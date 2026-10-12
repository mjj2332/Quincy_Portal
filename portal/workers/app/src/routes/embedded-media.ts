import { Hono, type Context } from "hono";
import { readBoundedBytes } from "../lib/bounded-body";
import { z } from "zod";
import { createDb, schema } from "@quincy/db";
import { eq } from "drizzle-orm";
import {
  EMBEDDED_HEIC_CONTENT_TYPES, EMBEDDED_IMAGE_CONTENT_TYPES, EMBEDDED_POSTER_MAX_BYTES, EMBEDDED_VIDEO_CONTENT_TYPES, EMBEDDED_VIDEO_PART_URL_TTL_SECONDS, embeddedMediaKindFor, embeddedMediaMaxBytes, embeddedMediaObjectKey,
  embeddedMediaPosterKey, enqueueEmbeddedDisplaySafely, roleHasCapability, externalEmbeddedMediaCompleteSchema, externalEmbeddedMediaPresignSchema, externalEmbeddedMediaSettingsSchema, isEmbeddedHeicContentType, isJpeg, renditionsEnabled,
  embeddedImageDimensionsShape, requireBothImageDimensions,
} from "@quincy/shared";
import { terminalRoute } from "../lib/terminal-route";
import type { AppEnv, Env } from "../env";
import { hasProjectAccess, hasProjectCollaborationAccess } from "../middleware/capability";
import { readVideoReviewGate } from "../lib/video-review-gate";
import { audit } from "../lib/audit";
import { newId } from "../lib/ids";
import { abortMultipart, createMultipartPresign, PART_BYTES, PRESIGN_EXPIRES_SECONDS } from "../lib/r2s3";
import { abortEmbeddedMedia, claimAndDiscardUploadingMedia, discardUnreferencedObject, enqueueEmbeddedMediaCleanup, getEmbeddedMedia, recordedImageSize, settleThrownAdoption, verifyUploadedEmbeddedObject } from "../lib/embedded-media";
import { heicGate, heicUploadsAllowed, isHeicRow, renditionStatusResponse, retryRendition } from "../lib/embedded-heic";
import { abortEmbeddedUpload, completeEmbeddedMedia, directEmbeddedMedia, posterEmbeddedMedia, presignEmbeddedMedia, type UploadScope } from "../lib/embedded-media-upload";
import { jsonInput } from "./helpers";

const uuid = z.string().uuid();
/**
 * A Project's discussion takes images and videos (#494); each kind has its own size cap. `owner` (#501) says what the upload is for:
 * the discussion (the default) or the Project's whiteboard. A whiteboard upload takes the same types and sizes and is never attachable to a comment.
 * HEIC and HEIF (#495) are images with a JPEG display copy made after upload: `heicGate` refuses them for everyone but an Admin until the owner turns the flag on.
 */
const presignInput = z.object({ contentType: z.enum([...EMBEDDED_IMAGE_CONTENT_TYPES, ...EMBEDDED_HEIC_CONTENT_TYPES, ...EMBEDDED_VIDEO_CONTENT_TYPES]), bytes: z.number().int().min(1), owner: z.enum(["discussion", "whiteboard", "video_note"]).optional() }).strict()
  .superRefine((value, context) => { if (value.bytes > embeddedMediaMaxBytes(embeddedMediaKindFor(value.contentType)!)) context.addIssue({ code: "custom", path: ["bytes"], message: "File is too large" }); });
/** `width` and `height` (#611) are the image's pixel size as the uploading browser measured it. Optional, both or neither, and only recorded for an image that is not HEIC. */
const completeInput = z.object({ parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) }).strict()).optional(), ...embeddedImageDimensionsShape }).strict().superRefine(requireBothImageDimensions);

export const embeddedMediaRoutes = new Hono<AppEnv>();

type Project = { id: string; archivedAt: Date | null };

