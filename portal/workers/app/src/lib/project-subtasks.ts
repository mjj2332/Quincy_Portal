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
  mirrorRecompute,
  multiAssigneeEnabled,
  relationDeleteMany,
  relationInsertMany,
  type HydratedAssignee,
} from "./subtask-assignees";
import { projectMentionableUsers } from "./project-collaboration";
import { hasProjectCollaborationAccessForUser } from "../middleware/capability";
import { publishOutboxDetached } from "../lib/server-timing";

export const POSITION_STEP = 1024;

export type CreateItemInput = { title: string; assigneeIds: string[] };
/** `assigneeId` is the pre-#368 single-assignee field (open old tabs until #373); `assignees` is the delta. */
export type ItemPatch = { title?: string; done?: boolean; assigneeId?: string | null; assignees?: SubtaskAssigneeDelta };

export type ProjectSubtaskDto = {
  id: string;
  title: string;
  done: boolean;
  position: number;
  /** `assignees[0]`, kept for old tabs. Removed in #373. */
  assignee: { id: string; name: string } | null;
  assignees: CalendarPerson[];
  assignmentVersion: number;
  dueDate: string | null;
  schedule: ChecklistScheduleDto;
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
  | { outcome: "invalid_request"; status: 400; code: string; message: string; details?: { endpoint?: "start" | "end"; choices?: Array<{ disambiguation: "earlier" | "later"; utcOffsetMinutes: number }> } }
  | { outcome: "forbidden" }
  | { outcome: "not_found"; target: "project" | "subtask" }
  | { outcome: "schedule_conflict"; current: ChecklistScheduleDto; currentSubtask?: ProjectSubtaskDto }
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

export function serializeProjectSubtask(row: SubtaskRow, assignees: HydratedAssignee[]): ProjectSubtaskDto {
  const schedule = serializeSubtaskSchedule(row.subtask.id, scheduleStorage(row.subtask));
  return {
    id: row.subtask.id,
    title: row.subtask.title,
    done: row.subtask.done,
    position: row.subtask.position,
    assignee: assignees[0] ? { id: assignees[0].id, name: assignees[0].name } : null,
    assignees: assignees.map(assigneePerson),
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
    const assigneeIds = [...new Set(operation.item.assigneeIds ?? [])];
    if (assigneeIds.length) {
      const eligible = await eligibleToAdd(env, principal, projectId, assigneeIds);
      if (!assigneeIds.every((id) => eligible.has(id))) return invalidRequest("subtask_assignee_ineligible", "Assignee is not an active project participant.");
      if (assigneeIds.length > 1 && !await multiAssigneeEnabled(env.DB)) return invalidRequest("subtask_multi_assignee_disabled", "Assigning more than one person is not available yet.");
    }
    const normalized = normalizeChecklistSchedule(requested, 1);
    if (!normalized.ok) return invalidRequest(normalized.error.code, normalized.error.message, normalized.error.endpoint ? { endpoint: normalized.error.endpoint, ...(normalized.error.choices ? { choices: normalized.error.choices } : {}) } : undefined);
    const last = await env.DB.prepare("SELECT position FROM project_subtasks WHERE project_id = ? ORDER BY position DESC, id DESC LIMIT 1").bind(projectId).first<{ position: number }>();
    const id = newId();
    const auditId = newId();
    const activity = activityFor(id, projectId, principal.id, now, operation.item.title, "created");
    const bundle = buildProjectActivityStatements({ db: env.DB, intent: activity, winnerAuditId: auditId, createdAt: now });
    const canonicalSchedule = normalized.value;
    const insert = env.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignee_id, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, projectId, operation.item.title, (last?.position ?? 0) + POSITION_STEP, assigneeIds[0] ?? null, assigneeIds.length ? 1 : 0, canonicalSchedule.dueDate, canonicalSchedule.scheduleStartKind, canonicalSchedule.scheduleStartCivil, canonicalSchedule.scheduleStartAt, canonicalSchedule.scheduleStartUtcOffsetMinutes, canonicalSchedule.scheduleStartFold, canonicalSchedule.scheduleEndKind, canonicalSchedule.scheduleEndAt, canonicalSchedule.scheduleEndUtcOffsetMinutes, canonicalSchedule.scheduleEndFold, canonicalSchedule.scheduleZone, canonicalSchedule.scheduleVersion, principal.id, now, now);
    const results = await env.DB.batch([
      insert,
      env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, ?, 'project_subtask.create', 'project_subtask', ?, ?, ? WHERE changes() = 1").bind(auditId, principal.id, id, auditMeta(principal, { scheduleState: canonicalSchedule.state, scheduleVersion: canonicalSchedule.scheduleVersion }), now),
      ...bundle.statements,
      // Last, so the positional reads above stay valid (#364). The relation is authoritative; the recompute sets the column to its first row.
      ...(assigneeIds.length ? [relationInsertMany(env.DB, id, JSON.stringify(assigneeIds), 1, now, auditId), mirrorRecompute(env.DB, id, auditId)] : []),
    ]);
    const item = await subtaskQuery(db, projectId, id).get();
    if (!item) throw new Error("Subtask could not be created");
    return {
      outcome: "created",
      item: serializeProjectSubtask(item, await hydrateSubtaskAssignees(env.DB, id)),
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
  if (operation.scheduleRequest) {
    if (!Number.isSafeInteger(operation.scheduleRequest.expectedVersion) || operation.scheduleRequest.expectedVersion < 0) return invalidRequest("subtask_schedule_invalid_version", "Schedule version must be a nonnegative integer.");
    // Ranges only (ADR 0011). The route's schema enforces this too; this guard covers direct callers.
    if (operation.scheduleRequest.schedule.state !== "range") return invalidRequest("subtask_schedule_range_required", "A Subtask needs a start and an end.");
    requested = operation.scheduleRequest.schedule;
    expectedVersion = operation.scheduleRequest.expectedVersion;
  }

  if (requested && expectedVersion !== existingStorage.scheduleVersion) return { outcome: "schedule_conflict", current: currentDto, ...(operation.itemPatch ? { currentSubtask: serializeProjectSubtask(existing, currentAssignees) } : {}) };
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

  // The assignee delta: native (`assignees`) or translated from the legacy single field (`assigneeId`, open old tabs until #373).
  let delta: SubtaskAssigneeDelta | null = patch.assignees ?? null;
  let translated = false;
  if (!delta && Object.prototype.hasOwnProperty.call(patch, "assigneeId")) {
    // A stale tab knows one assignee; with two or more it cannot say what to keep, so it is a conflict and nothing is written.
    if (currentAssignees.length >= 2) return { outcome: "item_conflict", current: currentDto, currentSubtask: serializeProjectSubtask(existing, currentAssignees) };
    const current = currentAssignees[0]?.id ?? null;
    const next = patch.assigneeId ?? null;
    const add = next && next !== current ? [next] : [];
    const remove = current && current !== next ? [current] : [];
    // An empty delta is "no assignee change": the noop a repeated PATCH always was.
    if (add.length + remove.length > 0) { delta = { expectedVersion: existing.subtask.assignmentVersion, add, remove }; translated = true; }
  }
  if (delta) {
    if (delta.expectedVersion !== existing.subtask.assignmentVersion) return { outcome: "assignment_conflict", currentSubtask: serializeProjectSubtask(existing, currentAssignees) };
    const currentIds = new Set(currentAssignees.map((assignee) => assignee.id));
    const hidden = principal.role === "external_editor" ? new Set(currentAssignees.filter((assignee) => !assignee.onTeam).map((assignee) => assignee.id)) : new Set<string>();
    // An external can never touch a person hidden from them, so a hidden id reads as "not an assignee".
    if (delta.add.some((id) => currentIds.has(id)) || delta.remove.some((id) => !currentIds.has(id) || hidden.has(id))) return invalidRequest("subtask_assignee_invalid_delta", "That change does not match the current assignees.");
    // Kept people are not re-checked: a since-deactivated assignee must not block unrelated edits.
    if (delta.add.length) {
      const eligible = await eligibleToAdd(env, principal, projectId, delta.add);
      if (!delta.add.every((id) => eligible.has(id))) return invalidRequest("subtask_assignee_ineligible", "Assignee is not an active project participant.");
      if (currentIds.size + delta.add.length - delta.remove.length > 1 && !await multiAssigneeEnabled(env.DB)) return invalidRequest("subtask_multi_assignee_disabled", "Assigning more than one person is not available yet.");
    }
  }
  const assignmentChanged = delta !== null;
  const mappedChanges = [
    ...(titleChanged ? ["title" as const] : []),
    ...(doneChanged ? ["completion" as const] : []),
    ...(assignmentChanged ? ["assignee" as const] : []),
  ];
  if (!scheduleChanged && mappedChanges.length === 0) return { outcome: "noop", item: serializeProjectSubtask(existing, currentAssignees), broadPublicationIds: [], assignmentNotices: [] };

  const setParts: string[] = [];
  const bindings: unknown[] = [];
  if (titleChanged) { setParts.push("title = ?"); bindings.push(patch.title); }
  if (doneChanged) { setParts.push("done = ?"); bindings.push(patch.done ? 1 : 0); }
  // No `assignee_id = ?`: the column is a mirror, recomputed from the relation in the same batch.
  if (assignmentChanged) setParts.push("assignment_version = assignment_version + 1");
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
  const auditDetails = { fields: auditFields, scheduleState: nextScheduleState, scheduleVersion: nextScheduleVersion, ...(delta ? { assigneesAdded: delta.add, assigneesRemoved: delta.remove } : {}) };
  const statements: D1PreparedStatement[] = [env.DB.prepare(`UPDATE project_subtasks SET ${setParts.join(", ")} WHERE id = ? AND project_id = ? AND title IS ? AND done IS ? AND due_date IS ? AND assignment_version IS ? AND schedule_start_kind IS ? AND schedule_start_civil IS ? AND schedule_start_at IS ? AND schedule_start_utc_offset_minutes IS ? AND schedule_start_fold IS ? AND schedule_end_kind IS ? AND schedule_end_at IS ? AND schedule_end_utc_offset_minutes IS ? AND schedule_end_fold IS ? AND schedule_zone IS ? AND schedule_version IS ? RETURNING id, assignment_version AS assignmentVersion`).bind(...bindings, operation.subtaskId, projectId, existing.subtask.title, existing.subtask.done ? 1 : 0, existing.subtask.dueDate, existing.subtask.assignmentVersion, existing.subtask.scheduleStartKind, existing.subtask.scheduleStartCivil, existing.subtask.scheduleStartAt, existing.subtask.scheduleStartUtcOffsetMinutes, existing.subtask.scheduleStartFold, existing.subtask.scheduleEndKind, existing.subtask.scheduleEndAt, existing.subtask.scheduleEndUtcOffsetMinutes, existing.subtask.scheduleEndFold, existing.subtask.scheduleZone, existing.subtask.scheduleVersion)];
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
    statements.push(mirrorRecompute(env.DB, operation.subtaskId, auditId));
  }
  const results = await env.DB.batch(statements);
  const winner = rowsFromD1<{ id: string; assignmentVersion: number }>(results[0])[0];
  if (!winner) {
    const current = await subtaskQuery(db, projectId, operation.subtaskId).get();
    if (!current) return { outcome: "not_found", target: "subtask" };
    const authoritativeAssignees = await hydrateSubtaskAssignees(env.DB, operation.subtaskId);
    // A native delta whose version moved lost to another assignee change. A translated legacy write keeps today's behaviour below.
    if (delta && !translated && current.subtask.assignmentVersion !== existing.subtask.assignmentVersion) return { outcome: "assignment_conflict", currentSubtask: serializeProjectSubtask(current, authoritativeAssignees) };
    const authoritativeStorage = scheduleStorage(current.subtask);
    const authoritativeSchedule = serializeSubtaskSchedule(current.subtask.id, authoritativeStorage);
    if (scheduleBearing && (!rawScheduleEqual(authoritativeStorage, existingStorage) || authoritativeStorage.scheduleVersion !== existingStorage.scheduleVersion)) return { outcome: "schedule_conflict", current: authoritativeSchedule, ...(operation.itemPatch ? { currentSubtask: serializeProjectSubtask(current, authoritativeAssignees) } : {}) };
    // A native delta that lost to any other concurrent edit must not report success it did not have.
    if (scheduleBearing) return { outcome: "item_conflict", current: authoritativeSchedule, currentSubtask: serializeProjectSubtask(current, authoritativeAssignees) };
    return { outcome: "noop", item: serializeProjectSubtask(current, authoritativeAssignees), broadPublicationIds: [], assignmentNotices: [] };
  }
  const item = await subtaskQuery(db, projectId, operation.subtaskId).get();
  if (!item) throw new Error("Subtask could not be reread after update");
  return {
    outcome: "updated",
    item: serializeProjectSubtask(item, await hydrateSubtaskAssignees(env.DB, operation.subtaskId)),
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
