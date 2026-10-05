import { Hono } from "hono";
import type { Context } from "hono";
import { terminalRoute } from "../lib/terminal-route";
import { createDb, schema } from "@quincy/db";
import {
  EMBEDDED_HEIC_CONTENT_TYPES, EMBEDDED_IMAGE_CONTENT_TYPES, EMBEDDED_MEDIA_MAX_BYTES, NOTICE_BODY_MAX_LENGTH, NOTICE_RICH_TEXT_JSON_MAX_BYTES, NOTICE_RICH_TEXT_PROFILE, externalEmbeddedMediaCompleteSchema, externalEmbeddedMediaPresignSchema,
  enqueueEmbeddedDisplaySafely, isEmbeddedHeicContentType, noticeEmbeddedMediaObjectKey, richTextDocByteLength, legacyBodyToRichTextDoc, linkPreviewRequestSchema, linkPreviewResponseSchema, normalizeRichTextMentionLabels, parseRichTextDoc, richTextLinkPreviewIds, richTextMediaIds, richTextMentionIds, richTextPlainText, type RichTextDoc,
} from "@quincy/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCapability } from "../middleware/capability";
import { audit } from "../lib/audit";
import { newId } from "../lib/ids";
import { notifyNoticeBoardMentions } from "../lib/notifications";
import { NoticeBoardMediaConflictError, createNoticeBoardPost, deleteNoticeBoardPost, editNoticeBoardPost } from "../lib/notice-board-service";
import { enqueueEmbeddedMediaCleanup, getEmbeddedMedia, preflightOwnedMedia, purgeDetachedOwnerMedia, verifyUploadedEmbeddedObject } from "../lib/embedded-media";
import { abortMultipart, createMultipartPresign } from "../lib/r2s3";
import { heicGate, isHeicRow, renditionStatusResponse, retryRendition } from "../lib/embedded-heic";
import { advanceNoticeBoardReadMarker, getNoticeBoardReadState, type NoticeBoardReadState } from "../lib/notice-board-read-state";
import { requestLinkPreview, fillLinkPreviews, preflightLinkPreviews } from "../lib/link-previews";
import { jsonInput } from "./helpers";
import { ownHosts } from "./link-previews";

const optionalQuery = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((value) => value === "" ? undefined : value, schema.optional());
const postsQuery = z.object({ limit: optionalQuery(z.coerce.number().int().min(1).max(50)) });
const postInput = z.object({ content: z.unknown() });
const postId = z.string().uuid();
const mediaPresignInput = z.object({ contentType: z.enum([...EMBEDDED_IMAGE_CONTENT_TYPES, ...EMBEDDED_HEIC_CONTENT_TYPES]), bytes: z.number().int().min(1).max(EMBEDDED_MEDIA_MAX_BYTES) }).strict();
const mediaCompleteInput = z.object({ parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) }).strict()).optional() }).strict();

export type NoticePost = { id: string; authorId: string; authorName: string; body: string; content: RichTextDoc; createdAt: string; editedAt: string | null };
type NoticeBoardMutationResponse = { post: NoticePost; readState: NoticeBoardReadState };

