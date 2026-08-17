import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

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
    const secondResponse = await request(`/api/projects/${projectId}/comments`, "comments-editor-token", "POST", { content: doc("Second comment") });
    const thirdResponse = await request(`/api/projects/${projectId}/comments`, "comments-editor-token", "POST", { content: doc("Third comment") });
    expect(secondResponse.status).toBe(201); expect(thirdResponse.status).toBe(201);
    const second = await secondResponse.json() as { id: string }; const third = await thirdResponse.json() as { id: string };
    const createdAt = Date.now() - 10_000;
    await database.DB.batch([first, second, third].map((comment, index) => database.DB.prepare("UPDATE project_comments SET created_at = ? WHERE id = ?").bind(createdAt + index * 1_000, comment.id)));
    expect(first.body).toBe("admin 1111"); expect(first.content.content[0]!.content[0]!.attrs?.label).toBe("admin 1111");
    const mention = (await database.DB.prepare("SELECT id, mentioned_user_id FROM project_comment_mentions WHERE comment_id = ?").bind(first.id).first<{ id: string; mentioned_user_id: string }>())!;
    expect(mention.mentioned_user_id).toBe(adminId);
    expect(await database.DB.prepare("SELECT type, source_key, project_id FROM notifications WHERE user_id = ? AND source_key = ?").bind(adminId, mention.id).first()).toMatchObject({ type: "mentioned", source_key: mention.id, project_id: projectId });
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
});
