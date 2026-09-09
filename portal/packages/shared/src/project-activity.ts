import { z } from "zod";
import { CANONICAL_LOWERCASE_UUID_REGEX, staffPathFor } from "./staff-routes";
import { TB4D_SCHEDULE_ACTIVITY_CUTOVER_DATE } from "./checklist-schedule-config";

export const PROJECT_ACTIVITY_SCHEMA_VERSION = 1 as const;
export const PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID = "00000000-0000-4000-8000-000000000000" as const;

export const PROJECT_ACTIVITY_CATEGORIES = [
  "team", "deadline", "priority", "project_metadata", "coordination", "checklist", "comment",
  "collection_delivery", "review_workflow", "stage", "workflow",
] as const;
export type ProjectActivityCategory = (typeof PROJECT_ACTIVITY_CATEGORIES)[number];

export const LIVE_TYPES = [
  "project.team.member_added",
  "project.team.member_removed",
  "project.deadline.schedule_changed",
  "project.priority.changed",
  "project.details.changed",
  "project.archived",
  "project.restored",
  "project.checklist.item_created",
  "project.checklist.item_updated",
  "project.checklist.item_deleted",
  "project.comment.created",
  "project.comment.edited",
  "project.comment.deleted",
  "project.collection.video_link_added",
  "project.collection.video_link_changed",
  "project.collection.video_links_reordered",
  "project.collection.video_link_removed",
  "project.collection.document_completed",
  "project.workflow.manual_edited_ready",
  "project.collection.raw_sync_completed",
  "project.stage.changed",
  "project.checklist.schedule_changed",
] as const;
export const RESERVED_TYPES = [
  "project.workflow.raw_ready",
  "project.workflow.sent_to_editing",
  "project.workflow.edited_ready",
  "project.workflow.delivered",
] as const;
export const PROJECT_ACTIVITY_TYPES = [...LIVE_TYPES, ...RESERVED_TYPES] as const;
export type ProjectActivityType = (typeof PROJECT_ACTIVITY_TYPES)[number];
export type ProjectActivityLiveType = (typeof LIVE_TYPES)[number];

export function isProjectActivityLiveType(value: unknown): value is ProjectActivityLiveType {
  return typeof value === "string" && (LIVE_TYPES as readonly string[]).includes(value);
}

export type ProjectActivityCoalescing = null | {
  strategy: "leading_edge";
  key: string;
  windowSeconds: 300;
};

export type SafeProjectField = "address" | "shootDate" | "timeWindow" | "agency" | "agent" | "services" | "productionNotes";
export const SAFE_PROJECT_FIELDS = ["address", "shootDate", "timeWindow", "agency", "agent", "services", "productionNotes"] as const;

type ActorKind = "user" | "system";
type DeepLinkKind = "project" | "project_collaboration";
type SourceKind =
  | "project_member" | "project_deadline_schedule" | "project_priority" | "project_details"
  | "project" | "project_checklist" | "project_comment" | "project_video_link"
  | "project_video_links" | "project_document" | "project_manual_edited" | "project_raw_sync"
  | "project_stage" | "project_workflow";

const identifier = z.string().min(1).max(512);
const activityId = z.string().regex(CANONICAL_LOWERCASE_UUID_REGEX, "Activity id must be a canonical lowercase UUID");
const checklistTitle = z.string().min(1).max(500).refine((value) => value.trim() === value, "Checklist title must be trimmed");
const emptyPayload = z.object({}).strict();
const roleOnProject = z.enum(["photographer", "editor"]);
const safeField = z.enum(SAFE_PROJECT_FIELDS);
const safeChangedFields = z.array(safeField).min(1).max(SAFE_PROJECT_FIELDS.length).refine((fields) => new Set(fields).size === fields.length, "Changed fields must be unique");

