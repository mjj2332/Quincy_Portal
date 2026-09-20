import { Hono } from "hono";
import { terminalRoute } from "../lib/terminal-route";
import { createDb, schema } from "@quincy/db";
import { and, eq } from "drizzle-orm";
import { normalizeRichTextMentionLabels, parseRichTextDoc, richTextMentionIds, richTextPlainText, type RichTextDoc } from "@quincy/shared";
import { z } from "zod";
import type { AppEnv } from "../env";
import { hasProjectCollaborationAccess } from "../middleware/capability";
import { newId } from "../lib/ids";
import { publishNotificationOutbox } from "@quincy/shared";
import { projectMentionableUsers } from "../lib/project-collaboration";
import { projectStageForRole } from "./stages";
import {
  advanceProjectCommentReadMarker,
  createProjectComment,
  deleteProjectComment,
  editProjectComment,
  findProjectComment,
  getProjectCommentReadState,
  listProjectComments,
  serializeProjectComment,
} from "../lib/project-comments";
import { jsonInput } from "./helpers";
import { resolveVisibleProject } from "../lib/visible-project-scope";
import { assignedSubtaskCounts } from "../lib/external-project-query";
import { EXTERNAL_API_RESPONSE_SCHEMAS, ROLE_LABELS, externalCommentListResponseSchema, externalCommentSchema } from "@quincy/shared";
import { stageTransportKeyForRole, type StageKey } from "@quincy/shared";

const MAX_LIMIT = 50;
const COMMENT_BODY_MAX_LENGTH = 10_000;
const projectIdSchema = z.string().uuid();
const commentInput = z.object({ content: z.unknown() });
const listInput = z.object({ limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(), before: z.string().min(1).optional() });
type Cursor = { createdAt: string; id: string };

function encodeCursor(row: { createdAt: Date; id: string }) { return btoa(JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id })); }
function parseCursor(value: string): Cursor | null {
  try {
    const parsed = JSON.parse(atob(value)) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const item = parsed as Record<string, unknown>;
    const createdAt = typeof item.createdAt === "string" ? new Date(item.createdAt) : null;
    return createdAt && !Number.isNaN(createdAt.valueOf()) && projectIdSchema.safeParse(item.id).success ? { createdAt: createdAt.toISOString(), id: item.id as string } : null;
  } catch { return null; }
}

