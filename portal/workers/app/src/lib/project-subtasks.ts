import { buildProjectActivityStatements, createDb, schema } from "@quincy/db";
import { and, eq } from "drizzle-orm";
import {
  CHECKLIST_SCHEDULE_ZONE,
  CHECKLIST_SCHEDULE_RANGES_ENABLED,
  checklistScheduleToDto,
  normalizeChecklistSchedule,
  serializeChecklistSchedule,
  type ChecklistScheduleDto,
  type ChecklistScheduleStorage,
  type InitialChecklistScheduleInput,
  type SaveChecklistScheduleRequest,
  type NormalizedChecklistSchedule,
  projectActivityCoalesce,
  projectActivityDeepLink,
  publishNotificationOutbox,
  type ProjectActivityIntent,
} from "@quincy/shared";
import type { AppEnv, SessionUser } from "../env";
import { auditMeta } from "./audit";
import { newId } from "./ids";
import { notifySubtaskAssignee } from "./notifications";
import { projectMentionableUsers } from "./project-collaboration";
import { hasProjectCollaborationAccessForUser } from "../middleware/capability";

export const POSITION_STEP = 1024;

export type CreateItemInput = { title: string; assigneeId?: string | null };
export type ItemPatch = { title?: string; done?: boolean; assigneeId?: string | null };

