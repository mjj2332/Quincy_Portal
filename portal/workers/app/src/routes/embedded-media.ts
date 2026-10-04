import { Hono, type Context } from "hono";
import { z } from "zod";
import { createDb, schema } from "@quincy/db";
import { eq } from "drizzle-orm";
import {
  EMBEDDED_IMAGE_CONTENT_TYPES, EMBEDDED_POSTER_MAX_BYTES, EMBEDDED_VIDEO_CONTENT_TYPES, EMBEDDED_VIDEO_PART_URL_TTL_SECONDS, embeddedMediaKindFor, embeddedMediaMaxBytes, embeddedMediaObjectKey,
  embeddedMediaPosterKey, externalEmbeddedMediaCompleteSchema, externalEmbeddedMediaPresignSchema, isJpeg,
} from "@quincy/shared";
import { terminalRoute } from "../lib/terminal-route";
import type { AppEnv, Env } from "../env";
import { hasProjectCollaborationAccess } from "../middleware/capability";
import { audit } from "../lib/audit";
import { newId } from "../lib/ids";
import { abortMultipart, createMultipartPresign, PART_BYTES, PRESIGN_EXPIRES_SECONDS } from "../lib/r2s3";
import { abortEmbeddedMedia, claimAndDiscardUploadingMedia, discardUnreferencedObject, enqueueEmbeddedMediaCleanup, getEmbeddedMedia, verifyUploadedEmbeddedObject } from "../lib/embedded-media";
import { jsonInput } from "./helpers";

const uuid = z.string().uuid();
/** A Project's discussion takes images and videos (#494); each kind has its own size cap. */
const presignInput = z.object({ contentType: z.enum([...EMBEDDED_IMAGE_CONTENT_TYPES, ...EMBEDDED_VIDEO_CONTENT_TYPES]), bytes: z.number().int().min(1) }).strict()
  .superRefine((value, context) => { if (value.bytes > embeddedMediaMaxBytes(embeddedMediaKindFor(value.contentType)!)) context.addIssue({ code: "custom", path: ["bytes"], message: "File is too large" }); });
const completeInput = z.object({ parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) }).strict()).optional() }).strict();

export const embeddedMediaRoutes = new Hono<AppEnv>();

type Project = { id: string; archivedAt: Date | null };

