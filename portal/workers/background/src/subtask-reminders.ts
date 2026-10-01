import {
  NOTIFICATION_OUTBOX_EVENT_TYPES,
  PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID,
  publishNotificationOutbox,
} from "@quincy/shared";
import { buildSubtaskReminderMaterialization } from "@quincy/db";
import type { Env } from "./env";
import { sqlUuidV4 } from "./project-deadline";

/**
 * Subtask reminders fire (#424, ADR 0016). `scanSubtaskReminderOccurrences` is the Subtask counterpart of
 * `scanProjectDeadlineOccurrences`: one batch per due occurrence claims it, writes one outbox row per CURRENT assignee and their
 * ledger rows, and otherwise supersedes an occurrence that can no longer fire. Who gets a reminder is decided here, at fire time,
 * from the assignee relation, so an assignment added before the fire time is covered and a removed one is not.
 */
export const SUBTASK_REMINDER_SCAN_LIMIT = 100;

type DueSubtaskOccurrence = {
  id: string;
  subtaskId: string;
  projectId: string;
  scheduleVersion: number;
  kind: "advance" | "due_now";
  fireAt: number;
  dueAt: number;
};

/** The eligibility `emitStaffSubtaskAssignedNotification` and the external emitter checked, written once as SQL for the fire-time INSERT. */
const EXTERNAL_CYCLE_ID = `(SELECT member.id FROM project_members member
  WHERE member.project_id = occurrence.project_id AND member.user_id = recipient.id AND member.role_on_project = 'editor'
  ORDER BY member.created_at DESC, member.id LIMIT 1)`;
const EXTERNAL_CYCLE_STARTED_AT = `(SELECT member.created_at FROM project_members member
  WHERE member.project_id = occurrence.project_id AND member.user_id = recipient.id AND member.role_on_project = 'editor'
  ORDER BY member.created_at DESC, member.id LIMIT 1)`;
const RECIPIENT_ELIGIBLE = `recipient.active = 1 AND (
  (recipient.role = 'external_editor' AND ${EXTERNAL_CYCLE_ID} IS NOT NULL)
  OR (recipient.role <> 'external_editor' AND (recipient.role = 'admin' OR EXISTS (
    SELECT 1 FROM project_members member WHERE member.project_id = occurrence.project_id AND member.user_id = recipient.id
  )))
)`;

function payloadJsonSql(): string {
  return `json_object(
    'schemaVersion', 1,
    'event', json_object('type', 'project.subtask.reminder', 'sourceKey', 'subtask-reminder:' || occurrence.subtask_id || ':' || occurrence.id, 'recipientId', recipient.id),
    'authorizationAtOccurrence', json_object('kind', 'subtask_assignment', 'assignmentVersion', assignee.assignment_version,
      'membershipCycle', CASE WHEN recipient.role = 'external_editor' THEN ${EXTERNAL_CYCLE_ID} ELSE NULL END,
      'startedAt', CASE WHEN recipient.role = 'external_editor' THEN ${EXTERNAL_CYCLE_STARTED_AT} ELSE NULL END),
    'reminder', json_object(
      'occurrenceId', occurrence.id, 'projectId', occurrence.project_id, 'subtaskId', occurrence.subtask_id,
      'scheduleVersion', occurrence.schedule_version, 'kind', occurrence.kind,
      'offsetMinutes', occurrence.reminder_offset_minutes,
      'dueAt', strftime('%Y-%m-%dT%H:%M:%fZ', occurrence.due_at / 1000.0, 'unixepoch'),
      'dueLocalCivil', occurrence.due_local_civil, 'zone', occurrence.due_zone,
      'utcOffsetMinutes', occurrence.due_utc_offset_minutes, 'fold', occurrence.due_fold
    )
  )`;
}

