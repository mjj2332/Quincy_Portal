import {
  NOTIFICATION_OUTBOX_EVENT_TYPES,
  PROJECT_ASSIGNMENT_ELIGIBLE_ROLES,
} from "@quincy/shared";
import type { Env } from "./env";
import { publishNotificationOutbox } from "@quincy/shared";

export const PROJECT_DEADLINE_SCAN_LIMIT = 100;

type DueOccurrence = {
  id: string;
  projectId: string;
  scheduleVersion: number;
  kind: "advance" | "due_now";
  reminderOffsetMinutes: number;
  fireAt: number;
  deadlineAt: number;
  deadlineLocalCivil: string;
  deadlineUtcOffsetMinutes: number;
  deadlineFold: number;
  createdAt: number;
  createdBy: string;
};

function sqlUuidV4(): string {
  return "lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))";
}

function payloadJsonSql(): string {
  return `json_object(
    'schemaVersion', 1,
    'event', json_object('type', 'project.deadline.reminder', 'sourceKey', occurrence.id, 'recipientId', recipient.id),
    'authorizationAtOccurrence', json_object('kind', 'project_editor_membership', 'membershipCycle', member.id, 'startedAt', member.created_at),
    'reminder', json_object(
      'occurrenceId', occurrence.id, 'projectId', occurrence.project_id,
      'scheduleVersion', occurrence.schedule_version, 'kind', occurrence.kind,
      'offsetMinutes', occurrence.reminder_offset_minutes,
      'deadlineAt', strftime('%Y-%m-%dT%H:%M:%fZ', occurrence.deadline_at / 1000.0, 'unixepoch'),
      'deadlineLocalCivil', occurrence.deadline_local_civil, 'zone', occurrence.deadline_zone,
      'utcOffsetMinutes', occurrence.deadline_utc_offset_minutes, 'fold', occurrence.deadline_fold
    )
  )`;
}

