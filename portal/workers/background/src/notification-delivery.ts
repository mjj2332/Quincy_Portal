import {
  NOTIFICATION_DLQ_QUEUE_NAME,
  NOTIFICATION_OUTBOX_EVENT_TYPE,
  NOTIFICATION_OUTBOX_EVENT_TYPES,
  NOTIFICATION_QUEUE_NAME,
  NotificationOutboxMessage,
  PROJECT_ASSIGNMENT_ELIGIBLE_ROLES,
  PROJECT_ACTIVITY_REGISTRY,
  PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID,
  parseProjectActivityRow,
  parseNotificationOutboxMessage,
  publishNotificationOutbox,
  projectActivityCoalesce,
  projectActivityCoalescingDeclaration,
  renderProjectActivityNotification,
  EXTERNAL_PROJECT_ACTIVITY_POLICY,
  EXTERNAL_LEGACY_NOTIFICATION_POLICY,
  NOTIFICATION_TYPES,
  externalNotificationCopy,
  parseExternalNotificationOutboxPayload,
  projectExternalActivityPayload,
  roleHasCapability,
  isProjectAssignmentEligible,
  staffPathFor,
  truncateForEmail,
  formatSydneyInstant,
  formatSydneyCivil,
  type Role,
  type ProjectAssignmentCreatedPayload,
  type ProjectDeadlineReminderOutboxPayload,
  type ExternalNotificationOutboxPayload,
  type NotificationType,
} from "@quincy/shared";
import type { Env } from "./env";

export const NOTIFICATION_DELIVERY_LEASE_MS = 10 * 60_000;
export const NOTIFICATION_QUEUE_STUCK_MS = 30 * 60_000;
export const NOTIFICATION_RECOVERY_LIMIT = 100;
export const NOTIFICATION_QUEUE_MAX_DELAY_SECONDS = 12 * 60 * 60;
export const PROJECT_DEADLINE_OPERATIONAL_TARGET_MS = 120_000;
const htmlEscape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));

type OutboxRow = {
  id: string;
  schema_version: number;
  event_type: string;
  source_key: string;
  project_id: string;
  actor_id: string;
  recipient_id: string;
  payload_json: string;
  status: string;
  available_at: number;
  queue_published_at: number | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  delivery_attempts: number;
  coalesce_key: string | null;
  coalesce_until: number | null;
  recipient_membership_cycle_id: string | null;
  recipient_authorization_epoch: number | null;
};

type BroadResolverRow = {
  outboxId: string;
  schemaVersion: number;
  eventType: string;
  sourceKey: string;
  projectId: string;
  actorId: string;
  recipientId: string;
  payloadJson: string;
  coalesceKey: string | null;
  coalesceUntil: number | null;
  recipientMembershipCycleId: string | null;
  recipientActive: number | null;
  recipientRole: string | null;
  recipientName: string | null;
  projectStreet: string | null;
  membershipId: string | null;
  membershipCreatedAt: number | null;
  activityId: string | null;
  activitySchemaVersion: number | null;
  activityEventType: string | null;
  activityCategory: string | null;
  activityProjectId: string | null;
  activityActorKind: string | null;
  activityActorId: string | null;
  activityOccurredAt: number | null;
  activitySourceKind: string | null;
  activitySourceId: string | null;
  activitySourceKey: string | null;
  activitySafePayloadJson: string | null;
  activityDeepLinkKind: string | null;
  activityDeepLinkPath: string | null;
  activityCreatedAt: number | null;
  activityActorName: string | null;
};

type ResolverRow = {
  outboxId: string;
  schemaVersion: number;
  eventType: string;
  sourceKey: string;
  projectId: string;
  actorId: string;
  recipientId: string;
  payloadJson: string;
  recipientActive: number;
  recipientRole: string;
  recipientName: string;
  recipientEmail: string;
  recipientAuthorizationEpoch: number | null;
  currentAuthorizationEpoch: number | null;
  recipientMembershipCycleId: string | null;
  projectStreet: string | null;
  projectArchivedAt: number | null;
  commentId: string | null;
  commentProjectId: string | null;
  commentBody: string | null;
  authorId: string | null;
  authorName: string | null;
  mappingId: string | null;
  mappingRecipientId: string | null;
  mappingCommentId: string | null;
  membershipId: string | null;
  membershipCreatedAt: number | null;
};

type ReminderResolverRow = {
  outboxId: string;
  schemaVersion: number;
  eventType: string;
  sourceKey: string;
  projectId: string;
  actorId: string;
  recipientId: string;
  payloadJson: string;
  recipientActive: number;
  recipientRole: string;
  recipientName: string;
  recipientEmail: string;
  recipientAuthorizationEpoch: number | null;
  currentAuthorizationEpoch: number | null;
  projectStreet: string | null;
  projectArchivedAt: number | null;
  projectStageKey: string | null;
  projectDeadlineVersion: number | null;
  occurrenceId: string | null;
  occurrenceStatus: string | null;
  occurrenceFiredAt: number | null;
  occurrenceScheduleVersion: number | null;
  occurrenceKind: string | null;
  occurrenceOffsetMinutes: number | null;
  occurrenceDeadlineAt: number | null;
  occurrenceDeadlineLocalCivil: string | null;
  occurrenceDeadlineZone: string | null;
  occurrenceUtcOffsetMinutes: number | null;
  occurrenceFold: number | null;
  membershipId: string | null;
  membershipCreatedAt: number | null;
  membershipRole: string | null;
};

type ExternalSubtaskResolverRow = {
  outboxId: string;
  schemaVersion: number;
  eventType: string;
  sourceKey: string;
  projectId: string;
  actorId: string;
  recipientId: string;
  payloadJson: string;
  recipientAuthorizationEpoch: number | null;
  currentAuthorizationEpoch: number | null;
  recipientActive: number;
  recipientRole: string;
  recipientName: string;
  recipientEmail: string;
  projectStreet: string | null;
  projectArchivedAt: number | null;
  membershipId: string | null;
  membershipCreatedAt: number | null;
  subtaskId: string | null;
  subtaskProjectId: string | null;
  subtaskAssigneeId: string | null;
  subtaskAssignmentVersion: number | null;
  subtaskDueDate: string | null;
  subtaskDueReminderSentAt: number | null;
};

type ProjectCommentMentionPayload = {
  schemaVersion: 1;
  event: { type: "project.comment.mentioned"; sourceKey: string; recipientId: string };
  authorizationAtOccurrence:
    | { kind: "admin" }
    | { kind: "project_member"; membershipIds: string[] };
  projectCommentActivity: {
    schemaVersion: 1;
    activity: {
      id: string;
      type: "project.comment.created" | "project.comment.edited" | "project.comment.deleted";
      projectId: string;
      actorId: string;
      occurredAt: string;
      source: { kind: "project_comment"; id: string; key: string };
      safePayload: { commentId: string };
      deepLink: { kind: "project_collaboration"; path: string };
    };
    broadDelivery: {
      registryKey: "project.comment.created" | "project.comment.edited" | "project.comment.deleted";
      sourceActivityId: string;
      coalesce: null | { key: string; windowSeconds: 300 };
    };
    targetedMentionDelivery: false;
  };
};

type ResolvedDelivery = {
  notificationType: NotificationType | "project_activity" | "project_collaboration_activity";
  title: string;
  body: string;
  emailSubject: string;
  emailText: string;
  emailHtml: string;
};

type LegacyResolvedRecipient = {
  ok: true;
  kind: "legacy";
  row: ResolverRow | ReminderResolverRow;
  payload: ProjectCommentMentionPayload | ProjectAssignmentCreatedPayload | ProjectDeadlineReminderOutboxPayload | ExternalNotificationOutboxPayload;
  commentPath: string;
  delivery: ResolvedDelivery;
};

type BroadResolvedRecipient = {
  ok: true;
  kind: "broad";
  row: BroadResolverRow;
  activity: NonNullable<ReturnType<typeof parseProjectActivityRow>>;
  delivery: ResolvedDelivery;
  commentPath: string;
};

export type ProjectActivityPermanentCode =
  | "project_activity_payload_invalid"
  | "project_activity_missing"
  | "project_activity_invalid"
  | "project_activity_project_mismatch"
  | "project_activity_type_reserved";

type RecipientResolution =
  | LegacyResolvedRecipient
  | BroadResolvedRecipient
  | { ok: false; kind: "suppress"; code: AuthorizationSuppressionCode; reason: string }
  | { ok: false; kind: "permanent"; code: ProjectActivityPermanentCode; reason: string };

type ResolvedRecipient = RecipientResolution;

type AuthorizationSuppressionCode = "reauthorization_suppressed" | "authorization_epoch_changed";

function suppressed(reason: string, code: AuthorizationSuppressionCode = reason === "authorization_epoch_changed" ? "authorization_epoch_changed" : "reauthorization_suppressed") {
  return { ok: false as const, kind: "suppress" as const, code, reason };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function safeReminderPayload(value: string, outbox: OutboxRow): ProjectDeadlineReminderOutboxPayload | null {
  if (outbox.schema_version !== 1 || outbox.event_type !== NOTIFICATION_OUTBOX_EVENT_TYPES.projectDeadlineReminder) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isObject(parsed) || !hasExactKeys(parsed, ["schemaVersion", "event", "authorizationAtOccurrence", "reminder"]) || parsed.schemaVersion !== 1) return null;
    const event = parsed.event;
    const authorization = parsed.authorizationAtOccurrence;
    const reminder = parsed.reminder;
    if (!isObject(event) || !hasExactKeys(event, ["type", "sourceKey", "recipientId"]) || event.type !== NOTIFICATION_OUTBOX_EVENT_TYPES.projectDeadlineReminder || typeof event.sourceKey !== "string" || typeof event.recipientId !== "string") return null;
    if (!isObject(authorization) || !hasExactKeys(authorization, ["kind", "membershipCycle", "startedAt"]) || authorization.kind !== "project_editor_membership" || typeof authorization.membershipCycle !== "string" || typeof authorization.startedAt !== "number" || !Number.isSafeInteger(authorization.startedAt)) return null;
    if (!isObject(reminder) || !hasExactKeys(reminder, ["occurrenceId", "projectId", "scheduleVersion", "kind", "offsetMinutes", "deadlineAt", "deadlineLocalCivil", "zone", "utcOffsetMinutes", "fold"])) return null;
    const occurrenceId = reminder.occurrenceId;
    const projectId = reminder.projectId;
    const scheduleVersion = reminder.scheduleVersion;
    const kind = reminder.kind;
    const offsetMinutes = reminder.offsetMinutes;
    const deadlineAt = reminder.deadlineAt;
    const deadlineLocalCivil = reminder.deadlineLocalCivil;
    const zone = reminder.zone;
    const utcOffsetMinutes = reminder.utcOffsetMinutes;
    const fold = reminder.fold;
    if (typeof occurrenceId !== "string" || typeof projectId !== "string" || typeof scheduleVersion !== "number" || !Number.isSafeInteger(scheduleVersion) || scheduleVersion < 1 || (kind !== "advance" && kind !== "due_now") || typeof offsetMinutes !== "number" || !Number.isSafeInteger(offsetMinutes) || (kind === "due_now" ? offsetMinutes !== 0 : offsetMinutes < 1 || offsetMinutes > 43200) || typeof deadlineAt !== "string" || typeof deadlineLocalCivil !== "string" || zone !== "Australia/Sydney" || typeof utcOffsetMinutes !== "number" || !Number.isSafeInteger(utcOffsetMinutes) || utcOffsetMinutes < -840 || utcOffsetMinutes > 840 || (fold !== 0 && fold !== 1)) return null;
    const deadline = new Date(deadlineAt);
    if (!Number.isFinite(deadline.valueOf()) || deadline.toISOString() !== deadlineAt) return null;
    if (event.sourceKey !== outbox.source_key || event.recipientId !== outbox.recipient_id || occurrenceId !== outbox.source_key || projectId !== outbox.project_id) return null;
    return parsed as ProjectDeadlineReminderOutboxPayload;
  } catch {
    return null;
  }
}