/** The collaboration gate shared by the three routes: 403 for staff, 404 for an External editor (as the comment routes do). */
export async function collaborationGate(c: Context<AppEnv>, projectId: string): Promise<Project | Response> {
  if (!await hasProjectCollaborationAccess(c, projectId)) return c.get("user").role === "external_editor" ? c.json({ error: "Project not found" }, 404) : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const project = await createDb(c.env.DB).select({ id: schema.projects.id, archivedAt: schema.projects.archivedAt }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  return project ?? c.json({ error: "Project not found" }, 404);
}

embeddedMediaRoutes.post("/projects/:projectId/embedded-media", terminalRoute("/projects/:projectId/embedded-media", async (c) => {
  const projectId = c.req.param("projectId"); if (!uuid.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  const project = await collaborationGate(c, projectId); if (project instanceof Response) return project;
  if (project.archivedAt) return c.json({ error: "Archived projects cannot accept media", code: "project_archived" }, 409);
  const data = await jsonInput(c, presignInput); if (data instanceof Response) return data;
  const user = c.get("user"); const mediaId = newId(); const key = embeddedMediaObjectKey(projectId, mediaId); const now = Date.now();
  const kind = embeddedMediaKindFor(data.contentType)!;
  // Fenced on the Project still being live, so a reservation never lands in an archived Project.
  const reserved = await c.env.DB.prepare(`
    INSERT INTO embedded_media (id, owner_kind, owner_id, project_id, uploader_id, kind, content_type, bytes, original_key, state, created_at, updated_at)
    SELECT ?, 'project_comment', NULL, id, ?, ?, ?, ?, ?, 'uploading', ?, ? FROM projects WHERE id = ? AND archived_at IS NULL
  `).bind(mediaId, user.id, kind, data.contentType, data.bytes, key, now, now, projectId).run();
  if ((reserved.meta.changes ?? 0) !== 1) return c.json({ error: "Archived projects cannot accept media", code: "project_archived" }, 409);
  const release = () => c.env.DB.prepare("DELETE FROM embedded_media WHERE id = ? AND state = 'uploading'").bind(mediaId).run();
  let multipart: Awaited<ReturnType<typeof createMultipartPresign>>;
  try { multipart = await createMultipartPresign(c.env, key, data.bytes, data.contentType, PART_BYTES, kind === "video" ? EMBEDDED_VIDEO_PART_URL_TTL_SECONDS : PRESIGN_EXPIRES_SECONDS); }
  catch (error) { await release(); throw error; }
  if (!multipart) {
    // Dev has no R2 S3 credentials: steer the browser to the direct-PUT route (Miniflare R2).
    if (c.env.APP_ENV === "dev") return c.json(externalEmbeddedMediaPresignSchema.parse({ mediaId, devDirect: true }));
    await release();
    return c.json({ error: "R2 S3 upload credentials are not configured" }, 503);
  }
  // The reservation and the Project may have gone while R2 was starting the upload (archive, hard delete, a sweep claim): then no URLs go out.
  const stored = await c.env.DB.prepare(`
    UPDATE embedded_media SET upload_id = ? WHERE id = ? AND state = 'uploading' AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL)
  `).bind(multipart.uploadId, mediaId, projectId).run();
  if ((stored.meta.changes ?? 0) !== 1) {
    // An abort that fails leaves the upload completable, so the queue takes it over (the sweep aborts it, then deletes the key).
    try { await abortMultipart(c.env, key, multipart.uploadId); } catch { await enqueueEmbeddedMediaCleanup(c.env.DB, [{ key, uploadId: multipart.uploadId, projectId }]); }
    await release();
    return c.json({ error: "This project can no longer accept media", code: "project_unavailable" }, 409);
  }
  await audit(c.env, user, "embedded_media.presign", "embedded_media", mediaId, { projectId, bytes: data.bytes, contentType: data.contentType });
  return c.json(externalEmbeddedMediaPresignSchema.parse({ mediaId, uploadId: multipart.uploadId, partUrls: multipart.partUrls, partBytes: multipart.partBytes }));
}));

embeddedMediaRoutes.put("/projects/:projectId/embedded-media/:mediaId/direct", terminalRoute("/projects/:projectId/embedded-media/:mediaId/direct", async (c) => {
  if (c.env.APP_ENV !== "dev") return c.json({ error: "Direct uploads are available only in dev" }, 404);
  const projectId = c.req.param("projectId"); const mediaId = c.req.param("mediaId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(mediaId).success) return c.json({ error: "Invalid media upload" }, 400);
  const project = await collaborationGate(c, projectId); if (project instanceof Response) return project;
  const row = await getEmbeddedMedia(c.env.DB, mediaId);
  if (!row || row.projectId !== projectId || row.uploaderId !== c.get("user").id || row.state !== "uploading") return c.json({ error: "Media upload is unavailable" }, 404);
  await c.env.MEDIA.put(row.originalKey, c.req.raw.body, { httpMetadata: { contentType: row.contentType } });
  return c.body(null, 204);
}));

embeddedMediaRoutes.post("/projects/:projectId/embedded-media/:mediaId/complete", terminalRoute("/projects/:projectId/embedded-media/:mediaId/complete", async (c) => {
  const projectId = c.req.param("projectId"); const mediaId = c.req.param("mediaId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(mediaId).success) return c.json({ error: "Invalid media upload" }, 400);
  // A row that is gone is not ours to clean up: a Project hard delete queued its keys before the cascade, and a sweep claim queued its own.
  // This route touches R2 only after it has claimed the still-uploading row itself.
  const stray = () => c.json({ error: "Media upload not found" }, 404);
  const live = await createDb(c.env.DB).select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!live) return stray();
  const project = await collaborationGate(c, projectId); if (project instanceof Response) return project;
  if (project.archivedAt) return c.json({ error: "Archived projects cannot accept media", code: "project_archived" }, 409);
  const data = await jsonInput(c, completeInput); if (data instanceof Response) return data;
  const user = c.get("user"); const row = await getEmbeddedMedia(c.env.DB, mediaId);
  if (!row) return stray();
  if (row.projectId !== projectId || row.uploaderId !== user.id) return c.json({ error: "Media upload not found" }, 404);
  if (row.state === "pending") return c.json(externalEmbeddedMediaCompleteSchema.parse({ mediaId, state: "pending" }));
  if (row.state !== "uploading") return c.json({ error: "This media is already in use", code: "media_not_uploading" }, 409);

  const verdict = await verifyUploadedEmbeddedObject(c.env, row, data.parts);
  if (!verdict.ok) return c.json(verdict.body, verdict.status);

  // Fenced on the Project still being live and unarchived: R2 was awaited above, so the Project may have been deleted or archived meanwhile.
  const promoted = await c.env.DB.prepare("UPDATE embedded_media SET state = 'pending', updated_at = ? WHERE id = ? AND state = 'uploading' AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL)").bind(Date.now(), mediaId, projectId).run();
  if ((promoted.meta.changes ?? 0) !== 1) {
    const current = await getEmbeddedMedia(c.env.DB, mediaId);
    if (!current) return stray();
    if (current.state === "uploading") {
      // Lost to the Project's lifecycle, not to another writer: nothing will ever own this object.
      if (!await claimAndDiscardUploadingMedia(c.env, current)) return c.json({ error: "This media is already in use", code: "media_not_uploading" }, 409);
      return c.json({ error: "This project can no longer accept media", code: "project_unavailable" }, 409);
    }
    if (current.state !== "pending") return c.json({ error: "This media is already in use", code: "media_not_uploading" }, 409);
  } else {
    await audit(c.env, user, "embedded_media.upload", "embedded_media", mediaId, { projectId, bytes: row.bytes, contentType: row.contentType });
  }
  return c.json(externalEmbeddedMediaCompleteSchema.parse({ mediaId, state: "pending" }));
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
  const project = await collaborationGate(c, projectId); if (project instanceof Response) return project;
  if (project.archivedAt) return c.json({ error: "Archived projects cannot accept media", code: "project_archived" }, 409);
  const user = c.get("user"); const row = await getEmbeddedMedia(c.env.DB, mediaId);
  if (!row || row.projectId !== projectId || row.uploaderId !== user.id || row.kind !== "video") return c.json({ error: "Media upload not found" }, 404);
  if (row.state !== "pending" || row.posterKey) return c.json({ error: "This video cannot take a poster", code: "poster_unavailable" }, 409);
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > EMBEDDED_POSTER_MAX_BYTES) return c.json({ error: "The poster is larger than 2 MB" }, 413);
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength > EMBEDDED_POSTER_MAX_BYTES) return c.json({ error: "The poster is larger than 2 MB" }, 413);
  if (!isJpeg(body)) return c.json({ error: "The poster must be a JPEG image" }, 400);
  const posterKey = embeddedMediaPosterKey(projectId, mediaId, newId());
  // The queue entry is the fence: the adopting batch needs it to exist, unchanged and unleased, and removes it in the same batch. A sweep that leased it (even a lease since expired), finished and dequeued it, or a re-queue that bumped it all make the adoption lose.
  const queuedAt = Date.now();
  await c.env.DB.prepare("INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at) VALUES (?, NULL, ?, ?)").bind(posterKey, projectId, queuedAt).run();
  try { await c.env.MEDIA.put(posterKey, body, { httpMetadata: { contentType: "image/jpeg" } }); }
  catch (error) { await c.env.DB.prepare("DELETE FROM embedded_media_cleanup WHERE storage_key = ?").bind(posterKey).run(); throw error; }
  let results: D1Result[];
  try {
    results = await c.env.DB.batch([
      c.env.DB.prepare(`
        UPDATE embedded_media SET poster_key = ?, updated_at = ?
        WHERE id = ? AND kind = 'video' AND state = 'pending' AND poster_key IS NULL AND uploader_id = ? AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL)
          AND EXISTS (SELECT 1 FROM embedded_media_cleanup WHERE storage_key = ? AND queued_at = ? AND claimed_until IS NULL)
      `).bind(posterKey, Date.now(), mediaId, user.id, projectId, posterKey, queuedAt),
      c.env.DB.prepare("DELETE FROM embedded_media_cleanup WHERE storage_key = ? AND queued_at = ? AND claimed_until IS NULL AND (SELECT poster_key FROM embedded_media WHERE id = ?) = ?").bind(posterKey, queuedAt, mediaId, posterKey),
    ]);
  } catch (error) {
    // A throw can still follow a commit: if the row already references the object, it is live and stays.
    const committed = await getEmbeddedMedia(c.env.DB, mediaId).then((current) => current?.posterKey === posterKey, () => false);
    if (committed) return c.body(null, 204);
    await discardUnreferencedObject(c.env, posterKey, projectId); throw error;
  }
  if ((results[0]!.meta.changes ?? 0) === 1) return c.body(null, 204);
  // Lost: nothing references the object, and a sweep's claim on its entry can never be undone (adoption needs an unclaimed entry).
  await discardUnreferencedObject(c.env, posterKey, projectId);
  return c.json({ error: "This video can no longer take a poster", code: "poster_unavailable" }, 409);
}));

/** A cancelled upload (#494): see `abortEmbeddedMedia`. The uploader's alone, in any Project state, since cleaning up is never harmful. */
embeddedMediaRoutes.post("/projects/:projectId/embedded-media/:mediaId/abort", terminalRoute("/projects/:projectId/embedded-media/:mediaId/abort", async (c) => {
  const projectId = c.req.param("projectId"); const mediaId = c.req.param("mediaId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(mediaId).success) return c.json({ error: "Invalid media upload" }, 400);
  const live = await createDb(c.env.DB).select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!live) return c.json({ error: "Media upload not found" }, 404);
  const project = await collaborationGate(c, projectId); if (project instanceof Response) return project;
  const user = c.get("user"); const row = await getEmbeddedMedia(c.env.DB, mediaId);
  if (!row || row.projectId !== projectId || row.uploaderId !== user.id) return c.json({ error: "Media upload not found" }, 404);
  const outcome = await abortEmbeddedMedia(c.env, row);
  if (outcome === "gone") return c.json({ error: "Media upload not found" }, 404);
  if (outcome === "in_use") return c.json({ error: "This media is already in use", code: "media_not_uploading" }, 409);
  return c.body(null, 204);
}));
