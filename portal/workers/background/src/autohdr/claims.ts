import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  assets,
  autoHdrFetchClaims,
  autoHdrHandoffs,
  autoHdrOutputMappings,
  autoHdrPathClaims,
  collections,
  jobs,
  projects,
  selections,
} from "@quincy/db/schema";
import type { Database } from "@quincy/db";

import type { Env } from "../env";
import { autoHdrFinalPathCandidates, deriveAutoHdrFolderName } from "./paths";
import { dropboxPathKey, pathEqualsOrIsBelow } from "../dropbox/paths";
import { canonicalDropboxConnectionId } from "../dropbox/connection";
import { setJobStatus } from "../lib/jobs";
import type { RoutedAutoHdrMapping } from "./mapping";

const START_LEASE_MS = 10 * 60_000;

function isUniqueConflict(error: unknown): boolean {
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

export type HandoffOwner = { handoffId: string; jobId: string; workflowId: string; reused: boolean };
export type HandoffClaimDependencies = { beforeClaimBatch?: () => void | Promise<void> };

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
  dependencies: HandoffClaimDependencies = {},
): Promise<HandoffOwner> {
  const db = (await import("../lib/db")).dbFor(env);
  const now = new Date();
  const active = await db.select({ id: autoHdrHandoffs.id, jobId: autoHdrHandoffs.jobId, workflowId: autoHdrHandoffs.workflowId })
    .from(autoHdrHandoffs)
    .where(and(eq(autoHdrHandoffs.projectId, projectId), inArray(autoHdrHandoffs.state, ["starting", "started", "blocked"])))
    .get();
  if (active) return { handoffId: active.id, jobId: active.jobId, workflowId: active.workflowId, reused: true };

  const project = await db.select({
    stageKey: projects.stageKey, archivedAt: projects.archivedAt, rawFolderPath: projects.rawFolderPath,
  }).from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new Error(`Project ${projectId} does not exist`);
  if (project.archivedAt) throw new Error(`Project ${projectId} is archived`);
  if (project.stageKey !== "raw_review") throw new Error("AutoHDR handoff requires the project to be exactly in Raw Review");
  if (!project.rawFolderPath) throw new Error("AutoHDR handoff requires a canonical Dropbox RAW folder path");

  const selected = await db.select({
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
  if (!selected.length) throw new Error("No RAW assets are selected for editing");
  selected.sort((a, b) => a.assetId.localeCompare(b.assetId));
  const filenames = new Set<string>();
  for (const item of selected) {
    const filename = item.filename.toLowerCase();
    if (filenames.has(filename)) throw new Error(`Duplicate RAW filename selected for autoHDR: ${item.filename}`);
    filenames.add(filename);
  }
  const readinessMap = new Map<string, string[]>();
  for (const item of selected) {
    const key = item.bracketGroup ? `bracket:${item.bracketGroup}` : `asset:${item.assetId}`;
    readinessMap.set(key, [...(readinessMap.get(key) ?? []), item.assetId].sort());
  }
  const readinessUnits = [...readinessMap].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, assetIds]) => ({ key, assetIds }));
  const selectedIds = selected.map((item) => item.assetId);
  const selectionHash = await sha256(JSON.stringify(selected.map((item) => [item.assetId, item.bracketGroup])));
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

/** Atomic insert-or-return-owner with bounded recovery of an orphaned `starting` claim. */
export async function claimAutoHdrFetch(
  env: Env,
  route: RoutedAutoHdrMapping,
  trigger: FetchTrigger,
): Promise<FetchOwner> {
  const db = (await import("../lib/db")).dbFor(env);
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
    inArray(autoHdrFetchClaims.state, ["starting", "running"]),
  )).get();
  if (existing) return {
    claimId: existing.id,
    jobId: existing.jobId,
    workflowId: existing.workflowId,
    input: JSON.parse(existing.triggerJson) as import("../workflows/autohdr-fetch").AutoHdrFetchInput,
    reused: true,
    state: existing.state as "starting" | "running",
  };
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
    await env.DB.batch([
      env.DB.prepare("INSERT INTO jobs (id, kind, status, correlation_id, project_id, payload_json, retries, created_at, updated_at) VALUES (?, 'fetch_edited', 'queued', ?, ?, ?, 0, ?, ?)")
        .bind(jobId, `fetch_edited:${route.projectId}:${route.generation}`, route.projectId, JSON.stringify(input), now.getTime(), now.getTime()),
      env.DB.prepare("INSERT INTO autohdr_fetch_claims (id, project_id, handoff_id, mapping_id, mapping_generation, connection_id, workflow_id, job_id, state, lease_expires_at, trigger, trigger_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?)")
        .bind(claimId, route.projectId, route.handoffId, route.mappingId, route.generation, route.connectionId, workflowId, jobId, now.getTime() + START_LEASE_MS, trigger.trigger, JSON.stringify(input), now.getTime(), now.getTime()),
    ]);
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const winner = await db.select().from(autoHdrFetchClaims).where(and(
      eq(autoHdrFetchClaims.projectId, route.projectId),
      eq(autoHdrFetchClaims.mappingGeneration, route.generation),
      inArray(autoHdrFetchClaims.state, ["starting", "running"]),
    )).get();
    if (!winner) throw error;
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
