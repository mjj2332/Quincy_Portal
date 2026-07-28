import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const adminToken = "notice-board-admin-session-token";
const editorToken = "notice-board-editor-session-token";
const photographerToken = "notice-board-photographer-session-token";
const adminId = "44444444-4444-4444-8444-444444444444";
const editorId = "55555555-5555-4555-8555-555555555555";
const photographerId = "66666666-6666-4666-8666-666666666666";
declare const __PORTAL_MIGRATION_SQL__: string;
declare const __PORTAL_SEED_SQL__: string;

async function executeSql(sql: string): Promise<void> {
  for (const chunk of sql.split("--> statement-breakpoint")) {
    const withoutComments = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of withoutComments.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

async function sessionCookie(token: string): Promise<string> {
  const context = await createAuth(baseEnv).$context;
  return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
}

async function request(path: string, token: string, method: "GET" | "POST" | "DELETE" = "GET", body?: unknown): Promise<Response> {
  const headers = new Headers({ cookie: await sessionCookie(token) });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (method !== "GET") headers.set("origin", baseEnv.APP_ORIGIN);
  return workerSelf.fetch(`https://portal.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await executeSql(__PORTAL_SEED_SQL__);
  const now = Date.now();
  for (const [id, name, email, role] of [
    [adminId, "Notice Admin", "notice-admin@example.test", "admin"],
    [editorId, "Notice Editor", "notice-editor@example.test", "editor"],
    [photographerId, "Notice Photographer", "notice-photographer@example.test", "photographer"],
  ]) {
    await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, ?, ?)")
      .bind(id, name, email, role, now, now).run();
  }
  for (const [id, token, userId] of [
    ["notice-admin-session", adminToken, adminId],
    ["notice-editor-session", editorToken, editorId],
    ["notice-photographer-session", photographerToken, photographerId],
  ]) {
    await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, now + 60 * 60 * 1000, token, userId, now, now).run();
  }
});

describe("notice board API", () => {
  it("returns an empty latest cursor before the first post", async () => {
    const response = await request("/api/notice-board/posts/latest", editorToken);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: null, createdAt: null });
  });

  it("allows an editor through every route and supports create/list/latest/delete", async () => {
    const created = await request("/api/notice-board/posts", editorToken, "POST", { body: "Editor notice" });
    expect(created.status).toBe(201);
    const post = await created.json() as { id: string; authorId: string; authorName: string; body: string; createdAt: string };
    expect(post).toMatchObject({ authorId: editorId, authorName: "Notice Editor", body: "Editor notice" });

    const list = await request("/api/notice-board/posts", editorToken);
    expect(list.status).toBe(200);
    expect((await list.json() as { posts: Array<{ id: string }> }).posts[0]?.id).toBe(post.id);
    const latest = await request("/api/notice-board/posts/latest", editorToken);
    expect(latest.status).toBe(200);
    expect(await latest.json()).toMatchObject({ id: post.id });
    const deleted = await request(`/api/notice-board/posts/${post.id}`, editorToken, "DELETE");
    expect(deleted.status).toBe(200);
  });

  it("rejects invalid body lengths and invalid limits", async () => {
    for (const body of ["", "x".repeat(2_001)]) {
      expect((await request("/api/notice-board/posts", editorToken, "POST", { body })).status).toBe(400);
    }
    for (const limit of ["0", "-1", "1.5", "51"]) {
      expect((await request(`/api/notice-board/posts?limit=${limit}`, editorToken)).status).toBe(400);
    }
  });

  it("keeps deletion author-only, including for an admin", async () => {
    const created = await request("/api/notice-board/posts", editorToken, "POST", { body: "Keep author-only" });
    const post = await created.json() as { id: string };
    expect((await request(`/api/notice-board/posts/${post.id}`, adminToken, "DELETE")).status).toBe(403);
    expect((await request(`/api/notice-board/posts/${post.id}`, editorToken, "DELETE")).status).toBe(200);
  });

  it("returns newest-first with an id tie-break and caps lists at fifty", async () => {
    const now = Date.now() - 10_000;
    const ids = Array.from({ length: 52 }, (_, index) => `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`);
    await database.DB.batch(ids.map((id) => database.DB.prepare("INSERT INTO notice_board_posts (id, author_id, body, created_at) VALUES (?, ?, ?, ?)").bind(id, editorId, id, now)));
    const response = await request("/api/notice-board/posts?limit=100", editorToken);
    expect(response.status).toBe(400);
    const capped = await request("/api/notice-board/posts?limit=50", editorToken);
    const posts = (await capped.json() as { posts: Array<{ id: string }> }).posts;
    expect(posts).toHaveLength(50);
    expect(posts[0]?.id).toBe(ids[51]);
    expect(posts[1]?.id).toBe(ids[50]);
    const latest = await request("/api/notice-board/posts/latest", editorToken);
    expect(await latest.json()).toMatchObject({ id: ids[51] });
  });

  it("denies photographers on every route", async () => {
    const routes: Array<[string, "GET" | "POST" | "DELETE", unknown?]> = [
      ["/api/notice-board/posts", "GET"],
      ["/api/notice-board/posts/latest", "GET"],
      ["/api/notice-board/posts", "POST", { body: "No access" }],
      ["/api/notice-board/posts/00000000-0000-4000-8000-000000000001", "DELETE"],
    ];
    for (const [path, method, body] of routes) expect((await request(path, photographerToken, method, body)).status).toBe(403);
  });
});
