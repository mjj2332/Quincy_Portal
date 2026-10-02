import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

/** #461 PR A fix round: the Gantt role gates on child requests and the standalone child page's parent check. */

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
declare const __PORTAL_MIGRATION_SQL__: string;

const adminId = "95111111-1111-4111-8111-111111111111";
const externalId = "95222222-2222-4222-8222-222222222222";
const tokens = { admin: "t461r-admin", external: "t461r-external" };
const editingProject = "95a00000-0000-4000-8000-000000000001";
const awaitingProject = "95a00000-0000-4000-8000-000000000002";

async function executeSql(sql: string): Promise<void> {
  for (const chunk of sql.split("--> statement-breakpoint")) {
    const withoutComments = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of withoutComments.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

async function cookie(token: string): Promise<string> {
  const context = await createAuth(baseEnv).$context;
  return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
}

async function get<T>(query: string, token: string): Promise<{ status: number; body: T }> {
  const response = await SELF.fetch(`https://portal.test/api/production-gantt?${query}`, { headers: { cookie: await cookie(token) } });
  return { status: response.status, body: await response.json() as T };
}

async function insertUser(userId: string, role: string, token: string, name: string): Promise<void> {
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, 0, ?, ?)").bind(userId, name, `${userId}@gantt461r.test`, role, now, now),
    database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, token, userId, now, now),
  ]);
}

async function insertProject(projectId: string, street: string, stage: string): Promise<void> {
  const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, shoot_date, created_at, updated_at) VALUES (?, ?, ?, '2026-08-10', ?, ?)").bind(projectId, street, stage, now, now).run();
}

async function subtask(projectId: string, title: string, position: number): Promise<void> {
  const now = Date.now();
  await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 1, '2026-08-27T17:00', 'timed', '2026-08-27T09:00', 1787785200000, 600, 0, 'timed', 1787814000000, 600, 0, 'Australia/Sydney', 1, ?, ?, ?)")
    .bind(crypto.randomUUID(), projectId, title, position, adminId, now, now).run();
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await insertUser(adminId, "admin", tokens.admin, "Admin Review");
  await insertUser(externalId, "external_editor", tokens.external, "External Review");
  await insertProject(editingProject, "1 Review Street", "editing_autohdr");
  await subtask(editingProject, "E1", 0);
  await insertProject(awaitingProject, "2 Review Street", "awaiting_raw");
  await subtask(awaitingProject, "W1", 0);
});

const F = (tree: string) => `f=${encodeURIComponent(tree)}`;

describe("#461 fix round: Gantt role gates run on every mode", () => {
  it("an External Editor's Priority rule is refused on a child request, as on the page", async () => {
    const tree = `1:or(priority=5;!mine)`;
    expect((await get(`scope=active&${F(tree)}`, tokens.external)).status).toBe(400);
    expect((await get(`scope=active&childrenOf=${awaitingProject}&${F(tree)}`, tokens.external)).status).toBe(400);
  });

  it("a non-Admin Archived rule is refused on a child request", async () => {
    const tree = `1:or(archived=only;!mine)`;
    expect((await get(`scope=active&childrenOf=${awaitingProject}&${F(tree)}`, tokens.external)).status).toBe(403);
  });
});

describe("#461 fix round: a standalone child request verifies its parent passes the tree", () => {
  it("childrenOf under a tree with no People / My tasks rule returns nothing for a parent the tree excludes", async () => {
    const tree = `1:and(!stages=editing)`;
    const excluded = await get<{ children: { total: number; rows: unknown[] } }>(`scope=active&childrenOf=${editingProject}&${F(tree)}`, tokens.admin);
    expect(excluded.status).toBe(200);
    expect(excluded.body.children.total).toBe(0);
    expect(excluded.body.children.rows).toEqual([]);
    const included = await get<{ children: { total: number } }>(`scope=active&childrenOf=${awaitingProject}&${F(tree)}`, tokens.admin);
    expect(included.body.children.total).toBe(1);
  });
});
