import { z } from "zod";
import type { NotificationType } from "./notification-types";

const uuid = z.string().uuid();
const isoString = z.string().min(1);

export const notificationActorSchema = z.object({ id: uuid, name: z.string().min(1) }).strict();

export const NOTIFICATION_SUBJECT_KINDS = ["asset", "subtask", "project_comment", "notice_board_post"] as const;
export type NotificationSubjectKind = (typeof NOTIFICATION_SUBJECT_KINDS)[number];

export const notificationSubjectSchema = z.object({
  kind: z.enum(NOTIFICATION_SUBJECT_KINDS),
  label: z.string().min(1),
}).strict();
export type NotificationActor = z.infer<typeof notificationActorSchema>;
export type NotificationSubject = z.infer<typeof notificationSubjectSchema>;
export type StaffNotificationListItem = z.infer<typeof staffNotificationListItemSchema>;

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
  nextCursor: z.string().max(512).nullable(),
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
 * The enriched form every notification type may take — the upper bound the resolver in
 * workers/app/src/lib/notification-enrichment.ts works within, and what its conformance test
 * checks each returned row against:
 * - `actor`: where an actor comes from — the source row itself ("source"), the delivery
 *   ledger's outbox row ("ledger"), or nowhere ("none", a system event).
 * - `subject`: the subject kinds a row of this type may carry (empty = never).
 * - `asset`: whether the row may name a specific Asset of its own.
 * - `title`: "composed" means the title is rewritten when the actor (and Asset, for a comment)
 *   resolves, and stays stored otherwise; "unchanged" is never rewritten.
 * - `body`: "subject" means the body becomes the subject's own text when it resolves.
 * Every part degrades independently to the stored copy; nothing here promises a part resolves.
 */
export type NotificationEnrichmentDeclaration = {
  actor: "none" | "source" | "ledger";
  subject: readonly NotificationSubjectKind[];
  asset: boolean;
  title: "unchanged" | "composed";
  body: "unchanged" | "subject";
};
const SYSTEM: NotificationEnrichmentDeclaration = { actor: "none", subject: [], asset: false, title: "unchanged", body: "unchanged" };
export const NOTIFICATION_ENRICHMENT: Record<NotificationType, NotificationEnrichmentDeclaration> = {
  comment_added: { actor: "source", subject: ["asset"], asset: true, title: "composed", body: "subject" },
  mentioned: { actor: "source", subject: ["project_comment", "notice_board_post"], asset: false, title: "composed", body: "subject" },
  // Only external recipients have an outbox row for this type today, so for the staff branch the
  // actor never resolves and the title stays stored — see ADR 0007's consequences.
  subtask_assigned: { actor: "ledger", subject: ["subtask"], asset: false, title: "composed", body: "subject" },
  subtask_due_today: { actor: "none", subject: ["subtask"], asset: false, title: "unchanged", body: "subject" },
  assigned_to_project: { actor: "ledger", subject: [], asset: false, title: "composed", body: "unchanged" },
  // The stored body already leads with the actor's name (renderProjectActivityNotification).
  project_activity: { actor: "ledger", subject: [], asset: false, title: "unchanged", body: "unchanged" },
  project_collaboration_activity: { actor: "ledger", subject: [], asset: false, title: "unchanged", body: "unchanged" },
  raw_ready: SYSTEM,
  edited_landed: SYSTEM,
  sent_to_editing: SYSTEM,
  autohdr_stalled: SYSTEM,
  delivered: SYSTEM,
  project_deadline_reminder: SYSTEM,
};

/**
 * Whether one enriched row stays inside its type's declaration. Pure, so the worker's route test
 * can hold every returned row against the table without knowing how the resolver got there.
 */
export function conformsToNotificationEnrichment(
  type: string,
  row: { title: string; body: string | null; actor: unknown; subject: NotificationSubject | null; assetId: string | null },
  stored: { title: string; body: string | null },
): boolean {
  const declared = (NOTIFICATION_ENRICHMENT as Record<string, NotificationEnrichmentDeclaration | undefined>)[type];
  if (!declared) return row.actor === null && row.subject === null && row.assetId === null && row.title === stored.title && row.body === stored.body;
  if (declared.actor === "none" && row.actor !== null) return false;
  if (row.subject !== null && !declared.subject.includes(row.subject.kind)) return false;
  if (!declared.asset && row.assetId !== null) return false;
  if (declared.title === "unchanged" && row.title !== stored.title) return false;
  if (declared.body === "unchanged" && row.body !== stored.body) return false;
  return true;
}
