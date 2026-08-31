import { z } from "zod";
import { EXTERNAL_EDITOR_CAPABILITIES, ROLE_LABELS } from "./capabilities";
import { externalAssetSchema } from "./external-asset-dto";
import { externalEditedCompleteResponseSchema, externalEditedUploadCreateResponseSchema } from "./external-upload";
import { STAGE_PRESENTATION_KEYS } from "./stage-move";
import { externalCalendarRangeSchema } from "./production-calendar";
import { externalProjectActivityFeedResponseSchema } from "./project-activity-feed";
export { externalCalendarRangeSchema } from "./production-calendar";
export { externalProjectActivityFeedResponseSchema } from "./project-activity-feed";

const iso = z.string().min(1);
const uuid = z.string().uuid();

export const externalPersonSchema = z.object({
  id: uuid,
  name: z.string(),
  roleLabel: z.string(),
  isExternal: z.boolean(),
  active: z.boolean(),
}).strict();
export type ExternalPersonDto = z.infer<typeof externalPersonSchema>;

export const externalParticipantSchema = externalPersonSchema.extend({
  email: z.string().email(),
  membershipCycleId: uuid,
  roleOnProject: z.enum(["photographer", "editor"]),
}).strict();
export type ExternalParticipantDto = z.infer<typeof externalParticipantSchema>;

const externalDeadlineEndpointSchema = z.object({
  localCivil: z.string(),
  zone: z.literal("Australia/Sydney"),
  utcOffsetMinutes: z.number().int(),
  fold: z.union([z.literal(0), z.literal(1)]),
  instant: iso,
}).strict();

export const externalDeadlineSchema = z.object({
  version: z.number().int().nonnegative(),
  deadline: externalDeadlineEndpointSchema.nullable(),
  reminderOffsetsMinutes: z.array(z.number().int()),
  state: z.enum(["unset", "scheduled", "overdue", "inactive_delivered", "inactive_archived"]),
  nextOccurrence: z.object({
    kind: z.enum(["advance", "due_now"]),
    offsetMinutes: z.number().int(),
    firesAt: iso,
  }).strict().nullable(),
  canResume: z.boolean(),
  skippedReminderOffsetsMinutes: z.array(z.number().int()).optional(),
}).strict();
export type ExternalDeadlineDto = z.infer<typeof externalDeadlineSchema>;

const externalScheduleEndpointSchema = z.object({
  kind: z.enum(["date", "timed"]),
  localCivil: z.string(),
  instant: iso.nullable(),
  utcOffsetMinutes: z.number().int().nullable(),
  fold: z.union([z.literal(0), z.literal(1)]).nullable(),
  resolution: z.enum(["stored", "derived_unambiguous"]),
}).strict();

export const externalScheduleSchema = z.union([
  z.object({
    state: z.enum(["unscheduled", "due_only", "range"]),
    version: z.number().int().nonnegative(),
    zone: z.literal("Australia/Sydney"),
    start: externalScheduleEndpointSchema.nullable(),
    end: externalScheduleEndpointSchema.nullable(),
    due: z.string().nullable(),
  }).strict(),
  z.object({
    state: z.literal("legacy_unresolved"),
    version: z.literal(0),
    zone: z.literal("Australia/Sydney"),
    start: z.null(),
    end: z.null(),
    due: z.string(),
    error: z.object({
      code: z.literal("subtask_schedule_legacy_unresolved"),
      reason: z.enum(["invalid_literal", "nonexistent_local_time", "repeated_local_time"]),
      foldChoices: z.array(z.object({ disambiguation: z.enum(["earlier", "later"]), utcOffsetMinutes: z.number().int() }).strict()).optional(),
    }).strict(),
  }).strict(),
  z.object({
    state: z.literal("invalid"),
    version: z.number().int().nonnegative(),
    zone: z.null(),
    start: z.null(),
    end: z.null(),
    due: z.string().nullable(),
    error: z.object({
      code: z.literal("subtask_schedule_storage_invalid"),
      reason: z.enum(["shape_mismatch", "resolution_mismatch", "ordering_invalid"]),
    }).strict(),
  }).strict(),
]);
export type ExternalScheduleDto = z.infer<typeof externalScheduleSchema>;

const serviceSchema = z.object({
  id: uuid,
  kind: z.string(),
  status: z.string(),
  expectedCount: z.number().int().nullable(),
  receivedCount: z.number().int(),
}).strict();

const coverSchema = z.object({ assetId: uuid, url: z.string().url() }).strict();

