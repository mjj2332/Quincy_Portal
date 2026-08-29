import { buildHandoffStartTail, buildOwnershipAssertionBundle, buildNonCompactingStageWinner, buildTerminalAssertionBundle, buildWorkflowCheckBundle, buildWorkflowTail, buildEditingEntryTokenTail, compileClosedAutomaticCoupling, composeStageBundle,
  deriveStageFinalizerIntent,
  type ClosedAutomaticCoupling, type ClosedOwnershipBundle, type CommittedStageFinalizerIntent,
  type ExpectedTargetPlacementRow,
  type GuardedTransitionPrerequisite,
  type HandoffStartBundle,
  type JobEntryProvenanceBundle, type StageFinalizerWinnerResult, type WorkflowTailIndexes,
  type WorkflowTailKind,
} from "@quincy/db";
import type { StageKey } from "@quincy/shared";

import type { Env } from "../env";
import { automaticBoardWritesEnabled } from "./board-schema";
export { automaticBoardWritesEnabled } from "./board-schema";

export type AutomaticStageBindings = Pick<Env, "DB">;

export type AutomaticStageOutcome = { kind: "winner"; finalizer: CommittedStageFinalizerIntent; }
  | { kind: "already_at_destination"; } | { kind: "loser"; }
  | { kind: "deferred"; }
  | { kind: "conflict"; } | { kind: "invariant_failure"; };

type StageSnapshot = { stageKey: StageKey; oldBoardRevision: number;
  expectedTarget: ExpectedTargetPlacementRow[]; archivedAt: number | null; };

async function stageSnapshot(
  database: D1Database,
  projectId: string,
  sourceStageKey: StageKey,
  targetStageKey: StageKey): Promise<StageSnapshot | null> {
  const source = await database.prepare("SELECT stage_key AS stageKey, board_revision AS boardRevision, archived_at AS archivedAt FROM projects WHERE id = ?").bind(projectId).first<{ stageKey: StageKey; boardRevision: number; archivedAt: number | null; }>();
  if (!source) return null;
  const target = await database.prepare(
    "SELECT id AS projectId, stage_key AS stageKey, board_position AS boardPosition, board_revision AS boardRevision FROM projects WHERE stage_key = ? AND archived_at IS NULL AND id <> ? ORDER BY board_position, id").bind(targetStageKey, projectId).all<ExpectedTargetPlacementRow>();
  return {
    stageKey: source.stageKey,
    oldBoardRevision: Number(source.boardRevision), expectedTarget: target.results,
    archivedAt: source.archivedAt
  };
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
  expected: { projectId: string; stageKey: StageKey; boardRevision: number; }): Extract<StageFinalizerWinnerResult, { kind: "winner"; }> | null {
  const row = exactOne(result);
  if (!row || typeof row.id !== "string" || typeof row.stage_key !== "string" || row.id !== expected.projectId || row.stage_key !== expected.stageKey) return null;
  const boardPosition = typeof row.board_position === "number" ? row.board_position : Number(row.board_position);
  const boardRevision = typeof row.board_revision === "number" ? row.board_revision : Number(row.board_revision);
  if (!Number.isFinite(boardPosition) || !Number.isInteger(boardRevision) || boardRevision !== expected.boardRevision) return null;
  return {
    kind: "winner",
    row: { projectId: row.id, stageKey: row.stage_key as StageKey, boardPosition, boardRevision },
    auditId: ""
  };
}

function workflowTailKindFor(p: GuardedTransitionPrerequisite): WorkflowTailKind {
  if (p.kind === "none") return "none";
  if (p.kind === "raw_reconciliation") return "raw_reconciliation";
  if (p.kind === "autohdr_handoff") return "autohdr_handoff_entry";
  if (p.kind === "autohdr_mapping") return "autohdr_mapping_entry";
  if (p.kind === "autohdr_final_claim") return "autohdr_final_completion";
  return p.mode === "entry" ? "autohdr_job_entry" : "autohdr_job_completion";
}
function workflowResultIndexes(kind: WorkflowTailKind, indexes: WorkflowTailIndexes): number[] {
  if (kind === "none") return [];
  return Object.entries(indexes)
    .filter(([key, value]) => key !== "kind" && typeof value === "number")
    .map(([, value]) => value as number);
}

