import {
  buildNonCompactingStageWinner,
  buildWorkflowTail,
  composeStageBundle,
  deriveStageFinalizerIntent,
  type CommittedStageFinalizerIntent,
  type ExpectedTargetPlacementRow,
  type StageFinalizerWinnerResult,
  type WorkflowTailKind,
  type WorkflowTailIndexes,
  type WorkflowTailPrerequisite,
} from "@quincy/db";
import type { StageKey } from "@quincy/shared";

import type { Env } from "../env";
import { automaticBoardWritesEnabled } from "./board-schema";
export { automaticBoardWritesEnabled } from "./board-schema";

export type AutomaticStageBindings = Pick<Env, "DB">;

export type AutomaticStageOutcome =
  | { kind: "winner"; finalizer: CommittedStageFinalizerIntent }
  | { kind: "loser" }
  | { kind: "deferred" }
  | { kind: "invariant_failure" };

type StageSnapshot = {
  oldBoardRevision: number;
  expectedTarget: ExpectedTargetPlacementRow[];
};

async function stageSnapshot(
  database: D1Database,
  projectId: string,
  sourceStageKey: StageKey,
  targetStageKey: StageKey,
): Promise<StageSnapshot | null> {
  const source = await database.prepare(
    "SELECT board_revision AS boardRevision FROM projects WHERE id = ? AND stage_key = ? AND archived_at IS NULL",
  ).bind(projectId, sourceStageKey).first<{ boardRevision: number }>();
  if (!source) return null;
  const target = await database.prepare(
    "SELECT id AS projectId, stage_key AS stageKey, board_position AS boardPosition, board_revision AS boardRevision FROM projects WHERE stage_key = ? AND archived_at IS NULL AND id <> ? ORDER BY board_position, id",
  ).bind(targetStageKey, projectId).all<ExpectedTargetPlacementRow>();
  return { oldBoardRevision: Number(source.boardRevision), expectedTarget: target.results };
}

function resultRows(result: D1Result<unknown> | undefined): readonly Record<string, unknown>[] {
  return (result?.results ?? []) as readonly Record<string, unknown>[];
}

function exactOne(result: D1Result<unknown> | undefined): Record<string, unknown> | null {
  const rows = resultRows(result);
  return rows.length === 1 ? rows[0] ?? null : null;
}

function stageWinnerRow(
  result: D1Result<unknown> | undefined,
  expected: { projectId: string; stageKey: StageKey; boardRevision: number },
): Extract<StageFinalizerWinnerResult, { kind: "winner" }> | null {
  const row = exactOne(result);
  if (!row || typeof row.id !== "string" || typeof row.stage_key !== "string") return null;
  if (row.id !== expected.projectId || row.stage_key !== expected.stageKey) return null;
  const boardPosition = typeof row.board_position === "number" ? row.board_position : Number(row.board_position);
  const boardRevision = typeof row.board_revision === "number" ? row.board_revision : Number(row.board_revision);
  if (!Number.isFinite(boardPosition) || !Number.isInteger(boardRevision) || boardRevision !== expected.boardRevision) return null;
  return {
    kind: "winner",
    row: { projectId: row.id, stageKey: row.stage_key as StageKey, boardPosition, boardRevision },
    auditId: "",
  };
}

function workflowResultIndexes(kind: WorkflowTailKind, indexes: WorkflowTailIndexes): number[] {
  if (kind === "none") return [];
  return Object.entries(indexes)
    .filter(([key, value]) => key !== "kind" && typeof value === "number")
    .map(([, value]) => value as number);
}

function offsetWorkflowIndexes(indexes: WorkflowTailIndexes, offset: number): WorkflowTailIndexes {
  return Object.fromEntries(Object.entries(indexes).map(([key, value]) => [
    key,
    typeof value === "number" ? value + offset : value,
  ])) as WorkflowTailIndexes;
}

function workflowTailAgrees(
  results: D1Result<unknown>[],
  kind: WorkflowTailKind,
  indexes: WorkflowTailIndexes,
  stageRevision: number,
): boolean {
  for (const index of workflowResultIndexes(kind, indexes)) {
    if (!exactOne(results[index])) return false;
  }
  if (kind === "autohdr_handoff_entry" || kind === "autohdr_mapping_entry" || kind === "autohdr_job_entry") {
    const tokenIndex = Object.entries(indexes).find(([key, value]) => key === "editingEntryToken" && typeof value === "number")?.[1];
    const token = exactOne(typeof tokenIndex === "number" ? results[tokenIndex] : undefined);
    const tokenRevision = token?.editing_entry_board_revision ?? token?.stage_entry_board_revision;
    return typeof tokenRevision === "number" && tokenRevision === stageRevision;
  }
  if (kind === "autohdr_job_completion") {
    const sourceIndex = Object.entries(indexes).find(([key, value]) => key === "sourceEntryJob" && typeof value === "number")?.[1];
    const source = exactOne(typeof sourceIndex === "number" ? results[sourceIndex] : undefined);
    return typeof source?.stage_entry_board_revision === "number"
      && source.stage_entry_board_revision === stageRevision;
  }
  return true;
}

