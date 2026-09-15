import {
  effectiveDefaultEditorSql,
  NOTIFICATION_OUTBOX_EVENT_TYPES,
  PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID,
  type ProjectAssignmentCreatedPayload,
} from "@quincy/shared";

/** "Effective default editor" (#135): pre-read once, before the create batch. */
export async function selectEffectiveDefaultEditorIds(db: D1Database): Promise<string[]> {
  const predicate = effectiveDefaultEditorSql("user");
  const result = await db.prepare(`SELECT id FROM user WHERE ${predicate.sql}`).bind(...predicate.bindings).all<{ id: string }>();
  return (result.results ?? []).map((row) => row.id);
}

/**
 * Per-editor member/audit/outbox/ledger statements for Tonomo's create batch. Every statement
 * re-checks the full effective-default-editor predicate in SQL, so a default disabled or
 * deactivated between the pre-read and this batch is simply not added — never an error.
 * No project activity rows: the system actor (`PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID`) is
 * rejected by the activity registry, so Tonomo's default-editor adds skip that surface entirely.
 */
export function buildDefaultEditorAssignmentStatements(
  db: D1Database,
  input: { projectId: string; orderId: string; userIds: string[]; now: number },
): { statements: D1PreparedStatement[]; outboxResultOffsets: number[] } {
  const statements: D1PreparedStatement[] = [];
  const outboxResultOffsets: number[] = [];
  const predicate = effectiveDefaultEditorSql("u");
  for (const userId of input.userIds) {
    const membershipId = crypto.randomUUID();
    const auditId = crypto.randomUUID();
    const outboxId = crypto.randomUUID();
    statements.push(db.prepare(`
      INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at)
      SELECT ?, ?, ?, 'editor', ?
      WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?)
        AND EXISTS (SELECT 1 FROM user u WHERE u.id = ? AND ${predicate.sql})
      ON CONFLICT(project_id, user_id, role_on_project) DO NOTHING
    `).bind(membershipId, input.projectId, userId, input.now, input.projectId, userId, ...predicate.bindings));
    statements.push(db.prepare(`
      INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?, NULL, 'project.member.add', 'project_member', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM project_members WHERE id = ? AND project_id = ? AND user_id = ? AND role_on_project = 'editor')
    `).bind(
      auditId, membershipId,
      JSON.stringify({ actor: "tonomo", source: "default_editor", orderId: input.orderId, projectId: input.projectId, userId, roleOnProject: "editor", membershipCycle: membershipId }),
      input.now, membershipId, input.projectId, userId,
    ));
    const payload: ProjectAssignmentCreatedPayload = {
      schemaVersion: 1,
      event: { type: NOTIFICATION_OUTBOX_EVENT_TYPES.projectAssignmentCreated, sourceKey: membershipId, recipientId: userId },
      assignment: { projectId: input.projectId, userId, roleOnProject: "editor", membershipCycle: membershipId },
    };
    outboxResultOffsets.push(statements.length);
    statements.push(db.prepare(`
      INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, recipient_authorization_epoch, payload_json, status, available_at, created_at, updated_at)
      SELECT ?, 1, ?, ?, ?, ?, ?, (SELECT authorization_epoch FROM user WHERE id = ?), ?, 'pending', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM project_members WHERE id = ? AND project_id = ? AND user_id = ? AND role_on_project = 'editor')
      RETURNING id
    `).bind(
      outboxId, NOTIFICATION_OUTBOX_EVENT_TYPES.projectAssignmentCreated, membershipId, input.projectId,
      PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID, userId, userId, JSON.stringify(payload), input.now, input.now, input.now,
      membershipId, input.projectId, userId,
    ));
    for (const channel of ["in_app", "email"] as const) {
      statements.push(db.prepare(`
        INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, ?
        WHERE EXISTS (SELECT 1 FROM notification_outbox WHERE id = ? AND event_type = ? AND source_key = ? AND recipient_id = ?)
      `).bind(
        crypto.randomUUID(), outboxId, NOTIFICATION_OUTBOX_EVENT_TYPES.projectAssignmentCreated, membershipId, userId, channel, input.now, input.now,
        outboxId, NOTIFICATION_OUTBOX_EVENT_TYPES.projectAssignmentCreated, membershipId, userId,
      ));
    }
  }
  return { statements, outboxResultOffsets };
}
