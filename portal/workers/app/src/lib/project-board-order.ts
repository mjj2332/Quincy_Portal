import {
  boardContractEnabled,
  boardSchemaVariant,
  buildCompactingStageWinner,
  buildNonCompactingStageWinner,
  composeStageBundle,
  computeInsertPosition,
  deriveStageFinalizerIntent,
  buildWorkflowTail,
  type StageFinalizerWinnerResult,
  type CommittedStageFinalizerIntent,
} from "@quincy/db";
import {
  roleHasCapability,
  stageTransportKeyForRole,
  parseStageTransportKey,
  type MoveProjectStageRequest,
  type MoveProjectStageResponse,
  type Role,
  type StageKey,
  type StageMoveProjectState,
} from "@quincy/shared";
import { resolveVisibleProject } from "./visible-project-scope";
import { auditMeta } from "./audit";
import { newId } from "./ids";
import type { AppEnv, SessionUser } from "../env";

export type BoardProjectRow = {
  id: string;
  stageKey: StageKey;
  priority: number | null;
  boardPosition: number;
  boardRevision: number;
};

type ProjectRow = BoardProjectRow & { archivedAt: number | null };

export type BoardPlacementPlan = {
  target: BoardProjectRow;
  destination: BoardProjectRow[];
  destinationWithoutTarget: BoardProjectRow[];
  changed: boolean;
  compact: boolean;
  boardPosition: number;
  expectedTarget: Array<{ projectId: string; stageKey: StageKey; boardPosition: number; boardRevision: number; newBoardPosition?: number }>;
  changedPlan: Array<{
    projectId: string;
    oldStageKey: StageKey;
    oldBoardPosition: number;
    oldBoardRevision: number;
    newBoardPosition: number;
    isTarget: 0 | 1;
  }>;
  placement: "append" | "exact";
};

export type BoardOrderResult =
  | { kind: "moved"; response: MoveProjectStageResponse; finalizer: CommittedStageFinalizerIntent }
  | { kind: "no_change"; response: MoveProjectStageResponse }
  | { kind: "forbidden"; capability: "prioritizeProjects" }
  | { kind: "not_found" }
  | { kind: "conflict"; current: StageMoveProjectState | null }
  | { kind: "disabled" }
  | { kind: "schema_maintenance" };

export type ProjectBoardOrderInput = {
  env: AppEnv["Bindings"];
  principal: SessionUser;
  projectId: string;
  request: MoveProjectStageRequest;
  now?: number;
};

function isGlobal(role: Role) {
  return roleHasCapability(role, "viewAllProjects");
}

function compareRows(left: BoardProjectRow, right: BoardProjectRow) {
  return (left.priority === null ? 1 : 0) - (right.priority === null ? 1 : 0)
    || left.boardPosition - right.boardPosition
    || left.id.localeCompare(right.id);
}

function currentState(row: ProjectRow | BoardProjectRow | null, role: Role): StageMoveProjectState | null {
  return row ? {
    projectId: row.id,
    stageKey: stageTransportKeyForRole(row.stageKey, role),
    boardRevision: row.boardRevision,
  } : null;
}

function responseFor(
  target: BoardProjectRow,
  role: Role,
  sourceStageKey: StageKey,
  visibleDestination: BoardProjectRow[],
  changed: boolean,
): MoveProjectStageResponse {
  return {
    changed,
    project: {
      projectId: target.id,
      stageKey: stageTransportKeyForRole(target.stageKey, role),
      boardRevision: target.boardRevision,
    },
    board: {
      sourceStageKey: stageTransportKeyForRole(sourceStageKey, role),
      targetStageKey: stageTransportKeyForRole(target.stageKey, role),
      orderedVisibleProjectIds: visibleDestination.map((row) => row.id),
    },
  };
}

export async function readBoardProject(db: D1Database, projectId: string): Promise<ProjectRow | null> {
  return db.prepare(`
    SELECT id, stage_key AS stageKey, priority, board_position AS boardPosition,
      board_revision AS boardRevision, archived_at AS archivedAt
    FROM projects WHERE id = ?
  `).bind(projectId).first<ProjectRow>();
}

