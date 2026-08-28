import { and, eq, inArray, sql } from "drizzle-orm";
import {
  assets,
  autoHdrFetchClaims,
  autoHdrHandoffs,
  autoHdrOutputMappings,
  collections,
  editedSourceClaims,
  projects,
} from "@quincy/db/schema";
import { COLLECTION_RECEIVED_COUNT_SQL, collectionReceivedCountBindings } from "@quincy/db";
import { enqueueRenditionSafely } from "@quincy/shared";

import type { Env } from "../env";
import { dbFor } from "../lib/db";
import { download, type DropboxFile } from "../dropbox/client";
import { dropboxPathKey, pathEqualsOrIsBelow } from "../dropbox/paths";
import { notifyProject } from "../notifications";
import { commitAutomaticStage } from "../lib/automatic-stage";

export type FrozenReadinessUnit = { key: string; assetIds: string[] };
export type FinalWriteContext = {
  projectId: string;
  jobId: string;
  claimId: string;
  handoffId: string;
  manifestVersion: number;
  mappingId: string;
  mappingGeneration: number;
  connectionId: string;
  finalPath: string;
  finalPathKey: string;
  trigger: "manual" | "dropbox_delta";
};

export type FinalWriteResult = {
  status: "created" | "same_hash" | "replaced" | "quarantined" | "lost_race";
  assetId?: string;
  coveredUnit?: string;
  stageAdvanced: boolean;
};

export type FinalWriteDependencies = {
  download?: typeof download;
  enqueue?: typeof enqueueRenditionSafely;
  afterR2Write?: () => void | Promise<void>;
  afterD1Commit?: () => void | Promise<void>;
};

export function plainBasename(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").toLowerCase();
}

export function strippedBasename(filename: string): string {
  return plainBasename(filename).replace(/[ _-]+(?:vs|staged)$/i, "");
}

async function shortDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest).slice(0, 10)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function ensureEditedCollection(env: Env, projectId: string): Promise<string> {
  const db = dbFor(env);
  await db.insert(collections).values({ id: crypto.randomUUID(), projectId, kind: "edited", status: "empty" }).onConflictDoNothing();
  const collection = await db.select({ id: collections.id }).from(collections)
    .where(and(eq(collections.projectId, projectId), eq(collections.kind, "edited"))).get();
  if (!collection) throw new Error(`Unable to resolve edited collection for project ${projectId}`);
  return collection.id;
}

async function credibleCoverage(env: Env, context: FinalWriteContext, filename: string) {
  const db = dbFor(env);
  const handoff = await db.select({
    selectedJson: autoHdrHandoffs.selectedAssetIdsJson,
    unitsJson: autoHdrHandoffs.readinessUnitsJson,
  }).from(autoHdrHandoffs).where(eq(autoHdrHandoffs.id, context.handoffId)).get();
  if (!handoff) return null;
  const selectedIds = JSON.parse(handoff.selectedJson) as string[];
  const units = JSON.parse(handoff.unitsJson) as FrozenReadinessUnit[];
  const raws = await db.select({ id: assets.id, filename: assets.originalFilename }).from(assets)
    .where(inArray(assets.id, selectedIds));
  const exact = raws.find((raw) => plainBasename(raw.filename) === plainBasename(filename));
  const matched = exact ?? raws.find((raw) => plainBasename(raw.filename) === strippedBasename(filename));
  if (!matched) return null;
  const unit = units.find((candidate) => candidate.assetIds.includes(matched.id));
  return unit ? { rawAssetId: matched.id, unitKey: unit.key, matchKind: exact ? "exact" as const : "suffix" as const } : null;
}

async function quarantine(env: Env, context: FinalWriteContext, file: DropboxFile, reason: string): Promise<FinalWriteResult> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, NULL, 'autohdr.final_quarantined', 'project', ?, ?, ?)")
      .bind(crypto.randomUUID(), context.projectId, JSON.stringify({ reason, sourcePath: file.path_display ?? file.path_lower, jobId: context.jobId, handoffId: context.handoffId }), now),
    env.DB.prepare("UPDATE autohdr_fetch_claims SET state = 'quarantined', last_error = ?, updated_at = ? WHERE id = ? AND state in ('starting', 'running')")
      .bind(reason, now, context.claimId),
  ]);
  return { status: "quarantined", stageAdvanced: false };
}

