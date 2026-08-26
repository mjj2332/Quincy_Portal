import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";
import { createProjectComment, createProjectCommentActivityIntent, deleteProjectComment } from "../src/lib/project-comments";

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const adminId = "11111111-1111-4111-8111-111111111111";
const editorId = "22222222-2222-4222-8222-222222222222";
const photographerId = "33333333-3333-4333-8333-333333333333";
const outsiderId = "44444444-4444-4444-8444-444444444444";
const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherProjectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
declare const __PORTAL_MIGRATION_SQL__: string; declare const __PORTAL_SEED_SQL__: string;

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const mentionDoc = (id: string, label: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id, label } }] }] });
const markedDoc = (type: "underline" | "strike") => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `${type} text`, marks: [{ type }] }] }] });
const headingDoc = (level: 2 | 3) => ({ type: "doc", content: [{ type: "heading", attrs: { level }, content: [{ type: "text", text: level === 2 ? "Comment section" : "Comment subsection" }] }] });
const taskDoc = (checked: boolean) => ({ type: "doc", content: [{ type: "taskList", content: [{ type: "taskItem", attrs: { checked }, content: [{ type: "paragraph", content: [{ type: "text", text: checked ? "Checked comment" : "Unchecked comment" }] }] }] }] });
const nestedTaskDoc = () => ({ type: "doc", content: [{ type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Outer comment task" }] }, { type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Nested ordinary" }] }, { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Nested task" }] }] }] }] }] }] }] }] });
const malformedHeadingDocs = () => [
  { type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Invalid h1" }] }] },
  { type: "doc", content: [{ type: "heading", attrs: { level: 4 }, content: [{ type: "text", text: "Invalid h4" }] }] },
  { type: "doc", content: [{ type: "heading", attrs: { level: 2, extra: true }, content: [{ type: "text", text: "Extra attributes" }] }] },
  { type: "doc", content: [{ type: "heading", attrs: { level: 3 }, content: [{ type: "paragraph", content: [{ type: "text", text: "Block content" }] }] }] },
];
async function executeSql(sql: string) { for (const chunk of sql.split("--> statement-breakpoint")) for (const statement of chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); } }
async function cookie(token: string) { const context = await createAuth(baseEnv).$context; return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`; }
async function request(path: string, token: string, method: "GET" | "POST" | "PATCH" | "DELETE" = "GET", body?: unknown) { const headers = new Headers({ cookie: await cookie(token) }); if (body !== undefined) headers.set("content-type", "application/json"); if (method !== "GET") headers.set("origin", baseEnv.APP_ORIGIN); return workerSelf.fetch(`https://portal.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__); await executeSql(__PORTAL_SEED_SQL__); const now = Date.now();
  for (const [id, role] of [[adminId, "admin"], [editorId, "editor"], [photographerId, "photographer"], [outsiderId, "editor"]]) await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, ?, ?)").bind(id, `${role} ${id.slice(0, 4)}`, `${id}@example.test`, role, now, now).run();
  for (const [id, token, userId] of [["comments-admin", "comments-admin-token", adminId], ["comments-editor", "comments-editor-token", editorId], ["comments-photographer", "comments-photographer-token", photographerId], ["comments-outsider", "comments-outsider-token", outsiderId]]) await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, now + 3_600_000, token, userId, now, now).run();
  for (const [id, street] of [[projectId, "Comment Street"], [otherProjectId, "Other Street"]]) await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, ?, 'editing_autohdr', 0, ?, ?)").bind(id, street, now, now).run();
  for (const [id, userId, project] of [[crypto.randomUUID(), editorId, projectId], [crypto.randomUUID(), photographerId, projectId], [crypto.randomUUID(), outsiderId, otherProjectId]]) await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(id, project, userId, now).run();
});