function storedContent(contentJson: string | null, body: string): RichTextDoc {
  if (!contentJson) return legacyBodyToRichTextDoc(body);
  // The READ path must use the notice profile too: a parse failure falls back to the plain-text
  // legacy document, so a comment-profile read would silently flatten every table notice (#492).
  try { return parseRichTextDoc(JSON.parse(contentJson), NOTICE_RICH_TEXT_PROFILE); }
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

async function normalizedContent(db: ReturnType<typeof createDb>, input: unknown): Promise<{ content: RichTextDoc; body: string; mentionIds: string[]; mediaIds: string[]; previewIds: string[] } | null> {
  let parsed: RichTextDoc;
  try { parsed = parseRichTextDoc(input, NOTICE_RICH_TEXT_PROFILE); } catch { return null; }
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
  // Re-check the byte cap here: a label rewritten to the current name can be longer than the one sent.
  if (!body || body.length > NOTICE_BODY_MAX_LENGTH || richTextDocByteLength(content) > NOTICE_RICH_TEXT_JSON_MAX_BYTES) return null;
  return { content, body, mentionIds, mediaIds: richTextMediaIds(content), previewIds: richTextLinkPreviewIds(content) };
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
  return c.json({ posts: await fillLinkPreviews(c.env.DB, rows.map(serializePost)) });
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
  if (!await preflightOwnedMedia(c.env.DB, { ownerKind: "notice_post", ownerId: id, projectId: null, uploaderId: user.id, ids: prepared.mediaIds })) return c.json({ error: "An image in this notice is unavailable.", code: "invalid_media" }, 400);
  if (!await preflightLinkPreviews(c.env.DB, { ownerKind: "notice_post", ownerId: id, projectId: null, requesterId: user.id, ids: prepared.previewIds })) return c.json({ error: "A link preview in this notice is unavailable.", code: "invalid_link_preview" }, 400);
  try { await createNoticeBoardPost(c.env.DB, { id, authorId: user.id, body: prepared.body, contentJson: JSON.stringify(prepared.content), mentions, wallClockMs, media: { authorId: user.id, ids: prepared.mediaIds, previewIds: prepared.previewIds } }); }
  catch (error) { if (error instanceof NoticeBoardMediaConflictError) return c.json({ error: "An image in this notice is no longer available. Remove it and try again.", code: "media_conflict" }, 409); throw error; }
  await audit(c.env, user, "notice_board.post", "notice_board_post", id);
  await notifyNoticeBoardMentions(c.env, { actorId: user.id, authorName: user.name, body: prepared.body, mentions });
  const post = await findPost(db, id);
  if (!post) return c.json({ error: "Post could not be created" }, 500);
  const readState = await getNoticeBoardReadState(c.env.DB, user.id);
  const [filled] = await fillLinkPreviews(c.env.DB, [serializePost(post)]);
  return c.json({ post: filled!, readState } satisfies NoticeBoardMutationResponse, 201);
}));

noticeBoardRoutes.patch("/notice-board/posts/:id", terminalRoute("/notice-board/posts/:id", async (c) => {
  const id = c.req.param("id"); if (!postId.safeParse(id).success) return c.json({ error: "Invalid post id" }, 400);
  const data = await jsonInput(c, postInput); if (data instanceof Response) return data;
  const db = createDb(c.env.DB); const existing = await db.select().from(schema.noticeBoardPosts).where(eq(schema.noticeBoardPosts.id, id)).get();
  if (!existing) return c.json({ error: "Post not found" }, 404);
  const user = c.get("user");
  // An impersonated Admin intentionally acts as the effective author here — see the
  // impersonation caveat on this rule in AGENTS.md.
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
  if (!await preflightOwnedMedia(c.env.DB, { ownerKind: "notice_post", ownerId: id, projectId: null, uploaderId: user.id, ids: prepared.mediaIds })) return c.json({ error: "An image in this notice is unavailable.", code: "invalid_media" }, 400);
  if (!await preflightLinkPreviews(c.env.DB, { ownerKind: "notice_post", ownerId: id, projectId: null, requesterId: user.id, ids: prepared.previewIds })) return c.json({ error: "A link preview in this notice is unavailable.", code: "invalid_link_preview" }, 400);
  let edited: Awaited<ReturnType<typeof editNoticeBoardPost>>;
  try { edited = await editNoticeBoardPost(c.env.DB, { id, authorId: user.id, body: prepared.body, contentJson: JSON.stringify(prepared.content), editedAt: createdAt, removeMentionIds: removed.map((map) => map.id), addMentions: added, media: { authorId: user.id, ids: prepared.mediaIds, previewIds: prepared.previewIds } }); }
  catch (error) { if (error instanceof NoticeBoardMediaConflictError) return c.json({ error: "An image in this notice is no longer available. Remove it and try again.", code: "media_conflict" }, 409); throw error; }
  if (!edited.updated) return c.json({ error: "Post not found" }, 404);
  await audit(c.env, user, "notice_board.edit", "notice_board_post", id);
  await notifyNoticeBoardMentions(c.env, { actorId: user.id, authorName: user.name, body: prepared.body, mentions: added });
  const post = await findPost(db, id);
  if (!post) return c.json({ error: "Post could not be updated" }, 500);
  const readState = await getNoticeBoardReadState(c.env.DB, user.id);
  const [filled] = await fillLinkPreviews(c.env.DB, [serializePost(post)]);
  return c.json({ post: filled!, readState } satisfies NoticeBoardMutationResponse);
}));