const payloadSchemas = {
  "project.team.member_added": z.object({ membershipCycle: identifier, roleOnProject }).strict(),
  "project.team.member_removed": z.object({ membershipCycle: identifier, roleOnProject }).strict(),
  "project.deadline.schedule_changed": z.object({ version: z.number().int().min(1), operation: z.enum(["set", "clear", "resume"]) }).strict(),
  "project.priority.changed": z.object({ priority: z.number().int().min(1).max(5).nullable() }).strict(),
  "project.details.changed": z.object({ changedFields: safeChangedFields }).strict(),
  "project.archived": emptyPayload,
  "project.restored": emptyPayload,
  "project.checklist.item_created": z.object({ itemId: identifier, checklistTitle }).strict(),
  "project.checklist.item_updated": z.object({ itemId: identifier, checklistTitle, changes: z.array(z.enum(["title", "completion", "assignee"])).min(1).max(3).refine((changes) => new Set(changes).size === changes.length, "Checklist changes must be unique") }).strict(),
  "project.checklist.item_deleted": z.object({ itemId: identifier, checklistTitle }).strict(),
  "project.checklist.schedule_changed": z.object({ itemId: identifier, checklistTitle, scheduleState: z.enum(["unscheduled", "due_only", "range"]), version: z.number().int().min(1) }).strict(),
  "project.comment.created": z.object({ commentId: identifier }).strict(),
  "project.comment.edited": z.object({ commentId: identifier }).strict(),
  "project.comment.deleted": z.object({ commentId: identifier }).strict(),
  "project.collection.video_link_added": z.object({ linkId: identifier, collectionKind: z.literal("video") }).strict(),
  "project.collection.video_link_changed": z.object({ linkId: identifier, collectionKind: z.literal("video"), changedFields: z.array(z.enum(["url", "label"])).min(1).max(2).refine((fields) => new Set(fields).size === fields.length, "Changed fields must be unique") }).strict(),
  "project.collection.video_links_reordered": z.object({ collectionKind: z.literal("video"), count: z.number().int().min(1).max(10_000) }).strict(),
  "project.collection.video_link_removed": z.object({ linkId: identifier, collectionKind: z.literal("video") }).strict(),
  "project.collection.document_completed": z.object({ collectionKind: z.enum(["copy", "floorplan"]), version: z.number().int().min(1), assetCount: z.number().int().min(1).max(10_000) }).strict(),
  "project.workflow.manual_edited_ready": z.object({ collectionKind: z.literal("edited"), count: z.literal(1) }).strict(),
  "project.collection.raw_sync_completed": z.object({ collectionKind: z.literal("raw"), importedCount: z.number().int().min(1).max(100_000) }).strict(),
  "project.stage.changed": emptyPayload,
  "project.workflow.raw_ready": emptyPayload,
  "project.workflow.sent_to_editing": emptyPayload,
  "project.workflow.edited_ready": emptyPayload,
  "project.workflow.delivered": emptyPayload,
} as const;

export type ProjectActivityPayload = {
  [K in ProjectActivityType]: z.infer<(typeof payloadSchemas)[K]>;
}[ProjectActivityType];
export type ProjectActivityPayloadFor<T extends ProjectActivityType> = Extract<ProjectActivityPayload, z.infer<(typeof payloadSchemas)[T]>>;

type RegistryEntry = {
  schemaVersion: 1;
  category: ProjectActivityCategory;
  producerOwner: string;
  producerCallSites: readonly string[];
  sourceKind: SourceKind;
  sourceKeyShape: string;
  actorRule: ActorKind;
  actorRecipientRule: "eligible_editor_membership_only";
  payloadSchema: z.ZodTypeAny;
  deepLinkKind: DeepLinkKind;
  coalescing: null | { strategy: "leading_edge"; keyShape: string; windowSeconds: 300 };
  channels: readonly ["in_app"];
  emailDefault: "off";
  audience: "internal";
  cutover: "live" | "reserved";
  cutoverOwner: string;
  cutoverDate: string;
  backfill: "none";
  noBackfillNote: string;
};

const live = (
  category: ProjectActivityCategory,
  producerOwner: string,
  producerCallSites: readonly string[],
  sourceKind: SourceKind,
  sourceKeyShape: string,
  deepLinkKind: DeepLinkKind,
  payloadSchema: z.ZodTypeAny,
  coalescing: RegistryEntry["coalescing"] = null,
  actorRule: ActorKind = "user",
  metadata: Partial<Pick<RegistryEntry, "cutoverOwner" | "cutoverDate" | "noBackfillNote">> = {},
): RegistryEntry => ({
  schemaVersion: 1, category, producerOwner, producerCallSites, sourceKind, sourceKeyShape, actorRule,
  actorRecipientRule: "eligible_editor_membership_only", payloadSchema, deepLinkKind, coalescing,
  channels: ["in_app"], emailDefault: "off", audience: "internal",
  cutover: "live", cutoverOwner: metadata.cutoverOwner ?? producerOwner, cutoverDate: metadata.cutoverDate ?? "2026-08-27", backfill: "none",
  noBackfillNote: metadata.noBackfillNote ?? "TB4C has no history backfill; only committed semantic winners emit this type.",
});

