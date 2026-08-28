export const NOTIFICATION_TYPES = [
  "raw_ready",
  "edited_landed",
  "sent_to_editing",
  "autohdr_stalled",
  "delivered",
  "comment_added",
  "assigned_to_project",
  "mentioned",
  "subtask_assigned",
  "subtask_due_today",
  "project_deadline_reminder",
  "project_activity",
  "project_collaboration_activity",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