/** The collaboration gate shared by the three routes: 403 for staff, 404 for an External editor (as the comment routes do). */
export async function collaborationGate(c: Context<AppEnv>, projectId: string): Promise<Project | Response> {
  if (!await hasProjectCollaborationAccess(c, projectId)) return c.get("user").role === "external_editor" ? c.json({ error: "Project not found" }, 404) : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const project = await createDb(c.env.DB).select({ id: schema.projects.id, archivedAt: schema.projects.archivedAt }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  return project ?? c.json({ error: "Project not found" }, 404);
}

/**
 * The gate for media a VIDEO NOTE owns (#835): the people who may write a video note, not the Collaboration tab's people. In the order every video route uses: the `notes` part (closed is a
 * plain 404), `annotateVideo` (403), then Project visibility (an External outside the Project 404, staff 403). Without it a non-member Editor could presign for a note and then fail at complete.
 */
export async function videoNoteUploadGate(c: Context<AppEnv>, projectId: string): Promise<Project | Response> {
  const user = c.get("user");
  if (!(await readVideoReviewGate(c.env.DB, projectId)).parts.includes("notes")) return c.json({ error: "Not found" }, 404);
  if (!roleHasCapability(user.role, "annotateVideo")) return c.json({ error: "Forbidden" }, 403);
  if (!await hasProjectAccess(c, projectId)) return user.role === "external_editor" ? c.json({ error: "Project not found" }, 404) : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const project = await createDb(c.env.DB).select({ id: schema.projects.id, archivedAt: schema.projects.archivedAt }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  return project ?? c.json({ error: "Project not found" }, 404);
}

/** The upload core's scope for this staff request: the signed-in user is the uploader, there is no extra fence, and audit rows name them (an impersonating Admin included). */
function scopeOf(c: Context<AppEnv>, projectId: string): UploadScope {
  const user = c.get("user");
  return { env: c.env, projectId, uploader: { userId: user.id }, audit: (action, mediaId, meta) => audit(c.env, user, action, "embedded_media", mediaId, meta) };
}

/** The gate for a request about an existing row: a video note's media takes `videoNoteUploadGate`, every other row (and an unknown id) the Collaboration gate. */
async function gateForRow(c: Context<AppEnv>, projectId: string, mediaId: string): Promise<Project | Response> {
  const row = uuid.safeParse(mediaId).success ? await getEmbeddedMedia(c.env.DB, mediaId) : null;
  return row?.ownerKind === "video_note" && row.projectId === projectId ? videoNoteUploadGate(c, projectId) : collaborationGate(c, projectId);
}

embeddedMediaRoutes.post("/projects/:projectId/embedded-media", terminalRoute("/projects/:projectId/embedded-media", async (c) => {
  const projectId = c.req.param("projectId"); if (!uuid.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  // The owner picks the gate, so it is peeked at before the body is parsed (Hono caches the body; `jsonInput` reads it again).
  const peek: unknown = await c.req.json().catch(() => null);
  const videoNote = typeof peek === "object" && peek !== null && (peek as { owner?: unknown }).owner === "video_note";
  const project = await (videoNote ? videoNoteUploadGate(c, projectId) : collaborationGate(c, projectId)); if (project instanceof Response) return project;
  if (project.archivedAt) return c.json({ error: "Archived projects cannot accept media", code: "project_archived" }, 409);
  const data = await jsonInput(c, presignInput); if (data instanceof Response) return data;
  const heic = isEmbeddedHeicContentType(data.contentType);
  if (heic) { const refused = await heicGate(c); if (refused) return refused; }
  const ownerKind = data.owner === "whiteboard" ? "whiteboard" : data.owner === "video_note" ? "video_note" : "project_comment";
  return presignEmbeddedMedia(scopeOf(c, projectId), { contentType: data.contentType, bytes: data.bytes, ownerKind });
}));

embeddedMediaRoutes.put("/projects/:projectId/embedded-media/:mediaId/direct", terminalRoute("/projects/:projectId/embedded-media/:mediaId/direct", async (c) => {
  if (c.env.APP_ENV !== "dev") return c.json({ error: "Direct uploads are available only in dev" }, 404);
  const projectId = c.req.param("projectId"); const mediaId = c.req.param("mediaId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(mediaId).success) return c.json({ error: "Invalid media upload" }, 400);
  const project = await gateForRow(c, projectId, mediaId); if (project instanceof Response) return project;
  // A reservation made before the Project was archived takes no bytes afterwards (as `complete` and the poster refuse too).
  if (project.archivedAt) return c.json({ error: "Archived projects cannot accept media", code: "project_archived" }, 409);
  return directEmbeddedMedia(scopeOf(c, projectId), mediaId, c.req.raw.body);
}));

embeddedMediaRoutes.post("/projects/:projectId/embedded-media/:mediaId/complete", terminalRoute("/projects/:projectId/embedded-media/:mediaId/complete", async (c) => {
  const projectId = c.req.param("projectId"); const mediaId = c.req.param("mediaId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(mediaId).success) return c.json({ error: "Invalid media upload" }, 400);
  // A row that is gone is not ours to clean up: a Project hard delete queued its keys before the cascade, and a sweep claim queued its own.
  // This route touches R2 only after it has claimed the still-uploading row itself.
  const stray = () => c.json({ error: "Media upload not found" }, 404);
  const live = await createDb(c.env.DB).select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!live) return stray();
  const project = await gateForRow(c, projectId, mediaId); if (project instanceof Response) return project;
  if (project.archivedAt) return c.json({ error: "Archived projects cannot accept media", code: "project_archived" }, 409);
  const data = await jsonInput(c, completeInput); if (data instanceof Response) return data;
  return completeEmbeddedMedia(scopeOf(c, projectId), mediaId, data, () => heicGate(c));
}));

/**
 * The poster frame the browser captured from a video (#494). Best effort: a video without one plays from its first frame.
 * Only the uploader, only for a video that has finished uploading and is not yet in a comment, only once. The write order
 * leaves no orphan whichever way a race goes: the key is queued first, then written, then one batch sets it on the row and
 * unqueues it, but only if the row still wants it. A batch that loses (the upload was cancelled, the Project went away) deletes the
 * object, and if R2 refuses, the queued key is left for the daily sweep.
 */
embeddedMediaRoutes.put("/projects/:projectId/embedded-media/:mediaId/poster", terminalRoute("/projects/:projectId/embedded-media/:mediaId/poster", async (c) => {
  const projectId = c.req.param("projectId"); const mediaId = c.req.param("mediaId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(mediaId).success) return c.json({ error: "Invalid media upload" }, 400);
  const project = await gateForRow(c, projectId, mediaId); if (project instanceof Response) return project;
  if (project.archivedAt) return c.json({ error: "Archived projects cannot accept media", code: "project_archived" }, 409);
  return posterEmbeddedMedia(scopeOf(c, projectId), mediaId, { body: (max) => readBoundedBytes(c.req.raw, max) });
}));

/** A cancelled upload (#494): see `abortEmbeddedMedia`. The uploader's alone, in any Project state, since cleaning up is never harmful. */
embeddedMediaRoutes.post("/projects/:projectId/embedded-media/:mediaId/abort", terminalRoute("/projects/:projectId/embedded-media/:mediaId/abort", async (c) => {
  const projectId = c.req.param("projectId"); const mediaId = c.req.param("mediaId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(mediaId).success) return c.json({ error: "Invalid media upload" }, 400);
  const live = await createDb(c.env.DB).select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!live) return c.json({ error: "Media upload not found" }, 404);
  const project = await gateForRow(c, projectId, mediaId); if (project instanceof Response) return project;
  return abortEmbeddedUpload(scopeOf(c, projectId), mediaId);
}));

/** The uploader's view of a HEIC image's display copy (#495): the composer polls it. Uploader-only, in any Project state. */
async function ownRenditionRow(c: Context<AppEnv>, projectId: string, mediaId: string) {
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(mediaId).success) return c.json({ error: "Invalid media upload" }, 400);
  const live = await createDb(c.env.DB).select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!live) return c.json({ error: "Media upload not found" }, 404);
  const project = await gateForRow(c, projectId, mediaId); if (project instanceof Response) return project;
  const row = await getEmbeddedMedia(c.env.DB, mediaId);
  if (!row || row.projectId !== projectId || row.uploaderId !== c.get("user").id || row.kind !== "image" || row.state === "uploading") return c.json({ error: "Media upload not found" }, 404);
  return row;
}

embeddedMediaRoutes.get("/projects/:projectId/embedded-media/:mediaId/rendition", terminalRoute("/projects/:projectId/embedded-media/:mediaId/rendition", async (c) => {
  const row = await ownRenditionRow(c, c.req.param("projectId"), c.req.param("mediaId")); if (row instanceof Response) return row;
  return renditionStatusResponse(c, row);
}));

embeddedMediaRoutes.post("/projects/:projectId/embedded-media/:mediaId/rendition/retry", terminalRoute("/projects/:projectId/embedded-media/:mediaId/rendition/retry", async (c) => {
  const row = await ownRenditionRow(c, c.req.param("projectId"), c.req.param("mediaId")); if (row instanceof Response) return row;
  return retryRendition(c, row);
}));

/** Whether this person may upload HEIC (#495), for the picker. The effective user, so an impersonating Admin is told what the staff member would be. */
embeddedMediaRoutes.get("/embedded-media/settings", terminalRoute("/embedded-media/settings", async (c) =>
  c.json(externalEmbeddedMediaSettingsSchema.parse({ heic: renditionsEnabled(c.env) && await heicUploadsAllowed(c.env, c.get("user")) }))));