export async function readBoardRows(db: D1Database, stageKey: StageKey): Promise<BoardProjectRow[]> {
  const result = await db.prepare(`
    SELECT id, stage_key AS stageKey, priority, board_position AS boardPosition,
      board_revision AS boardRevision
    FROM projects
    WHERE stage_key = ? AND archived_at IS NULL
  `).bind(stageKey).all<BoardProjectRow>();
  return result.results.sort(compareRows);
}

export async function readVisibleBoardRows(db: D1Database, principal: Pick<SessionUser, "id" | "role">, stageKey: StageKey): Promise<BoardProjectRow[]> {
  const stageVisibility = principal.role === "photographer"
    ? " AND p.stage_key IN ('awaiting_raw', 'raw_review', 'edited_review', 'delivered')"
    : "";
  const membership = isGlobal(principal.role)
    ? ""
    : principal.role === "external_editor"
      ? " AND m.user_id = ? AND m.role_on_project = 'editor'"
      : " AND m.user_id = ?";
  const result = await db.prepare(`
    SELECT DISTINCT p.id, p.stage_key AS stageKey, p.priority,
      p.board_position AS boardPosition, p.board_revision AS boardRevision
    FROM projects p
    LEFT JOIN project_members m ON m.project_id = p.id
    WHERE p.stage_key = ? AND p.archived_at IS NULL${stageVisibility}${membership}
  `).bind(...(isGlobal(principal.role) ? [stageKey] : [stageKey, principal.id])).all<BoardProjectRow>();
  return result.results.sort(compareRows);
}

function normalizedPlacement(request: MoveProjectStageRequest) {
  return request.placement.kind === "between"
    && request.placement.before === null
    && request.placement.after === null
    ? { kind: "append" as const }
    : request.placement;
}

/**
 * Classifies the requested logical slot without reading neighbour revisions. This is deliberately
 * separate from planBoardPlacement: capability denial must not be replaced by a stale-neighbour
 * conflict for an unauthorized same-stage reorder.
 */
export function placementChangesLogicalSlot(input: {
  target: BoardProjectRow;
  destinationRows: BoardProjectRow[];
  visibleRows: BoardProjectRow[];
  request: MoveProjectStageRequest;
}): boolean {
  const placement = normalizedPlacement(input.request);
  const destinationWithoutTarget = input.destinationRows.filter((row) => row.id !== input.target.id).sort(compareRows);
  const visibleWithoutTarget = input.visibleRows.filter((row) => row.id !== input.target.id).sort(compareRows);
  const fullById = new Map(destinationWithoutTarget.map((row) => [row.id, row]));
  let insertionIndex = destinationWithoutTarget.length;

  if (placement.kind === "between") {
    const { before, after } = placement;
    if (before && (!fullById.has(before.projectId) || !visibleWithoutTarget.some((row) => row.id === before.projectId))) return true;
    if (after && (!fullById.has(after.projectId) || !visibleWithoutTarget.some((row) => row.id === after.projectId))) return true;
    if (before && after) {
      const beforeIndex = visibleWithoutTarget.findIndex((row) => row.id === before.projectId);
      const afterIndex = visibleWithoutTarget.findIndex((row) => row.id === after.projectId);
      if (beforeIndex < 0 || afterIndex !== beforeIndex + 1) return true;
      insertionIndex = destinationWithoutTarget.findIndex((row) => row.id === after.projectId);
      if (insertionIndex < 0) return true;
    } else if (after) {
      if (visibleWithoutTarget[0]?.id !== after.projectId) return true;
      insertionIndex = destinationWithoutTarget.findIndex((row) => row.id === after.projectId);
      if (insertionIndex < 0) return true;
    } else if (before) {
      if (visibleWithoutTarget.at(-1)?.id !== before.projectId) return true;
      // A null after anchor means global append, including when hidden rows follow the anchor.
      insertionIndex = destinationWithoutTarget.length;
    }
  }

  const requestedDestinationStage = input.request.targetStageKey === "editing" ? "editing_autohdr" : input.request.targetStageKey as StageKey;
  const currentIndex = input.destinationRows.slice().sort(compareRows).findIndex((row) => row.id === input.target.id);
  return input.target.stageKey !== requestedDestinationStage || currentIndex < 0 || currentIndex !== insertionIndex;
}