const reserved = (
  category: ProjectActivityCategory,
  owner: string,
  sourceKind: SourceKind,
  sourceKeyShape: string,
  deepLinkKind: DeepLinkKind,
  payloadSchema: z.ZodTypeAny = emptyPayload,
  coalescing: RegistryEntry["coalescing"] = null,
): RegistryEntry => ({
  ...live(category, owner, [], sourceKind, sourceKeyShape, deepLinkKind, payloadSchema, coalescing),
  cutover: "reserved", cutoverOwner: owner,
  noBackfillNote: "Reserved for its owning tracer bullet; TB4C must not emit or backfill this type.",
});

export const PROJECT_ACTIVITY_REGISTRY = {
  "project.team.member_added": live("team", "TB4A project membership", ["workers/app/src/lib/project-members.ts", "workers/app/src/routes/projects.ts#createProjectAtomically"], "project_member", "project-member:<membershipCycle>:added", "project", payloadSchemas["project.team.member_added"]),
  "project.team.member_removed": live("team", "TB4A project membership", ["workers/app/src/lib/project-members.ts#removeProjectMemberCycle"], "project_member", "project-member:<membershipCycle>:removed", "project", payloadSchemas["project.team.member_removed"]),
  "project.deadline.schedule_changed": live("deadline", "TB4B saveProjectDeadlineSchedule", ["workers/app/src/lib/project-deadline.ts#saveProjectDeadlineSchedule"], "project_deadline_schedule", "project-deadline:<projectId>:version:<version>", "project", payloadSchemas["project.deadline.schedule_changed"]),
  "project.priority.changed": live("priority", "project priority route", ["workers/app/src/routes/projects.ts#priority"], "project_priority", "project-priority:<projectId>:change:<activityId>", "project", payloadSchemas["project.priority.changed"]),
  "project.details.changed": live("project_metadata", "project details route", ["workers/app/src/routes/projects.ts#patch"], "project_details", "project-details:<projectId>:change:<activityId>", "project", payloadSchemas["project.details.changed"]),
  "project.archived": live("coordination", "project archive route", ["workers/app/src/routes/projects.ts#archive"], "project", "project:<projectId>:archived:<auditId>", "project", payloadSchemas["project.archived"]),
  "project.restored": live("coordination", "project restore route", ["workers/app/src/routes/projects.ts#restore"], "project", "project:<projectId>:restored:<auditId>", "project", payloadSchemas["project.restored"]),
  "project.checklist.item_created": live("checklist", "project checklist routes", ["workers/app/src/routes/project-subtasks.ts#post"], "project_checklist", "project-checklist:<itemId>:created", "project_collaboration", payloadSchemas["project.checklist.item_created"]),
  "project.checklist.item_updated": live("checklist", "project checklist routes", ["workers/app/src/routes/project-subtasks.ts#patch"], "project_checklist", "project-checklist:<itemId>:updated:<activityId>", "project_collaboration", payloadSchemas["project.checklist.item_updated"]),
  "project.checklist.item_deleted": live("checklist", "project checklist routes", ["workers/app/src/routes/project-subtasks.ts#delete"], "project_checklist", "project-checklist:<itemId>:deleted", "project_collaboration", payloadSchemas["project.checklist.item_deleted"]),
  "project.comment.created": live("comment", "project comment commands", ["workers/app/src/lib/project-comments.ts#createProjectComment"], "project_comment", "project-comment:<commentId>:created", "project_collaboration", payloadSchemas["project.comment.created"]),
  "project.comment.edited": live("comment", "project comment commands", ["workers/app/src/lib/project-comments.ts#editProjectComment"], "project_comment", "project-comment:<commentId>:edited:<activityId>", "project_collaboration", payloadSchemas["project.comment.edited"], { strategy: "leading_edge", keyShape: "project-comment-edit:<projectId>:<commentId>:<actorId>", windowSeconds: 300 }),
  "project.comment.deleted": live("comment", "project comment commands", ["workers/app/src/lib/project-comments.ts#deleteProjectComment"], "project_comment", "project-comment:<commentId>:deleted", "project_collaboration", payloadSchemas["project.comment.deleted"]),
  "project.collection.video_link_added": live("collection_delivery", "manual collection-link routes", ["workers/app/src/routes/collections.ts#post-link"], "project_video_link", "project-video-link:<linkId>:added", "project", payloadSchemas["project.collection.video_link_added"]),
  "project.collection.video_link_changed": live("collection_delivery", "manual collection-link routes", ["workers/app/src/routes/collections.ts#patch-link"], "project_video_link", "project-video-link:<linkId>:changed:<activityId>", "project", payloadSchemas["project.collection.video_link_changed"]),
  "project.collection.video_links_reordered": live("collection_delivery", "manual collection-link routes", ["workers/app/src/routes/collections.ts#reorder-link"], "project_video_links", "project-video-links:<collectionId>:reordered:<activityId>", "project", payloadSchemas["project.collection.video_links_reordered"]),
  "project.collection.video_link_removed": live("collection_delivery", "manual collection-link routes", ["workers/app/src/routes/collections.ts#delete-link"], "project_video_link", "project-video-link:<linkId>:removed", "project", payloadSchemas["project.collection.video_link_removed"]),
  "project.collection.document_completed": live("collection_delivery", "document completion route", ["workers/app/src/routes/collections.ts#complete-document"], "project_document", "project-document:<sessionId>:completed", "project", payloadSchemas["project.collection.document_completed"]),
  "project.workflow.manual_edited_ready": live("review_workflow", "manual edited publication workflow", ["workers/background/src/workflows/manual-edited-publish.ts"], "project_manual_edited", "project-manual-edited:<jobId>:<assetId>:ready", "project", payloadSchemas["project.workflow.manual_edited_ready"], null, "system"),
  "project.collection.raw_sync_completed": live("collection_delivery", "RAW Dropbox reconciliation", ["workers/background/src/dropbox/sync.ts#claim-completion"], "project_raw_sync", "project-raw-sync:<claimId>:completed", "project", payloadSchemas["project.collection.raw_sync_completed"], null, "system"),
  "project.stage.changed": live("stage", "moveProjectStage", ["workers/app/src/lib/project-stage.ts#moveProjectStage"], "project_stage", "project-stage:<projectId>:transition:<activityId>", "project", payloadSchemas["project.stage.changed"]),
  "project.checklist.schedule_changed": live("checklist", "TB4D saveProjectSubtask", ["workers/app/src/lib/project-subtasks.ts#saveProjectSubtask"], "project_checklist", "project-checklist-schedule:<projectId>:<itemId>:version:<version>", "project_collaboration", payloadSchemas["project.checklist.schedule_changed"], { strategy: "leading_edge", keyShape: "project-checklist-schedule:<projectId>:<itemId>:<actorId>", windowSeconds: 300 }, "user", {
    cutoverOwner: "TB4D saveProjectSubtask",
    // Explicit TB4D cutover metadata; do not inherit the TB4C helper default.
    cutoverDate: TB4D_SCHEDULE_ACTIVITY_CUTOVER_DATE,
    noBackfillNote: "TB4D has no checklist schedule history backfill; only post-cutover committed schedule winners emit this type.",
  }),
  "project.workflow.raw_ready": reserved("workflow", "future canonical workflow owner", "project_workflow", "project-workflow:<projectId>:raw-ready:<transitionId>", "project"),
  "project.workflow.sent_to_editing": reserved("workflow", "future canonical workflow owner", "project_workflow", "project-workflow:<projectId>:sent-to-editing:<transitionId>", "project"),
  "project.workflow.edited_ready": reserved("workflow", "future canonical workflow owner", "project_workflow", "project-workflow:<projectId>:edited-ready:<transitionId>", "project"),
  "project.workflow.delivered": reserved("workflow", "future canonical workflow owner", "project_workflow", "project-workflow:<projectId>:delivered:<transitionId>", "project"),
} as const satisfies Record<ProjectActivityType, RegistryEntry>;