function safeAssignmentPayload(value: string, outbox: OutboxRow): ProjectAssignmentCreatedPayload | null {
  if (outbox.schema_version !== 1 || outbox.event_type !== NOTIFICATION_OUTBOX_EVENT_TYPES.projectAssignmentCreated) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    const object = (candidate: unknown): candidate is Record<string, unknown> => Boolean(candidate && typeof candidate === "object" && !Array.isArray(candidate));
    const exactKeys = (candidate: Record<string, unknown>, keys: string[]) => Object.keys(candidate).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(candidate, key));
    if (!object(parsed) || !exactKeys(parsed, ["schemaVersion", "event", "assignment"]) || parsed.schemaVersion !== 1) return null;
    const event = parsed.event;
    const assignment = parsed.assignment;
    if (!object(event) || !exactKeys(event, ["type", "sourceKey", "recipientId"]) || event.type !== NOTIFICATION_OUTBOX_EVENT_TYPES.projectAssignmentCreated || typeof event.sourceKey !== "string" || typeof event.recipientId !== "string") return null;
    if (!object(assignment) || !exactKeys(assignment, ["projectId", "userId", "roleOnProject", "membershipCycle"])) return null;
    if (typeof assignment.projectId !== "string" || typeof assignment.userId !== "string" || typeof assignment.membershipCycle !== "string" || (assignment.roleOnProject !== "photographer" && assignment.roleOnProject !== "editor")) return null;
    if (event.sourceKey !== outbox.source_key || event.recipientId !== outbox.recipient_id || assignment.projectId !== outbox.project_id || assignment.userId !== outbox.recipient_id || assignment.membershipCycle !== outbox.source_key) return null;
    return parsed as ProjectAssignmentCreatedPayload;
  } catch {
    return null;
  }
}

function isLegacyNotificationType(value: string): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

async function resolveExternalSafeDirectRecipient(env: Env, outbox: OutboxRow): Promise<LegacyResolvedRecipient | Extract<ResolvedRecipient, { ok: false }>> {
  const payload = parseExternalNotificationOutboxPayload(outbox.payload_json);
  if (!payload || !("legacy" in payload) || payload.event.type !== "project.external_safe.direct") return suppressed("payload_invalid");
  if (!isLegacyNotificationType(payload.legacy.type)) return suppressed("external_policy_suppressed");
  const policy = EXTERNAL_LEGACY_NOTIFICATION_POLICY[payload.legacy.type];
  if (policy.decision !== "allowed" || policy.durableEvent !== "project.external_safe.direct") return suppressed("external_policy_suppressed");
  const row = await env.DB.prepare(`
    SELECT o.id AS outboxId, o.schema_version AS schemaVersion, o.event_type AS eventType,
      o.source_key AS sourceKey, o.project_id AS projectId, o.actor_id AS actorId,
      o.recipient_id AS recipientId, o.payload_json AS payloadJson,
      o.recipient_authorization_epoch AS recipientAuthorizationEpoch,
      recipient.authorization_epoch AS currentAuthorizationEpoch,
      recipient.active AS recipientActive, recipient.role AS recipientRole,
      recipient.name AS recipientName, recipient.email AS recipientEmail,
      project.street AS projectStreet, project.archived_at AS projectArchivedAt,
      member.id AS membershipId, member.created_at AS membershipCreatedAt
    FROM notification_outbox o
    INNER JOIN user recipient ON recipient.id = o.recipient_id
    INNER JOIN projects project ON project.id = o.project_id
    INNER JOIN project_members member ON member.id = o.recipient_membership_cycle_id
      AND member.project_id = o.project_id AND member.user_id = o.recipient_id AND member.role_on_project = 'editor'
    WHERE o.id = ?
  `).bind(outbox.id).first<ResolverRow>();
  if (!row || row.schemaVersion !== 1 || row.eventType !== "project.external_safe.direct" || row.sourceKey !== payload.event.sourceKey || row.recipientId !== payload.event.recipientId || row.projectId !== payload.legacy.projectId || row.recipientMembershipCycleId !== payload.authorizationAtOccurrence.membershipCycle || row.membershipId !== payload.authorizationAtOccurrence.membershipCycle || row.membershipCreatedAt !== payload.authorizationAtOccurrence.startedAt) return suppressed("payload_invalid");
  if (row.projectArchivedAt !== null || !row.projectStreet) return suppressed("project_no_longer_visible");
  if (row.recipientActive !== 1 || row.recipientRole !== "external_editor") return suppressed("recipient_ineligible");
  if (row.recipientAuthorizationEpoch === null || row.currentAuthorizationEpoch !== row.recipientAuthorizationEpoch) return suppressed("authorization_epoch_changed");
  const copy = externalNotificationCopy({ type: payload.legacy.type });
  const projectPath = `${env.APP_ORIGIN}/projects/${row.projectId}`;
  return {
    ok: true,
    kind: "legacy",
    row,
    payload,
    commentPath: projectPath,
    delivery: {
      notificationType: payload.legacy.type,
      title: copy.title,
      body: copy.body,
      emailSubject: copy.title,
      emailText: `${copy.body}\n\n${projectPath}`,
      emailHtml: `<p>${htmlEscape(copy.body)}</p><p><a href="${htmlEscape(projectPath)}">View project</a></p>`,
    },
  };
}

async function resolveExternalSubtaskRecipient(env: Env, outbox: OutboxRow): Promise<LegacyResolvedRecipient | Extract<ResolvedRecipient, { ok: false }>> {
  const payload = parseExternalNotificationOutboxPayload(outbox.payload_json);
  if (!payload || !("assignment" in payload) || payload.event.type !== outbox.event_type) return suppressed("payload_invalid");
  const expectedType = outbox.event_type === "project.subtask.assigned" ? "subtask_assigned" : outbox.event_type === "project.subtask.due_today" ? "subtask_due_today" : null;
  if (!expectedType || payload.event.sourceKey !== outbox.source_key || payload.event.recipientId !== outbox.recipient_id) return suppressed("payload_invalid");
  const row = await env.DB.prepare(`
    SELECT o.id AS outboxId, o.schema_version AS schemaVersion, o.event_type AS eventType,
      o.source_key AS sourceKey, o.project_id AS projectId, o.actor_id AS actorId,
      o.recipient_id AS recipientId, o.payload_json AS payloadJson,
      o.recipient_authorization_epoch AS recipientAuthorizationEpoch,
      recipient.authorization_epoch AS currentAuthorizationEpoch,
      recipient.active AS recipientActive, recipient.role AS recipientRole,
      recipient.name AS recipientName, recipient.email AS recipientEmail,
      p.street AS projectStreet, p.archived_at AS projectArchivedAt,
      member.id AS membershipId, member.created_at AS membershipCreatedAt,
      subtask.id AS subtaskId, subtask.project_id AS subtaskProjectId,
      subtask.assignee_id AS subtaskAssigneeId, subtask.assignment_version AS subtaskAssignmentVersion,
      subtask.due_date AS subtaskDueDate, subtask.due_reminder_sent_at AS subtaskDueReminderSentAt
    FROM notification_outbox o
    LEFT JOIN user recipient ON recipient.id = o.recipient_id
    LEFT JOIN projects p ON p.id = o.project_id
    LEFT JOIN project_members member ON member.id = o.recipient_membership_cycle_id
      AND member.project_id = o.project_id AND member.user_id = o.recipient_id AND member.role_on_project = 'editor'
    LEFT JOIN project_subtasks subtask ON subtask.id = json_extract(o.payload_json, '$.assignment.subtaskId')
      AND subtask.project_id = o.project_id
    WHERE o.id = ?
  `).bind(outbox.id).first<ExternalSubtaskResolverRow>();
  if (!row || row.schemaVersion !== 1 || row.eventType !== outbox.event_type || row.sourceKey !== payload.event.sourceKey || row.recipientId !== payload.event.recipientId || row.projectId !== payload.assignment.projectId || row.subtaskId !== payload.assignment.subtaskId || row.subtaskProjectId !== row.projectId || row.subtaskAssigneeId !== payload.assignment.assigneeId || row.subtaskAssigneeId !== row.recipientId || row.subtaskAssignmentVersion !== payload.assignment.assignmentVersion || row.membershipId !== payload.authorizationAtOccurrence.membershipCycle || row.membershipCreatedAt !== payload.authorizationAtOccurrence.startedAt || row.recipientAuthorizationEpoch === null || row.currentAuthorizationEpoch !== row.recipientAuthorizationEpoch) return suppressed(row?.recipientAuthorizationEpoch !== row?.currentAuthorizationEpoch ? "authorization_epoch_changed" : "payload_invalid");
  if (row.projectArchivedAt !== null || !row.projectStreet) return suppressed("project_no_longer_visible");
  if (row.recipientActive !== 1 || row.recipientRole !== "external_editor") return suppressed("recipient_ineligible");
  if (payload.event.type !== (expectedType === "subtask_assigned" ? "project.subtask.assigned" : "project.subtask.due_today")) return suppressed("payload_invalid");
  if (expectedType === "subtask_due_today" && (!("dueDate" in payload.assignment) || payload.assignment.dueDate !== row.subtaskDueDate || payload.assignment.claimAt !== row.subtaskDueReminderSentAt)) return suppressed("subtask_changed");
  const copy = externalNotificationCopy({ type: expectedType });
  const projectPath = `${env.APP_ORIGIN}/projects/${row.projectId}`;
  return {
    ok: true,
    kind: "legacy",
    row: row as unknown as ResolverRow,
    payload,
    commentPath: projectPath,
    delivery: {
      notificationType: expectedType,
      title: copy.title,
      body: copy.body,
      emailSubject: copy.title,
      emailText: `${copy.body}\n\n${projectPath}`,
      emailHtml: `<p>${htmlEscape(copy.body)}</p><p><a href="${htmlEscape(projectPath)}">View project</a></p>`,
    },
  };
}

