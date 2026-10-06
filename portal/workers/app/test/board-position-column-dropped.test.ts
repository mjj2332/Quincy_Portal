import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

/**
 * #475 (Board order Stage B): no app-Worker code reads or writes `projects.board_position`. The proof is this
 * suite: the migration chain (0064) drops the index and the column, then it drives every path that ever touched
 * them over HTTP. Any `no such column: board_position` (including a drizzle full-row select, which is a hidden
 * column read) is a 500 and fails a test here. This is what makes Stage B the proof for #476's DROP COLUMN (migration 0064).
 * Same pattern as #373's subtask-assignee-column-dropped.test.ts.
 */
const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const adminId = "a1111111-1111-4111-8111-111111111111";
const photographerId = "a3333333-3333-4333-8333-333333333333";
const externalId = "a4444444-4444-4444-8444-444444444444";
const tokens = { admin: "t475-admin", photographer: "t475-photographer", external: "t475-external" };
declare const __PORTAL_MIGRATION_SQL__: string;

async function executeSql(sql: string) { for (const chunk of sql.split("--> statement-breakpoint")) for (const statement of chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); } }
async function cookie(token: string) { const context = await createAuth(baseEnv).$context; return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`; }
async function request(path: string, token: string, method: "GET" | "POST" | "PATCH" | "DELETE" = "GET", body?: unknown) { const headers = new Headers({ cookie: await cookie(token) }); if (body !== undefined) headers.set("content-type", "application/json"); if (method !== "GET") headers.set("origin", baseEnv.APP_ORIGIN); return workerSelf.fetch(`https://portal.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }

let projectId = "";

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run();
  const now = Date.now();
  for (const [id, role] of [[adminId, "admin"], [photographerId, "photographer"], [externalId, "external_editor"]] as const) {
    await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, 0, ?, ?)").bind(id, `${role} ${id.slice(0, 2)}`, `${id}@example.test`, role, now, now).run();
  }
  for (const [key, userId] of [["admin", adminId], ["photographer", photographerId], ["external", externalId]] as const) {
    await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(`t475-${key}`, now + 3_600_000, tokens[key], userId, now, now).run();
  }
});

describe("with projects.board_position dropped", () => {
  it("the column and its index are really gone", async () => {
    const columns = (await database.DB.prepare("SELECT name FROM pragma_table_info('projects')").all<{ name: string }>()).results.map((row) => row.name);
    expect(columns).not.toContain("board_position");
    expect(columns).toContain("board_revision");
    expect((await database.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'projects_stage_archive_board_order_idx'").all()).results).toEqual([]);
  });

  it("creates a Project, then lists and reads it as admin, photographer and external editor", async () => {
    const created = await request("/api/projects", tokens.admin, "POST", { street: "No position street", orderedServices: [], photographerUserIds: [photographerId], editorUserIds: [externalId] });
    expect(created.status).toBe(201);
    projectId = (await created.json() as { id: string }).id;
    for (const token of Object.values(tokens)) {
      const list = await request("/api/projects", token);
      expect(list.status).toBe(200);
      const body = await list.json() as { projects: Array<{ id: string }> };
      expect(body.projects.some((project) => project.id === projectId)).toBe(true);
    }
    for (const token of Object.values(tokens)) expect((await request(`/api/projects/${projectId}`, token)).status).toBe(200);
  });

  it("sets Priority", async () => {
    const response = await request(`/api/projects/${projectId}/priority`, tokens.admin, "POST", { priority: 3 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ priority: 3, boardRevision: 0 });
  });

  it("moves a Stage with its confirmation round trip", async () => {
    const body = { expected: { stageKey: "awaiting_raw", boardRevision: 0 }, targetStageKey: "delivered", placement: { kind: "append" } };
    const first = await request(`/api/projects/${projectId}/stage`, tokens.admin, "POST", body);
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({ code: "stage_confirmation_required" });
    const confirmed = await request(`/api/projects/${projectId}/stage`, tokens.admin, "POST", { ...body, confirmation: { reasons: ["skipped_forward", "delivered_boundary"] } });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ changed: true, project: { stageKey: "delivered", boardRevision: 1 } });
  });

  it("archives and restores", async () => {
    expect((await request(`/api/projects/${projectId}/archive`, tokens.admin, "POST")).status).toBe(200);
    expect((await request(`/api/projects/${projectId}/restore`, tokens.admin, "POST")).status).toBe(200);
  });

  it("auto-advances a direct RAW upload out of Awaiting RAW", async () => {
    const created = await request("/api/projects", tokens.admin, "POST", { street: "No position RAW street", orderedServices: [] });
    expect(created.status).toBe(201);
    const id = (await created.json() as { id: string }).id;
    const assetId = crypto.randomUUID();
    const key = `projects/${id}/raw/${assetId}/dropped.jpg`;
    await baseEnv.MEDIA.put(key, "dropped-jpeg", { httpMetadata: { contentType: "image/jpeg" } });
    const response = await request("/api/uploads/complete", tokens.admin, "POST", { projectId: id, key, originalFilename: "dropped.jpg", collection: "raw" });
    expect(response.status).toBe(201);
    expect(await database.DB.prepare("SELECT stage_key, board_revision FROM projects WHERE id = ?").bind(id).first()).toEqual({ stage_key: "raw_review", board_revision: 1 });
    expect((await database.DB.prepare("SELECT count(*) AS count FROM notifications WHERE project_id = ? AND type = 'raw_ready'").bind(id).first<{ count: number }>())!.count).toBeGreaterThan(0);
  });
});
