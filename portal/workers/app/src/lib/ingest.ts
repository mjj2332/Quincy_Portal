import { COLLECTION_RECEIVED_COUNT_SQL, collectionReceivedCountBindings, createDb, guardedStageTransition, schema } from "@quincy/db";
import { and, eq, sql } from "drizzle-orm";
import { enqueueRenditionSafely, parseXmpRating, XMP_SCAN_BYTES, xmpRatingToStars } from "@quincy/shared";
import type { Env } from "../env";
import { audit, auditMeta, type AuditPrincipal } from "./audit";
import { notifyProject } from "./notifications";
import { requireBoardSchemaReady } from "./board-schema";

export type FinalizeIngestDependencies = { beforeMetadataBatch?: () => void | Promise<void> };

export type FinalizeExternalEditedUploadInput = {
  sessionId: string;
  leaseToken: string;
  projectId: string;
  collectionId: string;
  assetId: string;
  key: string;
  originalFilename: string;
  bytes: number;
  auditPrincipal: AuditPrincipal;
  now?: number;
};

/** The lease was valid when R2 work began, but no longer passed the final D1 authorization fence. */
export class ExternalEditedUploadCompletionRejectedError extends Error {
  constructor() {
    super("Edited upload completion authorization or lease was lost");
    this.name = "ExternalEditedUploadCompletionRejectedError";
  }
}

/**
 * Commits the final edited asset and upload-session terminal state in one lease-fenced D1 batch.
 * Unlike the legacy ingest path, this deliberately does not inspect the object body: the External
 * upload route has already performed the final R2 HEAD size/content-type check, and the rendition
 * pipeline is the decode/type gate before publication.
 */
