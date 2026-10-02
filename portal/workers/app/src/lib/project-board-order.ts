import {
  computeInsertPosition,
} from "@quincy/db";
import {
  compareBoardCards,
  roleHasCapability,
  type BoardCardOrderKey,
  type MoveProjectStageRequest,
  type Role,
  type StageKey,
} from "@quincy/shared";
import type { SessionUser } from "../env";

export type BoardProjectRow = {
  id: string;
  stageKey: StageKey;
  priority: number | null;
  boardPosition: number;
  boardRevision: number;
};

/** A destination row as the viewer may see it, carrying what the fixed Board order reads. */
export type VisibleBoardRow = BoardProjectRow & BoardCardOrderKey;

type ProjectRow = BoardProjectRow & { archivedAt: number | null };

export type BoardPlacementPlan = {
  target: BoardProjectRow;
  destinationWithoutTarget: BoardProjectRow[];
  changed: boolean;
  boardPosition: number;
  expectedTarget: Array<{ projectId: string; stageKey: StageKey; boardPosition: number; boardRevision: number }>;
};

function isGlobal(role: Role) {
  return roleHasCapability(role, "viewAllProjects");
}

/**
 * The Board order of one Stage as the viewer sees it (#470): priority, then oldest Shoot date,
 * then street and id. External Editors have no priority in their DTO, so priority takes no part
 * in their order -- it must not leak through the sequence.
 */
export function boardCardOrderOptionsFor(role: Role) {
  return { priorityVisible: role !== "external_editor" };
}

export function sortBoardCardsForRole<T extends BoardCardOrderKey>(rows: T[], role: Role): T[] {
  const options = boardCardOrderOptionsFor(role);
  return rows.sort((left, right) => compareBoardCards(left, right, options));
}

/**
 * Stored position, then id. Used only to anchor an append against the physical column; it is no
 * longer the order any viewer sees.
 */
export function compareBoardOrder(left: { id: string; boardPosition: number }, right: { id: string; boardPosition: number }) {
  return left.boardPosition - right.boardPosition || left.id.localeCompare(right.id);
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
  return result.results.sort(compareBoardOrder);
}

export async function readVisibleBoardRows(db: D1Database, principal: Pick<SessionUser, "id" | "role">, stageKey: StageKey): Promise<VisibleBoardRow[]> {
  const stageVisibility = principal.role === "photographer"
    ? " AND p.stage_key IN ('awaiting_raw', 'raw_review', 'edited_review', 'delivered')"
    : "";
  const membership = isGlobal(principal.role)
    ? ""
    : principal.role === "external_editor"
      ? " AND m.user_id = ? AND m.role_on_project = 'editor'"
      : " AND m.user_id = ?";
  const result = await db.prepare(`
    SELECT DISTINCT p.id, p.stage_key AS stageKey, p.priority, p.street, p.shoot_date AS shootDate,
      p.board_position AS boardPosition, p.board_revision AS boardRevision
    FROM projects p
    LEFT JOIN project_members m ON m.project_id = p.id
    WHERE p.stage_key = ? AND p.archived_at IS NULL${stageVisibility}${membership}
  `).bind(...(isGlobal(principal.role) ? [stageKey] : [stageKey, principal.id])).all<VisibleBoardRow>();
  return sortBoardCardsForRole(result.results, principal.role);
}

/**
 * Plans an append of `target` to the bottom of the destination column. Every Stage move appends
 * now (#470): the viewer-facing order comes from the data, so the stored position is bookkeeping
 * that only has to be unique-ish and stable. A request that names a different placement is
 * treated as an append too -- a stale tab may still send one.
 */
export function planBoardPlacement(input: {
  target: BoardProjectRow;
  destinationRows: BoardProjectRow[];
  request: Pick<MoveProjectStageRequest, "targetStageKey">;
}): BoardPlacementPlan {
  const { target, request } = input;
  const destinationWithoutTarget = input.destinationRows.filter((row) => row.id !== target.id).sort(compareBoardOrder);
  const requestedDestinationStage = request.targetStageKey === "editing" ? "editing_autohdr" : request.targetStageKey as StageKey;
  const last = destinationWithoutTarget.at(-1) ?? null;
  const boardPosition = computeInsertPosition(last?.boardPosition ?? null, null);
  return {
    target,
    destinationWithoutTarget,
    changed: target.stageKey !== requestedDestinationStage,
    boardPosition,
    expectedTarget: destinationWithoutTarget.map((row) => ({
      projectId: row.id,
      stageKey: row.stageKey,
      boardPosition: row.boardPosition,
      boardRevision: row.boardRevision,
    })),
  };
}