type FinalCoverage = NonNullable<Awaited<ReturnType<typeof credibleCoverage>>>;

async function advanceFinalStage(
  env: Env,
  context: FinalWriteContext,
  fence: { stageKey: string; editingEntryBoardRevision: number | null },
  coverage: FinalCoverage | null,
  collectionId: string,
  sourcePathKey: string,
  currentAssetId: string,
): Promise<boolean> {
  if (!coverage || fence.stageKey !== "editing_autohdr") return false;
  if (fence.editingEntryBoardRevision === null) {
    console.error("AutoHDR final completion permanently failed closed", {
      projectId: context.projectId,
      handoffId: context.handoffId,
      mappingId: context.mappingId,
      claimId: context.claimId,
      jobId: context.jobId,
      providerSecret: false,
      reason: "missing editing-entry board revision",
    });
    return false;
  }
  const auditId = crypto.randomUUID();
  const outcome = await commitAutomaticStage({
    env,
    projectId: context.projectId,
    from: "editing_autohdr",
    to: "edited_review",
    oldBoardRevision: fence.editingEntryBoardRevision,
    auditId,
    auditMetaJson: JSON.stringify({
      from: "editing_autohdr",
      to: "edited_review",
      trigger: context.trigger,
      jobId: context.jobId,
      handoffId: context.handoffId,
      mappingGeneration: context.mappingGeneration,
      sourcePathKey,
      credibleCoverage: coverage.unitKey,
    }),
    workflow: {
      kind: "autohdr_final_completion",
      prerequisite: {
        kind: "autohdr_final_claim",
        collectionId,
        sourcePathKey,
        handoffId: context.handoffId,
        mappingId: context.mappingId,
        currentAssetId,
        db: env.DB,
        auditId,
        now: Date.now(),
      },
    },
    legacyWorkflowNotification: "edited_landed",
  });
  if (outcome.kind === "winner") {
    try {
      await notifyProject(env, context.projectId, "edited_landed");
    } catch (error) {
      console.error("AutoHDR final notification failed", { projectId: context.projectId, error });
    }
    return true;
  }
  return false;
}