/**
 * Validates visible neighbour adjacency, then anchors against the complete destination column.
 * The returned plan is shared by cross-stage and same-stage commands so neither command can
 * accidentally use the caller's filtered projection as the global ordering authority.
 */
export function planBoardPlacement(input: {
  target: BoardProjectRow;
  destinationRows: BoardProjectRow[];
  visibleRows: BoardProjectRow[];
  request: MoveProjectStageRequest;
}): BoardPlacementPlan | null {
  const { target, request } = input;
  const placement = normalizedPlacement(request);
  const destinationWithoutTarget = input.destinationRows.filter((row) => row.id !== target.id).sort(compareRows);
  const visibleWithoutTarget = input.visibleRows.filter((row) => row.id !== target.id).sort(compareRows);
  const fullById = new Map(destinationWithoutTarget.map((row) => [row.id, row]));
  const visibleById = new Map(visibleWithoutTarget.map((row) => [row.id, row]));

  let insertionIndex = destinationWithoutTarget.length;
  if (placement.kind === "between") {
    const before = placement.before;
    const after = placement.after;
    if (before && (!visibleById.has(before.projectId) || fullById.get(before.projectId)?.boardRevision !== before.boardRevision)) return null;
    if (after && (!visibleById.has(after.projectId) || fullById.get(after.projectId)?.boardRevision !== after.boardRevision)) return null;
    if (before && after) {
      const beforeIndex = visibleWithoutTarget.findIndex((row) => row.id === before.projectId);
      const afterIndex = visibleWithoutTarget.findIndex((row) => row.id === after.projectId);
      if (beforeIndex < 0 || afterIndex !== beforeIndex + 1) return null;
      insertionIndex = destinationWithoutTarget.findIndex((row) => row.id === after.projectId);
      if (insertionIndex < 0) return null;
    } else if (after) {
      if (visibleWithoutTarget[0]?.id !== after.projectId) return null;
      insertionIndex = destinationWithoutTarget.findIndex((row) => row.id === after.projectId);
      if (insertionIndex < 0) return null;
    } else if (before) {
      if (visibleWithoutTarget.at(-1)?.id !== before.projectId) return null;
      // A null after anchor is a global append, even when hidden rows follow the visible anchor.
      insertionIndex = destinationWithoutTarget.length;
    }
  }

  const requestedDestinationStage = request.targetStageKey === "editing" ? "editing_autohdr" : request.targetStageKey as StageKey;
  const destination = [...destinationWithoutTarget];
  destination.splice(insertionIndex, 0, { ...target, stageKey: requestedDestinationStage });
  // A same-Stage request can describe the target's existing logical slot. Treat that as a
  // no-op before calculating a fresh midpoint; otherwise an append of an already-bottom row
  // would manufacture a new position and incorrectly count as a reorder.
  const currentDestination = input.destinationRows.slice().sort(compareRows);
  const currentIndex = currentDestination.findIndex((row) => row.id === target.id);
  const unchangedSlot = target.stageKey === requestedDestinationStage
    && currentIndex >= 0
    && currentIndex === insertionIndex;
  if (unchangedSlot) {
    return {
      target,
      destination: currentDestination,
      destinationWithoutTarget,
      changed: false,
      compact: false,
      boardPosition: target.boardPosition,
      expectedTarget: destinationWithoutTarget.map((row) => ({
        projectId: row.id,
        stageKey: row.stageKey,
        boardPosition: row.boardPosition,
        boardRevision: row.boardRevision,
      })),
      changedPlan: [],
      placement: placement.kind === "append" ? "append" : "exact",
    };
  }
  const previous = destination[insertionIndex - 1] ?? null;
  const next = destination[insertionIndex + 1] ?? null;
  const candidate = computeInsertPosition(previous?.boardPosition ?? null, next?.boardPosition ?? null);
  const collides = !Number.isFinite(candidate) || destinationWithoutTarget.some((row) => row.boardPosition === candidate);
  const compact = placement.kind === "between" && collides;
  const newPositions = new Map<string, number>();
  if (compact) destination.forEach((row, index) => newPositions.set(row.id, index * 1024));
  else newPositions.set(target.id, candidate);

  const finalPosition = newPositions.get(target.id)!;
  const actualChanged = target.stageKey !== requestedDestinationStage
    || target.boardPosition !== finalPosition;
  const expectedTarget = destinationWithoutTarget.map((row) => ({
    projectId: row.id,
    stageKey: row.stageKey,
    boardPosition: row.boardPosition,
    boardRevision: row.boardRevision,
    ...(compact ? { newBoardPosition: newPositions.get(row.id)! } : {}),
  }));
  const changedPlan: BoardPlacementPlan["changedPlan"] = [];
  if (compact) {
    for (const row of destination) {
      const newBoardPosition = newPositions.get(row.id)!;
      if (row.id === target.id) changedPlan.push({ projectId: row.id, oldStageKey: target.stageKey, oldBoardPosition: target.boardPosition, oldBoardRevision: target.boardRevision, newBoardPosition, isTarget: 1 });
      else if (row.boardPosition !== newBoardPosition) changedPlan.push({ projectId: row.id, oldStageKey: row.stageKey, oldBoardPosition: row.boardPosition, oldBoardRevision: row.boardRevision, newBoardPosition, isTarget: 0 });
    }
  } else {
    changedPlan.push({ projectId: target.id, oldStageKey: target.stageKey, oldBoardPosition: target.boardPosition, oldBoardRevision: target.boardRevision, newBoardPosition: finalPosition, isTarget: 1 });
  }
  return {
    target,
    destination,
    destinationWithoutTarget,
    changed: actualChanged,
    compact,
    boardPosition: finalPosition,
    expectedTarget,
    changedPlan,
    placement: placement.kind === "append" ? "append" : "exact",
  };
}