export async function finalizeExternalEditedUpload(env: Env, input: FinalizeExternalEditedUploadInput): Promise<void> {
  const now = input.now ?? Date.now();
  const auditActorId = input.auditPrincipal?.id;
  if (!auditActorId) throw new Error("Edited upload completion requires an audit principal");
  const auditId = crypto.randomUUID();
  const assetInsert = env.DB.prepare(`
    INSERT INTO assets (
      id, collection_id, r2_key, original_filename, bytes, content_hash, source,
      source_raw_asset_id, section, publish_status, rating_from_metadata, created_at, updated_at
    )
    SELECT s.asset_id, s.collection_id, s.r2_key, s.original_filename, s.bytes, NULL, 'upload',
      NULL, 'Manual', 'pending', NULL, ?, ?
    FROM external_edited_upload_sessions s
    INNER JOIN collections c ON c.id = s.collection_id AND c.project_id = s.project_id AND c.kind = 'edited'
    INNER JOIN projects p ON p.id = s.project_id AND p.archived_at IS NULL
    INNER JOIN user recipient ON recipient.id = s.created_by
      AND recipient.active = 1 AND recipient.role = 'external_editor'
      AND recipient.authorization_epoch = s.authorization_epoch
    INNER JOIN project_members pm ON pm.id = s.membership_cycle_id
      AND pm.project_id = s.project_id AND pm.user_id = s.created_by AND pm.role_on_project = 'editor'
    WHERE s.id = ? AND s.status = 'completing' AND s.completion_lease_token = ?
      AND s.project_id = ? AND s.collection_id = ? AND s.asset_id = ?
      AND s.r2_key = ? AND s.bytes = ? AND s.expires_at > ?
    ON CONFLICT(id) DO NOTHING
    RETURNING id
  `).bind(now, now, input.sessionId, input.leaseToken, input.projectId, input.collectionId, input.assetId, input.key, input.bytes, now);
  const audit = env.DB.prepare(`
    INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
    SELECT ?, ?, 'asset.ingested', 'asset', ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM assets WHERE id = ? AND collection_id = ? AND r2_key = ? AND bytes = ?)
      AND EXISTS (
        SELECT 1 FROM external_edited_upload_sessions s
        INNER JOIN user recipient ON recipient.id = s.created_by
          AND recipient.active = 1 AND recipient.role = 'external_editor'
          AND recipient.authorization_epoch = s.authorization_epoch
        INNER JOIN project_members pm ON pm.id = s.membership_cycle_id
          AND pm.project_id = s.project_id AND pm.user_id = s.created_by AND pm.role_on_project = 'editor'
        WHERE s.id = ? AND s.status = 'completing' AND s.completion_lease_token = ?
          AND s.project_id = ? AND s.collection_id = ? AND s.asset_id = ?
          AND s.r2_key = ? AND s.bytes = ? AND s.expires_at > ?
      )
      AND NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'asset.ingested' AND target_type = 'asset' AND target_id = ?)
  `).bind(
    auditId, auditActorId, input.assetId,
    auditMeta(input.auditPrincipal, { projectId: input.projectId, key: input.key, manifestId: null, ratingFromMetadata: null }), now,
    input.assetId, input.collectionId, input.key, input.bytes,
    input.sessionId, input.leaseToken, input.projectId, input.collectionId, input.assetId, input.key, input.bytes, now,
    input.assetId,
  );
  const collectionCount = env.DB.prepare(`${COLLECTION_RECEIVED_COUNT_SQL}
    AND EXISTS (
      SELECT 1 FROM external_edited_upload_sessions s
      INNER JOIN user recipient ON recipient.id = s.created_by
        AND recipient.active = 1 AND recipient.role = 'external_editor'
        AND recipient.authorization_epoch = s.authorization_epoch
      INNER JOIN project_members pm ON pm.id = s.membership_cycle_id
        AND pm.project_id = s.project_id AND pm.user_id = s.created_by AND pm.role_on_project = 'editor'
      WHERE s.id = ? AND s.status = 'completing' AND s.completion_lease_token = ? AND s.expires_at > ?
    )`).bind(...collectionReceivedCountBindings(input.collectionId, now), input.sessionId, input.leaseToken, now);
  const complete = env.DB.prepare(`
    UPDATE external_edited_upload_sessions
    SET status = 'completed', completion_lease_token = NULL, completion_lease_expires_at = NULL,
        completed_at = ?, terminal_at = ?, updated_at = ?
    WHERE id = ? AND status = 'completing' AND completion_lease_token = ? AND expires_at > ?
      AND EXISTS (SELECT 1 FROM assets WHERE id = ? AND collection_id = ? AND r2_key = ? AND bytes = ?)
      AND EXISTS (
        SELECT 1 FROM external_edited_upload_sessions s
        INNER JOIN user recipient ON recipient.id = s.created_by
          AND recipient.active = 1 AND recipient.role = 'external_editor'
          AND recipient.authorization_epoch = s.authorization_epoch
        INNER JOIN project_members pm ON pm.id = s.membership_cycle_id
          AND pm.project_id = s.project_id AND pm.user_id = s.created_by AND pm.role_on_project = 'editor'
        WHERE s.id = ? AND s.status = 'completing' AND s.completion_lease_token = ? AND s.expires_at > ?
      )
  `).bind(now, now, now, input.sessionId, input.leaseToken, now, input.assetId, input.collectionId, input.key, input.bytes, input.sessionId, input.leaseToken, now);
  const results = await env.DB.batch([assetInsert, audit, collectionCount, complete]);
  if ((results[3]?.meta.changes ?? 0) !== 1) throw new ExternalEditedUploadCompletionRejectedError();
}

export async function finalizeIngest(
  env: Env,
  input: { actorId: string; auditPrincipal?: AuditPrincipal; projectId: string; assetId: string; key: string; originalFilename: string; contentHash?: string; collection?: "raw" | "edited"; manifestId?: string },
  dependencies: FinalizeIngestDependencies = {},
) {
  // This check must precede RAW R2/D1 work: a pre-0037 completion cannot leave a durable asset
  // behind while its automatic Stage writer is unavailable. Manual edited uploads do not write
  // Stage and remain available during the migration window.
  if ((input.collection ?? "raw") === "raw") await requireBoardSchemaReady(env);
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
        .bind(crypto.randomUUID(), input.auditPrincipal?.id ?? input.actorId, input.assetId, auditMeta(input.auditPrincipal ?? { id: input.actorId, impersonatedBy: null }, { projectId: input.projectId, key: input.key, manifestId: input.manifestId ?? null, ratingFromMetadata: stars }), now.getTime(), targetCollection.id, rawIdentityKey, input.assetId),
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
    await audit(env, input.auditPrincipal ?? { id: input.actorId, impersonatedBy: null }, "asset.ingested", "asset", input.assetId, { projectId: input.projectId, key: input.key, manifestId: input.manifestId ?? null, ratingFromMetadata: stars });
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
  // repairs missing generation work.
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
      onSuccess: () => notifyProject(env, input.projectId, "raw_ready"),
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
