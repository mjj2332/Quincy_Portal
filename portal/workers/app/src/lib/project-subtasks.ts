import { buildProjectActivityStatements, buildSubtaskReminderMaterialization, buildSubtaskReminderSuppression, createDb, readSubtaskReminderState, schema } from "@quincy/db";
import { and, eq } from "drizzle-orm";
import {
  CHECKLIST_SCHEDULE_ZONE,
  checklistScheduleToDto,
  defaultSubtaskRange,
  defaultSubtaskRangeDto,
  type ProjectDefaultRangeDto,
  effectiveDeadlineLocalCivil,
  normalizeChecklistSchedule,
  normalizeSubtaskReminderOffsets,
  SUBTASK_REMINDER_DEFAULT_OFFSETS,
  DEFAULT_SUBTASK_REMINDERS,
  SUBTASK_REMINDER_MAX_ADVANCE_OFFSETS,
  type SubtaskRemindersDto,
  type ChecklistScheduleDto,
  type ChecklistScheduleStorage,
  type RangeChecklistScheduleInput,
  type SaveChecklistScheduleRequest,
  type NormalizedChecklistSchedule,
  projectActivityCoalesce,
  projectActivityDeepLink,
  publishNotificationOutbox,
  ROLE_LABELS,
  SUBTASK_ACTIVITY_ASSIGNEE_IDS_MAX,
  type CalendarPerson,
  type ProjectActivityIntent,
  type SubtaskAssigneeDelta,
} from "@quincy/shared";
import type { AppEnv, SessionUser } from "../env";
import { auditMeta } from "./audit";
import { newId } from "./ids";
import { notifySubtaskAssignee } from "./notifications";
import { serializeSubtaskSchedule } from "./subtask-schedule";
import {
  externalAddEligible,
  hydrateSubtaskAssignees,
  relationDeleteMany,
  relationInsertMany,
  type HydratedAssignee,
} from "./subtask-assignees";
import { projectMentionableUsers } from "./project-collaboration";
import { hasProjectCollaborationAccessForUser } from "../middleware/capability";
import { publishOutboxDetached } from "../lib/server-timing";

export const POSITION_STEP = 1024;

/** `reminderOffsetsMinutes` is the advance set (#425); absent means the default "1 day before". The command validates it, whatever the caller. */
export type CreateItemInput = { title: string; assigneeIds: string[]; reminderOffsetsMinutes?: number[] };
/** `assignees` is the delta. */
export type ItemPatch = { title?: string; done?: boolean; assignees?: SubtaskAssigneeDelta };