function finalizerFromResults(results: D1Result<unknown>[], projectId: string, auditIndex: number, winnerIndex: number, activityIndex?: number) {
  const winner = (results[winnerIndex]?.results ?? []).find((row) => (row as { id?: unknown }).id === projectId) as { id?: string; stageKey?: StageKey; stage_key?: StageKey; boardPosition?: number; board_position?: number; boardRevision?: number; board_revision?: number } | undefined;
  const auditRow = results[auditIndex]?.results?.[0] as { id?: string } | undefined;
  const stageKey = winner?.stageKey ?? winner?.stage_key;
  const boardPosition = winner?.boardPosition ?? winner?.board_position;
  const boardRevision = winner?.boardRevision ?? winner?.board_revision;
  if (!winner?.id || !stageKey || boardPosition === undefined || boardRevision === undefined || !auditRow?.id) return null;
  const publicationIds = activityIndex === undefined
    ? []
    : (results[activityIndex]?.results ?? []).map((row) => (row as { id?: unknown }).id).filter((id): id is string => typeof id === "string");
  const intent = deriveStageFinalizerIntent([{
    kind: "winner",
    row: { projectId: winner.id, stageKey, boardPosition, boardRevision },
    auditId: auditRow.id,
    publicationIds,
  } satisfies StageFinalizerWinnerResult]);
  return intent;
}

async function readPrincipal(db: D1Database, principal: SessionUser): Promise<SessionUser | null> {
  const row = await db.prepare("SELECT id, email, name, role, active, authorization_epoch AS authorizationEpoch FROM user WHERE id = ?")
    .bind(principal.id).first<{ id: string; email: string; name: string; role: Role; active: number | boolean; authorizationEpoch: number }>();
  return row?.active === 1 || row?.active === true ? { ...row, active: true, impersonatedBy: principal.impersonatedBy } : null;
}