export type ProjectActivityRegistry = typeof PROJECT_ACTIVITY_REGISTRY;

export type ProjectActivityIntent = {
  schemaVersion: 1;
  activity: {
    id: string;
    type: ProjectActivityType;
    projectId: string;
    actorId: string | null;
    actorKind?: ActorKind;
    occurredAt: string | number;
    source: { kind: string; id: string; key: string };
    safePayload: unknown;
    deepLink: { kind: DeepLinkKind; path: string };
  };
  broadDelivery: {
    registryKey: ProjectActivityType;
    sourceActivityId: string;
    coalesce: null | { key: string; windowSeconds: 300 };
  };
};

export type ParsedProjectActivityIntent = Omit<ProjectActivityIntent, "activity"> & {
  activity: Omit<ProjectActivityIntent["activity"], "occurredAt" | "actorKind" | "safePayload"> & {
    actorKind: ActorKind;
    occurredAt: number;
    safePayload: ProjectActivityPayload;
  };
};

function expectedDeepLink(type: ProjectActivityType, projectId: string): { kind: DeepLinkKind; path: string } {
  return PROJECT_ACTIVITY_REGISTRY[type].deepLinkKind === "project_collaboration"
    ? { kind: "project_collaboration", path: staffPathFor({ kind: "project", projectId, collaboration: "open" }) }
    : { kind: "project", path: staffPathFor({ kind: "project", projectId }) };
}

