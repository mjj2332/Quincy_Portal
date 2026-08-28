import {
  EXTERNAL_LEGACY_NOTIFICATION_POLICY,
  EXTERNAL_NOTIFICATION_OUTBOX_EVENT_TYPES,
  externalNotificationChannels,
  externalNotificationCopy,
  type NotificationType,
} from "@quincy/shared";

function uuidSql(): string {
  return "lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-8' || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))";
}

export type ExternalSafeLegacyInput = {
  projectId: string;
  actorId: string;
  type: NotificationType;
  sourceKey: string;
  sourceId: string;
  excludeUserId?: string;
  now?: number;
};

export type ExternalSubtaskNotificationInput = {
  projectId: string;
  actorId: string;
  assigneeId: string;
  subtaskId: string;
  assignmentVersion: number;
  sourceKey: string;
  kind: "assigned" | "due_today";
  dueDate?: string;
  claimAt?: number;
  now?: number;
};

type InsertedOutbox = { id: string };

async function insertLedgers(db: D1Database, outboxIds: readonly string[], channels: readonly ("in_app" | "email")[], now: number): Promise<void> {
  if (!outboxIds.length) return;
  const statements: D1PreparedStatement[] = [];
  for (const outboxId of outboxIds) {
    for (const channel of channels) {
      statements.push(db.prepare(`
        INSERT INTO notification_delivery_ledger
          (id, outbox_id, event_type, source_key, recipient_id, channel, status, created_at, updated_at)
        SELECT ${uuidSql()}, id, event_type, source_key, recipient_id, ?, 'pending', ?, ?
        FROM notification_outbox
        WHERE id = ? AND status = 'pending'
        ON CONFLICT(outbox_id, channel) DO NOTHING
      `).bind(channel, now, now, outboxId));
    }
  }
  await db.batch(statements);
}

/**
 * The only producer for the allowed legacy direct workflow signals. It writes a strict
 * external-safe envelope, selects the epoch in the same INSERT ... SELECT, and never creates
 * an External row through the legacy notifications table.
 */
export async function emitExternalSafeLegacyNotification(db: D1Database, input: ExternalSafeLegacyInput): Promise<string[]> {
  const policy = EXTERNAL_LEGACY_NOTIFICATION_POLICY[input.type];
  if (policy.decision !== "allowed" || policy.durableEvent !== EXTERNAL_NOTIFICATION_OUTBOX_EVENT_TYPES.projectSafeDirect || !input.sourceKey || !input.sourceId) return [];
  const now = input.now ?? Date.now();
  const copy = externalNotificationCopy({ type: input.type });
  const rows = await db.prepare(`
    INSERT INTO notification_outbox (
      id, schema_version, event_type, source_key, project_id, actor_id, recipient_id,
      recipient_authorization_epoch, payload_json, status, available_at,
      recipient_membership_cycle_id, created_at, updated_at
    )
    SELECT ${uuidSql()}, 1, ?, ?, p.id, ?, recipient.id,
      recipient.authorization_epoch,
      json_object(
        'schemaVersion', 1,
        'event', json_object('type', ?, 'sourceKey', ?, 'recipientId', recipient.id),
        'authorizationAtOccurrence', json_object('kind', 'project_editor_membership', 'membershipCycle', member.id, 'startedAt', member.created_at),
        'legacy', json_object('type', ?, 'projectId', p.id, 'sourceId', ?)
      ), 'pending', ?, member.id, ?, ?
    FROM projects p
    INNER JOIN project_members member ON member.project_id = p.id AND member.role_on_project = 'editor'
    INNER JOIN user recipient ON recipient.id = member.user_id
    WHERE p.id = ? AND p.archived_at IS NULL
      AND recipient.active = 1 AND recipient.role = 'external_editor'
      AND (? IS NULL OR recipient.id <> ?)
    ON CONFLICT(event_type, source_key, recipient_id) DO NOTHING
    RETURNING id
  `).bind(
    policy.durableEvent, input.sourceKey, input.actorId,
    policy.durableEvent, input.sourceKey, input.type, input.projectId, input.sourceId,
    now, now, now, input.projectId, input.excludeUserId ?? null, input.excludeUserId ?? null,
  ).all<InsertedOutbox>();
  const outboxIds = rows.results.map((row) => row.id);
  await insertLedgers(db, outboxIds, externalNotificationChannels(input.type), now);
  void copy;
  return outboxIds;
}

/** Durable replacement for the old direct checklist-assignment/due emitters. */
export async function emitExternalSubtaskNotification(db: D1Database, input: ExternalSubtaskNotificationInput): Promise<string[]> {
  const eventType = input.kind === "assigned"
    ? EXTERNAL_NOTIFICATION_OUTBOX_EVENT_TYPES.subtaskAssigned
    : EXTERNAL_NOTIFICATION_OUTBOX_EVENT_TYPES.subtaskDueToday;
  const policyType: NotificationType = input.kind === "assigned" ? "subtask_assigned" : "subtask_due_today";
  const now = input.now ?? Date.now();
  const dueCondition = input.kind === "due_today" ? "AND s.due_date = ? AND s.due_reminder_sent_at = ?" : "";
  const dueBindings = input.kind === "due_today" ? [input.dueDate ?? null, input.claimAt ?? null] : [];
  const payloadDue = input.kind === "due_today"
    ? `, 'dueDate', s.due_date, 'claimAt', s.due_reminder_sent_at`
    : "";
  const rows = await db.prepare(`
    INSERT INTO notification_outbox (
      id, schema_version, event_type, source_key, project_id, actor_id, recipient_id,
      recipient_authorization_epoch, payload_json, status, available_at,
      recipient_membership_cycle_id, created_at, updated_at
    )
    SELECT ${uuidSql()}, 1, ?, ?, p.id, ?, recipient.id, recipient.authorization_epoch,
      json_object(
        'schemaVersion', 1,
        'event', json_object('type', ?, 'sourceKey', ?, 'recipientId', recipient.id),
        'authorizationAtOccurrence', json_object('kind', 'project_editor_membership', 'membershipCycle', member.id, 'startedAt', member.created_at),
        'assignment', json_object('projectId', p.id, 'subtaskId', s.id, 'assigneeId', s.assignee_id, 'assignmentVersion', s.assignment_version${payloadDue})
      ), 'pending', ?, member.id, ?, ?
    FROM project_subtasks s
    INNER JOIN projects p ON p.id = s.project_id AND p.archived_at IS NULL
    INNER JOIN project_members member ON member.project_id = p.id AND member.user_id = s.assignee_id AND member.role_on_project = 'editor'
    INNER JOIN user recipient ON recipient.id = s.assignee_id
    WHERE s.id = ? AND s.project_id = ? AND s.assignee_id = ? AND s.assignment_version = ? AND s.done = 0
      AND recipient.active = 1 AND recipient.role = 'external_editor'
      ${dueCondition}
    ON CONFLICT(event_type, source_key, recipient_id) DO NOTHING
    RETURNING id
  `).bind(
    eventType, input.sourceKey, input.actorId, eventType, input.sourceKey, now, now, now,
    input.subtaskId, input.projectId, input.assigneeId, input.assignmentVersion, ...dueBindings,
  ).all<InsertedOutbox>();
  const outboxIds = rows.results.map((row) => row.id);
  await insertLedgers(db, outboxIds, externalNotificationChannels(policyType), now);
  return outboxIds;
}
