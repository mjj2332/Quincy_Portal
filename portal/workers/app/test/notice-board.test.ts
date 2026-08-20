import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";
import { notifyMentions } from "../src/lib/notifications";

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const adminToken = "notice-board-admin-session-token"; const editorToken = "notice-board-editor-session-token"; const photographerToken = "notice-board-photographer-session-token";
const adminId = "44444444-4444-4444-8444-444444444444"; const editorId = "55555555-5555-4555-8555-555555555555"; const photographerId = "66666666-6666-4666-8666-866666666666";
declare const __PORTAL_MIGRATION_SQL__: string; declare const __PORTAL_SEED_SQL__: string;

const doc = (content: Array<Record<string, unknown>>) => ({ type: "doc", content: [{ type: "paragraph", content }] });
const textDoc = (text: string) => doc([{ type: "text", text }]);
const markedDoc = (type: "underline" | "strike") => doc([{ type: "text", text: `${type} text`, marks: [{ type }] }]);
const headingDoc = (level: 2 | 3) => ({ type: "doc", content: [{ type: "heading", attrs: { level }, content: [{ type: "text", text: level === 2 ? "Notice section" : "Notice subsection" }] }] });
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
  for (const [id, name, email, role] of [[adminId, "Notice Admin", "notice-admin@example.test", "admin"], [editorId, "Notice Editor", "notice-editor@example.test", "editor"], [photographerId, "Notice Photographer", "notice-photographer@example.test", "photographer"]]) await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, ?, ?)").bind(id, name, email, role, now, now).run();
  for (const [id, token, userId] of [["notice-admin-session", adminToken, adminId], ["notice-editor-session", editorToken, editorId], ["notice-photographer-session", photographerToken, photographerId]]) await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, now + 3_600_000, token, userId, now, now).run();
});