export type ProjectSubtaskDto = {
  id: string;
  title: string;
  done: boolean;
  position: number;
  assignees: CalendarPerson[];
  assignmentVersion: number;
  dueDate: string | null;
  schedule: ChecklistScheduleDto;
  /** The reminder offset set and the next reminder (#425). One set per Subtask, shared by its assignees. */
  reminders: SubtaskRemindersDto;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

type SubtaskRow = {
  subtask: typeof schema.projectSubtasks.$inferSelect;
};

type SuccessResult = {
  outcome: "created" | "updated" | "noop";
  item: ProjectSubtaskDto;
  broadPublicationIds: string[];
  assignmentNotices: AssignmentNotice[];
};

type AssignmentNotice = {
  projectId: string;
  actorId: string;
  assigneeId: string;
  subtaskId: string;
  assignmentVersion: number;
};

export type ProjectSubtaskCommandResult =
  | SuccessResult
  | { outcome: "invalid_request"; status: 400; code: string; message: string; details?: RequestDetails }
  | { outcome: "forbidden" }
  | { outcome: "not_found"; target: "project" | "subtask" }
  /** The Project is archived: its Checklist is read-only (#446). An External Editor never sees this, they get `not_found`. */
  | { outcome: "project_archived" }
  | { outcome: "schedule_conflict"; current: ChecklistScheduleDto; currentSubtask: ProjectSubtaskDto }
  | { outcome: "item_conflict"; current: ChecklistScheduleDto; currentSubtask: ProjectSubtaskDto }
  | { outcome: "assignment_conflict"; currentSubtask: ProjectSubtaskDto };

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

/** The archived refusal: staff see it, an External Editor cannot see an archived Project at all (#446). */
function archivedOutcome(principal: Pick<SessionUser, "role">): ProjectSubtaskCommandResult {
  return principal.role === "external_editor" ? { outcome: "not_found", target: "project" } : { outcome: "project_archived" };
}

/** The mutation batches end with `SELECT archived_at FROM projects`: whether the Project was archived when the primary write ran. */
export const ARCHIVED_SNAPSHOT_SQL = "SELECT archived_at FROM projects WHERE id = ?";
export function archivedInSnapshot(result: unknown): boolean {
  const row = rowsFromD1<{ archived_at: number | null }>(result)[0];
  return row !== undefined && row.archived_at !== null;
}

function subtaskQuery(db: ReturnType<typeof createDb>, projectId: string, subtaskId?: string) {
  return db.select({ subtask: schema.projectSubtasks })
    .from(schema.projectSubtasks)
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

export function assigneePerson(assignee: Pick<HydratedAssignee, "id" | "name" | "role" | "active">): CalendarPerson {
  return { id: assignee.id, name: assignee.name, roleLabel: ROLE_LABELS[assignee.role], isExternal: assignee.role === "external_editor", active: assignee.active };
}

export function serializeProjectSubtask(row: SubtaskRow, assignees: HydratedAssignee[], reminders: SubtaskRemindersDto): ProjectSubtaskDto {
  const schedule = serializeSubtaskSchedule(row.subtask.id, scheduleStorage(row.subtask));
  return {
    id: row.subtask.id,
    title: row.subtask.title,
    done: row.subtask.done,
    position: row.subtask.position,
    assignees: assignees.map(assigneePerson),
    assignmentVersion: row.subtask.assignmentVersion,
    dueDate: row.subtask.dueDate,
    schedule,
    reminders,
    createdBy: row.subtask.createdBy,
    createdAt: row.subtask.createdAt.toISOString(),
    updatedAt: row.subtask.updatedAt.toISOString(),
  };
}

/** The reminders of Subtasks as the API returns them: the stored set and the next pending occurrence of the current schedule version. */
export async function readSubtaskReminders(db: D1Database, subtaskIds: readonly string[], now: number = Date.now()): Promise<Map<string, SubtaskRemindersDto>> {
  return readSubtaskReminderState(db, subtaskIds, now);
}

/** One Subtask's reminders. A row that vanished mid-request reads as the default set rather than failing the response. */
export async function readSubtaskRemindersOf(db: D1Database, subtaskId: string, now: number = Date.now()): Promise<SubtaskRemindersDto> {
  return (await readSubtaskReminderState(db, [subtaskId], now)).get(subtaskId) ?? DEFAULT_SUBTASK_REMINDERS;
}

/** The raw array is bounded before normalising, so a huge request is refused without work. Eight advance offsets is the real limit. */
const RAW_REMINDER_OFFSETS_MAX = 64;

function parseReminderOffsets(value: unknown, field: string): number[] | ProjectSubtaskCommandResult {
  if (Array.isArray(value) && value.length > RAW_REMINDER_OFFSETS_MAX) return invalidRequest("subtask_reminders_invalid", `Choose no more than ${SUBTASK_REMINDER_MAX_ADVANCE_OFFSETS} advance reminders.`, { field });
  try { return normalizeSubtaskReminderOffsets(value); }
  catch (error) { return invalidRequest("subtask_reminders_invalid", error instanceof Error ? error.message : "Invalid reminders.", { field }); }
}

function storedReminderOffsets(json: string): number[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === "number" && Number.isSafeInteger(value))) return (parsed as number[]).slice().sort((a, b) => b - a);
  } catch { /* the column CHECK guarantees a JSON array */ }
  return [...SUBTASK_REMINDER_DEFAULT_OFFSETS];
}

/** `field` is the request path of the offending value, so a client can mark the input: `schedule.end.localCivil` on create, `schedule.schedule.end.localCivil` on update. */
type RequestDetails = { endpoint?: "start" | "end"; field?: string; choices?: Array<{ disambiguation: "earlier" | "later"; utcOffsetMinutes: number }> };

