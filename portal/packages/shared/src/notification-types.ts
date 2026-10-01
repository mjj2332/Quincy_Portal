import type { WorkspaceTab } from "./workspace-tab";

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
  "subtask_reminder",
  "project_deadline_reminder",
  "project_activity",
  "project_collaboration_activity",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * #337: the Workspace tab a Project notification opens on. An exhaustive `Record` over the
 * declared union, so adding a type without a mapping fails the typecheck (and the key-parity test
 * in `notification-types.test.ts` fails at runtime).
 */
export const NOTIFICATION_WORKSPACE_TAB: Readonly<Record<NotificationType, WorkspaceTab>> = Object.freeze({
  raw_ready: "raw",
  sent_to_editing: "raw",
  autohdr_stalled: "raw",
  edited_landed: "edited",
  delivered: "edited",
  comment_added: "collaboration",
  assigned_to_project: "collaboration",
  mentioned: "collaboration",
  subtask_assigned: "collaboration",
  subtask_due_today: "collaboration",
  subtask_reminder: "collaboration",
  project_deadline_reminder: "collaboration",
  project_activity: "collaboration",
  project_collaboration_activity: "collaboration",
});

/** The mapped tab for a stored notification type, or undefined for one the app no longer declares
 * (`notifications.type` is free text). Own keys only, so `toString`/`__proto__` never match. */
export function notificationWorkspaceTab(type: string): WorkspaceTab | undefined {
  return Object.hasOwn(NOTIFICATION_WORKSPACE_TAB, type) ? NOTIFICATION_WORKSPACE_TAB[type as NotificationType] : undefined;
}

/**
 * The notification types #114's row grid tones with `text-warning` (never
 * `text-signal-caution` directly, never `bg-warning` — see `design-system-guards.test.ts`'s
 * caution-token guard): a stalled AutoHDR job, an approaching project deadline and an approaching
 * Subtask due (#424) are all "this needs attention before it becomes a problem", distinct from the
 * routine info types.
 */
export const NOTIFICATION_CAUTION_TYPES = ["autohdr_stalled", "project_deadline_reminder", "subtask_reminder"] as const;

export function isCautionNotificationType(type: string): boolean {
  return (NOTIFICATION_CAUTION_TYPES as readonly string[]).includes(type);
}
