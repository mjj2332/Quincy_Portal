import { Hono } from "hono";
import { terminalRoute } from "../lib/terminal-route";
import type { Context } from "hono";
import { buildProjectActivityStatements, computeInsertPosition, createDb, schema } from "@quincy/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import type { AppEnv } from "../env";
import { audit, auditMeta } from "../lib/audit";
import { newId } from "../lib/ids";
import { serializeSubtaskSchedule } from "../lib/subtask-schedule";
import {
  externalChecklistItemSchema, externalChecklistListResponseSchema, externalPersonSchema, externalSubtaskAssigneeOptionsResponseSchema, ROLE_LABELS, projectActivityDeepLink,
  SUBTASK_ASSIGNEE_DELTA_MAX, subtaskAssigneeDeltaSchema, subtaskAssigneeOptionsResponseSchema, type ChecklistScheduleStorage, type ProjectActivityIntent,
} from "@quincy/shared";
import { hasProjectCollaborationAccess } from "../middleware/capability";
import { projectMentionableUsers } from "../lib/project-collaboration";
import { externalAssigneeProjection, hydrateProjectAssignees, hydrateSubtaskAssignees, type HydratedAssignee } from "../lib/subtask-assignees";
import { resolveVisibleProject, visibleProjectWhere } from "../lib/visible-project-scope";
import { jsonInput } from "./helpers";
import { publishOutboxDetached } from "../lib/server-timing";
import {
  finalizeProjectSubtaskCommandResult,
  projectDefaultRangeDtoFor,
  saveProjectSubtask,
  serializeProjectSubtask,
  type ItemPatch,
} from "../lib/project-subtasks";

const idParam = z.string().uuid();
const TITLE_MAX_LENGTH = 500;
const POSITION_STEP = 1024;

const titleInput = z.string().trim().min(1).max(TITLE_MAX_LENGTH);
// Every end is a moment (ADR 0016). A stale tab may still send the retired `kind`: it is dropped (zod strips unknown keys),
// so an old date-only end meets the field-named `subtask_schedule_time_required` and an old timed save succeeds.
const endpointInput = z.object({ localCivil: z.string(), disambiguation: z.enum(["earlier", "later"]).optional() });
// A Subtask is always a range (ADR 0011): unscheduled and due-only payloads are rejected here, before any read.
const scheduleInput = z.object({ state: z.literal("range"), start: endpointInput, end: endpointInput }).strict();