export function projectActivityDeepLink(type: ProjectActivityType, projectId: string) {
  return expectedDeepLink(type, projectId);
}

function sourceKeyMatches(type: ProjectActivityType, sourceId: string, key: string, projectId?: string): boolean {
  const exact = (prefix: string, suffix: string) => key === `${prefix}${sourceId}${suffix}`;
  const oneToken = (prefix: string, suffix: string) => {
    const start = `${prefix}${sourceId}${suffix}`;
    const token = key.startsWith(start) ? key.slice(start.length) : "";
    return token.length > 0 && !token.includes(":");
  };
  const projectToken = (verb: string) => {
    const start = `project:${sourceId}:${verb}:`;
    const token = key.startsWith(start) ? key.slice(start.length) : "";
    return token.length > 0 && !token.includes(":");
  };
  switch (type) {
    case "project.team.member_added": return exact("project-member:", ":added");
    case "project.team.member_removed": return exact("project-member:", ":removed");
    case "project.deadline.schedule_changed": return key.startsWith(`project-deadline:${sourceId}:version:`) && /^project-deadline:[^:]+:version:\d+$/.test(key);
    case "project.priority.changed": return oneToken("project-priority:", ":change:");
    case "project.details.changed": return oneToken("project-details:", ":change:");
    case "project.archived": return projectToken("archived");
    case "project.restored": return projectToken("restored");
    case "project.checklist.item_created": return exact("project-checklist:", ":created");
    case "project.checklist.item_updated": return oneToken("project-checklist:", ":updated:");
    case "project.checklist.item_deleted": return exact("project-checklist:", ":deleted");
    case "project.comment.created": return exact("project-comment:", ":created");
    case "project.comment.edited": return oneToken("project-comment:", ":edited:");
    case "project.comment.deleted": return exact("project-comment:", ":deleted");
    case "project.collection.video_link_added": return exact("project-video-link:", ":added");
    case "project.collection.video_link_changed": return oneToken("project-video-link:", ":changed:");
    case "project.collection.video_links_reordered": return oneToken("project-video-links:", ":reordered:");
    case "project.collection.video_link_removed": return exact("project-video-link:", ":removed");
    case "project.collection.document_completed": return exact("project-document:", ":completed");
    case "project.workflow.manual_edited_ready": {
      const prefix = "project-manual-edited:";
      const suffix = `:${sourceId}:ready`;
      const token = key.startsWith(prefix) && key.endsWith(suffix) ? key.slice(prefix.length, key.length - suffix.length) : "";
      return token.length > 0 && !token.includes(":");
    }
    case "project.collection.raw_sync_completed": return exact("project-raw-sync:", ":completed");
    case "project.stage.changed": return projectId !== undefined && key === `project-stage:${projectId}:transition:${sourceId}`;
    case "project.checklist.schedule_changed": {
      const match = /^project-checklist-schedule:([^:]+):([^:]+):version:(\d+)$/.exec(key);
      return Boolean(match && match[2] === sourceId && Number(match[3]) >= 1);
    }
    case "project.workflow.raw_ready":
    case "project.workflow.sent_to_editing":
    case "project.workflow.edited_ready":
    case "project.workflow.delivered": return key.startsWith("project-workflow:");
  }
}