function invalidRequest(code: string, message: string, details?: RequestDetails): ProjectSubtaskCommandResult {
  return { outcome: "invalid_request", status: 400, code, message, ...(details ? { details } : {}) };
}

function scheduleInvalidRequest(error: { code: string; message: string; endpoint?: "start" | "end"; choices?: RequestDetails["choices"] }, prefix: "schedule" | "schedule.schedule"): ProjectSubtaskCommandResult {
  return invalidRequest(error.code, error.message, error.endpoint ? { endpoint: error.endpoint, field: `${prefix}.${error.endpoint}.localCivil`, ...(error.choices ? { choices: error.choices } : {}) } : undefined);
}

const SCHEDULE_KEYS: Array<keyof ChecklistScheduleStorage> = [
  "dueDate", "scheduleStartKind", "scheduleStartCivil", "scheduleStartAt", "scheduleStartUtcOffsetMinutes", "scheduleStartFold",
  "scheduleEndKind", "scheduleEndAt", "scheduleEndUtcOffsetMinutes", "scheduleEndFold", "scheduleZone",
];

function rawScheduleEqual(a: ChecklistScheduleStorage, b: ChecklistScheduleStorage): boolean {
  return SCHEDULE_KEYS.every((key) => a[key] === b[key]);
}

function scheduleEndpointEqual(left: ChecklistScheduleDto["start"], right: ChecklistScheduleDto["start"]): boolean {
  return left.localCivil === right.localCivil && left.instant === right.instant && left.utcOffsetMinutes === right.utcOffsetMinutes && left.fold === right.fold;
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

/** The Project's default Subtask range input: its shoot date, creation instant and effective Deadline with its stored fold. */
export function projectDefaultRange(project: { shootDate: string | null; createdAt: Date; deadlineLocalCivil: string | null; deadlineAt: number | null; deadlineFold: number | null }): RangeChecklistScheduleInput {
  return defaultSubtaskRange(projectDefaultRangeInput(project));
}

export function projectDefaultRangeInput(project: { shootDate: string | null; createdAt: Date; deadlineLocalCivil: string | null; deadlineAt: number | null; deadlineFold: number | null }) {
  const localCivil = effectiveDeadlineLocalCivil(project);
  return {
    shootDate: project.shootDate,
    deadline: localCivil ? { localCivil, fold: project.deadlineFold === 1 ? 1 as const : 0 as const } : null,
    projectCreatedAt: project.createdAt.getTime(),
  };
}

/** The same default, as the list responses carry it for the editors' "Project default" (ADR 0016). */
export async function projectDefaultRangeDtoFor(env: AppEnv["Bindings"], projectId: string): Promise<ProjectDefaultRangeDto | null> {
  const project = await createDb(env.DB).select({ shootDate: schema.projects.shootDate, createdAt: schema.projects.createdAt, deadlineLocalCivil: schema.projects.deadlineLocalCivil, deadlineAt: schema.projects.deadlineAt, deadlineFold: schema.projects.deadlineFold }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  return project ? defaultSubtaskRangeDto(projectDefaultRangeInput(project)) : null;
}

async function authorizedProject(env: AppEnv["Bindings"], principal: SessionUser, projectId: string) {
  if (!await hasProjectCollaborationAccessForUser(env, principal, projectId)) return null;
  return createDb(env.DB).select({ id: schema.projects.id, archivedAt: schema.projects.archivedAt, shootDate: schema.projects.shootDate, createdAt: schema.projects.createdAt, deadlineLocalCivil: schema.projects.deadlineLocalCivil, deadlineAt: schema.projects.deadlineAt, deadlineFold: schema.projects.deadlineFold }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
}

function activityFor(itemId: string, projectId: string, actorId: string, now: number, title: string, type: "created" | "updated", changes?: Array<"title" | "completion" | "assignee">, delta?: Pick<SubtaskAssigneeDelta, "add" | "remove">): ProjectActivityIntent {
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
      safePayload: type === "created" ? { itemId, checklistTitle: title } : {
        itemId, checklistTitle: title, changes: changes ?? [],
        // Bounded: the 4 KB payload cap forbids unbounded arrays. The full lists are in the audit details.
        ...(delta ? {
          assigneesAdded: delta.add.slice(0, SUBTASK_ACTIVITY_ASSIGNEE_IDS_MAX), assigneesRemoved: delta.remove.slice(0, SUBTASK_ACTIVITY_ASSIGNEE_IDS_MAX),
          assigneesAddedCount: delta.add.length, assigneesRemovedCount: delta.remove.length,
        } : {}),
      },
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
  // Before the no-op check: even an identical-value patch is refused on an archived Project (#446).
  if (project.archivedAt !== null) return archivedOutcome(principal);
  const db = createDb(env.DB);
  const now = input.now ?? Date.now();

  if (operation.kind === "create") {
    // No range given: copy the Project's shoot date at 09:00 to its Deadline once (ADR 0011, ADR 0016). The copy is the Subtask's own afterwards.
    const requested = operation.schedule ?? projectDefaultRange(project);
    // Ranges only (ADR 0011). The route's schema enforces this too; this guard covers direct callers.
    if (requested.state !== "range") return invalidRequest("subtask_schedule_range_required", "A Subtask needs a start and an end.");
    const offsets = operation.item.reminderOffsetsMinutes === undefined ? [...SUBTASK_REMINDER_DEFAULT_OFFSETS] : parseReminderOffsets(operation.item.reminderOffsetsMinutes, "reminderOffsetsMinutes");
    if (!Array.isArray(offsets)) return offsets;
    const assigneeIds = [...new Set(operation.item.assigneeIds ?? [])];
    if (assigneeIds.length) {
      const eligible = await eligibleToAdd(env, principal, projectId, assigneeIds);
      if (!assigneeIds.every((id) => eligible.has(id))) return invalidRequest("subtask_assignee_ineligible", "Assignee is not an active project participant.");
    }
    const normalized = normalizeChecklistSchedule(requested, 1);
    if (!normalized.ok) return scheduleInvalidRequest(normalized.error, "schedule");
    const last = await env.DB.prepare("SELECT position FROM project_subtasks WHERE project_id = ? ORDER BY position DESC, id DESC LIMIT 1").bind(projectId).first<{ position: number }>();
    const id = newId();
    const auditId = newId();
    const activity = activityFor(id, projectId, principal.id, now, operation.item.title, "created");
    const bundle = buildProjectActivityStatements({ db: env.DB, intent: activity, winnerAuditId: auditId, createdAt: now });
    const canonicalSchedule = normalized.value;
    // The only statement that needs the archive guard: every later one is fenced on `changes() = 1` or the audit id (#446).
    const insert = env.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, reminder_offsets_json, created_by, created_at, updated_at) SELECT ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL) RETURNING id").bind(id, projectId, operation.item.title, (last?.position ?? 0) + POSITION_STEP, assigneeIds.length ? 1 : 0, canonicalSchedule.dueDate, canonicalSchedule.scheduleStartKind, canonicalSchedule.scheduleStartCivil, canonicalSchedule.scheduleStartAt, canonicalSchedule.scheduleStartUtcOffsetMinutes, canonicalSchedule.scheduleStartFold, canonicalSchedule.scheduleEndKind, canonicalSchedule.scheduleEndAt, canonicalSchedule.scheduleEndUtcOffsetMinutes, canonicalSchedule.scheduleEndFold, canonicalSchedule.scheduleZone, canonicalSchedule.scheduleVersion, JSON.stringify(offsets), principal.id, now, now, projectId);
    const results = await env.DB.batch([
      insert,
      env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, ?, 'project_subtask.create', 'project_subtask', ?, ?, ? WHERE changes() = 1").bind(auditId, principal.id, id, auditMeta(principal, { scheduleState: canonicalSchedule.state, scheduleVersion: canonicalSchedule.scheduleVersion, reminderOffsetsMinutes: offsets }), now),
      ...bundle.statements,
      // Last, so the positional reads above stay valid (#364).
      ...(assigneeIds.length ? [relationInsertMany(env.DB, id, JSON.stringify(assigneeIds), 1, now, auditId)] : []),
      // The default reminders (#424). Reads the Subtask the first statement inserted, and writes nothing if that insert lost.
      ...buildSubtaskReminderMaterialization({ db: env.DB, scope: { kind: "subtask", subtaskId: id }, now, createdBy: principal.id, gateAuditId: auditId }).statements,
      // Last, so the positional reads above stay valid. Classifies a lost insert (#446).
      env.DB.prepare(ARCHIVED_SNAPSHOT_SQL).bind(projectId),
    ]);
    if (!rowsFromD1<{ id: string }>(results[0])[0]) {
      if (archivedInSnapshot(results[results.length - 1])) return archivedOutcome(principal);
      throw new Error("Subtask could not be created");
    }
    const item = await subtaskQuery(db, projectId, id).get();
    if (!item) throw new Error("Subtask could not be created");
    return {
      outcome: "created",
      item: serializeProjectSubtask(item, await hydrateSubtaskAssignees(env.DB, id), await readSubtaskRemindersOf(env.DB, id, now)),
      broadPublicationIds: publicationIds(results, 2, bundle),
      assignmentNotices: assigneeIds.filter((assigneeId) => assigneeId !== principal.id).map((assigneeId) => ({ projectId, actorId: principal.id, assigneeId, subtaskId: id, assignmentVersion: 1 })),
    };
  }

  const existing = await subtaskQuery(db, projectId, operation.subtaskId).get();
  if (!existing) return { outcome: "not_found", target: "subtask" };
  const currentAssignees = await hydrateSubtaskAssignees(env.DB, operation.subtaskId);
  const existingStorage = scheduleStorage(existing.subtask);
  const currentDto = serializeSubtaskSchedule(existing.subtask.id, existingStorage);
  const scheduleBearing = operation.scheduleRequest !== undefined;

  let requested: RangeChecklistScheduleInput | null = null;
  let expectedVersion: number | null = null;
  let requestedOffsets: number[] | null = null;
  if (operation.scheduleRequest) {
    if (!Number.isSafeInteger(operation.scheduleRequest.expectedVersion) || operation.scheduleRequest.expectedVersion < 0) return invalidRequest("subtask_schedule_invalid_version", "Schedule version must be a nonnegative integer.");
    // Ranges only (ADR 0011). The route's schema enforces this too; this guard covers direct callers.
    if (operation.scheduleRequest.schedule.state !== "range") return invalidRequest("subtask_schedule_range_required", "A Subtask needs a start and an end.");
    requested = operation.scheduleRequest.schedule;
    expectedVersion = operation.scheduleRequest.expectedVersion;
    // Absent keeps the stored set: a drag or an undo sends only the range and must not reset a custom one.
    if (operation.scheduleRequest.reminderOffsetsMinutes !== undefined) {
      const parsedOffsets = parseReminderOffsets(operation.scheduleRequest.reminderOffsetsMinutes, "schedule.reminderOffsetsMinutes");
      if (!Array.isArray(parsedOffsets)) return parsedOffsets;
      requestedOffsets = parsedOffsets;
    }
  }
  const storedOffsets = storedReminderOffsets(existing.subtask.reminderOffsetsJson);
  const remindersChanged = requestedOffsets !== null && JSON.stringify(requestedOffsets) !== JSON.stringify(storedOffsets);

  // The version check comes first for the reminders too: a stale save loses even when its offsets match what is stored now.
  if (requested && expectedVersion !== existingStorage.scheduleVersion) return { outcome: "schedule_conflict", current: currentDto, currentSubtask: serializeProjectSubtask(existing, currentAssignees, await readSubtaskRemindersOf(env.DB, operation.subtaskId, now)) };
  let normalized: NormalizedChecklistSchedule | null = null;
  let scheduleChanged = false;
  let startChanged = false;
  let endChanged = false;
  if (requested) {
    // The version is not part of semantic equality; it only keeps the candidate serializable.
    const candidateVersion = Math.max(1, existingStorage.scheduleVersion);
    const candidateResult = normalizeChecklistSchedule(requested, candidateVersion);
    if (!candidateResult.ok) return scheduleInvalidRequest(candidateResult.error, "schedule.schedule");
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

  const delta: SubtaskAssigneeDelta | null = patch.assignees ?? null;
  if (delta) {
    if (delta.expectedVersion !== existing.subtask.assignmentVersion) return { outcome: "assignment_conflict", currentSubtask: serializeProjectSubtask(existing, currentAssignees, await readSubtaskRemindersOf(env.DB, operation.subtaskId, now)) };
    const currentIds = new Set(currentAssignees.map((assignee) => assignee.id));
    const hidden = principal.role === "external_editor" ? new Set(currentAssignees.filter((assignee) => !assignee.onTeam).map((assignee) => assignee.id)) : new Set<string>();
    // An external can never touch a person hidden from them, so a hidden id reads as "not an assignee".
    if (delta.add.some((id) => currentIds.has(id)) || delta.remove.some((id) => !currentIds.has(id) || hidden.has(id))) return invalidRequest("subtask_assignee_invalid_delta", "That change does not match the current assignees.");
    // Kept people are not re-checked: a since-deactivated assignee must not block unrelated edits.
    if (delta.add.length) {
      const eligible = await eligibleToAdd(env, principal, projectId, delta.add);
      if (!delta.add.every((id) => eligible.has(id))) return invalidRequest("subtask_assignee_ineligible", "Assignee is not an active project participant.");
    }
  }
  const assignmentChanged = delta !== null;
  const mappedChanges = [
    ...(titleChanged ? ["title" as const] : []),
    ...(doneChanged ? ["completion" as const] : []),
    ...(assignmentChanged ? ["assignee" as const] : []),
  ];
  if (!scheduleChanged && !remindersChanged && mappedChanges.length === 0) return { outcome: "noop", item: serializeProjectSubtask(existing, currentAssignees, await readSubtaskRemindersOf(env.DB, operation.subtaskId, now)), broadPublicationIds: [], assignmentNotices: [] };

  const setParts: string[] = [];
  const bindings: unknown[] = [];
  if (titleChanged) { setParts.push("title = ?"); bindings.push(patch.title); }
  if (doneChanged) { setParts.push("done = ?"); bindings.push(patch.done ? 1 : 0); }
  if (assignmentChanged) setParts.push("assignment_version = assignment_version + 1");
  if (normalized && scheduleChanged) {
    setParts.push("due_date = ?", "schedule_start_kind = ?", "schedule_start_civil = ?", "schedule_start_at = ?", "schedule_start_utc_offset_minutes = ?", "schedule_start_fold = ?", "schedule_end_kind = ?", "schedule_end_at = ?", "schedule_end_utc_offset_minutes = ?", "schedule_end_fold = ?", "schedule_zone = ?", "schedule_version = ?");
    bindings.push(normalized.dueDate, normalized.scheduleStartKind, normalized.scheduleStartCivil, normalized.scheduleStartAt, normalized.scheduleStartUtcOffsetMinutes, normalized.scheduleStartFold, normalized.scheduleEndKind, normalized.scheduleEndAt, normalized.scheduleEndUtcOffsetMinutes, normalized.scheduleEndFold, normalized.scheduleZone, normalized.scheduleVersion);
    if (endChanged) setParts.push("due_reminder_sent_at = NULL");
  }
  if (remindersChanged && requestedOffsets) {
    setParts.push("reminder_offsets_json = ?"); bindings.push(JSON.stringify(requestedOffsets));
    // The reminder set is part of the schedule version (#425): occurrences are keyed by it, and a concurrent editor's save conflicts on it.
    // A range change in the same request already carries the one bump.
    if (!scheduleChanged) { setParts.push("schedule_version = ?"); bindings.push(existingStorage.scheduleVersion + 1); }
  }
  setParts.push("updated_at = ?"); bindings.push(now);
  const auditId = newId();
  const nextTitle = titleChanged ? patch.title! : existing.subtask.title;
  const auditFields = [...mappedChanges, ...(scheduleChanged ? ["schedule"] : []), ...(remindersChanged ? ["reminders"] : [])];
  const nextScheduleState = normalized?.state ?? currentDto.state;
  const nextScheduleVersion = normalized?.scheduleVersion ?? (remindersChanged ? existingStorage.scheduleVersion + 1 : existingStorage.scheduleVersion);
  const auditDetails = { fields: auditFields, scheduleState: nextScheduleState, scheduleVersion: nextScheduleVersion, ...(delta ? { assigneesAdded: delta.add, assigneesRemoved: delta.remove } : {}), ...(remindersChanged ? { reminders: { before: storedOffsets, after: requestedOffsets } } : {}) };
  const statements: D1PreparedStatement[] = [env.DB.prepare(`UPDATE project_subtasks SET ${setParts.join(", ")} WHERE id = ? AND project_id = ? AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_subtasks.project_id AND p.archived_at IS NULL) AND title IS ? AND done IS ? AND due_date IS ? AND assignment_version IS ? AND schedule_start_kind IS ? AND schedule_start_civil IS ? AND schedule_start_at IS ? AND schedule_start_utc_offset_minutes IS ? AND schedule_start_fold IS ? AND schedule_end_kind IS ? AND schedule_end_at IS ? AND schedule_end_utc_offset_minutes IS ? AND schedule_end_fold IS ? AND schedule_zone IS ? AND schedule_version IS ? RETURNING id, assignment_version AS assignmentVersion`).bind(...bindings, operation.subtaskId, projectId, existing.subtask.title, existing.subtask.done ? 1 : 0, existing.subtask.dueDate, existing.subtask.assignmentVersion, existing.subtask.scheduleStartKind, existing.subtask.scheduleStartCivil, existing.subtask.scheduleStartAt, existing.subtask.scheduleStartUtcOffsetMinutes, existing.subtask.scheduleStartFold, existing.subtask.scheduleEndKind, existing.subtask.scheduleEndAt, existing.subtask.scheduleEndUtcOffsetMinutes, existing.subtask.scheduleEndFold, existing.subtask.scheduleZone, existing.subtask.scheduleVersion)];
  statements.push(env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, ?, 'project_subtask.update', 'project_subtask', ?, ?, ? WHERE changes() = 1").bind(auditId, principal.id, operation.subtaskId, auditMeta(principal, auditDetails), now));
  const bundles: Array<{ bundle: ReturnType<typeof buildProjectActivityStatements>; offset: number }> = [];
  if (mappedChanges.length) {
    const bundle = buildProjectActivityStatements({ db: env.DB, intent: activityFor(operation.subtaskId, projectId, principal.id, now, nextTitle, "updated", mappedChanges, delta ?? undefined), winnerAuditId: auditId, createdAt: now });
    bundles.push({ bundle, offset: statements.length }); statements.push(...bundle.statements);
  }
  if (scheduleChanged && normalized) {
    const bundle = buildProjectActivityStatements({ db: env.DB, intent: scheduleActivityFor(operation.subtaskId, projectId, principal.id, now, nextTitle, normalized.state, normalized.scheduleVersion), winnerAuditId: auditId, createdAt: now, broadMode: scheduleActivityBroadMode(endChanged) });
    bundles.push({ bundle, offset: statements.length }); statements.push(...bundle.statements);
  }
  if (delta) {
    // Appended last so every positional read stays valid (#364). The new people take the Subtask's new version; survivors keep theirs.
    if (delta.remove.length) statements.push(relationDeleteMany(env.DB, operation.subtaskId, JSON.stringify(delta.remove), auditId));
    if (delta.add.length) statements.push(relationInsertMany(env.DB, operation.subtaskId, JSON.stringify(delta.add), existing.subtask.assignmentVersion + 1, now, auditId));
  }
  // Reminder occurrences follow the Subtask (#424), appended last for the same reason. Completion comes first, so a combined
  // completion and reschedule leaves nothing pending. Assignee-only changes touch no occurrence: recipients are resolved when one fires.
  const nextDone = doneChanged ? patch.done === true : existing.subtask.done;
  const gate = { db: env.DB, now, gateAuditId: auditId } as const;
  const subtaskScope = { kind: "subtask", projectId, subtaskId: operation.subtaskId } as const;
  if (doneChanged && nextDone) statements.push(...buildSubtaskReminderSuppression({ ...gate, scope: subtaskScope, reason: "subtask_completed" }).statements);
  if (scheduleChanged || remindersChanged) statements.push(...buildSubtaskReminderSuppression({ ...gate, scope: subtaskScope, reason: scheduleChanged ? "schedule_replaced" : "reminders_changed" }).statements);
  // Un-completing recomputes the future ones, and a new schedule version needs its own set. Fired rows of the same version block repeats.
  if ((doneChanged && !nextDone) || scheduleChanged || remindersChanged) statements.push(...buildSubtaskReminderMaterialization({ ...gate, scope: { kind: "subtask", subtaskId: operation.subtaskId }, createdBy: principal.id }).statements);
  // Last, so every positional read stays valid. Read before the conflict branches: a write that lost to an archive is not a conflict (#446).
  statements.push(env.DB.prepare(ARCHIVED_SNAPSHOT_SQL).bind(projectId));
  const results = await env.DB.batch(statements);
  const winner = rowsFromD1<{ id: string; assignmentVersion: number }>(results[0])[0];
  if (!winner) {
    if (archivedInSnapshot(results[results.length - 1])) return archivedOutcome(principal);
    const current = await subtaskQuery(db, projectId, operation.subtaskId).get();
    if (!current) return { outcome: "not_found", target: "subtask" };
    const authoritativeAssignees = await hydrateSubtaskAssignees(env.DB, operation.subtaskId);
    // A delta whose version moved lost to another assignee change.
    const authoritativeReminders = await readSubtaskRemindersOf(env.DB, operation.subtaskId, now);
    if (delta && current.subtask.assignmentVersion !== existing.subtask.assignmentVersion) return { outcome: "assignment_conflict", currentSubtask: serializeProjectSubtask(current, authoritativeAssignees, authoritativeReminders) };
    const authoritativeStorage = scheduleStorage(current.subtask);
    const authoritativeSchedule = serializeSubtaskSchedule(current.subtask.id, authoritativeStorage);
    if (scheduleBearing && (!rawScheduleEqual(authoritativeStorage, existingStorage) || authoritativeStorage.scheduleVersion !== existingStorage.scheduleVersion)) return { outcome: "schedule_conflict", current: authoritativeSchedule, currentSubtask: serializeProjectSubtask(current, authoritativeAssignees, authoritativeReminders) };
    // A delta that lost to any other concurrent edit must not report success it did not have.
    if (scheduleBearing || delta) return { outcome: "item_conflict", current: authoritativeSchedule, currentSubtask: serializeProjectSubtask(current, authoritativeAssignees, authoritativeReminders) };
    return { outcome: "noop", item: serializeProjectSubtask(current, authoritativeAssignees, authoritativeReminders), broadPublicationIds: [], assignmentNotices: [] };
  }
  const item = await subtaskQuery(db, projectId, operation.subtaskId).get();
  if (!item) throw new Error("Subtask could not be reread after update");
  return {
    outcome: "updated",
    item: serializeProjectSubtask(item, await hydrateSubtaskAssignees(env.DB, operation.subtaskId), await readSubtaskRemindersOf(env.DB, operation.subtaskId, now)),
    broadPublicationIds: bundles.flatMap(({ bundle, offset }) => publicationIds(results, offset, bundle)),
    // Only the newly added people, and never the actor. Removal notifies nobody.
    assignmentNotices: (delta?.add ?? []).filter((assigneeId) => assigneeId !== principal.id).map((assigneeId) => ({ projectId, actorId: principal.id, assigneeId, subtaskId: operation.subtaskId, assignmentVersion: winner.assignmentVersion })),
  };
}

/** Who this principal may add: staff, any active admin or Project member; an External Editor, active Project members only. */
async function eligibleToAdd(env: AppEnv["Bindings"], principal: SessionUser, projectId: string, ids: string[]): Promise<Set<string>> {
  if (principal.role === "external_editor") return externalAddEligible(env.DB, projectId, ids);
  return new Set((await projectMentionableUsers(env, projectId)).map((user) => user.id));
}

export async function finalizeProjectSubtaskCommandResult(input: { env: AppEnv["Bindings"]; executionCtx: { waitUntil(promise: Promise<unknown>): void }; result: ProjectSubtaskCommandResult }): Promise<void> {
  const result = input.result;
  if (result.outcome !== "created" && result.outcome !== "updated") return;
  if (result.broadPublicationIds.length) input.executionCtx.waitUntil(publishOutboxDetached(input.env.NOTIFICATION_QUEUE, input.env.DB, result.broadPublicationIds));
  for (const notice of result.assignmentNotices) await notifySubtaskAssignee(input.env, notice);
}

export { CHECKLIST_SCHEDULE_ZONE };
