/**
 * Subtask assignee relation (`project_subtask_assignees`, #364, ADR 0012).
 *
 * While `project_subtasks.assignee_id` exists it mirrors the first assignee, and every write that changes it
 * appends these statements to the same D1 batch. Each is fenced by the winning audit row, so a lost
 * compare-and-swap writes nothing. There are no triggers (the worker test harness splits migration SQL on `;`).
 */

/** Order of a Subtask's assignees: the first is the one the legacy column mirrors. */
export const ASSIGNEE_ORDER_SQL = "assignment_version ASC, added_at ASC, user_id ASC";

export type OrderedAssignee = { assignmentVersion: number; addedAt: number; userId: string };

/** The JS twin of `ASSIGNEE_ORDER_SQL`. */
export function compareAssignees(a: OrderedAssignee, b: OrderedAssignee): number {
  if (a.assignmentVersion !== b.assignmentVersion) return a.assignmentVersion - b.assignmentVersion;
  if (a.addedAt !== b.addedAt) return a.addedAt - b.addedAt;
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
}

/**
 * Copy the column's current assignee into the relation at the Subtask's current version. Runs after the
 * Subtask UPDATE/INSERT in the same batch. `DO NOTHING`, never `DO UPDATE`: a person already present keeps
 * their per-person version.
 */
export function relationInsertFromColumn(db: D1Database, subtaskId: string, expectedAssigneeId: string, auditId: string, now: number): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at)
    SELECT id, assignee_id, assignment_version, ? FROM project_subtasks
    WHERE id = ? AND assignee_id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
    ON CONFLICT(subtask_id, user_id) DO NOTHING
  `).bind(now, subtaskId, expectedAssigneeId, auditId);
}

/** Remove one person from a Subtask. Replace-one dual-write uses this for the assignee the column held. */
export function relationDeleteOne(db: D1Database, subtaskId: string, userId: string, auditId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM project_subtask_assignees WHERE subtask_id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)").bind(subtaskId, userId, auditId);
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
