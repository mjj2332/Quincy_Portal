import {
  compareBoardCards,
  roleHasCapability,
  type BoardCardOrderKey,
  type Role,
  type StageKey,
} from "@quincy/shared";
import type { SessionUser } from "../env";

export type BoardProjectRow = {
  id: string;
  stageKey: StageKey;
  priority: number | null;
  boardRevision: number;
};

/** A destination row as the viewer may see it, carrying what the fixed Board order reads. */
export type VisibleBoardRow = BoardProjectRow & BoardCardOrderKey;

type ProjectRow = BoardProjectRow & { archivedAt: number | null };

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

export async function readBoardProject(db: D1Database, projectId: string): Promise<ProjectRow | null> {
  return db.prepare(`
    SELECT id, stage_key AS stageKey, priority,
      board_revision AS boardRevision, archived_at AS archivedAt
    FROM projects WHERE id = ?
  `).bind(projectId).first<ProjectRow>();
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
      p.board_revision AS boardRevision
    FROM projects p
    LEFT JOIN project_members m ON m.project_id = p.id
    WHERE p.stage_key = ? AND p.archived_at IS NULL${stageVisibility}${membership}
  `).bind(...(isGlobal(principal.role) ? [stageKey] : [stageKey, principal.id])).all<VisibleBoardRow>();
  return sortBoardCardsForRole(result.results, principal.role);
}
