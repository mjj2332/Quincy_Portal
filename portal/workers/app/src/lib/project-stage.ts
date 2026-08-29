import {
  boardContractEnabled,
  boardSchemaVariant,
  buildCompactingStageWinner,
  buildDeadlineSuppressionBundle,
  buildNonCompactingStageWinner,
  buildStageActivityBundle,
  buildWorkflowTail,
  composeStageBundle,
  createDb,
  deriveStageFinalizerIntent,
  type CommittedStageFinalizerIntent,
} from "@quincy/db";
import {
  parseStageTransportKey,
  roleHasCapability,
  stageMoveConfirmationReasons,
  stageTransportKeyForRole,
  type MoveProjectStageRequest,
  type MoveProjectStageResponse,
  type Role,
  type StageKey,
  type StageMoveConfirmationReason,
  type StageMoveProjectState,
  type StageTransportKey,
} from "@quincy/shared";
import { resolveVisibleProject } from "./visible-project-scope";
import { auditMeta } from "./audit";
import { newId } from "./ids";
import type { AppEnv, SessionUser } from "../env";
import { ensurePipelineStages } from "../routes/stages";
import {
  moveProjectBoardOrder,
  planBoardPlacement,
  placementChangesLogicalSlot,
  readBoardProject,
  readBoardRows,
  readVisibleBoardRows,
  type BoardOrderResult,
} from "./project-board-order";

export type MoveProjectStageInput = {
  env: AppEnv["Bindings"];
  principal: SessionUser;
  projectId: string;
  request: MoveProjectStageRequest;
  now?: number;
};

export type MoveProjectStageResult =
  | { kind: "moved"; response: MoveProjectStageResponse; finalizer: CommittedStageFinalizerIntent }
  | { kind: "no_change"; response: MoveProjectStageResponse }
  | { kind: "forbidden"; capability: "moveProjectStage" }
  | { kind: "reorder_forbidden"; code: "project_board_reorder_forbidden"; capability: "prioritizeProjects" }
  | { kind: "not_found" }
  | { kind: "archived"; current: StageMoveProjectState }
  | { kind: "inactive_destination"; current: StageMoveProjectState }
  | { kind: "confirmation_required"; current: StageMoveProjectState; required: { fromStageKey: StageTransportKey; toStageKey: StageTransportKey; reasons: StageMoveConfirmationReason[] } }
  | { kind: "conflict"; current: StageMoveProjectState | null }
  | { kind: "disabled" }
  | { kind: "schema_maintenance" };

function stateFor(row: Awaited<ReturnType<typeof readBoardProject>>, role: Role): StageMoveProjectState | null {
  return row ? { projectId: row.id, stageKey: stageTransportKeyForRole(row.stageKey, role), boardRevision: row.boardRevision } : null;
}

function responseFor(
  row: NonNullable<Awaited<ReturnType<typeof readBoardProject>>>,
  role: Role,
  sourceStageKey: StageKey,
  visibleRows: Awaited<ReturnType<typeof readVisibleBoardRows>>,
  changed: boolean,
): MoveProjectStageResponse {
  return {
    changed,
    project: { projectId: row.id, stageKey: stageTransportKeyForRole(row.stageKey, role), boardRevision: row.boardRevision },
    board: {
      sourceStageKey: stageTransportKeyForRole(sourceStageKey, role),
      targetStageKey: stageTransportKeyForRole(row.stageKey, role),
      orderedVisibleProjectIds: visibleRows.map((item) => item.id),
    },
  };
}

function sameReasons(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((reason, index) => reason === right[index]);
}

async function resolveStageVisibleProject(input: MoveProjectStageInput) {
  const visible = await resolveVisibleProject(input.env, input.principal, input.projectId);
  if (visible || input.principal.role !== "editor") return visible;
  // Internal Editors retain project-level knowledge of an assigned archived project so the
  // command can return the explicit read-only result. External Editors deliberately do not get
  // this fallback: archived, unassigned, and nonexistent ids remain the same generic 404.
  const assignedArchived = await input.env.DB.prepare(`
    SELECT p.id
    FROM projects p
    INNER JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
    WHERE p.id = ?
  `).bind(input.principal.id, input.projectId).first<{ id: string }>();
  return assignedArchived ? {
    projectId: input.projectId,
    membershipCycleIds: [],
    role: input.principal.role,
    isExternal: false,
  } : null;
}

