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

/**
 * The two notification types #114's row grid tones with `text-warning` (never
 * `text-signal-caution` directly, never `bg-warning` — see `design-system-guards.test.ts`'s
 * caution-token guard): a stalled AutoHDR job and an approaching project deadline are both
 * "this needs attention before it becomes a problem", distinct from the routine info types.
 */
export const NOTIFICATION_CAUTION_TYPES = ["autohdr_stalled", "project_deadline_reminder"] as const;

export function isCautionNotificationType(type: string): boolean {
  return (NOTIFICATION_CAUTION_TYPES as readonly string[]).includes(type);
}
