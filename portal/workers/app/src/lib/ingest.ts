import { COLLECTION_RECEIVED_COUNT_SQL, collectionReceivedCountBindings, createDb, schema } from "@quincy/db";
import { and, eq } from "drizzle-orm";
import { enqueueRenditionSafely, parseXmpRating, XMP_SCAN_BYTES, xmpRatingToStars } from "@quincy/shared";
import type { Env } from "../env";
import { audit } from "./audit";

export async function finalizeIngest(env: Env, input: { actorId: string; projectId: string; assetId: string; key: string; originalFilename: string; contentHash?: string; collection?: "raw" | "edited"; manifestId?: string }) {
  const object = await env.MEDIA.head(input.key);
  if (!object) throw new Error("Uploaded object was not found in R2");
  const header = await env.MEDIA.get(input.key, { range: { offset: 0, length: XMP_SCAN_BYTES } });
  const stars = header ? xmpRatingToStars(parseXmpRating(await header.arrayBuffer())) : null;
  const db = createDb(env.DB);
  const collectionKind = input.collection ?? "raw";
  const targetCollection = collectionKind === "raw"
    ? await db.select().from(schema.collections).where(and(eq(schema.collections.projectId, input.projectId), eq(schema.collections.kind, "raw"))).get()
    : await (async () => {
      await db.insert(schema.collections).values({ id: crypto.randomUUID(), projectId: input.projectId, kind: "edited", status: "empty" }).onConflictDoNothing();
      return db.select({ id: schema.collections.id }).from(schema.collections).where(and(eq(schema.collections.projectId, input.projectId), eq(schema.collections.kind, "edited"))).get();
    })();
  if (!targetCollection) throw new Error(collectionKind === "raw" ? "Project has no RAW collection" : `Unable to resolve edited collection for project ${input.projectId}`);
  if (input.manifestId) {
    if (collectionKind !== "raw") throw new Error("Upload manifests can only be used with RAW uploads");
    const manifest = await db.select({ id: schema.uploadManifests.id })
      .from(schema.uploadManifests)
      .where(and(
        eq(schema.uploadManifests.id, input.manifestId),
        eq(schema.uploadManifests.collectionId, targetCollection.id),
      ))
      .get();
    if (!manifest) throw new Error("Upload manifest does not belong to this project's RAW collection");
  }
  const now = new Date();
  const statements = [
    collectionKind === "raw"
      ? env.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, content_hash, source, manifest_id, rating_from_metadata, created_at, updated_at) VALUES (?, ?, 'photo', ?, ?, ?, ?, 'upload', ?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(input.assetId, targetCollection.id, input.key, input.originalFilename, object.size, input.contentHash ?? null, input.manifestId ?? null, stars, now.getTime(), now.getTime())
      : env.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, content_hash, source, source_raw_asset_id, section, publish_status, rating_from_metadata, created_at, updated_at) VALUES (?, ?, 'photo', ?, ?, ?, ?, 'upload', NULL, 'Manual', 'pending', ?, ?, ?) ON CONFLICT DO NOTHING").bind(input.assetId, targetCollection.id, input.key, input.originalFilename, object.size, input.contentHash ?? null, stars, now.getTime(), now.getTime()),
    env.DB.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(targetCollection.id, now.getTime())),
  ];
  if (input.manifestId) {
    statements.push(env.DB.prepare("UPDATE upload_manifests SET status = 'complete' WHERE id = ? AND status = 'active' AND expected_count = (SELECT count(*) FROM assets WHERE manifest_id = ?)").bind(input.manifestId, input.manifestId));
  }
  const results = await env.DB.batch(statements);
  const inserted = (results[0]?.meta.changes ?? 0) > 0;
  if (inserted) {
    await audit(env, input.actorId, "asset.ingested", "asset", input.assetId, { projectId: input.projectId, key: input.key, manifestId: input.manifestId ?? null, ratingFromMetadata: stars });
  }
  // Manual edited uploads must cross the Dropbox boundary before they become visible. The
  // background publisher is started by the caller after this durable pending row is committed.
  if (collectionKind === "edited") {
    const published = await db.select({ publishStatus: schema.assets.publishStatus }).from(schema.assets).where(eq(schema.assets.id, input.assetId)).get();
    const publishStatus = published?.publishStatus ?? "pending";
    return {
      assetId: input.assetId,
      ratingFromMetadata: stars,
      publishStatus: publishStatus as "pending" | "ready" | "failed",
    };
  }
  // Queue failure cannot invalidate the durable source asset. A duplicate finalization also
  // repairs missing generation work once the red gate has explicitly been enabled.
  await enqueueRenditionSafely(env, input.assetId, inserted ? "upload-ingest" : "upload-existing-asset");
  const mirrored = await db.select({ sourcePath: schema.assets.sourcePath }).from(schema.assets).where(eq(schema.assets.id, input.assetId)).get();
  return {
    assetId: input.assetId,
    ratingFromMetadata: stars,
    publishStatus: "ready" as const,
    mirrorStatus: mirrored?.sourcePath ? "ready" as const : "pending" as const,
  };
}