function workflowTailAgrees(
  results: D1Result<unknown>[],
  kind: WorkflowTailKind,
  indexes: WorkflowTailIndexes, oldBoardRevision: number): boolean {
  for (const index of workflowResultIndexes(kind, indexes)) if (!exactOne(results[index])) return false;
  if (kind === "autohdr_handoff_entry" || kind === "autohdr_mapping_entry" || kind === "autohdr_job_entry") {
    const tokenIndex = Object.entries(indexes).find(([key, value]) => key === "editingEntryToken" && typeof value === "number")?.[1];

    // Object.entries is deliberately retained: WorkflowTailIndexes is a discriminated union but
    // the token is composed separately, so narrowing on kind cannot narrow its accessor shape.
    const token = exactOne(typeof tokenIndex === "number" ? results[tokenIndex] : undefined);
    const revision = token?.editing_entry_board_revision ?? token?.stage_entry_board_revision;
    return typeof revision === "number" && revision === oldBoardRevision + 1;
  }
  if (kind === "autohdr_job_completion") {
    const sourceIndex = Object.entries(indexes).find(([key, value]) => key === "sourceEntryJob" && typeof value === "number")?.[1];
    const source = exactOne(typeof sourceIndex === "number" ? results[sourceIndex] : undefined);
    return typeof source?.stage_entry_board_revision === "number"
      && source.stage_entry_board_revision === oldBoardRevision;
  }
  if (kind === "autohdr_final_completion") {
    const handoffIndex = Object.entries(indexes).find(([key, value]) => key === "handoffState" && typeof value === "number")?.[1];
    const handoff = exactOne(typeof handoffIndex === "number" ? results[handoffIndex] : undefined);
    return typeof handoff?.editing_entry_board_revision === "number" && handoff.editing_entry_board_revision === oldBoardRevision;
  }
  return true;
}
export { workflowTailAgrees, workflowTailKindFor };
function ownerIds(prerequisite: GuardedTransitionPrerequisite): Record<string, string | undefined> {
  return {
    handoffId: "handoffId" in prerequisite ? prerequisite.handoffId : undefined,
    mappingId: "mappingId" in prerequisite ? prerequisite.mappingId : undefined,
    jobId: "jobId" in prerequisite && typeof prerequisite.jobId === "string" ? prerequisite.jobId : undefined
  };
}
function isAutomaticBundleAssertionError(error: unknown): boolean {
  for (let cause: unknown = error; cause !== undefined && cause !== null; cause = cause instanceof Error ? cause.cause : typeof cause === "object" && "cause" in cause ? (cause as { cause?: unknown; }).cause : undefined) {
    const message = cause instanceof Error ? cause.message : typeof cause === "object" && "message" in cause && typeof (cause as { message?: unknown; }).message === "string" ? (cause as { message: string; }).message : "";
    if (/audit_log\.id|bundle_assertion|closed_bundle_assertion/i.test(message)) return true;
  }
  return false;
}
export { isAutomaticBundleAssertionError };
async function diagnosticProject(database: D1Database, projectId: string): Promise<{ stageKey: StageKey; boardRevision: number; archivedAt: number | null; } | null> {
  return database.prepare("SELECT stage_key AS stageKey, board_revision AS boardRevision, archived_at AS archivedAt FROM projects WHERE id = ?").bind(projectId).first<{ stageKey: StageKey; boardRevision: number; archivedAt: number | null; }>();
}
function tokenTail(db: D1Database, workflow: GuardedTransitionPrerequisite, auditId: string, now: number) {
  if (workflow.kind === "autohdr_handoff") return buildEditingEntryTokenTail({
    db,
    owner: "handoff",
    projectId: workflow.projectId,
    handoffId: workflow.handoffId,
    connectionId: workflow.connectionId,
    generation: workflow.generation,
    state: "started",
    expectedPriorToken: workflow.expectedPriorToken,
    auditId,
    updatedAt: now
  });
  if (workflow.kind === "autohdr_mapping") return buildEditingEntryTokenTail({
    db,
    owner: "handoff",
    projectId: workflow.projectId,
    handoffId: workflow.handoffId,
    connectionId: workflow.connectionId,
    generation: workflow.generation,
    state: "started",
    expectedPriorToken: workflow.expectedPriorToken,
    auditId,
    updatedAt: now
  });
  if (workflow.kind === "autohdr_job" && workflow.mode === "entry") return buildEditingEntryTokenTail({
    db,
    owner: "job",
    projectId: workflow.projectId,
    jobId: workflow.jobId,
    jobKind: workflow.jobKind,
    generation: workflow.generation,
    expectedPriorToken: workflow.expectedPriorToken,
    auditId,
    updatedAt: now
  });
  return undefined;
}
function startTail(db: D1Database, workflow: GuardedTransitionPrerequisite, auditId: string, now: number): HandoffStartBundle | undefined {
  if (workflow.kind === "autohdr_handoff") return buildHandoffStartTail({
    db,
    projectId: workflow.projectId,
    handoffId: workflow.handoffId,
    connectionId: workflow.connectionId,
    generation: workflow.generation,
    expectedStates: workflow.expectedStates,
    auditId,
    updatedAt: now
  });
  if (workflow.kind === "autohdr_mapping") return buildHandoffStartTail({
    db,
    projectId: workflow.projectId,
    handoffId: workflow.handoffId,
    connectionId: workflow.connectionId,
    generation: workflow.generation,
    expectedStates: workflow.handoffStates,
    auditId,
    updatedAt: now
  });
  return undefined;
}
function validateClosedComposition(input: {
  projectId: string;
  workflow: GuardedTransitionPrerequisite;
  coupling?: ClosedAutomaticCoupling;
  preWinnerOwnership?: ClosedOwnershipBundle;
  preWinnerProvenance?: JobEntryProvenanceBundle;
  postMarkerHandoffStart?: HandoffStartBundle;
  alreadyAtDestination: { allowed: false; } | {
    allowed: true;
    effect: { kind: "none"; } | { kind: "handoff_start"; bundle: HandoffStartBundle; } | { kind: "ownership"; bundle: ClosedOwnershipBundle; } | { kind: "job_provenance"; bundle: JobEntryProvenanceBundle; } | { kind: "workflow_check"; workflow: GuardedTransitionPrerequisite; };
  };
}): void {
  if (input.workflow.kind !== "none" && input.workflow.projectId !== input.projectId) throw new Error("Automatic workflow and project documents disagree");
  if (input.preWinnerOwnership && input.preWinnerProvenance) throw new Error("Automatic Stage accepts one pre-winner bundle");
  if (input.preWinnerOwnership && !input.coupling) throw new Error("Automatic ownership requires a coupling document");
  if (input.preWinnerProvenance && (!input.coupling || input.coupling.kind !== "job_entry_provenance")) throw new Error("Automatic provenance requires job_entry_provenance coupling");
  if (input.preWinnerOwnership && input.coupling && compileClosedAutomaticCoupling(input.preWinnerOwnership.coupling) !== compileClosedAutomaticCoupling(input.coupling)) throw new Error("Automatic ownership and coupling documents disagree");
  if (input.preWinnerProvenance && input.coupling && compileClosedAutomaticCoupling(input.preWinnerProvenance.coupling) !== compileClosedAutomaticCoupling(input.coupling)) throw new Error("Automatic provenance and coupling documents disagree");
  if (input.postMarkerHandoffStart) {
    if (input.workflow.kind !== "autohdr_handoff" && input.workflow.kind !== "autohdr_mapping") throw new Error("A post-marker handoff start is valid only for handoff or mapping workflows");
    const workflowHandoff = input.workflow.handoffId;
    const workflowConnection = input.workflow.connectionId;
    const workflowGeneration = input.workflow.generation;
    const start = input.postMarkerHandoffStart.coupling;
    if (start.handoffId !== workflowHandoff || start.connectionId !== workflowConnection || start.generation !== workflowGeneration) throw new Error("Post-marker handoff start does not match workflow identity");
  }
  if (input.alreadyAtDestination.allowed) {
    const effect = input.alreadyAtDestination.effect;
    if (effect.kind === "handoff_start" && (!input.coupling || compileClosedAutomaticCoupling(effect.bundle.coupling) !== compileClosedAutomaticCoupling(input.coupling))) throw new Error("Destination handoff-start and coupling documents disagree");
    if (effect.kind === "ownership" && (!input.coupling || compileClosedAutomaticCoupling(effect.bundle.coupling) !== compileClosedAutomaticCoupling(input.coupling))) throw new Error("Destination ownership and coupling documents disagree");
    if (effect.kind === "job_provenance" && (!input.coupling || effect.bundle.coupling.kind !== "job_entry_provenance" || compileClosedAutomaticCoupling(effect.bundle.coupling) !== compileClosedAutomaticCoupling(input.coupling))) throw new Error("Destination provenance and coupling documents disagree");
    if (effect.kind === "workflow_check") {
      if (effect.workflow.kind !== "autohdr_handoff" && effect.workflow.kind !== "autohdr_mapping") throw new Error("workflow_check destination effect is only valid for handoff/mapping");
      if (effect.workflow.projectId !== input.projectId) throw new Error("Destination workflow and project documents disagree");
    }
  }
}
function destinationWorkflow(workflow: GuardedTransitionPrerequisite, boardRevision: number): GuardedTransitionPrerequisite {
  if (workflow.kind === "autohdr_handoff") return { ...workflow, expectedPriorToken: boardRevision - 1 };
  if (workflow.kind === "autohdr_mapping") return { ...workflow, expectedPriorToken: boardRevision - 1 };
  return workflow;
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
  workflow: GuardedTransitionPrerequisite;
  coupling?: ClosedAutomaticCoupling;
  preWinnerOwnership?: ClosedOwnershipBundle;
  preWinnerProvenance?: JobEntryProvenanceBundle;
  postMarkerHandoffStart?: HandoffStartBundle;
  alreadyAtDestination: { allowed: false; } | {
    allowed: true;
    effect: { kind: "none"; } | { kind: "handoff_start"; bundle: HandoffStartBundle; } | { kind: "ownership"; bundle: ClosedOwnershipBundle; } | { kind: "job_provenance"; bundle: JobEntryProvenanceBundle; } | { kind: "workflow_check"; workflow: GuardedTransitionPrerequisite; };
  };
  legacyWorkflowNotification?: CommittedStageFinalizerIntent["legacyWorkflowNotification"];
}): Promise<AutomaticStageOutcome> {
  if (!(await automaticBoardWritesEnabled(input.env))) return { kind: "deferred" };
  validateClosedComposition(input);
  const now = input.now ?? Date.now();
  const snapshot = await stageSnapshot(input.env.DB, input.projectId, input.from, input.to);
  if (!snapshot || snapshot.archivedAt !== null) return { kind: "conflict" };
  if (snapshot.stageKey === input.to) {
    if (!input.alreadyAtDestination.allowed) return { kind: "conflict" };
    const effect = input.alreadyAtDestination.effect;
    if (effect.kind === "none") return { kind: "already_at_destination" };
    if (effect.kind === "workflow_check") {
      if (effect.workflow.kind !== "autohdr_handoff" && effect.workflow.kind !== "autohdr_mapping") throw new Error("workflow_check destination effect is only valid for handoff/mapping");
      const check = buildWorkflowCheckBundle({
        db: input.env.DB,
        projectId: input.projectId,
        destinationStage: input.to,
        oldBoardRevision: snapshot.oldBoardRevision - 1,
        workflow: destinationWorkflow(effect.workflow, snapshot.oldBoardRevision)
      });
      const results = await input.env.DB.batch(check.statements);
      return exactOne(results[check.indexes.workflowCheck]) ? { kind: "already_at_destination" } : { kind: "conflict" };
    }
    if (effect.kind === "handoff_start") {
      const assertion = buildOwnershipAssertionBundle({
        db: input.env.DB,
        projectId: input.projectId,
        destinationStage: input.to,
        coupling: effect.bundle.coupling,
        assertedAt: now
      });
      try {
        const results = await input.env.DB.batch([...effect.bundle.statements, ...assertion.statements]);
        return exactOne(results[effect.bundle.indexes.handoffStart]) && (results[effect.bundle.statements.length + assertion.indexes.ownershipAssertion]?.meta.changes ?? 0) === 0 ? { kind: "already_at_destination" } : { kind: "conflict" };
      } catch (error) {
        if (isAutomaticBundleAssertionError(error)) return { kind: "conflict" };
        throw error;
      }
    }
    let results: D1Result<unknown>[];
    try { results = await input.env.DB.batch(effect.bundle.statements); } catch (error) {
      if (isAutomaticBundleAssertionError(error)) return { kind: "conflict" };
      throw error;
    }
    if (effect.kind === "ownership") {
      const index = effect.bundle.indexes.ownershipAssertion;
      return typeof index === "number" && !exactOne(results[index]) ? { kind: "already_at_destination" } : { kind: "conflict" };
    }
    return (results[effect.bundle.indexes.payloadUpdate]?.meta.changes ?? 0) === 1 ? { kind: "already_at_destination" } : { kind: "conflict" };
  }
  if (snapshot.stageKey !== input.from) return { kind: "conflict" };
  const oldBoardRevision = input.oldBoardRevision ?? snapshot.oldBoardRevision;
  const workflowKind = workflowTailKindFor(input.workflow);
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
    workflowPremise: input.workflow
  });
  const state = input.postMarkerHandoffStart ?? startTail(input.env.DB, input.workflow, input.auditId, now);
  const workflow = buildWorkflowTail({
    ...input.workflow,
    db: input.env.DB,
    auditId: input.auditId,
    now }, workflowKind);
  const token = tokenTail(input.env.DB, input.workflow, input.auditId, now);
  const terminal = buildTerminalAssertionBundle({
    db: input.env.DB,
    projectId: input.projectId,
    destinationStage: input.to,
    oldBoardRevision,
    premise: input.workflow,
    coupling: input.coupling,
    auditId: input.auditId,
    winnerRequired: Boolean(input.preWinnerOwnership || input.preWinnerProvenance),
    assertedAt: now
  });
  const bundle = composeStageBundle({ preWinner: input.preWinnerOwnership ?? input.preWinnerProvenance, stage, state, workflow, token, terminal });
  let results: D1Result<unknown>[];
  try { results = await input.env.DB.batch(bundle.statements); } catch (error) {
    if (!isAutomaticBundleAssertionError(error)) throw error;
    const diagnostic = await diagnosticProject(input.env.DB, input.projectId);
  const samePremise = diagnostic?.stageKey === input.from && diagnostic.boardRevision === oldBoardRevision && diagnostic.archivedAt === null;
    console.error("Automatic Stage bundle assertion failed after rollback", {
      projectId: input.projectId,
      from: input.from,
      to: input.to,
      auditId: input.auditId,
      ownerIds: ownerIds(input.workflow),
      classification: "conflict",
      diagnosticRacePossible: !samePremise,
      preBatchOldBoardRevision: oldBoardRevision,
      diagnosticBoardRevision: diagnostic?.boardRevision ?? null,
      providerSecret: false
    });
    return { kind: "conflict" };
  }
  const winner = stageWinnerRow(results[bundle.indexes.stage.winner], {
    projectId: input.projectId,
    stageKey: input.to,
    boardRevision: oldBoardRevision + 1 });
  if (!winner) return { kind: "loser" };
  const markerResult = exactOne(results[bundle.indexes.stage.auditMarker]);
  const stateAgrees = !bundle.indexes.state || Boolean(exactOne(results[bundle.indexes.state.handoffStart]));
  const tokenAgrees = !bundle.indexes.token || Boolean(exactOne(results[bundle.indexes.token.editingEntryToken]));
  const workflowAgreementIndexes: WorkflowTailIndexes = bundle.indexes.token ? { ...bundle.indexes.workflow, editingEntryToken: bundle.indexes.token.editingEntryToken } : bundle.indexes.workflow;
  if (!markerResult || markerResult.id !== input.auditId || !stateAgrees || !tokenAgrees || !workflowTailAgrees(results, workflowKind, workflowAgreementIndexes, oldBoardRevision)) {
    console.error("Automatic Stage bundle invariant failure", {
      projectId: input.projectId,
      from: input.from,
      to: input.to,
      auditId: input.auditId,
      workflowKind,
      ownerIds: ownerIds(input.workflow),
      providerSecret: false
    });
    return { kind: "invariant_failure" };
  }
  const finalizer = deriveStageFinalizerIntent([{
    ...winner,
    auditId: markerResult.id as string,
    legacyWorkflowNotification: input.legacyWorkflowNotification }]);
  return finalizer ? { kind: "winner", finalizer } : { kind: "invariant_failure" };
  }