/** Rechecks every trigger fence immediately before metadata and writes immutable current versions. */
export async function writeAutoHdrFinal(
  env: Env,
  context: FinalWriteContext,
  file: DropboxFile,
  dependencies: FinalWriteDependencies = {},
): Promise<FinalWriteResult> {
  const sourcePath = file.path_display ?? file.path_lower;
  const sourcePathKey = dropboxPathKey(file.path_lower);
  if (!file.content_hash) return quarantine(env, context, file, "Dropbox final has no trusted content hash");
  if (!pathEqualsOrIsBelow(sourcePathKey, context.finalPathKey)) return quarantine(env, context, file, "Final path is outside the frozen mapping");
  const db = dbFor(env);
  const fence = await db.select({
    stageKey: projects.stageKey,
    archivedAt: projects.archivedAt,
    mappingState: autoHdrOutputMappings.state,
    mappingGeneration: autoHdrOutputMappings.generation,
    finalPathKey: autoHdrOutputMappings.finalPathKey,
    mappingConnectionId: autoHdrOutputMappings.connectionId,
    handoffState: autoHdrHandoffs.state,
    manifestVersion: autoHdrHandoffs.manifestVersion,
    editingEntryBoardRevision: autoHdrHandoffs.editingEntryBoardRevision,
  }).from(projects)
    .innerJoin(autoHdrOutputMappings, eq(autoHdrOutputMappings.projectId, projects.id))
    .innerJoin(autoHdrHandoffs, eq(autoHdrOutputMappings.handoffId, autoHdrHandoffs.id))
    .innerJoin(autoHdrFetchClaims, and(
      eq(autoHdrFetchClaims.id, context.claimId),
      eq(autoHdrFetchClaims.projectId, projects.id),
      eq(autoHdrFetchClaims.handoffId, autoHdrHandoffs.id),
      eq(autoHdrFetchClaims.mappingId, autoHdrOutputMappings.id),
      eq(autoHdrFetchClaims.connectionId, context.connectionId),
      eq(autoHdrFetchClaims.mappingGeneration, context.mappingGeneration),
      inArray(autoHdrFetchClaims.state, ["starting", "running"]),
    ))
    .where(and(
      eq(projects.id, context.projectId),
      eq(autoHdrOutputMappings.id, context.mappingId),
      eq(autoHdrHandoffs.id, context.handoffId),
    )).get();
  if (!fence || fence.archivedAt || !["editing_autohdr", "edited_review"].includes(fence.stageKey) ||
      fence.mappingState !== "active" || fence.mappingGeneration !== context.mappingGeneration ||
      fence.finalPathKey !== context.finalPathKey || fence.mappingConnectionId !== context.connectionId ||
      fence.handoffState !== "started" || fence.manifestVersion !== context.manifestVersion) {
    return quarantine(env, context, file, "Final writer fence changed after routing");
  }

  const collectionId = await ensureEditedCollection(env, context.projectId);
  const coverage = await credibleCoverage(env, context, file.name);
  const current = await db.select({
    claimId: editedSourceClaims.id,
    currentAssetId: editedSourceClaims.currentAssetId,
    contentHash: editedSourceClaims.contentHash,
  }).from(editedSourceClaims)
    .where(and(eq(editedSourceClaims.collectionId, collectionId), eq(editedSourceClaims.sourcePathKey, sourcePathKey))).get();
  if (!current) {
    const ambiguousLegacy = await db.select({ id: assets.id }).from(assets).where(and(
      eq(assets.collectionId, collectionId),
      eq(assets.source, "dropbox"),
      eq(assets.originalFilename, file.name),
      sql`${assets.sourcePathKey} IS NULL`,
      sql`${assets.supersededAt} IS NULL`,
    )).get();
    if (ambiguousLegacy) return quarantine(env, context, file, "Legacy edited asset with no source key requires reconciliation");
  }
  if (current && !current.currentAssetId) return quarantine(env, context, file, "Edited source claim has no current asset and requires recovery");
  if (current?.contentHash === file.content_hash && current.currentAssetId) {
    const replayGuard = env.DB.prepare(
      "UPDATE edited_source_claims SET updated_at = updated_at WHERE id = ? AND current_asset_id = ? AND content_hash = ? " +
      "AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL AND stage_key in ('editing_autohdr','edited_review')) " +
      "AND EXISTS (SELECT 1 FROM autohdr_output_mappings m JOIN autohdr_handoffs h ON h.id = m.handoff_id JOIN autohdr_fetch_claims f ON f.mapping_id = m.id AND f.handoff_id = h.id " +
      "WHERE m.id = ? AND m.state = 'active' AND m.generation = ? AND m.final_path_key = ? AND m.connection_id = ? " +
      "AND h.id = ? AND h.state = 'started' AND h.manifest_version = ? AND f.id = ? AND f.connection_id = ? AND f.mapping_generation = ? AND f.state in ('starting','running'))",
    ).bind(
      current.claimId, current.currentAssetId, file.content_hash, context.projectId,
      context.mappingId, context.mappingGeneration, context.finalPathKey, context.connectionId,
      context.handoffId, context.manifestVersion, context.claimId, context.connectionId,
      context.mappingGeneration,
    );
    const replayStatements = [replayGuard];
    if (coverage) {
      replayStatements.push(env.DB.prepare(
        "INSERT INTO autohdr_final_associations (id, handoff_id, asset_id, readiness_unit_key, match_kind, created_at) " +
        "SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1 ON CONFLICT DO NOTHING",
      ).bind(
        crypto.randomUUID(), context.handoffId, current.currentAssetId, coverage.unitKey,
        coverage.matchKind, Date.now(),
      ));
    }
    const replayResult = await env.DB.batch(replayStatements);
    if ((replayResult[0]?.meta.changes ?? 0) !== 1) {
      return quarantine(env, context, file, "Final writer fence changed before same-hash replay repair");
    }
    const stageAdvanced = await advanceFinalStage(env, context, fence, coverage, collectionId, sourcePathKey, current.currentAssetId);
    // A Workflow can fail after the D1 version commit but before its rendition handoff. Replays
    // deliberately re-enqueue the current winner; rendition generation is itself idempotent.
    await (dependencies.enqueue ?? enqueueRenditionSafely)(env, current.currentAssetId, "autohdr-existing-final");
    return { status: "same_hash", assetId: current.currentAssetId, coveredUnit: coverage?.unitKey, stageAdvanced };
  }

  const assetId = crypto.randomUUID();
  const r2Key = `projects/${context.projectId}/edited/dropbox/${await shortDigest(sourcePathKey)}-${file.content_hash}/${file.name}`;
  const source = await (dependencies.download ?? download)(env, db, sourcePath, {}, context.connectionId);
  if (!source.body) throw new Error(`Dropbox returned no body for ${file.name}`);
  await env.MEDIA.put(r2Key, source.body, { httpMetadata: { contentType: "image/jpeg" } });
  await dependencies.afterR2Write?.();
  const now = new Date();
  const baseInsert = env.DB.prepare(
    "INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, content_hash, source, source_path, source_path_key, source_raw_asset_id, section, publish_status, autohdr_handoff_id, created_at, updated_at) " +
    "SELECT ?, ?, 'photo', ?, ?, ?, ?, 'dropbox', ?, ?, ?, 'AutoHDR', 'ready', ?, ?, ? " +
    "WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL AND stage_key in ('editing_autohdr','edited_review')) " +
    "AND EXISTS (SELECT 1 FROM autohdr_output_mappings m JOIN autohdr_handoffs h ON h.id = m.handoff_id JOIN autohdr_fetch_claims f ON f.mapping_id = m.id AND f.handoff_id = h.id " +
    "WHERE m.id = ? AND m.state = 'active' AND m.generation = ? AND m.final_path_key = ? AND m.connection_id = ? " +
    "AND h.id = ? AND h.state = 'started' AND h.manifest_version = ? AND f.id = ? AND f.connection_id = ? AND f.mapping_generation = ? AND f.state in ('starting','running'))",
  ).bind(
    assetId, collectionId, r2Key, file.name, file.size, file.content_hash, sourcePath,
    sourcePathKey, coverage?.rawAssetId ?? null, context.handoffId, now.getTime(), now.getTime(),
    context.projectId, context.mappingId, context.mappingGeneration, context.finalPathKey,
    context.connectionId, context.handoffId, context.manifestVersion, context.claimId,
    context.connectionId, context.mappingGeneration,
  );

  try {
    if (!current) {
      const statements = [
        baseInsert,
        env.DB.prepare("INSERT INTO edited_source_claims (id, collection_id, source_path_key, current_asset_id, content_hash, handoff_id, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1")
          .bind(crypto.randomUUID(), collectionId, sourcePathKey, assetId, file.content_hash, context.handoffId, now.getTime(), now.getTime()),
      ];
      if (coverage) statements.push(env.DB.prepare("INSERT INTO autohdr_final_associations (id, handoff_id, asset_id, readiness_unit_key, match_kind, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM edited_source_claims WHERE collection_id = ? AND source_path_key = ? AND current_asset_id = ?)")
        .bind(crypto.randomUUID(), context.handoffId, assetId, coverage.unitKey, coverage.matchKind, now.getTime(), collectionId, sourcePathKey, assetId));
      statements.push(
        env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'autohdr.final_imported', 'asset', ?, ?, ? WHERE EXISTS (SELECT 1 FROM edited_source_claims WHERE collection_id = ? AND source_path_key = ? AND current_asset_id = ?)")
          .bind(crypto.randomUUID(), assetId, JSON.stringify({ projectId: context.projectId, sourcePathKey, trigger: context.trigger, jobId: context.jobId, handoffId: context.handoffId, mappingGeneration: context.mappingGeneration, connectionId: context.connectionId, credibleCoverage: coverage?.unitKey ?? null }), now.getTime(), collectionId, sourcePathKey, assetId),
        env.DB.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(collectionId, now.getTime())),
      );
      const result = await env.DB.batch(statements);
      if ((result[1]?.meta.changes ?? 0) !== 1) {
        return quarantine(env, context, file, "Final writer fence changed before first-version metadata commit");
      }
      const stageAdvanced = await advanceFinalStage(env, context, fence, coverage, collectionId, sourcePathKey, assetId);
      await dependencies.afterD1Commit?.();
      await (dependencies.enqueue ?? enqueueRenditionSafely)(env, assetId, "autohdr-fetch");
      return { status: "created", assetId, coveredUnit: coverage?.unitKey, stageAdvanced };
    }

    if (fence.stageKey !== "editing_autohdr" && fence.stageKey !== "edited_review") return quarantine(env, context, file, "Project stage does not permit replacement");
    const statements = [
      env.DB.prepare("UPDATE assets SET superseded_at = ?, replaced_by_asset_id = ?, updated_at = ? WHERE id = ? AND superseded_at IS NULL AND content_hash = ?")
        .bind(now.getTime(), assetId, now.getTime(), current.currentAssetId, current.contentHash),
      baseInsert,
      env.DB.prepare("UPDATE edited_source_claims SET current_asset_id = ?, content_hash = ?, handoff_id = ?, updated_at = ? WHERE id = ? AND current_asset_id = ? AND EXISTS (SELECT 1 FROM assets WHERE id = ? AND superseded_at = ?)")
        .bind(assetId, file.content_hash, context.handoffId, now.getTime(), current.claimId, current.currentAssetId, current.currentAssetId, now.getTime()),
    ];
    if (coverage) statements.push(env.DB.prepare("INSERT INTO autohdr_final_associations (id, handoff_id, asset_id, readiness_unit_key, match_kind, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM edited_source_claims WHERE id = ? AND current_asset_id = ?)")
      .bind(crypto.randomUUID(), context.handoffId, assetId, coverage.unitKey, coverage.matchKind, now.getTime(), current.claimId, assetId));
    statements.push(
      env.DB.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(collectionId, now.getTime())),
      env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'autohdr.final_replaced', 'asset', ?, ?, ? WHERE EXISTS (SELECT 1 FROM edited_source_claims WHERE id = ? AND current_asset_id = ?)")
        .bind(crypto.randomUUID(), assetId, JSON.stringify({ priorAssetId: current.currentAssetId, sourcePathKey, handoffId: context.handoffId, jobId: context.jobId, trigger: context.trigger, mappingGeneration: context.mappingGeneration, connectionId: context.connectionId }), now.getTime(), current.claimId, assetId),
    );
    const result = await env.DB.batch(statements);
    if ((result[2]?.meta.changes ?? 0) !== 1) {
      const winner = await db.select({ currentAssetId: editedSourceClaims.currentAssetId, contentHash: editedSourceClaims.contentHash })
        .from(editedSourceClaims).where(eq(editedSourceClaims.id, current.claimId)).get();
      if (winner?.contentHash === file.content_hash && winner.currentAssetId) {
        return { status: "lost_race", assetId: winner.currentAssetId, stageAdvanced: false };
      }
      if (winner?.currentAssetId === current.currentAssetId && winner.contentHash === current.contentHash) {
        return quarantine(env, context, file, "Final writer fence changed before replacement metadata commit");
      }
      throw new Error("Lost AutoHDR replacement race to a different content hash");
    }
    const stageAdvanced = await advanceFinalStage(env, context, fence, coverage, collectionId, sourcePathKey, assetId);
    await dependencies.afterD1Commit?.();
    await (dependencies.enqueue ?? enqueueRenditionSafely)(env, assetId, "autohdr-replacement");
    return { status: "replaced", assetId, coveredUnit: coverage?.unitKey, stageAdvanced };
  } catch (error) {
    // R2 is intentionally retained. A same-key/same-hash winner is replay success.
    const winner = await db.select({ currentAssetId: editedSourceClaims.currentAssetId, contentHash: editedSourceClaims.contentHash })
      .from(editedSourceClaims).where(and(eq(editedSourceClaims.collectionId, collectionId), eq(editedSourceClaims.sourcePathKey, sourcePathKey))).get();
    if (winner?.currentAssetId && (
      winner.contentHash === file.content_hash
      || (winner.currentAssetId !== current?.currentAssetId && winner.contentHash !== current?.contentHash)
    )) {
      return { status: "lost_race", assetId: winner.currentAssetId, stageAdvanced: false };
    }
    throw error;
  }
}