async function resolveDeadlineReminderRecipient(env: Env, outbox: OutboxRow): Promise<ResolvedRecipient> {
  const payload = safeReminderPayload(outbox.payload_json, outbox);
  if (!payload) return suppressed("payload_invalid");
  const result = await env.DB.prepare(`
    SELECT o.id AS outboxId, o.schema_version AS schemaVersion, o.event_type AS eventType,
      o.source_key AS sourceKey, o.project_id AS projectId, o.actor_id AS actorId,
      o.recipient_id AS recipientId, o.payload_json AS payloadJson,
      o.recipient_authorization_epoch AS recipientAuthorizationEpoch,
      recipient.active AS recipientActive, recipient.role AS recipientRole,
      recipient.authorization_epoch AS currentAuthorizationEpoch,
      recipient.name AS recipientName, recipient.email AS recipientEmail,
      p.street AS projectStreet, p.archived_at AS projectArchivedAt,
      p.stage_key AS projectStageKey, p.deadline_version AS projectDeadlineVersion,
      occurrence.id AS occurrenceId, occurrence.status AS occurrenceStatus,
      occurrence.fired_at AS occurrenceFiredAt, occurrence.schedule_version AS occurrenceScheduleVersion,
      occurrence.kind AS occurrenceKind, occurrence.reminder_offset_minutes AS occurrenceOffsetMinutes,
      occurrence.deadline_at AS occurrenceDeadlineAt, occurrence.deadline_local_civil AS occurrenceDeadlineLocalCivil,
      occurrence.deadline_zone AS occurrenceDeadlineZone, occurrence.deadline_utc_offset_minutes AS occurrenceUtcOffsetMinutes,
      occurrence.deadline_fold AS occurrenceFold,
      member.id AS membershipId, member.created_at AS membershipCreatedAt, member.role_on_project AS membershipRole
    FROM notification_outbox o
    LEFT JOIN user recipient ON recipient.id = o.recipient_id
    LEFT JOIN projects p ON p.id = o.project_id
    LEFT JOIN project_deadline_occurrences occurrence
      ON occurrence.id = o.source_key AND occurrence.project_id = o.project_id
    LEFT JOIN project_members member
      ON member.id = json_extract(o.payload_json, '$.authorizationAtOccurrence.membershipCycle')
      AND member.project_id = o.project_id AND member.user_id = o.recipient_id
    WHERE o.id = ?
  `).bind(outbox.id).first<ReminderResolverRow>();
  if (!result) return suppressed("outbox_missing");
  if ((result.recipientAuthorizationEpoch === null && result.recipientRole === "external_editor") || (result.recipientAuthorizationEpoch !== null && result.currentAuthorizationEpoch !== result.recipientAuthorizationEpoch)) return suppressed("authorization_epoch_changed");
  if (result.schemaVersion !== 1 || result.eventType !== NOTIFICATION_OUTBOX_EVENT_TYPES.projectDeadlineReminder || result.sourceKey !== payload.reminder.occurrenceId || result.projectId !== payload.reminder.projectId || result.recipientId !== payload.event.recipientId) return suppressed("payload_invalid");
  const deadlineAt = Date.parse(payload.reminder.deadlineAt);
  const role = result.recipientRole as Role;
  if (result.projectStreet === null || result.projectArchivedAt !== null || result.projectStageKey === "delivered" || result.projectDeadlineVersion !== payload.reminder.scheduleVersion) return suppressed("project_no_longer_visible");
  if (result.recipientActive !== 1 || !isProjectAssignmentEligible("editor", role)) return suppressed("recipient_ineligible");
  if (result.occurrenceId !== payload.reminder.occurrenceId || result.occurrenceStatus !== "fired" || result.occurrenceFiredAt === null || result.occurrenceScheduleVersion !== payload.reminder.scheduleVersion || result.occurrenceKind !== payload.reminder.kind || result.occurrenceOffsetMinutes !== payload.reminder.offsetMinutes || result.occurrenceDeadlineAt !== deadlineAt || result.occurrenceDeadlineLocalCivil !== payload.reminder.deadlineLocalCivil || result.occurrenceDeadlineZone !== payload.reminder.zone || result.occurrenceUtcOffsetMinutes !== payload.reminder.utcOffsetMinutes || result.occurrenceFold !== payload.reminder.fold) return suppressed("occurrence_changed");
  if (result.membershipId !== payload.authorizationAtOccurrence.membershipCycle || result.membershipRole !== "editor" || result.membershipCreatedAt !== payload.authorizationAtOccurrence.startedAt || result.membershipCreatedAt > result.occurrenceFiredAt) return suppressed("membership_cycle_changed");
  const projectPath = `${env.APP_ORIGIN}${staffPathFor({ kind: "project", projectId: result.projectId })}`;
  const label = result.projectStreet || "Project";
  const dueText = payload.reminder.kind === "due_now"
    ? Date.now() > deadlineAt ? "is overdue" : "is due now"
    : `is due at ${formatSydneyCivil(deadlineAt)} Sydney time`;
  const body = `${label} ${dueText}.`;
  const title = "Project deadline reminder";
  return {
    ok: true,
    kind: "legacy",
    row: result,
    payload,
    commentPath: projectPath,
    delivery: {
      notificationType: "project_deadline_reminder",
      title,
      body,
      emailSubject: title,
      emailText: `${body}\n\n${projectPath}`,
      emailHtml: `<p>${htmlEscape(body)}</p><p><small>${htmlEscape(formatSydneyInstant(deadlineAt))}</small></p><p><a href="${htmlEscape(projectPath)}">View project</a></p>`,
    },
  };
}

export type EmailClassification =
  | { kind: "quota_transient"; code: "E_RATE_LIMIT_EXCEEDED" | "E_DAILY_LIMIT_EXCEEDED"; message: string }
  | { kind: "permanent"; code: string; message: string }
  | { kind: "unknown"; code: "email_acceptance_unknown"; message: string };

const PERMANENT_EMAIL_CODES = new Set([
  "E_INVALID_FROM",
  "E_INVALID_TO",
  "E_INVALID_EMAIL",
  "E_DOMAIN_NOT_VERIFIED",
  "E_SENDER_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_MESSAGE_TOO_LARGE",
  "E_INVALID_HEADERS",
  "E_DELIVERY_FAILED",
]);

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/** Pure classification seam: only quota codes are retryable; internal errors are ambiguous. */
export function classifyEmailError(error: unknown): EmailClassification {
  const code = errorCode(error);
  if (code === "E_RATE_LIMIT_EXCEEDED" || code === "E_DAILY_LIMIT_EXCEEDED") {
    return { kind: "quota_transient", code, message: "Cloudflare email quota rejected admission." };
  }
  if (code && PERMANENT_EMAIL_CODES.has(code)) {
    return { kind: "permanent", code, message: "Cloudflare rejected the email before delivery." };
  }
  return { kind: "unknown", code: "email_acceptance_unknown", message: "Email acceptance could not be proven." };
}

function boundedDelaySeconds(attempts: number): number {
  return Math.min(NOTIFICATION_QUEUE_MAX_DELAY_SECONDS, Math.max(1, 2 ** Math.min(Math.max(attempts, 0), 12)));
}

function retryDelaySeconds(messageAttempts: number): number {
  return boundedDelaySeconds(messageAttempts);
}

function safePayload(value: string, outbox: OutboxRow): ProjectCommentMentionPayload | null {
  if (outbox.schema_version !== 1 || outbox.event_type !== NOTIFICATION_OUTBOX_EVENT_TYPE) return null;
  try {
    const parsed = JSON.parse(value) as ProjectCommentMentionPayload;
    if (parsed.schemaVersion !== 1 || parsed.event.type !== NOTIFICATION_OUTBOX_EVENT_TYPE || parsed.event.sourceKey !== outbox.source_key || parsed.event.recipientId !== outbox.recipient_id) return null;
    if (parsed.projectCommentActivity.targetedMentionDelivery !== false) return null;
    if (parsed.projectCommentActivity.schemaVersion !== 1) return null;
    if (parsed.projectCommentActivity.activity.projectId !== outbox.project_id || parsed.projectCommentActivity.activity.actorId !== outbox.actor_id) return null;
    if (parsed.projectCommentActivity.activity.safePayload.commentId.length === 0) return null;
    if (parsed.authorizationAtOccurrence.kind !== "admin" && parsed.authorizationAtOccurrence.kind !== "project_member") return null;
    if (parsed.authorizationAtOccurrence.kind === "project_member" && !Array.isArray(parsed.authorizationAtOccurrence.membershipIds)) return null;
    return parsed;
  } catch {
    return null;
  }
}

type BroadPayload = {
  schemaVersion: 1;
  event: { type: "project.activity.broad"; sourceKey: string; recipientId: string };
  authorizationAtOccurrence: { kind: "project_editor_membership"; membershipCycle: string; startedAt: number };
  activity: { id: string; projectId: string };
};

function safeBroadPayload(value: string, outbox: OutboxRow): BroadPayload | null {
  if (outbox.schema_version !== 1 || outbox.event_type !== NOTIFICATION_OUTBOX_EVENT_TYPES.projectActivityBroad) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isObject(parsed) || !hasExactKeys(parsed, ["schemaVersion", "event", "authorizationAtOccurrence", "activity"]) || parsed.schemaVersion !== 1) return null;
    const event = parsed.event;
    const authorization = parsed.authorizationAtOccurrence;
    const activity = parsed.activity;
    if (!isObject(event) || !hasExactKeys(event, ["type", "sourceKey", "recipientId"]) || event.type !== NOTIFICATION_OUTBOX_EVENT_TYPES.projectActivityBroad || typeof event.sourceKey !== "string" || typeof event.recipientId !== "string") return null;
    if (!isObject(authorization) || !hasExactKeys(authorization, ["kind", "membershipCycle", "startedAt"]) || authorization.kind !== "project_editor_membership" || typeof authorization.membershipCycle !== "string" || typeof authorization.startedAt !== "number" || !Number.isSafeInteger(authorization.startedAt)) return null;
    if (!isObject(activity) || !hasExactKeys(activity, ["id", "projectId"]) || typeof activity.id !== "string" || typeof activity.projectId !== "string") return null;
    if (event.sourceKey !== outbox.source_key || event.recipientId !== outbox.recipient_id || activity.id.length === 0 || activity.projectId !== outbox.project_id) return null;
    return parsed as BroadPayload;
  } catch {
    return null;
  }
}