export async function moveProjectBoardOrder(input: ProjectBoardOrderInput): Promise<BoardOrderResult> {
  const db = input.env.DB;
  const principal = await readPrincipal(db, input.principal);
  if (!principal || !roleHasCapability(principal.role, "prioritizeProjects")) return { kind: "forbidden", capability: "prioritizeProjects" };
  const variant = await boardSchemaVariant(db);
  if (variant === "pre_0037") return { kind: "schema_maintenance" };
  if (!await boardContractEnabled(db, variant)) return { kind: "disabled" };
  if (!await resolveVisibleProject(input.env, principal, input.projectId)) return { kind: "not_found" };
  const current = await readBoardProject(db, input.projectId);
  if (!current || current.archivedAt !== null) return { kind: "not_found" };
  const request = input.request;
  const expected = request.expected;
  const expectedStage = parseStageTransportKey(expected.stageKey, principal.role);
  const destinationStage = current.stageKey;
  if (expectedStage !== current.stageKey || expected.boardRevision !== current.boardRevision) {
    return { kind: "conflict", current: currentState(current, principal.role) };
  }
  const rows = await readBoardRows(db, destinationStage);
  const visibleRows = await readVisibleBoardRows(db, principal, destinationStage);
  const targetStage = parseStageTransportKey(request.targetStageKey, principal.role);
  if (targetStage !== current.stageKey) return { kind: "conflict", current: currentState(current, principal.role) };
  const plan = planBoardPlacement({ target: current, destinationRows: rows, visibleRows, request: { ...request, targetStageKey: targetStage } });
  if (!plan) return { kind: "conflict", current: currentState(current, principal.role) };
  if (!plan.changed) {
    return { kind: "no_change", response: responseFor(current, principal.role, current.stageKey, visibleRows, false) };
  }
  const auditId = newId();
  const now = input.now ?? Date.now();
  const stage = plan.compact
    ? buildCompactingStageWinner({
      db, projectId: current.id, sourceStageKey: current.stageKey, targetStageKey: current.stageKey,
      oldBoardRevision: current.boardRevision, expectedTarget: plan.expectedTarget.map((row) => ({ ...row, newBoardPosition: row.newBoardPosition! })),
      changedPlan: plan.changedPlan, expectedChangedRowCount: plan.changedPlan.length,
      auditId, actorId: principal.id, auditAction: "project.board_position_set", auditMetaJson: auditMeta(principal, {} ) ?? "{}", now,
    })
    : buildNonCompactingStageWinner({
      db, projectId: current.id, sourceStageKey: current.stageKey, targetStageKey: current.stageKey,
      oldBoardRevision: current.boardRevision, expectedTarget: plan.expectedTarget, placement: plan.placement,
      exactBoardPosition: plan.boardPosition, auditId, actorId: principal.id,
      auditAction: "project.board_position_set", auditMetaJson: auditMeta(principal, {}) ?? "{}", now,
    });
  const bundle = composeStageBundle({ stage, workflow: buildWorkflowTail({ db, auditId, kind: "none" }, "none") });
  const results = await db.batch(bundle.statements);
  const intent = finalizerFromResults(results, input.projectId, bundle.indexes.stage.auditMarker, bundle.indexes.stage.winner);
  if (!intent) return { kind: "conflict", current: currentState(await readBoardProject(db, input.projectId), principal.role) };
  const updated = await readBoardProject(db, input.projectId);
  if (!updated || updated.archivedAt !== null) return { kind: "conflict", current: null };
  const updatedVisible = await readVisibleBoardRows(db, principal, current.stageKey);
  const response = responseFor(updated, principal.role, current.stageKey, updatedVisible, true);
  return { kind: "moved", response, finalizer: intent };
}