noticeBoardRoutes.delete("/notice-board/posts/:id", terminalRoute("/notice-board/posts/:id", async (c) => {
  const id = c.req.param("id"); if (!postId.safeParse(id).success) return c.json({ error: "Invalid post id" }, 400);
  const db = createDb(c.env.DB); const post = await db.select().from(schema.noticeBoardPosts).where(eq(schema.noticeBoardPosts.id, id)).get();
  if (!post) return c.json({ error: "Post not found" }, 404);
  const user = c.get("user");
  // An impersonated Admin intentionally acts as the effective author here — see the
  // impersonation caveat on this rule in AGENTS.md.
  if (post.authorId !== user.id) return c.json({ error: "Forbidden: only the author can delete this post." }, 403);
  if (!await deleteNoticeBoardPost(c.env.DB, { id, authorId: user.id })) return c.json({ error: "Post not found" }, 404);
  await audit(c.env, user, "notice_board.delete", "notice_board_post", id);
  // The batch left the post's media detached and due now: delete the objects, then the rows, best effort. The daily sweep is the backstop (#496).
  await purgeDetachedOwnerMedia(c.env, "notice_post", id);
  return c.json({ ok: true });
}));

/**
 * Embedded media on the Notice board (#496). Registered here, beside the posts, so the `/notice-board/*` capability gate above
 * covers every one of them. The object lives under a Notice-board prefix and is owned by its post through the D1 row.
 */
const mediaUuid = z.string().uuid();
const mediaStray = (c: Context<AppEnv>) => c.json({ error: "Media upload not found" }, 404);

noticeBoardRoutes.post("/notice-board/embedded-media", terminalRoute("/notice-board/embedded-media", async (c) => {
  const data = await jsonInput(c, mediaPresignInput); if (data instanceof Response) return data;
  // HEIC (#495): an Admin only until the owner turns the flag on, and refused loudly when renditions are off.
  const heic = isEmbeddedHeicContentType(data.contentType);
  if (heic) { const refused = await heicGate(c); if (refused) return refused; }
  const user = c.get("user"); const mediaId = newId(); const key = noticeEmbeddedMediaObjectKey(mediaId); const now = Date.now();
  await c.env.DB.prepare(`
    INSERT INTO embedded_media (id, owner_kind, owner_id, project_id, uploader_id, kind, content_type, bytes, original_key, state, created_at, updated_at, rendition_status)
    VALUES (?, 'notice_post', NULL, NULL, ?, 'image', ?, ?, ?, 'uploading', ?, ?, ?)
  `).bind(mediaId, user.id, data.contentType, data.bytes, key, now, now, heic ? "pending" : "not_required").run();
  const release = () => c.env.DB.prepare("DELETE FROM embedded_media WHERE id = ? AND state = 'uploading'").bind(mediaId).run();
  let multipart: Awaited<ReturnType<typeof createMultipartPresign>>;
  try { multipart = await createMultipartPresign(c.env, key, data.bytes, data.contentType); }
  catch (error) { await release(); throw error; }
  if (!multipart) {
    // Dev has no R2 S3 credentials: steer the browser to the direct-PUT route (Miniflare R2).
    if (c.env.APP_ENV === "dev") return c.json(externalEmbeddedMediaPresignSchema.parse({ mediaId, devDirect: true }));
    await release();
    return c.json({ error: "R2 S3 upload credentials are not configured" }, 503);
  }
  // A sweep claim may have taken the reservation while R2 was starting the upload: then no URLs go out.
  const stored = await c.env.DB.prepare("UPDATE embedded_media SET upload_id = ? WHERE id = ? AND state = 'uploading'").bind(multipart.uploadId, mediaId).run();
  if ((stored.meta.changes ?? 0) !== 1) {
    try { await abortMultipart(c.env, key, multipart.uploadId); } catch { await enqueueEmbeddedMediaCleanup(c.env.DB, [{ key, uploadId: multipart.uploadId, projectId: null }]); }
    await release();
    return c.json({ error: "This upload can no longer be accepted", code: "media_unavailable" }, 409);
  }
  await audit(c.env, user, "embedded_media.presign", "embedded_media", mediaId, { scope: "notice_board", bytes: data.bytes, contentType: data.contentType });
  return c.json(externalEmbeddedMediaPresignSchema.parse({ mediaId, uploadId: multipart.uploadId, partUrls: multipart.partUrls, partBytes: multipart.partBytes }));
}));

noticeBoardRoutes.put("/notice-board/embedded-media/:mediaId/direct", terminalRoute("/notice-board/embedded-media/:mediaId/direct", async (c) => {
  if (c.env.APP_ENV !== "dev") return c.json({ error: "Direct uploads are available only in dev" }, 404);
  const mediaId = c.req.param("mediaId"); if (!mediaUuid.safeParse(mediaId).success) return c.json({ error: "Invalid media upload" }, 400);
  const row = await getEmbeddedMedia(c.env.DB, mediaId);
  if (!row || row.ownerKind !== "notice_post" || row.uploaderId !== c.get("user").id || row.state !== "uploading") return c.json({ error: "Media upload is unavailable" }, 404);
  await c.env.MEDIA.put(row.originalKey, c.req.raw.body, { httpMetadata: { contentType: row.contentType } });
  return c.body(null, 204);
}));

