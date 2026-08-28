import {
  NOTIFICATION_OUTBOX_EVENT_TYPES,
  PROJECT_ACTIVITY_REGISTRY,
  PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID,
  PROJECT_ASSIGNMENT_ELIGIBLE_ROLES,
  parseProjectActivityIntent,
  projectActivityCoalesce,
  type ParsedProjectActivityIntent,
  type ProjectActivityIntent,
} from "@quincy/shared";

export type ProjectActivityStatementBundle = {
  statements: D1PreparedStatement[];
  activityIndex: number;
  broadOutboxIndex: number;
  broadLedgerIndex: number;
  intent: ParsedProjectActivityIntent;
};

type AppendProjectActivityInput = {
  db: D1Database;
  intent: ProjectActivityIntent | ParsedProjectActivityIntent;
  winnerAuditId: string;
  excludeRecipientId?: string;
  createdAt?: number;
  broadMode?: "emit" | "activity_only";
};

function uuidSql(): string {
  // D1/SQLite has no UUID function. Keep IDs UUID-shaped while retaining one SQL fan-out.
  return "lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-8' || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))";
}

function broadOutboxSql(coalesce: ReturnType<typeof projectActivityCoalesce>, roles: readonly string[], excludeRecipientId?: string, broadMode: "emit" | "activity_only" = "emit"): string {
  if (broadMode === "activity_only") return "SELECT id FROM notification_outbox WHERE 0";
  const exclude = excludeRecipientId === undefined ? "" : " AND recipient.id <> ?";
  const prior = coalesce
    ? `
      AND NOT EXISTS (
        SELECT 1 FROM notification_outbox previous
        WHERE previous.event_type = ?
          AND previous.recipient_id = member.user_id
          AND previous.recipient_membership_cycle_id = member.id
          AND previous.coalesce_key = ?
          AND previous.coalesce_until IS NOT NULL
          AND activity.occurred_at >= previous.coalesce_until - ?
          AND activity.occurred_at < previous.coalesce_until
      )`
    : "";
  return `
    INSERT INTO notification_outbox (
      id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, recipient_authorization_epoch,
      payload_json, status, available_at, coalesce_key, coalesce_until,
      recipient_membership_cycle_id, created_at, updated_at
    )
    SELECT ${uuidSql()}, 1, ?, activity.id, activity.project_id, ?, recipient.id, recipient.authorization_epoch,
      json_object(
        'schemaVersion', 1,
        'event', json_object('type', ?, 'sourceKey', activity.id, 'recipientId', member.user_id),
        'authorizationAtOccurrence', json_object('kind', 'project_editor_membership', 'membershipCycle', member.id, 'startedAt', member.created_at),
        'activity', json_object('id', activity.id, 'projectId', activity.project_id)
      ), 'pending', ?, ?, ?, member.id, ?, ?
    FROM project_activity_events activity
    JOIN project_members member ON member.project_id = activity.project_id
      AND member.role_on_project = 'editor'
      AND member.created_at <= activity.occurred_at
    JOIN user recipient ON recipient.id = member.user_id
    WHERE activity.id = ?
      AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
      AND recipient.active = 1
      AND recipient.role IN (${roles.map(() => "?").join(", ")})
      ${exclude}
      ${prior}
    ON CONFLICT(event_type, source_key, recipient_id) DO NOTHING
    RETURNING id
  `;
}

/**
 * Builds the activity insert, occurrence-time Editor fan-out, and in-app ledger statements.
 * It does not execute or publish: producers append these statements after their authoritative
 * mutation and adjacent audit marker, then publish returned outbox IDs after the D1 batch.
 */
export function buildProjectActivityStatements(input: AppendProjectActivityInput): ProjectActivityStatementBundle {
  const parsed = parseProjectActivityIntent(input.intent);
  if (!parsed) throw new Error("Invalid or reserved project activity intent");
  const { activity } = parsed;
  const createdAt = input.createdAt ?? Date.now();
  const actorId = activity.actorKind === "system" ? PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID : activity.actorId;
  const coalesce = projectActivityCoalesce(activity.type, activity.projectId, activity.actorId, activity.safePayload);
  const sourcePayload = JSON.stringify(activity.safePayload);
  const activityInsert = input.db.prepare(`
    INSERT INTO project_activity_events (
      id, schema_version, event_type, category, project_id, actor_kind, actor_id,
      occurred_at, source_kind, source_id, source_key, safe_payload_json,
      deep_link_kind, deep_link_path, created_at
    )
    SELECT ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
    ON CONFLICT(event_type, source_key) DO NOTHING
    RETURNING id
  `).bind(
    activity.id, activity.type, PROJECT_ACTIVITY_REGISTRY[activity.type].category, activity.projectId,
    activity.actorKind, activity.actorId, activity.occurredAt, activity.source.kind,
    activity.source.id, activity.source.key, sourcePayload, activity.deepLink.kind,
    activity.deepLink.path, createdAt, input.winnerAuditId,
  );
  const eligibleRoles = PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor;
  const broadBindings = input.broadMode === "activity_only" ? [] : [
    NOTIFICATION_OUTBOX_EVENT_TYPES.projectActivityBroad,
    actorId,
    NOTIFICATION_OUTBOX_EVENT_TYPES.projectActivityBroad,
    activity.occurredAt,
    coalesce?.key ?? null,
    coalesce ? activity.occurredAt + coalesce.windowSeconds * 1000 : null,
    createdAt,
    createdAt,
    activity.id,
    input.winnerAuditId,
    ...eligibleRoles,
    ...(input.excludeRecipientId === undefined ? [] : [input.excludeRecipientId]),
    ...(coalesce ? [NOTIFICATION_OUTBOX_EVENT_TYPES.projectActivityBroad, coalesce.key, 300_000] : []),
  ];
  const broadOutbox = input.db.prepare(broadOutboxSql(coalesce, eligibleRoles, input.excludeRecipientId, input.broadMode)).bind(...broadBindings);
  const ledger = input.db.prepare(`
    INSERT INTO notification_delivery_ledger (
      id, outbox_id, event_type, source_key, recipient_id, channel, status, created_at, updated_at
    )
    SELECT ${uuidSql()}, o.id, o.event_type, o.source_key, o.recipient_id, 'in_app', 'pending', ?, ?
    FROM notification_outbox o
    WHERE o.event_type = ? AND o.source_key = ? AND o.status = 'pending'
    ON CONFLICT(outbox_id, channel) DO NOTHING
  `).bind(createdAt, createdAt, NOTIFICATION_OUTBOX_EVENT_TYPES.projectActivityBroad, activity.id);
  return { statements: [activityInsert, broadOutbox, ledger], activityIndex: 0, broadOutboxIndex: 1, broadLedgerIndex: 2, intent: parsed };
}