export async function fireSubtaskReminderOccurrence(env: Env, occurrence: DueSubtaskOccurrence, now: number): Promise<{ claimed: boolean; publicationIds: string[] }> {
  const fireAuditId = crypto.randomUUID();
  const sourceKey = `subtask-reminder:${occurrence.subtaskId}:${occurrence.id}`;
  const eventType = NOTIFICATION_OUTBOX_EVENT_TYPES.subtaskReminder;
  const statements = [
    // 1. Claim. Every condition is re-read from the Subtask and Project at this instant, so an edit that landed since the scan wins.
    env.DB.prepare(`
      UPDATE project_subtask_reminder_occurrences
      SET status = 'fired', fired_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND fire_at <= ?
        AND (kind = 'due_now' OR due_at > ?)
        AND EXISTS (
          SELECT 1 FROM project_subtasks s
          JOIN projects p ON p.id = s.project_id
          WHERE s.id = project_subtask_reminder_occurrences.subtask_id
            AND s.project_id = project_subtask_reminder_occurrences.project_id
            AND s.done = 0 AND s.due_reminder_sent_at IS NULL
            AND s.schedule_version = project_subtask_reminder_occurrences.schedule_version
            AND s.schedule_end_at = project_subtask_reminder_occurrences.due_at
            AND p.archived_at IS NULL
        )
      RETURNING id
    `).bind(now, now, occurrence.id, now, now),
    // 2. Audit marker, written only when the claim won.
    env.DB.prepare(`
      INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?, NULL, 'project.subtask.reminder_fired', 'project_subtask_reminder_occurrence', ?, NULL, ?
      WHERE changes() = 1 RETURNING id
    `).bind(fireAuditId, occurrence.id, now),
    // 3. One outbox row per current, eligible assignee. An unassigned Subtask consumes the occurrence and writes none.
    env.DB.prepare(`
      INSERT INTO notification_outbox
        (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id,
         recipient_authorization_epoch, payload_json, status, available_at, publish_attempts, delivery_attempts,
         recipient_membership_cycle_id, created_at, updated_at)
      SELECT ${sqlUuidV4()}, 1, ?, 'subtask-reminder:' || occurrence.subtask_id || ':' || occurrence.id, occurrence.project_id, ?,
        recipient.id, recipient.authorization_epoch, ${payloadJsonSql()}, 'pending', ?, 0, 0,
        CASE WHEN recipient.role = 'external_editor' THEN ${EXTERNAL_CYCLE_ID} ELSE NULL END, ?, ?
      FROM project_subtask_reminder_occurrences occurrence
      JOIN project_subtasks s ON s.id = occurrence.subtask_id
      JOIN projects p ON p.id = occurrence.project_id
      JOIN project_subtask_assignees assignee ON assignee.subtask_id = occurrence.subtask_id
      JOIN user recipient ON recipient.id = assignee.user_id
      WHERE occurrence.id = ? AND occurrence.status = 'fired' AND occurrence.fired_at = ?
        AND s.schedule_version = occurrence.schedule_version AND s.schedule_end_at = occurrence.due_at
        AND s.done = 0 AND p.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
        AND ${RECIPIENT_ELIGIBLE}
      ON CONFLICT(event_type, source_key, recipient_id) DO NOTHING
      RETURNING id
    `).bind(eventType, PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID, now, now, now, occurrence.id, now, fireAuditId),
    // 4. In-app and email ledger rows for the rows just written.
    env.DB.prepare(`
      INSERT INTO notification_delivery_ledger
        (id, outbox_id, event_type, source_key, recipient_id, channel, status, attempts, created_at, updated_at)
      SELECT ${sqlUuidV4()}, o.id, o.event_type, o.source_key, o.recipient_id, channel.value, 'pending', 0, ?, ?
      FROM notification_outbox o
      JOIN (SELECT 'in_app' AS value UNION ALL SELECT 'email') channel
      WHERE o.event_type = ? AND o.source_key = ? AND o.project_id = ? AND o.status = 'pending'
        AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
        AND EXISTS (
          SELECT 1 FROM project_subtask_reminder_occurrences occurrence
          WHERE occurrence.id = ? AND occurrence.status = 'fired' AND occurrence.fired_at = ?
        )
      ON CONFLICT(outbox_id, channel) DO NOTHING
      RETURNING id
    `).bind(now, now, eventType, sourceKey, occurrence.projectId, fireAuditId, occurrence.id, now),
    // 5. A pending occurrence that can no longer fire is closed with the reason it can not.
    env.DB.prepare(`
      UPDATE project_subtask_reminder_occurrences
      SET status = 'superseded', terminal_reason = (
        SELECT CASE
          WHEN p.archived_at IS NOT NULL THEN 'project_archived'
          WHEN s.done = 1 THEN 'subtask_completed'
          WHEN s.schedule_version <> project_subtask_reminder_occurrences.schedule_version
            OR s.schedule_end_at IS NOT project_subtask_reminder_occurrences.due_at THEN 'schedule_replaced'
          WHEN s.due_reminder_sent_at IS NOT NULL THEN 'legacy_due_today_sent'
          ELSE 'due_elapsed'
        END
        FROM project_subtasks s JOIN projects p ON p.id = s.project_id
        WHERE s.id = project_subtask_reminder_occurrences.subtask_id
      ), fired_at = NULL, updated_at = ?
      WHERE project_subtask_reminder_occurrences.id = ?
        AND project_subtask_reminder_occurrences.status = 'pending'
        AND project_subtask_reminder_occurrences.fire_at <= ?
        AND NOT EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
        AND EXISTS (SELECT 1 FROM project_subtasks s WHERE s.id = project_subtask_reminder_occurrences.subtask_id)
    `).bind(now, occurrence.id, now, fireAuditId),
  ];
  const results = await env.DB.batch(statements);
  const marker = results[1]?.results?.[0] as { id?: string } | undefined;
  if (!marker || marker.id !== fireAuditId) return { claimed: false, publicationIds: [] };
  const publicationIds = ((results[2]?.results ?? []) as Array<{ id?: string }>).flatMap((row) => row.id ? [row.id] : []);
  if (publicationIds.length) await publishNotificationOutbox(env.NOTIFICATION_QUEUE, env.DB, publicationIds, now);
  console.log("Fired Subtask reminder occurrence", {
    occurrenceId: occurrence.id,
    subtaskId: occurrence.subtaskId,
    projectId: occurrence.projectId,
    kind: occurrence.kind,
    fireAt: occurrence.fireAt,
    recipients: publicationIds.length,
  });
  return { claimed: true, publicationIds };
}