async function resolveBroadRecipient(env: Env, outbox: OutboxRow): Promise<ResolvedRecipient> {
  const payload = safeBroadPayload(outbox.payload_json, outbox);
  if (!payload) return { ok: false, kind: "permanent", code: "project_activity_payload_invalid", reason: "Broad activity payload failed validation." };
  const row = await env.DB.prepare(`
    SELECT o.id AS outboxId, o.schema_version AS schemaVersion, o.event_type AS eventType,
      o.source_key AS sourceKey, o.project_id AS projectId, o.actor_id AS actorId,
      o.recipient_id AS recipientId, o.payload_json AS payloadJson,
      o.coalesce_key AS coalesceKey, o.coalesce_until AS coalesceUntil,
      o.recipient_membership_cycle_id AS recipientMembershipCycleId,
      recipient.active AS recipientActive, recipient.role AS recipientRole, recipient.name AS recipientName,
      project.street AS projectStreet,
      member.id AS membershipId, member.created_at AS membershipCreatedAt,
      activity.id AS activityId, activity.schema_version AS activitySchemaVersion,
      activity.event_type AS activityEventType, activity.category AS activityCategory,
      activity.project_id AS activityProjectId, activity.actor_kind AS activityActorKind,
      activity.actor_id AS activityActorId, activity.occurred_at AS activityOccurredAt,
      activity.source_kind AS activitySourceKind, activity.source_id AS activitySourceId,
      activity.source_key AS activitySourceKey, activity.safe_payload_json AS activitySafePayloadJson,
      activity.deep_link_kind AS activityDeepLinkKind, activity.deep_link_path AS activityDeepLinkPath,
      activity.created_at AS activityCreatedAt,
      activityActor.name AS activityActorName
    FROM notification_outbox o
    LEFT JOIN projects project ON project.id = o.project_id
    LEFT JOIN user recipient ON recipient.id = o.recipient_id
    LEFT JOIN project_members member ON member.id = o.recipient_membership_cycle_id
      AND member.project_id = o.project_id AND member.user_id = o.recipient_id
    LEFT JOIN project_activity_events activity ON activity.id = json_extract(o.payload_json, '$.activity.id')
    LEFT JOIN user activityActor ON activityActor.id = activity.actor_id AND activity.actor_kind = 'user'
    WHERE o.id = ?
  `).bind(outbox.id).first<BroadResolverRow>();
  if (!row) return { ok: false, kind: "permanent", code: "project_activity_missing", reason: "Broad activity outbox row is missing." };
  if (!row.activityId) return { ok: false, kind: "permanent", code: "project_activity_missing", reason: "Referenced project activity is missing." };
  if (row.projectId !== payload.activity.projectId || row.activityProjectId !== row.projectId || row.activityId !== payload.activity.id || row.sourceKey !== row.activityId || row.sourceKey !== payload.event.sourceKey || row.recipientId !== payload.event.recipientId || row.recipientMembershipCycleId !== payload.authorizationAtOccurrence.membershipCycle || (row.membershipId !== null && (row.membershipId !== payload.authorizationAtOccurrence.membershipCycle || row.membershipCreatedAt !== payload.authorizationAtOccurrence.startedAt))) {
    return { ok: false, kind: "permanent", code: "project_activity_project_mismatch", reason: "Broad activity identity does not match its outbox envelope." };
  }
  if (row.activityActorKind === "user" && row.actorId !== row.activityActorId) return { ok: false, kind: "permanent", code: "project_activity_project_mismatch", reason: "Broad activity actor does not match its outbox envelope." };
  if (row.activityActorKind === "system" && row.actorId !== PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID) return { ok: false, kind: "permanent", code: "project_activity_project_mismatch", reason: "Broad system activity does not match its outbox envelope." };
  const eventType = row.activityEventType;
  const registryEntry = typeof eventType === "string" && Object.prototype.hasOwnProperty.call(PROJECT_ACTIVITY_REGISTRY, eventType)
    ? PROJECT_ACTIVITY_REGISTRY[eventType as keyof typeof PROJECT_ACTIVITY_REGISTRY]
    : undefined;
  if (registryEntry?.cutover === "reserved") return { ok: false, kind: "permanent", code: "project_activity_type_reserved", reason: "Project activity type is reserved." };
  const activity = parseProjectActivityRow({
    id: row.activityId, schemaVersion: row.activitySchemaVersion, eventType: row.activityEventType,
    projectId: row.activityProjectId, actorKind: row.activityActorKind, actorId: row.activityActorId,
    occurredAt: row.activityOccurredAt, sourceKind: row.activitySourceKind, sourceId: row.activitySourceId,
    sourceKey: row.activitySourceKey, safePayloadJson: row.activitySafePayloadJson,
    deepLinkKind: row.activityDeepLinkKind, deepLinkPath: row.activityDeepLinkPath, createdAt: row.activityCreatedAt,
  });
  if (!activity) return { ok: false, kind: "permanent", code: "project_activity_invalid", reason: "Project activity failed registry validation." };
  if (row.activityCategory !== PROJECT_ACTIVITY_REGISTRY[activity.type].category) return { ok: false, kind: "permanent", code: "project_activity_invalid", reason: "Project activity category failed registry validation." };
  if (activity.actorKind === "user" && activity.actorId !== row.actorId) return { ok: false, kind: "permanent", code: "project_activity_project_mismatch", reason: "Project activity actor identity does not match its outbox envelope." };
  if (activity.actorKind === "system" && row.actorId !== PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID) return { ok: false, kind: "permanent", code: "project_activity_project_mismatch", reason: "Project activity system identity does not match its outbox envelope." };
  const coalesce = projectActivityCoalesce(activity.type, activity.projectId, activity.actorId, activity.safePayload);
  if (coalesce ? row.coalesceKey !== coalesce.key || row.coalesceUntil !== activity.occurredAt + coalesce.windowSeconds * 1000 : row.coalesceKey !== null || row.coalesceUntil !== null) {
    return { ok: false, kind: "permanent", code: "project_activity_invalid", reason: "Project activity coalescing state failed validation." };
  }
  if (row.projectStreet === null) return suppressed("project_no_longer_visible");
  const role = row.recipientRole as Role;
  if (row.recipientActive !== 1 || !isProjectAssignmentEligible("editor", role)) return suppressed("recipient_ineligible");
  if (row.membershipId === null || row.membershipCreatedAt === null || row.membershipCreatedAt > activity.occurredAt) return suppressed("membership_cycle_changed");
  if (role === "external_editor") {
    const policy = EXTERNAL_PROJECT_ACTIVITY_POLICY[activity.type];
    if (policy.decision === "suppressed" || !projectExternalActivityPayload(activity.type, activity.safePayload)) return suppressed("external_policy_suppressed");
  }
  const projection = activity.deepLink.kind === "project_collaboration" ? "project_collaboration_activity" : "project_activity";
  const copy = renderProjectActivityNotification(activity.type, activity.safePayload, row.projectStreet, activity.actorKind === "user" ? row.activityActorName : null);
  const projectPath = `${env.APP_ORIGIN}${activity.deepLink.path}`;
  return {
    ok: true,
    kind: "broad",
    row,
    activity,
    commentPath: projectPath,
    delivery: {
      notificationType: projection,
      title: copy.title,
      body: copy.body,
      emailSubject: copy.title,
      emailText: `${copy.body}\n\n${projectPath}`,
      emailHtml: `<p>${htmlEscape(copy.body)}</p><p><a href="${htmlEscape(projectPath)}">View project</a></p>`,
    },
  };
}

async function resolveRecipient(env: Env, outbox: OutboxRow): Promise<ResolvedRecipient> {
  if (outbox.event_type === NOTIFICATION_OUTBOX_EVENT_TYPES.projectActivityBroad) return resolveBroadRecipient(env, outbox);
  if (outbox.event_type === NOTIFICATION_OUTBOX_EVENT_TYPES.projectDeadlineReminder) return resolveDeadlineReminderRecipient(env, outbox);
  if (outbox.event_type === "project.external_safe.direct") return resolveExternalSafeDirectRecipient(env, outbox);
  if (outbox.event_type === "project.subtask.assigned" || outbox.event_type === "project.subtask.due_today") return resolveExternalSubtaskRecipient(env, outbox);
  const row = await env.DB.prepare(`
    SELECT
      o.id AS outboxId, o.schema_version AS schemaVersion, o.event_type AS eventType,
      o.source_key AS sourceKey, o.project_id AS projectId, o.actor_id AS actorId,
      o.recipient_id AS recipientId, o.payload_json AS payloadJson,
      o.recipient_authorization_epoch AS recipientAuthorizationEpoch,
      recipient.active AS recipientActive, recipient.role AS recipientRole,
      recipient.authorization_epoch AS currentAuthorizationEpoch,
      recipient.name AS recipientName, recipient.email AS recipientEmail,
      project.street AS projectStreet, project.archived_at AS projectArchivedAt,
      comment.id AS commentId, comment.project_id AS commentProjectId,
      comment.body AS commentBody, author.id AS authorId, author.name AS authorName,
      mention.id AS mappingId, mention.mentioned_user_id AS mappingRecipientId,
      mention.comment_id AS mappingCommentId, member.id AS membershipId
    FROM notification_outbox o
    LEFT JOIN user recipient ON recipient.id = o.recipient_id
    LEFT JOIN projects project ON project.id = o.project_id
    LEFT JOIN project_comments comment ON comment.id = json_extract(o.payload_json, '$.projectCommentActivity.activity.safePayload.commentId')
    LEFT JOIN user author ON author.id = comment.author_id
    LEFT JOIN project_comment_mentions mention ON mention.id = o.source_key
    LEFT JOIN project_members member ON member.project_id = o.project_id AND member.user_id = o.recipient_id
    WHERE o.id = ?
    ORDER BY member.id
  `).bind(outbox.id).all<ResolverRow>();
  const first = row.results[0];
  if (!first) return suppressed("outbox_missing");
  if ((first.recipientAuthorizationEpoch === null && first.recipientRole === "external_editor") || (first.recipientAuthorizationEpoch !== null && first.currentAuthorizationEpoch !== first.recipientAuthorizationEpoch)) return suppressed("authorization_epoch_changed");

  if (outbox.event_type === NOTIFICATION_OUTBOX_EVENT_TYPES.projectAssignmentCreated) {
    const payload = safeAssignmentPayload(first.payloadJson, outbox);
    if (!payload) return suppressed("payload_invalid");
    const roleOnProject = payload.assignment.roleOnProject;
    const role = first.recipientRole as Role;
    if (first.schemaVersion !== 1 || first.eventType !== NOTIFICATION_OUTBOX_EVENT_TYPES.projectAssignmentCreated || first.sourceKey !== payload.assignment.membershipCycle || first.recipientId !== payload.assignment.userId || first.projectId !== payload.assignment.projectId) return suppressed("payload_invalid");
    if (first.projectStreet === null) return suppressed("project_missing");
    if (first.recipientActive !== 1 || !isProjectAssignmentEligible(roleOnProject, role) || (role === "external_editor" && roleOnProject !== "editor")) return suppressed("recipient_ineligible");
    const exact = await env.DB.prepare(`
      SELECT pm.id AS membershipId
      FROM project_members pm
      WHERE pm.id = ? AND pm.project_id = ? AND pm.user_id = ? AND pm.role_on_project = ?
    `).bind(payload.assignment.membershipCycle, payload.assignment.projectId, payload.assignment.userId, roleOnProject).first<{ membershipId: string }>();
    if (!exact) return suppressed("membership_cycle_changed");
    const projectPath = `${env.APP_ORIGIN}/projects/${first.projectId}`;
    const title = "Assigned to project";
    const body = `You have been assigned as the ${roleOnProject} for ${first.projectStreet ?? "Project"}.`;
    return {
      ok: true,
      kind: "legacy",
      row: first,
      payload,
      commentPath: projectPath,
      delivery: {
        notificationType: "assigned_to_project",
        title,
        body,
        emailSubject: title,
        emailText: `${body}\n\n${projectPath}`,
        emailHtml: `<p>${htmlEscape(body)}</p><p><a href="${htmlEscape(projectPath)}">View project</a></p>`,
      },
    };
  }

  const payload = safePayload(first.payloadJson, outbox);
  if (!payload) return suppressed("payload_invalid");
  const role = first.recipientRole as Role;
  if (first.recipientActive !== 1 || !roleHasCapability(role, "collaborateOnProject")) return suppressed("recipient_ineligible");
  if (first.recipientId === first.actorId) return suppressed("self_mention");
  if (first.projectArchivedAt !== null || !first.projectStreet || !first.commentId || first.commentProjectId !== first.projectId || !first.authorId || !first.authorName || first.commentBody === null) return suppressed("project_comment_invisible");
  if (first.mappingId !== first.sourceKey || first.mappingRecipientId !== first.recipientId || first.mappingCommentId !== first.commentId) return suppressed("mention_mapping_removed");

  const memberships = [...new Set(row.results.map((candidate) => candidate.membershipId).filter((id): id is string => Boolean(id)))];
  const currentEligible = role === "admin" || memberships.length > 0;
  if (!currentEligible) return suppressed("membership_removed");
  if (payload.authorizationAtOccurrence.kind === "admin") {
    if (role !== "admin") return suppressed("admin_authorization_changed");
  } else if (!payload.authorizationAtOccurrence.membershipIds.some((id) => memberships.includes(id))) {
    return suppressed("membership_cycle_changed");
  }
  const commentPath = `${env.APP_ORIGIN}${staffPathFor({ kind: "project", projectId: first.projectId, collaboration: "open" })}`;
  const excerpt = truncateForEmail(first.commentBody ?? "");
  return {
    ok: true,
    kind: "legacy",
    row: first,
    payload,
    commentPath,
    delivery: {
      notificationType: "mentioned",
      title: "You were mentioned",
      body: "You were mentioned in a project comment.",
      emailSubject: "You were mentioned",
      emailText: `${first.authorName} commented on ${first.projectStreet ?? ""}:\n\n“${excerpt}”\n\n${commentPath}`,
      emailHtml: `<p>${htmlEscape(first.authorName ?? "")} commented on ${htmlEscape(first.projectStreet ?? "")}:</p><p>“${htmlEscape(excerpt)}”</p><p><a href="${htmlEscape(commentPath)}">View project</a></p>`,
    },
  };
}

