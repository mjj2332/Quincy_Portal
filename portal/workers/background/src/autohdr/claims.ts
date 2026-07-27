import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  assets,
  autoHdrFetchClaims,
  autoHdrFinalAssociations,
  autoHdrHandoffs,
  autoHdrOutputMappings,
  autoHdrPathClaims,
  autoHdrSentFiles,
  collections,
  jobs,
  projects,
  selections,
} from "@quincy/db/schema";
import type { Database } from "@quincy/db";
import { computeRemovalAssetIds } from "@quincy/shared";

import type { Env } from "../env";
import { autoHdrFinalPathCandidates, deriveAutoHdrFolderName } from "./paths";
import { dropboxPathKey, pathEqualsOrIsBelow } from "../dropbox/paths";
import { canonicalDropboxConnectionId } from "../dropbox/connection";
import { setJobStatus } from "../lib/jobs";
import type { RoutedAutoHdrMapping } from "./mapping";
import { plainBasename, strippedBasename } from "./finals";
import { AutoHdrClaimError } from "./errors";

const START_LEASE_MS = 10 * 60_000;

export function isUniqueConflict(error: unknown): boolean {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    if (/UNIQUE constraint failed/i.test(cause.message)) return true;
  }
  return false;
}

export function isWorkflowAlreadyExists(error: unknown): boolean {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    if (/(?:workflow|instance).*(?:already exists|duplicate)|\b409\b/i.test(cause.message)) return true;
  }
  return false;
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type SelectionSnapshot = {
  rows: { assetId: string; filename: string; bracketGroup: string | null }[];
  ids: string[];
  readinessUnits: { key: string; assetIds: string[] }[];
  selectionHash: string;
};

async function currentSelection(db: Database, projectId: string): Promise<SelectionSnapshot> {
  const rows = await db.select({
    assetId: assets.id,
    filename: assets.originalFilename,
    bracketGroup: selections.bracketGroup,
  }).from(selections)
    .innerJoin(assets, eq(selections.assetId, assets.id))
    .innerJoin(collections, eq(assets.collectionId, collections.id))
    .where(and(
      eq(selections.state, "selected_for_editing"),
      eq(collections.projectId, projectId),
      eq(collections.kind, "raw"),
      sql`${assets.supersededAt} IS NULL`,
    ));
  rows.sort((a, b) => a.assetId.localeCompare(b.assetId));
  if (!rows.length) throw new AutoHdrClaimError("ERR_NO_RAW_SELECTION", "No RAW assets are selected for editing");
  const filenames = new Set<string>();
  for (const row of rows) {
    const filename = row.filename.toLowerCase();
    if (filenames.has(filename)) throw new AutoHdrClaimError("ERR_NO_RAW_SELECTION", `Duplicate RAW filename selected for autoHDR: ${row.filename}`);
    filenames.add(filename);
  }
  const readinessMap = new Map<string, string[]>();
  for (const row of rows) {
    const key = row.bracketGroup ? `bracket:${row.bracketGroup}` : `asset:${row.assetId}`;
    readinessMap.set(key, [...(readinessMap.get(key) ?? []), row.assetId].sort());
  }
  const readinessUnits = [...readinessMap].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, assetIds]) => ({ key, assetIds }));
  return {
    rows,
    ids: rows.map((row) => row.assetId),
    readinessUnits,
    selectionHash: await sha256(JSON.stringify(rows.map((row) => [row.assetId, row.bracketGroup]))),
  };
}

async function removalSetHash(ids: readonly string[]): Promise<string> {
  return sha256(JSON.stringify([...ids].sort((left, right) => left.localeCompare(right))));
}

export type HandoffOwner = { handoffId: string; jobId: string; workflowId: string; reused: boolean; retiredHandoffId?: string };
export type HandoffClaimOptions = { startNewRound?: boolean; resumeExisting?: boolean; removalSetHash?: string };
export type HandoffClaimDependencies = { beforeClaimBatch?: () => void | Promise<void>; beforeRepeatBatch?: () => void | Promise<void>; beforeBatch?: () => void | Promise<void> };
export type ImplicitHandoffResult = {
  handoffId: string;
  jobId: string;
  workflowId: string;
  reused: boolean;
  generation: number;
  mappingId: string;
  finalPath: string;
  finalPathKey: string;
  isCollision: boolean;
};
export type BackfillHandoffClaim =
  | { ok: true; handoff: ImplicitHandoffResult }
  | { ok: false; reason: string };

export async function confirmAutoHdrHandoff(
  env: Env,
  input: { projectId: string; handoffId: string; connectionId: string; mappingGeneration: number; initiatedBy: string; jobId: string },
): Promise<boolean> {
  const now = Date.now();
  const result = await env.DB.batch([
    env.DB.prepare("UPDATE projects SET stage_key = 'editing_autohdr', updated_at = ? WHERE id = ? AND stage_key = 'raw_review' AND archived_at IS NULL")
      .bind(now, input.projectId),
    env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, ?, 'stage.auto_advance', 'project', ?, ?, ? WHERE changes() = 1")
      .bind(crypto.randomUUID(), input.initiatedBy, input.projectId, JSON.stringify({ from: "raw_review", to: "editing_autohdr", trigger: "autohdr_handoff", handoffId: input.handoffId, jobId: input.jobId, mappingGeneration: input.mappingGeneration, connectionId: input.connectionId }), now),
    env.DB.prepare("UPDATE autohdr_handoffs SET state = 'started', started_at = coalesce(started_at, ?), updated_at = ? WHERE id = ? AND project_id = ? AND connection_id = ? AND generation = ? AND state in ('starting','started') AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND stage_key = 'editing_autohdr' AND archived_at IS NULL)")
      .bind(now, now, input.handoffId, input.projectId, input.connectionId, input.mappingGeneration, input.projectId),
  ]);
  return (result[2]?.meta.changes ?? 0) === 1;
}

