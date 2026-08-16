import { Hono } from "hono";
import { createDb, schema } from "@quincy/db";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
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

function isCalendarDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1]!;
}

const titleInput = z.string().trim().min(1).max(TITLE_MAX_LENGTH);
const dueDateInput = z.string().refine(isCalendarDate, "Expected a calendar-valid YYYY-MM-DD date");
const createInput = z.object({ title: titleInput, assigneeId: idParam.optional(), dueDate: dueDateInput.optional() }).strict();
const updateInput = z.object({
  title: titleInput.optional(), done: z.boolean().optional(), assigneeId: idParam.nullable().optional(), dueDate: dueDateInput.nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field is required");
const moveInput = z.object({ direction: z.enum(["up", "down"]) }).strict();

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
  if (has("dueDate") && data.dueDate !== existing.subtask.dueDate) { values.dueDate = data.dueDate; changed.push("dueDate"); }
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

projectSubtasksRoutes.post("/projects/:projectId/subtasks/:subtaskId/move", async (c) => {
  const projectId = c.req.param("projectId"); const subtaskId = c.req.param("subtaskId");
  if (!idParam.safeParse(projectId).success || !idParam.safeParse(subtaskId).success) return c.json({ error: "Invalid project or subtask id" }, 400);
  const project = await ensureProjectAccessAndExists(c, projectId); if (project === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (!project) return c.json({ error: "Project not found" }, 404);
  const data = await jsonInput(c, moveInput); if (data instanceof Response) return data;
  const db = createDb(c.env.DB); const target = await db.select({ id: schema.projectSubtasks.id, position: schema.projectSubtasks.position }).from(schema.projectSubtasks).where(and(eq(schema.projectSubtasks.id, subtaskId), eq(schema.projectSubtasks.projectId, projectId))).get();
  if (!target) return c.json({ error: "Subtask not found" }, 404);
  const neighbor = await db.select({ id: schema.projectSubtasks.id, position: schema.projectSubtasks.position }).from(schema.projectSubtasks)
    .where(and(eq(schema.projectSubtasks.projectId, projectId), data.direction === "up" ? or(sql`${schema.projectSubtasks.position} < ${target.position}`, and(eq(schema.projectSubtasks.position, target.position), sql`${schema.projectSubtasks.id} < ${target.id}`)) : or(sql`${schema.projectSubtasks.position} > ${target.position}`, and(eq(schema.projectSubtasks.position, target.position), sql`${schema.projectSubtasks.id} > ${target.id}`))))
    .orderBy(data.direction === "up" ? desc(schema.projectSubtasks.position) : asc(schema.projectSubtasks.position), data.direction === "up" ? desc(schema.projectSubtasks.id) : asc(schema.projectSubtasks.id)).limit(1).get();
  if (!neighbor || neighbor.position === target.position) return c.json({ position: target.position });
  const now = Date.now();
  // One guarded statement inside a D1 batch swaps both rows only when the original target and
  // adjacent neighbor are still this project's exact snapshot; no client position is trusted.
  const [swap] = await c.env.DB.batch([c.env.DB.prepare(`UPDATE project_subtasks SET position = CASE WHEN id = ? THEN ? WHEN id = ? THEN ? END, updated_at = ? WHERE project_id = ? AND ((id = ? AND position = ?) OR (id = ? AND position = ?)) AND EXISTS (SELECT 1 FROM project_subtasks WHERE id = ? AND project_id = ? AND position = ?) AND EXISTS (SELECT 1 FROM project_subtasks WHERE id = ? AND project_id = ? AND position = ?)`)
    .bind(target.id, neighbor.position, neighbor.id, target.position, now, projectId, target.id, target.position, neighbor.id, neighbor.position, target.id, projectId, target.position, neighbor.id, projectId, neighbor.position)]);
  if ((swap?.meta.changes ?? 0) !== 2) {
    const current = await db.select({ position: schema.projectSubtasks.position }).from(schema.projectSubtasks).where(and(eq(schema.projectSubtasks.id, subtaskId), eq(schema.projectSubtasks.projectId, projectId))).get();
    return current ? c.json({ position: current.position }) : c.json({ error: "Subtask not found" }, 404);
  }
  await audit(c.env, c.get("user").id, "project_subtask.move", "project_subtask", subtaskId, { direction: data.direction });
  return c.json({ position: neighbor.position });
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