async function claimOutbox(env: Env, outboxId: string, now: number): Promise<{ row: OutboxRow; token: string } | null> {
  const token = crypto.randomUUID();
  const leaseExpiresAt = now + NOTIFICATION_DELIVERY_LEASE_MS;
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE notification_outbox
      SET status = 'processing', lease_token = ?, lease_expires_at = ?,
          delivery_attempts = delivery_attempts + 1,
          last_error_code = NULL, last_error = NULL, updated_at = ?
      WHERE id = ?
        AND (
          (status IN ('pending', 'queued') AND available_at <= ?)
          OR (
            status = 'processing' AND lease_expires_at <= ?
            AND NOT EXISTS (
              SELECT 1 FROM notification_delivery_ledger l
              WHERE l.outbox_id = notification_outbox.id
                AND l.channel = 'email' AND l.status = 'processing'
            )
          )
        )
      RETURNING *
    `).bind(token, leaseExpiresAt, now, outboxId, now, now),
    env.DB.prepare(`
      UPDATE notification_delivery_ledger
      SET status = 'pending',
          last_error_code = 'delivery_lease_expired',
          last_error = 'In-app delivery lease expired; reclaimed by a new outbox owner.',
          updated_at = ?
      WHERE outbox_id = ?
        AND channel = 'in_app'
        AND status = 'processing'
        AND EXISTS (
          SELECT 1 FROM notification_outbox o
          WHERE o.id = notification_delivery_ledger.outbox_id
            AND o.status = 'processing'
            AND o.lease_token = ?
        )
    `).bind(now, outboxId, token),
  ]);
  const row = results[0]?.results?.[0] as OutboxRow | undefined;
  return row ? { row, token } : null;
}

async function readOutbox(env: Env, outboxId: string): Promise<Pick<OutboxRow, "status" | "available_at" | "lease_expires_at"> | null> {
  return await env.DB.prepare("SELECT status, available_at, lease_expires_at FROM notification_outbox WHERE id = ?").bind(outboxId).first<Pick<OutboxRow, "status" | "available_at" | "lease_expires_at">>();
}

async function releaseBeforeRetry(env: Env, outbox: OutboxRow, token: string, retryAt: number): Promise<boolean> {
  try {
    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE notification_delivery_ledger
        SET status = 'pending', last_error_code = 'delivery_retry',
            last_error = 'In-app delivery released before Queue retry.', updated_at = ?
        WHERE outbox_id = ? AND channel = 'in_app' AND status = 'processing'
          AND EXISTS (SELECT 1 FROM notification_outbox o WHERE o.id = ? AND o.status = 'processing' AND o.lease_token = ?)
      `).bind(retryAt, outbox.id, outbox.id, token),
      env.DB.prepare(`
        UPDATE notification_outbox
        SET status = 'queued', lease_token = NULL, lease_expires_at = NULL,
            available_at = ?, updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_token = ?
      `).bind(retryAt, retryAt, outbox.id, token),
    ]);
    return (results[1]?.meta.changes ?? 0) === 1;
  } catch (error) {
    console.error("Notification in-app retry release failed", { outboxId: outbox.id, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    return false;
  }
}

async function completeIfTerminal(env: Env, outbox: OutboxRow, token: string, now: number): Promise<void> {
  await env.DB.prepare(`
    UPDATE notification_outbox
    SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
        completed_at = ?, updated_at = ?
    WHERE id = ? AND status = 'processing' AND lease_token = ?
      AND NOT EXISTS (
        SELECT 1 FROM notification_delivery_ledger
        WHERE outbox_id = ? AND status IN ('pending', 'processing')
      )
  `).bind(now, now, outbox.id, token, outbox.id).run();
}

async function suppressWholeOccurrence(env: Env, outbox: OutboxRow, token: string, reason: string, now: number, code: AuthorizationSuppressionCode = "reauthorization_suppressed"): Promise<void> {
  const meta = JSON.stringify({ eventType: outbox.event_type, sourceKey: outbox.source_key, recipientId: outbox.recipient_id, reason });
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE notification_delivery_ledger
      SET status = 'suppressed', last_error_code = ?, last_error = ?, updated_at = ?
      WHERE outbox_id = ? AND status IN ('pending', 'processing')
        AND EXISTS (SELECT 1 FROM notification_outbox o WHERE o.id = ? AND o.status = 'processing' AND o.lease_token = ?)
    `).bind(code, reason, now, outbox.id, outbox.id, token),
    env.DB.prepare(`
      UPDATE notification_outbox
      SET status = CASE WHEN event_type = ? THEN 'completed' ELSE 'suppressed' END,
          last_error_code = CASE WHEN event_type = ? THEN NULL ELSE ? END,
          last_error = CASE WHEN event_type = ? THEN NULL ELSE ? END,
          lease_token = NULL, lease_expires_at = NULL,
          completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_token = ?
    `).bind(NOTIFICATION_OUTBOX_EVENT_TYPES.projectActivityBroad, NOTIFICATION_OUTBOX_EVENT_TYPES.projectActivityBroad, code, NOTIFICATION_OUTBOX_EVENT_TYPES.projectActivityBroad, reason, now, now, outbox.id, token),
    env.DB.prepare(`
      INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?, NULL, 'notification.delivery.suppressed', 'notification_outbox', ?, ?, ?
      WHERE changes() = 1
    `).bind(crypto.randomUUID(), outbox.id, meta, now),
  ]);
}

type NotificationSuppressionCode = AuthorizationSuppressionCode | "recipient_preference_disabled";

async function suppressEmailChannel(env: Env, outbox: OutboxRow, token: string, reason: string, now: number, code: NotificationSuppressionCode = "reauthorization_suppressed"): Promise<void> {
  const meta = JSON.stringify({ eventType: outbox.event_type, sourceKey: outbox.source_key, recipientId: outbox.recipient_id, reason });
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE notification_delivery_ledger
      SET status = 'suppressed', last_error_code = ?, last_error = ?, updated_at = ?
      WHERE outbox_id = ? AND channel = 'email' AND status = 'pending'
        AND EXISTS (SELECT 1 FROM notification_outbox o WHERE o.id = ? AND o.status = 'processing' AND o.lease_token = ?)
    `).bind(code, reason, now, outbox.id, outbox.id, token),
    env.DB.prepare(`
      UPDATE notification_outbox
      SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
          completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_token = ?
        AND NOT EXISTS (SELECT 1 FROM notification_delivery_ledger WHERE outbox_id = ? AND status IN ('pending', 'processing'))
    `).bind(now, now, outbox.id, token, outbox.id),
    env.DB.prepare(`
      INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?, NULL, 'notification.delivery.suppressed', 'notification_outbox', ?, ?, ?
      WHERE changes() = 1
    `).bind(crypto.randomUUID(), outbox.id, meta, now),
  ]);
}

type ReminderAdmission = { sql: string; values: unknown[] };

function reminderAuthorization(outbox: OutboxRow, payload: ProjectDeadlineReminderOutboxPayload, token: string, channel?: "in_app" | "email"): ReminderAdmission {
  const roles = PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor;
  const rolePlaceholders = roles.map(() => "?").join(",");
  return {
    sql: `
      SELECT 1
      FROM notification_outbox o
      JOIN projects p ON p.id = o.project_id
      JOIN project_deadline_occurrences occurrence
        ON occurrence.id = o.source_key AND occurrence.project_id = o.project_id
      JOIN user recipient ON recipient.id = o.recipient_id
      JOIN project_members member
        ON member.id = ? AND member.project_id = o.project_id
        AND member.user_id = o.recipient_id AND member.role_on_project = 'editor'
      LEFT JOIN notification_preferences preference ON preference.user_id = o.recipient_id
      WHERE o.id = notification_delivery_ledger.outbox_id
        AND o.id = ? AND o.status = 'processing' AND o.lease_token = ?
        AND o.schema_version = 1 AND o.event_type = 'project.deadline.reminder'
        AND o.source_key = ? AND o.project_id = ? AND o.recipient_id = ?
        AND p.archived_at IS NULL AND p.stage_key <> 'delivered'
        AND p.deadline_version = ? AND p.deadline_at = ?
        AND occurrence.status = 'fired' AND occurrence.fired_at IS NOT NULL
        AND occurrence.schedule_version = ? AND occurrence.kind = ?
        AND occurrence.reminder_offset_minutes = ? AND occurrence.deadline_at = ?
        AND occurrence.deadline_local_civil = ? AND occurrence.deadline_zone = 'Australia/Sydney'
        AND occurrence.deadline_utc_offset_minutes = ? AND occurrence.deadline_fold = ?
        AND recipient.active = 1 AND recipient.role IN (${rolePlaceholders})
        AND member.created_at = ? AND member.created_at <= occurrence.fired_at
        ${channel ? "AND (? <> 'email' OR COALESCE(preference.project_deadline_reminder_emails, 1) = 1)" : ""}
    `,
    values: [
      payload.authorizationAtOccurrence.membershipCycle, outbox.id, token,
      payload.reminder.occurrenceId, payload.reminder.projectId, outbox.recipient_id,
      payload.reminder.scheduleVersion, Date.parse(payload.reminder.deadlineAt),
      payload.reminder.scheduleVersion, payload.reminder.kind, payload.reminder.offsetMinutes,
      Date.parse(payload.reminder.deadlineAt), payload.reminder.deadlineLocalCivil,
      payload.reminder.utcOffsetMinutes, payload.reminder.fold, ...roles,
      payload.authorizationAtOccurrence.startedAt, ...(channel ? [channel] : []),
    ],
  };
}