const projectSummaryShape = {
  id: uuid,
  address: z.object({ street: z.string(), suburb: z.string().nullable(), postcode: z.string().nullable() }).strict(),
  agencyDisplayName: z.string().nullable(),
  agentDisplayName: z.string().nullable(),
  shootDate: z.string().nullable(),
  timeWindow: z.string().nullable(),
  stageKey: z.enum(STAGE_PRESENTATION_KEYS),
  boardRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  deadline: externalDeadlineSchema.nullable(),
  productionNotes: z.string().nullable(),
  services: z.array(serviceSchema),
  cover: coverSchema.nullable(),
};

export const externalProjectSummarySchema = z.object(projectSummaryShape).strict();
export type ExternalProjectSummaryDto = z.infer<typeof externalProjectSummarySchema>;

export const externalProjectDetailSchema = externalProjectSummarySchema.extend({
  contractEnabled: z.boolean(),
  editedUploadAvailable: z.boolean(),
  collections: z.array(serviceSchema),
  members: z.array(externalParticipantSchema.extend({ assignedSubtaskCount: z.number().int().nonnegative() }).strict()),
}).strict();
export type ExternalProjectDetailDto = z.infer<typeof externalProjectDetailSchema>;

export { externalAssetSchema, type ExternalAssetDto } from "./external-asset-dto";

export const externalAnnotationSchema = z.object({
  id: uuid,
  author: externalPersonSchema,
  scope: z.enum(["raw", "edited"]),
  hasMarkup: z.boolean(),
  markupUrl: z.string().url().nullable(),
  noteText: z.string().nullable(),
  createdAt: iso,
  editedAt: iso.nullable(),
}).strict();
export type ExternalAnnotationDto = z.infer<typeof externalAnnotationSchema>;

export const externalCollectionLinkSchema = z.object({ id: uuid, url: z.string().url(), label: z.string().nullable(), position: z.number().int(), createdAt: iso }).strict();
export type ExternalCollectionLinkDto = z.infer<typeof externalCollectionLinkSchema>;

export const externalIngestStatusSchema = z.object({ expectedCount: z.number().int().nullable(), receivedCount: z.number().int(), mismatch: z.boolean() }).strict();
export const externalChecklistItemSchema = z.object({
  id: uuid,
  title: z.string(),
  done: z.boolean(),
  position: z.number().int(),
  assignee: externalPersonSchema.nullable(),
  assignmentVersion: z.number().int().nonnegative(),
  dueDate: z.string().nullable(),
  schedule: externalScheduleSchema,
  createdBy: externalPersonSchema,
  createdAt: iso,
  updatedAt: iso,
}).strict();
export const externalCommentSchema = z.object({ id: uuid, author: externalPersonSchema, body: z.string(), content: z.unknown(), createdAt: iso, editedAt: iso.nullable() }).strict();
export const externalCommentReadStateSchema = z.object({
  projectId: uuid,
  marker: z.object({ throughCommentId: uuid, throughCreatedAt: iso, updatedAt: iso }).strict().nullable(),
  latest: z.object({ commentId: uuid, createdAt: iso }).strict().nullable(),
  unreadCount: z.number().int().nonnegative(),
}).strict();
export const externalMentionableUserSchema = externalPersonSchema;
export const externalNotificationListItemSchema = z.object({ id: uuid, projectId: uuid, type: z.string(), title: z.string(), body: z.string().nullable(), readAt: iso.nullable(), createdAt: iso }).strict();

export const externalProjectExportSchema = z.object({
  schemaVersion: z.literal(1), generatedAt: iso,
  project: externalProjectDetailSchema,
  assets: z.array(externalAssetSchema), links: z.array(externalCollectionLinkSchema),
  checklist: z.array(externalChecklistItemSchema), comments: z.array(externalCommentSchema),
}).strict();

const externalBoardProjectionSchema = z.object({
  contractEnabled: z.boolean(),
  orderedProjectIdsByStage: z.object({
    awaiting_raw: z.array(uuid).optional(),
    raw_review: z.array(uuid).optional(),
    editing: z.array(uuid).optional(),
    edited_review: z.array(uuid).optional(),
    delivered: z.array(uuid).optional(),
  }).strict(),
}).strict();

