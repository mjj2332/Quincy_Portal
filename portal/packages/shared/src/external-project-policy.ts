import { z } from "zod";
import {
  PROJECT_ACTIVITY_REGISTRY,
  SAFE_PROJECT_FIELDS,
  type ProjectActivityPayloadFor,
  type ProjectActivityType,
} from "./project-activity";
import { NOTIFICATION_TYPES, type NotificationType } from "./notification-types";

export type ExternalSuppressionReason =
  | "priority_withheld"
  | "archive_withheld"
  | "restore_withheld"
  | "provider_or_diagnostic"
  | "unlinked_or_notice_board"
  | "unknown_event";
export type ExternalProjectActivityProjector = "safe_activity" | "safe_details" | "safe_team" | "safe_checklist" | "safe_comment" | "safe_deliverable" | "safe_workflow";
export type ExternalActivityPolicy =
  | { decision: "allowed"; projector: ExternalProjectActivityProjector }
  | { decision: "suppressed"; reason: ExternalSuppressionReason };
export type ExternalLegacyPolicy =
  | { decision: "allowed"; durableEvent: string }
  | { decision: "suppressed"; reason: ExternalSuppressionReason };

const allowed = (projector: ExternalProjectActivityProjector): ExternalActivityPolicy => ({ decision: "allowed", projector });
const suppressed = (reason: ExternalSuppressionReason): ExternalActivityPolicy => ({ decision: "suppressed", reason });

export const EXTERNAL_PROJECT_ACTIVITY_POLICY: Record<ProjectActivityType, ExternalActivityPolicy> = {
  "project.team.member_added": allowed("safe_team"),
  "project.team.member_removed": allowed("safe_team"),
  "project.deadline.schedule_changed": allowed("safe_activity"),
  "project.priority.changed": suppressed("priority_withheld"),
  "project.details.changed": allowed("safe_details"),
  "project.archived": suppressed("archive_withheld"),
  "project.restored": suppressed("restore_withheld"),
  "project.checklist.item_created": allowed("safe_checklist"),
  "project.checklist.item_updated": allowed("safe_checklist"),
  "project.checklist.item_deleted": allowed("safe_checklist"),
  "project.comment.created": allowed("safe_comment"),
  "project.comment.edited": allowed("safe_comment"),
  "project.comment.deleted": allowed("safe_comment"),
  "project.collection.video_link_added": allowed("safe_deliverable"),
  "project.collection.video_link_changed": allowed("safe_deliverable"),
  "project.collection.video_links_reordered": allowed("safe_deliverable"),
  "project.collection.video_link_removed": allowed("safe_deliverable"),
  "project.collection.document_completed": allowed("safe_deliverable"),
  "project.workflow.manual_edited_ready": allowed("safe_workflow"),
  "project.collection.raw_sync_completed": allowed("safe_workflow"),
  "project.checklist.schedule_changed": allowed("safe_checklist"),
  "project.stage.changed": allowed("safe_activity"),
  "project.workflow.raw_ready": allowed("safe_workflow"),
  "project.workflow.sent_to_editing": allowed("safe_workflow"),
  "project.workflow.edited_ready": allowed("safe_workflow"),
  "project.workflow.delivered": allowed("safe_workflow"),
};

export const EXTERNAL_LEGACY_NOTIFICATION_POLICY: Record<NotificationType, ExternalLegacyPolicy> = {
  raw_ready: { decision: "allowed", durableEvent: "project.external_safe.direct" },
  edited_landed: { decision: "allowed", durableEvent: "project.external_safe.direct" },
  sent_to_editing: { decision: "allowed", durableEvent: "project.external_safe.direct" },
  autohdr_stalled: { decision: "suppressed", reason: "provider_or_diagnostic" },
  delivered: { decision: "allowed", durableEvent: "project.external_safe.direct" },
  comment_added: { decision: "allowed", durableEvent: "project.external_safe.direct" },
  assigned_to_project: { decision: "allowed", durableEvent: "project.assignment.created" },
  mentioned: { decision: "allowed", durableEvent: "project.comment.mentioned" },
  subtask_assigned: { decision: "allowed", durableEvent: "project.subtask.assigned" },
  subtask_due_today: { decision: "allowed", durableEvent: "project.subtask.due_today" },
  project_deadline_reminder: { decision: "allowed", durableEvent: "project.deadline.reminder" },
  project_activity: { decision: "allowed", durableEvent: "project.activity.broad" },
  project_collaboration_activity: { decision: "allowed", durableEvent: "project.activity.broad" },
};

export type ExternalProjectDetailSafeField = (typeof SAFE_PROJECT_FIELDS)[number];
export const EXTERNAL_PROJECT_DETAIL_SAFE_FIELDS = SAFE_PROJECT_FIELDS satisfies readonly ExternalProjectDetailSafeField[];

export type ExternalProjectedActivity<T extends ProjectActivityType> = {
  type: T;
  payload: ProjectActivityPayloadFor<T>;
};

export function projectExternalActivityPayload<T extends ProjectActivityType>(type: T, payload: ProjectActivityPayloadFor<T>): ExternalProjectedActivity<T> | null {
  const policy = EXTERNAL_PROJECT_ACTIVITY_POLICY[type];
  const registry = PROJECT_ACTIVITY_REGISTRY[type];
  if (!policy || !registry || policy.decision === "suppressed" || registry.cutover !== "live") return null;
  const parsed = registry.payloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  if (type === "project.details.changed") {
    const fields = (parsed.data as { changedFields: string[] }).changedFields;
    if (!fields.some((field) => (SAFE_PROJECT_FIELDS as readonly string[]).includes(field))) return null;
  }
  return { type, payload: parsed.data as ProjectActivityPayloadFor<T> };
}

export function projectExternalLegacyPayload(type: NotificationType, payload: unknown): { type: NotificationType } | null {
  return EXTERNAL_LEGACY_NOTIFICATION_POLICY[type]?.decision === "allowed" ? { type } : null;
}

export function isExternalNotificationEventAllowed(eventType: string): boolean {
  if ((NOTIFICATION_TYPES as readonly string[]).includes(eventType)) return EXTERNAL_LEGACY_NOTIFICATION_POLICY[eventType as NotificationType].decision === "allowed";
  if (!(eventType in EXTERNAL_PROJECT_ACTIVITY_POLICY)) return false;
  return EXTERNAL_PROJECT_ACTIVITY_POLICY[eventType as ProjectActivityType].decision === "allowed";
}

/** Audience is derived from this policy; registry metadata remains the internal delivery inventory. */
export function externalProjectActivityAudience(type: ProjectActivityType): "internal" | "internal-and-external" {
  return EXTERNAL_PROJECT_ACTIVITY_POLICY[type].decision === "allowed" ? "internal-and-external" : "internal";
}

const externalSafeFieldValues = [...EXTERNAL_PROJECT_DETAIL_SAFE_FIELDS] as [ExternalProjectDetailSafeField, ...ExternalProjectDetailSafeField[]];
export const externalProjectDetailsChangedPayloadSchema = z.object({ changedFields: z.array(z.enum(externalSafeFieldValues)) }).strict();
