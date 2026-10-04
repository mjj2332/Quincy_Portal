import { Hono, type Context } from "hono";
import { z } from "zod";
import { createDb, schema } from "@quincy/db";
import { eq } from "drizzle-orm";
import {
  EMBEDDED_IMAGE_CONTENT_TYPES, EMBEDDED_MEDIA_MAX_BYTES, embeddedMediaObjectKey, externalEmbeddedMediaCompleteSchema, externalEmbeddedMediaPresignSchema, sniffEmbeddedImageType,
} from "@quincy/shared";
import { terminalRoute } from "../lib/terminal-route";
import type { AppEnv } from "../env";
import { hasProjectCollaborationAccess } from "../middleware/capability";
import { audit } from "../lib/audit";
import { newId } from "../lib/ids";
import { completeMultipart, createMultipartPresign, validateMultipartParts } from "../lib/r2s3";
import { deleteEmbeddedMediaObjects, getEmbeddedMedia } from "../lib/embedded-media";
import { jsonInput } from "./helpers";

const uuid = z.string().uuid();
const presignInput = z.object({ contentType: z.enum(EMBEDDED_IMAGE_CONTENT_TYPES), bytes: z.number().int().min(1).max(EMBEDDED_MEDIA_MAX_BYTES) }).strict();
const completeInput = z.object({ parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) }).strict()).optional() }).strict();

export const embeddedMediaRoutes = new Hono<AppEnv>();

type Project = { id: string; archivedAt: Date | null };

/** The collaboration gate shared by the three routes: 403 for staff, 404 for an External editor (as the comment routes do). */
async function collaborationGate(c: Context<AppEnv>, projectId: string): Promise<Project | Response> {
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
  // Fenced on the Project still being live, so a reservation never lands in an archived Project.
  const reserved = await c.env.DB.prepare(`
    INSERT INTO embedded_media (id, owner_kind, owner_id, project_id, uploader_id, kind, content_type, bytes, original_key, state, created_at, updated_at)
    SELECT ?, 'project_comment', NULL, id, ?, 'image', ?, ?, ?, 'uploading', ?, ? FROM projects WHERE id = ? AND archived_at IS NULL
  `).bind(mediaId, user.id, data.contentType, data.bytes, key, now, now, projectId).run();
  if ((reserved.meta.changes ?? 0) !== 1) return c.json({ error: "Archived projects cannot accept media", code: "project_archived" }, 409);
  const release = () => c.env.DB.prepare("DELETE FROM embedded_media WHERE id = ? AND state = 'uploading'").bind(mediaId).run();
  let multipart: Awaited<ReturnType<typeof createMultipartPresign>>;
  try { multipart = await createMultipartPresign(c.env, key, data.bytes, data.contentType); }
  catch (error) { await release(); throw error; }
  if (!multipart) {
    // Dev has no R2 S3 credentials: steer the browser to the direct-PUT route (Miniflare R2).
    if (c.env.APP_ENV === "dev") return c.json(externalEmbeddedMediaPresignSchema.parse({ mediaId, devDirect: true }));
    await release();
    return c.json({ error: "R2 S3 upload credentials are not configured" }, 503);
  }
  await c.env.DB.prepare("UPDATE embedded_media SET upload_id = ? WHERE id = ? AND state = 'uploading'").bind(multipart.uploadId, mediaId).run();
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
  const strayKey = embeddedMediaObjectKey(projectId, mediaId);
  const stray = async () => { await deleteEmbeddedMediaObjects(c.env, [{ originalKey: strayKey, displayKey: null, posterKey: null }]); return c.json({ error: "Media upload not found" }, 404); };
  // The Project was deleted while the browser was still uploading: nothing owns the object any more.
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

  if (row.uploadId) {
    if (!data.parts?.length) return c.json({ error: "Multipart uploads require completed parts" }, 400);
    try { validateMultipartParts(row.bytes, data.parts); } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Invalid multipart parts" }, 400); }
    try { await completeMultipart(c.env, row.originalKey, row.uploadId, data.parts, row.bytes); }
    catch (error) {
      // A retry after a lost response finds the upload already completed: carry on if the object is there.
      if (!await c.env.MEDIA.head(row.originalKey)) return c.json({ error: error instanceof Error ? error.message : "Upload could not be completed" }, 502);
    }
  }
  const head = await c.env.MEDIA.head(row.originalKey);
  if (!head) return c.json({ error: "The file has not finished uploading", code: "upload_missing" }, 400);
  const reject = async (message: string) => {
    await deleteEmbeddedMediaObjects(c.env, [row]);
    await c.env.DB.prepare("DELETE FROM embedded_media WHERE id = ? AND state = 'uploading'").bind(mediaId).run();
    return c.json({ error: message, code: "media_rejected" }, 400);
  };
  if (head.size !== row.bytes) return reject("The uploaded file is not the size that was reserved");
  if (head.httpMetadata?.contentType !== row.contentType) return reject("The uploaded file is not the type that was reserved");
  const first = await c.env.MEDIA.get(row.originalKey, { range: { offset: 0, length: 16 } });
  const sniffed = first ? sniffEmbeddedImageType(new Uint8Array(await first.arrayBuffer())) : null;
  if (sniffed !== row.contentType) return reject("The uploaded file is not a JPEG, PNG or WebP image");

  const promoted = await c.env.DB.prepare("UPDATE embedded_media SET state = 'pending', updated_at = ? WHERE id = ? AND state = 'uploading'").bind(Date.now(), mediaId).run();
  if ((promoted.meta.changes ?? 0) !== 1) {
    const current = await getEmbeddedMedia(c.env.DB, mediaId);
    if (!current) return stray();
    if (current.state !== "pending") return c.json({ error: "This media is already in use", code: "media_not_uploading" }, 409);
  } else {
    await audit(c.env, user, "embedded_media.upload", "embedded_media", mediaId, { projectId, bytes: row.bytes, contentType: row.contentType });
  }
  return c.json(externalEmbeddedMediaCompleteSchema.parse({ mediaId, state: "pending" }));
}));
