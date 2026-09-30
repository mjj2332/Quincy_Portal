import { buildProjectActivityStatements, createDb, schema } from "@quincy/db";
import { and, eq } from "drizzle-orm";
import {
  CHECKLIST_SCHEDULE_ZONE,
  checklistScheduleToDto,
  defaultSubtaskRange,
  effectiveDeadlineLocalCivil,
  normalizeChecklistSchedule,
  type ChecklistScheduleDto,
  type ChecklistScheduleStorage,
  type RangeChecklistScheduleInput,
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
import { serializeSubtaskSchedule } from "./subtask-schedule";
import { relationDeleteOne, relationInsertFromColumn } from "./subtask-assignees";
import { projectMentionableUsers } from "./project-collaboration";
import { hasProjectCollaborationAccessForUser } from "../middleware/capability";
import { publishOutboxDetached } from "../lib/server-timing";

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
  | { outcome: "invalid_request"; status: 400; code: string; message: string; details?: { endpoint?: "start" | "end"; choices?: Array<{ disambiguation: "earlier" | "later"; utcOffsetMinutes: number }> } }
  | { outcome: "forbidden" }
  | { outcome: "not_found"; target: "project" | "subtask" }
  | { outcome: "schedule_conflict"; current: ChecklistScheduleDto; currentSubtask?: ProjectSubtaskDto }
  | { outcome: "item_conflict"; current: ChecklistScheduleDto; currentSubtask: ProjectSubtaskDto };

export type SaveProjectSubtaskInput = {
  env: AppEnv["Bindings"];
  projectId: string;
  principal: SessionUser;
  operation:
    | { kind: "create"; item: CreateItemInput; schedule?: RangeChecklistScheduleInput }
    | { kind: "update"; subtaskId: string; itemPatch?: ItemPatch; scheduleRequest?: SaveChecklistScheduleRequest };
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
  const schedule = serializeSubtaskSchedule(row.subtask.id, scheduleStorage(row.subtask));
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

function invalidRequest(code: string, message: string, details?: RequestDetails): ProjectSubtaskCommandResult {
  return { outcome: "invalid_request", status: 400, code, message, ...(details ? { details } : {}) };
}

const SCHEDULE_KEYS: Array<keyof ChecklistScheduleStorage> = [
  "dueDate", "scheduleStartKind", "scheduleStartCivil", "scheduleStartAt", "scheduleStartUtcOffsetMinutes", "scheduleStartFold",
  "scheduleEndKind", "scheduleEndAt", "scheduleEndUtcOffsetMinutes", "scheduleEndFold", "scheduleZone",
];

function rawScheduleEqual(a: ChecklistScheduleStorage, b: ChecklistScheduleStorage): boolean {
  return SCHEDULE_KEYS.every((key) => a[key] === b[key]);
}

function scheduleEndpointEqual(left: ChecklistScheduleDto["start"], right: ChecklistScheduleDto["start"]): boolean {
  return left.kind === right.kind && left.localCivil === right.localCivil && left.instant === right.instant && left.utcOffsetMinutes === right.utcOffsetMinutes && left.fold === right.fold;
}

function semanticScheduleEqual(a: ChecklistScheduleDto, b: ChecklistScheduleDto): boolean {
  return a.due === b.due && scheduleEndpointEqual(a.start, b.start) && scheduleEndpointEqual(a.end, b.end);
}

function scheduleDiff(current: ChecklistScheduleDto, next: ChecklistScheduleDto): { startChanged: boolean; endChanged: boolean } {
  return {
    startChanged: !scheduleEndpointEqual(current.start, next.start),
    endChanged: !scheduleEndpointEqual(current.end, next.end) || current.due !== next.due,
  };
}

export function scheduleActivityBroadMode(endChanged: boolean): "emit" | "activity_only" {
  return endChanged ? "emit" : "activity_only";
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
  return createDb(env.DB).select({ id: schema.projects.id, shootDate: schema.projects.shootDate, createdAt: schema.projects.createdAt, deadlineLocalCivil: schema.projects.deadlineLocalCivil, deadlineAt: schema.projects.deadlineAt }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
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

function scheduleActivityFor(itemId: string, projectId: string, actorId: string, now: number, title: string, state: "range", version: number): ProjectActivityIntent {
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
    // No range given: copy the Project's shoot date to Deadline once (ADR 0011). The copy is the Subtask's own afterwards.
    const requested = operation.schedule ?? defaultSubtaskRange({
      shootDate: project.shootDate,
      deadlineLocalCivil: effectiveDeadlineLocalCivil(project),
      projectCreatedAt: project.createdAt.getTime(),
    });
    // Ranges only (ADR 0011). The route's schema enforces this too; this guard covers direct callers.
    if (requested.state !== "range") return invalidRequest("subtask_schedule_range_required", "A Subtask needs a start and an end.");
    const assigneeId = operation.item.assigneeId ?? null;
    if (assigneeId && !(await projectMentionableUsers(env, projectId)).some((user) => user.id === assigneeId)) return invalidRequest("subtask_assignee_ineligible", "Assignee is not an active project participant.");
    const normalized = normalizeChecklistSchedule(requested, 1);
    if (!normalized.ok) return invalidRequest(normalized.error.code, normalized.error.message, normalized.error.endpoint ? { endpoint: normalized.error.endpoint, ...(normalized.error.choices ? { choices: normalized.error.choices } : {}) } : undefined);
    const last = await env.DB.prepare("SELECT position FROM project_subtasks WHERE project_id = ? ORDER BY position DESC, id DESC LIMIT 1").bind(projectId).first<{ position: number }>();
    const id = newId();
    const auditId = newId();
    const activity = activityFor(id, projectId, principal.id, now, operation.item.title, "created");
    const bundle = buildProjectActivityStatements({ db: env.DB, intent: activity, winnerAuditId: auditId, createdAt: now });
    const canonicalSchedule = normalized.value;
    const insert = env.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignee_id, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, projectId, operation.item.title, (last?.position ?? 0) + POSITION_STEP, assigneeId, assigneeId ? 1 : 0, canonicalSchedule.dueDate, canonicalSchedule.scheduleStartKind, canonicalSchedule.scheduleStartCivil, canonicalSchedule.scheduleStartAt, canonicalSchedule.scheduleStartUtcOffsetMinutes, canonicalSchedule.scheduleStartFold, canonicalSchedule.scheduleEndKind, canonicalSchedule.scheduleEndAt, canonicalSchedule.scheduleEndUtcOffsetMinutes, canonicalSchedule.scheduleEndFold, canonicalSchedule.scheduleZone, canonicalSchedule.scheduleVersion, principal.id, now, now);
    const results = await env.DB.batch([
      insert,
      env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, ?, 'project_subtask.create', 'project_subtask', ?, ?, ? WHERE changes() = 1").bind(auditId, principal.id, id, auditMeta(principal, { scheduleState: canonicalSchedule.state, scheduleVersion: canonicalSchedule.scheduleVersion }), now),
      ...bundle.statements,
      // Last, so the positional reads above stay valid (#364).
      ...(assigneeId ? [relationInsertFromColumn(env.DB, id, assigneeId, auditId, now)] : []),
    ]);
    const item = await subtaskQuery(db, projectId, id).get();
    if (!item) throw new Error("Subtask could not be created");
    return { outcome: "created", item: serializeProjectSubtask(item), broadPublicationIds: publicationIds(results, 2, bundle), assignmentNotice: assigneeId && assigneeId !== principal.id ? { projectId, actorId: principal.id, assigneeId, subtaskId: id, assignmentVersion: 1 } : null };
  }

  const existing = await subtaskQuery(db, projectId, operation.subtaskId).get();
  if (!existing) return { outcome: "not_found", target: "subtask" };
  const existingStorage = scheduleStorage(existing.subtask);
  const currentDto = serializeSubtaskSchedule(existing.subtask.id, existingStorage);
  const scheduleBearing = operation.scheduleRequest !== undefined;

  let requested: RangeChecklistScheduleInput | null = null;
  let expectedVersion: number | null = null;
  if (operation.scheduleRequest) {
    if (!Number.isSafeInteger(operation.scheduleRequest.expectedVersion) || operation.scheduleRequest.expectedVersion < 0) return invalidRequest("subtask_schedule_invalid_version", "Schedule version must be a nonnegative integer.");
    // Ranges only (ADR 0011). The route's schema enforces this too; this guard covers direct callers.
    if (operation.scheduleRequest.schedule.state !== "range") return invalidRequest("subtask_schedule_range_required", "A Subtask needs a start and an end.");
    requested = operation.scheduleRequest.schedule;
    expectedVersion = operation.scheduleRequest.expectedVersion;
  }

  if (requested && expectedVersion !== existingStorage.scheduleVersion) return { outcome: "schedule_conflict", current: currentDto, ...(operation.itemPatch ? { currentSubtask: serializeProjectSubtask(existing) } : {}) };
  let normalized: NormalizedChecklistSchedule | null = null;
  let scheduleChanged = false;
  let startChanged = false;
  let endChanged = false;
  if (requested) {
    // The version is not part of semantic equality; it only keeps the candidate serializable.
    const candidateVersion = Math.max(1, existingStorage.scheduleVersion);
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
  if (!scheduleChanged && mappedChanges.length === 0) return { outcome: "noop", item: serializeProjectSubtask(existing), broadPublicationIds: [], assignmentNotice: null };

  const setParts: string[] = [];
  const bindings: unknown[] = [];
  if (titleChanged) { setParts.push("title = ?"); bindings.push(patch.title); }
  if (doneChanged) { setParts.push("done = ?"); bindings.push(patch.done ? 1 : 0); }
  if (assignmentChanged) { setParts.push("assignee_id = ?", "assignment_version = assignment_version + 1"); bindings.push(patch.assigneeId ?? null); }
  if (normalized && scheduleChanged) {
    setParts.push("due_date = ?", "schedule_start_kind = ?", "schedule_start_civil = ?", "schedule_start_at = ?", "schedule_start_utc_offset_minutes = ?", "schedule_start_fold = ?", "schedule_end_kind = ?", "schedule_end_at = ?", "schedule_end_utc_offset_minutes = ?", "schedule_end_fold = ?", "schedule_zone = ?", "schedule_version = ?");
    bindings.push(normalized.dueDate, normalized.scheduleStartKind, normalized.scheduleStartCivil, normalized.scheduleStartAt, normalized.scheduleStartUtcOffsetMinutes, normalized.scheduleStartFold, normalized.scheduleEndKind, normalized.scheduleEndAt, normalized.scheduleEndUtcOffsetMinutes, normalized.scheduleEndFold, normalized.scheduleZone, normalized.scheduleVersion);
    if (endChanged) setParts.push("due_reminder_sent_at = NULL");
  }
  setParts.push("updated_at = ?"); bindings.push(now);
  const auditId = newId();
  const nextTitle = titleChanged ? patch.title! : existing.subtask.title;
  const auditFields = [...mappedChanges, ...(scheduleChanged ? ["schedule"] : [])];
  const nextScheduleState = normalized?.state ?? currentDto.state;
  const nextScheduleVersion = normalized?.scheduleVersion ?? existingStorage.scheduleVersion;
  const auditDetails = { fields: auditFields, scheduleState: nextScheduleState, scheduleVersion: nextScheduleVersion };
  const statements: D1PreparedStatement[] = [env.DB.prepare(`UPDATE project_subtasks SET ${setParts.join(", ")} WHERE id = ? AND project_id = ? AND title IS ? AND done IS ? AND due_date IS ? AND assignee_id IS ? AND schedule_start_kind IS ? AND schedule_start_civil IS ? AND schedule_start_at IS ? AND schedule_start_utc_offset_minutes IS ? AND schedule_start_fold IS ? AND schedule_end_kind IS ? AND schedule_end_at IS ? AND schedule_end_utc_offset_minutes IS ? AND schedule_end_fold IS ? AND schedule_zone IS ? AND schedule_version IS ? RETURNING id, assignee_id AS assigneeId, assignment_version AS assignmentVersion`).bind(...bindings, operation.subtaskId, projectId, existing.subtask.title, existing.subtask.done ? 1 : 0, existing.subtask.dueDate, existing.subtask.assigneeId, existing.subtask.scheduleStartKind, existing.subtask.scheduleStartCivil, existing.subtask.scheduleStartAt, existing.subtask.scheduleStartUtcOffsetMinutes, existing.subtask.scheduleStartFold, existing.subtask.scheduleEndKind, existing.subtask.scheduleEndAt, existing.subtask.scheduleEndUtcOffsetMinutes, existing.subtask.scheduleEndFold, existing.subtask.scheduleZone, existing.subtask.scheduleVersion)];
  statements.push(env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, ?, 'project_subtask.update', 'project_subtask', ?, ?, ? WHERE changes() = 1").bind(auditId, principal.id, operation.subtaskId, auditMeta(principal, auditDetails), now));
  const bundles: Array<{ bundle: ReturnType<typeof buildProjectActivityStatements>; offset: number }> = [];
  if (mappedChanges.length) {
    const bundle = buildProjectActivityStatements({ db: env.DB, intent: activityFor(operation.subtaskId, projectId, principal.id, now, nextTitle, "updated", mappedChanges), winnerAuditId: auditId, createdAt: now });
    bundles.push({ bundle, offset: statements.length }); statements.push(...bundle.statements);
  }
  if (scheduleChanged && normalized) {
    const bundle = buildProjectActivityStatements({ db: env.DB, intent: scheduleActivityFor(operation.subtaskId, projectId, principal.id, now, nextTitle, normalized.state, normalized.scheduleVersion), winnerAuditId: auditId, createdAt: now, broadMode: scheduleActivityBroadMode(endChanged) });
    bundles.push({ bundle, offset: statements.length }); statements.push(...bundle.statements);
  }
  if (assignmentChanged) {
    // Replace-one, appended last so every positional read stays valid (#364). Touches only the person the column held.
    if (existing.subtask.assigneeId !== null) statements.push(relationDeleteOne(env.DB, operation.subtaskId, existing.subtask.assigneeId, auditId));
    if (patch.assigneeId) statements.push(relationInsertFromColumn(env.DB, operation.subtaskId, patch.assigneeId, auditId, now));
  }
  const results = await env.DB.batch(statements);
  const winner = rowsFromD1<{ id: string; assigneeId: string | null; assignmentVersion: number }>(results[0])[0];
  if (!winner) {
    const current = await subtaskQuery(db, projectId, operation.subtaskId).get();
    if (!current) return { outcome: "not_found", target: "subtask" };
    const authoritativeStorage = scheduleStorage(current.subtask);
    const authoritativeSchedule = serializeSubtaskSchedule(current.subtask.id, authoritativeStorage);
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
  if (result.broadPublicationIds.length) input.executionCtx.waitUntil(publishOutboxDetached(input.env.NOTIFICATION_QUEUE, input.env.DB, result.broadPublicationIds));
  if (result.assignmentNotice) await notifySubtaskAssignee(input.env, result.assignmentNotice);
}

export { CHECKLIST_SCHEDULE_ZONE };