noticeBoardRoutes.post("/notice-board/embedded-media/:mediaId/complete", terminalRoute("/notice-board/embedded-media/:mediaId/complete", async (c) => {
  const mediaId = c.req.param("mediaId"); if (!mediaUuid.safeParse(mediaId).success) return c.json({ error: "Invalid media upload" }, 400);
  const data = await jsonInput(c, mediaCompleteInput); if (data instanceof Response) return data;
  const user = c.get("user"); const row = await getEmbeddedMedia(c.env.DB, mediaId);
  // A row that is gone is not ours to clean up: a sweep claim queued its own keys. R2 is touched only after this route claims the row itself.
  if (!row || row.ownerKind !== "notice_post" || row.uploaderId !== user.id) return mediaStray(c);
  const heic = isHeicRow(row);
  if (heic) { const refused = await heicGate(c); if (refused) return refused; }
  const completed = (rendition: string) => c.json(externalEmbeddedMediaCompleteSchema.parse({ mediaId, state: "pending", ...(heic ? { rendition } : {}) }));
  if (row.state === "pending") return completed(row.renditionStatus);
  if (row.state !== "uploading") return c.json({ error: "This media is already in use", code: "media_not_uploading" }, 409);
  const verdict = await verifyUploadedEmbeddedObject(c.env, row, data.parts);
  if (!verdict.ok) return c.json(verdict.body, verdict.status);
  const promotedAt = Date.now();
  const promoted = await c.env.DB.prepare("UPDATE embedded_media SET state = 'pending', updated_at = ?, rendition_requested_at = CASE WHEN rendition_status = 'pending' THEN ? ELSE NULL END WHERE id = ? AND state = 'uploading'").bind(promotedAt, promotedAt, mediaId).run();
  if ((promoted.meta.changes ?? 0) !== 1) {
    const current = await getEmbeddedMedia(c.env.DB, mediaId);
    if (!current) return mediaStray(c);
    if (current.state !== "pending") return c.json({ error: "This media is already in use", code: "media_not_uploading" }, 409);
  } else {
    await audit(c.env, user, "embedded_media.upload", "embedded_media", mediaId, { scope: "notice_board", bytes: row.bytes, contentType: row.contentType });
    if (heic) await enqueueEmbeddedDisplaySafely(c.env, mediaId, "complete", promotedAt);
  }
  return completed("pending");
}));

/** The uploader's view of a HEIC image's display copy (#495), and its retry. Uploader-only: the composer polls it before the image can go in a post. */
const ownNoticeRenditionRow = async (c: Context<AppEnv>, mediaId: string) => {
  if (!mediaUuid.safeParse(mediaId).success) return c.json({ error: "Invalid media upload" }, 400);
  const row = await getEmbeddedMedia(c.env.DB, mediaId);
  if (!row || row.ownerKind !== "notice_post" || row.uploaderId !== c.get("user").id || row.kind !== "image" || row.state === "uploading") return mediaStray(c);
  return row;
};
noticeBoardRoutes.get("/notice-board/embedded-media/:mediaId/rendition", terminalRoute("/notice-board/embedded-media/:mediaId/rendition", async (c) => {
  const row = await ownNoticeRenditionRow(c, c.req.param("mediaId")); if (row instanceof Response) return row;
  return renditionStatusResponse(c, row);
}));
noticeBoardRoutes.post("/notice-board/embedded-media/:mediaId/rendition/retry", terminalRoute("/notice-board/embedded-media/:mediaId/rendition/retry", async (c) => {
  const row = await ownNoticeRenditionRow(c, c.req.param("mediaId")); if (row instanceof Response) return row;
  return retryRendition(c, row);
}));

/** Link previews on the Notice board (#497). Registered here, beside the posts, so the `/notice-board/*` capability gate covers it: an External editor gets 403. */
noticeBoardRoutes.post("/notice-board/link-previews", terminalRoute("/notice-board/link-previews", async (c) => {
  const data = await jsonInput(c, linkPreviewRequestSchema); if (data instanceof Response) return data;
  const result = await requestLinkPreview(c.env, c.get("user"), { ownerKind: "notice_post", projectId: null }, data.url, ownHosts(c));
  return result.status === 200 ? c.json(linkPreviewResponseSchema.parse(result.body)) : c.json(result.body, result.status);
}));
