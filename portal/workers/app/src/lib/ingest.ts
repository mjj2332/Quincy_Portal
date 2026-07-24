import { COLLECTION_RECEIVED_COUNT_SQL, collectionReceivedCountBindings, createDb, guardedStageTransition, schema } from "@quincy/db";
import { and, eq, sql } from "drizzle-orm";
import { enqueueRenditionSafely, parseXmpRating, XMP_SCAN_BYTES, xmpRatingToStars } from "@quincy/shared";
import type { Env } from "../env";
import { audit } from "./audit";

export type FinalizeIngestDependencies = { beforeMetadataBatch?: () => void | Promise<void> };

export async function finalizeIngest(
  env: Env,
  input: { actorId: string; projectId: string; assetId: string; key: string; originalFilename: string; contentHash?: string; collection?: "raw" | "edited"; manifestId?: string },
  dependencies: FinalizeIngestDependencies = {},
) {
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
  const rawIdentityKey = collectionKind === "raw"
    ? input.contentHash ? `hash:${input.contentHash.toLowerCase()}` : `upload:${input.assetId}`
    : null;
  const statements = [
    collectionKind === "raw"
      ? env.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, content_hash, source, manifest_id, rating_from_metadata, created_at, updated_at) SELECT ?, ?, 'photo', ?, ?, ?, ?, 'upload', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL) ON CONFLICT DO NOTHING").bind(input.assetId, targetCollection.id, input.key, input.originalFilename, object.size, input.contentHash ?? null, input.manifestId ?? null, stars, now.getTime(), now.getTime(), input.projectId)
      : env.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, content_hash, source, source_raw_asset_id, section, publish_status, rating_from_metadata, created_at, updated_at) VALUES (?, ?, 'photo', ?, ?, ?, ?, 'upload', NULL, 'Manual', 'pending', ?, ?, ?) ON CONFLICT DO NOTHING").bind(input.assetId, targetCollection.id, input.key, input.originalFilename, object.size, input.contentHash ?? null, stars, now.getTime(), now.getTime()),
  ];
  if (rawIdentityKey) {
    statements.push(
      env.DB.prepare("INSERT INTO asset_ingest_identities (id, collection_id, identity_key, asset_id, created_at) SELECT ?, ?, ?, ?, ? WHERE changes() = 1")
        .bind(crypto.randomUUID(), targetCollection.id, rawIdentityKey, input.assetId, now.getTime()),
      env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, ?, 'asset.ingested', 'asset', ?, ?, ? WHERE EXISTS (SELECT 1 FROM asset_ingest_identities WHERE collection_id = ? AND identity_key = ? AND asset_id = ?)")
        .bind(crypto.randomUUID(), input.actorId, input.assetId, JSON.stringify({ projectId: input.projectId, key: input.key, manifestId: input.manifestId ?? null, ratingFromMetadata: stars }), now.getTime(), targetCollection.id, rawIdentityKey, input.assetId),
    );
  }
  statements.push(env.DB.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(targetCollection.id, now.getTime())));
  if (input.manifestId) {
    statements.push(env.DB.prepare("UPDATE upload_manifests SET status = 'complete' WHERE id = ? AND status = 'active' AND expected_count = (SELECT count(*) FROM assets WHERE manifest_id = ?)").bind(input.manifestId, input.manifestId));
  }
  let results: D1Result<unknown>[] | undefined;
  let effectiveAssetId = input.assetId;
  try {
    await dependencies.beforeMetadataBatch?.();
    results = await env.DB.batch(statements);
  } catch (error) {
    const identityConflict = (() => {
      for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
        if (/UNIQUE constraint failed:\s*asset_ingest_identities\.collection_id,\s*asset_ingest_identities\.identity_key/i.test(cause.message)) return true;
      }
      return false;
    })();
    if (!identityConflict || !rawIdentityKey) throw error;
    const owner = await db.select({ assetId: schema.assetIngestIdentities.assetId })
      .from(schema.assetIngestIdentities)
      .where(and(eq(schema.assetIngestIdentities.collectionId, targetCollection.id), eq(schema.assetIngestIdentities.identityKey, rawIdentityKey)))
      .get();
    if (!owner) throw error;
    effectiveAssetId = owner.assetId;
  }
  let inserted = (results?.[0]?.meta.changes ?? 0) > 0;
  if (collectionKind === "raw" && !inserted) {
    const [sameAsset, project] = await Promise.all([
      db.select({ id: schema.assets.id }).from(schema.assets).where(eq(schema.assets.id, input.assetId)).get(),
      db.select({ archivedAt: schema.projects.archivedAt }).from(schema.projects).where(eq(schema.projects.id, input.projectId)).get(),
    ]);
    if (!sameAsset && project?.archivedAt) throw new Error("Project was archived before RAW metadata could be committed");
  }
  if (inserted && collectionKind !== "raw") {
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
  await enqueueRenditionSafely(env, effectiveAssetId, inserted ? "upload-ingest" : "upload-existing-asset");
  const currentRawAvailable = Boolean(await db.select({ id: schema.assets.id }).from(schema.assets)
    .where(and(eq(schema.assets.collectionId, targetCollection.id), eq(schema.assets.kind, "photo"), sql`${schema.assets.supersededAt} IS NULL`)).get());
  if (currentRawAvailable) {
    await guardedStageTransition(env.DB, {
      projectId: input.projectId,
      from: "awaiting_raw",
      to: "raw_review",
      meta: {
        trigger: "direct_upload",
        assetId: effectiveAssetId,
        manifestId: input.manifestId ?? null,
        durableRawEvidence: { newlyImported: inserted, currentRawAvailable },
      },
    });
  }
  const mirrored = await db.select({ sourcePath: schema.assets.sourcePath }).from(schema.assets).where(eq(schema.assets.id, effectiveAssetId)).get();
  return {
    assetId: effectiveAssetId,
    ratingFromMetadata: stars,
    publishStatus: "ready" as const,
    mirrorStatus: mirrored?.sourcePath ? "ready" as const : "pending" as const,
    durableRawEvidence: { newlyImported: inserted, currentRawAvailable },
  };
}