async function ensureProjectAccessAndExists(c: Parameters<typeof hasProjectCollaborationAccess>[0], projectId: string) {
  if (!await hasProjectCollaborationAccess(c, projectId)) return c.get("user").role === "external_editor" ? "not_found" as const : "forbidden" as const;
  const project = await createDb(c.env.DB).select({ id: schema.projects.id, street: schema.projects.street }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  return project ?? null;
}

async function normalizedContent(env: AppEnv["Bindings"], projectId: string, input: unknown): Promise<{ content: RichTextDoc; body: string; mentionIds: string[] } | null> {
  let parsed: RichTextDoc;
  try { parsed = parseRichTextDoc(input); } catch { return null; }
  const mentionIds = richTextMentionIds(parsed);
  const eligible = await projectMentionableUsers(env, projectId);
  const names = new Map(eligible.map((candidate) => [candidate.id, candidate.name]));
  if (mentionIds.some((id) => !names.has(id))) return null;
  try {
    const content = normalizeRichTextMentionLabels(parsed, names);
    const body = richTextPlainText(content).trim();
    return body && body.length <= COMMENT_BODY_MAX_LENGTH ? { content, body, mentionIds } : null;
  } catch { return null; }
}

export const projectCommentsRoutes = new Hono<AppEnv>();

projectCommentsRoutes.get("/projects/:projectId/collaboration-summary", terminalRoute("/projects/:projectId/collaboration-summary", async (c) => {
  const projectId = c.req.param("projectId");
  if (!projectIdSchema.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  if (c.get("user").role === "external_editor" && !await resolveVisibleProject(c.env, c.get("user"), projectId)) return c.json({ error: "Project not found" }, 404);
  if (!await hasProjectCollaborationAccess(c, projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const db = createDb(c.env.DB);
  const project = await db.select({ id: schema.projects.id, street: schema.projects.street, stageKey: schema.projects.stageKey }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) return c.json({ error: "Project not found" }, 404);
  const members = await db.select({ id: schema.projectMembers.id, userId: schema.projectMembers.userId, roleOnProject: schema.projectMembers.roleOnProject, name: schema.user.name, email: schema.user.email, globalRole: schema.user.role, active: schema.user.active })
    .from(schema.projectMembers).innerJoin(schema.user, eq(schema.projectMembers.userId, schema.user.id)).where(eq(schema.projectMembers.projectId, projectId)).orderBy(schema.projectMembers.roleOnProject, schema.user.name, schema.user.id).all();
  if (c.get("user").role === "external_editor") {
    const subtaskCounts = await assignedSubtaskCounts(db, projectId);
    return c.json(EXTERNAL_API_RESPONSE_SCHEMAS.collaboration.parse({
      project: { id: project.id, street: project.street, stageKey: stageTransportKeyForRole(project.stageKey as StageKey, "external_editor") },
      members: members.map((member) => ({
        id: member.userId, membershipCycleId: member.id, roleOnProject: member.roleOnProject,
        name: member.name, email: member.email, roleLabel: ROLE_LABELS[member.globalRole],
        isExternal: member.globalRole === "external_editor", active: Boolean(member.active),
        assignedSubtaskCount: subtaskCounts.get(member.userId) ?? 0,
      })),
    }));
  }
  return c.json({
    project: { id: project.id, street: project.street, stageKey: projectStageForRole(project, c.get("user").role).stageKey },
    members: members.map((member) => ({ id: member.id, userId: member.userId, roleOnProject: member.roleOnProject, name: member.name, active: Boolean(member.active) })),
  });
}));

projectCommentsRoutes.get("/projects/:projectId/comments", terminalRoute("/projects/:projectId/comments", async (c) => {
  const projectId = c.req.param("projectId"); if (!projectIdSchema.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  const parsed = listInput.safeParse(c.req.query()); if (!parsed.success) return c.json({ error: "Invalid query", details: parsed.error.flatten() }, 400);
  const access = await ensureProjectAccessAndExists(c, projectId); if (access === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (access === "not_found" || !access) return c.json({ error: "Project not found" }, 404);
  const cursor = parsed.data.before ? parseCursor(parsed.data.before) : null; if (parsed.data.before && !cursor) return c.json({ error: "Invalid cursor" }, 400);
  const rows = await listProjectComments(createDb(c.env.DB), projectId, { limit: parsed.data.limit ?? MAX_LIMIT, before: cursor ? { createdAt: new Date(cursor.createdAt), id: cursor.id } : null });
  const oldest = rows.at(-1)?.comment;
  if (c.get("user").role === "external_editor") return c.json(externalCommentListResponseSchema.parse({ project: access, comments: rows.map((row) => externalCommentSchema.parse(serializeProjectComment(row))), ...(oldest && rows.length === (parsed.data.limit ?? MAX_LIMIT) ? { nextCursor: encodeCursor(oldest) } : {}) }));
  return c.json({ project: access, comments: rows.map(serializeProjectComment), ...(oldest && rows.length === (parsed.data.limit ?? MAX_LIMIT) ? { nextCursor: encodeCursor(oldest) } : {}) });
}));

projectCommentsRoutes.post("/projects/:projectId/comments", terminalRoute("/projects/:projectId/comments", async (c) => {
  const projectId = c.req.param("projectId"); if (!projectIdSchema.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  const access = await ensureProjectAccessAndExists(c, projectId); if (access === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (access === "not_found" || !access) return c.json({ error: "Project not found" }, 404);
  const data = await jsonInput(c, commentInput); if (data instanceof Response) return data;
  const prepared = await normalizedContent(c.env, projectId, data.content); if (!prepared) return c.json({ error: "Invalid comment content or mention target" }, 400);
  const db = createDb(c.env.DB); const currentUser = c.get("user"); const id = newId(); const createdAt = new Date();
  const mentions = prepared.mentionIds.map((mentionedUserId) => ({ id: newId(), commentId: id, mentionedUserId, createdAt }));
  const result = await createProjectComment(c.env.DB, { id, projectId, authorId: currentUser.id, auditPrincipal: currentUser, body: prepared.body, contentJson: JSON.stringify(prepared.content), mentions, wallClockMs: createdAt.getTime(), occurredAt: createdAt });
  c.executionCtx.waitUntil(publishNotificationOutbox(c.env.NOTIFICATION_QUEUE, c.env.DB, result.notificationOutboxIds));
  if (!result.comment) return c.json({ error: "Comment could not be created" }, 500);
  return c.json(c.get("user").role === "external_editor" ? externalCommentSchema.parse(serializeProjectComment(result.comment)) : serializeProjectComment(result.comment), 201);
}));

projectCommentsRoutes.patch("/projects/:projectId/comments/:commentId", terminalRoute("/projects/:projectId/comments/:commentId", async (c) => {
  const projectId = c.req.param("projectId"); const commentId = c.req.param("commentId"); if (!projectIdSchema.safeParse(projectId).success || !projectIdSchema.safeParse(commentId).success) return c.json({ error: "Invalid project or comment id" }, 400);
  const access = await ensureProjectAccessAndExists(c, projectId); if (access === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (access === "not_found" || !access) return c.json({ error: "Project not found" }, 404);
  const data = await jsonInput(c, commentInput); if (data instanceof Response) return data;
  const db = createDb(c.env.DB); const existing = await findProjectComment(db, projectId, commentId); if (!existing) return c.json({ error: "Comment not found" }, 404);
  // An impersonated Admin intentionally acts as the effective author here — see the
  // impersonation caveat on this rule in AGENTS.md.
  const currentUser = c.get("user"); if (existing.comment.authorId !== currentUser.id) return c.json({ error: "Forbidden: only the author can edit this comment." }, 403);
  const prepared = await normalizedContent(c.env, projectId, data.content); if (!prepared) return c.json({ error: "Invalid comment content or mention target" }, 400);
  const maps = await db.select().from(schema.projectCommentMentions).where(eq(schema.projectCommentMentions.commentId, commentId)).all(); const wanted = new Set(prepared.mentionIds); const existingIds = new Set(maps.map((map) => map.mentionedUserId)); const createdAt = new Date();
  const added = prepared.mentionIds.filter((mentionedUserId) => !existingIds.has(mentionedUserId)).map((mentionedUserId) => ({ id: newId(), commentId, mentionedUserId, createdAt }));
  const result = await editProjectComment(c.env.DB, { projectId, commentId, actorId: currentUser.id, auditPrincipal: currentUser, body: prepared.body, contentJson: JSON.stringify(prepared.content), removeMentionIds: maps.filter((map) => !wanted.has(map.mentionedUserId)).map((map) => map.id), addMentions: added, mentionIds: prepared.mentionIds, editedAt: createdAt, occurredAt: createdAt });
  c.executionCtx.waitUntil(publishNotificationOutbox(c.env.NOTIFICATION_QUEUE, c.env.DB, result.notificationOutboxIds));
  if (!result.comment) return c.json({ error: "Comment could not be updated" }, 500);
  return c.json(c.get("user").role === "external_editor" ? externalCommentSchema.parse(serializeProjectComment(result.comment)) : serializeProjectComment(result.comment));
}));

projectCommentsRoutes.delete("/projects/:projectId/comments/:commentId", terminalRoute("/projects/:projectId/comments/:commentId", async (c) => {
  const projectId = c.req.param("projectId"); const commentId = c.req.param("commentId"); if (!projectIdSchema.safeParse(projectId).success || !projectIdSchema.safeParse(commentId).success) return c.json({ error: "Invalid project or comment id" }, 400);
  const access = await ensureProjectAccessAndExists(c, projectId); if (access === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (access === "not_found" || !access) return c.json({ error: "Project not found" }, 404);
  const db = createDb(c.env.DB); const existing = await findProjectComment(db, projectId, commentId); if (!existing) return c.json({ error: "Comment not found" }, 404);
  // An impersonated Admin intentionally acts as the effective author here — see the
  // impersonation caveat on this rule in AGENTS.md.
  const currentUser = c.get("user"); if (existing.comment.authorId !== currentUser.id) return c.json({ error: "Forbidden: only the author can delete this comment." }, 403);
  const result = await deleteProjectComment(c.env.DB, { projectId, commentId, actorId: currentUser.id, auditPrincipal: currentUser, occurredAt: new Date() });
  c.executionCtx.waitUntil(publishNotificationOutbox(c.env.NOTIFICATION_QUEUE, c.env.DB, result.notificationOutboxIds));
  return c.json({ ok: true });
}));

const readMarkerInput = z.object({ throughCommentId: z.string().uuid() }).strict();

projectCommentsRoutes.get("/projects/:projectId/comment-read-marker", terminalRoute("/projects/:projectId/comment-read-marker", async (c) => {
  const projectId = c.req.param("projectId"); if (!projectIdSchema.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  const access = await ensureProjectAccessAndExists(c, projectId); if (access === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (access === "not_found" || !access) return c.json({ error: "Project not found" }, 404);
  return c.json(await getProjectCommentReadState(c.env.DB, c.get("user").id, projectId));
}));

projectCommentsRoutes.patch("/projects/:projectId/comment-read-marker", terminalRoute("/projects/:projectId/comment-read-marker", async (c) => {
  const projectId = c.req.param("projectId"); if (!projectIdSchema.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  const access = await ensureProjectAccessAndExists(c, projectId); if (access === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (access === "not_found" || !access) return c.json({ error: "Project not found" }, 404);
  const data = await jsonInput(c, readMarkerInput); if (data instanceof Response) return data;
  const result = await advanceProjectCommentReadMarker(c.env.DB, c.get("user").id, projectId, data.throughCommentId);
  if (!result.targetExists) return c.json({ error: "Comment read target changed.", code: "comment_read_target_changed" }, 409);
  return c.json(result.state);
}));
