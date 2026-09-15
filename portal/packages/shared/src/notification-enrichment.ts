import { z } from "zod";
import type { NotificationType } from "./notification-types";

const uuid = z.string().uuid();
const isoString = z.string().min(1);

export const notificationActorSchema = z.object({ id: uuid, name: z.string().min(1) }).strict();

export const notificationSubjectSchema = z.object({
  kind: z.enum(["asset", "subtask", "project_comment", "notice_board_post"]),
  label: z.string().min(1),
}).strict();

// initials are computed in the web via the existing apps/web/src/lib/initials.ts — not carried
// in the payload.
export const staffNotificationListItemSchema = z.object({
  id: uuid,
  projectId: uuid.nullable(),
  // A plain string, like `externalNotificationListItemSchema`: the list must survive a stored
  // type this build no longer knows, not 500 on it. Unknown types simply enrich nothing.
  type: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  readAt: isoString.nullable(),
  createdAt: isoString,
  projectStreet: z.string().nullable(),
  coverAssetId: uuid.nullable(),
  actor: notificationActorSchema.nullable(),
  subject: notificationSubjectSchema.nullable(),
  assetId: uuid.nullable(),
}).strict();

export const staffNotificationListResponseSchema = z.object({
  notifications: z.array(staffNotificationListItemSchema),
  unreadCount: z.number().int().nonnegative(),
}).strict();

/** Server clamp for enriched bodies: comment/annotation/post text can run to ~10k chars. */
export const NOTIFICATION_BODY_MAX = 280;

export function clampNotificationBody(body: string): string {
  if (body.length <= NOTIFICATION_BODY_MAX) return body;
  return `${body.slice(0, NOTIFICATION_BODY_MAX - 1)}…`;
}

export type NotificationSource =
  | { kind: "annotation"; annotationId: string }
  | { kind: "project_comment_mention"; mentionId: string }
  | { kind: "notice_board_mention"; mentionId: string }
  | { kind: "subtask_assignment"; subtaskId: string; version: number }
  | { kind: "subtask_due"; subtaskId: string; dueDate: string }
  | { kind: "membership"; membershipId: string }
  | { kind: "ledger" }
  | { kind: "none" };

const UUID_PART = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const UUID_RE = new RegExp(`^${UUID_PART}$`);
const ANNOTATION_RE = new RegExp(`^annotation:(${UUID_PART})$`);
const SUBTASK_ASSIGNMENT_RE = new RegExp(`^subtask-assignment:(${UUID_PART}):(\\d+)$`);
const SUBTASK_DUE_RE = new RegExp(`^subtask-due:(${UUID_PART}):(\\d{4}-\\d{2}-\\d{2})$`);

/**
 * Pure and total: never throws, and an unknown or malformed sourceKey (or one belonging to a
 * type/projectId combination that doesn't apply) always degrades to `{ kind: "none" }` rather
 * than guessing. Anchored regexes so a source key can't be partially matched.
 */
export function parseNotificationSource(type: string, projectId: string | null, sourceKey: string | null): NotificationSource {
  switch (type as NotificationType) {
    case "comment_added": {
      if (!sourceKey) return { kind: "none" };
      const match = ANNOTATION_RE.exec(sourceKey);
      return match ? { kind: "annotation", annotationId: match[1]! } : { kind: "none" };
    }
    case "mentioned": {
      if (!sourceKey || !UUID_RE.test(sourceKey)) return { kind: "none" };
      return projectId ? { kind: "project_comment_mention", mentionId: sourceKey } : { kind: "notice_board_mention", mentionId: sourceKey };
    }
    case "subtask_assigned": {
      if (!sourceKey) return { kind: "none" };
      const match = SUBTASK_ASSIGNMENT_RE.exec(sourceKey);
      return match ? { kind: "subtask_assignment", subtaskId: match[1]!, version: Number(match[2]) } : { kind: "none" };
    }
    case "subtask_due_today": {
      if (!sourceKey) return { kind: "none" };
      const match = SUBTASK_DUE_RE.exec(sourceKey);
      return match ? { kind: "subtask_due", subtaskId: match[1]!, dueDate: match[2]! } : { kind: "none" };
    }
    case "assigned_to_project":
      return sourceKey && UUID_RE.test(sourceKey) ? { kind: "membership", membershipId: sourceKey } : { kind: "none" };
    case "project_activity":
    case "project_collaboration_activity":
      return { kind: "ledger" };
    default:
      return { kind: "none" };
  }
}

/**
 * Declares, per type, which read-time facts the resolver may fill in. This is a documentation +
 * enumeration table (see notification-enrichment.test.ts's enumeration test): the resolver's
 * actual per-type behaviour is implemented directly in workers/app/src/lib/notification-enrichment.ts,
 * including the runtime project-comment vs notice-board branch of `mentioned` that a single
 * declared `subject` kind can't represent.
 */
export const NOTIFICATION_ENRICHMENT: Record<NotificationType, {
  actor: "none" | "source" | "ledger";
  subject: "none" | "asset" | "subtask" | "project_comment" | "notice_board_post";
  asset: boolean;
  title: "unchanged" | "composed";
  body: "unchanged" | "subject" | "composed";
}> = {
  comment_added: { actor: "source", subject: "asset", asset: true, title: "composed", body: "subject" },
  mentioned: { actor: "source", subject: "project_comment", asset: false, title: "composed", body: "subject" },
  subtask_assigned: { actor: "ledger", subject: "subtask", asset: false, title: "composed", body: "subject" },
  subtask_due_today: { actor: "none", subject: "subtask", asset: false, title: "unchanged", body: "subject" },
  assigned_to_project: { actor: "ledger", subject: "none", asset: false, title: "composed", body: "unchanged" },
  project_activity: { actor: "ledger", subject: "none", asset: false, title: "unchanged", body: "unchanged" },
  project_collaboration_activity: { actor: "ledger", subject: "none", asset: false, title: "unchanged", body: "unchanged" },
  raw_ready: { actor: "none", subject: "none", asset: false, title: "unchanged", body: "unchanged" },
  edited_landed: { actor: "none", subject: "none", asset: false, title: "unchanged", body: "unchanged" },
  sent_to_editing: { actor: "none", subject: "none", asset: false, title: "unchanged", body: "unchanged" },
  autohdr_stalled: { actor: "none", subject: "none", asset: false, title: "unchanged", body: "unchanged" },
  delivered: { actor: "none", subject: "none", asset: false, title: "unchanged", body: "unchanged" },
  project_deadline_reminder: { actor: "none", subject: "none", asset: false, title: "unchanged", body: "unchanged" },
};