function parseOccurredAt(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value ? date.getTime() : null;
}

function scheduleSourceIdentityMatches(projectId: string, sourceId: string, key: string, payload: unknown): boolean {
  const match = /^project-checklist-schedule:([^:]+):([^:]+):version:(\d+)$/.exec(key);
  if (!match || match[1] !== projectId || match[2] !== sourceId) return false;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  return value.itemId === sourceId && typeof value.version === "number" && Number.isSafeInteger(value.version)
    && value.version >= 1 && String(value.version) === match[3];
}

export function projectActivityCoalesce(type: ProjectActivityType, projectId: string, actorId: string | null, payload?: unknown): ProjectActivityCoalescing {
  if (type === "project.comment.edited" && actorId) {
    const parsed = payloadSchemas[type].safeParse(payload);
    if (!parsed.success) return null;
    return { strategy: "leading_edge", key: `project-comment-edit:${projectId}:${parsed.data.commentId}:${actorId}`, windowSeconds: 300 };
  }
  if (type === "project.checklist.schedule_changed" && actorId && payload && typeof payload === "object" && "itemId" in payload) {
    return { strategy: "leading_edge", key: `project-checklist-schedule:${projectId}:${String((payload as { itemId: unknown }).itemId)}:${actorId}`, windowSeconds: 300 };
  }
  return null;
}

/** Runtime gate for every producer intent. Dates are normalized to epoch milliseconds here. */
export function parseProjectActivityIntent(value: unknown): ParsedProjectActivityIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== PROJECT_ACTIVITY_SCHEMA_VERSION || !candidate.activity || !candidate.broadDelivery) return null;
  const activity = candidate.activity as Record<string, unknown>;
  const broad = candidate.broadDelivery as Record<string, unknown>;
  const type = activity.type;
  if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(PROJECT_ACTIVITY_REGISTRY, type)) return null;
  const typed = type as ProjectActivityType;
  const entry = PROJECT_ACTIVITY_REGISTRY[typed];
  if (entry.cutover !== "live") return null;
  if (typeof activity.id !== "string" || !activityId.safeParse(activity.id).success || typeof activity.projectId !== "string" || !activity.projectId || typeof activity.actorId !== "string" && activity.actorId !== null) return null;
  const parsedActivityId = activity.id;
  const actorKind: ActorKind = activity.actorKind === undefined ? (activity.actorId === null ? "system" : "user") : activity.actorKind as ActorKind;
  if ((actorKind === "user" && (!activity.actorId || activity.actorId === PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID)) || (actorKind === "system" && activity.actorId !== null) || (actorKind !== "user" && actorKind !== "system")) return null;
  if (entry.actorRule !== actorKind) return null;
  const occurredAt = parseOccurredAt(activity.occurredAt);
  if (occurredAt === null) return null;
  const source = activity.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const sourceRecord = source as Record<string, unknown>;
  if (sourceRecord.kind !== entry.sourceKind || typeof sourceRecord.id !== "string" || !sourceRecord.id || typeof sourceRecord.key !== "string" || !sourceRecord.key || !sourceKeyMatches(typed, sourceRecord.id, sourceRecord.key, activity.projectId)) return null;
  const safePayload = entry.payloadSchema.safeParse(activity.safePayload);
  if (!safePayload.success || JSON.stringify(safePayload.data).length > 4_096) return null;
  if (typed === "project.checklist.schedule_changed" && !scheduleSourceIdentityMatches(activity.projectId, sourceRecord.id, sourceRecord.key, safePayload.data)) return null;
  const deepLink = activity.deepLink;
  const expected = expectedDeepLink(typed, activity.projectId);
  if (!deepLink || typeof deepLink !== "object" || Array.isArray(deepLink) || (deepLink as Record<string, unknown>).kind !== expected.kind || (deepLink as Record<string, unknown>).path !== expected.path) return null;
  if (broad.registryKey !== typed || broad.sourceActivityId !== activity.id || !Object.prototype.hasOwnProperty.call(broad, "coalesce")) return null;
  const expectedCoalesce = projectActivityCoalesce(typed, activity.projectId, activity.actorId, safePayload.data);
  if (expectedCoalesce === null) {
    if (broad.coalesce !== null) return null;
  } else {
    if (!broad.coalesce || typeof broad.coalesce !== "object" || Array.isArray(broad.coalesce)) return null;
    const actualCoalesce = broad.coalesce as Record<string, unknown>;
    if (actualCoalesce.key !== expectedCoalesce.key || actualCoalesce.windowSeconds !== expectedCoalesce.windowSeconds) return null;
  }
  return {
    schemaVersion: 1,
    activity: {
      id: parsedActivityId,
      type: typed,
      projectId: activity.projectId,
      actorId: activity.actorId,
      actorKind,
      occurredAt,
      source: { kind: sourceRecord.kind as string, id: sourceRecord.id, key: sourceRecord.key },
      safePayload: safePayload.data as ProjectActivityPayload,
      deepLink: { kind: expected.kind, path: expected.path },
    },
    broadDelivery: {
      registryKey: typed,
      sourceActivityId: parsedActivityId,
      coalesce: expectedCoalesce ? { key: expectedCoalesce.key, windowSeconds: expectedCoalesce.windowSeconds } : null,
    },
  };
}

