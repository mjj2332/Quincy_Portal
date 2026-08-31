import { Hono } from "hono";
import type { Context } from "hono";
import { terminalRoute } from "../lib/terminal-route";
import { createDb, schema } from "@quincy/db";
import { legacyBodyToRichTextDoc, normalizeRichTextMentionLabels, parseRichTextDoc, richTextMentionIds, richTextPlainText, type RichTextDoc } from "@quincy/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCapability } from "../middleware/capability";
import { audit } from "../lib/audit";
import { newId } from "../lib/ids";
import { notifyNoticeBoardMentions } from "../lib/notifications";
import { createNoticeBoardPost } from "../lib/notice-board-service";
import { advanceNoticeBoardReadMarker, getNoticeBoardReadState, type NoticeBoardReadState } from "../lib/notice-board-read-state";
import { jsonInput } from "./helpers";

const optionalQuery = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((value) => value === "" ? undefined : value, schema.optional());
const postsQuery = z.object({ limit: optionalQuery(z.coerce.number().int().min(1).max(50)) });
const postInput = z.object({ content: z.unknown() });
const postId = z.string().uuid();
const NOTICE_BODY_MAX_LENGTH = 2_000;

export type NoticePost = { id: string; authorId: string; authorName: string; body: string; content: RichTextDoc; createdAt: string; editedAt: string | null };
type NoticeBoardMutationResponse = { post: NoticePost; readState: NoticeBoardReadState };

function storedContent(contentJson: string | null, body: string): RichTextDoc {
  if (!contentJson) return legacyBodyToRichTextDoc(body);
  try { return parseRichTextDoc(JSON.parse(contentJson)); }
  catch { return legacyBodyToRichTextDoc(body); }
}

function serializePost(row: { post: typeof schema.noticeBoardPosts.$inferSelect; authorName: string }): NoticePost {
  return {
    id: row.post.id,
    authorId: row.post.authorId,
    authorName: row.authorName,
    body: row.post.body,
    content: storedContent(row.post.contentJson, row.post.body),
    createdAt: row.post.createdAt.toISOString(),
    editedAt: row.post.editedAt?.toISOString() ?? null,
  };
}

async function findPost(db: ReturnType<typeof createDb>, id: string) {
  return db.select({ post: schema.noticeBoardPosts, authorName: schema.user.name })
    .from(schema.noticeBoardPosts).innerJoin(schema.user, eq(schema.noticeBoardPosts.authorId, schema.user.id))
    .where(eq(schema.noticeBoardPosts.id, id)).get();
}

async function normalizedContent(db: ReturnType<typeof createDb>, input: unknown): Promise<{ content: RichTextDoc; body: string; mentionIds: string[] } | null> {
  let parsed: RichTextDoc;
  try { parsed = parseRichTextDoc(input); } catch { return null; }
  const mentionIds = richTextMentionIds(parsed);
  const eligible = mentionIds.length
    ? await db.select({ id: schema.user.id, name: schema.user.name }).from(schema.user)
      .where(and(inArray(schema.user.id, mentionIds), eq(schema.user.active, true))).all()
    : [];
  if (eligible.length !== mentionIds.length) return null;
  let content: RichTextDoc;
  try { content = normalizeRichTextMentionLabels(parsed, new Map(eligible.map((target) => [target.id, target.name]))); }
  catch { return null; }
  const body = richTextPlainText(content).trim();
  if (!body || body.length > NOTICE_BODY_MAX_LENGTH) return null;
  return { content, body, mentionIds };
}

export const noticeBoardRoutes = new Hono<AppEnv>();
noticeBoardRoutes.use("/notice-board", requireCapability("viewNoticeBoard"));
noticeBoardRoutes.use("/notice-board/*", requireCapability("viewNoticeBoard"));

const readMarkerInput = z.object({ throughPostId: z.string().uuid() }).strict();

async function getReadMarker(c: Context<AppEnv>) {
  return c.json(await getNoticeBoardReadState(c.env.DB, c.get("user").id));
}

async function patchReadMarker(c: Context<AppEnv>) {
  const data = await jsonInput(c, readMarkerInput); if (data instanceof Response) return data;
  const result = await advanceNoticeBoardReadMarker(c.env.DB, c.get("user").id, data.throughPostId);
  if (!result.targetExists) return c.json({ error: "Notice board read target changed.", code: "notice_board_read_target_changed" }, 409);
  return c.json(result.state);
}

noticeBoardRoutes.get("/notice-board/read-marker", terminalRoute("/notice-board/read-marker", getReadMarker));
noticeBoardRoutes.get("/notice-board/read-marker/", terminalRoute("/notice-board/read-marker/", getReadMarker));
noticeBoardRoutes.patch("/notice-board/read-marker", terminalRoute("/notice-board/read-marker", patchReadMarker));
noticeBoardRoutes.patch("/notice-board/read-marker/", terminalRoute("/notice-board/read-marker/", patchReadMarker));

noticeBoardRoutes.get("/notice-board/posts", terminalRoute("/notice-board/posts", async (c) => {
  const parsed = postsQuery.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "Invalid query", details: parsed.error.flatten() }, 400);
  const rows = await createDb(c.env.DB).select({ post: schema.noticeBoardPosts, authorName: schema.user.name })
    .from(schema.noticeBoardPosts).innerJoin(schema.user, eq(schema.noticeBoardPosts.authorId, schema.user.id))
    .orderBy(desc(schema.noticeBoardPosts.createdAt), desc(schema.noticeBoardPosts.id)).limit(parsed.data.limit ?? 50).all();
  return c.json({ posts: rows.map(serializePost) });
}));

