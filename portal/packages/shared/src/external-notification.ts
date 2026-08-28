import { z } from "zod";
import type { NotificationType } from "./notification-types";

export const EXTERNAL_NOTIFICATION_OUTBOX_EVENT_TYPES = {
  projectSafeDirect: "project.external_safe.direct",
  subtaskAssigned: "project.subtask.assigned",
  subtaskDueToday: "project.subtask.due_today",
} as const;

const authorizationAtOccurrence = z.object({
  kind: z.literal("project_editor_membership"),
  membershipCycle: z.string().uuid(),
  startedAt: z.number().int().nonnegative(),
}).strict();
const event = (type: string) => z.object({ type: z.literal(type), sourceKey: z.string().min(1), recipientId: z.string().uuid() }).strict();

const safeDirect = z.object({
  schemaVersion: z.literal(1),
  event: event(EXTERNAL_NOTIFICATION_OUTBOX_EVENT_TYPES.projectSafeDirect),
  authorizationAtOccurrence,
  legacy: z.object({ type: z.string().min(1), projectId: z.string().uuid(), sourceId: z.string().min(1) }).strict(),
}).strict();
const assignment = z.object({ projectId: z.string().uuid(), subtaskId: z.string().uuid(), assigneeId: z.string().uuid(), assignmentVersion: z.number().int().nonnegative() }).strict();
const due = assignment.extend({ dueDate: z.string(), claimAt: z.number().int().nonnegative() }).strict();

// The discriminator is nested inside the event object. Zod's discriminatedUnion only supports a
// top-level discriminator, so the strict union is selected explicitly by the parser below.
export const externalNotificationOutboxPayloadSchema = z.union([
  safeDirect,
  z.object({ schemaVersion: z.literal(1), event: event(EXTERNAL_NOTIFICATION_OUTBOX_EVENT_TYPES.subtaskAssigned), authorizationAtOccurrence, assignment }).strict(),
  z.object({ schemaVersion: z.literal(1), event: event(EXTERNAL_NOTIFICATION_OUTBOX_EVENT_TYPES.subtaskDueToday), authorizationAtOccurrence, assignment: due }).strict(),
]);

export type ExternalNotificationOutboxPayload =
  | z.infer<typeof safeDirect>
  | { schemaVersion: 1; event: { type: typeof EXTERNAL_NOTIFICATION_OUTBOX_EVENT_TYPES.subtaskAssigned; sourceKey: string; recipientId: string }; authorizationAtOccurrence: z.infer<typeof authorizationAtOccurrence>; assignment: z.infer<typeof assignment> }
  | { schemaVersion: 1; event: { type: typeof EXTERNAL_NOTIFICATION_OUTBOX_EVENT_TYPES.subtaskDueToday; sourceKey: string; recipientId: string }; authorizationAtOccurrence: z.infer<typeof authorizationAtOccurrence>; assignment: z.infer<typeof due> };

export function parseExternalNotificationOutboxPayload(value: unknown): ExternalNotificationOutboxPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const eventType = (value as { event?: { type?: unknown } }).event?.type;
  const schema = eventType === EXTERNAL_NOTIFICATION_OUTBOX_EVENT_TYPES.projectSafeDirect ? safeDirect
    : eventType === EXTERNAL_NOTIFICATION_OUTBOX_EVENT_TYPES.subtaskAssigned ? z.object({ schemaVersion: z.literal(1), event: event(EXTERNAL_NOTIFICATION_OUTBOX_EVENT_TYPES.subtaskAssigned), authorizationAtOccurrence, assignment }).strict()
    : eventType === EXTERNAL_NOTIFICATION_OUTBOX_EVENT_TYPES.subtaskDueToday ? z.object({ schemaVersion: z.literal(1), event: event(EXTERNAL_NOTIFICATION_OUTBOX_EVENT_TYPES.subtaskDueToday), authorizationAtOccurrence, assignment: due }).strict()
    : null;
  if (!schema) return null;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data as ExternalNotificationOutboxPayload : null;
}

