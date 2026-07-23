import { Hono } from "hono";
import { createDb, schema } from "@quincy/db";
import { and, desc, eq } from "drizzle-orm";
import { isAcceptedPhotoFilename, roleHasCapability } from "@quincy/shared";
import { z } from "zod";
import type { AppEnv } from "../env";
import { hasProjectAccess, requireCapability } from "../middleware/capability";
import { audit } from "../lib/audit";
import { finalizeIngest } from "../lib/ingest";
import { newId, safeFilename } from "../lib/ids";
import { completeMultipart, createMultipartPresign } from "../lib/r2s3";
import { jsonInput } from "./helpers";

const manifestInput = z.object({ filenames: z.array(z.string().min(1)).min(1).max(10_000) });
const presignInput = z.object({ projectId: z.string().uuid(), filename: z.string().min(1), bytes: z.number().int().positive().max(5 * 1024 * 1024 * 1024), collection: z.enum(["raw", "edited"]).default("raw") });
const completeInput = z.object({ projectId: z.string().uuid(), key: z.string().min(1), uploadId: z.string().optional(), parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) })).optional(), originalFilename: z.string().min(1), contentHash: z.string().max(256).optional(), collection: z.enum(["raw", "edited"]).default("raw") });
export const uploadsRoutes = new Hono<AppEnv>();
uploadsRoutes.post("/projects/:id/upload-manifest", requireCapability("uploadRaw"), async (c) => {
  const projectId = c.req.param("id"); if (!await hasProjectAccess(c, projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); {
    const data = await jsonInput(c, manifestInput); if (data instanceof Response) return data;
    if (data.filenames.some((name) => !isAcceptedPhotoFilename(name))) return c.json({ error: "RAW uploads must be .jpg or .jpeg files" }, 400);
    const db = createDb(c.env.DB); const raw = await db.select().from(schema.collections).where(and(eq(schema.collections.projectId, projectId), eq(schema.collections.kind, "raw"))).get(); if (!raw) return c.json({ error: "Project RAW collection not found" }, 404);
    const id = newId(); await db.insert(schema.uploadManifests).values({ id, collectionId: raw.id, expectedCount: data.filenames.length, filenamesJson: JSON.stringify(data.filenames), createdBy: c.get("user").id, createdAt: new Date() }); await db.update(schema.collections).set({ expectedCount: data.filenames.length, status: "awaiting_upload", updatedAt: new Date() }).where(eq(schema.collections.id, raw.id)); await audit(c.env, c.get("user").id, "upload.manifest", "upload_manifest", id, { projectId, expectedCount: data.filenames.length }); return c.json({ manifestId: id });
  }
});
uploadsRoutes.post("/uploads/presign", async (c) => {
  const data = await jsonInput(c, presignInput); if (data instanceof Response) return data;
  const capability = data.collection === "edited" ? "uploadEdited" : "uploadRaw";
  if (!roleHasCapability(c.get("user").role, capability)) return c.json({ error: "Forbidden", capability }, 403);
  if (!await hasProjectAccess(c, data.projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if ((await createDb(c.env.DB).select({ archivedAt: schema.projects.archivedAt }).from(schema.projects).where(eq(schema.projects.id, data.projectId)).get())?.archivedAt) return c.json({ error: "Project is archived" }, 409); {
    if (!isAcceptedPhotoFilename(data.filename)) return c.json({ error: data.collection === "raw" ? "RAW uploads must be .jpg or .jpeg files" : "Edited uploads must be .jpg or .jpeg files" }, 400);
    const assetId = newId(); const key = `projects/${data.projectId}/${data.collection}/${assetId}/${safeFilename(data.filename)}`; const multipart = await createMultipartPresign(c.env, key, data.bytes);
    if (!multipart) {
      // Dev fallback: no R2 S3 creds locally → steer the uploader to the direct-PUT route (Miniflare R2).
      if (c.env.APP_ENV === "dev") return c.json({ assetId, key, devDirect: true });
      return c.json({ error: "R2 S3 upload credentials are not configured" }, 503);
    }
    await audit(c.env, c.get("user").id, "upload.presign", "asset", assetId, { projectId: data.projectId, key, bytes: data.bytes }); return c.json({ assetId, ...multipart });
  }
});
uploadsRoutes.put("/uploads/direct", async (c) => {
  if (c.env.APP_ENV !== "dev") return c.json({ error: "Direct uploads are available only in dev" }, 404);
  const key = c.req.query("key"); if (!key || !key.startsWith("projects/")) return c.json({ error: "A valid R2 key is required" }, 400);
  const match = key.match(/^projects\/([0-9a-f-]{36})\/(raw|edited)\/([0-9a-f-]{36})\//); if (!match) return c.json({ error: "R2 key does not follow the required asset key convention" }, 400);
  const projectId = match[1]!; const collection = match[2]!; const assetId = match[3]!;
  const capability = collection === "edited" ? "uploadEdited" : "uploadRaw";
  if (!roleHasCapability(c.get("user").role, capability)) return c.json({ error: "Forbidden", capability }, 403);
  if (!await hasProjectAccess(c, projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if ((await createDb(c.env.DB).select({ archivedAt: schema.projects.archivedAt }).from(schema.projects).where(eq(schema.projects.id, projectId)).get())?.archivedAt) return c.json({ error: "Project is archived" }, 409);
  await c.env.MEDIA.put(key, c.req.raw.body, { httpMetadata: { contentType: "image/jpeg" } });
  await audit(c.env, c.get("user").id, "upload.direct", "asset", assetId, { projectId, key });
  return c.body(null, 204);
});
uploadsRoutes.post("/uploads/complete", async (c) => {
  const data = await jsonInput(c, completeInput); if (data instanceof Response) return data;
  const capability = data.collection === "edited" ? "uploadEdited" : "uploadRaw";
  if (!roleHasCapability(c.get("user").role, capability)) return c.json({ error: "Forbidden", capability }, 403);
  if (!await hasProjectAccess(c, data.projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if ((await createDb(c.env.DB).select({ archivedAt: schema.projects.archivedAt }).from(schema.projects).where(eq(schema.projects.id, data.projectId)).get())?.archivedAt) return c.json({ error: "Project is archived" }, 409); {
    if (!isAcceptedPhotoFilename(data.originalFilename)) return c.json({ error: data.collection === "raw" ? "RAW uploads must be .jpg or .jpeg files" : "Edited uploads must be .jpg or .jpeg files" }, 400);
    const assetId = data.key.match(new RegExp(`^projects/${data.projectId}/${data.collection}/([^/]+)/`))?.[1]; if (!assetId || !z.string().uuid().safeParse(assetId).success) return c.json({ error: "R2 key does not follow the required asset key convention" }, 400);
    if (data.uploadId) { if (!data.parts?.length) return c.json({ error: "Multipart uploads require completed parts" }, 400); await completeMultipart(c.env, data.key, data.uploadId, data.parts); }
    try {
      const completed = await finalizeIngest(c.env, { actorId: c.get("user").id, projectId: data.projectId, assetId, key: data.key, originalFilename: data.originalFilename, contentHash: data.contentHash, collection: data.collection });
      if (data.collection === "edited" && completed.publishStatus !== "ready") {
        try {
          const { jobId } = await c.env.BACKGROUND.publishManualEditedUpload(data.projectId, assetId);
          return c.json({ ...completed, jobId, publishStatus: "pending" }, 202);
        } catch (error) {
          // Finalization is already durable and R2 bytes are intentionally retained. Return the
          // existing terminal job when a lost RPC response raced a successful enqueue; otherwise
          // surface a failed operation that an admin can retry from the jobs panel.
          const db = createDb(c.env.DB);
          const message = error instanceof Error ? error.message : "Manual Dropbox publishing could not be started";
          let existingJob = await db.select({ id: schema.jobs.id, status: schema.jobs.status })
            .from(schema.jobs)
            .where(and(
              eq(schema.jobs.projectId, data.projectId),
              eq(schema.jobs.kind, "manual_edited_publish"),
              eq(schema.jobs.correlationId, `manual_edited_publish:${assetId}`),
            ))
            .orderBy(desc(schema.jobs.createdAt))
            .get();
          if (!existingJob) {
            // A service-binding failure happens after the source asset is safely committed. Keep
            // a terminal job in D1 so the existing admin retry route can restart publication.
            await db.insert(schema.jobs).values({
              id: newId(), kind: "manual_edited_publish", status: "failed", projectId: data.projectId,
              correlationId: `manual_edited_publish:${assetId}`,
              payloadJson: JSON.stringify({ projectId: data.projectId, assetId }), error: message,
              createdAt: new Date(), updatedAt: new Date(),
            }).onConflictDoNothing();
            existingJob = await db.select({ id: schema.jobs.id, status: schema.jobs.status })
              .from(schema.jobs)
              .where(and(
                eq(schema.jobs.projectId, data.projectId),
                eq(schema.jobs.kind, "manual_edited_publish"),
                eq(schema.jobs.correlationId, `manual_edited_publish:${assetId}`),
              ))
              .orderBy(desc(schema.jobs.createdAt))
              .get();
          }
          if (existingJob?.status === "failed") {
            // The app owns this fallback when the service binding itself could not begin.
            // Keep the R2 source, but terminally hide the un-published asset so retry has a
            // durable pending -> failed lifecycle to restart from.
            await db.update(schema.assets).set({ publishStatus: "failed", updatedAt: new Date() }).where(and(
              eq(schema.assets.id, assetId),
              eq(schema.assets.publishStatus, "pending"),
            ));
            await audit(c.env, c.get("user").id, "asset.manual_publish.start_failed", "asset", assetId, { projectId: data.projectId, jobId: existingJob.id, error: message });
          }
          if (existingJob) return c.json({ ...completed, jobId: existingJob.id, publishStatus: existingJob.status === "failed" ? "failed" : "pending" }, 202);
          return c.json({ ...completed, publishStatus: "failed", error: error instanceof Error ? error.message : "Manual Dropbox publishing could not be started" }, 202);
        }
      }
      return c.json(completed, completed.publishStatus === "ready" ? 201 : 202);
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Could not finalize upload" }, 409); }
  }
});
uploadsRoutes.get("/projects/:id/ingest-status", async (c) => { const projectId = c.req.param("id"); if (!await hasProjectAccess(c, projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); const raw = await createDb(c.env.DB).select({ expectedCount: schema.collections.expectedCount, receivedCount: schema.collections.receivedCount }).from(schema.collections).where(and(eq(schema.collections.projectId, projectId), eq(schema.collections.kind, "raw"))).get(); if (!raw) return c.json({ error: "Project RAW collection not found" }, 404); return c.json({ expectedCount: raw.expectedCount, receivedCount: raw.receivedCount, mismatch: raw.expectedCount !== null && raw.expectedCount !== raw.receivedCount }); });