export type ProjectActivityRow = ParsedProjectActivityIntent["activity"] & { category: ProjectActivityCategory; createdAt: number };

export type ProjectActivityFeedRow = {
  id: string;
  type: ProjectActivityLiveType;
  category: ProjectActivityCategory;
  occurredAt: number;
  actorId: string | null;
  actorKind: ActorKind;
  safePayload: ProjectActivityPayload;
};

function parseProjectActivityFeedRow(value: unknown): ProjectActivityFeedRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = row.id;
  const type = row.event_type ?? row.eventType;
  const category = row.category;
  const occurredAt = row.occurred_at ?? row.occurredAt;
  const actorId = row.actor_id ?? row.actorId ?? null;
  if (typeof id !== "string" || id.length === 0 || !CANONICAL_LOWERCASE_UUID_REGEX.test(id) || !isProjectActivityLiveType(type)) return null;
  if (category !== PROJECT_ACTIVITY_REGISTRY[type].category) return null;
  if (typeof occurredAt !== "number" || !Number.isSafeInteger(occurredAt) || occurredAt < 0) return null;
  if (actorId !== null && (typeof actorId !== "string" || actorId.length === 0)) return null;
  let payload: unknown;
  try { payload = JSON.parse(String(row.safe_payload_json ?? row.safePayloadJson)); } catch { return null; }
  const parsedPayload = PROJECT_ACTIVITY_REGISTRY[type].payloadSchema.safeParse(payload);
  if (!parsedPayload.success) return null;
  const actorKind: ActorKind = actorId === null ? "system" : "user";
  if (PROJECT_ACTIVITY_REGISTRY[type].actorRule !== actorKind) return null;
  return { id, type, category: category as ProjectActivityCategory, occurredAt, actorId, actorKind, safePayload: parsedPayload.data as ProjectActivityPayload };
}

/** Parses only the immutable DB projection; no outbox or actor profile is dereferenced here. */
export function parseProjectActivityRow(value: unknown, projection: "feed"): ProjectActivityFeedRow | null;
export function parseProjectActivityRow(value: unknown): ProjectActivityRow | null;
export function parseProjectActivityRow(value: unknown, projection?: "feed"): ProjectActivityRow | ProjectActivityFeedRow | null {
  if (projection === "feed") return parseProjectActivityFeedRow(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const get = (camel: string, snake: string) => row[camel] ?? row[snake];
  // The intent boundary accepts canonical ISO strings for request-owned producers;
  // the immutable DB projection must prove D1 stored an integer, not re-normalize it.
  if (typeof get("occurredAt", "occurred_at") !== "number") return null;
  let payload: unknown;
  try { payload = JSON.parse(String(get("safePayloadJson", "safe_payload_json"))); } catch { return null; }
  const intent = parseProjectActivityIntent({
    schemaVersion: get("schemaVersion", "schema_version"),
    activity: {
      id: get("id", "id"), type: get("eventType", "event_type"), projectId: get("projectId", "project_id"),
      actorId: get("actorId", "actor_id"), actorKind: get("actorKind", "actor_kind"), occurredAt: get("occurredAt", "occurred_at"),
      source: { kind: get("sourceKind", "source_kind"), id: get("sourceId", "source_id"), key: get("sourceKey", "source_key") },
      safePayload: payload, deepLink: { kind: get("deepLinkKind", "deep_link_kind"), path: get("deepLinkPath", "deep_link_path") },
    },
    broadDelivery: { registryKey: get("eventType", "event_type"), sourceActivityId: get("id", "id"), coalesce: projectActivityCoalesce(get("eventType", "event_type") as ProjectActivityType, String(get("projectId", "project_id")), get("actorId", "actor_id") as string | null, payload) },
  });
  if (!intent) return null;
  const category = PROJECT_ACTIVITY_REGISTRY[intent.activity.type].category;
  const createdAt = get("createdAt", "created_at");
  if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt)) return null;
  return { ...intent.activity, category, createdAt };
}

