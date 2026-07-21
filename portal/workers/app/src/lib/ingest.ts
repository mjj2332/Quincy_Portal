import { COLLECTION_RECEIVED_COUNT_SQL, collectionReceivedCountBindings, createDb, schema } from "@quincy/db";
import { and, eq } from "drizzle-orm";
import { enqueueRenditionSafely, parseXmpRating, XMP_SCAN_BYTES, xmpRatingToStars } from "@quincy/shared";
import type { Env } from "../env";
import { audit } from "./audit";

export async function finalizeIngest(env: Env, input: { actorId: string; projectId: string; assetId: string; key: string; originalFilename: string; contentHash?: string }) {
  const object = await env.MEDIA.head(input.key);
  if (!object) throw new Error("Uploaded object was not found in R2");
  const header = await env.MEDIA.get(input.key, { range: { offset: 0, length: XMP_SCAN_BYTES } });
  const stars = header ? xmpRatingToStars(parseXmpRating(await header.arrayBuffer())) : null;
  const db = createDb(env.DB);
  const raw = await db.select().from(schema.collections).where(and(eq(schema.collections.projectId, input.projectId), eq(schema.collections.kind, "raw"))).get();
  if (!raw) throw new Error("Project has no RAW collection");
  const now = new Date();
  const results = await env.DB.batch([
    env.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, content_hash, source, rating_from_metadata, created_at, updated_at) VALUES (?, ?, 'photo', ?, ?, ?, ?, 'upload', ?, ?, ?) ON CONFLICT DO NOTHING").bind(input.assetId, raw.id, input.key, input.originalFilename, object.size, input.contentHash ?? null, stars, now.getTime(), now.getTime()),
    env.DB.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(raw.id, now.getTime())),
  ]);
  const inserted = (results[0]?.meta.changes ?? 0) > 0;
  if (inserted) {
    await audit(env, input.actorId, "asset.ingested", "asset", input.assetId, { projectId: input.projectId, key: input.key, ratingFromMetadata: stars });
  }
  // Queue failure cannot invalidate the durable source asset. A duplicate finalization also
  // repairs missing generation work once the red gate has explicitly been enabled.
  await enqueueRenditionSafely(env, input.assetId, inserted ? "upload-ingest" : "upload-existing-asset");
  return { assetId: input.assetId, ratingFromMetadata: stars };
}