describe("project comments API", () => {
  it("allows admins and assigned stage-hidden collaborators, but not globally-visible unassigned editors", async () => {
    expect((await request(`/api/projects/${projectId}/comments`, "comments-admin-token")).status).toBe(200);
    expect((await request(`/api/projects/${projectId}/comments`, "comments-photographer-token")).status).toBe(200);
    expect((await request(`/api/projects/${projectId}/comments`, "comments-outsider-token")).status).toBe(403);
  });

  it("creates normalized project mentions, pages newest-first, and preserves author-only project-scoped edits and deletes", async () => {
    const firstResponse = await request(`/api/projects/${projectId}/comments`, "comments-editor-token", "POST", { content: mentionDoc(adminId, "Forged admin label") });
    expect(firstResponse.status).toBe(201); const first = await firstResponse.json() as { id: string; body: string; content: { content: Array<{ content: Array<{ attrs?: { label: string } }> }> } };
    const storedFirst = await database.DB.prepare("SELECT id, created_at FROM project_comments WHERE id = ?").bind(first.id).first<{ id: string; created_at: number }>();
    expect(await database.DB.prepare("SELECT user_id, project_id, last_read_comment_id, last_read_comment_created_at FROM project_comment_read_markers WHERE user_id = ? AND project_id = ?").bind(editorId, projectId).first()).toMatchObject({ user_id: editorId, project_id: projectId, last_read_comment_id: first.id, last_read_comment_created_at: storedFirst?.created_at });
    const secondResponse = await request(`/api/projects/${projectId}/comments`, "comments-editor-token", "POST", { content: doc("Second comment") });
    const thirdResponse = await request(`/api/projects/${projectId}/comments`, "comments-editor-token", "POST", { content: doc("Third comment") });
    expect(secondResponse.status).toBe(201); expect(thirdResponse.status).toBe(201);
    const second = await secondResponse.json() as { id: string }; const third = await thirdResponse.json() as { id: string };
    const createdAt = Date.now() - 10_000;
    await database.DB.batch([first, second, third].map((comment, index) => database.DB.prepare("UPDATE project_comments SET created_at = ? WHERE id = ?").bind(createdAt + index * 1_000, comment.id)));
    expect(first.body).toBe("admin 1111"); expect(first.content.content[0]!.content[0]!.attrs?.label).toBe("admin 1111");
    const mention = (await database.DB.prepare("SELECT id, mentioned_user_id FROM project_comment_mentions WHERE comment_id = ?").bind(first.id).first<{ id: string; mentioned_user_id: string }>())!;
    expect(mention.mentioned_user_id).toBe(adminId);
    expect(await database.DB.prepare("SELECT event_type, source_key, recipient_id, status FROM notification_outbox WHERE source_key = ?").bind(mention.id).first()).toMatchObject({ event_type: "project.comment.mentioned", source_key: mention.id, recipient_id: adminId, status: expect.stringMatching(/pending|queued/) });
    expect(await database.DB.prepare("SELECT id FROM notifications WHERE user_id = ? AND source_key = ?").bind(adminId, mention.id).first()).toBeNull();
    const full = await request(`/api/projects/${projectId}/comments?limit=3`, "comments-editor-token"); const fullPage = await full.json() as { project: { street: string }; comments: Array<{ id: string }> };
    expect(fullPage.project.street).toBe("Comment Street"); expect(fullPage.comments.map((comment) => comment.id)).toEqual([third.id, second.id, first.id]);
    const limited = await request(`/api/projects/${projectId}/comments?limit=2`, "comments-editor-token"); const limitedPage = await limited.json() as { comments: Array<{ id: string }>; nextCursor?: string };
    expect(limitedPage.comments.map((comment) => comment.id)).toEqual([third.id, second.id]); expect(limitedPage.nextCursor).toEqual(expect.any(String));
    const older = await request(`/api/projects/${projectId}/comments?limit=2&before=${encodeURIComponent(limitedPage.nextCursor!)}`, "comments-editor-token");
    expect((await older.json() as { comments: Array<{ id: string }> }).comments.map((comment) => comment.id)).toEqual([first.id]);
    expect((await request(`/api/projects/${projectId}/comments?before=not-a-cursor`, "comments-editor-token")).status).toBe(400);
    expect((await request(`/api/projects/${projectId}/comments/${first.id}`, "comments-admin-token", "PATCH", { content: doc("No") })).status).toBe(403);
    expect((await request(`/api/projects/${projectId}/comments/${first.id}`, "comments-editor-token", "PATCH", { content: doc("Edited comment") })).status).toBe(200);
    expect((await request(`/api/projects/${projectId}/comments/${first.id}`, "comments-editor-token", "DELETE")).status).toBe(200);
    expect(await database.DB.prepare("SELECT action FROM audit_log WHERE target_id = ? ORDER BY created_at").bind(first.id).all()).toMatchObject({ results: [{ action: "project_comment.create" }, { action: "project_comment.edit" }, { action: "project_comment.delete" }] });
  });

  it("accepts a list item containing a hard break", async () => {
    const content = { type: "doc", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "First" }, { type: "hardBreak" }, { type: "text", text: "second" }] }] }] }] };
    const response = await request(`/api/projects/${projectId}/comments`, "comments-editor-token", "POST", { content });
    expect(response.status).toBe(201);
    expect((await response.json() as { content: unknown; body: string })).toMatchObject({ content, body: "First\nsecond" });
  });

  it("trims leading and trailing whitespace before accepting an at-limit body", async () => {
    const body = "x".repeat(10_000);
    const response = await request(`/api/projects/${projectId}/comments`, "comments-editor-token", "POST", { content: doc(`  ${body}  `) });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ body });
  });

  it("rejects forged or inactive targets without auditing, keeps nested comment IDs project-scoped, and validates lookup after access then existence", async () => {
    expect((await request(`/api/projects/${projectId}/comments/${crypto.randomUUID()}`, "comments-editor-token", "DELETE")).status).toBe(404);
    await database.DB.prepare("UPDATE user SET active = 0 WHERE id = ?").bind(adminId).run();
    expect((await request(`/api/projects/${projectId}/comments`, "comments-editor-token", "POST", { content: mentionDoc(adminId, "Inactive admin") })).status).toBe(400);
    await database.DB.prepare("UPDATE user SET active = 1 WHERE id = ?").bind(adminId).run();
    const missingProjectId = crypto.randomUUID(); const missingCommentId = crypto.randomUUID();
    const auditCount = await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'project_comment.create'").first<{ count: number }>();
    expect((await request(`/api/projects/${missingProjectId}/comments`, "comments-admin-token", "POST", { content: doc("Missing project") })).status).toBe(404);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'project_comment.create'").first()).toEqual(auditCount);
    expect((await request(`/api/projects/${missingProjectId}/comments/${missingCommentId}`, "comments-admin-token", "PATCH", { content: doc("Missing project") })).status).toBe(404);
    expect(await database.DB.prepare("SELECT id FROM audit_log WHERE target_id = ?").bind(missingCommentId).all()).toMatchObject({ results: [] });
    const otherCommentId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO project_comments (id, project_id, author_id, body, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(otherCommentId, otherProjectId, editorId, "Other project comment", JSON.stringify(doc("Other project comment")), now).run();
    expect((await request(`/api/projects/${projectId}/comments/${otherCommentId}`, "comments-editor-token", "PATCH", { content: doc("Forged path") })).status).toBe(404);
    expect((await request(`/api/projects/${projectId}/comments/${otherCommentId}`, "comments-editor-token", "DELETE")).status).toBe(404);
    expect(await database.DB.prepare("SELECT action FROM audit_log WHERE target_id = ?").bind(otherCommentId).all()).toMatchObject({ results: [] });
    expect((await request(`/api/mentionable-users?scope=notice-board&projectId=${projectId}`, "comments-editor-token")).status).toBe(400);
    expect((await request(`/api/mentionable-users?projectId=${projectId}`, "comments-editor-token")).status).toBe(200);
    expect((await request(`/api/mentionable-users?projectId=${crypto.randomUUID()}`, "comments-editor-token")).status).toBe(403);
    expect((await request(`/api/mentionable-users?projectId=${crypto.randomUUID()}`, "comments-admin-token")).status).toBe(404);
  });

  it("returns authoritative read state, distinguishes a missing target from an idempotent no-op, and preserves access ordering", async () => {
    const page = await request(`/api/projects/${projectId}/comments?limit=1`, "comments-editor-token");
    const target = (await page.json() as { comments: Array<{ id: string }> }).comments[0]!;
    const initial = await request(`/api/projects/${projectId}/comment-read-marker`, "comments-editor-token");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({ projectId, marker: expect.anything(), latest: expect.anything(), unreadCount: expect.any(Number) });
    const advanced = await request(`/api/projects/${projectId}/comment-read-marker`, "comments-editor-token", "PATCH", { throughCommentId: target.id });
    expect(advanced.status).toBe(200);
    const advancedBody = await advanced.json() as { marker: { throughCommentId: string; updatedAt: string } };
    expect(advancedBody.marker.throughCommentId).toBe(target.id);
    const repeat = await request(`/api/projects/${projectId}/comment-read-marker`, "comments-editor-token", "PATCH", { throughCommentId: target.id });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual(advancedBody);
    const missing = await request(`/api/projects/${projectId}/comment-read-marker`, "comments-editor-token", "PATCH", { throughCommentId: crypto.randomUUID() });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({ error: "Comment read target changed.", code: "comment_read_target_changed" });
    const invalid = await request(`/api/projects/${projectId}/comment-read-marker`, "comments-editor-token", "PATCH", { throughCommentId: "not-a-uuid" });
    expect(invalid.status).toBe(400);
    expect((await request(`/api/projects/${crypto.randomUUID()}/comment-read-marker`, "comments-editor-token")).status).toBe(403);
  });

  it("keeps a deleted high-water target from absorbing a later comment and returns the exact activity intent contract", async () => {
    const page = await request(`/api/projects/${projectId}/comments?limit=1`, "comments-editor-token");
    const target = (await page.json() as { comments: Array<{ id: string }> }).comments[0]!;
    const highWater = Date.now() + 10_000_000;
    await database.DB.prepare("UPDATE project_comment_read_markers SET last_read_comment_id = ?, last_read_comment_created_at = ? WHERE user_id = ? AND project_id = ?").bind(target.id, highWater, editorId, projectId).run();
    await database.DB.prepare("DELETE FROM project_comments WHERE id = ?").bind(target.id).run();
    const created = await request(`/api/projects/${projectId}/comments`, "comments-photographer-token", "POST", { content: doc("After deleted marker") });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { id: string; createdAt: string };
    expect(Number(new Date(createdBody.createdAt))).toBeGreaterThan(highWater);
    const editorState = await request(`/api/projects/${projectId}/comment-read-marker`, "comments-editor-token");
    expect((await editorState.json() as { unreadCount: number }).unreadCount).toBeGreaterThan(0);

    const createdIntent = createProjectCommentActivityIntent({ type: "created", projectId, actorId: editorId, commentId: createdBody.id, occurredAt: new Date("2026-08-25T00:00:00.000Z") });
    expect(createdIntent).toMatchObject({ schemaVersion: 1, activity: { type: "project.comment.created", projectId, actorId: editorId, source: { kind: "project_comment", id: createdBody.id, key: `project-comment:${createdBody.id}:created` }, safePayload: { commentId: createdBody.id }, deepLink: { kind: "project_collaboration", path: `/projects/${projectId}?collaboration=open` } }, broadDelivery: { registryKey: "project.comment.created", coalesce: null }, targetedMentionDelivery: false });
    const editedIntent = createProjectCommentActivityIntent({ type: "edited", projectId, actorId: editorId, commentId: createdBody.id, occurredAt: new Date("2026-08-25T00:00:00.000Z") });
    expect(editedIntent.broadDelivery.coalesce).toEqual({ key: `project-comment-edit:${projectId}:${createdBody.id}:${editorId}`, windowSeconds: 300 });
    expect(editedIntent.activity.source.key).toMatch(new RegExp(`^project-comment:${createdBody.id}:edited:[0-9a-f-]+$`));
    expect(editedIntent.activity).not.toHaveProperty("body"); expect(editedIntent.activity).not.toHaveProperty("mentions");
  });

  it("allocates a lexically lower same-clock successor above a surviving deleted-comment marker", async () => {
    const deletedId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const successorId = "00000000-0000-4000-8000-000000000001";
    const frozenClock = Date.now() + 20_000_000;
    await database.DB.prepare("INSERT INTO project_comments (id, project_id, author_id, body, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(deletedId, projectId, editorId, "Deleted high-water", JSON.stringify(doc("Deleted high-water")), frozenClock).run();
    await database.DB.prepare("INSERT INTO project_comment_read_markers (user_id, project_id, last_read_comment_id, last_read_comment_created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, project_id) DO UPDATE SET last_read_comment_id = excluded.last_read_comment_id, last_read_comment_created_at = excluded.last_read_comment_created_at, updated_at = excluded.updated_at").bind(editorId, projectId, deletedId, frozenClock, frozenClock).run();
    await deleteProjectComment(database.DB, { projectId, commentId: deletedId, actorId: editorId, occurredAt: new Date(frozenClock) });
    const result = await createProjectComment(database.DB, { id: successorId, projectId, authorId: photographerId, body: "Lower UUID successor", contentJson: JSON.stringify(doc("Lower UUID successor")), mentions: [], wallClockMs: frozenClock, occurredAt: new Date(frozenClock) });
    const stored = await database.DB.prepare("SELECT created_at FROM project_comments WHERE id = ?").bind(successorId).first<{ created_at: number }>();
    expect(Number(stored?.created_at)).toBeGreaterThan(frozenClock);
    expect(result.activity.targetedMentionDelivery).toBe(false);
    const state = await request(`/api/projects/${projectId}/comment-read-marker`, "comments-editor-token");
    expect((await state.json() as { unreadCount: number }).unreadCount).toBeGreaterThan(0);
  });

  it("keeps a same-clock lower-UUID follow-up unread after visible-read and own-POST advancement", async () => {
    const frozenClock = Date.now() + 30_000_000;
    const visibleTargetId = "ffffffff-ffff-4fff-8fff-fffffffffff0";
    const ownPostId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee0";
    const lowerFollowUpId = "00000000-0000-4000-8000-0000000000f0";
    const create = (id: string, authorId: string, text: string) => createProjectComment(database.DB, {
      id, projectId, authorId, body: text, contentJson: JSON.stringify(doc(text)), mentions: [], wallClockMs: frozenClock, occurredAt: new Date(frozenClock),
    });
    await create(visibleTargetId, photographerId, "Visible target");
    const visibleRead = await request(`/api/projects/${projectId}/comment-read-marker`, "comments-editor-token", "PATCH", { throughCommentId: visibleTargetId });
    expect(visibleRead.status).toBe(200);
    await create(ownPostId, editorId, "Own post");
    const ownState = await request(`/api/projects/${projectId}/comment-read-marker`, "comments-editor-token");
    expect((await ownState.json() as { marker: { throughCommentId: string } }).marker.throughCommentId).toBe(ownPostId);
    await create(lowerFollowUpId, photographerId, "Lower UUID follow-up");
    const storedFollowUp = await database.DB.prepare("SELECT created_at FROM project_comments WHERE id = ?").bind(lowerFollowUpId).first<{ created_at: number }>();
    const storedMarker = await database.DB.prepare("SELECT last_read_comment_created_at FROM project_comment_read_markers WHERE user_id = ? AND project_id = ?").bind(editorId, projectId).first<{ last_read_comment_created_at: number }>();
    expect(storedFollowUp?.created_at).toBeGreaterThan(storedMarker?.last_read_comment_created_at ?? 0);
    const unread = await request(`/api/projects/${projectId}/comment-read-marker`, "comments-editor-token");
    expect((await unread.json() as { unreadCount: number }).unreadCount).toBeGreaterThan(0);
  });

  it("stores underline and strike through both POST and author PATCH, rejecting malformed mark attributes", async () => {
    for (const type of ["underline", "strike"] as const) {
      const content = markedDoc(type);
      const created = await request(`/api/projects/${projectId}/comments`, "comments-editor-token", "POST", { content });
      expect(created.status).toBe(201); const comment = await created.json() as { id: string; content: unknown };
      expect(comment.content).toEqual(content);
      const edited = await request(`/api/projects/${projectId}/comments/${comment.id}`, "comments-editor-token", "PATCH", { content });
      expect(edited.status).toBe(200); expect((await edited.json() as { content: unknown }).content).toEqual(content);
      const malformed = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Bad", marks: [{ type, attrs: {} }] }] }] };
      expect((await request(`/api/projects/${projectId}/comments`, "comments-editor-token", "POST", { content: malformed })).status).toBe(400);
      expect((await request(`/api/projects/${projectId}/comments/${comment.id}`, "comments-editor-token", "PATCH", { content: malformed })).status).toBe(400);
    }
  });

  it("stores h2 and h3 through POST and author PATCH", async () => {
    for (const level of [2, 3] as const) {
      const content = headingDoc(level);
      const created = await request(`/api/projects/${projectId}/comments`, "comments-editor-token", "POST", { content });
      expect(created.status).toBe(201); const comment = await created.json() as { id: string; content: unknown };
      expect(comment.content).toEqual(content);
      const edited = await request(`/api/projects/${projectId}/comments/${comment.id}`, "comments-editor-token", "PATCH", { content });
      expect(edited.status).toBe(200); expect((await edited.json() as { content: unknown }).content).toEqual(content);
    }
  });

  it("rejects malformed headings on both POST and author PATCH", async () => {
    const created = await request(`/api/projects/${projectId}/comments`, "comments-editor-token", "POST", { content: headingDoc(2) });
    expect(created.status).toBe(201);
    const comment = await created.json() as { id: string };
    for (const content of malformedHeadingDocs()) {
      expect((await request(`/api/projects/${projectId}/comments`, "comments-editor-token", "POST", { content })).status).toBe(400);
      expect((await request(`/api/projects/${projectId}/comments/${comment.id}`, "comments-editor-token", "PATCH", { content })).status).toBe(400);
    }
  });

  it("stores checked and unchecked task lists through POST and author PATCH", async () => {
    for (const content of [taskDoc(false), taskDoc(true), nestedTaskDoc()]) {
      const created = await request(`/api/projects/${projectId}/comments`, "comments-editor-token", "POST", { content });
      expect(created.status).toBe(201); const comment = await created.json() as { id: string; content: unknown };
      expect(comment.content).toEqual(content);
      const edited = await request(`/api/projects/${projectId}/comments/${comment.id}`, "comments-editor-token", "PATCH", { content });
      expect(edited.status).toBe(200); expect((await edited.json() as { content: unknown }).content).toEqual(content);
    }
  });

  it("rejects malformed task items on both POST and author PATCH", async () => {
    const created = await request(`/api/projects/${projectId}/comments`, "comments-editor-token", "POST", { content: taskDoc(false) });
    const { id } = await created.json() as { id: string };
    const invalid = [
      { type: "doc", content: [{ type: "taskList", content: [{ type: "taskItem", attrs: { checked: false, extra: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Bad" }] }] }] }] },
      { type: "doc", content: [{ type: "taskList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Bad" }] }] }] }] },
    ];
    for (const content of invalid) {
      expect((await request(`/api/projects/${projectId}/comments`, "comments-editor-token", "POST", { content })).status).toBe(400);
      expect((await request(`/api/projects/${projectId}/comments/${id}`, "comments-editor-token", "PATCH", { content })).status).toBe(400);
    }
  });
});
