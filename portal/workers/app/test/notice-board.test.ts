import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";
import { notifyNoticeBoardMentions } from "../src/lib/notifications";
import { createNoticeBoardPost } from "../src/lib/notice-board-service";
import { advanceNoticeBoardReadMarker, getNoticeBoardReadState } from "../src/lib/notice-board-read-state";

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const adminToken = "notice-board-admin-session-token"; const editorToken = "notice-board-editor-session-token"; const photographerToken = "notice-board-photographer-session-token";
const adminId = "44444444-4444-4444-8444-444444444444"; const editorId = "55555555-5555-4555-8555-555555555555"; const photographerId = "66666666-6666-4666-8666-866666666666";
const inactiveId = "77777777-7777-4777-8777-777777777777"; const externalId = "88888888-8888-4888-8888-888888888888";
const inactiveToken = "notice-board-inactive-session-token"; const externalToken = "notice-board-external-session-token";
declare const __PORTAL_MIGRATION_SQL__: string; declare const __PORTAL_SEED_SQL__: string;

const doc = (content: Array<Record<string, unknown>>) => ({ type: "doc", content: [{ type: "paragraph", content }] });
const textDoc = (text: string) => doc([{ type: "text", text }]);
const markedDoc = (type: "underline" | "strike") => doc([{ type: "text", text: `${type} text`, marks: [{ type }] }]);
const headingDoc = (level: 2 | 3) => ({ type: "doc", content: [{ type: "heading", attrs: { level }, content: [{ type: "text", text: level === 2 ? "Notice section" : "Notice subsection" }] }] });
const taskDoc = (checked: boolean) => ({ type: "doc", content: [{ type: "taskList", content: [{ type: "taskItem", attrs: { checked }, content: [{ type: "paragraph", content: [{ type: "text", text: checked ? "Checked notice" : "Unchecked notice" }] }] }] }] });
const nestedTaskDoc = () => ({ type: "doc", content: [{ type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Outer notice task" }] }, { type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Nested ordinary" }] }, { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Nested task" }] }] }] }] }] }] }] }] });
const malformedHeadingDocs = () => [
  { type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Invalid h1" }] }] },
  { type: "doc", content: [{ type: "heading", attrs: { level: 4 }, content: [{ type: "text", text: "Invalid h4" }] }] },
  { type: "doc", content: [{ type: "heading", attrs: { level: 2, extra: true }, content: [{ type: "text", text: "Extra attributes" }] }] },
  { type: "doc", content: [{ type: "heading", attrs: { level: 3 }, content: [{ type: "paragraph", content: [{ type: "text", text: "Block content" }] }] }] },
];
async function executeSql(sql: string) { for (const chunk of sql.split("--> statement-breakpoint")) for (const statement of chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); } }
async function sessionCookie(token: string) { const context = await createAuth(baseEnv).$context; return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`; }
async function request(path: string, token: string, method: "GET" | "POST" | "PATCH" | "DELETE" = "GET", body?: unknown) {
  const headers = new Headers({ cookie: await sessionCookie(token) }); if (body !== undefined) headers.set("content-type", "application/json"); if (method !== "GET") headers.set("origin", baseEnv.APP_ORIGIN);
  return workerSelf.fetch(`https://portal.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__); await executeSql(__PORTAL_SEED_SQL__); const now = Date.now();
  for (const [id, name, email, role, active] of [[adminId, "Notice Admin", "notice-admin@example.test", "admin", 1], [editorId, "Notice Editor", "notice-editor@example.test", "editor", 1], [photographerId, "Notice Photographer", "notice-photographer@example.test", "photographer", 1], [inactiveId, "Notice Inactive", "notice-inactive@example.test", "editor", 0], [externalId, "Notice External", "notice-external@example.test", "external_editor", 1]]) await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)").bind(id, name, email, role, active, now, now).run();
  for (const [id, token, userId] of [["notice-admin-session", adminToken, adminId], ["notice-editor-session", editorToken, editorId], ["notice-photographer-session", photographerToken, photographerId], ["notice-inactive-session", inactiveToken, inactiveId], ["notice-external-session", externalToken, externalId]]) await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, now + 3_600_000, token, userId, now, now).run();
});

