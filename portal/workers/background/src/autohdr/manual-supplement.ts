import {
  COLLECTION_RECEIVED_COUNT_SQL,
  collectionReceivedCountBindings,
} from "@quincy/db";
import {
  assetIngestIdentities,
  assets,
  collections,
} from "@quincy/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { enqueueRenditionSafely } from "@quincy/shared";

import type { Env } from "../env";
import { download, type DropboxFile } from "../dropbox/client";
import { dropboxPathKey } from "../dropbox/paths";
import { dbFor } from "../lib/db";

export type ManualSupplementDependencies = {
  download?: typeof download;
  beforeBatch?: () => void | Promise<void>;
};

export type ManualSupplementResult =
  | { status: "created" | "already_ingested"; assetId: string }
  | { status: "skipped" };

const MANUAL_INGEST_LEASE_TTL_MS = 2 * 60_000;

export async function acquireManualIngestLease(env: Env, mappingId: string): Promise<string | null> {
  const ownerToken = crypto.randomUUID();
  const now = Date.now();
  const result = await env.DB.prepare(
    "INSERT INTO autohdr_manual_ingest_leases (mapping_id, owner_token, lease_expires_at, created_at, updated_at) " +
    "SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = ? AND state IN ('pending_discovery', 'active')) " +
    "ON CONFLICT (mapping_id) DO UPDATE SET owner_token = excluded.owner_token, " +
    "lease_expires_at = excluded.lease_expires_at, updated_at = excluded.updated_at " +
    "WHERE autohdr_manual_ingest_leases.lease_expires_at <= excluded.created_at",
  ).bind(mappingId, ownerToken, now + MANUAL_INGEST_LEASE_TTL_MS, now, now, mappingId).run();
  return result.meta.changes === 1 ? ownerToken : null;
}

export async function refreshManualIngestLease(
  env: Env,
  mappingId: string,
  ownerToken: string,
  now: number,
  newExpiry: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE autohdr_manual_ingest_leases SET lease_expires_at = ?, updated_at = ? " +
    "WHERE mapping_id = ? AND owner_token = ? AND lease_expires_at > ?",
  ).bind(newExpiry, now, mappingId, ownerToken, now).run();
  return result.meta.changes === 1;
}

export async function releaseManualIngestLease(env: Env, mappingId: string, ownerToken: string): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM autohdr_manual_ingest_leases WHERE mapping_id = ? AND owner_token = ?",
  ).bind(mappingId, ownerToken).run();
}

const COLLECTION_RECEIVED_COUNT_AFTER_INSERT_SQL = COLLECTION_RECEIVED_COUNT_SQL.replace(
  "WHERE id = ?",
  "WHERE id = ? AND changes() = 1",
);

function causeHas(error: unknown, pattern: RegExp): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (pattern.test(current.message)) return true;
  }
  return false;
}

function sourcePathParent(sourcePathKey: string): { manualFolderKey: string; scaffoldPathKey: string } {
  const fileSeparator = sourcePathKey.lastIndexOf("/");
  const manualFolderKey = sourcePathKey.slice(0, fileSeparator);
  const folderSeparator = manualFolderKey.lastIndexOf("/");
  return {
    manualFolderKey,
    scaffoldPathKey: manualFolderKey.slice(0, folderSeparator),
  };
}

async function ensureEditedCollection(env: Env, projectId: string): Promise<string> {
  const db = dbFor(env);
  await db.insert(collections).values({
    id: crypto.randomUUID(),
    projectId,
    kind: "edited",
    status: "empty",
  }).onConflictDoNothing();
  const collection = await db.select({ id: collections.id })
    .from(collections)
    .where(and(eq(collections.projectId, projectId), eq(collections.kind, "edited")))
    .get();
  if (!collection) throw new Error(`Unable to resolve edited collection for project ${projectId}`);
  return collection.id;
}