async function beginReminderChannel(env: Env, outbox: OutboxRow, token: string, channel: "in_app" | "email", now: number): Promise<boolean> {
  const payload = safeReminderPayload(outbox.payload_json, outbox);
  if (!payload) return false;
  const authorization = reminderAuthorization(outbox, payload, token);
  const admission = reminderAuthorization(outbox, payload, token, channel);
  const preferenceForCode = `COALESCE((SELECT project_deadline_reminder_emails FROM notification_preferences WHERE user_id = ?), 1) = 0`;
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE notification_delivery_ledger
      SET status = 'processing', attempts = attempts + 1, last_attempt_at = ?, updated_at = ?,
          last_error_code = NULL, last_error = NULL
      WHERE outbox_id = ? AND channel = ? AND status = 'pending'
        AND EXISTS (${admission.sql})
      RETURNING id
    `).bind(now, now, outbox.id, channel, ...admission.values.slice(0, -1), channel),
    env.DB.prepare(`
      UPDATE notification_delivery_ledger
      SET status = 'suppressed',
          last_error_code = CASE
            WHEN channel = 'email' AND EXISTS (${authorization.sql}) AND ${preferenceForCode}
              THEN 'recipient_preference_disabled'
            ELSE 'reauthorization_suppressed'
          END,
          last_error = CASE
            WHEN channel = 'email' AND EXISTS (${authorization.sql}) AND ${preferenceForCode}
              THEN 'Recipient disabled project deadline reminder email.'
            ELSE 'Current reminder authorization no longer matches.'
          END,
          updated_at = ?
      WHERE outbox_id = ? AND channel = ? AND status = 'pending' AND changes() = 0
        AND EXISTS (SELECT 1 FROM notification_outbox owned WHERE owned.id = ? AND owned.status = 'processing' AND owned.lease_token = ?)
        AND NOT EXISTS (${admission.sql})
      RETURNING id, last_error_code
    `).bind(
      ...authorization.values, outbox.recipient_id,
      ...authorization.values, outbox.recipient_id,
      now, outbox.id, channel, outbox.id, token,
      ...admission.values.slice(0, -1), channel,
    ),
    env.DB.prepare(`
      INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?, NULL, 'notification.delivery.suppressed', 'notification_outbox', ?,
        json_object('eventType', ?, 'sourceKey', ?, 'recipientId', ?,
          'reasonCode', (SELECT last_error_code FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = ? AND status = 'suppressed' ORDER BY updated_at DESC LIMIT 1)), ?
      WHERE changes() = 1
    `).bind(crypto.randomUUID(), outbox.id, outbox.event_type, outbox.source_key, outbox.recipient_id, outbox.id, channel, now),
    env.DB.prepare(`
      UPDATE notification_outbox
      SET status = 'completed', lease_token = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_token = ?
        AND NOT EXISTS (SELECT 1 FROM notification_delivery_ledger WHERE outbox_id = ? AND status IN ('pending', 'processing'))
    `).bind(now, now, outbox.id, token, outbox.id),
  ]);
  return (results[0]?.results?.length ?? 0) === 1;
}

async function beginChannel(env: Env, outbox: OutboxRow, token: string, channel: "in_app" | "email", now: number): Promise<boolean> {
  if (outbox.event_type === NOTIFICATION_OUTBOX_EVENT_TYPES.projectDeadlineReminder) return beginReminderChannel(env, outbox, token, channel, now);
  const result = await env.DB.prepare(`
    UPDATE notification_delivery_ledger
    SET status = 'processing', attempts = attempts + 1, last_attempt_at = ?, updated_at = ?,
        last_error_code = NULL, last_error = NULL
    WHERE outbox_id = ? AND channel = ? AND status = 'pending'
      AND EXISTS (SELECT 1 FROM notification_outbox o WHERE o.id = ? AND o.status = 'processing' AND o.lease_token = ?)
  `).bind(now, now, outbox.id, channel, outbox.id, token).run();
  return (result.meta.changes ?? 0) === 1;
}

async function deliverInApp(env: Env, outbox: OutboxRow, token: string, _resolved: Extract<Awaited<ReturnType<typeof resolveRecipient>>, { ok: true; kind: "legacy" }>, now: number): Promise<void> {
  const began = await beginChannel(env, outbox, token, "in_app", now);
  if (!began) return;
  const secondResolution = await resolveRecipient(env, outbox);
  if (!secondResolution.ok) {
    if (secondResolution.kind !== "suppress") throw new Error("Legacy recipient resolver returned a permanent failure");
    await suppressWholeOccurrence(env, outbox, token, secondResolution.reason, now, secondResolution.code);
    return;
  }
  if (secondResolution.kind !== "legacy") throw new Error("Legacy outbox resolved as a broad activity");
  const current = secondResolution;
  const notificationId = crypto.randomUUID();
  const inserted = env.DB.prepare(`
    INSERT INTO notifications (id, user_id, project_id, type, title, body, source_key, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM notification_outbox o WHERE o.id = ? AND o.status = 'processing' AND o.lease_token = ?)
    ON CONFLICT (type, source_key, user_id)
      WHERE source_key IS NOT NULL DO NOTHING
  `).bind(notificationId, current.row.recipientId, current.row.projectId, current.delivery.notificationType, current.delivery.title, current.delivery.body, current.row.sourceKey, now, outbox.id, token);
  const converged = env.DB.prepare(`
    UPDATE notification_delivery_ledger
    SET status = 'sent',
        notification_id = (
          SELECT id FROM notifications
          WHERE type = ? AND source_key = ? AND user_id = ?
          LIMIT 1
        ),
        delivered_at = ?, updated_at = ?, last_error_code = NULL, last_error = NULL
    WHERE id = (SELECT id FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'in_app')
      AND outbox_id = ? AND channel = 'in_app' AND status = 'processing'
      AND EXISTS (
        SELECT 1 FROM notification_outbox o
        WHERE o.id = notification_delivery_ledger.outbox_id
          AND o.status = 'processing' AND o.lease_token = ?
      )
      AND EXISTS (
        SELECT 1 FROM notifications
        WHERE type = ? AND source_key = ? AND user_id = ?
      )
  `).bind(current.delivery.notificationType, current.row.sourceKey, current.row.recipientId, now, now, outbox.id, outbox.id, token, current.delivery.notificationType, current.row.sourceKey, current.row.recipientId);
  const results = await env.DB.batch([inserted, converged]);
  if ((results[1]?.meta.changes ?? 0) !== 1) throw new Error("In-app ledger convergence lost ownership");
  await recordProjectDeadlineInAppLatency(env, outbox, now);
}

type BroadAdmission = {
  structural: { sql: string; values: unknown[] };
  authorization: { sql: string; values: unknown[] };
  failureCode: { sql: string; values: unknown[] };
  suppressionCode: { sql: string; values: unknown[] };
};

function broadAdmission(outbox: OutboxRow, resolved: BroadResolvedRecipient, token: string): BroadAdmission {
  const roles = PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor;
  const activity = resolved.activity;
  const coalescing = projectActivityCoalescingDeclaration(activity.type);
  const coalesceSql = coalescing
    ? "AND o.coalesce_key = ? AND o.coalesce_until = ?"
    : "AND o.coalesce_key IS NULL AND o.coalesce_until IS NULL";
  const coalesceValues = coalescing
    ? [resolved.row.coalesceKey, activity.occurredAt + coalescing.windowSeconds * 1000]
    : [];
  const conditions = `
    o.id = ? AND o.status = 'processing' AND o.lease_token = ?
    AND o.schema_version = 1 AND o.event_type = ? AND o.source_key = ? AND o.project_id = ? AND o.recipient_id = ?
    AND o.recipient_membership_cycle_id IS NOT NULL
    AND json_extract(o.payload_json, '$.schemaVersion') = 1
    AND json_extract(o.payload_json, '$.event.type') = ?
    AND json_extract(o.payload_json, '$.event.sourceKey') = o.source_key
    AND json_extract(o.payload_json, '$.event.recipientId') = o.recipient_id
    AND json_extract(o.payload_json, '$.authorizationAtOccurrence.kind') = 'project_editor_membership'
    AND json_extract(o.payload_json, '$.authorizationAtOccurrence.membershipCycle') = o.recipient_membership_cycle_id
    AND json_extract(o.payload_json, '$.authorizationAtOccurrence.startedAt') IS NOT NULL
    AND json_extract(o.payload_json, '$.activity.id') = activity.id
    AND json_extract(o.payload_json, '$.activity.projectId') = activity.project_id
    AND activity.schema_version = 1 AND activity.event_type = ? AND activity.project_id = ?
    AND activity.category = ? AND activity.actor_kind = ? AND activity.occurred_at = ?
    AND activity.source_kind = ? AND activity.source_id = ? AND activity.source_key = ?
    AND activity.safe_payload_json = ?
    AND activity.deep_link_kind = ? AND activity.deep_link_path = ?
    AND ((activity.actor_kind = 'system' AND activity.actor_id IS NULL AND o.actor_id = ?)
      OR (activity.actor_kind = 'user' AND activity.actor_id = o.actor_id AND o.actor_id <> ?))
    ${coalesceSql}
  `;
  const baseValues = [
    outbox.id, token, NOTIFICATION_OUTBOX_EVENT_TYPES.projectActivityBroad,
    activity.id, activity.projectId, outbox.recipient_id, NOTIFICATION_OUTBOX_EVENT_TYPES.projectActivityBroad,
    activity.type, activity.projectId, PROJECT_ACTIVITY_REGISTRY[activity.type].category, activity.actorKind,
    activity.occurredAt, activity.source.kind, activity.source.id, activity.source.key,
    JSON.stringify(activity.safePayload), activity.deepLink.kind, activity.deepLink.path,
    PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID, PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID,
    ...coalesceValues,
  ];
  const structural = {
    sql: `EXISTS (
      SELECT 1
      FROM notification_outbox o
      JOIN project_activity_events activity ON activity.id = ?
      WHERE ${conditions}
    )`,
    values: [activity.id, ...baseValues],
  };
  const authorization = {
    sql: `EXISTS (
      SELECT 1
      FROM notification_outbox o
      JOIN project_activity_events activity ON activity.id = ?
      JOIN project_members member ON member.id = o.recipient_membership_cycle_id
        AND member.project_id = o.project_id AND member.user_id = o.recipient_id AND member.role_on_project = 'editor'
      JOIN user recipient ON recipient.id = o.recipient_id
      WHERE ${conditions}
        AND json_extract(o.payload_json, '$.authorizationAtOccurrence.membershipCycle') = member.id
        AND json_extract(o.payload_json, '$.authorizationAtOccurrence.startedAt') = member.created_at
        AND activity.occurred_at >= member.created_at
        AND recipient.active = 1 AND recipient.role IN (${roles.map(() => "?").join(",")})
        AND (o.recipient_authorization_epoch = recipient.authorization_epoch
          OR (o.recipient_authorization_epoch IS NULL AND recipient.role <> 'external_editor'))
    )`,
    values: [activity.id, ...baseValues, ...roles],
  };
  const reservedTypes = Object.entries(PROJECT_ACTIVITY_REGISTRY)
    .filter(([, entry]) => entry.cutover === "reserved")
    .map(([type]) => type);
  const failureCode = {
    // These three predicates partition the structural failures reaching this SQL;
    // there is deliberately no fallback code for an impossible fourth arm.
    sql: `CASE
      WHEN NOT EXISTS (SELECT 1 FROM project_activity_events WHERE id = ?) THEN 'project_activity_missing'
      WHEN EXISTS (SELECT 1 FROM project_activity_events WHERE id = ? AND event_type IN (${reservedTypes.map(() => "?").join(",") || "NULL"})) THEN 'project_activity_type_reserved'
      WHEN EXISTS (SELECT 1 FROM project_activity_events WHERE id = ?) THEN 'project_activity_project_mismatch'
    END`,
    values: [activity.id, activity.id, ...reservedTypes, activity.id],
  };
  const suppressionCode = {
    sql: `CASE WHEN EXISTS (
      SELECT 1
      FROM notification_outbox o
      JOIN project_activity_events activity ON activity.id = ?
      JOIN user recipient ON recipient.id = o.recipient_id
      WHERE ${conditions}
        AND recipient.active = 1
        AND (o.recipient_authorization_epoch IS NULL OR o.recipient_authorization_epoch <> recipient.authorization_epoch)
    ) THEN 'authorization_epoch_changed' ELSE 'reauthorization_suppressed' END`,
    values: [activity.id, ...baseValues],
  };
  return {
    structural,
    authorization,
    failureCode,
    suppressionCode,
  };
}

/**
 * Broad activity admission is deliberately separate from the legacy two-channel delivery path.
 * The nine statements (including the two adjacent terminal audits) keep in-app admission,
 * authorization convergence, suppression, and completion in one lease-fenced D1 batch; a returned
 * outcome is terminal and never a Queue retry.
 */
export async function deliverBroadInApp(env: Env, outbox: OutboxRow, token: string, resolved: BroadResolvedRecipient, now: number): Promise<"delivered" | "suppressed" | "failed"> {
  const admission = broadAdmission(outbox, resolved, token);
  const notificationId = crypto.randomUUID();
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE notification_delivery_ledger
      SET status = 'processing', attempts = attempts + 1, last_attempt_at = ?, updated_at = ?, last_error_code = NULL, last_error = NULL
      WHERE outbox_id = ? AND channel = 'in_app' AND status = 'pending' AND ${admission.authorization.sql}
      RETURNING id
    `).bind(now, now, outbox.id, ...admission.authorization.values),
    env.DB.prepare(`
      INSERT INTO notifications (id, user_id, project_id, type, title, body, source_key, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM notification_delivery_ledger
        WHERE outbox_id = ? AND channel = 'in_app' AND status = 'processing'
      ) AND ${admission.authorization.sql}
      ON CONFLICT (type, source_key, user_id) WHERE source_key IS NOT NULL DO NOTHING
    `).bind(notificationId, resolved.row.recipientId, resolved.row.projectId, resolved.delivery.notificationType, resolved.delivery.title, resolved.delivery.body, resolved.row.sourceKey, now, outbox.id, ...admission.authorization.values),
    env.DB.prepare(`
      UPDATE notification_delivery_ledger
      SET status = 'sent', notification_id = (SELECT id FROM notifications WHERE type = ? AND source_key = ? AND user_id = ? LIMIT 1), delivered_at = ?, updated_at = ?, last_error_code = NULL, last_error = NULL
      WHERE outbox_id = ? AND channel = 'in_app' AND status = 'processing'
        AND ${admission.authorization.sql}
        AND EXISTS (SELECT 1 FROM notifications WHERE type = ? AND source_key = ? AND user_id = ?)
    `).bind(resolved.delivery.notificationType, resolved.row.sourceKey, resolved.row.recipientId, now, now, outbox.id, ...admission.authorization.values, resolved.delivery.notificationType, resolved.row.sourceKey, resolved.row.recipientId),
    env.DB.prepare(`
      INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?, NULL, 'notification.delivery.delivered', 'notification_outbox', ?, ?, ?
      WHERE changes() = 1
    `).bind(crypto.randomUUID(), outbox.id, JSON.stringify({ eventType: outbox.event_type, outboxId: outbox.id, recipientId: outbox.recipient_id }), now),
    env.DB.prepare(`
      UPDATE notification_delivery_ledger
      SET status = 'suppressed', last_error_code = ${admission.suppressionCode.sql}, last_error = 'Current project activity authorization no longer matches.', updated_at = ?
      WHERE outbox_id = ? AND channel = 'in_app' AND status IN ('pending', 'processing')
        AND EXISTS (SELECT 1 FROM notification_outbox o WHERE o.id = ? AND o.status = 'processing' AND o.lease_token = ?)
        AND ${admission.structural.sql}
        AND NOT ${admission.authorization.sql}
      RETURNING id
    `).bind(...admission.suppressionCode.values, now, outbox.id, outbox.id, token, ...admission.structural.values, ...admission.authorization.values),
    env.DB.prepare(`
      INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?, NULL, 'notification.delivery.suppressed', 'notification_outbox', ?,
        json_object('eventType', ?, 'outboxId', ?, 'recipientId', ?,
          'reasonCode', (SELECT last_error_code FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'in_app' AND status = 'suppressed' LIMIT 1)), ?
      WHERE changes() = 1
    `).bind(crypto.randomUUID(), outbox.id, outbox.event_type, outbox.id, outbox.recipient_id, outbox.id, now),
    env.DB.prepare(`
      UPDATE notification_delivery_ledger
      SET status = 'failed', last_error_code = ${admission.failureCode.sql}, last_error = 'Project activity could not be processed.', updated_at = ?
      WHERE outbox_id = ? AND channel = 'in_app' AND status IN ('pending', 'processing')
        AND EXISTS (SELECT 1 FROM notification_outbox o WHERE o.id = ? AND o.status = 'processing' AND o.lease_token = ?)
        AND NOT ${admission.structural.sql}
      RETURNING id
    `).bind(...admission.failureCode.values, now, outbox.id, outbox.id, token, ...admission.structural.values),
    env.DB.prepare(`
      INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?, NULL, 'notification.delivery.failed', 'notification_outbox', ?,
        json_object('eventType', ?, 'outboxId', ?, 'recipientId', ?, 'code', (SELECT last_error_code FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'in_app')),
        ?
      WHERE changes() = 1
    `).bind(crypto.randomUUID(), outbox.id, outbox.event_type, outbox.id, outbox.recipient_id, outbox.id, now),
    env.DB.prepare(`
      UPDATE notification_outbox
      SET status = CASE WHEN EXISTS (SELECT 1 FROM notification_delivery_ledger WHERE outbox_id = ? AND status = 'failed') THEN 'failed' ELSE 'completed' END,
        last_error_code = CASE WHEN EXISTS (SELECT 1 FROM notification_delivery_ledger WHERE outbox_id = ? AND status = 'failed') THEN (SELECT last_error_code FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'in_app') ELSE NULL END,
        last_error = CASE WHEN EXISTS (SELECT 1 FROM notification_delivery_ledger WHERE outbox_id = ? AND status = 'failed') THEN last_error ELSE NULL END,
        lease_token = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_token = ?
      AND NOT EXISTS (SELECT 1 FROM notification_delivery_ledger WHERE outbox_id = ? AND status IN ('pending', 'processing'))
      RETURNING id, status
    `).bind(outbox.id, outbox.id, outbox.id, outbox.id, now, now, outbox.id, token, outbox.id),
  ]);
  const terminalOutcomes = [
    [(results[2]?.meta.changes ?? 0) === 1, "delivered"],
    [(results[4]?.meta.changes ?? 0) === 1, "suppressed"],
    [(results[6]?.meta.changes ?? 0) === 1, "failed"],
  ].filter(([matched]) => matched).map(([, outcome]) => outcome);
  if (terminalOutcomes.length !== 1 || (results[8]?.meta.changes ?? 0) !== 1) throw new Error("Broad in-app delivery did not atomically terminalize exactly one outcome");
  return terminalOutcomes[0] as "delivered" | "suppressed" | "failed";
}