noticeBoardRoutes.get("/notice-board/posts/latest", terminalRoute("/notice-board/posts/latest", async (c) => {
  const post = await createDb(c.env.DB).select({ id: schema.noticeBoardPosts.id, createdAt: schema.noticeBoardPosts.createdAt })
    .from(schema.noticeBoardPosts).orderBy(desc(schema.noticeBoardPosts.createdAt), desc(schema.noticeBoardPosts.id)).limit(1).get();
  return c.json({ id: post?.id ?? null, createdAt: post?.createdAt.toISOString() ?? null });
}));

noticeBoardRoutes.post("/notice-board/posts", terminalRoute("/notice-board/posts", async (c) => {
  const data = await jsonInput(c, postInput); if (data instanceof Response) return data;
  const db = createDb(c.env.DB); const prepared = await normalizedContent(db, data.content);
  if (!prepared) return c.json({ error: "Invalid notice content or mention target" }, 400);
  const id = newId(); const wallClockMs = Date.now(); const createdAt = new Date(wallClockMs); const user = c.get("user");
  const mentions = prepared.mentionIds.map((mentionedUserId) => ({ id: newId(), postId: id, mentionedUserId, createdAt }));
  await createNoticeBoardPost(c.env.DB, { id, authorId: user.id, body: prepared.body, contentJson: JSON.stringify(prepared.content), mentions, wallClockMs });
  await audit(c.env, user, "notice_board.post", "notice_board_post", id);
  await notifyNoticeBoardMentions(c.env, { actorId: user.id, authorName: user.name, body: prepared.body, mentions });
  const post = await findPost(db, id);
  if (!post) return c.json({ error: "Post could not be created" }, 500);
  const readState = await getNoticeBoardReadState(c.env.DB, user.id);
  return c.json({ post: serializePost(post), readState } satisfies NoticeBoardMutationResponse, 201);
}));

noticeBoardRoutes.patch("/notice-board/posts/:id", terminalRoute("/notice-board/posts/:id", async (c) => {
  const id = c.req.param("id"); if (!postId.safeParse(id).success) return c.json({ error: "Invalid post id" }, 400);
  const data = await jsonInput(c, postInput); if (data instanceof Response) return data;
  const db = createDb(c.env.DB); const existing = await db.select().from(schema.noticeBoardPosts).where(eq(schema.noticeBoardPosts.id, id)).get();
  if (!existing) return c.json({ error: "Post not found" }, 404);
  const user = c.get("user");
  // An impersonated Admin intentionally acts as the effective author here — see the
  // impersonation caveat on this rule in CLAUDE.md.
  if (existing.authorId !== user.id) return c.json({ error: "Forbidden: only the author can edit this post." }, 403);
  const prepared = await normalizedContent(db, data.content);
  if (!prepared) return c.json({ error: "Invalid notice content or mention target" }, 400);
  const existingMaps = await db.select().from(schema.noticeBoardPostMentions).where(eq(schema.noticeBoardPostMentions.postId, id)).all();
  const existingIds = new Set(existingMaps.map((map) => map.mentionedUserId));
  const wantedIds = new Set(prepared.mentionIds);
  const removed = existingMaps.filter((map) => !wantedIds.has(map.mentionedUserId));
  const createdAt = new Date();
  const added = prepared.mentionIds.filter((mentionedUserId) => !existingIds.has(mentionedUserId))
    .map((mentionedUserId) => ({ id: newId(), postId: id, mentionedUserId, createdAt }));
  const edits = [
    db.update(schema.noticeBoardPosts).set({ body: prepared.body, contentJson: JSON.stringify(prepared.content), editedAt: createdAt }).where(eq(schema.noticeBoardPosts.id, id)),
    ...removed.map((map) => db.delete(schema.noticeBoardPostMentions).where(eq(schema.noticeBoardPostMentions.id, map.id))),
    ...added.map((map) => db.insert(schema.noticeBoardPostMentions).values(map)),
  ];
  await db.batch(edits as [never, ...never[]]);
  await audit(c.env, user, "notice_board.edit", "notice_board_post", id);
  await notifyNoticeBoardMentions(c.env, { actorId: user.id, authorName: user.name, body: prepared.body, mentions: added });
  const post = await findPost(db, id);
  if (!post) return c.json({ error: "Post could not be updated" }, 500);
  const readState = await getNoticeBoardReadState(c.env.DB, user.id);
  return c.json({ post: serializePost(post), readState } satisfies NoticeBoardMutationResponse);
}));

noticeBoardRoutes.delete("/notice-board/posts/:id", terminalRoute("/notice-board/posts/:id", async (c) => {
  const id = c.req.param("id"); if (!postId.safeParse(id).success) return c.json({ error: "Invalid post id" }, 400);
  const db = createDb(c.env.DB); const post = await db.select().from(schema.noticeBoardPosts).where(eq(schema.noticeBoardPosts.id, id)).get();
  if (!post) return c.json({ error: "Post not found" }, 404);
  const user = c.get("user");
  // An impersonated Admin intentionally acts as the effective author here — see the
  // impersonation caveat on this rule in CLAUDE.md.
  if (post.authorId !== user.id) return c.json({ error: "Forbidden: only the author can delete this post." }, 403);
  await db.delete(schema.noticeBoardPosts).where(eq(schema.noticeBoardPosts.id, id));
  await audit(c.env, user, "notice_board.delete", "notice_board_post", id);
  return c.json({ ok: true });
}));
