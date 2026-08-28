import { z } from "zod";
import type { NotificationType } from "./notification-types";
import type { ProjectActivityType } from "./project-activity";

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
  | ProjectActivityType;

export type NotificationCopy = { title: string; body: string };
export type ExternalNotificationCopyInput = { type: string };

// Suppressed known values are represented as null so this remains a total compile-time registry
// without giving a future or provider-only event a permissive fallback renderer.
const COPY: Record<ExternalAllowedNotificationType, NotificationCopy | null> = {
  raw_ready: { title: "RAW media ready", body: "RAW media is ready for review." },
  edited_landed: { title: "Edited media updated", body: "Edited project media was updated." },
  sent_to_editing: { title: "Editing workflow updated", body: "The project was sent to editing." },
  autohdr_stalled: null,
  delivered: { title: "Project delivered", body: "The assigned project was delivered." },
  comment_added: { title: "New annotation feedback", body: "Annotation feedback was added to assigned media." },
  assigned_to_project: { title: "Project assigned", body: "You were assigned to a project." },
  mentioned: { title: "You were mentioned", body: "You were mentioned in a project comment." },
  subtask_assigned: { title: "Checklist item assigned", body: "A checklist item was assigned to you." },
  subtask_due_today: { title: "Checklist item due today", body: "An assigned checklist item is due today." },
  project_deadline_reminder: { title: "Project deadline reminder", body: "An assigned project deadline is approaching." },
  project_activity: null,
  project_collaboration_activity: null,
  "project.team.member_added": { title: "Project team updated", body: "The assigned project team was updated." },
  "project.team.member_removed": { title: "Project team updated", body: "The assigned project team was updated." },
  "project.deadline.schedule_changed": { title: "Project details updated", body: "External-visible project details were updated." },
  "project.priority.changed": null,
  "project.details.changed": { title: "Project details updated", body: "External-visible project details were updated." },
  "project.archived": null,
  "project.restored": null,
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
  "project.workflow.raw_ready": { title: "RAW media ready", body: "RAW media is ready for review." },
  "project.workflow.sent_to_editing": { title: "Editing workflow updated", body: "The project was sent to editing." },
  "project.workflow.edited_ready": { title: "Edited media updated", body: "Edited project media was updated." },
  "project.workflow.delivered": { title: "Project delivered", body: "The assigned project was delivered." },
};

export function externalNotificationCopy(input: ExternalNotificationCopyInput): NotificationCopy | null {
  return Object.prototype.hasOwnProperty.call(COPY, input.type)
    ? COPY[input.type as ExternalAllowedNotificationType]
    : null;
}

const CHANNELS: Record<ExternalAllowedNotificationType, readonly ("in_app" | "email")[]> = {
  raw_ready: ["in_app"], edited_landed: ["in_app"], sent_to_editing: ["in_app"], autohdr_stalled: [],
  delivered: ["in_app"], comment_added: ["in_app"], assigned_to_project: ["in_app", "email"], mentioned: ["in_app", "email"],
  subtask_assigned: ["in_app", "email"], subtask_due_today: ["in_app", "email"], project_deadline_reminder: ["in_app", "email"],
  project_activity: [], project_collaboration_activity: [],
  "project.team.member_added": ["in_app"], "project.team.member_removed": ["in_app"], "project.deadline.schedule_changed": ["in_app"],
  "project.priority.changed": [], "project.details.changed": ["in_app"], "project.archived": [], "project.restored": [],
  "project.checklist.item_created": ["in_app"], "project.checklist.item_updated": ["in_app"], "project.checklist.item_deleted": ["in_app"],
  "project.comment.created": ["in_app"], "project.comment.edited": ["in_app"], "project.comment.deleted": ["in_app"],
  "project.collection.video_link_added": ["in_app"], "project.collection.video_link_changed": ["in_app"],
  "project.collection.video_links_reordered": ["in_app"], "project.collection.video_link_removed": ["in_app"],
  "project.collection.document_completed": ["in_app"], "project.workflow.manual_edited_ready": ["in_app"],
  "project.collection.raw_sync_completed": ["in_app"], "project.checklist.schedule_changed": ["in_app"], "project.stage.changed": ["in_app"],
  "project.workflow.raw_ready": ["in_app"], "project.workflow.sent_to_editing": ["in_app"], "project.workflow.edited_ready": ["in_app"], "project.workflow.delivered": ["in_app"],
};

export function externalNotificationChannels(type: string): readonly ("in_app" | "email")[] {
  return Object.prototype.hasOwnProperty.call(CHANNELS, type)
    ? CHANNELS[type as ExternalAllowedNotificationType]
    : [];
}