export async function jobEntryToken(
  database: D1Database,
  input: { sourceJobId: string; projectId: string; generation: number; sourceJobKind?: string; }): Promise<number | null> {
  const source = await database.prepare(`SELECT stage_entry_board_revision AS stageEntryBoardRevision
     FROM jobs
     WHERE id = ?
       AND project_id = ?
       AND kind = ?
       AND json_valid(payload_json)
       AND CAST(json_extract(payload_json, '$.projectId') AS TEXT) = ?
       AND json_extract(payload_json, '$.stageEntrySourceJobId') = id
       AND CAST(
         COALESCE(
           json_extract(payload_json, '$.stageEntryGeneration'),
           json_extract(payload_json, '$.generation')
         ) AS INTEGER
       ) = ?
       AND stage_entry_board_revision IS NOT NULL`).bind(input.sourceJobId, input.projectId, input.sourceJobKind ?? "autohdr", input.projectId, input.generation).first<{ stageEntryBoardRevision: number; }>();
  return source?.stageEntryBoardRevision ?? null;
}

export function logMissingJobProvenance(input: { projectId: string; completionJobId: string; sourceJobId?: string; generation?: number; }): void {
  console.error("Automatic Stage completion permanently failed closed", {
    projectId: input.projectId,
    completionJobId: input.completionJobId,
    sourceJobId: input.sourceJobId ?? null,
    generation: input.generation ?? null,
    providerSecret: false
  });
}