export type ProjectActivityNotificationCopy = { title: string; body: string };

export function renderProjectActivityNotification(
  type: ProjectActivityType,
  payload: unknown,
  projectLabel = "Project",
  actorName?: string | null,
): ProjectActivityNotificationCopy {
  const safe = PROJECT_ACTIVITY_REGISTRY[type].payloadSchema.safeParse(payload).success ? payload as Record<string, unknown> : {};
  const actor = actorName ? `${actorName} — ` : "";
  switch (type) {
    case "project.team.member_added":
    case "project.team.member_removed": return { title: "Project team updated", body: `${actor}${projectLabel} team was updated.` };
    case "project.deadline.schedule_changed": return { title: "Deadline schedule updated", body: `${actor}${projectLabel} deadline schedule was ${safe.operation === "clear" ? "cleared" : safe.operation === "resume" ? "resumed" : "updated"}.` };
    case "project.priority.changed": return { title: "Project priority changed", body: `${actor}${projectLabel} priority changed.` };
    case "project.details.changed": return { title: "Project details updated", body: `${actor}${projectLabel} details were updated.` };
    case "project.archived": return { title: "Project archived", body: `${actor}${projectLabel} was archived.` };
    case "project.restored": return { title: "Project restored", body: `${actor}${projectLabel} was restored.` };
    case "project.checklist.item_created": return { title: "Checklist item added", body: `${actor}Checklist “${String(safe.checklistTitle ?? "item")}” was added.` };
    case "project.checklist.item_updated": return { title: "Checklist item updated", body: `${actor}Checklist “${String(safe.checklistTitle ?? "item")}” was updated.` };
    case "project.checklist.item_deleted": return { title: "Checklist item removed", body: `${actor}Checklist “${String(safe.checklistTitle ?? "item")}” was removed.` };
    case "project.comment.created": return { title: "Project comment added", body: `${actor}A project comment was added.` };
    case "project.comment.edited": return { title: "Project comment edited", body: `${actor}A project comment was edited.` };
    case "project.comment.deleted": return { title: "Project comment removed", body: `${actor}A project comment was removed.` };
    case "project.collection.video_link_added":
    case "project.collection.video_link_changed":
    case "project.collection.video_links_reordered":
    case "project.collection.video_link_removed": return { title: "Video links updated", body: `${actor}${projectLabel} video links were updated.` };
    case "project.collection.document_completed": return { title: "Document upload completed", body: `${actor}${projectLabel} copy or floorplan upload completed.` };
    case "project.workflow.manual_edited_ready": return { title: "Edited media is ready", body: `${actor}${projectLabel} edited media is ready.` };
    case "project.collection.raw_sync_completed": return { title: "RAW import completed", body: `${actor}${projectLabel} RAW import completed (${String(safe.importedCount ?? 0)} items).` };
    case "project.checklist.schedule_changed": return { title: "Checklist schedule updated", body: `${actor}Checklist “${String(safe.checklistTitle ?? "item")}” schedule was updated.` };
    case "project.stage.changed":
    case "project.workflow.raw_ready":
    case "project.workflow.sent_to_editing":
    case "project.workflow.edited_ready":
    case "project.workflow.delivered": return { title: "Project activity", body: `${projectLabel} has a project update.` };
  }
}

/** The parser's expected coalescing shape, kept exported for registry and DB tests. */
export function projectActivityCoalescingDeclaration(type: ProjectActivityType) {
  return PROJECT_ACTIVITY_REGISTRY[type].coalescing;
}