function mapBoardResult(result: BoardOrderResult): MoveProjectStageResult {
  if (result.kind === "forbidden") return { kind: "forbidden", capability: "moveProjectStage" };
  if (result.kind === "moved" || result.kind === "no_change" || result.kind === "conflict" || result.kind === "not_found" || result.kind === "disabled" || result.kind === "schema_maintenance") return result as MoveProjectStageResult;
  return { kind: "conflict", current: null };
}

function finalizerFromResults(results: D1Result<unknown>[], projectId: string, auditIndex: number, winnerIndex: number, activityIndex: number) {
  const winner = (results[winnerIndex]?.results ?? []).find((item) => (item as { id?: unknown }).id === projectId) as { id?: string; stage_key?: StageKey; stageKey?: StageKey; board_position?: number; boardPosition?: number; board_revision?: number; boardRevision?: number } | undefined;
  const marker = results[auditIndex]?.results?.[0] as { id?: string } | undefined;
  if (!winner?.id || !marker?.id) return null;
  const stageKey = winner.stageKey ?? winner.stage_key;
  const boardPosition = winner.boardPosition ?? winner.board_position;
  const boardRevision = winner.boardRevision ?? winner.board_revision;
  if (!stageKey || boardPosition === undefined || boardRevision === undefined) return null;
  const publicationIds = (results[activityIndex]?.results ?? []).map((item) => (item as { id?: unknown }).id).filter((id): id is string => typeof id === "string");
  return deriveStageFinalizerIntent([{
    kind: "winner",
    row: { projectId: winner.id, stageKey, boardPosition, boardRevision },
    auditId: marker.id,
    publicationIds,
  }]);
}

