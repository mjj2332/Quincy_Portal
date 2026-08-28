import { EXTERNAL_LEGACY_NOTIFICATION_POLICY, EXTERNAL_PROJECT_ACTIVITY_POLICY } from "@quincy/shared";

const legacyTypes = Object.entries(EXTERNAL_LEGACY_NOTIFICATION_POLICY)
  .filter(([, policy]) => policy.decision === "allowed")
  .map(([type]) => type);
const directLegacyTypes = Object.entries(EXTERNAL_LEGACY_NOTIFICATION_POLICY)
  .filter(([, policy]) => policy.decision === "allowed" && policy.durableEvent === "project.external_safe.direct")
  .map(([type]) => type);
const activityTypes = Object.entries(EXTERNAL_PROJECT_ACTIVITY_POLICY)
  .filter(([, policy]) => policy.decision === "allowed")
  .map(([type]) => type);

const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(",");

/**
 * The single authorization predicate used by list, count, and all notification mutations.
 * Callers put it inside the same CTE shape so a hidden row is indistinguishable from an absent ID.
 */
export function externalVisibleNotificationWhere(principalId: string, alias = "n") {
  return {
    sql: `${alias}.user_id = ?
      AND ${alias}.project_id IS NOT NULL
      AND ${alias}.type IN (${placeholders(legacyTypes)})
      AND EXISTS (
        SELECT 1
        FROM projects p
        INNER JOIN project_members pm ON pm.project_id = p.id
          AND pm.user_id = ${alias}.user_id AND pm.role_on_project = 'editor'
        INNER JOIN user u ON u.id = ${alias}.user_id
        INNER JOIN notification_delivery_ledger l ON l.notification_id = ${alias}.id
          AND l.recipient_id = ${alias}.user_id AND l.channel = 'in_app' AND l.status = 'sent'
        INNER JOIN notification_outbox o ON o.id = l.outbox_id
          AND o.recipient_id = ${alias}.user_id AND o.project_id = ${alias}.project_id
          AND o.source_key = ${alias}.source_key
          AND o.recipient_authorization_epoch = u.authorization_epoch
        WHERE p.id = ${alias}.project_id AND p.archived_at IS NULL
          AND u.active = 1 AND u.role = 'external_editor'
          AND json_valid(o.payload_json) = 1
          AND json_extract(o.payload_json, '$.schemaVersion') = 1
          AND (
            (
              o.event_type = 'project.activity.broad'
              AND ${alias}.type IN ('project_activity', 'project_collaboration_activity')
              AND json_valid(o.payload_json) = 1
              AND json_extract(o.payload_json, '$.schemaVersion') = 1
              AND json_extract(o.payload_json, '$.event.type') = 'project.activity.broad'
              AND json_extract(o.payload_json, '$.event.sourceKey') = o.source_key
              AND json_extract(o.payload_json, '$.event.recipientId') = o.recipient_id
              AND json_extract(o.payload_json, '$.authorizationAtOccurrence.kind') = 'project_editor_membership'
              AND o.recipient_membership_cycle_id = pm.id
              AND json_extract(o.payload_json, '$.authorizationAtOccurrence.membershipCycle') = pm.id
              AND json_extract(o.payload_json, '$.authorizationAtOccurrence.startedAt') = pm.created_at
              AND EXISTS (
                SELECT 1 FROM project_activity_events activity
                WHERE activity.id = json_extract(o.payload_json, '$.activity.id')
                  AND activity.project_id = o.project_id
                  AND activity.schema_version = 1
                  AND activity.event_type IN (${placeholders(activityTypes)})
                  AND json_extract(o.payload_json, '$.activity.projectId') = activity.project_id
              )
            )
            OR (
              o.event_type = 'project.external_safe.direct'
              AND ${alias}.type IN (${placeholders(directLegacyTypes)})
              AND json_valid(o.payload_json) = 1
              AND json_extract(o.payload_json, '$.schemaVersion') = 1
              AND json_extract(o.payload_json, '$.event.type') = 'project.external_safe.direct'
              AND json_extract(o.payload_json, '$.event.sourceKey') = o.source_key
              AND json_extract(o.payload_json, '$.event.recipientId') = o.recipient_id
              AND json_extract(o.payload_json, '$.authorizationAtOccurrence.kind') = 'project_editor_membership'
              AND o.recipient_membership_cycle_id = pm.id
              AND json_extract(o.payload_json, '$.authorizationAtOccurrence.membershipCycle') = pm.id
              AND json_extract(o.payload_json, '$.authorizationAtOccurrence.startedAt') = pm.created_at
              AND json_extract(o.payload_json, '$.legacy.type') = ${alias}.type
              AND json_extract(o.payload_json, '$.legacy.projectId') = o.project_id
              AND json_type(o.payload_json, '$.legacy.sourceId') = 'text'
              AND length(json_extract(o.payload_json, '$.legacy.sourceId')) > 0
            )
            OR (
              o.event_type = 'project.assignment.created'
              AND ${alias}.type = 'assigned_to_project'
              AND json_valid(o.payload_json) = 1
              AND json_extract(o.payload_json, '$.schemaVersion') = 1
              AND json_extract(o.payload_json, '$.event.type') = 'project.assignment.created'
              AND json_extract(o.payload_json, '$.event.sourceKey') = o.source_key
              AND json_extract(o.payload_json, '$.event.recipientId') = o.recipient_id
              AND json_extract(o.payload_json, '$.assignment.projectId') = o.project_id
              AND json_extract(o.payload_json, '$.assignment.userId') = o.recipient_id
              AND json_extract(o.payload_json, '$.assignment.roleOnProject') = 'editor'
              AND o.source_key = pm.id
              AND json_extract(o.payload_json, '$.assignment.membershipCycle') = pm.id
            )
            OR (
              o.event_type = 'project.comment.mentioned'
              AND ${alias}.type = 'mentioned'
              AND json_valid(o.payload_json) = 1
              AND json_extract(o.payload_json, '$.schemaVersion') = 1
              AND json_extract(o.payload_json, '$.event.type') = 'project.comment.mentioned'
              AND json_extract(o.payload_json, '$.event.sourceKey') = o.source_key
              AND json_extract(o.payload_json, '$.event.recipientId') = o.recipient_id
              AND json_extract(o.payload_json, '$.authorizationAtOccurrence.kind') = 'project_member'
              AND EXISTS (
                SELECT 1 FROM project_comment_mentions mention
                WHERE mention.id = o.source_key AND mention.mentioned_user_id = ${alias}.user_id
                  AND mention.comment_id = json_extract(o.payload_json, '$.projectCommentActivity.activity.safePayload.commentId')
                  AND json_extract(o.payload_json, '$.projectCommentActivity.activity.projectId') = o.project_id
                  AND EXISTS (
                    SELECT 1 FROM project_comments comment
                    WHERE comment.id = mention.comment_id AND comment.project_id = o.project_id
                  )
                  AND EXISTS (SELECT 1 FROM json_each(o.payload_json, '$.authorizationAtOccurrence.membershipIds') cycle WHERE cycle.value = pm.id)
              )
            )
            OR (
              o.event_type = 'project.deadline.reminder'
              AND ${alias}.type = 'project_deadline_reminder'
              AND json_valid(o.payload_json) = 1
              AND json_extract(o.payload_json, '$.schemaVersion') = 1
              AND json_extract(o.payload_json, '$.event.type') = 'project.deadline.reminder'
              AND json_extract(o.payload_json, '$.event.sourceKey') = o.source_key
              AND json_extract(o.payload_json, '$.event.recipientId') = o.recipient_id
              AND json_extract(o.payload_json, '$.authorizationAtOccurrence.kind') = 'project_editor_membership'
              AND o.recipient_membership_cycle_id = pm.id
              AND json_extract(o.payload_json, '$.authorizationAtOccurrence.membershipCycle') = pm.id
              AND json_extract(o.payload_json, '$.authorizationAtOccurrence.startedAt') = pm.created_at
              AND json_extract(o.payload_json, '$.reminder.occurrenceId') = o.source_key
              AND json_extract(o.payload_json, '$.reminder.projectId') = o.project_id
              AND EXISTS (
                SELECT 1 FROM project_deadline_occurrences occurrence
                WHERE occurrence.id = o.source_key AND occurrence.project_id = o.project_id
              )
            )
            OR (
              ((o.event_type = 'project.subtask.assigned' AND ${alias}.type = 'subtask_assigned')
                OR (o.event_type = 'project.subtask.due_today' AND ${alias}.type = 'subtask_due_today'))
              AND json_valid(o.payload_json) = 1
              AND json_extract(o.payload_json, '$.schemaVersion') = 1
              AND json_extract(o.payload_json, '$.event.type') = o.event_type
              AND json_extract(o.payload_json, '$.event.sourceKey') = o.source_key
              AND json_extract(o.payload_json, '$.event.recipientId') = o.recipient_id
              AND json_extract(o.payload_json, '$.authorizationAtOccurrence.kind') = 'project_editor_membership'
              AND o.recipient_membership_cycle_id = pm.id
              AND json_extract(o.payload_json, '$.authorizationAtOccurrence.membershipCycle') = pm.id
              AND json_extract(o.payload_json, '$.authorizationAtOccurrence.startedAt') = pm.created_at
              AND json_extract(o.payload_json, '$.assignment.assigneeId') = ${alias}.user_id
              AND json_extract(o.payload_json, '$.assignment.projectId') = o.project_id
              AND EXISTS (
                SELECT 1 FROM project_subtasks subtask
                WHERE subtask.id = json_extract(o.payload_json, '$.assignment.subtaskId')
                  AND subtask.project_id = o.project_id
                  AND subtask.assignee_id = o.recipient_id
                  AND subtask.assignment_version = json_extract(o.payload_json, '$.assignment.assignmentVersion')
                  AND subtask.done = 0
                  AND (o.event_type <> 'project.subtask.due_today'
                    OR (subtask.due_date = json_extract(o.payload_json, '$.assignment.dueDate')
                      AND subtask.due_reminder_sent_at = json_extract(o.payload_json, '$.assignment.claimAt')))
              )
            )
          )
      )`,
    bindings: [principalId, ...legacyTypes, ...activityTypes, ...directLegacyTypes],
  };
}

export function externalVisibleNotificationCte(principalId: string) {
  const where = externalVisibleNotificationWhere(principalId);
  return {
    sql: `WITH external_visible_notifications AS (SELECT n.id FROM notifications n WHERE ${where.sql})`,
    bindings: where.bindings,
  };
}
