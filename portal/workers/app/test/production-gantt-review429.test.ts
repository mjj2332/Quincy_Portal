import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

/**
 * `/api/production-gantt` review fix on #429: the Project-level Deadline range and Overdue gate the Project
 * before either its own Deadline or a matching child can admit it, so People plus Overdue (or a Deadline
 * range) never lists a Project the range or Overdue excludes. The child page endpoint rejects those params,
 * so it cannot admit a Project on its own.
 */
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

async function insertUser(userId: string, role: string, token: string | null, name: string): Promise<void> {
  const now = Date.now();
  const statements = [database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, 0, ?, ?)").bind(userId, name, `${userId}@gantt429.test`, role, now, now)];
  if (token) statements.push(database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, token, userId, now, now));
  await database.DB.batch(statements);
}

async function insertProject(projectId: string, street: string, shoot: string | null, deadlineCivil: string | null = null): Promise<void> {
  const now = Date.now();
  const deadlineAt = deadlineCivil ? Date.parse(`${deadlineCivil}:00+10:00`) : null;
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, shoot_date, deadline_at, deadline_local_civil, deadline_zone, deadline_utc_offset_minutes, deadline_fold, deadline_version, created_at, updated_at) VALUES (?, ?, 'awaiting_raw', ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(projectId, street, shoot, deadlineAt, deadlineCivil, deadlineCivil ? "Australia/Sydney" : null, deadlineCivil ? 600 : null, deadlineCivil ? 0 : null, deadlineCivil ? 1 : 0, now, now).run();
}

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
declare const __PORTAL_MIGRATION_SQL__: string;

const adminId = "96111111-1111-4111-8111-111111111111";
const alexId = "96222222-2222-4222-8222-222222222222";
const blairId = "96333333-3333-4333-8333-333333333333";
const token = "t429gate-admin";
const id = (n: number) => `96a00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const pastOwn = id(1); // alex Edits it; Deadline 2026-08-27 (past)
const futureChild = id(2); // blair Edits it; Deadline 2099 (future); a Subtask assigned to alex
const pastChild = id(3); // blair Edits it; Deadline 2026-08-29 (past); a Subtask assigned to alex
const base = "scope=active&limit=200";

type Body = { projects: Array<{ id: string }> };

async function get(query: string): Promise<{ status: number; body: Body }> {
  const response = await SELF.fetch(`https://portal.test/api/production-gantt?${query}`, { headers: { cookie: await cookie(token) } });
  return { status: response.status, body: await response.json() as Body };
}
const ids = (body: Body) => body.projects.map((row) => row.id).filter((projectId) => projectId.startsWith("96a00000")).sort();

async function editor(projectId: string, userId: string): Promise<void> {
  await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, userId, Date.now()).run();
}

async function subtask(projectId: string, title: string, assignees: string[]): Promise<void> {
  const subtaskId = crypto.randomUUID();
  const now = Date.now();
  const statements = [database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_end_kind, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, 0, 1, '2026-08-27', 'date', '2026-08-27', 'date', 'Australia/Sydney', 1, ?, ?, ?)")
    .bind(subtaskId, projectId, title, adminId, now, now)];
  for (const [index, userId] of assignees.entries()) statements.push(database.DB.prepare("INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at) VALUES (?, ?, 1, ?)").bind(subtaskId, userId, now + index));
  await database.DB.batch(statements);
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await insertUser(adminId, "admin", token, "Admin Gate");
  await insertUser(alexId, "editor", null, "Alex Gate");
  await insertUser(blairId, "editor", null, "Blair Gate");
  await insertProject(pastOwn, "1 Gate Street", "2026-08-10", "2026-08-27T09:00");
  await editor(pastOwn, alexId);
  await insertProject(futureChild, "2 Gate Street", "2026-08-11", "2099-01-01T09:00");
  await editor(futureChild, blairId);
  await subtask(futureChild, "Alex task, future Deadline", [alexId]);
  await insertProject(pastChild, "3 Gate Street", "2026-08-12", "2026-08-29T09:00");
  await editor(pastChild, blairId);
  await subtask(pastChild, "Alex task, past Deadline", [alexId]);
});

describe("/api/production-gantt Deadline range and Overdue gate the matching-child branch (#429)", () => {
  it("People plus Overdue does not admit a Project with a future Deadline through its matching child", async () => {
    const { status, body } = await get(`${base}&editors=${alexId}&overdue=1`);
    expect(status).toBe(200);
    expect(ids(body)).toEqual([pastOwn, pastChild].sort());
  });

  it("People plus a Deadline range does not admit a Project outside the range through its matching child", async () => {
    const { status, body } = await get(`${base}&editors=${alexId}&deadline=2026-08-29..2026-08-29`);
    expect(status).toBe(200);
    expect(ids(body)).toEqual([pastChild]);
  });

  it("a Deadline range or Overdue alone is unchanged, and People alone still lists the context Project", async () => {
    expect(ids((await get(`${base}&overdue=1`)).body)).toEqual([pastOwn, pastChild].sort());
    expect(ids((await get(`${base}&editors=${alexId}`)).body)).toEqual([pastOwn, futureChild, pastChild].sort());
  });

  it("the child page endpoint refuses Overdue and Deadline range, so it cannot admit a Project on its own", async () => {
    for (const query of ["overdue=1", "deadline=2026-08-01..2026-08-31"]) {
      expect((await get(`scope=active&childrenOf=${futureChild}&editors=${alexId}&${query}`)).status, query).toBe(400);
    }
  });
});