export async function fireProjectDeadlineOccurrence(env: Env, occurrence: DueOccurrence, now: number): Promise<{ claimed: boolean; publicationIds: string[] }> {
  const fireAuditId = crypto.randomUUID();
  const eligibleRoles = PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor;
  const rolePlaceholders = eligibleRoles.map(() => "?").join(",");
  const payload = payloadJsonSql();
  const outboxIdExpression = sqlUuidV4();
  const statements = [
    env.DB.prepare(`
      UPDATE project_deadline_occurrences
      SET status = 'fired', fired_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND fire_at <= ?
        AND EXISTS (
          SELECT 1 FROM projects p
          WHERE p.id = project_deadline_occurrences.project_id
            AND p.deadline_version = project_deadline_occurrences.schedule_version
            AND p.deadline_at IS NOT NULL AND p.archived_at IS NULL
            AND p.stage_key <> 'delivered'
        )
      RETURNING id
    `).bind(now, now, occurrence.id, now),
    env.DB.prepare(`
      INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?, NULL, 'project.deadline.occurrence_fired', 'project_deadline_occurrence', ?, NULL, ?
      WHERE changes() = 1 RETURNING id
    `).bind(fireAuditId, occurrence.id, now),
    env.DB.prepare(`
      INSERT INTO notification_outbox
        (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id,
         payload_json, status, available_at, publish_attempts, delivery_attempts, created_at, updated_at)
      SELECT ${outboxIdExpression}, 1, ?, occurrence.id, occurrence.project_id, occurrence.created_by,
        recipient.id, ${payload}, 'pending', ?, 0, 0, ?, ?
      FROM project_deadline_occurrences occurrence
      INNER JOIN projects p ON p.id = occurrence.project_id
      INNER JOIN project_members member ON member.project_id = occurrence.project_id
        AND member.role_on_project = 'editor' AND member.created_at <= occurrence.fired_at
      INNER JOIN user recipient ON recipient.id = member.user_id
      WHERE occurrence.id = ? AND occurrence.status = 'fired' AND occurrence.fired_at = ?
        AND occurrence.schedule_version = ?
        AND p.deadline_version = occurrence.schedule_version
        AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
        AND recipient.active = 1 AND recipient.role IN (${rolePlaceholders})
      RETURNING id
    `).bind(NOTIFICATION_OUTBOX_EVENT_TYPES.projectDeadlineReminder, now, now, now, occurrence.id, now, occurrence.scheduleVersion, fireAuditId, ...eligibleRoles),
    env.DB.prepare(`
      INSERT INTO notification_delivery_ledger
        (id, outbox_id, event_type, source_key, recipient_id, channel, status,
         attempts, created_at, updated_at)
      SELECT ${sqlUuidV4()}, o.id, o.event_type, o.source_key, o.recipient_id, channel.value, 'pending', 0, ?, ?
      FROM notification_outbox o
      JOIN (SELECT 'in_app' AS value UNION ALL SELECT 'email') channel
      WHERE o.event_type = ? AND o.source_key = ? AND o.project_id = ?
        AND o.status = 'pending'
        AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
        AND EXISTS (
          SELECT 1 FROM project_deadline_occurrences occurrence
          WHERE occurrence.id = o.source_key AND occurrence.status = 'fired' AND occurrence.fired_at = ?
            AND occurrence.schedule_version = ?
        )
      RETURNING id
    `).bind(now, now, NOTIFICATION_OUTBOX_EVENT_TYPES.projectDeadlineReminder, occurrence.id, occurrence.projectId, fireAuditId, now, occurrence.scheduleVersion),
    env.DB.prepare(`
      UPDATE project_deadline_occurrences
      SET status = 'superseded', terminal_reason = (
        SELECT CASE
          WHEN p.archived_at IS NOT NULL THEN 'project_archived'
          WHEN p.stage_key = 'delivered' THEN 'project_delivered'
          WHEN p.deadline_at IS NULL THEN 'deadline_cleared'
          WHEN p.deadline_version <> project_deadline_occurrences.schedule_version THEN 'schedule_replaced'
        END FROM projects p WHERE p.id = project_deadline_occurrences.project_id
      ), fired_at = NULL, updated_at = ?
      WHERE project_deadline_occurrences.id = ?
        AND project_deadline_occurrences.status = 'pending'
        AND project_deadline_occurrences.fire_at <= ?
        AND NOT EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
        AND EXISTS (
          SELECT 1 FROM projects p
          WHERE p.id = project_deadline_occurrences.project_id
            AND (p.archived_at IS NOT NULL OR p.stage_key = 'delivered' OR p.deadline_at IS NULL OR p.deadline_version <> project_deadline_occurrences.schedule_version)
        )
    `).bind(now, occurrence.id, now, fireAuditId),
  ];
  const results = await env.DB.batch(statements);
  const marker = results[1]?.results?.[0] as { id?: string } | undefined;
  if (!marker || marker.id !== fireAuditId) return { claimed: false, publicationIds: [] };
  const publicationIds = ((results[2]?.results ?? []) as Array<{ id?: string }>).flatMap((row) => row.id ? [row.id] : []);
  if (publicationIds.length) {
    await publishNotificationOutbox(env.NOTIFICATION_QUEUE, env.DB, publicationIds, now);
  }
  console.log("Fired project Deadline occurrence", {
    occurrenceId: occurrence.id,
    projectId: occurrence.projectId,
    fireAt: occurrence.fireAt,
    operationalMetricBasis: Math.max(occurrence.fireAt, occurrence.createdAt),
    recipients: publicationIds.length,
  });
  return { claimed: true, publicationIds };
}

export async function scanProjectDeadlineOccurrences(env: Env, now = Date.now()): Promise<{ scanned: number; fired: number; published: number }> {
  const due = await env.DB.prepare(`
    SELECT id, project_id AS projectId, schedule_version AS scheduleVersion, kind,
      reminder_offset_minutes AS reminderOffsetMinutes, fire_at AS fireAt,
      deadline_at AS deadlineAt, deadline_local_civil AS deadlineLocalCivil,
      deadline_utc_offset_minutes AS deadlineUtcOffsetMinutes, deadline_fold AS deadlineFold,
      created_at AS createdAt, created_by AS createdBy
    FROM project_deadline_occurrences
    WHERE status = 'pending' AND fire_at <= ?
    ORDER BY fire_at, project_id, id LIMIT ${PROJECT_DEADLINE_SCAN_LIMIT}
  `).bind(now).all<DueOccurrence>();
  let fired = 0;
  let published = 0;
  for (const occurrence of due.results) {
    const result = await fireProjectDeadlineOccurrence(env, occurrence, now);
    if (result.claimed) fired += 1;
    published += result.publicationIds.length;
  }
  if (due.results.length === PROJECT_DEADLINE_SCAN_LIMIT) console.warn("Project Deadline occurrence backlog limit reached", { limit: PROJECT_DEADLINE_SCAN_LIMIT });
  return { scanned: due.results.length, fired, published };
}

export { sqlUuidV4 };