async function failWholeOccurrence(env: Env, outbox: OutboxRow, token: string, code: ProjectActivityPermanentCode, now: number): Promise<void> {
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE notification_delivery_ledger
      SET status = 'failed', last_error_code = ?, last_error = 'Project activity could not be processed.', updated_at = ?
      WHERE outbox_id = ? AND channel = 'in_app' AND status IN ('pending', 'processing')
        AND EXISTS (SELECT 1 FROM notification_outbox o WHERE o.id = ? AND o.status = 'processing' AND o.lease_token = ? AND o.event_type = ?)
    `).bind(code, now, outbox.id, outbox.id, token, NOTIFICATION_OUTBOX_EVENT_TYPES.projectActivityBroad),
    env.DB.prepare(`
      UPDATE notification_outbox
      SET status = 'failed', lease_token = NULL, lease_expires_at = NULL, completed_at = ?, last_error_code = ?, last_error = 'Project activity could not be processed.', updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_token = ? AND event_type = ?
    `).bind(now, code, now, outbox.id, token, NOTIFICATION_OUTBOX_EVENT_TYPES.projectActivityBroad),
    env.DB.prepare(`
      INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?, NULL, 'notification.delivery.failed', 'notification_outbox', ?, ?, ? WHERE changes() = 1
    `).bind(crypto.randomUUID(), outbox.id, JSON.stringify({ eventType: outbox.event_type, outboxId: outbox.id, recipientId: outbox.recipient_id, code }), now),
  ]);
  if ((results[1]?.meta.changes ?? 0) !== 1) return;
}

async function mirrorEmailOutcome(env: Env, outboxId: string, update: { emailSentAt: number; emailMessageId: string } | { emailError: string }): Promise<void> {
  try {
    if ("emailMessageId" in update) {
      await env.DB.prepare(`
        UPDATE notifications SET email_sent_at = ?, email_message_id = ?, email_error = NULL
        WHERE id = (SELECT notification_id FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'in_app')
      `).bind(update.emailSentAt, update.emailMessageId, outboxId).run();
    } else {
      await env.DB.prepare(`
        UPDATE notifications SET email_error = ?
        WHERE id = (SELECT notification_id FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'in_app')
      `).bind(update.emailError, outboxId).run();
    }
  } catch { /* Ledger remains authoritative if the compatibility mirror is gone. */ }
}

async function recordProjectDeadlineInAppLatency(env: Env, outbox: OutboxRow, deliveredAt: number): Promise<void> {
  if (outbox.event_type !== NOTIFICATION_OUTBOX_EVENT_TYPES.projectDeadlineReminder) return;
  try {
    const occurrence = await env.DB.prepare(`
      SELECT fire_at AS fireAt, created_at AS createdAt
      FROM project_deadline_occurrences
      WHERE id = ?
    `).bind(outbox.source_key).first<{ fireAt: number; createdAt: number }>();
    if (!occurrence) return;
    const operationalMetricBasis = Math.max(occurrence.fireAt, occurrence.createdAt);
    const latencyMs = deliveredAt - operationalMetricBasis;
    const details = {
      outboxId: outbox.id,
      occurrenceId: outbox.source_key,
      fireAt: occurrence.fireAt,
      operationalMetricBasis,
      deliveredAt,
      latencyMs,
    };
    if (latencyMs > PROJECT_DEADLINE_OPERATIONAL_TARGET_MS) {
      console.warn("Project Deadline in-app latency target exceeded", details);
    } else {
      console.log("Project Deadline in-app latency", details);
    }
  } catch {
    // Delivery remains authoritative when the bounded operational metric cannot be recorded.
  }
}

async function failEmailBeforeAdmission(env: Env, outbox: OutboxRow, token: string, code: string, message: string, now: number): Promise<void> {
  const result = await env.DB.prepare(`
    UPDATE notification_delivery_ledger
    SET status = 'failed', last_error_code = ?, last_error = ?, updated_at = ?
    WHERE outbox_id = ? AND channel = 'email' AND status = 'pending'
      AND EXISTS (SELECT 1 FROM notification_outbox o WHERE o.id = ? AND o.status = 'processing' AND o.lease_token = ?)
  `).bind(code, message, now, outbox.id, outbox.id, token).run();
  if ((result.meta.changes ?? 0) === 1) await mirrorEmailOutcome(env, outbox.id, { emailError: code });
}

async function quotaReleaseAndRetry(env: Env, outbox: OutboxRow, token: string, classification: EmailClassification, retryAt: number): Promise<boolean> {
  try {
    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE notification_delivery_ledger
        SET status = 'pending', last_error_code = ?, last_error = ?, updated_at = ?
        WHERE outbox_id = ? AND channel = 'email' AND status = 'processing'
          AND EXISTS (SELECT 1 FROM notification_outbox o WHERE o.id = ? AND o.status = 'processing' AND o.lease_token = ?)
      `).bind(classification.code, classification.message, retryAt, outbox.id, outbox.id, token),
      env.DB.prepare(`
        UPDATE notification_outbox
        SET status = 'queued', lease_token = NULL, lease_expires_at = NULL,
            available_at = ?, last_error_code = ?, last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_token = ?
      `).bind(retryAt, classification.code, classification.message, retryAt, outbox.id, token),
    ]);
    return (results[0]?.meta.changes ?? 0) === 1 && (results[1]?.meta.changes ?? 0) === 1;
  } catch {
    return false;
  }
}

async function finishEmail(env: Env, outbox: OutboxRow, token: string, now: number, messageAttempts: number, emailReachedProcessing: { value: boolean }): Promise<"done" | "retry"> {
  const reauthorized = await resolveRecipient(env, outbox);
  if (!reauthorized.ok) {
    if (reauthorized.kind !== "suppress") throw new Error("Legacy email resolver returned a permanent failure");
    await suppressEmailChannel(env, outbox, token, reauthorized.reason, now, reauthorized.code);
    return "done";
  }
  if (reauthorized.kind !== "legacy") throw new Error("Legacy email resolver returned a broad activity");
  if (!env.EMAIL || !env.NOTIFICATIONS_FROM_ADDRESS) {
    await failEmailBeforeAdmission(env, outbox, token, "email_configuration_missing", "Email delivery is not configured.", now);
    await completeIfTerminal(env, outbox, token, now);
    return "done";
  }
  const began = await beginChannel(env, outbox, token, "email", now);
  if (!began) {
    await completeIfTerminal(env, outbox, token, now);
    return "done";
  }
  emailReachedProcessing.value = true;
  const current = reauthorized;
  try {
    const result = await env.EMAIL.send({
      from: env.NOTIFICATIONS_FROM_ADDRESS,
      to: current.row.recipientEmail,
      subject: current.delivery.emailSubject,
      text: current.delivery.emailText,
      html: current.delivery.emailHtml,
    });
    const sentResult = await env.DB.prepare(`
      UPDATE notification_delivery_ledger
      SET status = 'sent', delivered_at = ?, email_message_id = ?, updated_at = ?, last_error_code = NULL, last_error = NULL
      WHERE outbox_id = ? AND channel = 'email' AND status = 'processing'
        AND EXISTS (SELECT 1 FROM notification_outbox o WHERE o.id = ? AND o.status = 'processing' AND o.lease_token = ?)
    `).bind(now, result.messageId, now, outbox.id, outbox.id, token).run();
    if ((sentResult.meta.changes ?? 0) === 1) await mirrorEmailOutcome(env, outbox.id, { emailSentAt: now, emailMessageId: result.messageId });
    await completeIfTerminal(env, outbox, token, now);
    return "done";
  } catch (error) {
    const classification = classifyEmailError(error);
    if (classification.kind === "quota_transient") {
      const retryAt = now + retryDelaySeconds(messageAttempts) * 1000;
      if (await quotaReleaseAndRetry(env, outbox, token, classification, retryAt)) return "retry";
      return "done";
    }
    if (classification.kind === "permanent") {
      // PERMANENT_EMAIL_CODES are all admission-time validation gates (invalid/unverified
      // sender or recipient, oversized message, malformed headers, or a documented delivery
      // rejection) that Cloudflare's API contract rejects before any send is attempted -- the
      // same "proven pre-acceptance" reasoning already applied to the quota codes above. This is
      // real proof of non-acceptance, so `failed` is correct and safe: it never contradicts the
      // "no path may move an *ambiguous* processing attempt to failed" invariant, because this
      // response is not ambiguous. Only a genuinely uncoded/unrecognized error (the `else`
      // branch) or an external observer with no direct proof (DLQ/Cron/discard) must stay
      // conservative and land on `unknown`.
      const failedResult = await env.DB.prepare(`
        UPDATE notification_delivery_ledger
        SET status = 'failed', last_error_code = ?, last_error = ?, updated_at = ?
        WHERE outbox_id = ? AND channel = 'email' AND status = 'processing'
          AND EXISTS (SELECT 1 FROM notification_outbox o WHERE o.id = ? AND o.status = 'processing' AND o.lease_token = ?)
      `).bind(classification.code, classification.message, now, outbox.id, outbox.id, token).run();
      if ((failedResult.meta.changes ?? 0) === 1) await mirrorEmailOutcome(env, outbox.id, { emailError: classification.code });
      await completeIfTerminal(env, outbox, token, now);
      return "done";
    } else {
      const unknownResult = await env.DB.prepare(`
        UPDATE notification_delivery_ledger
        SET status = 'unknown', last_error_code = 'email_acceptance_unknown', last_error = ?, updated_at = ?
        WHERE outbox_id = ? AND channel = 'email' AND status = 'processing'
          AND EXISTS (SELECT 1 FROM notification_outbox o WHERE o.id = ? AND o.status = 'processing' AND o.lease_token = ?)
      `).bind(classification.message, now, outbox.id, outbox.id, token).run();
      if ((unknownResult.meta.changes ?? 0) === 1) await mirrorEmailOutcome(env, outbox.id, { emailError: "email_acceptance_unknown" });
    }
    await completeIfTerminal(env, outbox, token, now);
    return "done";
  }
}

