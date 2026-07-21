import { createDb, schema } from "@quincy/db";
import { and, eq, sql } from "drizzle-orm";
import { parseXmpRating, XMP_SCAN_BYTES, xmpRatingToStars } from "@quincy/shared";
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
  await db.insert(schema.assets).values({ id: input.assetId, collectionId: raw.id, kind: "photo", r2Key: input.key, originalFilename: input.originalFilename, bytes: object.size, contentHash: input.contentHash ?? null, source: "upload", ratingFromMetadata: stars, createdAt: new Date(), updatedAt: new Date() });
  await db.update(schema.collections).set({ receivedCount: sql`${schema.collections.receivedCount} + 1`, status: "receiving", updatedAt: new Date() }).where(eq(schema.collections.id, raw.id));
  await env.INGEST_QUEUE.send({ type: "asset_ingested", assetId: input.assetId });
  await audit(env, input.actorId, "asset.ingested", "asset", input.assetId, { projectId: input.projectId, key: input.key, ratingFromMetadata: stars });
  return { assetId: input.assetId, ratingFromMetadata: stars };
}
