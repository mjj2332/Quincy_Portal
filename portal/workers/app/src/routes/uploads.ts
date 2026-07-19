import { Hono } from "hono";
import { createDb, schema } from "@quincy/db";
import { and, eq } from "drizzle-orm";
import { isAcceptedPhotoFilename } from "@quincy/shared";
import { z } from "zod";
import type { AppEnv } from "../env";
import { hasProjectAccess, requireCapability } from "../middleware/capability";
import { audit } from "../lib/audit";
import { finalizeIngest } from "../lib/ingest";
import { newId, safeFilename } from "../lib/ids";
import { completeMultipart, createMultipartPresign } from "../lib/r2s3";
import { jsonInput } from "./helpers";

const manifestInput = z.object({ filenames: z.array(z.string().min(1)).min(1).max(10_000) });
const presignInput = z.object({ projectId: z.string().uuid(), filename: z.string().min(1), bytes: z.number().int().positive().max(5 * 1024 * 1024 * 1024) });
const completeInput = z.object({ projectId: z.string().uuid(), key: z.string().min(1), uploadId: z.string().optional(), parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) })).optional(), originalFilename: z.string().min(1), contentHash: z.string().max(256).optional() });
export const uploadsRoutes = new Hono<AppEnv>();
uploadsRoutes.post("/projects/:id/upload-manifest", requireCapability("uploadRaw"), async (c) => {
  const projectId = c.req.param("id"); if (!await hasProjectAccess(c, projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); {
    const data = await jsonInput(c, manifestInput); if (data instanceof Response) return data;
    if (data.filenames.some((name) => !isAcceptedPhotoFilename(name))) return c.json({ error: "RAW uploads must be .jpg or .jpeg files" }, 400);
    const db = createDb(c.env.DB); const raw = await db.select().from(schema.collections).where(and(eq(schema.collections.projectId, projectId), eq(schema.collections.kind, "raw"))).get(); if (!raw) return c.json({ error: "Project RAW collection not found" }, 404);
    const id = newId(); await db.insert(schema.uploadManifests).values({ id, collectionId: raw.id, expectedCount: data.filenames.length, filenamesJson: JSON.stringify(data.filenames), createdBy: c.get("user").id, createdAt: new Date() }); await db.update(schema.collections).set({ expectedCount: data.filenames.length, status: "awaiting_upload", updatedAt: new Date() }).where(eq(schema.collections.id, raw.id)); await audit(c.env, c.get("user").id, "upload.manifest", "upload_manifest", id, { projectId, expectedCount: data.filenames.length }); return c.json({ manifestId: id });
  }
});
uploadsRoutes.post("/uploads/presign", requireCapability("uploadRaw"), async (c) => {
  const data = await jsonInput(c, presignInput); if (data instanceof Response) return data;
  if (!await hasProjectAccess(c, data.projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); {
    if (!isAcceptedPhotoFilename(data.filename)) return c.json({ error: "RAW uploads must be .jpg or .jpeg files" }, 400);
    const assetId = newId(); const key = `projects/${data.projectId}/raw/${assetId}/${safeFilename(data.filename)}`; const multipart = await createMultipartPresign(c.env, key, data.bytes);
    if (!multipart) return c.json({ error: "R2 S3 upload credentials are not configured; use dev direct upload when APP_ENV=dev" }, 503);
    await audit(c.env, c.get("user").id, "upload.presign", "asset", assetId, { projectId: data.projectId, key, bytes: data.bytes }); return c.json({ assetId, ...multipart });
  }
});
uploadsRoutes.put("/uploads/direct", async (c) => {
  if (c.env.APP_ENV !== "dev") return c.json({ error: "Direct uploads are available only in dev" }, 404);
  const key = c.req.query("key"); if (!key || !key.startsWith("projects/")) return c.json({ error: "A valid R2 key is required" }, 400);
  if (!key.match(/^projects\/[0-9a-f-]{36}\/raw\/[0-9a-f-]{36}\//)) return c.json({ error: "R2 key does not follow the required asset key convention" }, 400);
  const projectId = key.split("/")[1]!;
  if (!await hasProjectAccess(c, projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (!["admin", "photographer", "editor"].includes(c.get("user").role)) return c.json({ error: "Forbidden", capability: "uploadRaw" }, 403);
  await c.env.MEDIA.put(key, c.req.raw.body, { httpMetadata: { contentType: "image/jpeg" } });
  await audit(c.env, c.get("user").id, "upload.direct", "asset", key.split("/")[3]!, { projectId, key });
  return c.body(null, 204);
});
uploadsRoutes.post("/uploads/complete", requireCapability("uploadRaw"), async (c) => {
  const data = await jsonInput(c, completeInput); if (data instanceof Response) return data;
  if (!await hasProjectAccess(c, data.projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); {
    if (!isAcceptedPhotoFilename(data.originalFilename)) return c.json({ error: "RAW uploads must be .jpg or .jpeg files" }, 400);
    const assetId = data.key.match(new RegExp(`^projects/${data.projectId}/raw/([^/]+)/`))?.[1]; if (!assetId || !z.string().uuid().safeParse(assetId).success) return c.json({ error: "R2 key does not follow the required asset key convention" }, 400);
    if (data.uploadId) { if (!data.parts?.length) return c.json({ error: "Multipart uploads require completed parts" }, 400); await completeMultipart(c.env, data.key, data.uploadId, data.parts); }
    try { return c.json(await finalizeIngest(c.env, { actorId: c.get("user").id, projectId: data.projectId, assetId, key: data.key, originalFilename: data.originalFilename, contentHash: data.contentHash }), 201); } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Could not finalize upload" }, 409); }
  }
});
uploadsRoutes.get("/projects/:id/ingest-status", async (c) => { const projectId = c.req.param("id"); if (!await hasProjectAccess(c, projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); const raw = await createDb(c.env.DB).select({ expectedCount: schema.collections.expectedCount, receivedCount: schema.collections.receivedCount }).from(schema.collections).where(and(eq(schema.collections.projectId, projectId), eq(schema.collections.kind, "raw"))).get(); if (!raw) return c.json({ error: "Project RAW collection not found" }, 404); return c.json({ expectedCount: raw.expectedCount, receivedCount: raw.receivedCount, mismatch: raw.expectedCount !== null && raw.expectedCount !== raw.receivedCount }); });
