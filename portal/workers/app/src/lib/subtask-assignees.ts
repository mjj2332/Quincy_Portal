/**
 * Subtask assignee relation (`project_subtask_assignees`, #364, ADR 0012).
 *
 * The relation is the source of truth (#368). `project_subtasks.assignee_id` mirrors the first assignee for
 * not-yet-migrated readers, and every write that changes the set appends these statements to the same D1 batch. Each is fenced by the winning audit row, so a lost
 * compare-and-swap writes nothing. There are no triggers (the worker test harness splits migration SQL on `;`).
 */
import type { Role } from "@quincy/shared";
import { SUBTASK_MULTI_ASSIGNEE_FLAG } from "@quincy/shared";

/** Order of a Subtask's assignees: the first is the one the legacy column mirrors. */
export const ASSIGNEE_ORDER_SQL = "assignment_version ASC, added_at ASC, user_id ASC";

export type OrderedAssignee = { assignmentVersion: number; addedAt: number; userId: string };

/** The JS twin of `ASSIGNEE_ORDER_SQL`. */
export function compareAssignees(a: OrderedAssignee, b: OrderedAssignee): number {
  if (a.assignmentVersion !== b.assignmentVersion) return a.assignmentVersion - b.assignmentVersion;
  if (a.addedAt !== b.addedAt) return a.addedAt - b.addedAt;
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
}

export type HydratedAssignee = {
  id: string;
  name: string;
  role: Role;
  active: boolean;
  assignmentVersion: number;
  addedAt: number;
  /** Has a `project_members` row on the Subtask's Project (any role): the visibility rule for externals. */
  onTeam: boolean;
};

/** Whether more than one assignee may be saved (#358). A missing row means off. */
export async function multiAssigneeEnabled(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT enabled FROM feature_flags WHERE key = ?").bind(SUBTASK_MULTI_ASSIGNEE_FLAG).first<{ enabled: number }>();
  return row?.enabled === 1;
}

type HydrationRow = { subtaskId: string; id: string; name: string; role: Role; active: number; assignmentVersion: number; addedAt: number; onTeam: number };

const HYDRATE_SELECT = `
  SELECT a.subtask_id AS subtaskId, a.user_id AS id, u.name, u.role, u.active, a.assignment_version AS assignmentVersion, a.added_at AS addedAt,
    EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = s.project_id AND pm.user_id = a.user_id) AS onTeam
  FROM project_subtask_assignees a JOIN project_subtasks s ON s.id = a.subtask_id JOIN user u ON u.id = a.user_id`;

function sortAssignees(rows: HydrationRow[]): HydratedAssignee[] {
  return rows
    .map((row) => ({ id: row.id, name: row.name, role: row.role, active: row.active === 1, assignmentVersion: row.assignmentVersion, addedAt: row.addedAt, onTeam: row.onTeam === 1 }))
    .sort((a, b) => compareAssignees({ assignmentVersion: a.assignmentVersion, addedAt: a.addedAt, userId: a.id }, { assignmentVersion: b.assignmentVersion, addedAt: b.addedAt, userId: b.id }));
}

/** Every assignee of every Subtask on the Project, ordered per Subtask. The order is sorted in JS, never taken from SQL. */
export async function hydrateProjectAssignees(db: D1Database, projectId: string): Promise<Map<string, HydratedAssignee[]>> {
  const { results } = await db.prepare(`${HYDRATE_SELECT} WHERE s.project_id = ?`).bind(projectId).all<HydrationRow>();
  const bySubtask = new Map<string, HydrationRow[]>();
  for (const row of results) bySubtask.set(row.subtaskId, [...(bySubtask.get(row.subtaskId) ?? []), row]);
  return new Map([...bySubtask].map(([subtaskId, rows]) => [subtaskId, sortAssignees(rows)]));
}

export async function hydrateSubtaskAssignees(db: D1Database, subtaskId: string): Promise<HydratedAssignee[]> {
  const { results } = await db.prepare(`${HYDRATE_SELECT} WHERE a.subtask_id = ?`).bind(subtaskId).all<HydrationRow>();
  return sortAssignees(results);
}

/** Active users an External Editor may add: those with a `project_members` row on the Project. */
export async function externalAddEligible(db: D1Database, projectId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { results } = await db.prepare(`
    SELECT DISTINCT u.id FROM user u JOIN project_members pm ON pm.user_id = u.id
    WHERE pm.project_id = ? AND u.active = 1 AND u.id IN (SELECT value FROM json_each(?))
  `).bind(projectId, JSON.stringify(ids)).all<{ id: string }>();
  return new Set(results.map((row) => row.id));
}