export async function processNotificationMessage(env: Env, message: Message<NotificationOutboxMessage>): Promise<"acked" | "retried"> {
  const now = Date.now();
  const claimed = await claimOutbox(env, message.body.outboxId, now);
  if (!claimed) {
    const row = await readOutbox(env, message.body.outboxId);
    if (row && ["pending", "queued"].includes(row.status) && row.available_at > now) {
      const delaySeconds = Math.min(NOTIFICATION_QUEUE_MAX_DELAY_SECONDS, Math.max(1, Math.ceil((row.available_at - now) / 1000)));
      message.retry({ delaySeconds });
      return "retried";
    }
    message.ack();
    return "acked";
  }
  const { row, token } = claimed;
  let emailReachedProcessing = { value: false };
  try {
    const resolved = await resolveRecipient(env, row);
    if (!resolved.ok) {
      if (resolved.kind === "suppress") await suppressWholeOccurrence(env, row, token, resolved.reason, now, resolved.code);
      else await failWholeOccurrence(env, row, token, resolved.code, now);
      message.ack();
      return "acked";
    }
    if (resolved.kind === "broad") {
      // Broad delivery has no email phase. This dispatch remains defensive: the atomic broad
      // batch normally terminalizes the outbox. This read/ack is defensive only; it never writes
      // a second terminal transition.
      await deliverBroadInApp(env, row, token, resolved, now);
      const broadCurrent = await readOutbox(env, row.id);
      if (!broadCurrent || !["completed", "failed"].includes(broadCurrent.status)) throw new Error("Broad delivery returned without a terminal outbox state");
      message.ack();
      return "acked";
    }
    await deliverInApp(env, row, token, resolved, now);
    const current = await readOutbox(env, row.id);
    if (!current || current.status !== "processing") {
      message.ack();
      return "acked";
    }
    const emailResult = await finishEmail(env, row, token, now, message.attempts, emailReachedProcessing);
    if (emailResult === "retry") {
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      return "retried";
    }
    message.ack();
    return "acked";
  } catch (error) {
    if (!emailReachedProcessing.value) {
      const retryAt = now + retryDelaySeconds(message.attempts) * 1000;
      if (await releaseBeforeRetry(env, row, token, retryAt)) {
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
        return "retried";
      }
      message.ack();
      return "acked";
    }
    // Once email crossed processing, retain the lease. A Queue retry cannot reclaim it, and
    // Cron/DLQ will resolve the ambiguous outcome to `unknown` after the lease expires.
    console.error("Notification delivery failed after email ambiguity fence", { outboxId: row.id, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    message.retry();
    return "retried";
  }
}

async function recordNotificationDlq(env: Env, outboxId: string, now: number): Promise<void> {
  const source = await env.DB.prepare("SELECT event_type AS eventType FROM notification_outbox WHERE id = ?").bind(outboxId).first<{ eventType: string }>();
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE notification_delivery_ledger
      SET status = 'unknown', last_error_code = 'email_acceptance_unknown', last_error = 'Queue retries exhausted after email submission began.', updated_at = ?
      WHERE outbox_id = ? AND channel = 'email' AND status = 'processing'
        AND EXISTS (SELECT 1 FROM notification_outbox o WHERE o.id = notification_delivery_ledger.outbox_id AND o.status IN ('pending', 'queued', 'processing') AND (o.status != 'processing' OR o.lease_expires_at <= ?))
    `).bind(now, outboxId, now),
    env.DB.prepare(`
      UPDATE notification_delivery_ledger
      SET status = 'failed', last_error_code = 'queue_retries_exhausted', last_error = 'Queue retries exhausted before delivery completed.', updated_at = ?
      WHERE outbox_id = ? AND channel = 'email' AND status = 'pending'
        AND EXISTS (
          SELECT 1 FROM notification_outbox o
          WHERE o.id = notification_delivery_ledger.outbox_id
            AND o.status IN ('pending', 'queued', 'processing')
            AND (o.status != 'processing' OR o.lease_expires_at <= ?)
        )
    `).bind(now, outboxId, now),
    env.DB.prepare(`
      UPDATE notification_delivery_ledger
      SET status = 'failed', last_error_code = 'queue_retries_exhausted', last_error = 'Queue retries exhausted before delivery completed.', updated_at = ?
      WHERE outbox_id = ? AND channel = 'in_app' AND status IN ('pending', 'processing')
        AND EXISTS (
          SELECT 1 FROM notification_outbox o
          WHERE o.id = notification_delivery_ledger.outbox_id
            AND o.status IN ('pending', 'queued', 'processing')
            AND (o.status != 'processing' OR o.lease_expires_at <= ?)
        )
    `).bind(now, outboxId, now),
    env.DB.prepare(`
      UPDATE notification_outbox
      SET status = 'dlq', lease_token = NULL, lease_expires_at = NULL,
          last_error_code = 'queue_retries_exhausted', last_error = 'Queue retries exhausted before delivery completed.', updated_at = ?
      WHERE id = ? AND status IN ('pending', 'queued', 'processing')
        AND (status != 'processing' OR lease_expires_at <= ?)
    `).bind(now, outboxId, now),
    env.DB.prepare(`
      INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?, NULL, 'notification.delivery.dlq', 'notification_outbox', ?, ?, ?
      WHERE changes() = 1
    `).bind(crypto.randomUUID(), outboxId, JSON.stringify({ eventType: source?.eventType ?? "unknown", outboxId, reason: "queue_retries_exhausted" }), now),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 1) await mirrorEmailOutcome(env, outboxId, { emailError: "email_acceptance_unknown" });
  else if ((results[1]?.meta.changes ?? 0) === 1) await mirrorEmailOutcome(env, outboxId, { emailError: "queue_retries_exhausted" });
}

export async function processNotificationDlqMessage(env: Env, message: Message<NotificationOutboxMessage>): Promise<"acked" | "retried"> {
  const now = Date.now();
  const row = await env.DB.prepare("SELECT status, lease_expires_at AS leaseExpiresAt FROM notification_outbox WHERE id = ?").bind(message.body.outboxId).first<{ status: string; leaseExpiresAt: number | null }>();
  if (!row) { message.ack(); return "acked"; }
  if (row.status === "processing" && row.leaseExpiresAt !== null && row.leaseExpiresAt > now) {
    message.retry();
    return "retried";
  }
  try {
    await recordNotificationDlq(env, message.body.outboxId, now);
    message.ack();
    return "acked";
  } catch (error) {
    console.error("Notification DLQ recording failed", { outboxId: message.body.outboxId, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    message.retry();
    return "retried";
  }
}

export async function recoverNotificationOutbox(env: Env, scheduledTime: number): Promise<number> {
  const now = scheduledTime;
  const expiredEmail = await env.DB.prepare(`
    SELECT outbox_id AS outboxId FROM notification_delivery_ledger
    WHERE channel = 'email' AND status = 'processing'
      AND outbox_id IN (SELECT id FROM notification_outbox WHERE status = 'processing' AND lease_expires_at <= ?)
    ORDER BY outbox_id LIMIT ${NOTIFICATION_RECOVERY_LIMIT}
  `).bind(now).all<{ outboxId: string }>();
  if (expiredEmail.results.length > 0) {
    const expiredEmailIds = expiredEmail.results.map(({ outboxId }) => outboxId);
    const placeholders = expiredEmailIds.map(() => "?").join(", ");
    const recoveredEmail = await env.DB.prepare(`
      UPDATE notification_delivery_ledger
      SET status = 'unknown', last_error_code = 'email_acceptance_unknown', last_error = 'Email attempt lease expired after submission began.', updated_at = ?
      WHERE channel = 'email' AND status = 'processing'
        AND outbox_id IN (SELECT id FROM notification_outbox WHERE status = 'processing' AND lease_expires_at <= ?)
        AND outbox_id IN (${placeholders})
      RETURNING outbox_id AS outboxId
    `).bind(now, now, ...expiredEmailIds).all<{ outboxId: string }>();
    for (const { outboxId } of recoveredEmail.results) await mirrorEmailOutcome(env, outboxId, { emailError: "email_acceptance_unknown" });
  }
  await env.DB.prepare(`
    UPDATE notification_outbox
    SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
        completed_at = ?, last_error_code = 'email_acceptance_unknown',
        last_error = 'Email outcome requires operator review.', updated_at = ?
    WHERE status = 'processing' AND lease_expires_at <= ?
      AND EXISTS (SELECT 1 FROM notification_delivery_ledger l WHERE l.outbox_id = notification_outbox.id AND l.channel = 'email' AND l.status = 'unknown')
  `).bind(now, now, now).run();
  await env.DB.prepare(`
    UPDATE notification_delivery_ledger
    SET status = 'pending', last_error_code = 'delivery_lease_expired',
        last_error = 'In-app delivery lease expired before completion.', updated_at = ?
    WHERE channel = 'in_app' AND status = 'processing'
      AND outbox_id IN (SELECT id FROM notification_outbox WHERE status = 'processing' AND lease_expires_at <= ?)
  `).bind(now, now).run();
  await env.DB.prepare(`
    UPDATE notification_outbox
    SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
        available_at = ?, last_error_code = 'delivery_lease_expired',
        last_error = 'Delivery lease expired before an ambiguous email attempt.', updated_at = ?
    WHERE status = 'processing' AND lease_expires_at <= ?
      AND NOT EXISTS (SELECT 1 FROM notification_delivery_ledger l WHERE l.outbox_id = notification_outbox.id AND l.channel = 'email' AND l.status IN ('processing', 'unknown'))
  `).bind(now, now, now).run();
  const candidates = await env.DB.prepare(`
    SELECT id FROM notification_outbox
    WHERE (status = 'pending' AND available_at <= ?)
       OR (status = 'queued' AND queue_published_at <= ? AND available_at <= ?)
    ORDER BY created_at, id LIMIT ${NOTIFICATION_RECOVERY_LIMIT}
  `).bind(now, now - NOTIFICATION_QUEUE_STUCK_MS, now).all<{ id: string }>();
  await publishNotificationOutbox(env.NOTIFICATION_QUEUE, env.DB, candidates.results.map((row) => row.id), now);
  return candidates.results.length;
}

export function parseNotificationQueueBody(queue: string, value: unknown): NotificationOutboxMessage | null {
  if (queue !== NOTIFICATION_QUEUE_NAME && queue !== NOTIFICATION_DLQ_QUEUE_NAME) return null;
  return parseNotificationOutboxMessage(value);
}
