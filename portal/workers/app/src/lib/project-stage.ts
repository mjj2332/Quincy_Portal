import {
  boardContractEnabled,
  boardSchemaVariant,
  buildDeadlineSuppressionBundle,
  buildStageActivityBundle,
  buildStageWinner,
  buildStageShootDateFill,
  buildWorkflowTail,
  composeStageBundle,
  createDb,
  deriveStageFinalizerIntent,
  shootDateFillLanded,
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
  readBoardProject,
  readVisibleBoardRows,
} from "./project-board-order";

export type MoveProjectStageInput = {
  env: AppEnv["Bindings"];
  principal: SessionUser;
  projectId: string;
  request: MoveProjectStageRequest;
  now?: number;
};

export type MoveProjectStageResult =
  | { kind: "moved"; response: MoveProjectStageResponse; finalizer: CommittedStageFinalizerIntent; /** Internal: a Shoot date fill landed in this batch; never part of the HTTP body. */ shootDateFilled: boolean }
  | { kind: "no_change"; response: MoveProjectStageResponse }
  | { kind: "forbidden"; capability: "moveProjectStage" }
  | { kind: "not_found" }
  | { kind: "archived"; current: StageMoveProjectState }
  | { kind: "inactive_destination"; current: StageMoveProjectState }
  | { kind: "confirmation_required"; current: StageMoveProjectState; required: { fromStageKey: StageTransportKey; toStageKey: StageTransportKey; reasons: StageMoveConfirmationReason[] } }
  /** `shootDateFilled`: the batch committed (and filled) but a later move won the reread; the fill's follow-up must still run. */
  | { kind: "conflict"; current: StageMoveProjectState | null; shootDateFilled?: boolean }
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
    projectLabel: null,
    membershipCycleIds: [],
    role: input.principal.role,
    isExternal: false,
  } : null;
}

function finalizerFromResults(results: D1Result<unknown>[], projectId: string, auditIndex: number, winnerIndex: number, activityIndex: number) {
  const winner = (results[winnerIndex]?.results ?? []).find((item) => (item as { id?: unknown }).id === projectId) as { id?: string; stage_key?: StageKey; stageKey?: StageKey; board_revision?: number; boardRevision?: number } | undefined;
  const marker = results[auditIndex]?.results?.[0] as { id?: string } | undefined;
  if (!winner?.id || !marker?.id) return null;
  const stageKey = winner.stageKey ?? winner.stage_key;
  const boardRevision = winner.boardRevision ?? winner.board_revision;
  if (!stageKey || boardRevision === undefined) return null;
  const publicationIds = (results[activityIndex]?.results ?? []).map((item) => (item as { id?: unknown }).id).filter((id): id is string => typeof id === "string");
  return deriveStageFinalizerIntent([{
    kind: "winner",
    row: { projectId: winner.id, stageKey, boardRevision },
    auditId: marker.id,
    publicationIds,
  }]);
}

export async function moveProjectStage(input: MoveProjectStageInput): Promise<MoveProjectStageResult> {
  const principal = input.principal;
  if (!principal.active || !roleHasCapability(principal.role, "moveProjectStage")) return { kind: "forbidden", capability: "moveProjectStage" };
  const variant = await boardSchemaVariant(input.env.DB);
  if (variant === "pre_0037") return { kind: "schema_maintenance" };
  if (!await boardContractEnabled(input.env.DB, variant)) return { kind: "disabled" };
  const db = input.env.DB;

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

  // The Board is sorted by data (#470), so a same-Stage request has nothing to change. The source
  // CAS above already rejected a stale card. A retired `between` placement never reaches here: the
  // route answers it with 409 stage_contract_reload_required before parsing (#475).
  if (targetStageKey === project.stageKey) {
    const visibleRows = await readVisibleBoardRows(db, principal, project.stageKey);
    return { kind: "no_change", response: responseFor(project, principal.role, project.stageKey, visibleRows, false) };
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

  const auditId = newId();
  const activityId = newId();
  const now = input.now ?? Date.now();
  const stage = buildStageWinner({
    db, projectId: project.id, sourceStageKey: project.stageKey, targetStageKey,
    oldBoardRevision: project.boardRevision,
    auditId, actorId: principal.id, auditAction: "stage.set",
    auditMetaJson: auditMeta(principal, { from: project.stageKey, to: targetStageKey }) ?? "{}", now,
  });
  const activity = buildStageActivityBundle({ db, projectId: project.id, activityId, actorId: principal.id, occurredAt: now, winnerAuditId: auditId });
  const deadline = targetStageKey === "delivered"
    ? buildDeadlineSuppressionBundle({ db, projectId: project.id, now, reason: "project_delivered", auditId })
    : undefined;
  const shootDateFill = buildStageShootDateFill({
    db, projectId: project.id, from: project.stageKey, to: targetStageKey,
    winnerAuditId: auditId, winnerAuditAction: "stage.set", fillAuditId: newId(),
    actorId: principal.id, impersonatedBy: principal.impersonatedBy, now,
  });
  const bundle = composeStageBundle({ stage, activity, deadline, workflow: buildWorkflowTail({ db, auditId, kind: "none" }, "none"), shootDateFill });
  const results = await db.batch(bundle.statements);
  const finalizer = finalizerFromResults(results, project.id, bundle.indexes.stage.auditMarker, bundle.indexes.stage.winner, bundle.indexes.activity!.broadOutbox);
  if (!finalizer) return { kind: "conflict", current: stateFor(await readBoardProject(db, project.id), principal.role) };
  // Read once the batch committed: a later move winning the reread below must not drop the fill's follow-up.
  const shootDateFilled = shootDateFillLanded(results, bundle.indexes.shootDateFill);
  const updated = await readBoardProject(db, project.id);
  if (!updated || updated.archivedAt !== null || updated.stageKey !== targetStageKey) return { kind: "conflict", current: stateFor(updated, principal.role), shootDateFilled };
  const updatedVisible = await readVisibleBoardRows(db, principal, targetStageKey);
  return { kind: "moved", response: responseFor(updated, principal.role, project.stageKey, updatedVisible, true), finalizer, shootDateFilled };
}