export type ExternalAllowedNotificationType =
  | NotificationType
  | "project.team.member_added"
  | "project.team.member_removed"
  | "project.deadline.schedule_changed"
  | "project.details.changed"
  | "project.checklist.item_created"
  | "project.checklist.item_updated"
  | "project.checklist.item_deleted"
  | "project.checklist.schedule_changed"
  | "project.comment.created"
  | "project.comment.edited"
  | "project.comment.deleted"
  | "project.collection.video_link_added"
  | "project.collection.video_link_changed"
  | "project.collection.video_links_reordered"
  | "project.collection.video_link_removed"
  | "project.collection.document_completed"
  | "project.workflow.manual_edited_ready"
  | "project.collection.raw_sync_completed"
  | "project.stage.changed";

export type NotificationCopy = { title: string; body: string };
export type ExternalNotificationCopyInput = { type: ExternalAllowedNotificationType };

const COPY: Partial<Record<ExternalAllowedNotificationType, NotificationCopy>> = {
  raw_ready: { title: "RAW media ready", body: "RAW media is ready for review." },
  edited_landed: { title: "Edited media updated", body: "Edited project media was updated." },
  sent_to_editing: { title: "Editing workflow updated", body: "The project was sent to editing." },
  delivered: { title: "Project delivered", body: "The assigned project was delivered." },
  comment_added: { title: "New annotation feedback", body: "Annotation feedback was added to assigned media." },
  assigned_to_project: { title: "Project assigned", body: "You were assigned to a project." },
  mentioned: { title: "You were mentioned", body: "You were mentioned in a project comment." },
  subtask_assigned: { title: "Checklist item assigned", body: "A checklist item was assigned to you." },
  subtask_due_today: { title: "Checklist item due today", body: "An assigned checklist item is due today." },
  project_deadline_reminder: { title: "Project deadline reminder", body: "An assigned project deadline is approaching." },
  "project.team.member_added": { title: "Project team updated", body: "The assigned project team was updated." },
  "project.team.member_removed": { title: "Project team updated", body: "The assigned project team was updated." },
  "project.details.changed": { title: "Project details updated", body: "External-visible project details were updated." },
  project_activity: { title: "Project update", body: "The assigned project was updated." },
  project_collaboration_activity: { title: "Project discussion updated", body: "The assigned project discussion was updated." },
  "project.checklist.item_created": { title: "Project checklist updated", body: "The assigned project checklist was updated." },
  "project.checklist.item_updated": { title: "Project checklist updated", body: "The assigned project checklist was updated." },
  "project.checklist.item_deleted": { title: "Project checklist updated", body: "The assigned project checklist was updated." },
  "project.checklist.schedule_changed": { title: "Project checklist updated", body: "The assigned project checklist was updated." },
  "project.comment.created": { title: "Project discussion updated", body: "The assigned project discussion was updated." },
  "project.comment.edited": { title: "Project discussion updated", body: "The assigned project discussion was updated." },
  "project.comment.deleted": { title: "Project discussion updated", body: "The assigned project discussion was updated." },
  "project.collection.video_link_added": { title: "Project deliverable updated", body: "An assigned project deliverable was updated." },
  "project.collection.video_link_changed": { title: "Project deliverable updated", body: "An assigned project deliverable was updated." },
  "project.collection.video_links_reordered": { title: "Project deliverable updated", body: "An assigned project deliverable was updated." },
  "project.collection.video_link_removed": { title: "Project deliverable updated", body: "An assigned project deliverable was updated." },
  "project.collection.document_completed": { title: "Project deliverable ready", body: "An assigned project deliverable is ready." },
  "project.workflow.manual_edited_ready": { title: "Edited media updated", body: "Edited project media was updated." },
  "project.collection.raw_sync_completed": { title: "RAW media ready", body: "RAW media is ready for review." },
  "project.stage.changed": { title: "Project stage updated", body: "The assigned project stage was updated." },
};

export function externalNotificationCopy(input: ExternalNotificationCopyInput): NotificationCopy {
  return COPY[input.type] ?? { title: "Project update", body: "The assigned project was updated." };
}

export function externalNotificationChannels(type: ExternalAllowedNotificationType): readonly ("in_app" | "email")[] {
  if (type === "assigned_to_project" || type === "mentioned" || type === "subtask_assigned" || type === "subtask_due_today" || type === "project_deadline_reminder") return ["in_app", "email"];
  return ["in_app"];
}