function ownerIds(prerequisite: WorkflowTailPrerequisite): Record<string, string | undefined> {
  return {
    handoffId: "handoffId" in prerequisite ? prerequisite.handoffId : undefined,
    mappingId: "mappingId" in prerequisite ? prerequisite.mappingId : undefined,
    jobId: "jobId" in prerequisite ? prerequisite.jobId : undefined,
  };
}

export async function commitAutomaticStage(input: {
  env: AutomaticStageBindings;
  projectId: string;
  from: StageKey;
  to: StageKey;
  auditId: string;
  auditActorId?: string | null;
  auditMetaJson: string;
  now?: number;
  oldBoardRevision?: number;
  workflow: { kind: WorkflowTailKind; prerequisite: WorkflowTailPrerequisite };
  legacyWorkflowNotification?: CommittedStageFinalizerIntent["legacyWorkflowNotification"];
  prefix?: D1PreparedStatement[];
  betweenStageAndWorkflow?: D1PreparedStatement[];
}): Promise<AutomaticStageOutcome> {
  if (!await automaticBoardWritesEnabled(input.env)) return { kind: "deferred" };
  const now = input.now ?? Date.now();
  const snapshot = await stageSnapshot(input.env.DB, input.projectId, input.from, input.to);
  if (!snapshot) return { kind: "loser" };
  const oldBoardRevision = input.oldBoardRevision ?? snapshot.oldBoardRevision;
  const stage = buildNonCompactingStageWinner({
    db: input.env.DB,
    projectId: input.projectId,
    sourceStageKey: input.from,
    targetStageKey: input.to,
    oldBoardRevision,
    expectedTarget: snapshot.expectedTarget,
    expectedTargetRowCount: snapshot.expectedTarget.length,
    placement: "append",
    auditId: input.auditId,
    actorId: input.auditActorId,
    auditAction: "stage.auto_advance",
    auditMetaJson: input.auditMetaJson,
    updatedAt: now,
  });
  const stageWithInterlude = input.betweenStageAndWorkflow?.length
    ? { statements: [...stage.statements, ...input.betweenStageAndWorkflow], indexes: stage.indexes }
    : stage;
  const workflow = buildWorkflowTail({
    ...input.workflow.prerequisite,
    db: input.env.DB,
    auditId: input.auditId,
    now,
    projectId: input.projectId,
  }, input.workflow.kind);
  const bundle = composeStageBundle({ stage: stageWithInterlude, workflow });
  const prefix = input.prefix ?? [];
  const results = await input.env.DB.batch([...prefix, ...bundle.statements]);
  const offset = prefix.length;
  const winner = stageWinnerRow(results[offset + bundle.indexes.stage.winner], {
    projectId: input.projectId,
    stageKey: input.to,
    boardRevision: oldBoardRevision + 1,
  });
  const marker = exactOne(results[offset + bundle.indexes.stage.auditMarker]);
  if (!winner) return { kind: "loser" };
  if (!marker || marker.id !== input.auditId || !workflowTailAgrees(results, input.workflow.kind, offsetWorkflowIndexes(bundle.indexes.workflow, offset), winner.row.boardRevision)) {
    console.error("Automatic Stage bundle invariant failure", {
      projectId: input.projectId,
      from: input.from,
      to: input.to,
      auditId: input.auditId,
      workflowKind: input.workflow.kind,
      ownerIds: ownerIds(input.workflow.prerequisite),
      providerSecret: false,
    });
    return { kind: "invariant_failure" };
  }
  const finalizer = deriveStageFinalizerIntent([{
    ...winner,
    auditId: marker.id as string,
    legacyWorkflowNotification: input.legacyWorkflowNotification,
  }]);
  if (!finalizer) {
    console.error("Automatic Stage finalizer invariant failure", {
      projectId: input.projectId,
      auditId: input.auditId,
      ownerIds: ownerIds(input.workflow.prerequisite),
      providerSecret: false,
    });
    return { kind: "invariant_failure" };
  }
  return { kind: "winner", finalizer };
}

export async function jobEntryToken(
  database: D1Database,
  input: { sourceJobId: string; projectId: string; generation: number; sourceJobKind?: string },
): Promise<number | null> {
  const source = await database.prepare(
    "SELECT stage_entry_board_revision AS stageEntryBoardRevision FROM jobs WHERE id = ? AND project_id = ? AND kind = ? AND json_valid(payload_json) AND CAST(json_extract(payload_json, '$.projectId') AS TEXT) = ? AND json_extract(payload_json, '$.stageEntrySourceJobId') = id AND CAST(COALESCE(json_extract(payload_json, '$.stageEntryGeneration'), json_extract(payload_json, '$.generation')) AS INTEGER) = ? AND stage_entry_board_revision IS NOT NULL",
  ).bind(input.sourceJobId, input.projectId, input.sourceJobKind ?? "autohdr", input.projectId, input.generation).first<{ stageEntryBoardRevision: number }>();
  return source?.stageEntryBoardRevision ?? null;
}

export function logMissingJobProvenance(input: { projectId: string; completionJobId: string; sourceJobId?: string; generation?: number }): void {
  console.error("Automatic Stage completion permanently failed closed", {
    projectId: input.projectId,
    completionJobId: input.completionJobId,
    sourceJobId: input.sourceJobId ?? null,
    generation: input.generation ?? null,
    providerSecret: false,
  });
}