export async function scanSubtaskReminderOccurrences(env: Env, now = Date.now()): Promise<{ scanned: number; fired: number; published: number }> {
  const due = await env.DB.prepare(`
    SELECT id, subtask_id AS subtaskId, project_id AS projectId, schedule_version AS scheduleVersion, kind,
      fire_at AS fireAt, due_at AS dueAt
    FROM project_subtask_reminder_occurrences
    WHERE status = 'pending' AND fire_at <= ?
    ORDER BY fire_at, subtask_id, id LIMIT ${SUBTASK_REMINDER_SCAN_LIMIT}
  `).bind(now).all<DueSubtaskOccurrence>();
  let fired = 0;
  let published = 0;
  for (const occurrence of due.results) {
    const result = await fireSubtaskReminderOccurrence(env, occurrence, now);
    if (result.claimed) fired += 1;
    published += result.publicationIds.length;
  }
  if (due.results.length === SUBTASK_REMINDER_SCAN_LIMIT) console.warn("Subtask reminder occurrence backlog limit reached", { limit: SUBTASK_REMINDER_SCAN_LIMIT });
  return { scanned: due.results.length, fired, published };
}

/**
 * The hourly reconcile. It replaces the retired 08:00 `scanDueSubtasks` pass: it inserts the occurrences a Subtask's current schedule
 * version still lacks, which heals a gap an old Worker left in the apply-then-deploy window. The eager paths in the API keep this at zero,
 * so a non-zero count is logged as a warning.
 */
export async function reconcileSubtaskReminderOccurrences(env: Env, now = Date.now()): Promise<{ inserted: number }> {
  const bundle = buildSubtaskReminderMaterialization({ db: env.DB, scope: { kind: "all" }, now, createdBy: null });
  const results = await env.DB.batch(bundle.statements);
  const inserted = results[bundle.indexes.materialize]?.meta?.changes ?? 0;
  if (inserted > 0) console.warn("Subtask reminder reconcile inserted missing occurrences", { inserted });
  else console.log("Subtask reminder reconcile", { inserted });
  return { inserted };
}