/** Creates the frozen send owner and both permanent candidate claims before Workflow creation. */
export async function claimAutoHdrHandoff(
  env: Env,
  projectId: string,
  initiatedBy: string,
  optionsOrDependencies: HandoffClaimOptions | HandoffClaimDependencies = {},
  dependencies: HandoffClaimDependencies = {},
): Promise<HandoffOwner> {
  const isDependencies = "beforeClaimBatch" in optionsOrDependencies || "beforeRepeatBatch" in optionsOrDependencies || "beforeBatch" in optionsOrDependencies;
  const options: HandoffClaimOptions = isDependencies ? {} : optionsOrDependencies as HandoffClaimOptions;
  if (isDependencies) dependencies = optionsOrDependencies as HandoffClaimDependencies;
  const db = (await import("../lib/db")).dbFor(env);
  const now = new Date();
  const active = await db.select({
    id: autoHdrHandoffs.id,
    jobId: autoHdrHandoffs.jobId,
    workflowId: autoHdrHandoffs.workflowId,
    state: autoHdrHandoffs.state,
    initiatedBy: autoHdrHandoffs.initiatedBy,
    selectionHash: autoHdrHandoffs.selectionHash,
    readinessUnitsJson: autoHdrHandoffs.readinessUnitsJson,
    jobPayloadJson: jobs.payloadJson,
    mappingId: autoHdrOutputMappings.id,
    mappingState: autoHdrOutputMappings.state,
    connectionId: autoHdrHandoffs.connectionId,
    generation: autoHdrHandoffs.generation,
  })
    .from(autoHdrHandoffs)
    .leftJoin(autoHdrOutputMappings, eq(autoHdrOutputMappings.handoffId, autoHdrHandoffs.id))
    .leftJoin(jobs, eq(jobs.id, autoHdrHandoffs.jobId))
    .where(and(eq(autoHdrHandoffs.projectId, projectId), inArray(autoHdrHandoffs.state, ["starting", "started", "blocked"])))
    .get();
  if (active) {
    if (options.resumeExisting) {
      let retiredHandoffId: string | undefined;
      try {
        const payload = active.jobPayloadJson ? JSON.parse(active.jobPayloadJson) : null;
        if (payload && typeof payload.retiredHandoffId === "string") retiredHandoffId = payload.retiredHandoffId;
      } catch { /* malformed payload — leave undefined, matching pre-fix behavior */ }
      return { handoffId: active.id, jobId: active.jobId, workflowId: active.workflowId, reused: true, retiredHandoffId };
    }
    const selection = await currentSelection(db, projectId);
    const isExplicitLive = active.state !== "blocked" && Boolean(active.initiatedBy);
    if (isExplicitLive && active.selectionHash === selection.selectionHash && !options.startNewRound) {
      return { handoffId: active.id, jobId: active.jobId, workflowId: active.workflowId, reused: true };
    }
    if (!options.startNewRound) {
      const sentFiles = await db.select({ assetId: autoHdrSentFiles.assetId, dropboxPathKey: autoHdrSentFiles.dropboxPathKey })
        .from(autoHdrSentFiles).where(eq(autoHdrSentFiles.handoffId, active.id));
      const removalIds = computeRemovalAssetIds(sentFiles, selection.rows);
      throw new AutoHdrClaimError(
        "ERR_HANDOFF_ALREADY_ACTIVE",
        active.state === "blocked"
          ? "The existing AutoHDR handoff is blocked and requires confirmation before starting a new round."
          : "A different AutoHDR selection is already active; confirmation is required before starting a new round.",
        { removalCount: removalIds.length, removalSetHash: await removalSetHash(removalIds) },
      );
    }
    if (active.mappingState === "pending_discovery") {
      throw new AutoHdrClaimError("ERR_HANDOFF_BLOCKED", "AutoHDR hasn't delivered anything for this project yet; wait for the first result before starting a new round");
    }
    return claimAutoHdrRepeatSend(env, db, projectId, initiatedBy, active, selection, options, dependencies);
  }

  const project = await db.select({
    stageKey: projects.stageKey, archivedAt: projects.archivedAt, rawFolderPath: projects.rawFolderPath,
  }).from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new Error(`Project ${projectId} does not exist`);
  if (project.archivedAt) throw new Error(`Project ${projectId} is archived`);
  if (project.stageKey !== "raw_review") throw new Error("AutoHDR handoff requires the project to be exactly in Raw Review");
  if (!project.rawFolderPath) throw new Error("AutoHDR handoff requires a canonical Dropbox RAW folder path");

  const selection = await currentSelection(db, projectId);
  const selectedIds = selection.ids;
  const readinessUnits = selection.readinessUnits;
  const selectionHash = selection.selectionHash;
  const connectionId = await canonicalDropboxConnectionId(db);
  const folderName = deriveAutoHdrFolderName(project.rawFolderPath);
  const candidates = autoHdrFinalPathCandidates(folderName);
  if (candidates.some((candidate) => !pathEqualsOrIsBelow(candidate, "/AutoHDR"))) throw new Error("Invalid AutoHDR final candidate");
  const prior = await db.select({ generation: autoHdrHandoffs.generation }).from(autoHdrHandoffs)
    .where(eq(autoHdrHandoffs.projectId, projectId)).orderBy(desc(autoHdrHandoffs.generation)).limit(1);
  const generation = (prior[0]?.generation ?? 0) + 1;
  const handoffId = crypto.randomUUID();
  const mappingId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  // Workflow instance ids must match ^[a-zA-Z0-9_][a-zA-Z0-9-_]*$ — a ":" separator is rejected
  // at create() with "(instance.invalid_id) Instance has invalid id". Use "-": handoffId is a
  // UUID, so the result stays within the allowed alphabet.
  const workflowId = `autohdr-send-${handoffId}`;
  const lease = new Date(now.getTime() + START_LEASE_MS);
  try {
    await dependencies.beforeClaimBatch?.();
    const results = await env.DB.batch([
      env.DB.prepare("INSERT INTO jobs (id, kind, status, correlation_id, project_id, payload_json, retries, created_at, updated_at) VALUES (?, 'autohdr', 'queued', ?, ?, ?, 0, ?, ?)")
        .bind(jobId, `autohdr:${projectId}:${generation}`, projectId, JSON.stringify({ handoffId, generation, connectionId, assetIds: selectedIds }), now.getTime(), now.getTime()),
      env.DB.prepare("INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, manifest_version, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, initiated_by, expected_origin_stage, state, workflow_id, job_id, lease_expires_at, created_at, updated_at) SELECT ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'raw_review', 'starting', ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL AND stage_key = 'raw_review')")
        .bind(handoffId, projectId, connectionId, generation, selectionHash, JSON.stringify(selectedIds), JSON.stringify(readinessUnits), project.rawFolderPath, initiatedBy, workflowId, jobId, lease.getTime(), now.getTime(), now.getTime(), projectId),
      env.DB.prepare("INSERT INTO autohdr_output_mappings (id, project_id, handoff_id, connection_id, generation, state, created_at, updated_at) SELECT ?, ?, ?, ?, ?, 'pending_discovery', ?, ? WHERE EXISTS (SELECT 1 FROM autohdr_handoffs WHERE id = ? AND state = 'starting')")
        .bind(mappingId, projectId, handoffId, connectionId, generation, now.getTime(), now.getTime(), handoffId),
      ...candidates.map((candidate, index) => env.DB.prepare("INSERT INTO autohdr_path_claims (id, mapping_id, handoff_id, project_id, connection_id, candidate, path, path_key, state, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ? WHERE EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = ? AND handoff_id = ?)")
        .bind(crypto.randomUUID(), mappingId, handoffId, projectId, connectionId, index === 0 ? "final" : "finals", candidate, dropboxPathKey(candidate), now.getTime(), now.getTime(), mappingId, handoffId)),
    ]);
    if ((results[1]?.meta.changes ?? 0) !== 1) {
      const diagnostic = "AutoHDR handoff eligibility changed before claim commit: project must be active in Raw Review.";
      await env.DB.batch([
        env.DB.prepare("UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
          .bind(diagnostic, now.getTime(), jobId),
        env.DB.prepare("INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, manifest_version, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, initiated_by, expected_origin_stage, state, workflow_id, job_id, lease_expires_at, last_error, created_at, updated_at) SELECT ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'raw_review', 'blocked', ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?) AND NOT EXISTS (SELECT 1 FROM autohdr_handoffs WHERE id = ?)")
          .bind(handoffId, projectId, connectionId, generation, selectionHash, JSON.stringify(selectedIds), JSON.stringify(readinessUnits), project.rawFolderPath, initiatedBy, workflowId, jobId, lease.getTime(), diagnostic, now.getTime(), now.getTime(), projectId, handoffId),
      ]);
      throw new Error(diagnostic);
    }
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const winner = await db.select({ id: autoHdrHandoffs.id, jobId: autoHdrHandoffs.jobId, workflowId: autoHdrHandoffs.workflowId })
      .from(autoHdrHandoffs)
      .where(and(eq(autoHdrHandoffs.projectId, projectId), inArray(autoHdrHandoffs.state, ["starting", "started", "blocked"]))).get();
    if (winner) return { handoffId: winner.id, jobId: winner.jobId, workflowId: winner.workflowId, reused: true };
    const collision = await db.select({ mappingId: autoHdrPathClaims.mappingId, pathKey: autoHdrPathClaims.pathKey })
      .from(autoHdrPathClaims).where(and(eq(autoHdrPathClaims.connectionId, connectionId), inArray(autoHdrPathClaims.pathKey, candidates.map(dropboxPathKey)))).get();
    if (collision) {
      const diagnostic = `AutoHDR path claim collision at ${collision.pathKey}; staff resolution is required.`;
      await db.update(autoHdrOutputMappings).set({ state: "blocked_collision", diagnostic, updatedAt: now }).where(eq(autoHdrOutputMappings.id, collision.mappingId));
      await db.update(autoHdrPathClaims).set({ state: "blocked", diagnostic, updatedAt: now }).where(eq(autoHdrPathClaims.mappingId, collision.mappingId));
      const existingMapping = await db.select({ handoffId: autoHdrOutputMappings.handoffId }).from(autoHdrOutputMappings)
        .where(eq(autoHdrOutputMappings.id, collision.mappingId)).get();
      if (existingMapping) {
        await db.update(autoHdrHandoffs).set({ state: "blocked", lastError: diagnostic, updatedAt: now })
          .where(and(eq(autoHdrHandoffs.id, existingMapping.handoffId), inArray(autoHdrHandoffs.state, ["starting", "started"])));
      }
      // The failed all-or-nothing claim batch left no rows for the new project. Persist its
      // frozen manifest and a blocked mapping (without stealing either permanent claim) so both
      // affected sides are operator-visible and an audited reassignment can target it.
      await env.DB.batch([
        env.DB.prepare("INSERT INTO jobs (id, kind, status, correlation_id, project_id, payload_json, retries, error, created_at, updated_at) VALUES (?, 'autohdr', 'failed', ?, ?, ?, 0, ?, ?, ?)")
          .bind(jobId, `autohdr:${projectId}:${generation}`, projectId, JSON.stringify({ handoffId, generation, connectionId, assetIds: selectedIds }), diagnostic, now.getTime(), now.getTime()),
        env.DB.prepare("INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, manifest_version, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, initiated_by, expected_origin_stage, state, workflow_id, job_id, lease_expires_at, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'raw_review', 'blocked', ?, ?, ?, ?, ?, ?)")
          .bind(handoffId, projectId, connectionId, generation, selectionHash, JSON.stringify(selectedIds), JSON.stringify(readinessUnits), project.rawFolderPath, initiatedBy, workflowId, jobId, lease.getTime(), diagnostic, now.getTime(), now.getTime()),
        env.DB.prepare("INSERT INTO autohdr_output_mappings (id, project_id, handoff_id, connection_id, generation, state, diagnostic, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'blocked_collision', ?, ?, ?)")
          .bind(mappingId, projectId, handoffId, connectionId, generation, diagnostic, now.getTime(), now.getTime()),
      ]);
      throw new Error(diagnostic);
    }
    throw error;
  }
  return { handoffId, jobId, workflowId, reused: false };
}

async function claimAutoHdrRepeatSend(
  env: Env,
  db: Database,
  projectId: string,
  initiatedBy: string,
  active: {
    id: string; jobId: string; workflowId: string; state: string; initiatedBy: string | null;
    selectionHash: string; readinessUnitsJson: string;
    mappingId: string | null; mappingState: string | null; connectionId: string; generation: number;
  },
  selection: SelectionSnapshot,
  options: HandoffClaimOptions,
  dependencies: HandoffClaimDependencies,
): Promise<HandoffOwner> {
  if (!active.mappingId || !["active", "blocked_collision"].includes(active.mappingState ?? "")) {
    throw new AutoHdrClaimError("ERR_HANDOFF_BLOCKED", "AutoHDR output is not ready for a repeat send; wait for folder discovery to complete");
  }
  const mappingId = active.mappingId;
  const now = new Date();
  const nowMs = now.getTime();
  const oldUnits = JSON.parse(active.readinessUnitsJson) as { key: string; assetIds: string[] }[];
  const associations = await db.select({ readinessUnitKey: autoHdrFinalAssociations.readinessUnitKey })
    .from(autoHdrFinalAssociations).where(eq(autoHdrFinalAssociations.handoffId, active.id));
  const associatedUnits = new Set(associations.map((row) => row.readinessUnitKey));
  const openAssetIds = oldUnits.filter((unit) => !associatedUnits.has(unit.key)).flatMap((unit) => unit.assetIds);
  const oldRaws = openAssetIds.length
    ? await db.select({ id: assets.id, filename: assets.originalFilename }).from(assets).where(inArray(assets.id, openAssetIds))
    : [];
  const oldBasenames = new Set(oldRaws.flatMap((raw) => [plainBasename(raw.filename), strippedBasename(raw.filename)]));
  const overlapping = selection.rows.some((raw) => oldBasenames.has(plainBasename(raw.filename)) || oldBasenames.has(strippedBasename(raw.filename)));
  if (overlapping) {
    throw new AutoHdrClaimError("ERR_SELECTION_OVERLAPS_OPEN_DELIVERY", "The new selection overlaps an open AutoHDR delivery by normalized filename; wait for that delivery to resolve before resending");
  }

  const associationCountAtCheck = associations.length;
  const sentFiles = await db.select({ assetId: autoHdrSentFiles.assetId, dropboxPathKey: autoHdrSentFiles.dropboxPathKey })
    .from(autoHdrSentFiles).where(eq(autoHdrSentFiles.handoffId, active.id));
  const removalIds = computeRemovalAssetIds(sentFiles, selection.rows);
  const computedRemovalHash = await removalSetHash(removalIds);
  if (options.removalSetHash !== computedRemovalHash) {
    throw new AutoHdrClaimError("ERR_REMOVAL_SET_CHANGED", "The selected assets changed while the repeat-send confirmation was open; review the new removal count and confirm again", {
      removalCount: removalIds.length,
      removalSetHash: computedRemovalHash,
    });
  }
  const sentFilesCountAtCheck = sentFiles.length;
  const activeFetch = await db.select({ id: autoHdrFetchClaims.id }).from(autoHdrFetchClaims).where(and(
    eq(autoHdrFetchClaims.mappingId, mappingId),
    inArray(autoHdrFetchClaims.state, ["starting", "running"]),
  )).get();
  if (activeFetch) throw new AutoHdrClaimError("ERR_FETCH_IN_PROGRESS", "An AutoHDR fetch is still in progress for the current round; wait for it to finish before starting a new round");

  const project = await db.select({ rawFolderPath: projects.rawFolderPath, stageKey: projects.stageKey, archivedAt: projects.archivedAt })
    .from(projects).where(eq(projects.id, projectId)).get();
  if (!project || project.archivedAt || !["editing_autohdr", "edited_review"].includes(project.stageKey)) {
    throw new AutoHdrClaimError("ERR_HANDOFF_BLOCKED", "The project changed state before the repeat send could start; try again");
  }
  if (!project.rawFolderPath) throw new AutoHdrClaimError("ERR_HANDOFF_BLOCKED", "AutoHDR repeat send requires a canonical Dropbox RAW folder path");
  const connectionId = await canonicalDropboxConnectionId(db);
  const candidates = autoHdrFinalPathCandidates(deriveAutoHdrFolderName(project.rawFolderPath));
  const existingByCandidatePath = new Map<string, { id: string; candidate: string; path: string; pathKey: string }>();
  const candidateKeys = new Set(candidates.map(dropboxPathKey));
  const projectClaims = await db.select({ id: autoHdrPathClaims.id, candidate: autoHdrPathClaims.candidate, path: autoHdrPathClaims.path, pathKey: autoHdrPathClaims.pathKey })
    .from(autoHdrPathClaims).where(and(eq(autoHdrPathClaims.projectId, projectId), inArray(autoHdrPathClaims.pathKey, [...candidateKeys])));
  for (const row of projectClaims) existingByCandidatePath.set(row.pathKey, row);

  const handoffId = crypto.randomUUID();
  const mappingNewId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const workflowId = `autohdr-send-${handoffId}`;
  const lease = new Date(nowMs + START_LEASE_MS);
  const diagnostic = "AutoHDR repeat-send claim could not reclaim both candidate paths; staff resolution is required.";
  await (dependencies.beforeRepeatBatch ?? dependencies.beforeBatch)?.();
  let results: Awaited<ReturnType<Env["DB"]["batch"]>>;
  try {
    results = await env.DB.batch([
      env.DB.prepare("UPDATE autohdr_output_mappings SET state = 'retired', retired_at = ?, updated_at = ? WHERE id = ? AND handoff_id = ? AND state IN ('active', 'blocked_collision') AND EXISTS (SELECT 1 FROM autohdr_handoffs WHERE id = ? AND project_id = ? AND state IN ('starting','started','blocked')) AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL AND stage_key IN ('editing_autohdr','edited_review')) AND NOT EXISTS (SELECT 1 FROM autohdr_fetch_claims WHERE mapping_id = ? AND state IN ('starting','running')) AND (SELECT COUNT(*) FROM autohdr_final_associations WHERE handoff_id = ?) = ? AND (SELECT COUNT(*) FROM autohdr_sent_files WHERE handoff_id = ?) = ? AND (SELECT COUNT(*) FROM autohdr_path_claims WHERE mapping_id = ? AND state IN ('active','pending','blocked')) = 2 AND EXISTS (SELECT 1 FROM autohdr_handoffs h JOIN jobs j ON j.id = h.job_id WHERE h.id = ? AND j.status NOT IN ('queued','running'))")
        .bind(nowMs, nowMs, mappingId, active.id, active.id, projectId, projectId, mappingId, active.id, associationCountAtCheck, active.id, sentFilesCountAtCheck, mappingId, active.id),
      env.DB.prepare("UPDATE autohdr_handoffs SET state = 'retired', updated_at = ? WHERE id = ? AND state IN ('starting','started','blocked') AND changes() = 1")
        .bind(nowMs, active.id),
      env.DB.prepare("UPDATE autohdr_path_claims SET state = 'tombstone', updated_at = ? WHERE mapping_id = ? AND state IN ('active','pending','blocked') AND changes() = 1")
        .bind(nowMs, mappingId),
      env.DB.prepare("INSERT INTO jobs (id, kind, status, correlation_id, project_id, payload_json, retries, created_at, updated_at) SELECT ?, 'autohdr', 'queued', ?, ?, ?, 0, ?, ? WHERE changes() = 2")
        .bind(jobId, `autohdr:${projectId}:${active.generation + 1}`, projectId, JSON.stringify({ handoffId, generation: active.generation + 1, connectionId, assetIds: selection.ids, retiredHandoffId: active.id }), nowMs, nowMs),
      env.DB.prepare("INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, manifest_version, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, initiated_by, expected_origin_stage, state, workflow_id, job_id, lease_expires_at, created_at, updated_at) SELECT ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ? WHERE changes() = 1 AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL AND stage_key IN ('editing_autohdr','edited_review'))")
        .bind(handoffId, projectId, connectionId, active.generation + 1, selection.selectionHash, JSON.stringify(selection.ids), JSON.stringify(selection.readinessUnits), project.rawFolderPath, initiatedBy, project.stageKey, workflowId, jobId, lease.getTime(), nowMs, nowMs, projectId),
      env.DB.prepare("INSERT INTO autohdr_output_mappings (id, project_id, handoff_id, connection_id, generation, state, created_at, updated_at) SELECT ?, ?, ?, ?, ?, 'pending_discovery', ?, ? WHERE changes() = 1 AND EXISTS (SELECT 1 FROM autohdr_handoffs WHERE id = ?)")
        .bind(mappingNewId, projectId, handoffId, connectionId, active.generation + 1, nowMs, nowMs, handoffId),
      env.DB.prepare("UPDATE projects SET stage_key = 'editing_autohdr', updated_at = ? WHERE id = ? AND stage_key = 'edited_review' AND archived_at IS NULL AND EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = ?)")
        .bind(nowMs, projectId, mappingNewId),
      env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, ?, 'stage.auto_advance', 'project', ?, ?, ? WHERE changes() = 1")
        .bind(crypto.randomUUID(), initiatedBy, projectId, JSON.stringify({ from: "edited_review", to: "editing_autohdr", trigger: "autohdr_repeat_send", handoffId, jobId, mappingGeneration: active.generation + 1, connectionId }), nowMs),
      ...candidates.map((candidate, index) => {
        const path = candidate;
        const pathKey = dropboxPathKey(path);
        const existing = existingByCandidatePath.get(pathKey);
        return existing
          ? env.DB.prepare("UPDATE autohdr_path_claims SET state = 'pending', handoff_id = ?, mapping_id = ?, connection_id = ?, folder_id = NULL, diagnostic = NULL, updated_at = ? WHERE id = ? AND project_id = ? AND state = 'tombstone' AND EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = ?)")
            .bind(handoffId, mappingNewId, connectionId, nowMs, existing.id, projectId, mappingNewId)
          : env.DB.prepare("INSERT INTO autohdr_path_claims (id, mapping_id, handoff_id, project_id, connection_id, candidate, path, path_key, state, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ? WHERE EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = ?)")
            .bind(crypto.randomUUID(), mappingNewId, handoffId, projectId, connectionId, index === 0 ? "final" : "finals", path, pathKey, nowMs, nowMs, mappingNewId);
      }),
    ]);
  } catch (error) {
    if (isUniqueConflict(error)) throw new AutoHdrClaimError("ERR_MAPPING_BLOCKED", "AutoHDR path ownership collided with another project; staff resolution is required");
    throw error;
  }

  if ((results[0]?.meta.changes ?? 0) !== 1) {
    const stillFetching = await db.select({ id: autoHdrFetchClaims.id }).from(autoHdrFetchClaims).where(and(eq(autoHdrFetchClaims.mappingId, mappingId), inArray(autoHdrFetchClaims.state, ["starting", "running"]))).get();
    if (stillFetching) throw new AutoHdrClaimError("ERR_FETCH_IN_PROGRESS", "An AutoHDR fetch is still in progress for the current round; wait for it to finish before starting a new round");
    throw new AutoHdrClaimError("ERR_HANDOFF_BLOCKED", "The current AutoHDR round changed while the repeat send was starting; try again");
  }
  const reactivationResults = results.slice(8, 10);
  if (reactivationResults.some((result) => (result.meta.changes ?? 0) !== 1)) {
    await env.DB.batch([
      env.DB.prepare("UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(diagnostic, nowMs, jobId),
      env.DB.prepare("UPDATE autohdr_output_mappings SET state = 'blocked_collision', diagnostic = ?, updated_at = ? WHERE id = ?").bind(diagnostic, nowMs, mappingNewId),
      env.DB.prepare("UPDATE autohdr_handoffs SET state = 'blocked', last_error = ?, updated_at = ? WHERE id = ?").bind(diagnostic, nowMs, handoffId),
      env.DB.prepare("UPDATE autohdr_path_claims SET state = 'blocked', diagnostic = ?, updated_at = ? WHERE mapping_id = ?").bind(diagnostic, nowMs, mappingNewId),
    ]);
    throw new AutoHdrClaimError("ERR_MAPPING_BLOCKED", diagnostic);
  }
  return { handoffId, jobId, workflowId, reused: false, retiredHandoffId: active.id };
}

function candidateForPath(targetPath: string): "manual" | "final" | "finals" {
  const lowerPath = targetPath.toLowerCase();
  return lowerPath.endsWith("/04-manual-photos")
    ? "manual"
    : lowerPath.endsWith("/04-finals-photos")
      ? "finals"
      : "final";
}

/** Creates the first, single-leaf handoff when a scaffolded project receives edited content. */
export async function claimImplicitAutoHdrHandoff(
  env: Env,
  projectId: string,
  connectionId: string,
  targetPath: string,
): Promise<ImplicitHandoffResult | null> {
  const db = (await import("../lib/db")).dbFor(env);
  const now = new Date();
  const nowMs = now.getTime();
  const targetPathKey = dropboxPathKey(targetPath);
  const activeWinner = await db.select({
    handoffId: autoHdrHandoffs.id,
    jobId: autoHdrHandoffs.jobId,
    workflowId: autoHdrHandoffs.workflowId,
    generation: autoHdrHandoffs.generation,
    mappingId: autoHdrOutputMappings.id,
    finalPath: autoHdrOutputMappings.finalPath,
    finalPathKey: autoHdrOutputMappings.finalPathKey,
    handoffState: autoHdrHandoffs.state,
  }).from(autoHdrHandoffs)
    .innerJoin(autoHdrOutputMappings, eq(autoHdrHandoffs.id, autoHdrOutputMappings.handoffId))
    .where(and(
      eq(autoHdrHandoffs.projectId, projectId),
      inArray(autoHdrHandoffs.state, ["starting", "started", "blocked"]),
    )).get();
  if (activeWinner?.finalPath && activeWinner.finalPathKey) {
    return {
      handoffId: activeWinner.handoffId,
      jobId: activeWinner.jobId,
      workflowId: activeWinner.workflowId,
      reused: true,
      generation: activeWinner.generation,
      mappingId: activeWinner.mappingId,
      finalPath: activeWinner.finalPath,
      finalPathKey: activeWinner.finalPathKey,
      isCollision: activeWinner.handoffState === "blocked",
    };
  }

  const collidingClaim = await db.select({
    id: autoHdrPathClaims.id,
    projectId: autoHdrPathClaims.projectId,
    state: autoHdrPathClaims.state,
  }).from(autoHdrPathClaims).where(and(
    eq(autoHdrPathClaims.connectionId, connectionId),
    eq(autoHdrPathClaims.pathKey, targetPathKey),
  )).get();
  const isCollision = Boolean(collidingClaim && collidingClaim.projectId !== projectId);
  const diagnostic = isCollision
    ? `AutoHDR path collision at ${targetPathKey}; owned by project ${collidingClaim!.projectId}.`
    : null;
  const handoffId = crypto.randomUUID();
  const mappingId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const workflowId = `autohdr-implicit-${projectId}-g1`;
  const candidate = candidateForPath(targetPath);
  const metaJson = JSON.stringify({
    from: "raw_review",
    to: "editing_autohdr",
    trigger: "autohdr_implicit_handoff",
    handoffId,
    jobId,
    mappingGeneration: 1,
    connectionId,
    targetPath,
  });

  const batchStatements: ReturnType<typeof env.DB.prepare>[] = [
    env.DB.prepare(`
      INSERT INTO jobs (id, kind, status, correlation_id, project_id, payload_json, retries, error, created_at, updated_at)
      SELECT ?, 'autohdr', ?, ?, ?, ?, 0, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM projects
        WHERE id = ? AND archived_at IS NULL AND stage_key IN ('raw_review', 'editing_autohdr')
      ) AND NOT EXISTS (
        SELECT 1 FROM autohdr_handoffs WHERE project_id = ?
      )
    `).bind(
      jobId,
      isCollision ? "failed" : "done",
      `autohdr:implicit:${projectId}:1`,
      projectId,
      JSON.stringify({ implicit: true, targetPath, isCollision }),
      diagnostic,
      nowMs,
      nowMs,
      projectId,
      projectId,
    ),
    env.DB.prepare(`
      INSERT INTO autohdr_handoffs (
        id, project_id, connection_id, generation, manifest_version, selection_hash,
        selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path,
        initiated_by, expected_origin_stage, state, workflow_id, job_id,
        lease_expires_at, started_at, last_error, created_at, updated_at
      ) SELECT
        ?, ?, ?, 1, 1, 'implicit-autodetect',
        '[]', '[]', COALESCE(raw_folder_path, ''),
        NULL, 'raw_review', ?, ?, ?,
        ?, ?, ?, ?, ?
      FROM projects
      WHERE id = ? AND archived_at IS NULL AND stage_key IN ('raw_review', 'editing_autohdr')
        AND EXISTS (SELECT 1 FROM jobs WHERE id = ?)
        AND NOT EXISTS (SELECT 1 FROM autohdr_handoffs WHERE project_id = ?)
    `).bind(
      handoffId,
      projectId,
      connectionId,
      isCollision ? "retired" : "started",
      workflowId,
      jobId,
      nowMs + 86_400_000,
      nowMs,
      diagnostic,
      nowMs,
      nowMs,
      projectId,
      jobId,
      projectId,
    ),
    env.DB.prepare(`
      INSERT INTO autohdr_output_mappings (
        id, project_id, handoff_id, connection_id, generation,
        state, final_path, final_path_key, diagnostic, observed_at, created_at, updated_at
      ) SELECT
        ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM autohdr_handoffs WHERE id = ?)
    `).bind(
      mappingId,
      projectId,
      handoffId,
      connectionId,
      isCollision ? "blocked_collision" : "active",
      targetPath,
      targetPathKey,
      diagnostic,
      nowMs,
      nowMs,
      nowMs,
      handoffId,
    ),
  ];
  const handoffInsertIndex = 1;

  if (!isCollision && collidingClaim?.projectId === projectId) {
    batchStatements.push(env.DB.prepare(`
      UPDATE autohdr_path_claims
      SET state = 'active', handoff_id = ?, mapping_id = ?, diagnostic = NULL, updated_at = ?
      WHERE id = ?
        AND state IN ('tombstone', 'blocked')
        AND EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = ?)
    `).bind(handoffId, mappingId, nowMs, collidingClaim.id, mappingId));
  } else if (!isCollision) {
    batchStatements.push(env.DB.prepare(`
      INSERT INTO autohdr_path_claims (
        id, mapping_id, handoff_id, project_id, connection_id, candidate,
        path, path_key, state, created_at, updated_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?
      WHERE EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = ?)
    `).bind(
      crypto.randomUUID(),
      mappingId,
      handoffId,
      projectId,
      connectionId,
      candidate,
      targetPath,
      targetPathKey,
      nowMs,
      nowMs,
      mappingId,
    ));
  }

  batchStatements.push(
    env.DB.prepare(`
      UPDATE projects
      SET stage_key = 'editing_autohdr', updated_at = ?
      WHERE id = ? AND stage_key = 'raw_review' AND archived_at IS NULL
        AND ? = 0
        AND EXISTS (SELECT 1 FROM autohdr_handoffs WHERE id = ?)
    `).bind(nowMs, projectId, isCollision ? 1 : 0, handoffId),
    env.DB.prepare(`
      INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?, NULL, 'stage.auto_advance', 'project', ?, ?, ?
      WHERE changes() = 1
    `).bind(crypto.randomUUID(), projectId, metaJson, nowMs),
  );

  const results = await env.DB.batch(batchStatements);
  if ((results[handoffInsertIndex]?.meta.changes ?? 0) !== 1) return null;
  return {
    handoffId,
    jobId,
    workflowId,
    reused: false,
    generation: 1,
    mappingId,
    finalPath: targetPath,
    finalPathKey: targetPathKey,
    isCollision,
  };
}

/** Atomically creates an observed provider mapping for an operator-driven stranded-project scan. */
export async function claimBackfillAutoHdrHandoff(
  env: Env,
  projectId: string,
  connectionId: string,
  targetPath: string,
  folderId: string,
): Promise<BackfillHandoffClaim> {
  const db = (await import("../lib/db")).dbFor(env);
  const now = new Date();
  const nowMs = now.getTime();
  const targetPathKey = dropboxPathKey(targetPath);
  const activeHandoff = await db.select({ id: autoHdrHandoffs.id }).from(autoHdrHandoffs)
    .where(and(
      eq(autoHdrHandoffs.projectId, projectId),
      inArray(autoHdrHandoffs.state, ["starting", "started", "blocked"]),
    )).get();
  if (activeHandoff) return { ok: false, reason: "An active AutoHDR handoff already exists" };

  const collidingClaim = await db.select({
    id: autoHdrPathClaims.id,
    projectId: autoHdrPathClaims.projectId,
    state: autoHdrPathClaims.state,
  }).from(autoHdrPathClaims).where(and(
    eq(autoHdrPathClaims.connectionId, connectionId),
    eq(autoHdrPathClaims.pathKey, targetPathKey),
  )).get();
  if (collidingClaim && collidingClaim.projectId !== projectId) {
    return {
      ok: false,
      reason: `AutoHDR path collision at ${targetPathKey}; owned by project ${collidingClaim.projectId}`,
    };
  }
  if (collidingClaim && !["tombstone", "blocked"].includes(collidingClaim.state)) {
    return {
      ok: false,
      reason: `Existing AutoHDR path claim is ${collidingClaim.state} and cannot be reactivated`,
    };
  }

  const maxGenRow = await db.select({ maxGen: sql<number>`COALESCE(MAX(${autoHdrHandoffs.generation}), 0)` })
    .from(autoHdrHandoffs).where(eq(autoHdrHandoffs.projectId, projectId)).get();
  const generation = Number(maxGenRow?.maxGen ?? 0) + 1;
  const handoffId = crypto.randomUUID();
  const mappingId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const workflowId = `autohdr-backfill-${projectId}-g${generation}`;
  const candidate = candidateForPath(targetPath);
  const eligibility = `
    id = ? AND archived_at IS NULL AND stage_key IN ('raw_review', 'editing_autohdr')
    AND NOT EXISTS (
      SELECT 1 FROM autohdr_handoffs
      WHERE project_id = ? AND state IN ('starting', 'started', 'blocked')
    )
  `;
  const batchStatements: ReturnType<typeof env.DB.prepare>[] = [
    env.DB.prepare(`
      INSERT INTO jobs (id, kind, status, correlation_id, project_id, payload_json, retries, created_at, updated_at)
      SELECT ?, 'autohdr', 'done', ?, ?, ?, 0, ?, ?
      FROM projects WHERE ${eligibility}
    `).bind(
      jobId,
      `autohdr:backfill:${projectId}:${generation}`,
      projectId,
      JSON.stringify({ backfill: true, targetPath }),
      nowMs,
      nowMs,
      projectId,
      projectId,
    ),
    env.DB.prepare(`
      INSERT INTO autohdr_handoffs (
        id, project_id, connection_id, generation, manifest_version, selection_hash,
        selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path,
        initiated_by, expected_origin_stage, state, workflow_id, job_id,
        lease_expires_at, started_at, created_at, updated_at
      ) SELECT
        ?, ?, ?, ?, 1, 'backfill-v2',
        '[]', '[]', COALESCE(raw_folder_path, ''),
        NULL, 'raw_review', 'started', ?, ?,
        ?, ?, ?, ?
      FROM projects
      WHERE ${eligibility}
        AND EXISTS (SELECT 1 FROM jobs WHERE id = ?)
    `).bind(
      handoffId,
      projectId,
      connectionId,
      generation,
      workflowId,
      jobId,
      nowMs + 86_400_000,
      nowMs,
      nowMs,
      nowMs,
      projectId,
      projectId,
      jobId,
    ),
    env.DB.prepare(`
      INSERT INTO autohdr_output_mappings (
        id, project_id, handoff_id, connection_id, generation,
        state, final_path, final_path_key, folder_id, observed_at, created_at, updated_at
      ) SELECT ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM autohdr_handoffs WHERE id = ?)
    `).bind(
      mappingId,
      projectId,
      handoffId,
      connectionId,
      generation,
      targetPath,
      targetPathKey,
      folderId,
      nowMs,
      nowMs,
      nowMs,
      handoffId,
    ),
  ];
  const handoffInsertIndex = 1;
  if (collidingClaim) {
    batchStatements.push(env.DB.prepare(`
      UPDATE autohdr_path_claims
      SET state = 'active', handoff_id = ?, mapping_id = ?, folder_id = ?, diagnostic = NULL, updated_at = ?
      WHERE id = ?
        AND state IN ('tombstone', 'blocked')
        AND EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = ?)
    `).bind(handoffId, mappingId, folderId, nowMs, collidingClaim.id, mappingId));
  } else {
    batchStatements.push(env.DB.prepare(`
      INSERT INTO autohdr_path_claims (
        id, mapping_id, handoff_id, project_id, connection_id, candidate,
        path, path_key, folder_id, state, created_at, updated_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?
      WHERE EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = ?)
    `).bind(
      crypto.randomUUID(),
      mappingId,
      handoffId,
      projectId,
      connectionId,
      candidate,
      targetPath,
      targetPathKey,
      folderId,
      nowMs,
      nowMs,
      mappingId,
    ));
  }
  batchStatements.push(
    env.DB.prepare(`
      UPDATE projects
      SET stage_key = 'editing_autohdr', updated_at = ?
      WHERE id = ? AND stage_key = 'raw_review' AND archived_at IS NULL
        AND EXISTS (SELECT 1 FROM autohdr_handoffs WHERE id = ?)
    `).bind(nowMs, projectId, handoffId),
    env.DB.prepare(`
      INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?, NULL, 'stage.auto_advance', 'project', ?, ?, ?
      WHERE changes() = 1
    `).bind(
      crypto.randomUUID(),
      projectId,
      JSON.stringify({
        from: "raw_review",
        to: "editing_autohdr",
        trigger: "autohdr_backfill",
        handoffId,
        jobId,
        mappingGeneration: generation,
        connectionId,
        targetPath,
      }),
      nowMs,
    ),
  );

  let results: D1Result[];
  try {
    results = await env.DB.batch(batchStatements);
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const concurrent = await db.select({ id: autoHdrHandoffs.id }).from(autoHdrHandoffs)
      .where(and(
        eq(autoHdrHandoffs.projectId, projectId),
        inArray(autoHdrHandoffs.state, ["starting", "started", "blocked"]),
      )).get();
    if (concurrent && concurrent.id !== handoffId) {
      return {
        ok: false,
        reason: "A concurrent handoff claimed this project during backfill — skipping, it's no longer stranded",
      };
    }
    const holder = await db.select({ projectId: autoHdrPathClaims.projectId }).from(autoHdrPathClaims)
      .where(and(
        eq(autoHdrPathClaims.connectionId, connectionId),
        eq(autoHdrPathClaims.pathKey, targetPathKey),
      )).get();
    if (holder && holder.projectId !== projectId) {
      return {
        ok: false,
        reason: `AutoHDR path collision at ${targetPathKey}; owned by project ${holder.projectId}`,
      };
    }
    throw error;
  }

  if ((results[handoffInsertIndex]?.meta.changes ?? 0) !== 1) {
    const current = await db.select({
      archivedAt: projects.archivedAt,
      stageKey: projects.stageKey,
    }).from(projects).where(eq(projects.id, projectId)).get();
    if (current?.archivedAt) {
      return { ok: false, reason: "Project was archived between selection and write" };
    }
    const concurrent = await db.select({ id: autoHdrHandoffs.id }).from(autoHdrHandoffs)
      .where(and(
        eq(autoHdrHandoffs.projectId, projectId),
        inArray(autoHdrHandoffs.state, ["starting", "started", "blocked"]),
      )).get();
    if (concurrent) {
      return {
        ok: false,
        reason: "A concurrent handoff claimed this project during backfill — skipping, it's no longer stranded",
      };
    }
    return {
      ok: false,
      reason: `Project is no longer eligible for backfill${current ? ` (stage ${current.stageKey})` : ""}`,
    };
  }

  return {
    ok: true,
    handoff: {
      handoffId,
      jobId,
      workflowId,
      reused: false,
      generation,
      mappingId,
      finalPath: targetPath,
      finalPathKey: targetPathKey,
      isCollision: false,
    },
  };
}

export type FetchTrigger = {
  trigger: "manual" | "dropbox_delta";
  representativeChangedPath?: string;
  monitorScope?: "autohdr";
  monitorRoot?: "/AutoHDR";
};

export type FetchOwner = {
  claimId: string;
  jobId: string;
  workflowId: string;
  input: import("../workflows/autohdr-fetch").AutoHdrFetchInput;
  reused: boolean;
  state: "starting" | "running";
};
export type FetchRouteNoLongerValid = { routeNoLongerValid: true; reason: string };
export type FetchClaimResult = FetchOwner | FetchRouteNoLongerValid;
export type FetchClaimDependencies = { beforeClaimBatch?: () => void | Promise<void>; beforeBatch?: () => void | Promise<void> };

async function fetchRouteIsValid(db: Database, route: RoutedAutoHdrMapping): Promise<boolean> {
  const row = await db.select({ mappingId: autoHdrOutputMappings.id }).from(autoHdrOutputMappings)
    .innerJoin(autoHdrHandoffs, and(
      eq(autoHdrHandoffs.id, autoHdrOutputMappings.handoffId),
      eq(autoHdrHandoffs.projectId, autoHdrOutputMappings.projectId),
    ))
    .where(and(
      eq(autoHdrOutputMappings.id, route.mappingId),
      eq(autoHdrOutputMappings.handoffId, route.handoffId),
      eq(autoHdrOutputMappings.projectId, route.projectId),
      eq(autoHdrOutputMappings.connectionId, route.connectionId),
      eq(autoHdrOutputMappings.generation, route.generation),
      eq(autoHdrOutputMappings.state, "active"),
      eq(autoHdrHandoffs.id, route.handoffId),
      eq(autoHdrHandoffs.projectId, route.projectId),
      eq(autoHdrHandoffs.connectionId, route.connectionId),
      eq(autoHdrHandoffs.generation, route.generation),
      eq(autoHdrHandoffs.state, "started"),
    )).get();
  return Boolean(row);
}

/** Atomic insert-or-return-owner with bounded recovery of an orphaned `starting` claim. */
export async function claimAutoHdrFetch(
  env: Env,
  route: RoutedAutoHdrMapping,
  trigger: FetchTrigger,
  dependencies: FetchClaimDependencies = {},
): Promise<FetchClaimResult> {
  const db = (await import("../lib/db")).dbFor(env);
  if (!await fetchRouteIsValid(db, route)) return { routeNoLongerValid: true, reason: "AutoHDR mapping or handoff is no longer active" };
  const now = new Date();
  // Reclaim the same owner/Workflow ID. Minting another deterministic ID here could overlap a
  // Workflow that was created successfully just before its confirmation write was interrupted.
  await db.update(autoHdrFetchClaims).set({
    leaseExpiresAt: new Date(now.getTime() + START_LEASE_MS),
    lastError: "orphaned start lease recovered",
    updatedAt: now,
  })
    .where(and(
      eq(autoHdrFetchClaims.projectId, route.projectId),
      eq(autoHdrFetchClaims.mappingGeneration, route.generation),
      eq(autoHdrFetchClaims.state, "starting"),
      lt(autoHdrFetchClaims.leaseExpiresAt, now),
    ));
  const existing = await db.select().from(autoHdrFetchClaims).where(and(
    eq(autoHdrFetchClaims.projectId, route.projectId),
    eq(autoHdrFetchClaims.mappingGeneration, route.generation),
    eq(autoHdrFetchClaims.mappingId, route.mappingId),
    eq(autoHdrFetchClaims.handoffId, route.handoffId),
    eq(autoHdrFetchClaims.connectionId, route.connectionId),
    inArray(autoHdrFetchClaims.state, ["starting", "running"]),
  )).get();
  if (existing && await fetchRouteIsValid(db, route)) return {
    claimId: existing.id,
    jobId: existing.jobId,
    workflowId: existing.workflowId,
    input: JSON.parse(existing.triggerJson) as import("../workflows/autohdr-fetch").AutoHdrFetchInput,
    reused: true,
    state: existing.state as "starting" | "running",
  };
  if (existing) return { routeNoLongerValid: true, reason: "AutoHDR mapping or handoff is no longer active" };
  const anyExisting = await db.select({ id: autoHdrFetchClaims.id }).from(autoHdrFetchClaims).where(and(
    eq(autoHdrFetchClaims.projectId, route.projectId),
    eq(autoHdrFetchClaims.mappingGeneration, route.generation),
    inArray(autoHdrFetchClaims.state, ["starting", "running"]),
  )).get();
  if (anyExisting) return { routeNoLongerValid: true, reason: "An existing AutoHDR fetch claim is pinned to a different route" };
  const claimId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const priorCount = await db.select({ count: sql<number>`count(*)` }).from(autoHdrFetchClaims).where(and(
    eq(autoHdrFetchClaims.projectId, route.projectId),
    eq(autoHdrFetchClaims.mappingGeneration, route.generation),
  )).get();
  // Same instance-id constraint as the send path above: "-" separators only, never ":".
  const workflowId = `autohdr-fetch-${route.projectId}-${route.generation}-${Number(priorCount?.count ?? 0) + 1}`;
  const input: import("../workflows/autohdr-fetch").AutoHdrFetchInput = {
    projectId: route.projectId,
    jobId,
    claimId,
    handoffId: route.handoffId,
    manifestVersion: 1,
    mappingId: route.mappingId,
    mappingGeneration: route.generation,
    connectionId: route.connectionId,
    finalPath: route.finalPath,
    finalPathKey: route.finalPathKey,
    trigger: trigger.trigger,
    representativeChangedPath: trigger.representativeChangedPath,
    monitorScope: trigger.monitorScope,
    monitorRoot: trigger.monitorRoot,
  };
  try {
    await (dependencies.beforeClaimBatch ?? dependencies.beforeBatch)?.();
    const results = await env.DB.batch([
      env.DB.prepare("INSERT INTO jobs (id, kind, status, correlation_id, project_id, payload_json, retries, created_at, updated_at) SELECT ?, 'fetch_edited', 'queued', ?, ?, ?, 0, ?, ? WHERE EXISTS (SELECT 1 FROM autohdr_output_mappings m JOIN autohdr_handoffs h ON h.id = m.handoff_id AND h.project_id = m.project_id WHERE m.id = ? AND m.state = 'active' AND m.connection_id = ? AND m.generation = ? AND m.project_id = ? AND h.id = ? AND h.state = 'started' AND h.generation = ? AND h.connection_id = ?)")
        .bind(jobId, `fetch_edited:${route.projectId}:${route.generation}`, route.projectId, JSON.stringify(input), now.getTime(), now.getTime(), route.mappingId, route.connectionId, route.generation, route.projectId, route.handoffId, route.generation, route.connectionId),
      env.DB.prepare("INSERT INTO autohdr_fetch_claims (id, project_id, handoff_id, mapping_id, mapping_generation, connection_id, workflow_id, job_id, state, lease_expires_at, trigger, trigger_json, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ? WHERE changes() = 1")
        .bind(claimId, route.projectId, route.handoffId, route.mappingId, route.generation, route.connectionId, workflowId, jobId, now.getTime() + START_LEASE_MS, trigger.trigger, JSON.stringify(input), now.getTime(), now.getTime()),
    ]);
    if ((results[1]?.meta.changes ?? 0) !== 1) return { routeNoLongerValid: true, reason: "AutoHDR mapping or handoff was retired before fetch claim commit" };
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const winner = await db.select().from(autoHdrFetchClaims).where(and(
      eq(autoHdrFetchClaims.projectId, route.projectId),
      eq(autoHdrFetchClaims.mappingGeneration, route.generation),
      eq(autoHdrFetchClaims.mappingId, route.mappingId),
      eq(autoHdrFetchClaims.handoffId, route.handoffId),
      eq(autoHdrFetchClaims.connectionId, route.connectionId),
      inArray(autoHdrFetchClaims.state, ["starting", "running"]),
    )).get();
    if (!winner) {
      if (!await fetchRouteIsValid(db, route)) return { routeNoLongerValid: true, reason: "AutoHDR mapping or handoff is no longer active" };
      throw error;
    }
    return { claimId: winner.id, jobId: winner.jobId, workflowId: winner.workflowId, input: JSON.parse(winner.triggerJson), reused: true, state: winner.state as "starting" | "running" };
  }
  return { claimId, jobId, workflowId, input, reused: false, state: "starting" };
}

export async function startClaimedFetch(env: Env, owner: FetchOwner): Promise<FetchOwner> {
  if (owner.reused && owner.state === "running") return owner;
  const db = (await import("../lib/db")).dbFor(env);
  try {
    await env.AUTOHDR_FETCH_WORKFLOW.create({ id: owner.workflowId, params: owner.input });
    await db.update(autoHdrFetchClaims).set({ state: "running", startedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(autoHdrFetchClaims.id, owner.claimId), eq(autoHdrFetchClaims.state, "starting")));
    return owner;
  } catch (error) {
    if (isWorkflowAlreadyExists(error)) {
      await db.update(autoHdrFetchClaims).set({ state: "running", startedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(autoHdrFetchClaims.id, owner.claimId), eq(autoHdrFetchClaims.state, "starting")));
      return owner;
    }
    await setJobStatus(db, owner.jobId, "failed", error instanceof Error ? error.message : String(error));
    // Leave starting ownership recoverable until its lease; Workflow "already exists" retries
    // will read and reuse it rather than creating a second owner.
    throw error;
  }
}
