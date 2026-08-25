import { Hono } from "hono";
import { createDb, schema } from "@quincy/db";
import { and, eq } from "drizzle-orm";
import { normalizeRichTextMentionLabels, parseRichTextDoc, richTextMentionIds, richTextPlainText, type RichTextDoc } from "@quincy/shared";
import { z } from "zod";
import type { AppEnv } from "../env";
import { hasProjectCollaborationAccess } from "../middleware/capability";
import { audit } from "../lib/audit";
import { newId } from "../lib/ids";
import { notifyMentions } from "../lib/notifications";
import { projectMentionableUsers } from "../lib/project-collaboration";
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
  if (!await hasProjectCollaborationAccess(c, projectId)) return "forbidden" as const;
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

projectCommentsRoutes.get("/projects/:projectId/comments", async (c) => {
  const projectId = c.req.param("projectId"); if (!projectIdSchema.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  const parsed = listInput.safeParse(c.req.query()); if (!parsed.success) return c.json({ error: "Invalid query", details: parsed.error.flatten() }, 400);
  const access = await ensureProjectAccessAndExists(c, projectId); if (access === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (!access) return c.json({ error: "Project not found" }, 404);
  const cursor = parsed.data.before ? parseCursor(parsed.data.before) : null; if (parsed.data.before && !cursor) return c.json({ error: "Invalid cursor" }, 400);
  const rows = await listProjectComments(createDb(c.env.DB), projectId, { limit: parsed.data.limit ?? MAX_LIMIT, before: cursor ? { createdAt: new Date(cursor.createdAt), id: cursor.id } : null });
  const oldest = rows.at(-1)?.comment;
  return c.json({ project: access, comments: rows.map(serializeProjectComment), ...(oldest && rows.length === (parsed.data.limit ?? MAX_LIMIT) ? { nextCursor: encodeCursor(oldest) } : {}) });
});

projectCommentsRoutes.post("/projects/:projectId/comments", async (c) => {
  const projectId = c.req.param("projectId"); if (!projectIdSchema.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  const access = await ensureProjectAccessAndExists(c, projectId); if (access === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (!access) return c.json({ error: "Project not found" }, 404);
  const data = await jsonInput(c, commentInput); if (data instanceof Response) return data;
  const prepared = await normalizedContent(c.env, projectId, data.content); if (!prepared) return c.json({ error: "Invalid comment content or mention target" }, 400);
  const db = createDb(c.env.DB); const currentUser = c.get("user"); const id = newId(); const createdAt = new Date();
  const mentions = prepared.mentionIds.map((mentionedUserId) => ({ id: newId(), commentId: id, mentionedUserId, createdAt }));
  const result = await createProjectComment(c.env.DB, { id, projectId, authorId: currentUser.id, body: prepared.body, contentJson: JSON.stringify(prepared.content), mentions, wallClockMs: createdAt.getTime(), occurredAt: createdAt });
  await audit(c.env, currentUser.id, "project_comment.create", "project_comment", id);
  await notifyMentions(c.env, { scope: "project-comment", projectId, projectStreet: access.street, actorId: currentUser.id, authorName: currentUser.name, body: prepared.body, mentions });
  return c.json(serializeProjectComment(result.comment), 201);
});

projectCommentsRoutes.patch("/projects/:projectId/comments/:commentId", async (c) => {
  const projectId = c.req.param("projectId"); const commentId = c.req.param("commentId"); if (!projectIdSchema.safeParse(projectId).success || !projectIdSchema.safeParse(commentId).success) return c.json({ error: "Invalid project or comment id" }, 400);
  const access = await ensureProjectAccessAndExists(c, projectId); if (access === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (!access) return c.json({ error: "Project not found" }, 404);
  const data = await jsonInput(c, commentInput); if (data instanceof Response) return data;
  const db = createDb(c.env.DB); const existing = await findProjectComment(db, projectId, commentId); if (!existing) return c.json({ error: "Comment not found" }, 404);
  const currentUser = c.get("user"); if (existing.comment.authorId !== currentUser.id) return c.json({ error: "Forbidden: only the author can edit this comment." }, 403);
  const prepared = await normalizedContent(c.env, projectId, data.content); if (!prepared) return c.json({ error: "Invalid comment content or mention target" }, 400);
  const maps = await db.select().from(schema.projectCommentMentions).where(eq(schema.projectCommentMentions.commentId, commentId)).all(); const wanted = new Set(prepared.mentionIds); const existingIds = new Set(maps.map((map) => map.mentionedUserId)); const createdAt = new Date();
  const added = prepared.mentionIds.filter((mentionedUserId) => !existingIds.has(mentionedUserId)).map((mentionedUserId) => ({ id: newId(), commentId, mentionedUserId, createdAt }));
  const result = await editProjectComment(c.env.DB, { projectId, commentId, actorId: currentUser.id, body: prepared.body, contentJson: JSON.stringify(prepared.content), removeMentionIds: maps.filter((map) => !wanted.has(map.mentionedUserId)).map((map) => map.id), addMentions: added, editedAt: createdAt, occurredAt: createdAt });
  await audit(c.env, currentUser.id, "project_comment.edit", "project_comment", commentId);
  await notifyMentions(c.env, { scope: "project-comment", projectId, projectStreet: access.street, actorId: currentUser.id, authorName: currentUser.name, body: prepared.body, mentions: added });
  return c.json(serializeProjectComment(result.comment));
});

projectCommentsRoutes.delete("/projects/:projectId/comments/:commentId", async (c) => {
  const projectId = c.req.param("projectId"); const commentId = c.req.param("commentId"); if (!projectIdSchema.safeParse(projectId).success || !projectIdSchema.safeParse(commentId).success) return c.json({ error: "Invalid project or comment id" }, 400);
  const access = await ensureProjectAccessAndExists(c, projectId); if (access === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (!access) return c.json({ error: "Project not found" }, 404);
  const db = createDb(c.env.DB); const existing = await findProjectComment(db, projectId, commentId); if (!existing) return c.json({ error: "Comment not found" }, 404);
  const currentUser = c.get("user"); if (existing.comment.authorId !== currentUser.id) return c.json({ error: "Forbidden: only the author can delete this comment." }, 403);
  await deleteProjectComment(c.env.DB, { projectId, commentId, actorId: currentUser.id, occurredAt: new Date() });
  await audit(c.env, currentUser.id, "project_comment.delete", "project_comment", commentId);
  return c.json({ ok: true });
});

const readMarkerInput = z.object({ throughCommentId: z.string().uuid() }).strict();

projectCommentsRoutes.get("/projects/:projectId/comment-read-marker", async (c) => {
  const projectId = c.req.param("projectId"); if (!projectIdSchema.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  const access = await ensureProjectAccessAndExists(c, projectId); if (access === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (!access) return c.json({ error: "Project not found" }, 404);
  return c.json(await getProjectCommentReadState(c.env.DB, c.get("user").id, projectId));
});

projectCommentsRoutes.patch("/projects/:projectId/comment-read-marker", async (c) => {
  const projectId = c.req.param("projectId"); if (!projectIdSchema.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  const access = await ensureProjectAccessAndExists(c, projectId); if (access === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (!access) return c.json({ error: "Project not found" }, 404);
  const data = await jsonInput(c, readMarkerInput); if (data instanceof Response) return data;
  const result = await advanceProjectCommentReadMarker(c.env.DB, c.get("user").id, projectId, data.throughCommentId);
  if (!result.targetExists) return c.json({ error: "Comment read target changed.", code: "comment_read_target_changed" }, 409);
  return c.json(result.state);
});