async function currentAssetForSource(
  env: Env,
  collectionId: string,
  sourcePathKey: string,
): Promise<string | undefined> {
  const winner = await dbFor(env).select({ id: assets.id })
    .from(assets)
    .where(and(
      eq(assets.collectionId, collectionId),
      eq(assets.sourcePathKey, sourcePathKey),
      isNull(assets.supersededAt),
    ))
    .get();
  return winner?.id;
}

async function reservedAssetForIdentity(
  env: Env,
  collectionId: string,
  identityKey: string,
): Promise<string | undefined> {
  const winner = await dbFor(env).select({ assetId: assetIngestIdentities.assetId })
    .from(assetIngestIdentities)
    .where(and(
      eq(assetIngestIdentities.collectionId, collectionId),
      eq(assetIngestIdentities.identityKey, identityKey),
    ))
    .get();
  return winner?.assetId;
}

/** Imports an AutoHDR manual supplement with a write-time, statement-level eligibility fence. */
export async function ingestManualSupplement(
  env: Env,
  projectId: string,
  handoffId: string,
  mappingId: string,
  connectionId: string,
  file: DropboxFile,
  dependencies: ManualSupplementDependencies,
  ownerToken: string,
): Promise<ManualSupplementResult> {
  const sourcePath = file.path_display ?? file.path_lower;
  const sourcePathKey = dropboxPathKey(file.path_lower);
  const identityKey = `manual-supplement:${sourcePathKey}`;
  const { manualFolderKey, scaffoldPathKey } = sourcePathParent(sourcePathKey);
  const finalPath = sourcePath.slice(0, sourcePath.lastIndexOf("/"));
  const assetId = crypto.randomUUID();
  const r2Key = `projects/${projectId}/edited/dropbox/manual-supplement/${assetId}/${file.name}`;
  const db = dbFor(env);
  const source = await (dependencies.download ?? download)(env, db, sourcePath, {}, connectionId);
  if (!source.body) throw new Error(`Dropbox returned no body for ${file.name}`);
  await env.MEDIA.put(r2Key, source.body, { httpMetadata: { contentType: "image/jpeg" } });

  const collectionId = await ensureEditedCollection(env, projectId);
  const now = Date.now();
  const statements = [
    env.DB.prepare(
      "UPDATE autohdr_output_mappings SET state = 'active', final_path = ?, final_path_key = ?, folder_id = NULL, " +
      "observed_at = ?, diagnostic = NULL, updated_at = ? WHERE id = ? AND state = 'pending_discovery' " +
      "AND EXISTS (SELECT 1 FROM projects p " +
      "JOIN autohdr_handoffs h ON h.project_id = p.id " +
      "JOIN autohdr_output_mappings m ON m.handoff_id = h.id AND m.project_id = p.id " +
      "JOIN autohdr_scaffold_claims s ON s.project_id = p.id " +
      "WHERE p.id = ? AND p.archived_at IS NULL AND p.stage_key IN ('editing_autohdr', 'edited_review') " +
      "AND h.id = ? AND h.connection_id = ? AND h.state = 'started' " +
      "AND m.id = ? AND m.connection_id = ? " +
      "AND s.connection_id = ? AND s.state = 'active' AND s.scaffold_path_key = ? " +
      "AND ? = s.scaffold_path_key || '/04-manual-photos')",
    ).bind(
      finalPath,
      manualFolderKey,
      now,
      now,
      mappingId,
      projectId,
      handoffId,
      connectionId,
      mappingId,
      connectionId,
      connectionId,
      scaffoldPathKey,
      manualFolderKey,
    ),
    env.DB.prepare(
      "INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, content_hash, source, source_path, source_path_key, section, publish_status, autohdr_handoff_id, created_at, updated_at) " +
      "SELECT ?, ?, 'photo', ?, ?, ?, ?, 'dropbox', ?, ?, 'AutoHDR', 'ready', ?, ?, ? " +
      "WHERE EXISTS (SELECT 1 FROM projects p " +
      "JOIN autohdr_handoffs h ON h.project_id = p.id " +
      "JOIN autohdr_output_mappings m ON m.handoff_id = h.id AND m.project_id = p.id " +
      "JOIN autohdr_scaffold_claims s ON s.project_id = p.id " +
      "WHERE p.id = ? AND p.archived_at IS NULL AND p.stage_key IN ('editing_autohdr', 'edited_review') " +
      "AND h.id = ? AND h.connection_id = ? AND h.state = 'started' " +
      "AND m.id = ? AND m.connection_id = ? AND m.state = 'active' " +
      "AND s.connection_id = ? AND s.state = 'active' AND s.scaffold_path_key = ? " +
      "AND ? = s.scaffold_path_key || '/04-manual-photos')",
    ).bind(
      assetId,
      collectionId,
      r2Key,
      file.name,
      file.size,
      file.content_hash ?? null,
      sourcePath,
      sourcePathKey,
      handoffId,
      now,
      now,
      projectId,
      handoffId,
      connectionId,
      mappingId,
      connectionId,
      connectionId,
      scaffoldPathKey,
      manualFolderKey,
    ),
    env.DB.prepare(
      "INSERT INTO asset_ingest_identities (id, collection_id, identity_key, asset_id, created_at) " +
      "SELECT ?, ?, ?, ?, ? WHERE changes() = 1 " +
      "AND EXISTS (SELECT 1 FROM assets WHERE id = ? AND r2_key = ? AND content_hash IS ?)",
    ).bind(
      crypto.randomUUID(),
      collectionId,
      identityKey,
      assetId,
      now,
      assetId,
      r2Key,
      file.content_hash ?? null,
    ),
    env.DB.prepare(COLLECTION_RECEIVED_COUNT_AFTER_INSERT_SQL)
      .bind(...collectionReceivedCountBindings(collectionId, now)),
    env.DB.prepare(
      "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) " +
      "SELECT ?, NULL, 'autohdr.manual_supplement_imported', 'asset', ?, ?, ? " +
      "WHERE EXISTS (SELECT 1 FROM asset_ingest_identities " +
      "WHERE collection_id = ? AND identity_key = ? AND asset_id = ?)",
    ).bind(
      crypto.randomUUID(),
      assetId,
      JSON.stringify({ projectId, handoffId, mappingId, connectionId, sourcePathKey }),
      now,
      collectionId,
      identityKey,
      assetId,
    ),
  ];

  await dependencies.beforeBatch?.();
  const refreshedAt = Date.now();
  const refreshed = await refreshManualIngestLease(
    env,
    mappingId,
    ownerToken,
    refreshedAt,
    refreshedAt + MANUAL_INGEST_LEASE_TTL_MS,
  );
  if (!refreshed) throw new Error(`Manual ingest lease expired before commit for mapping ${mappingId}`);
  try {
    const result = await env.DB.batch(statements);
    // Promotion is result[0]; the asset insert is result[1], whose changes decide creation.
    if ((result[1]?.meta.changes ?? 0) === 0) {
      console.warn("AutoHDR manual supplement skipped: write-time guard rejected", {
        projectId,
        handoffId,
        mappingId,
        sourcePathKey,
      });
      return { status: "skipped" };
    }
    await enqueueRenditionSafely(env, assetId, "autohdr-manual-supplement");
    return { status: "created", assetId };
  } catch (error) {
    const sourceConflict = causeHas(error, /UNIQUE constraint failed:\s*assets\.collection_id,\s*assets\.source_path_key/i);
    const identityConflict = causeHas(error, /UNIQUE constraint failed:\s*asset_ingest_identities\.collection_id,\s*asset_ingest_identities\.identity_key/i);
    if (sourceConflict) {
      const winner = await currentAssetForSource(env, collectionId, sourcePathKey);
      if (!winner) throw error;
      await enqueueRenditionSafely(env, winner, "autohdr-manual-supplement-existing");
      return { status: "already_ingested", assetId: winner };
    }
    if (identityConflict) {
      const winner = await reservedAssetForIdentity(env, collectionId, identityKey);
      if (!winner) throw error;
      await enqueueRenditionSafely(env, winner, "autohdr-manual-supplement-existing");
      return { status: "already_ingested", assetId: winner };
    }
    throw error;
  }
}