export async function moveProjectStage(input: MoveProjectStageInput): Promise<MoveProjectStageResult> {
  const variant = await boardSchemaVariant(input.env.DB);
  if (variant === "pre_0037") return { kind: "schema_maintenance" };
  if (!await boardContractEnabled(input.env.DB, variant)) return { kind: "disabled" };
  const db = input.env.DB;
  const principal = input.principal;
  if (!principal.active || !roleHasCapability(principal.role, "moveProjectStage")) return { kind: "forbidden", capability: "moveProjectStage" };

  // External visibility is intentionally resolved before the project lookup: an invisible id is
  // indistinguishable from a missing id and never reaches a more revealing branch.
  if (!await resolveStageVisibleProject(input)) return { kind: "not_found" };
  const project = await readBoardProject(db, input.projectId);
  if (!project) return { kind: "not_found" };
  const current = stateFor(project, principal.role)!;
  if (project.archivedAt !== null) return { kind: "archived", current };

  const expectedStageKey = parseStageTransportKey(input.request.expected.stageKey, principal.role);
  const targetStageKey = parseStageTransportKey(input.request.targetStageKey, principal.role);
  if (!expectedStageKey || !targetStageKey || expectedStageKey !== project.stageKey || input.request.expected.boardRevision !== project.boardRevision) {
    return { kind: "conflict", current };
  }

  if (targetStageKey === project.stageKey) {
    const rows = await readBoardRows(db, project.stageKey);
    const visibleRows = await readVisibleBoardRows(db, principal, project.stageKey);
    if (placementChangesLogicalSlot({ target: project, destinationRows: rows, visibleRows, request: { ...input.request, targetStageKey } })
      && !roleHasCapability(principal.role, "prioritizeProjects")) {
      return { kind: "reorder_forbidden", code: "project_board_reorder_forbidden", capability: "prioritizeProjects" };
    }
    const placement = planBoardPlacement({ target: project, destinationRows: rows, visibleRows, request: { ...input.request, targetStageKey } });
    if (!placement) return { kind: "conflict", current };
    if (!placement.changed) return { kind: "no_change", response: responseFor(project, principal.role, project.stageKey, visibleRows, false) };
    if (!roleHasCapability(principal.role, "prioritizeProjects")) return { kind: "reorder_forbidden", code: "project_board_reorder_forbidden", capability: "prioritizeProjects" };
    return mapBoardResult(await moveProjectBoardOrder(input));
  }

  await ensurePipelineStages(createDb(db));
  const destinationStage = await db.prepare("SELECT active FROM pipeline_stages WHERE key = ?").bind(targetStageKey).first<{ active: number | boolean }>();
  if (!destinationStage || !(destinationStage.active === 1 || destinationStage.active === true)) return { kind: "inactive_destination", current };
  const reasons = stageMoveConfirmationReasons(project.stageKey, targetStageKey);
  if (!input.request.confirmation || !sameReasons(input.request.confirmation.reasons, reasons)) {
    return {
      kind: "confirmation_required",
      current,
      required: {
        fromStageKey: stageTransportKeyForRole(project.stageKey, principal.role),
        toStageKey: stageTransportKeyForRole(targetStageKey, principal.role),
        reasons,
      },
    };
  }

  const destinationRows = await readBoardRows(db, targetStageKey);
  const visibleRows = await readVisibleBoardRows(db, principal, targetStageKey);
  const placement = planBoardPlacement({ target: project, destinationRows, visibleRows, request: { ...input.request, targetStageKey } });
  if (!placement) return { kind: "conflict", current };
  const auditId = newId();
  const activityId = newId();
  const now = input.now ?? Date.now();
  const stage = placement.compact
    ? buildCompactingStageWinner({
      db, projectId: project.id, sourceStageKey: project.stageKey, targetStageKey,
      oldBoardRevision: project.boardRevision, expectedTarget: placement.expectedTarget.map((row) => ({ ...row, newBoardPosition: row.newBoardPosition! })),
      changedPlan: placement.changedPlan, expectedChangedRowCount: placement.changedPlan.length,
      auditId, actorId: principal.id, auditAction: "stage.set",
      auditMetaJson: auditMeta(principal, { from: project.stageKey, to: targetStageKey }) ?? "{}", now,
    })
    : buildNonCompactingStageWinner({
      db, projectId: project.id, sourceStageKey: project.stageKey, targetStageKey,
      oldBoardRevision: project.boardRevision, expectedTarget: placement.expectedTarget,
      placement: placement.placement, exactBoardPosition: placement.boardPosition,
      auditId, actorId: principal.id, auditAction: "stage.set",
      auditMetaJson: auditMeta(principal, { from: project.stageKey, to: targetStageKey }) ?? "{}", now,
    });
  const activity = buildStageActivityBundle({ db, projectId: project.id, activityId, actorId: principal.id, occurredAt: now, winnerAuditId: auditId });
  const deadline = targetStageKey === "delivered"
    ? buildDeadlineSuppressionBundle({ db, projectId: project.id, now, reason: "project_delivered", auditId })
    : undefined;
  const bundle = composeStageBundle({ stage, activity, deadline, workflow: buildWorkflowTail({ db, auditId, kind: "none" }, "none") });
  const results = await db.batch(bundle.statements);
  const finalizer = finalizerFromResults(results, project.id, bundle.indexes.stage.auditMarker, bundle.indexes.stage.winner, bundle.indexes.activity!.broadOutbox);
  if (!finalizer) return { kind: "conflict", current: stateFor(await readBoardProject(db, project.id), principal.role) };
  const updated = await readBoardProject(db, project.id);
  if (!updated || updated.archivedAt !== null || updated.stageKey !== targetStageKey) return { kind: "conflict", current: stateFor(updated, principal.role) };
  const updatedVisible = await readVisibleBoardRows(db, principal, targetStageKey);
  return { kind: "moved", response: responseFor(updated, principal.role, project.stageKey, updatedVisible, true), finalizer };
}