/** `jsonInput` plus the nested path of every issue: `flatten()` folds `schedule.end.localCivil` into the top-level `schedule`. */
async function subtaskJsonInput<T extends z.ZodTypeAny>(c: Context<AppEnv>, validator: T): Promise<z.infer<T> | Response> {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  const result = validator.safeParse(body);
  if (result.success) return result.data;
  return c.json({ error: "Invalid input", details: { ...result.error.flatten(), issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code, message: issue.message })) } }, 400);
}
const scheduleRequestInput = z.object({ expectedVersion: z.number().int().nonnegative().refine(Number.isSafeInteger), schedule: scheduleInput }).strict();
const uniqueIds = (ids: string[]) => new Set(ids).size === ids.length;
const createInput = z.object({
  title: titleInput, assigneeIds: z.array(idParam).max(SUBTASK_ASSIGNEE_DELTA_MAX).refine(uniqueIds, "Assignee ids must be unique").optional(), schedule: scheduleInput.optional(),
}).strict();
const updateInput = z.object({
  title: titleInput.optional(), done: z.boolean().optional(), assignees: subtaskAssigneeDeltaSchema.optional(), schedule: scheduleRequestInput.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field is required");
const reorderInput = z.object({ beforeId: idParam.nullable(), afterId: idParam.nullable() }).strict().refine((value) => value.beforeId !== value.afterId || value.beforeId === null, "Neighbors must be distinct");

function rowsFromD1<T>(result: unknown): T[] {
  return ((result as { results?: T[] } | undefined)?.results ?? []);
}

const serializeSubtask = serializeProjectSubtask;

async function ensureProjectAccessAndExists(c: Parameters<typeof hasProjectCollaborationAccess>[0], projectId: string) {
  if (!await hasProjectCollaborationAccess(c, projectId)) return "forbidden" as const;
  return createDb(c.env.DB).select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
}

function subtaskQuery(db: ReturnType<typeof createDb>, projectId: string, subtaskId?: string) {
  return db.select({ subtask: schema.projectSubtasks })
    .from(schema.projectSubtasks)
    .where(and(eq(schema.projectSubtasks.projectId, projectId), subtaskId ? eq(schema.projectSubtasks.id, subtaskId) : undefined));
}

function externalSubtaskQuery(db: ReturnType<typeof createDb>, projectId: string, userId: string, subtaskId?: string) {
  const creator = alias(schema.user, "external_creator");
  return db.select({
    id: schema.projectSubtasks.id, title: schema.projectSubtasks.title, done: schema.projectSubtasks.done, position: schema.projectSubtasks.position,
    assignmentVersion: schema.projectSubtasks.assignmentVersion, dueDate: schema.projectSubtasks.dueDate,
    scheduleStartKind: schema.projectSubtasks.scheduleStartKind, scheduleStartCivil: schema.projectSubtasks.scheduleStartCivil, scheduleStartAt: schema.projectSubtasks.scheduleStartAt,
    scheduleStartUtcOffsetMinutes: schema.projectSubtasks.scheduleStartUtcOffsetMinutes, scheduleStartFold: schema.projectSubtasks.scheduleStartFold,
    scheduleEndKind: schema.projectSubtasks.scheduleEndKind, scheduleEndAt: schema.projectSubtasks.scheduleEndAt, scheduleEndUtcOffsetMinutes: schema.projectSubtasks.scheduleEndUtcOffsetMinutes,
    scheduleEndFold: schema.projectSubtasks.scheduleEndFold, scheduleZone: schema.projectSubtasks.scheduleZone, scheduleVersion: schema.projectSubtasks.scheduleVersion,
    createdAt: schema.projectSubtasks.createdAt, updatedAt: schema.projectSubtasks.updatedAt,
    creatorId: creator.id, creatorName: creator.name, creatorRole: creator.role, creatorActive: creator.active,
  }).from(schema.projectSubtasks)
    .innerJoin(schema.projects, eq(schema.projectSubtasks.projectId, schema.projects.id))
    .leftJoin(schema.projectMembers, and(eq(schema.projectMembers.projectId, schema.projects.id), eq(schema.projectMembers.userId, userId)))
    .innerJoin(creator, eq(schema.projectSubtasks.createdBy, creator.id))
    .where(and(eq(schema.projectSubtasks.projectId, projectId), subtaskId ? eq(schema.projectSubtasks.id, subtaskId) : undefined, visibleProjectWhere({ id: userId, role: "external_editor", active: true })));
}

/** The external Checklist DTO: `assignees` are the team members only, `otherAssigneeCount` the rest. */
function externalSubtaskDto(row: Awaited<ReturnType<typeof externalSubtaskQuery>>[number], assignees: HydratedAssignee[]) {
  const { assignees: named, otherAssigneeCount } = externalAssigneeProjection(assignees);
  const storage: ChecklistScheduleStorage = {
    dueDate: row.dueDate, scheduleStartKind: row.scheduleStartKind, scheduleStartCivil: row.scheduleStartCivil, scheduleStartAt: row.scheduleStartAt,
    scheduleStartUtcOffsetMinutes: row.scheduleStartUtcOffsetMinutes, scheduleStartFold: row.scheduleStartFold, scheduleEndKind: row.scheduleEndKind,
    scheduleEndAt: row.scheduleEndAt, scheduleEndUtcOffsetMinutes: row.scheduleEndUtcOffsetMinutes, scheduleEndFold: row.scheduleEndFold,
    scheduleZone: row.scheduleZone, scheduleVersion: row.scheduleVersion,
  };
  return externalChecklistItemSchema.parse({
    id: row.id, title: row.title, done: Boolean(row.done), position: row.position,
    assignees: named, otherAssigneeCount,
    assignmentVersion: row.assignmentVersion, dueDate: row.dueDate, schedule: serializeSubtaskSchedule(row.id, storage),
    createdBy: row.creatorId && row.creatorName && row.creatorRole ? { id: row.creatorId, name: row.creatorName, roleLabel: ROLE_LABELS[row.creatorRole], isExternal: row.creatorRole === "external_editor", active: Boolean(row.creatorActive) } : { id: "00000000-0000-4000-8000-000000000000", name: "", roleLabel: "", isExternal: false, active: false },
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  });
}

function hasField(value: object, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }

/** A conflict body's `currentSubtask` for the caller: an External Editor gets the external DTO, never the staff one (which now lists every assignee). */
async function conflictSubtask(c: Context<AppEnv>, projectId: string, current: { id: string }) {
  if (c.get("user").role !== "external_editor") return current;
  const row = await externalSubtaskQuery(createDb(c.env.DB), projectId, c.get("user").id, current.id).get();
  return row ? externalSubtaskDto(row, await hydrateSubtaskAssignees(c.env.DB, current.id)) : null;
}

async function commandResponse(c: Context<AppEnv>, projectId: string, result: Awaited<ReturnType<typeof saveProjectSubtask>>, status: 200 | 201 = 200) {
  switch (result.outcome) {
    case "created":
    case "updated":
    case "noop": {
      if (c.get("user").role === "external_editor") {
        const row = await externalSubtaskQuery(createDb(c.env.DB), projectId, c.get("user").id, result.item.id).get();
        return row ? c.json(externalSubtaskDto(row, await hydrateSubtaskAssignees(c.env.DB, result.item.id)), status) : c.json({ error: "Subtask not found" }, 404);
      }
      return c.json(result.item, status);
    }
    case "invalid_request": return c.json({ error: result.message, code: result.code, ...(result.details ? { details: result.details } : {}) }, result.status);
    case "forbidden": return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
    case "not_found": return c.json({ error: result.target === "project" ? "Project not found" : "Subtask not found" }, 404);
    case "schedule_conflict": {
      const currentSubtask = result.currentSubtask ? await conflictSubtask(c, projectId, result.currentSubtask) : undefined;
      return c.json({ error: "Checklist schedule changed; review the latest schedule before saving.", code: "subtask_schedule_version_conflict", current: result.current, ...(currentSubtask ? { currentSubtask } : {}) }, 409);
    }
    case "item_conflict": {
      const currentSubtask = await conflictSubtask(c, projectId, result.currentSubtask);
      if (!currentSubtask) return c.json({ error: "Subtask not found" }, 404);
      return c.json({ error: "Checklist item changed; review the latest item before saving.", code: "subtask_item_conflict", current: result.current, currentSubtask }, 409);
    }
    case "assignment_conflict": {
      const currentSubtask = await conflictSubtask(c, projectId, result.currentSubtask);
      if (!currentSubtask) return c.json({ error: "Subtask not found" }, 404);
      return c.json({ error: "Assignees changed; review the latest before saving.", code: "subtask_assignment_version_conflict", currentSubtask }, 409);
    }
  }
}

export const projectSubtasksRoutes = new Hono<AppEnv>();

projectSubtasksRoutes.get("/projects/:projectId/subtasks", terminalRoute("/projects/:projectId/subtasks", async (c) => {
  const projectId = c.req.param("projectId"); if (!idParam.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  if (c.get("user").role === "external_editor") {
    if (!await resolveVisibleProject(c.env, c.get("user"), projectId)) return c.json({ error: "Project not found" }, 404);
    const rows = await externalSubtaskQuery(createDb(c.env.DB), projectId, c.get("user").id).orderBy(asc(schema.projectSubtasks.position), asc(schema.projectSubtasks.id)).all();
    const assignees = await hydrateProjectAssignees(c.env.DB, projectId);
    return c.json(externalChecklistListResponseSchema.parse({ subtasks: rows.map((row) => externalSubtaskDto(row, assignees.get(row.id) ?? [])), projectDefaultRange: await projectDefaultRangeDtoFor(c.env, projectId) }));
  }
  const project = await ensureProjectAccessAndExists(c, projectId); if (project === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (!project) return c.json({ error: "Project not found" }, 404);
  const rows = await subtaskQuery(createDb(c.env.DB), projectId).orderBy(asc(schema.projectSubtasks.position), asc(schema.projectSubtasks.id)).all();
  const assignees = await hydrateProjectAssignees(c.env.DB, projectId);
  return c.json({ subtasks: rows.map((row) => serializeSubtask(row, assignees.get(row.subtask.id) ?? [])), projectDefaultRange: await projectDefaultRangeDtoFor(c.env, projectId) });
}));

projectSubtasksRoutes.get("/projects/:projectId/subtask-assignee-options", terminalRoute("/projects/:projectId/subtask-assignee-options", async (c) => {
  const projectId = c.req.param("projectId"); if (!idParam.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  if (c.get("user").role === "external_editor") {
    if (!await resolveVisibleProject(c.env, c.get("user"), projectId)) return c.json({ error: "Project not found" }, 404);
    // Team members only: an External Editor is never offered a person hidden from them.
    const { results } = await c.env.DB.prepare(`
      SELECT DISTINCT u.id, u.name, u.role FROM user u JOIN project_members pm ON pm.user_id = u.id
      WHERE pm.project_id = ? AND u.active = 1 ORDER BY u.name, u.id
    `).bind(projectId).all<{ id: string; name: string; role: keyof typeof ROLE_LABELS }>();
    return c.json(externalSubtaskAssigneeOptionsResponseSchema.parse({
      candidates: results.map((row) => externalPersonSchema.parse({ id: row.id, name: row.name, roleLabel: ROLE_LABELS[row.role], isExternal: row.role === "external_editor", active: true })),
    }));
  }
  const project = await ensureProjectAccessAndExists(c, projectId); if (project === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (!project) return c.json({ error: "Project not found" }, 404);
  return c.json(subtaskAssigneeOptionsResponseSchema.parse({ candidates: await projectMentionableUsers(c.env, projectId) }));
}));

projectSubtasksRoutes.post("/projects/:projectId/subtasks", terminalRoute("/projects/:projectId/subtasks", async (c) => {
  const projectId = c.req.param("projectId"); if (!idParam.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  if (c.get("user").role === "external_editor" && !await resolveVisibleProject(c.env, c.get("user"), projectId)) return c.json({ error: "Project not found" }, 404);
  const data = await subtaskJsonInput(c, createInput); if (data instanceof Response) return data;
  const result = await saveProjectSubtask({
    env: c.env,
    projectId,
    principal: c.get("user"),
    operation: { kind: "create", item: { title: data.title, assigneeIds: data.assigneeIds ?? [] }, schedule: data.schedule },
  });
  await finalizeProjectSubtaskCommandResult({ env: c.env, executionCtx: c.executionCtx, result });
  return await commandResponse(c, projectId, result, result.outcome === "created" ? 201 : 200);
}));

projectSubtasksRoutes.patch("/projects/:projectId/subtasks/:subtaskId", terminalRoute("/projects/:projectId/subtasks/:subtaskId", async (c) => {
  const projectId = c.req.param("projectId"); const subtaskId = c.req.param("subtaskId");
  if (!idParam.safeParse(projectId).success || !idParam.safeParse(subtaskId).success) return c.json({ error: "Invalid project or subtask id" }, 400);
  if (c.get("user").role === "external_editor" && !await resolveVisibleProject(c.env, c.get("user"), projectId)) return c.json({ error: "Project not found" }, 404);
  const data = await subtaskJsonInput(c, updateInput); if (data instanceof Response) return data;
  const hasSchedule = hasField(data, "schedule");
  const itemPatch: ItemPatch = {};
  if (hasField(data, "title")) itemPatch.title = data.title;
  if (hasField(data, "done")) itemPatch.done = data.done;
  if (hasField(data, "assignees")) itemPatch.assignees = data.assignees;
  const result = await saveProjectSubtask({
    env: c.env,
    projectId,
    principal: c.get("user"),
    operation: {
      kind: "update",
      subtaskId,
      itemPatch: Object.keys(itemPatch).length ? itemPatch : undefined,
      scheduleRequest: hasSchedule ? data.schedule : undefined,
    },
  });
  await finalizeProjectSubtaskCommandResult({ env: c.env, executionCtx: c.executionCtx, result });
  return await commandResponse(c, projectId, result);
}));

projectSubtasksRoutes.post("/projects/:projectId/subtasks/:subtaskId/reorder", terminalRoute("/projects/:projectId/subtasks/:subtaskId/reorder", async (c) => {
  const projectId = c.req.param("projectId"); const subtaskId = c.req.param("subtaskId");
  if (!idParam.safeParse(projectId).success || !idParam.safeParse(subtaskId).success) return c.json({ error: "Invalid project or subtask id" }, 400);
  if (c.get("user").role === "external_editor" && !await resolveVisibleProject(c.env, c.get("user"), projectId)) return c.json({ error: "Project not found" }, 404);
  const project = await ensureProjectAccessAndExists(c, projectId); if (project === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (!project) return c.json({ error: "Project not found" }, 404);
  const data = await jsonInput(c, reorderInput); if (data instanceof Response) return data;
  if (data.beforeId === subtaskId || data.afterId === subtaskId) return c.json({ error: "A subtask cannot be its own neighbor" }, 400);
  const db = createDb(c.env.DB); const target = await db.select({ id: schema.projectSubtasks.id, position: schema.projectSubtasks.position }).from(schema.projectSubtasks).where(and(eq(schema.projectSubtasks.id, subtaskId), eq(schema.projectSubtasks.projectId, projectId))).get();
  if (!target) return c.json({ error: "Subtask not found" }, 404);
  const snapshot = await db.select({ id: schema.projectSubtasks.id, position: schema.projectSubtasks.position }).from(schema.projectSubtasks).where(eq(schema.projectSubtasks.projectId, projectId)).orderBy(asc(schema.projectSubtasks.position), asc(schema.projectSubtasks.id)).all();
  const remaining = snapshot.filter((item) => item.id !== subtaskId);
  const beforeIndex = data.beforeId ? remaining.findIndex((item) => item.id === data.beforeId) : -1;
  const afterIndex = data.afterId ? remaining.findIndex((item) => item.id === data.afterId) : -1;
  if ((data.beforeId && beforeIndex < 0) || (data.afterId && afterIndex < 0)) return c.json({ error: "Neighbor subtask not found" }, 404);
  const expectedAfterIndex = data.beforeId ? beforeIndex + 1 : 0;
  if (data.beforeId === null && data.afterId === null ? remaining.length !== 0 : data.afterId ? afterIndex !== expectedAfterIndex : beforeIndex !== remaining.length - 1) return c.json({ error: "Subtask order changed; reload and try again" }, 409);
  const before = data.beforeId ? remaining[beforeIndex]! : null; const after = data.afterId ? remaining[afterIndex]! : null;
  const position = computeInsertPosition(before?.position ?? null, after?.position ?? null); const now = Date.now();
  const tied = position === before?.position || position === after?.position;
  let changes = 0;
  if (tied) {
    const insertAt = before ? beforeIndex + 1 : 0; const desired = [...remaining]; desired.splice(insertAt, 0, target);
    const snapshotJson = JSON.stringify(desired.map((item, index) => ({ id: item.id, oldPosition: item.position, newPosition: (index + 1) * POSITION_STEP })));
    const [rebased] = await c.env.DB.batch([c.env.DB.prepare(`UPDATE project_subtasks SET position = (SELECT CAST(json_extract(value, '$.newPosition') AS INTEGER) FROM json_each(?1) WHERE json_extract(value, '$.id') = project_subtasks.id), updated_at = ?2 WHERE project_id = ?3 AND (id, position) IN (SELECT json_extract(value, '$.id'), json_extract(value, '$.oldPosition') FROM json_each(?1)) AND (SELECT COUNT(*) FROM project_subtasks WHERE project_id = ?3 AND (id, position) IN (SELECT json_extract(value, '$.id'), json_extract(value, '$.oldPosition') FROM json_each(?1))) = json_array_length(?1) AND (SELECT COUNT(*) FROM project_subtasks WHERE project_id = ?3) = json_array_length(?1)`).bind(snapshotJson, now, projectId)]);
    changes = rebased?.meta.changes ?? 0;
    if (changes !== snapshot.length) return c.json({ error: "Subtask order changed; reload and try again" }, 409);
    const targetPosition = desired.findIndex((item) => item.id === subtaskId) + 1;
    await audit(c.env, c.get("user"), "project_subtask.reorder", "project_subtask", subtaskId, { beforeId: data.beforeId, afterId: data.afterId });
    return c.json({ position: targetPosition * POSITION_STEP });
  }
  const params: unknown[] = [position, now, target.id, projectId, target.position, projectId, snapshot.length];
  let guard = "";
  if (before) { guard += " AND EXISTS (SELECT 1 FROM project_subtasks WHERE id = ? AND project_id = ? AND position = ?)"; params.push(before.id, projectId, before.position); }
  if (after) { guard += " AND EXISTS (SELECT 1 FROM project_subtasks WHERE id = ? AND project_id = ? AND position = ?)"; params.push(after.id, projectId, after.position); }
  if (before && after) { guard += " AND NOT EXISTS (SELECT 1 FROM project_subtasks AS candidate WHERE candidate.project_id = ? AND candidate.id <> ? AND (candidate.position > ? OR (candidate.position = ? AND candidate.id > ?)) AND (candidate.position < ? OR (candidate.position = ? AND candidate.id < ?)))"; params.push(projectId, target.id, before.position, before.position, before.id, after.position, after.position, after.id); }
  else if (before) { guard += " AND NOT EXISTS (SELECT 1 FROM project_subtasks AS candidate WHERE candidate.project_id = ? AND candidate.id <> ? AND (candidate.position > ? OR (candidate.position = ? AND candidate.id > ?)))"; params.push(projectId, target.id, before.position, before.position, before.id); }
  else if (after) { guard += " AND NOT EXISTS (SELECT 1 FROM project_subtasks AS candidate WHERE candidate.project_id = ? AND candidate.id <> ? AND (candidate.position < ? OR (candidate.position = ? AND candidate.id < ?)))"; params.push(projectId, target.id, after.position, after.position, after.id); }
  const [updated] = await c.env.DB.batch([c.env.DB.prepare(`UPDATE project_subtasks SET position = ?, updated_at = ? WHERE id = ? AND project_id = ? AND position = ? AND (SELECT COUNT(*) FROM project_subtasks WHERE project_id = ?) = ?${guard}`).bind(...params)]);
  changes = updated?.meta.changes ?? 0;
  if (changes !== 1) return c.json({ error: "Subtask order changed; reload and try again" }, 409);
    await audit(c.env, c.get("user"), "project_subtask.reorder", "project_subtask", subtaskId, { beforeId: data.beforeId, afterId: data.afterId });
  return c.json({ position });
}));

projectSubtasksRoutes.delete("/projects/:projectId/subtasks/:subtaskId", terminalRoute("/projects/:projectId/subtasks/:subtaskId", async (c) => {
  const projectId = c.req.param("projectId"); const subtaskId = c.req.param("subtaskId");
  if (!idParam.safeParse(projectId).success || !idParam.safeParse(subtaskId).success) return c.json({ error: "Invalid project or subtask id" }, 400);
  if (c.get("user").role === "external_editor" && !await resolveVisibleProject(c.env, c.get("user"), projectId)) return c.json({ error: "Project not found" }, 404);
  const project = await ensureProjectAccessAndExists(c, projectId); if (project === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (!project) return c.json({ error: "Project not found" }, 404);
  const db = createDb(c.env.DB); const existing = await subtaskQuery(db, projectId, subtaskId).get(); if (!existing) return c.json({ error: "Subtask not found" }, 404);
  const auditId = newId(); const activityId = newId();
  const activity: ProjectActivityIntent = {
    schemaVersion: 1,
    activity: { id: activityId, type: "project.checklist.item_deleted", projectId, actorId: c.get("user").id, occurredAt: Date.now(), source: { kind: "project_checklist", id: subtaskId, key: `project-checklist:${subtaskId}:deleted` }, safePayload: { itemId: subtaskId, checklistTitle: existing.subtask.title }, deepLink: projectActivityDeepLink("project.checklist.item_deleted", projectId) },
    broadDelivery: { registryKey: "project.checklist.item_deleted", sourceActivityId: activityId, coalesce: null },
  };
  const activityStatements = buildProjectActivityStatements({ db: c.env.DB, intent: activity, winnerAuditId: auditId, createdAt: Date.now() });
  const results = await c.env.DB.batch([
    // The title is part of the delete snapshot because the activity payload is prepared before
    // the batch. A concurrent rename therefore loses this delete rather than producing stale bell copy.
    c.env.DB.prepare("DELETE FROM project_subtasks WHERE id = ? AND project_id = ? AND title IS ? RETURNING id").bind(subtaskId, projectId, existing.subtask.title),
    c.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, ?, 'project_subtask.delete', 'project_subtask', ?, ?, ? WHERE changes() = 1").bind(auditId, c.get("user").id, subtaskId, auditMeta(c.get("user")), Date.now()),
    ...activityStatements.statements,
  ]);
  if (!rowsFromD1<{ id: string }>(results[0])[0]) {
    const current = await subtaskQuery(db, projectId, subtaskId).get();
    if (current) return c.json({ error: "Subtask changed while deleting; reload and try again", code: "subtask_changed" }, 409);
    return c.json({ error: "Subtask not found" }, 404);
  }
  const publicationIds = rowsFromD1<{ id: string }>(results[2 + activityStatements.broadOutboxIndex]).map((row) => row.id);
  if (publicationIds.length) c.executionCtx.waitUntil(publishOutboxDetached(c.env.NOTIFICATION_QUEUE, c.env.DB, publicationIds));
  return c.json({ ok: true });
}));
