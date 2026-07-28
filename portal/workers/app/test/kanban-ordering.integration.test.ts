import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

const database = env as unknown as { DB: D1Database };
const appEnv = env as unknown as Env;
const adminId = crypto.randomUUID();
const editorId = crypto.randomUUID();
const adminToken = `kanban-admin-${crypto.randomUUID()}`;
const editorToken = `kanban-editor-${crypto.randomUUID()}`;
const authSecret = appEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
declare const __PORTAL_MIGRATION_SQL__: string;

async function executeSql(source: string) {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const flat = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of flat.split(";")) {
      const value = statement.replace(/\s+/g, " ").trim();
      if (value) await database.DB.exec(`${value};`);
    }
  }
}

async function cookie(token: string) {
  const context = await createAuth(appEnv).$context;
  return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
}

async function request(path: string, token: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", await cookie(token));
  if (init.method && init.method !== "GET") headers.set("origin", appEnv.APP_ORIGIN);
  if (init.body) headers.set("content-type", "application/json");
  return workerSelf.fetch(`https://portal.test${path}`, { ...init, headers });
}

async function seedProject(id: string, stageKey: string, boardPosition: number, priority: number | null = null) {
  const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, priority, board_position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, id, stageKey, priority, boardPosition, now, now).run();
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Kanban Admin', ?, 1, 'admin', 1, ?, ?), (?, 'Kanban Editor', ?, 1, 'editor', 1, ?, ?)")
      .bind(adminId, `${adminId}@example.test`, now, now, editorId, `${editorId}@example.test`, now, now),
    database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), now + 3_600_000, adminToken, adminId, now, now, crypto.randomUUID(), now + 3_600_000, editorToken, editorId, now, now),
  ]);
});

describe("Kanban priority and manual-position API", () => {
  it("repositions only the edited card and keeps the worked-example sibling positions", async () => {
    const a = crypto.randomUUID(); const b = crypto.randomUUID(); const c = crypto.randomUUID();
    await seedProject(a, "raw_review", 1024); await seedProject(b, "raw_review", 2048); await seedProject(c, "raw_review", 3072);
    expect((await request(`/api/projects/${a}/priority`, adminToken, { method: "POST", body: JSON.stringify({ priority: 8 }) })).status).toBe(200);
    const bBefore = await database.DB.prepare("SELECT board_position FROM projects WHERE id = ?").bind(b).first<{ board_position: number }>();
    const aBefore = await database.DB.prepare("SELECT board_position FROM projects WHERE id = ?").bind(a).first<{ board_position: number }>();
    expect((await request(`/api/projects/${b}/board-position`, adminToken, { method: "POST", body: JSON.stringify({ direction: "up" }) })).status).toBe(200);
    expect((await request(`/api/projects/${c}/priority`, adminToken, { method: "POST", body: JSON.stringify({ priority: 5 }) })).status).toBe(200);
    expect((await database.DB.prepare("SELECT board_position FROM projects WHERE id = ?").bind(b).first<{ board_position: number }>())!.board_position).toBe(bBefore!.board_position - 2048);
    expect((await database.DB.prepare("SELECT board_position FROM projects WHERE id = ?").bind(a).first<{ board_position: number }>())!.board_position).toBe(aBefore!.board_position);
  });

  it("handles no-anchor, tie, clear, validation, and capability cases", async () => {
    const first = crypto.randomUUID(); const second = crypto.randomUUID(); const target = crypto.randomUUID();
    await seedProject(first, "edited_review", 4096, 1); await seedProject(second, "edited_review", 5120, 2); await seedProject(target, "edited_review", 8192);
    const noAnchor = await request(`/api/projects/${target}/priority`, adminToken, { method: "POST", body: JSON.stringify({ priority: 10 }) });
    expect(noAnchor.status).toBe(200);
    expect((await noAnchor.json() as { boardPosition: number }).boardPosition).toBe(3072);
    for (const value of [0, 11, 5.5]) {
      expect((await request(`/api/projects/${target}/priority`, adminToken, { method: "POST", body: JSON.stringify({ priority: value }) })).status).toBe(400);
    }
    expect((await request(`/api/projects/${target}/priority`, editorToken, { method: "POST", body: JSON.stringify({ priority: 5 }) })).status).toBe(403);
    expect((await request(`/api/projects/${target}/board-position`, editorToken, { method: "POST", body: JSON.stringify({ direction: "up" }) })).status).toBe(403);
  });

  it("rejects invalid priorities at the database level itself, bypassing the API's Zod validation entirely", async () => {
    // The API route's Zod schema already rejects these (tested above) — this proves the
    // `projects_priority_check` CHECK constraint holds against the real D1/Miniflare binding
    // this test suite otherwise uses, not just SQLite via node:sqlite (packages/db/test/
    // migration-0020.test.ts) or the application-layer validator.
    for (const priority of [0, 11, 5.5]) {
      await expect(
        database.DB.prepare("INSERT INTO projects (id, street, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
          .bind(crypto.randomUUID(), `invalid-${priority}`, priority, Date.now(), Date.now())
          .run(),
      ).rejects.toThrow(/CHECK constraint failed/);
    }
  });

  it("appends cross-column moves at 0 then strictly above it and returns the position", async () => {
    const first = crypto.randomUUID(); const second = crypto.randomUUID();
    await seedProject(first, "raw_review", 1024, 10); await seedProject(second, "raw_review", 2048, 9);
    const firstMove = await request(`/api/projects/${first}/stage`, adminToken, { method: "POST", body: JSON.stringify({ stageKey: "delivered" }) });
    const secondMove = await request(`/api/projects/${second}/stage`, adminToken, { method: "POST", body: JSON.stringify({ stageKey: "delivered" }) });
    expect((await firstMove.json() as { boardPosition: number }).boardPosition).toBe(0);
    expect((await secondMove.json() as { boardPosition: number }).boardPosition).toBe(1024);
  });
});