describe("notice board API", () => {
  it("returns an empty latest cursor and empty authoritative read state before the first post", async () => {
    expect(await (await request("/api/notice-board/posts/latest", editorToken)).json()).toEqual({ id: null, createdAt: null });
    const bare = await request("/api/notice-board/read-marker", editorToken);
    const slash = await request("/api/notice-board/read-marker/", editorToken);
    expect(bare.status).toBe(200);
    const bareBody = await bare.text();
    const slashBody = await slash.text();
    expect(JSON.parse(bareBody)).toEqual({ marker: null, latest: null, unreadCount: 0 });
    expect(JSON.parse(slashBody)).toEqual({ marker: null, latest: null, unreadCount: 0 });
    expect(bareBody).toBe(slashBody);
  });

  it("gates both read-state methods while allowing every internal Notice Board role", async () => {
    const created = await request("/api/notice-board/posts", editorToken, "POST", { content: textDoc("Read-state target") });
    const target = (await created.json() as { post: { id: string } }).post;
    for (const token of [adminToken, editorToken, photographerToken]) {
      expect((await request("/api/notice-board/read-marker", token)).status).toBe(200);
      expect((await request("/api/notice-board/read-marker/", token)).status).toBe(200);
      const barePatch = await request("/api/notice-board/read-marker", token, "PATCH", { throughPostId: target.id });
      const slashPatch = await request("/api/notice-board/read-marker/", token, "PATCH", { throughPostId: target.id });
      expect(barePatch.status).toBe(200);
      expect(slashPatch.status).toBe(200);
      expect(await barePatch.text()).toBe(await slashPatch.text());
    }
    for (const token of [inactiveToken]) {
      expect((await request("/api/notice-board/read-marker", token)).status).toBe(401);
      expect((await request("/api/notice-board/read-marker/", token)).status).toBe(401);
      expect((await request("/api/notice-board/read-marker", token, "PATCH", { throughPostId: target.id })).status).toBe(401);
      expect((await request("/api/notice-board/read-marker/", token, "PATCH", { throughPostId: target.id })).status).toBe(401);
    }
    for (const token of [externalToken]) {
      expect((await request("/api/notice-board/read-marker", token)).status).toBe(403);
      expect((await request("/api/notice-board/read-marker/", token)).status).toBe(403);
      expect((await request("/api/notice-board/read-marker", token, "PATCH", { throughPostId: target.id })).status).toBe(403);
      expect((await request("/api/notice-board/read-marker/", token, "PATCH", { throughPostId: target.id })).status).toBe(403);
    }
    const noSession = async (path: string, method: "GET" | "PATCH", body?: unknown) => {
      const headers = new Headers(body === undefined ? {} : { "content-type": "application/json" });
      if (method === "PATCH") headers.set("origin", baseEnv.APP_ORIGIN);
      return workerSelf.fetch(`https://portal.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    };
    expect((await noSession("/api/notice-board/read-marker", "GET")).status).toBe(401);
    expect((await noSession("/api/notice-board/read-marker/", "GET")).status).toBe(401);
    expect((await noSession("/api/notice-board/read-marker", "PATCH", { throughPostId: target.id })).status).toBe(401);
    expect((await noSession("/api/notice-board/read-marker/", "PATCH", { throughPostId: target.id })).status).toBe(401);
  });

  it("advances monotonically, leaves equal or older retries idempotent, and returns authoritative tuples", async () => {
    const olderResponse = await request("/api/notice-board/posts", editorToken, "POST", { content: textDoc("Older read-state post") });
    const olderPost = (await olderResponse.json() as { post: { id: string } }).post;
    const firstResponse = await request("/api/notice-board/posts", editorToken, "POST", { content: textDoc("First read-state post") });
    const firstBody = await firstResponse.json() as { post: { id: string; createdAt: string }; readState: { marker: { throughPostId: string; throughCreatedAt: string; updatedAt: string } | null; latest: { postId: string; createdAt: string } | null; unreadCount: number } };
    const first = firstBody.post;
    expect(firstBody.readState).toEqual({
      marker: { throughPostId: first.id, throughCreatedAt: first.createdAt, updatedAt: expect.any(String) },
      latest: { postId: first.id, createdAt: first.createdAt },
      unreadCount: 0,
    });
    const secondResponse = await request("/api/notice-board/posts", photographerToken, "POST", { content: textDoc("Second read-state post") });
    const second = (await secondResponse.json() as { post: { id: string; createdAt: string } }).post;
    const noMarkerUserId = crypto.randomUUID();
    const now = Date.now();
    await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, 'editor', 1, ?, ?)").bind(noMarkerUserId, "No Marker User", `${noMarkerUserId}@example.test`, now, now).run();
    const noMarkerState = await getNoticeBoardReadState(database.DB, noMarkerUserId);
    expect(noMarkerState.marker).toBeNull();
    expect(noMarkerState.unreadCount).toBeGreaterThanOrEqual(3);
    const suppliedUpdatedAt = Date.now() + 120_000;
    await advanceNoticeBoardReadMarker(database.DB, noMarkerUserId, first.id, suppliedUpdatedAt);
    const firstMarker = await database.DB.prepare("SELECT updated_at FROM notice_board_read_markers WHERE user_id = ?").bind(noMarkerUserId).first<{ updated_at: number }>();
    expect(firstMarker?.updated_at).toBe(suppliedUpdatedAt);
    await advanceNoticeBoardReadMarker(database.DB, noMarkerUserId, second.id, suppliedUpdatedAt - 1);
    const secondMarker = await database.DB.prepare("SELECT updated_at FROM notice_board_read_markers WHERE user_id = ?").bind(noMarkerUserId).first<{ updated_at: number }>();
    expect(secondMarker?.updated_at).toBe(firstMarker!.updated_at + 1);
    const advanced = await request("/api/notice-board/read-marker", adminToken, "PATCH", { throughPostId: first.id });
    const advancedBody = await advanced.json() as { marker: { throughPostId: string; throughCreatedAt: string; updatedAt: string }; latest: { postId: string; createdAt: string }; unreadCount: number };
    expect(advanced.status).toBe(200);
    expect(advancedBody.marker).toMatchObject({ throughPostId: first.id, throughCreatedAt: first.createdAt });
    expect(advancedBody.latest).toMatchObject({ postId: second.id, createdAt: second.createdAt });
    expect(advancedBody.unreadCount).toBe(1);
    const repeated = await request("/api/notice-board/read-marker", adminToken, "PATCH", { throughPostId: first.id });
    const repeatedBody = await repeated.json();
    expect(repeatedBody).toEqual(advancedBody);
    const older = await request("/api/notice-board/read-marker", adminToken, "PATCH", { throughPostId: olderPost.id });
    expect(await older.json()).toEqual(advancedBody);
    const newer = await request("/api/notice-board/read-marker", adminToken, "PATCH", { throughPostId: second.id });
    const newerBody = await newer.json() as { marker: { throughPostId: string; updatedAt: string }; unreadCount: number };
    expect(newerBody.marker.throughPostId).toBe(second.id);
    expect(newerBody.unreadCount).toBe(0);
    expect(new Date(newerBody.marker.updatedAt).getTime()).toBeGreaterThan(new Date(advancedBody.marker.updatedAt).getTime());
  });

  it("returns a stable 409 for missing and deleted read targets", async () => {
    const created = await request("/api/notice-board/posts", editorToken, "POST", { content: textDoc("Deleted read target") });
    const post = (await created.json() as { post: { id: string } }).post;
    await request(`/api/notice-board/posts/${post.id}`, editorToken, "DELETE");
    for (const path of ["/api/notice-board/read-marker", "/api/notice-board/read-marker/"]) {
      const response = await request(path, editorToken, "PATCH", { throughPostId: post.id });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "Notice board read target changed.", code: "notice_board_read_target_changed" });
    }
  });

  it("keeps the author's create marker below a post committed afterward by another user", async () => {
    const wallClockMs = Date.now() + 50_000_000;
    const ownId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const otherId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa0";
    const create = (id: string, authorId: string, body: string, clock: number) => createNoticeBoardPost(database.DB, {
      id, authorId, body, contentJson: JSON.stringify(textDoc(body)), mentions: [], wallClockMs: clock,
    });
    try {
      await create(ownId, editorId, "Own atomic marker", wallClockMs);
      await create(otherId, photographerId, "Concurrent newer post", wallClockMs);
      const stored = await database.DB.prepare("SELECT id, created_at FROM notice_board_posts WHERE id IN (?, ?) ORDER BY created_at, id").bind(ownId, otherId).all<{ id: string; created_at: number }>();
      expect(stored.results.map((post) => post.id)).toEqual([ownId, otherId]);
      expect(stored.results[1]!.created_at).toBe(stored.results[0]!.created_at + 1);
      const state = await getNoticeBoardReadState(database.DB, editorId);
      expect(state.marker?.throughPostId).toBe(ownId);
      expect(state.unreadCount).toBeGreaterThanOrEqual(1);
    } finally {
      await database.DB.prepare("DELETE FROM notice_board_posts WHERE id IN (?, ?)").bind(ownId, otherId).run();
      await database.DB.prepare("DELETE FROM notice_board_read_markers WHERE user_id IN (?, ?)").bind(editorId, photographerId).run();
    }
  });

  it("allocates strict same-clock successors above surviving marker tuples after deletion", async () => {
    const frozenClock = Date.now() + 60_000_000;
    const deletedId = "ffffffff-ffff-4fff-8fff-fffffffffff1";
    const firstSuccessorId = "00000000-0000-4000-8000-0000000000f1";
    const secondSuccessorId = "00000000-0000-4000-8000-0000000000f2";
    const create = (id: string, authorId: string, body: string) => createNoticeBoardPost(database.DB, {
      id, authorId, body, contentJson: JSON.stringify(textDoc(body)), mentions: [], wallClockMs: frozenClock,
    });
    try {
      await create(deletedId, editorId, "Deleted high-water");
      await advanceNoticeBoardReadMarker(database.DB, editorId, deletedId, frozenClock);
      await database.DB.prepare("DELETE FROM notice_board_posts WHERE id = ?").bind(deletedId).run();
      await create(firstSuccessorId, photographerId, "First same-clock successor");
      await create(secondSuccessorId, photographerId, "Second same-clock successor");
      const stored = await database.DB.prepare("SELECT id, created_at FROM notice_board_posts WHERE id IN (?, ?) ORDER BY created_at").bind(firstSuccessorId, secondSuccessorId).all<{ id: string; created_at: number }>();
      expect(stored.results).toEqual([
        { id: firstSuccessorId, created_at: frozenClock + 1 },
        { id: secondSuccessorId, created_at: frozenClock + 2 },
      ]);
      const state = await getNoticeBoardReadState(database.DB, editorId);
      expect(state.marker?.throughPostId).toBe(deletedId);
      expect(state.unreadCount).toBeGreaterThanOrEqual(2);
    } finally {
      await database.DB.prepare("DELETE FROM notice_board_posts WHERE id IN (?, ?, ?)").bind(deletedId, firstSuccessorId, secondSuccessorId).run();
      await database.DB.prepare("DELETE FROM notice_board_read_markers WHERE user_id IN (?, ?)").bind(editorId, photographerId).run();
    }
  });

  it("does not change order or read state on edit, and deletes only reduce surviving unread posts", async () => {
    const frozenClock = Date.now() + 70_000_000;
    const oldId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
    const middleId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
    const newestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";
    const create = (id: string, authorId: string, body: string) => createNoticeBoardPost(database.DB, {
      id, authorId, body, contentJson: JSON.stringify(textDoc(body)), mentions: [], wallClockMs: frozenClock,
    });
    try {
      await create(oldId, photographerId, "Delete test old");
      await create(middleId, editorId, "Delete test middle");
      await create(newestId, editorId, "Delete test newest");
      await advanceNoticeBoardReadMarker(database.DB, photographerId, oldId, frozenClock);
      const beforeEdit = await getNoticeBoardReadState(database.DB, photographerId);
      const edited = await request(`/api/notice-board/posts/${oldId}`, photographerToken, "PATCH", { content: textDoc("Delete test edited") });
      expect(edited.status).toBe(200);
      const editBody = await edited.json() as { post: { id: string; createdAt: string }; readState: unknown };
      expect(editBody.post).toMatchObject({ id: oldId, createdAt: beforeEdit.marker?.throughCreatedAt });
      expect(editBody.readState).toEqual(beforeEdit);
      expect(await getNoticeBoardReadState(database.DB, photographerId)).toEqual(beforeEdit);
      expect((await database.DB.prepare("DELETE FROM notice_board_posts WHERE id = ?").bind(middleId).run()).meta.changes).toBe(1);
      expect((await getNoticeBoardReadState(database.DB, photographerId)).unreadCount).toBe(1);
      await database.DB.prepare("DELETE FROM notice_board_posts WHERE id = ?").bind(oldId).run();
      const afterMarkerDelete = await getNoticeBoardReadState(database.DB, photographerId);
      expect(afterMarkerDelete.marker?.throughPostId).toBe(oldId);
      expect(afterMarkerDelete.unreadCount).toBe(1);
    } finally {
      await database.DB.prepare("DELETE FROM notice_board_posts WHERE id IN (?, ?, ?)").bind(oldId, middleId, newestId).run();
      await database.DB.prepare("DELETE FROM notice_board_read_markers WHERE user_id IN (?, ?)").bind(photographerId, editorId).run();
    }
  });

  it("keeps marker actions free of notification and outbox side effects", async () => {
    const beforeNotifications = await database.DB.prepare("SELECT COUNT(*) AS count FROM notifications").first<{ count: number }>();
    const beforeOutbox = await database.DB.prepare("SELECT COUNT(*) AS count FROM notification_outbox").first<{ count: number }>();
    const target = await database.DB.prepare("SELECT id FROM notice_board_posts ORDER BY created_at DESC, id DESC LIMIT 1").first<{ id: string }>();
    expect(target).toBeDefined();
    await request("/api/notice-board/read-marker", editorToken);
    await request("/api/notice-board/read-marker", editorToken, "PATCH", { throughPostId: target!.id });
    const afterNotifications = await database.DB.prepare("SELECT COUNT(*) AS count FROM notifications").first<{ count: number }>();
    const afterOutbox = await database.DB.prepare("SELECT COUNT(*) AS count FROM notification_outbox").first<{ count: number }>();
    expect(afterNotifications?.count).toBe(beforeNotifications?.count);
    expect(afterOutbox?.count).toBe(beforeOutbox?.count);
  });

  it("stores underline and strike through both POST and author PATCH, rejecting malformed mark attributes", async () => {
    for (const type of ["underline", "strike"] as const) {
      const content = markedDoc(type);
      const created = await request("/api/notice-board/posts", editorToken, "POST", { content });
      expect(created.status).toBe(201); const post = (await created.json() as { post: { id: string; content: unknown } }).post;
      expect(post.content).toEqual(content);
      const edited = await request(`/api/notice-board/posts/${post.id}`, editorToken, "PATCH", { content });
      expect(edited.status).toBe(200); expect((await edited.json() as { post: { content: unknown } }).post.content).toEqual(content);
      const malformed = doc([{ type: "text", text: "Bad", marks: [{ type, attrs: {} }] }]);
      expect((await request("/api/notice-board/posts", editorToken, "POST", { content: malformed })).status).toBe(400);
      expect((await request(`/api/notice-board/posts/${post.id}`, editorToken, "PATCH", { content: malformed })).status).toBe(400);
    }
  });

  it("creates rich content, derives a body, normalizes forged labels, maps mentions, and notifies", async () => {
    const response = await request("/api/notice-board/posts", editorToken, "POST", { content: doc([{ type: "text", text: "Hello " }, { type: "mention", attrs: { id: adminId, label: "Pretend client name" } }]) });
    expect(response.status).toBe(201);
    const post = (await response.json() as { post: { id: string; body: string; content: { content: Array<{ content: Array<{ attrs?: { label: string } }> }> }; editedAt: string | null } }).post;
    expect(post).toMatchObject({ body: "Hello Notice Admin", editedAt: null });
    expect(post.content.content[0]!.content[1]!.attrs?.label).toBe("Notice Admin");
    expect(await database.DB.prepare("SELECT mentioned_user_id FROM notice_board_post_mentions WHERE post_id = ?").bind(post.id).all()).toMatchObject({ results: [{ mentioned_user_id: adminId }] });
    expect(await database.DB.prepare("SELECT type, source_key, project_id FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").bind(adminId).first()).toMatchObject({ type: "mentioned", project_id: null });
    const mention = (await database.DB.prepare("SELECT id, mentioned_user_id FROM notice_board_post_mentions WHERE post_id = ?").bind(post.id).first<{ id: string; mentioned_user_id: string }>())!;
    await database.DB.prepare("DELETE FROM notifications WHERE source_key = ?").bind(mention.id).run();
    const send = vi.fn().mockResolvedValue({ messageId: "mention-email" });
    await notifyNoticeBoardMentions({ DB: database.DB, EMAIL: { send }, NOTIFICATIONS_FROM_ADDRESS: "studio@example.test", APP_ORIGIN: "https://portal.test" } as unknown as Env, {
      actorId: editorId, authorName: "Notice Editor", body: "Hello Notice Admin", mentions: [{ id: mention.id, mentionedUserId: mention.mentioned_user_id }],
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "notice-admin@example.test", subject: "You were mentioned", text: "Notice Editor mentioned you in a notice-board post:\n\n“Hello Notice Admin”", html: "<p>Notice Editor mentioned you in a notice-board post:</p><p>“Hello Notice Admin”</p>" }));
    expect(await database.DB.prepare("SELECT email_sent_at, email_message_id FROM notifications WHERE source_key = ?").bind(mention.id).first()).toMatchObject({ email_sent_at: expect.any(Number), email_message_id: "mention-email" });
    const audit = await database.DB.prepare("SELECT action, meta_json FROM audit_log WHERE target_id = ? ORDER BY created_at DESC LIMIT 1").bind(post.id).first<{ action: string; meta_json: string | null }>();
    expect(audit).toEqual({ action: "notice_board.post", meta_json: null });
  });

  it("skips in-app and email mention delivery when the mapped staff member is deactivated before emission", async () => {
    const postId = crypto.randomUUID(); const mappingId = crypto.randomUUID(); const now = Date.now();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO notice_board_posts (id, author_id, body, content_json, created_at) VALUES (?, ?, ?, ?, ?)").bind(postId, editorId, "Mention Notice Photographer", JSON.stringify(doc([{ type: "mention", attrs: { id: photographerId, label: "Notice Photographer" } }])), now),
      database.DB.prepare("INSERT INTO notice_board_post_mentions (id, post_id, mentioned_user_id, created_at) VALUES (?, ?, ?, ?)").bind(mappingId, postId, photographerId, now),
    ]);
    await database.DB.prepare("UPDATE user SET active = 0 WHERE id = ?").bind(photographerId).run();
    const send = vi.fn().mockResolvedValue({ messageId: "should-not-send" });
    await notifyNoticeBoardMentions({ DB: database.DB, EMAIL: { send }, NOTIFICATIONS_FROM_ADDRESS: "studio@example.test", APP_ORIGIN: "https://portal.test" } as unknown as Env, {
      actorId: editorId, authorName: "Notice Editor", body: "Mention Notice Photographer", mentions: [{ id: mappingId, mentionedUserId: photographerId }],
    });
    expect(await database.DB.prepare("SELECT id FROM notifications WHERE source_key = ?").bind(mappingId).all()).toMatchObject({ results: [] });
    expect(send).not.toHaveBeenCalled();
    await database.DB.prepare("UPDATE user SET active = 1 WHERE id = ?").bind(photographerId).run();
  });

  it("supports photographer access and preserves author-only edit and delete, including for admins", async () => {
    const created = await request("/api/notice-board/posts", photographerToken, "POST", { content: textDoc("Photographer notice") });
    expect(created.status).toBe(201); const post = (await created.json() as { post: { id: string } }).post;
    expect((await request(`/api/notice-board/posts/${post.id}`, adminToken, "PATCH", { content: textDoc("Admin edit") })).status).toBe(403);
    expect((await request(`/api/notice-board/posts/${post.id}`, adminToken, "DELETE")).status).toBe(403);
    const edited = await request(`/api/notice-board/posts/${post.id}`, photographerToken, "PATCH", { content: textDoc("Photographer edited") });
    expect(edited.status).toBe(200); expect((await edited.json() as { post: unknown }).post).toMatchObject({ body: "Photographer edited", editedAt: expect.any(String) });
    expect((await request(`/api/notice-board/posts/${post.id}`, photographerToken, "DELETE")).status).toBe(200);
  });

  it("trims leading and trailing whitespace before accepting an at-limit body", async () => {
    const body = "x".repeat(2_000);
    const response = await request("/api/notice-board/posts", editorToken, "POST", { content: textDoc(`  ${body}  `) });
    expect(response.status).toBe(201);
    expect((await response.json() as { post: unknown }).post).toMatchObject({ body });
  });

  it("rejects malformed rich documents, overlong semantic bodies, and inactive mention targets", async () => {
    const invalid = [textDoc("x".repeat(2_001)), { type: "doc", content: [{ type: "heading", content: [{ type: "text", text: "bad" }] }] }, doc([{ type: "mention", attrs: { id: "not-a-uuid", label: "bad" } }])];
    for (const content of invalid) expect((await request("/api/notice-board/posts", editorToken, "POST", { content })).status).toBe(400);
    await database.DB.prepare("UPDATE user SET active = 0 WHERE id = ?").bind(adminId).run();
    expect((await request("/api/notice-board/posts", editorToken, "POST", { content: doc([{ type: "mention", attrs: { id: adminId, label: "Admin" } }]) })).status).toBe(400);
    await database.DB.prepare("UPDATE user SET active = 1 WHERE id = ?").bind(adminId).run();
  });

  it("diffs mention maps on edit and only creates a notification for the new target", async () => {
    const created = await request("/api/notice-board/posts", editorToken, "POST", { content: doc([{ type: "mention", attrs: { id: adminId, label: "x" } }]) });
    const post = (await created.json() as { post: { id: string } }).post;
    const edited = await request(`/api/notice-board/posts/${post.id}`, editorToken, "PATCH", { content: doc([{ type: "mention", attrs: { id: photographerId, label: "x" } }]) });
    expect(edited.status).toBe(200);
    expect(await database.DB.prepare("SELECT mentioned_user_id FROM notice_board_post_mentions WHERE post_id = ?").bind(post.id).all()).toMatchObject({ results: [{ mentioned_user_id: photographerId }] });
    const notification = await database.DB.prepare("SELECT type, source_key, project_id FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").bind(photographerId).first<{ type: string; source_key: string; project_id: string | null }>();
    expect(notification).toMatchObject({ type: "mentioned", project_id: null, source_key: expect.any(String) });
    expect(await database.DB.prepare("SELECT action, meta_json FROM audit_log WHERE action = 'notice_board.edit' AND target_id = ?").bind(post.id).first()).toEqual({ action: "notice_board.edit", meta_json: null });
  });

  it("serializes legacy bodies into a synthetic document and keeps newest-first list ordering", async () => {
    const legacyId = "00000000-0000-4000-8000-000000000025"; const now = Date.now() + 10_000;
    await database.DB.prepare("INSERT INTO notice_board_posts (id, author_id, body, created_at) VALUES (?, ?, ?, ?)").bind(legacyId, editorId, "Legacy body", now).run();
    const listed = await request("/api/notice-board/posts?limit=50", editorToken); const posts = (await listed.json() as { posts: Array<{ id: string; content: unknown; editedAt: unknown }> }).posts;
    expect(posts[0]).toMatchObject({ id: legacyId, content: textDoc("Legacy body"), editedAt: null });
  });

  it("re-parses persisted underline and strike documents instead of using the legacy fallback", async () => {
    const now = Date.now() + 20_000;
    const fixtures = [
      { id: "00000000-0000-4000-8000-000000000026", content: markedDoc("underline"), body: "Legacy underline fallback" },
      { id: "00000000-0000-4000-8000-000000000027", content: markedDoc("strike"), body: "Legacy strike fallback" },
    ];
    for (const fixture of fixtures) await database.DB.prepare("INSERT INTO notice_board_posts (id, author_id, body, content_json, created_at) VALUES (?, ?, ?, ?, ?)").bind(fixture.id, editorId, fixture.body, JSON.stringify(fixture.content), now).run();
    const malformedId = "00000000-0000-4000-8000-000000000028";
    await database.DB.prepare("INSERT INTO notice_board_posts (id, author_id, body, content_json, created_at) VALUES (?, ?, ?, ?, ?)").bind(malformedId, editorId, "Malformed fallback", "{not json", now).run();

    const listed = await request("/api/notice-board/posts?limit=50", editorToken);
    const posts = (await listed.json() as { posts: Array<{ id: string; content: unknown }> }).posts;
    for (const fixture of fixtures) expect(posts.find((post) => post.id === fixture.id)?.content).toEqual(fixture.content);
    expect(posts.find((post) => post.id === malformedId)?.content).toEqual(textDoc("Malformed fallback"));
  });

  it("preserves a list-item hard break through post and list retrieval", async () => {
    const content = { type: "doc", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "First" }, { type: "hardBreak" }, { type: "text", text: "second" }] }] }] }] };
    const created = await request("/api/notice-board/posts", editorToken, "POST", { content });
    expect(created.status).toBe(201);
    const { id } = (await created.json() as { post: { id: string } }).post;
    const listed = await request("/api/notice-board/posts?limit=50", editorToken);
    const posts = (await listed.json() as { posts: Array<{ id: string; content: unknown }> }).posts;
    expect(posts.find((post) => post.id === id)?.content).toEqual(content);
  });

  it("serves the active staff mention lookup without email or a manage-users dependency", async () => {
    for (let index = 0; index < 24; index += 1) { const id = `77777777-7777-4777-8777-${index.toString(16).padStart(12, "0")}`; await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, 'editor', 1, ?, ?)").bind(id, `Same Name ${index}`, `mention-${index}@example.test`, Date.now(), Date.now()).run(); }
    const response = await request("/api/mentionable-users?scope=notice-board&q=same%20name", photographerToken);
    expect(response.status).toBe(200); const users = (await response.json() as { users: Array<Record<string, unknown>> }).users;
    expect(users).toHaveLength(20); expect(users[0]).toHaveProperty("role"); expect(users[0]).not.toHaveProperty("email");
    await database.DB.prepare("UPDATE user SET active = 0 WHERE id = ?").bind("77777777-7777-4777-8777-000000000000").run();
    const filtered = await request("/api/mentionable-users?scope=notice-board&q=Same%20Name%200", photographerToken);
    expect((await filtered.json() as { users: Array<{ id: string }> }).users.map((user) => user.id)).not.toContain("77777777-7777-4777-8777-000000000000");
    const literalWildcard = await request("/api/mentionable-users?scope=notice-board&q=%25", photographerToken);
    expect((await literalWildcard.json() as { users: unknown[] }).users).toEqual([]);
    const literalUnderscore = await request("/api/mentionable-users?scope=notice-board&q=_", photographerToken);
    expect((await literalUnderscore.json() as { users: unknown[] }).users).toEqual([]);
    expect((await request("/api/mentionable-users?scope=wrong", photographerToken)).status).toBe(400);
  });

  it("stores h2 and h3 through POST/PATCH and re-parses persisted headings on GET", async () => {
    for (const level of [2, 3] as const) {
      const content = headingDoc(level);
      const created = await request("/api/notice-board/posts", editorToken, "POST", { content });
      expect(created.status).toBe(201); const post = (await created.json() as { post: { id: string; content: unknown } }).post;
      expect(post.content).toEqual(content);
      const edited = await request(`/api/notice-board/posts/${post.id}`, editorToken, "PATCH", { content });
      expect(edited.status).toBe(200); expect((await edited.json() as { post: { content: unknown } }).post.content).toEqual(content);
      const listed = await request("/api/notice-board/posts?limit=50", editorToken);
      expect((await listed.json() as { posts: Array<{ id: string; content: unknown }> }).posts.find((item) => item.id === post.id)?.content).toEqual(content);
    }
  });

  it("rejects malformed headings on both POST and PATCH", async () => {
    const created = await request("/api/notice-board/posts", editorToken, "POST", { content: headingDoc(2) });
    expect(created.status).toBe(201);
    const post = (await created.json() as { post: { id: string } }).post;
    for (const content of malformedHeadingDocs()) {
      expect((await request("/api/notice-board/posts", editorToken, "POST", { content })).status).toBe(400);
      expect((await request(`/api/notice-board/posts/${post.id}`, editorToken, "PATCH", { content })).status).toBe(400);
    }
  });

  it("stores checked and unchecked task lists through POST/PATCH and re-parses them on GET", async () => {
    for (const content of [taskDoc(false), taskDoc(true), nestedTaskDoc()]) {
      const created = await request("/api/notice-board/posts", editorToken, "POST", { content });
      expect(created.status).toBe(201); const post = (await created.json() as { post: { id: string; content: unknown } }).post;
      expect(post.content).toEqual(content);
      expect((await request(`/api/notice-board/posts/${post.id}`, editorToken, "PATCH", { content })).status).toBe(200);
      const listed = await request("/api/notice-board/posts?limit=50", editorToken);
      expect((await listed.json() as { posts: Array<{ id: string; content: unknown }> }).posts.find((item) => item.id === post.id)?.content).toEqual(content);
    }
  });

  it("rejects malformed task items on both POST and PATCH", async () => {
    const created = await request("/api/notice-board/posts", editorToken, "POST", { content: taskDoc(false) });
    const { id } = (await created.json() as { post: { id: string } }).post;
    const invalid = [
      { type: "doc", content: [{ type: "taskList", content: [{ type: "taskItem", attrs: { checked: "false" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Bad" }] }] }] }] },
      { type: "doc", content: [{ type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Bad" }] }] }] }] },
    ];
    for (const content of invalid) {
      expect((await request("/api/notice-board/posts", editorToken, "POST", { content })).status).toBe(400);
      expect((await request(`/api/notice-board/posts/${id}`, editorToken, "PATCH", { content })).status).toBe(400);
    }
  });
});