export const externalProjectListResponseSchema = z.object({
  projects: z.array(externalProjectSummarySchema),
  board: externalBoardProjectionSchema,
}).strict();
export const externalAssetListResponseSchema = z.object({ assets: z.array(externalAssetSchema) }).strict();
export const externalAnnotationListResponseSchema = z.object({ annotations: z.array(externalAnnotationSchema) }).strict();
export const externalCommentListResponseSchema = z.object({
  project: z.object({ id: uuid, street: z.string() }).strict(), comments: z.array(externalCommentSchema), nextCursor: z.string().max(2048).optional(),
}).strict();
export const externalChecklistListResponseSchema = z.object({ subtasks: z.array(externalChecklistItemSchema) }).strict();
export const externalCollectionLinkListResponseSchema = z.object({ links: z.array(externalCollectionLinkSchema) }).strict();
export const externalMentionableListResponseSchema = z.object({ users: z.array(externalMentionableUserSchema).max(20) }).strict();
export const externalNotificationListResponseSchema = z.object({ notifications: z.array(externalNotificationListItemSchema), unreadCount: z.number().int().nonnegative() }).strict();
export const externalMeResponseSchema = z.object({
  user: z.object({ id: uuid, name: z.string(), email: z.string().email(), role: z.literal("external_editor"), active: z.literal(true), impersonatedBy: uuid.nullable(), authorizationEpoch: z.number().int().nonnegative() }).strict(),
  capabilities: z.array(z.enum(EXTERNAL_EDITOR_CAPABILITIES)).length(EXTERNAL_EDITOR_CAPABILITIES.length),
}).strict();
export const externalNotificationPreferenceResponseSchema = z.object({ projectDeadlineReminderEmails: z.boolean() }).strict();
export const externalMutationOkResponseSchema = z.object({ ok: z.literal(true) }).strict();
export const externalProjectAccessSnapshotSchema = z.object({
  principal: z.object({ id: uuid, role: z.string(), authorizationEpoch: z.number().int().nonnegative() }).strict(),
  authorizationFingerprint: z.string().min(1),
  projects: z.array(z.object({ projectId: uuid, membershipCycleIds: z.array(uuid) }).strict()),
}).strict();
export type ExternalProjectAccessSnapshotDto = z.infer<typeof externalProjectAccessSnapshotSchema>;

export const externalStageListResponseSchema = z.object({
  stages: z.array(z.object({ key: z.string(), label: z.string(), displayOrder: z.number().int(), active: z.boolean() }).strict()),
}).strict();

export type ExternalApiSurface =
  | "me" | "notification-preferences" | "project-list" | "project-detail" | "asset-list" | "annotation-list"
  | "annotation-mutation" | "collection-links" | "ingest-status" | "stages" | "collaboration" | "checklist" | "comment-list"
  | "comment-mutation" | "comment-read-state" | "mentionable" | "notifications" | "notification-mutation"
  | "review-mutation" | "external-upload" | "external-upload-complete" | "access-snapshot" | "activity" | "calendar" | "export";

export const EXTERNAL_API_RESPONSE_SCHEMAS: Readonly<Record<ExternalApiSurface, z.ZodTypeAny>> = {
  me: externalMeResponseSchema,
  "notification-preferences": externalNotificationPreferenceResponseSchema,
  "project-list": externalProjectListResponseSchema,
  "project-detail": externalProjectDetailSchema,
  "asset-list": externalAssetListResponseSchema,
  "annotation-list": externalAnnotationListResponseSchema,
  "annotation-mutation": z.union([externalAnnotationSchema, externalMutationOkResponseSchema]),
  "collection-links": externalCollectionLinkListResponseSchema,
  "ingest-status": externalIngestStatusSchema,
  stages: externalStageListResponseSchema,
  collaboration: z.object({ project: z.object({ id: uuid, street: z.string(), stageKey: z.string() }).strict(), members: z.array(externalParticipantSchema.extend({ assignedSubtaskCount: z.number().int().nonnegative() }).strict()) }).strict(),
  checklist: z.union([externalChecklistListResponseSchema, externalChecklistItemSchema, z.object({ position: z.number().int() }).strict(), externalMutationOkResponseSchema]),
  "comment-list": externalCommentListResponseSchema,
  "comment-mutation": z.union([externalCommentSchema, externalMutationOkResponseSchema]),
  "comment-read-state": externalCommentReadStateSchema,
  mentionable: externalMentionableListResponseSchema,
  notifications: externalNotificationListResponseSchema,
  "notification-mutation": externalMutationOkResponseSchema,
  "review-mutation": externalMutationOkResponseSchema,
  "external-upload": externalEditedUploadCreateResponseSchema,
  "external-upload-complete": externalEditedCompleteResponseSchema,
  "access-snapshot": externalProjectAccessSnapshotSchema,
  activity: externalProjectActivityFeedResponseSchema,
  calendar: externalCalendarRangeSchema,
  export: externalProjectExportSchema,
};

export function externalRoleLabel(): string {
  return ROLE_LABELS.external_editor;
}