describe("notice board API", () => {
  it("returns an empty latest cursor before the first post", async () => expect(await (await request("/api/notice-board/posts/latest", editorToken)).json()).toEqual({ id: null, createdAt: null }));

  it("stores underline and strike through both POST and author PATCH, rejecting malformed mark attributes", async () => {
    for (const type of ["underline", "strike"] as const) {
      const content = markedDoc(type);
      const created = await request("/api/notice-board/posts", editorToken, "POST", { content });
      expect(created.status).toBe(201); const post = await created.json() as { id: string; content: unknown };
      expect(post.content).toEqual(content);
      const edited = await request(`/api/notice-board/posts/${post.id}`, editorToken, "PATCH", { content });
      expect(edited.status).toBe(200); expect((await edited.json() as { content: unknown }).content).toEqual(content);
      const malformed = doc([{ type: "text", text: "Bad", marks: [{ type, attrs: {} }] }]);
      expect((await request("/api/notice-board/posts", editorToken, "POST", { content: malformed })).status).toBe(400);
      expect((await request(`/api/notice-board/posts/${post.id}`, editorToken, "PATCH", { content: malformed })).status).toBe(400);
    }
  });

  it("creates rich content, derives a body, normalizes forged labels, maps mentions, and notifies", async () => {
    const response = await request("/api/notice-board/posts", editorToken, "POST", { content: doc([{ type: "text", text: "Hello " }, { type: "mention", attrs: { id: adminId, label: "Pretend client name" } }]) });
    expect(response.status).toBe(201);
    const post = await response.json() as { id: string; body: string; content: { content: Array<{ content: Array<{ attrs?: { label: string } }> }> }; editedAt: string | null };
    expect(post).toMatchObject({ body: "Hello Notice Admin", editedAt: null });
    expect(post.content.content[0]!.content[1]!.attrs?.label).toBe("Notice Admin");
    expect(await database.DB.prepare("SELECT mentioned_user_id FROM notice_board_post_mentions WHERE post_id = ?").bind(post.id).all()).toMatchObject({ results: [{ mentioned_user_id: adminId }] });
    expect(await database.DB.prepare("SELECT type, source_key, project_id FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").bind(adminId).first()).toMatchObject({ type: "mentioned", project_id: null });
    const mention = (await database.DB.prepare("SELECT id, mentioned_user_id FROM notice_board_post_mentions WHERE post_id = ?").bind(post.id).first<{ id: string; mentioned_user_id: string }>())!;
    await database.DB.prepare("DELETE FROM notifications WHERE source_key = ?").bind(mention.id).run();
    const send = vi.fn().mockResolvedValue({ messageId: "mention-email" });
    await notifyMentions({ DB: database.DB, EMAIL: { send }, NOTIFICATIONS_FROM_ADDRESS: "studio@example.test", APP_ORIGIN: "https://portal.test" } as unknown as Env, {
      scope: "notice-board", actorId: editorId, mentions: [{ id: mention.id, mentionedUserId: mention.mentioned_user_id }],
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "notice-admin@example.test", subject: "You were mentioned", text: "You were mentioned in a notice-board post.", html: "<p>You were mentioned in a notice-board post.</p>" }));
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
    await notifyMentions({ DB: database.DB, EMAIL: { send }, NOTIFICATIONS_FROM_ADDRESS: "studio@example.test", APP_ORIGIN: "https://portal.test" } as unknown as Env, {
      scope: "notice-board", actorId: editorId, mentions: [{ id: mappingId, mentionedUserId: photographerId }],
    });
    expect(await database.DB.prepare("SELECT id FROM notifications WHERE source_key = ?").bind(mappingId).all()).toMatchObject({ results: [] });
    expect(send).not.toHaveBeenCalled();
    await database.DB.prepare("UPDATE user SET active = 1 WHERE id = ?").bind(photographerId).run();
  });

  it("supports photographer access and preserves author-only edit and delete, including for admins", async () => {
    const created = await request("/api/notice-board/posts", photographerToken, "POST", { content: textDoc("Photographer notice") });
    expect(created.status).toBe(201); const post = await created.json() as { id: string };
    expect((await request(`/api/notice-board/posts/${post.id}`, adminToken, "PATCH", { content: textDoc("Admin edit") })).status).toBe(403);
    expect((await request(`/api/notice-board/posts/${post.id}`, adminToken, "DELETE")).status).toBe(403);
    const edited = await request(`/api/notice-board/posts/${post.id}`, photographerToken, "PATCH", { content: textDoc("Photographer edited") });
    expect(edited.status).toBe(200); expect(await edited.json()).toMatchObject({ body: "Photographer edited", editedAt: expect.any(String) });
    expect((await request(`/api/notice-board/posts/${post.id}`, photographerToken, "DELETE")).status).toBe(200);
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
    const post = await created.json() as { id: string };
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
    const { id } = await created.json() as { id: string };
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
      expect(created.status).toBe(201); const post = await created.json() as { id: string; content: unknown };
      expect(post.content).toEqual(content);
      const edited = await request(`/api/notice-board/posts/${post.id}`, editorToken, "PATCH", { content });
      expect(edited.status).toBe(200); expect((await edited.json() as { content: unknown }).content).toEqual(content);
      const listed = await request("/api/notice-board/posts?limit=50", editorToken);
      expect((await listed.json() as { posts: Array<{ id: string; content: unknown }> }).posts.find((item) => item.id === post.id)?.content).toEqual(content);
    }
  });

  it("rejects malformed headings on both POST and PATCH", async () => {
    const created = await request("/api/notice-board/posts", editorToken, "POST", { content: headingDoc(2) });
    expect(created.status).toBe(201);
    const post = await created.json() as { id: string };
    for (const content of malformedHeadingDocs()) {
      expect((await request("/api/notice-board/posts", editorToken, "POST", { content })).status).toBe(400);
      expect((await request(`/api/notice-board/posts/${post.id}`, editorToken, "PATCH", { content })).status).toBe(400);
    }
  });
});