export type ProjectSubtaskDto = {
  id: string;
  title: string;
  done: boolean;
  position: number;
  assignee: { id: string; name: string } | null;
  assignmentVersion: number;
  dueDate: string | null;
  schedule: ChecklistScheduleDto;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

type SubtaskRow = {
  subtask: typeof schema.projectSubtasks.$inferSelect;
  assigneeId: string | null;
  assigneeName: string | null;
};

type SuccessResult = {
  outcome: "created" | "updated" | "noop";
  item: ProjectSubtaskDto;
  broadPublicationIds: string[];
  assignmentNotice: AssignmentNotice | null;
};

type AssignmentNotice = {
  projectId: string;
  actorId: string;
  assigneeId: string | null;
  subtaskId: string;
  assignmentVersion: number;
};

export type ProjectSubtaskCommandResult =
  | SuccessResult
  | { outcome: "invalid_request"; status: 400 | 503; code: string; message: string; details?: { endpoint?: "start" | "end"; choices?: Array<{ disambiguation: "earlier" | "later"; utcOffsetMinutes: number }> } }
  | { outcome: "forbidden" }
  | { outcome: "not_found"; target: "project" | "subtask" }
  | { outcome: "schedule_conflict"; current: ChecklistScheduleDto; currentSubtask?: ProjectSubtaskDto }
  | { outcome: "item_conflict"; current: ChecklistScheduleDto; currentSubtask: ProjectSubtaskDto }
  | { outcome: "storage_invalid"; current: ChecklistScheduleDto & { state: "invalid" } };

export type SaveProjectSubtaskInput = {
  env: AppEnv["Bindings"];
  projectId: string;
  principal: SessionUser;
  operation:
    | { kind: "create"; item: CreateItemInput; schedule?: InitialChecklistScheduleInput; legacyDueDate?: string }
    | { kind: "update"; subtaskId: string; itemPatch?: ItemPatch; scheduleRequest?: SaveChecklistScheduleRequest; legacyDueDatePatch?: string | null };
  now?: number;
};

function rowsFromD1<T>(result: unknown): T[] { return ((result as { results?: T[] } | undefined)?.results ?? []); }

function subtaskQuery(db: ReturnType<typeof createDb>, projectId: string, subtaskId?: string) {
  return db.select({ subtask: schema.projectSubtasks, assigneeId: schema.user.id, assigneeName: schema.user.name })
    .from(schema.projectSubtasks).leftJoin(schema.user, eq(schema.projectSubtasks.assigneeId, schema.user.id))
    .where(and(eq(schema.projectSubtasks.projectId, projectId), subtaskId ? eq(schema.projectSubtasks.id, subtaskId) : undefined));
}

function scheduleStorage(row: SubtaskRow["subtask"]): ChecklistScheduleStorage {
  return {
    dueDate: row.dueDate,
    scheduleStartKind: row.scheduleStartKind,
    scheduleStartCivil: row.scheduleStartCivil,
    scheduleStartAt: row.scheduleStartAt,
    scheduleStartUtcOffsetMinutes: row.scheduleStartUtcOffsetMinutes,
    scheduleStartFold: row.scheduleStartFold,
    scheduleEndKind: row.scheduleEndKind,
    scheduleEndAt: row.scheduleEndAt,
    scheduleEndUtcOffsetMinutes: row.scheduleEndUtcOffsetMinutes,
    scheduleEndFold: row.scheduleEndFold,
    scheduleZone: row.scheduleZone,
    scheduleVersion: row.scheduleVersion,
  };
}

export function serializeProjectSubtask(row: SubtaskRow): ProjectSubtaskDto {
  const schedule = serializeChecklistSchedule(scheduleStorage(row.subtask));
  return {
    id: row.subtask.id,
    title: row.subtask.title,
    done: row.subtask.done,
    position: row.subtask.position,
    assignee: row.assigneeId && row.assigneeName ? { id: row.assigneeId, name: row.assigneeName } : null,
    assignmentVersion: row.subtask.assignmentVersion,
    dueDate: row.subtask.dueDate,
    schedule,
    createdBy: row.subtask.createdBy,
    createdAt: row.subtask.createdAt.toISOString(),
    updatedAt: row.subtask.updatedAt.toISOString(),
  };
}

type RequestDetails = { endpoint?: "start" | "end"; choices?: Array<{ disambiguation: "earlier" | "later"; utcOffsetMinutes: number }> };

function invalidRequest(code: string, message: string, details?: RequestDetails, status: 400 | 503 = 400): ProjectSubtaskCommandResult {
  return { outcome: "invalid_request", status, code, message, ...(details ? { details } : {}) };
}

const SCHEDULE_KEYS: Array<keyof ChecklistScheduleStorage> = [
  "dueDate", "scheduleStartKind", "scheduleStartCivil", "scheduleStartAt", "scheduleStartUtcOffsetMinutes", "scheduleStartFold",
  "scheduleEndKind", "scheduleEndAt", "scheduleEndUtcOffsetMinutes", "scheduleEndFold", "scheduleZone",
];

function rawScheduleEqual(a: ChecklistScheduleStorage, b: ChecklistScheduleStorage): boolean {
  return SCHEDULE_KEYS.every((key) => a[key] === b[key]);
}

function semanticScheduleEqual(a: ChecklistScheduleDto, b: ChecklistScheduleDto): boolean {
  if ((a.state === "legacy_unresolved") || (b.state === "legacy_unresolved") || a.state === "invalid" || b.state === "invalid") return false;
  const endpointEqual = (left: typeof a.start, right: typeof b.start) => {
    if (!left || !right) return left === right;
    return left.kind === right.kind && left.localCivil === right.localCivil && left.instant === right.instant && left.utcOffsetMinutes === right.utcOffsetMinutes && left.fold === right.fold;
  };
  return a.state === b.state && a.due === b.due && endpointEqual(a.start, b.start) && endpointEqual(a.end, b.end);
}

function scheduleDiff(current: ChecklistScheduleDto, next: ChecklistScheduleDto): { startChanged: boolean; endChanged: boolean } {
  const startChanged = current.state === "legacy_unresolved" || next.state === "legacy_unresolved"
    ? true
    : JSON.stringify(current.start) !== JSON.stringify(next.start);
  const endChanged = current.state === "legacy_unresolved" || next.state === "legacy_unresolved"
    ? true
    : JSON.stringify(current.end) !== JSON.stringify(next.end) || current.due !== next.due;
  return { startChanged, endChanged };
}

function withVersion(value: NormalizedChecklistSchedule, scheduleVersion: number, startChanged: boolean, endChanged: boolean): NormalizedChecklistSchedule {
  return { ...value, scheduleVersion, startChanged, endChanged };
}

function validateTitle(title: unknown): ProjectSubtaskCommandResult | null {
  if (typeof title !== "string" || !title.trim() || title.length > 500 || title.trim() !== title) return invalidRequest("subtask_invalid_title", "Enter a checklist title from 1 to 500 characters.");
  return null;
}

async function authorizedProject(env: AppEnv["Bindings"], principal: SessionUser, projectId: string) {
  if (!await hasProjectCollaborationAccessForUser(env, principal, projectId)) return null;
  return createDb(env.DB).select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
}

function activityFor(itemId: string, projectId: string, actorId: string, now: number, title: string, type: "created" | "updated", changes?: Array<"title" | "completion" | "assignee">): ProjectActivityIntent {
  const activityId = newId();
  return {
    schemaVersion: 1,
    activity: {
      id: activityId,
      type: type === "created" ? "project.checklist.item_created" : "project.checklist.item_updated",
      projectId,
      actorId,
      occurredAt: now,
      source: { kind: "project_checklist", id: itemId, key: type === "created" ? `project-checklist:${itemId}:created` : `project-checklist:${itemId}:updated:${activityId}` },
      safePayload: type === "created" ? { itemId, checklistTitle: title } : { itemId, checklistTitle: title, changes: changes ?? [] },
      deepLink: projectActivityDeepLink(type === "created" ? "project.checklist.item_created" : "project.checklist.item_updated", projectId),
    },
    broadDelivery: { registryKey: type === "created" ? "project.checklist.item_created" : "project.checklist.item_updated", sourceActivityId: activityId, coalesce: null },
  };
}

function scheduleActivityFor(itemId: string, projectId: string, actorId: string, now: number, title: string, state: "unscheduled" | "due_only" | "range", version: number): ProjectActivityIntent {
  const activityId = newId();
  const safePayload = { itemId, checklistTitle: title, scheduleState: state, version } as const;
  return {
    schemaVersion: 1,
    activity: {
      id: activityId,
      type: "project.checklist.schedule_changed",
      projectId,
      actorId,
      occurredAt: now,
      source: { kind: "project_checklist", id: itemId, key: `project-checklist-schedule:${projectId}:${itemId}:version:${version}` },
      safePayload,
      deepLink: projectActivityDeepLink("project.checklist.schedule_changed", projectId),
    },
    broadDelivery: { registryKey: "project.checklist.schedule_changed", sourceActivityId: activityId, coalesce: projectActivityCoalesce("project.checklist.schedule_changed", projectId, actorId, safePayload) },
  };
}

function publicationIds(results: unknown[], statementOffset: number, bundle: ReturnType<typeof buildProjectActivityStatements>): string[] {
  return rowsFromD1<{ id: string }>(results[statementOffset + bundle.broadOutboxIndex]).map((row) => row.id);
}

export async function saveProjectSubtask(input: SaveProjectSubtaskInput): Promise<ProjectSubtaskCommandResult> {
  const { env, projectId, principal, operation } = input;
  const titleError = operation.kind === "create"
    ? validateTitle(operation.item.title)
    : operation.itemPatch?.title === undefined ? null : validateTitle(operation.itemPatch.title);
  if (titleError) return titleError;
  const project = await authorizedProject(env, principal, projectId);
  if (!project) return (await hasProjectCollaborationAccessForUser(env, principal, projectId)) ? { outcome: "not_found", target: "project" } : { outcome: "forbidden" };
  const db = createDb(env.DB);
  const now = input.now ?? Date.now();

  if (operation.kind === "create") {
    if (operation.schedule && operation.legacyDueDate !== undefined) return invalidRequest("subtask_schedule_inputs_conflict", "Choose either schedule or dueDate, not both.");
    const legacyDueDateRequested = operation.legacyDueDate !== undefined;
    const requested = legacyDueDateRequested ? null : operation.schedule ?? { state: "unscheduled" as const };
    if (requested?.state === "range" && !CHECKLIST_SCHEDULE_RANGES_ENABLED) return invalidRequest("subtask_schedule_ranges_disabled", "Range scheduling is not enabled in this app version.", undefined, 503);
    const assigneeId = operation.item.assigneeId ?? null;
    if (assigneeId && !(await projectMentionableUsers(env, projectId)).some((user) => user.id === assigneeId)) return invalidRequest("subtask_assignee_ineligible", "Assignee is not an active project participant.");
    const normalized = requested ? normalizeChecklistSchedule(requested, requested.state === "unscheduled" ? 0 : 1) : null;
    if (normalized && !normalized.ok) return invalidRequest(normalized.error.code, normalized.error.message, normalized.error.endpoint ? { endpoint: normalized.error.endpoint, ...(normalized.error.choices ? { choices: normalized.error.choices } : {}) } : undefined);
    const last = await env.DB.prepare("SELECT position FROM project_subtasks WHERE project_id = ? ORDER BY position DESC, id DESC LIMIT 1").bind(projectId).first<{ position: number }>();
    const id = newId();
    const auditId = newId();
    const activity = activityFor(id, projectId, principal.id, now, operation.item.title, "created");
    const bundle = buildProjectActivityStatements({ db: env.DB, intent: activity, winnerAuditId: auditId, createdAt: now });
    const schedule = normalized?.value;
    const canonicalSchedule = schedule!;
    const insert = legacyDueDateRequested
      ? env.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignee_id, assignment_version, due_date, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)").bind(id, projectId, operation.item.title, (last?.position ?? 0) + POSITION_STEP, assigneeId, assigneeId ? 1 : 0, operation.legacyDueDate!, principal.id, now, now)
      : env.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignee_id, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, projectId, operation.item.title, (last?.position ?? 0) + POSITION_STEP, assigneeId, assigneeId ? 1 : 0, canonicalSchedule.dueDate, canonicalSchedule.scheduleStartKind, canonicalSchedule.scheduleStartCivil, canonicalSchedule.scheduleStartAt, canonicalSchedule.scheduleStartUtcOffsetMinutes, canonicalSchedule.scheduleStartFold, canonicalSchedule.scheduleEndKind, canonicalSchedule.scheduleEndAt, canonicalSchedule.scheduleEndUtcOffsetMinutes, canonicalSchedule.scheduleEndFold, canonicalSchedule.scheduleZone, canonicalSchedule.scheduleVersion, principal.id, now, now);
    const results = await env.DB.batch([
      insert,
      env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, ?, 'project_subtask.create', 'project_subtask', ?, ?, ? WHERE changes() = 1").bind(auditId, principal.id, id, auditMeta(principal, legacyDueDateRequested ? undefined : { scheduleState: canonicalSchedule.state, scheduleVersion: canonicalSchedule.scheduleVersion }), now),
      ...bundle.statements,
    ]);
    const item = await subtaskQuery(db, projectId, id).get();
    if (!item) throw new Error("Subtask could not be created");
    return { outcome: "created", item: serializeProjectSubtask(item), broadPublicationIds: publicationIds(results, 2, bundle), assignmentNotice: assigneeId && assigneeId !== principal.id ? { projectId, actorId: principal.id, assigneeId, subtaskId: id, assignmentVersion: 1 } : null };
  }

  const existing = await subtaskQuery(db, projectId, operation.subtaskId).get();
  if (!existing) return { outcome: "not_found", target: "subtask" };
  const existingStorage = scheduleStorage(existing.subtask);
  const currentDto = serializeChecklistSchedule(existingStorage);
  const legacyDueDateRequested = operation.legacyDueDatePatch !== undefined;
  const scheduleBearing = operation.scheduleRequest !== undefined || legacyDueDateRequested;
  if (scheduleBearing && currentDto.state === "invalid") return { outcome: "storage_invalid", current: currentDto };
  if (operation.scheduleRequest && legacyDueDateRequested) return invalidRequest("subtask_schedule_inputs_conflict", "Choose either schedule or dueDate, not both.");

  let requested: InitialChecklistScheduleInput | null = null;
  let expectedVersion: number | null = null;
  let legacyDueDateChanged = false;
  if (legacyDueDateRequested) {
    if (existingStorage.scheduleVersion !== 0 || currentDto.state === "legacy_unresolved" || ![
      "unscheduled", "due_only",
    ].includes(currentDto.state)) return invalidRequest("subtask_schedule_reload_required", "This checklist item has newer schedule data. Reload and reopen the schedule editor.");
    legacyDueDateChanged = operation.legacyDueDatePatch !== existing.subtask.dueDate;
    expectedVersion = 0;
  } else if (operation.scheduleRequest) {
    if (!Number.isSafeInteger(operation.scheduleRequest.expectedVersion) || operation.scheduleRequest.expectedVersion < 0) return invalidRequest("subtask_schedule_invalid_version", "Schedule version must be a nonnegative integer.");
    if (operation.scheduleRequest.schedule.state === "range" && !CHECKLIST_SCHEDULE_RANGES_ENABLED) return invalidRequest("subtask_schedule_ranges_disabled", "Range scheduling is not enabled in this app version.", undefined, 503);
    requested = operation.scheduleRequest.schedule;
    expectedVersion = operation.scheduleRequest.expectedVersion;
  }

  if ((requested || legacyDueDateRequested) && expectedVersion !== existingStorage.scheduleVersion) return { outcome: "schedule_conflict", current: currentDto, ...(operation.itemPatch ? { currentSubtask: serializeProjectSubtask(existing) } : {}) };
  let normalized: NormalizedChecklistSchedule | null = null;
  let scheduleChanged = false;
  let startChanged = false;
  let endChanged = false;
  if (requested) {
    // Scheduled candidates use the versioned metadata shape even when they
    // are compared with a legacy version-0 due date. The version is not part
    // of semantic equality; it only keeps the candidate serializable.
    const candidateVersion = requested.state === "unscheduled" ? existingStorage.scheduleVersion : Math.max(1, existingStorage.scheduleVersion);
    const candidateResult = normalizeChecklistSchedule(requested, candidateVersion);
    if (!candidateResult.ok) return invalidRequest(candidateResult.error.code, candidateResult.error.message, candidateResult.error.endpoint ? { endpoint: candidateResult.error.endpoint, ...(candidateResult.error.choices ? { choices: candidateResult.error.choices } : {}) } : undefined);
    const candidateDto = checklistScheduleToDto(candidateResult.value);
    scheduleChanged = !semanticScheduleEqual(currentDto, candidateDto);
    if (scheduleChanged) {
      const diff = scheduleDiff(currentDto, candidateDto);
      startChanged = diff.startChanged;
      endChanged = diff.endChanged;
      normalized = withVersion(candidateResult.value, existingStorage.scheduleVersion + 1, startChanged, endChanged);
    }
  }

  const patch = operation.itemPatch ?? {};
  const titleChanged = patch.title !== undefined && patch.title !== existing.subtask.title;
  const doneChanged = patch.done !== undefined && patch.done !== existing.subtask.done;
  const assignmentChanged = Object.prototype.hasOwnProperty.call(patch, "assigneeId") && patch.assigneeId !== existing.subtask.assigneeId;
  if (patch.assigneeId && !(await projectMentionableUsers(env, projectId)).some((user) => user.id === patch.assigneeId)) return invalidRequest("subtask_assignee_ineligible", "Assignee is not an active project participant.");
  const mappedChanges = [
    ...(titleChanged ? ["title" as const] : []),
    ...(doneChanged ? ["completion" as const] : []),
    ...(assignmentChanged ? ["assignee" as const] : []),
  ];
  if (!scheduleChanged && !legacyDueDateChanged && mappedChanges.length === 0) return { outcome: "noop", item: serializeProjectSubtask(existing), broadPublicationIds: [], assignmentNotice: null };

  const setParts: string[] = [];
  const bindings: unknown[] = [];
  if (titleChanged) { setParts.push("title = ?"); bindings.push(patch.title); }
  if (doneChanged) { setParts.push("done = ?"); bindings.push(patch.done ? 1 : 0); }
  if (assignmentChanged) { setParts.push("assignee_id = ?", "assignment_version = assignment_version + 1"); bindings.push(patch.assigneeId ?? null); }
  if (legacyDueDateChanged) {
    setParts.push("due_date = ?", "due_reminder_sent_at = NULL");
    bindings.push(operation.legacyDueDatePatch);
  } else if (normalized && scheduleChanged) {
    setParts.push("due_date = ?", "schedule_start_kind = ?", "schedule_start_civil = ?", "schedule_start_at = ?", "schedule_start_utc_offset_minutes = ?", "schedule_start_fold = ?", "schedule_end_kind = ?", "schedule_end_at = ?", "schedule_end_utc_offset_minutes = ?", "schedule_end_fold = ?", "schedule_zone = ?", "schedule_version = ?");
    bindings.push(normalized.dueDate, normalized.scheduleStartKind, normalized.scheduleStartCivil, normalized.scheduleStartAt, normalized.scheduleStartUtcOffsetMinutes, normalized.scheduleStartFold, normalized.scheduleEndKind, normalized.scheduleEndAt, normalized.scheduleEndUtcOffsetMinutes, normalized.scheduleEndFold, normalized.scheduleZone, normalized.scheduleVersion);
    if (endChanged) setParts.push("due_reminder_sent_at = NULL");
  }
  setParts.push("updated_at = ?"); bindings.push(now);
  const auditId = newId();
  const nextTitle = titleChanged ? patch.title! : existing.subtask.title;
  const auditFields = legacyDueDateRequested
    ? [...(titleChanged ? ["title"] : []), ...(doneChanged ? ["done"] : []), ...(legacyDueDateChanged ? ["dueDate"] : []), ...(assignmentChanged ? ["assigneeId"] : [])]
    : [...mappedChanges, ...(scheduleChanged ? ["schedule"] : [])];
  const nextScheduleState = normalized?.state ?? currentDto.state;
  const nextScheduleVersion = normalized?.scheduleVersion ?? existingStorage.scheduleVersion;
  const auditDetails = legacyDueDateRequested
    ? { fields: auditFields }
    : { fields: auditFields, scheduleState: nextScheduleState, scheduleVersion: nextScheduleVersion };
  const statements: D1PreparedStatement[] = [env.DB.prepare(`UPDATE project_subtasks SET ${setParts.join(", ")} WHERE id = ? AND project_id = ? AND title IS ? AND done IS ? AND due_date IS ? AND assignee_id IS ? AND schedule_start_kind IS ? AND schedule_start_civil IS ? AND schedule_start_at IS ? AND schedule_start_utc_offset_minutes IS ? AND schedule_start_fold IS ? AND schedule_end_kind IS ? AND schedule_end_at IS ? AND schedule_end_utc_offset_minutes IS ? AND schedule_end_fold IS ? AND schedule_zone IS ? AND schedule_version IS ? RETURNING id, assignee_id AS assigneeId, assignment_version AS assignmentVersion`).bind(...bindings, operation.subtaskId, projectId, existing.subtask.title, existing.subtask.done ? 1 : 0, existing.subtask.dueDate, existing.subtask.assigneeId, existing.subtask.scheduleStartKind, existing.subtask.scheduleStartCivil, existing.subtask.scheduleStartAt, existing.subtask.scheduleStartUtcOffsetMinutes, existing.subtask.scheduleStartFold, existing.subtask.scheduleEndKind, existing.subtask.scheduleEndAt, existing.subtask.scheduleEndUtcOffsetMinutes, existing.subtask.scheduleEndFold, existing.subtask.scheduleZone, existing.subtask.scheduleVersion)];
  statements.push(env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, ?, 'project_subtask.update', 'project_subtask', ?, ?, ? WHERE changes() = 1").bind(auditId, principal.id, operation.subtaskId, auditMeta(principal, auditDetails), now));
  const bundles: Array<{ bundle: ReturnType<typeof buildProjectActivityStatements>; offset: number }> = [];
  if (mappedChanges.length) {
    const bundle = buildProjectActivityStatements({ db: env.DB, intent: activityFor(operation.subtaskId, projectId, principal.id, now, nextTitle, "updated", mappedChanges), winnerAuditId: auditId, createdAt: now });
    bundles.push({ bundle, offset: statements.length }); statements.push(...bundle.statements);
  }
  if (scheduleChanged && normalized) {
    const bundle = buildProjectActivityStatements({ db: env.DB, intent: scheduleActivityFor(operation.subtaskId, projectId, principal.id, now, nextTitle, normalized.state, normalized.scheduleVersion), winnerAuditId: auditId, createdAt: now, broadMode: endChanged ? "emit" : "activity_only" });
    bundles.push({ bundle, offset: statements.length }); statements.push(...bundle.statements);
  }
  const results = await env.DB.batch(statements);
  const winner = rowsFromD1<{ id: string; assigneeId: string | null; assignmentVersion: number }>(results[0])[0];
  if (!winner) {
    const current = await subtaskQuery(db, projectId, operation.subtaskId).get();
    if (!current) return { outcome: "not_found", target: "subtask" };
    const authoritativeStorage = scheduleStorage(current.subtask);
    const authoritativeSchedule = serializeChecklistSchedule(authoritativeStorage);
    if (scheduleBearing && (!rawScheduleEqual(authoritativeStorage, existingStorage) || authoritativeStorage.scheduleVersion !== existingStorage.scheduleVersion)) return { outcome: "schedule_conflict", current: authoritativeSchedule, ...(operation.itemPatch ? { currentSubtask: serializeProjectSubtask(current) } : {}) };
    if (scheduleBearing) return { outcome: "item_conflict", current: authoritativeSchedule, currentSubtask: serializeProjectSubtask(current) };
    return { outcome: "noop", item: serializeProjectSubtask(current), broadPublicationIds: [], assignmentNotice: null };
  }
  const item = await subtaskQuery(db, projectId, operation.subtaskId).get();
  if (!item) throw new Error("Subtask could not be reread after update");
  return {
    outcome: "updated",
    item: serializeProjectSubtask(item),
    broadPublicationIds: bundles.flatMap(({ bundle, offset }) => publicationIds(results, offset, bundle)),
    assignmentNotice: assignmentChanged && winner.assigneeId && winner.assigneeId !== principal.id ? { projectId, actorId: principal.id, assigneeId: winner.assigneeId, subtaskId: operation.subtaskId, assignmentVersion: winner.assignmentVersion } : null,
  };
}

export async function finalizeProjectSubtaskCommandResult(input: { env: AppEnv["Bindings"]; executionCtx: { waitUntil(promise: Promise<unknown>): void }; result: ProjectSubtaskCommandResult }): Promise<void> {
  const result = input.result;
  if (result.outcome !== "created" && result.outcome !== "updated") return;
  if (result.broadPublicationIds.length) input.executionCtx.waitUntil(publishNotificationOutbox(input.env.NOTIFICATION_QUEUE, input.env.DB, result.broadPublicationIds));
  if (result.assignmentNotice) await notifySubtaskAssignee(input.env, result.assignmentNotice);
}

export { CHECKLIST_SCHEDULE_ZONE };
