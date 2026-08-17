import { Hono } from "hono";
import { createDb, schema } from "@quincy/db";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { normalizeRichTextMentionLabels, parseRichTextDoc, richTextMentionIds, richTextPlainText, type RichTextDoc } from "@quincy/shared";
import { z } from "zod";
import type { AppEnv } from "../env";
import { hasProjectCollaborationAccess } from "../middleware/capability";
import { audit } from "../lib/audit";
import { newId } from "../lib/ids";
import { notifyMentions } from "../lib/notifications";
import { projectMentionableUsers } from "../lib/project-collaboration";
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

function serializeComment(row: { comment: typeof schema.projectComments.$inferSelect; authorId: string; authorName: string }) {
  return { id: row.comment.id, author: { id: row.authorId, name: row.authorName }, body: row.comment.body, content: JSON.parse(row.comment.contentJson) as RichTextDoc, createdAt: row.comment.createdAt.toISOString(), editedAt: row.comment.editedAt?.toISOString() ?? null };
}

async function findComment(db: ReturnType<typeof createDb>, projectId: string, commentId: string) {
  return db.select({ comment: schema.projectComments, authorId: schema.user.id, authorName: schema.user.name }).from(schema.projectComments)
    .innerJoin(schema.user, eq(schema.projectComments.authorId, schema.user.id))
    .where(and(eq(schema.projectComments.id, commentId), eq(schema.projectComments.projectId, projectId))).get();
}

export const projectCommentsRoutes = new Hono<AppEnv>();

