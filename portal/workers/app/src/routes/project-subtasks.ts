import { Hono } from "hono";
import { computeInsertPosition, createDb, schema } from "@quincy/db";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { newId } from "../lib/ids";
import { notifySubtaskAssignee } from "../lib/notifications";
import { projectMentionableUsers } from "../lib/project-collaboration";
import { hasProjectCollaborationAccess } from "../middleware/capability";
import { jsonInput } from "./helpers";

const idParam = z.string().uuid();
const TITLE_MAX_LENGTH = 500;
const POSITION_STEP = 1024;

function isCalendarDateTime(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > daysInMonth[month - 1]!) return false;
  if (match[4] !== undefined) {
    const hour = Number(match[4]); const minute = Number(match[5]);
    if (hour > 23 || minute > 59) return false;
  }
  return true;
}

const titleInput = z.string().trim().min(1).max(TITLE_MAX_LENGTH);
const dueDateInput = z.string().refine(isCalendarDateTime, "Expected a calendar-valid YYYY-MM-DD date or YYYY-MM-DDTHH:MM date-time");
const createInput = z.object({ title: titleInput, assigneeId: idParam.optional(), dueDate: dueDateInput.optional() }).strict();
const updateInput = z.object({
  title: titleInput.optional(), done: z.boolean().optional(), assigneeId: idParam.nullable().optional(), dueDate: dueDateInput.nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field is required");
const reorderInput = z.object({ beforeId: idParam.nullable(), afterId: idParam.nullable() }).strict().refine((value) => value.beforeId !== value.afterId || value.beforeId === null, "Neighbors must be distinct");

type SubtaskRow = { subtask: typeof schema.projectSubtasks.$inferSelect; assigneeId: string | null; assigneeName: string | null };

function serializeSubtask(row: SubtaskRow) {
  const item = row.subtask;
  return {
    id: item.id, title: item.title, done: item.done, position: item.position,
    assignee: row.assigneeId && row.assigneeName ? { id: row.assigneeId, name: row.assigneeName } : null,
    assignmentVersion: item.assignmentVersion, dueDate: item.dueDate,
    createdBy: item.createdBy, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString(),
  };
}

async function ensureProjectAccessAndExists(c: Parameters<typeof hasProjectCollaborationAccess>[0], projectId: string) {
  if (!await hasProjectCollaborationAccess(c, projectId)) return "forbidden" as const;
  return createDb(c.env.DB).select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
}

function subtaskQuery(db: ReturnType<typeof createDb>, projectId: string, subtaskId?: string) {
  return db.select({ subtask: schema.projectSubtasks, assigneeId: schema.user.id, assigneeName: schema.user.name })
    .from(schema.projectSubtasks).leftJoin(schema.user, eq(schema.projectSubtasks.assigneeId, schema.user.id))
    .where(and(eq(schema.projectSubtasks.projectId, projectId), subtaskId ? eq(schema.projectSubtasks.id, subtaskId) : undefined));
}

async function eligibleAssignee(env: AppEnv["Bindings"], projectId: string, assigneeId: string) {
  return (await projectMentionableUsers(env, projectId)).some((candidate) => candidate.id === assigneeId);
}

function assigneeUnchangedCondition(assigneeId: string | null) {
  return assigneeId === null ? isNull(schema.projectSubtasks.assigneeId) : eq(schema.projectSubtasks.assigneeId, assigneeId);
}

export const projectSubtasksRoutes = new Hono<AppEnv>();

projectSubtasksRoutes.get("/projects/:projectId/subtasks", async (c) => {
  const projectId = c.req.param("projectId"); if (!idParam.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  const project = await ensureProjectAccessAndExists(c, projectId); if (project === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (!project) return c.json({ error: "Project not found" }, 404);
  const rows = await subtaskQuery(createDb(c.env.DB), projectId).orderBy(asc(schema.projectSubtasks.position), asc(schema.projectSubtasks.id)).all();
  return c.json({ subtasks: rows.map(serializeSubtask) });
});

projectSubtasksRoutes.post("/projects/:projectId/subtasks", async (c) => {
  const projectId = c.req.param("projectId"); if (!idParam.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  const project = await ensureProjectAccessAndExists(c, projectId); if (project === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (!project) return c.json({ error: "Project not found" }, 404);
  const data = await jsonInput(c, createInput); if (data instanceof Response) return data;
  if (data.assigneeId && !await eligibleAssignee(c.env, projectId, data.assigneeId)) return c.json({ error: "Assignee is not an active project participant" }, 400);
  const db = createDb(c.env.DB); const last = await db.select({ position: schema.projectSubtasks.position }).from(schema.projectSubtasks).where(eq(schema.projectSubtasks.projectId, projectId)).orderBy(desc(schema.projectSubtasks.position), desc(schema.projectSubtasks.id)).limit(1).get();
  const now = new Date(); const id = newId(); const assignmentVersion = data.assigneeId ? 1 : 0;
  await db.insert(schema.projectSubtasks).values({ id, projectId, title: data.title, done: false, position: (last?.position ?? 0) + POSITION_STEP, assigneeId: data.assigneeId, assignmentVersion, dueDate: data.dueDate, createdBy: c.get("user").id, createdAt: now, updatedAt: now });
  await audit(c.env, c.get("user").id, "project_subtask.create", "project_subtask", id);
  await notifySubtaskAssignee(c.env, { projectId, actorId: c.get("user").id, assigneeId: data.assigneeId ?? null, subtaskId: id, assignmentVersion });
  const task = await subtaskQuery(db, projectId, id).get(); if (!task) return c.json({ error: "Subtask could not be created" }, 500);
  return c.json(serializeSubtask(task), 201);
});

projectSubtasksRoutes.patch("/projects/:projectId/subtasks/:subtaskId", async (c) => {
  const projectId = c.req.param("projectId"); const subtaskId = c.req.param("subtaskId");
  if (!idParam.safeParse(projectId).success || !idParam.safeParse(subtaskId).success) return c.json({ error: "Invalid project or subtask id" }, 400);
  const project = await ensureProjectAccessAndExists(c, projectId); if (project === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (!project) return c.json({ error: "Project not found" }, 404);
  const data = await jsonInput(c, updateInput); if (data instanceof Response) return data;
  const db = createDb(c.env.DB); const existing = await subtaskQuery(db, projectId, subtaskId).get(); if (!existing) return c.json({ error: "Subtask not found" }, 404);
  const has = (key: keyof typeof data) => Object.prototype.hasOwnProperty.call(data, key);
  if (has("assigneeId") && data.assigneeId && !await eligibleAssignee(c.env, projectId, data.assigneeId)) return c.json({ error: "Assignee is not an active project participant" }, 400);
  const changed: string[] = [];
  const values: Record<string, unknown> = {};
  if (has("title") && data.title !== existing.subtask.title) { values.title = data.title; changed.push("title"); }
  if (has("done") && data.done !== existing.subtask.done) { values.done = data.done; changed.push("done"); }
  if (has("dueDate") && data.dueDate !== existing.subtask.dueDate) { values.dueDate = data.dueDate; values.dueReminderSentAt = null; changed.push("dueDate"); }
  const assignmentChanged = has("assigneeId") && data.assigneeId !== existing.subtask.assigneeId;
  if (assignmentChanged) { values.assigneeId = data.assigneeId; values.assignmentVersion = sql`${schema.projectSubtasks.assignmentVersion} + 1`; changed.push("assigneeId"); }
  if (!changed.length) return c.json(serializeSubtask(existing));
  values.updatedAt = new Date();
  // The compare-on-current-assignee guard means a concurrent reassignment cannot be overwritten
  // or spuriously notified based on this request's stale read.
  const updated = await db.update(schema.projectSubtasks).set(values).where(and(eq(schema.projectSubtasks.id, subtaskId), eq(schema.projectSubtasks.projectId, projectId), assigneeUnchangedCondition(existing.subtask.assigneeId))).returning().get();
  if (!updated) {
    const current = await subtaskQuery(db, projectId, subtaskId).get();
    return current ? c.json(serializeSubtask(current)) : c.json({ error: "Subtask not found" }, 404);
  }
  await audit(c.env, c.get("user").id, "project_subtask.update", "project_subtask", subtaskId, { fields: changed });
  if (assignmentChanged) await notifySubtaskAssignee(c.env, { projectId, actorId: c.get("user").id, assigneeId: updated.assigneeId, subtaskId, assignmentVersion: updated.assignmentVersion });
  const task = await subtaskQuery(db, projectId, subtaskId).get(); if (!task) return c.json({ error: "Subtask could not be updated" }, 500);
  return c.json(serializeSubtask(task));
});

projectSubtasksRoutes.post("/projects/:projectId/subtasks/:subtaskId/reorder", async (c) => {
  const projectId = c.req.param("projectId"); const subtaskId = c.req.param("subtaskId");
  if (!idParam.safeParse(projectId).success || !idParam.safeParse(subtaskId).success) return c.json({ error: "Invalid project or subtask id" }, 400);
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
    await audit(c.env, c.get("user").id, "project_subtask.reorder", "project_subtask", subtaskId, { beforeId: data.beforeId, afterId: data.afterId });
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
  await audit(c.env, c.get("user").id, "project_subtask.reorder", "project_subtask", subtaskId, { beforeId: data.beforeId, afterId: data.afterId });
  return c.json({ position });
});

projectSubtasksRoutes.delete("/projects/:projectId/subtasks/:subtaskId", async (c) => {
  const projectId = c.req.param("projectId"); const subtaskId = c.req.param("subtaskId");
  if (!idParam.safeParse(projectId).success || !idParam.safeParse(subtaskId).success) return c.json({ error: "Invalid project or subtask id" }, 400);
  const project = await ensureProjectAccessAndExists(c, projectId); if (project === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (!project) return c.json({ error: "Project not found" }, 404);
  const db = createDb(c.env.DB); const deleted = await db.delete(schema.projectSubtasks).where(and(eq(schema.projectSubtasks.id, subtaskId), eq(schema.projectSubtasks.projectId, projectId))).returning({ id: schema.projectSubtasks.id }).get();
  if (!deleted) return c.json({ error: "Subtask not found" }, 404);
  await audit(c.env, c.get("user").id, "project_subtask.delete", "project_subtask", subtaskId);
  return c.json({ ok: true });
});