const FENCE = "EXISTS (SELECT 1 FROM audit_log WHERE id = ?)";

/** Remove people from a Subtask. Fenced by the winning audit row, so a lost compare-and-swap deletes nothing. */
export function relationDeleteMany(db: D1Database, subtaskId: string, userIdsJson: string, auditId: string): D1PreparedStatement {
  return db.prepare(`DELETE FROM project_subtask_assignees WHERE subtask_id = ? AND user_id IN (SELECT value FROM json_each(?)) AND ${FENCE}`).bind(subtaskId, userIdsJson, auditId);
}

/**
 * Add people at the Subtask's new version. `DO NOTHING`, never `DO UPDATE`: a person already present keeps
 * their per-person version. The `WHERE` is required by SQLite to disambiguate `INSERT ... SELECT ... ON CONFLICT`.
 */
export function relationInsertMany(db: D1Database, subtaskId: string, userIdsJson: string, version: number, now: number, auditId: string): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at)
    SELECT ?, value, ?, ? FROM json_each(?) WHERE ${FENCE}
    ON CONFLICT(subtask_id, user_id) DO NOTHING
  `).bind(subtaskId, version, now, userIdsJson, auditId);
}

// Mirror of the first assignee for not-yet-migrated readers. Deleted in #373 (PR8).
export function mirrorRecompute(db: D1Database, subtaskId: string, auditId: string): D1PreparedStatement {
  return db.prepare(`
    UPDATE project_subtasks SET assignee_id = (
      SELECT user_id FROM project_subtask_assignees WHERE subtask_id = ?1 ORDER BY ${ASSIGNEE_ORDER_SQL} LIMIT 1
    ) WHERE id = ?1 AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?2)
  `).bind(subtaskId, auditId);
}

/**
 * Team removal: drop the person from every Subtask on the Project. The guard is the one the column-clearing
 * UPDATE uses (no other eligible role remains, and the person is not an active admin), so it removes exactly what
 * that UPDATE emptied.
 */
export function relationDeleteForRemovedMember(
  db: D1Database,
  input: { projectId: string; userId: string; auditId: string; remainingAfterDelete: { sql: string; bindings: unknown[] } },
): D1PreparedStatement {
  return db.prepare(`
    DELETE FROM project_subtask_assignees
    WHERE user_id = ?
      AND subtask_id IN (SELECT id FROM project_subtasks WHERE project_id = ?)
      AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
      AND NOT EXISTS (SELECT 1 FROM project_members remaining JOIN user target ON target.id = remaining.user_id WHERE ${input.remainingAfterDelete.sql})
      AND NOT EXISTS (SELECT 1 FROM user WHERE id = ? AND role = 'admin' AND active = 1)
  `).bind(input.userId, input.projectId, input.auditId, ...input.remainingAfterDelete.bindings, input.userId);
}

/**
 * The one shape of a per-person Subtask count (#371): how many Subtasks on a Project a person is an assignee of, read
 * from the relation and never the mirrored column. Both arguments are SQL expressions (a column or a `?` placeholder).
 */
export function assignedSubtaskCountSql(projectIdSql: string, userIdSql: string): string {
  return `(SELECT COUNT(*) FROM project_subtask_assignees sa INNER JOIN project_subtasks st ON st.id = sa.subtask_id WHERE st.project_id = ${projectIdSql} AND sa.user_id = ${userIdSql})`;
}

/**
 * Team removal, mirror repair (removed with the column in PR 8 of the multi-assignee series): after the relation rows go, point the
 * legacy column at the first remaining assignee (or NULL) on Subtasks that mirrored the removed person.
 */
export function mirrorRepairForRemovedMember(db: D1Database, input: { projectId: string; userId: string; auditId: string }): D1PreparedStatement {
  return db.prepare(`
    UPDATE project_subtasks SET assignee_id = (SELECT sa.user_id FROM project_subtask_assignees sa WHERE sa.subtask_id = project_subtasks.id ORDER BY sa.assignment_version ASC, sa.added_at ASC, sa.user_id ASC LIMIT 1)
    WHERE project_id = ? AND assignee_id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
  `).bind(input.projectId, input.userId, input.auditId);
}