projectCommentsRoutes.get("/projects/:projectId/comments", async (c) => {
  const projectId = c.req.param("projectId"); if (!projectIdSchema.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  const parsed = listInput.safeParse(c.req.query()); if (!parsed.success) return c.json({ error: "Invalid query", details: parsed.error.flatten() }, 400);
  const access = await ensureProjectAccessAndExists(c, projectId); if (access === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (!access) return c.json({ error: "Project not found" }, 404);
  const cursor = parsed.data.before ? parseCursor(parsed.data.before) : null; if (parsed.data.before && !cursor) return c.json({ error: "Invalid cursor" }, 400);
  const db = createDb(c.env.DB); const before = cursor ? new Date(cursor.createdAt) : null;
  const rows = await db.select({ comment: schema.projectComments, authorId: schema.user.id, authorName: schema.user.name }).from(schema.projectComments)
    .innerJoin(schema.user, eq(schema.projectComments.authorId, schema.user.id))
    .where(and(eq(schema.projectComments.projectId, projectId), cursor ? or(lt(schema.projectComments.createdAt, before!), and(eq(schema.projectComments.createdAt, before!), lt(schema.projectComments.id, cursor.id))) : undefined))
    .orderBy(desc(schema.projectComments.createdAt), desc(schema.projectComments.id)).limit(parsed.data.limit ?? MAX_LIMIT).all();
  const oldest = rows.at(-1)?.comment;
  return c.json({ project: access, comments: rows.map(serializeComment), ...(oldest && rows.length === (parsed.data.limit ?? MAX_LIMIT) ? { nextCursor: encodeCursor(oldest) } : {}) });
});

projectCommentsRoutes.post("/projects/:projectId/comments", async (c) => {
  const projectId = c.req.param("projectId"); if (!projectIdSchema.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  const access = await ensureProjectAccessAndExists(c, projectId); if (access === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (!access) return c.json({ error: "Project not found" }, 404);
  const data = await jsonInput(c, commentInput); if (data instanceof Response) return data;
  const prepared = await normalizedContent(c.env, projectId, data.content); if (!prepared) return c.json({ error: "Invalid comment content or mention target" }, 400);
  const db = createDb(c.env.DB); const currentUser = c.get("user"); const id = newId(); const createdAt = new Date();
  const mentions = prepared.mentionIds.map((mentionedUserId) => ({ id: newId(), commentId: id, mentionedUserId, createdAt }));
  await db.batch([db.insert(schema.projectComments).values({ id, projectId, authorId: currentUser.id, body: prepared.body, contentJson: JSON.stringify(prepared.content), createdAt }), ...mentions.map((mention) => db.insert(schema.projectCommentMentions).values(mention))] as [never, ...never[]]);
  await audit(c.env, currentUser.id, "project_comment.create", "project_comment", id);
  await notifyMentions(c.env, { scope: "project-comment", projectId, actorId: currentUser.id, mentions });
  const comment = await findComment(db, projectId, id); if (!comment) return c.json({ error: "Comment could not be created" }, 500);
  return c.json(serializeComment(comment), 201);
});

projectCommentsRoutes.patch("/projects/:projectId/comments/:commentId", async (c) => {
  const projectId = c.req.param("projectId"); const commentId = c.req.param("commentId"); if (!projectIdSchema.safeParse(projectId).success || !projectIdSchema.safeParse(commentId).success) return c.json({ error: "Invalid project or comment id" }, 400);
  const access = await ensureProjectAccessAndExists(c, projectId); if (access === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (!access) return c.json({ error: "Project not found" }, 404);
  const data = await jsonInput(c, commentInput); if (data instanceof Response) return data;
  const db = createDb(c.env.DB); const existing = await findComment(db, projectId, commentId); if (!existing) return c.json({ error: "Comment not found" }, 404);
  const currentUser = c.get("user"); if (existing.comment.authorId !== currentUser.id) return c.json({ error: "Forbidden: only the author can edit this comment." }, 403);
  const prepared = await normalizedContent(c.env, projectId, data.content); if (!prepared) return c.json({ error: "Invalid comment content or mention target" }, 400);
  const maps = await db.select().from(schema.projectCommentMentions).where(eq(schema.projectCommentMentions.commentId, commentId)).all(); const wanted = new Set(prepared.mentionIds); const existingIds = new Set(maps.map((map) => map.mentionedUserId)); const createdAt = new Date();
  const added = prepared.mentionIds.filter((mentionedUserId) => !existingIds.has(mentionedUserId)).map((mentionedUserId) => ({ id: newId(), commentId, mentionedUserId, createdAt }));
  await db.batch([db.update(schema.projectComments).set({ body: prepared.body, contentJson: JSON.stringify(prepared.content), editedAt: createdAt }).where(eq(schema.projectComments.id, commentId)), ...maps.filter((map) => !wanted.has(map.mentionedUserId)).map((map) => db.delete(schema.projectCommentMentions).where(eq(schema.projectCommentMentions.id, map.id))), ...added.map((map) => db.insert(schema.projectCommentMentions).values(map))] as [never, ...never[]]);
  await audit(c.env, currentUser.id, "project_comment.edit", "project_comment", commentId);
  await notifyMentions(c.env, { scope: "project-comment", projectId, actorId: currentUser.id, mentions: added });
  const comment = await findComment(db, projectId, commentId); if (!comment) return c.json({ error: "Comment could not be updated" }, 500);
  return c.json(serializeComment(comment));
});

projectCommentsRoutes.delete("/projects/:projectId/comments/:commentId", async (c) => {
  const projectId = c.req.param("projectId"); const commentId = c.req.param("commentId"); if (!projectIdSchema.safeParse(projectId).success || !projectIdSchema.safeParse(commentId).success) return c.json({ error: "Invalid project or comment id" }, 400);
  const access = await ensureProjectAccessAndExists(c, projectId); if (access === "forbidden") return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (!access) return c.json({ error: "Project not found" }, 404);
  const db = createDb(c.env.DB); const existing = await findComment(db, projectId, commentId); if (!existing) return c.json({ error: "Comment not found" }, 404);
  const currentUser = c.get("user"); if (existing.comment.authorId !== currentUser.id) return c.json({ error: "Forbidden: only the author can delete this comment." }, 403);
  await db.delete(schema.projectComments).where(and(eq(schema.projectComments.id, commentId), eq(schema.projectComments.projectId, projectId)));
  await audit(c.env, currentUser.id, "project_comment.delete", "project_comment", commentId);
  return c.json({ ok: true });
});
