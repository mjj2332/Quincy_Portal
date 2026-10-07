import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

/**
 * #680: on the Timeline, My tasks in a Subtask's context is "Editor of its Project OR its assignee". A Project I edit
 * lists every Subtask (paged, completed toggle honoured); an External Editor only sees Projects they edit, so My tasks
 * shows them the same rows as no filter.
 */

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
declare const __PORTAL_MIGRATION_SQL__: string;

const adminId = "97111111-1111-4111-8111-111111111111";
const alexId = "97222222-2222-4222-8222-222222222222";
const blairId = "97333333-3333-4333-8333-333333333333";
const extId = "97444444-4444-4444-8444-444444444444";
const tokens = { alex: "t680-alex", ext: "t680-ext" };
const id = (n: number) => `97a00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const big = id(1); // Editor alex; 105 subtasks assigned to blair
const done = id(2); // Editor alex; open O1 (blair), completed D1 (blair)
const extP = id(3); // Editor ext; subtasks E1 (alex), E2 (unassigned)
const base = "scope=active&limit=200";

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

type Child = { id: string; title: string };
type Row = { id: string; children: { rows: Child[]; total: number; returned: number; truncated: boolean; nextCursor: string | null } };
type Body = { projects: Row[] };
type ChildBody = { projectId: string; children: Row["children"] };

async function get<T>(query: string, token: string): Promise<{ status: number; body: T }> {
  const response = await SELF.fetch(`https://portal.test/api/production-gantt?${query}`, { headers: { cookie: await cookie(token) } });
  return { status: response.status, body: await response.json() as T };
}

const titles = (row: Row | undefined) => (row?.children.rows ?? []).map((child) => child.title);
const rowOf = (body: Body, projectId: string) => body.projects.find((row) => row.id === projectId);

async function insertUser(userId: string, role: string, token: string | null, name: string): Promise<void> {
  const now = Date.now();
  const statements = [database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, 0, ?, ?)").bind(userId, name, `${userId}@gantt680.test`, role, now, now)];
  if (token) statements.push(database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, token, userId, now, now));
  await database.DB.batch(statements);
}

async function insertProject(projectId: string, street: string, shoot: string, deadlineCivil: string): Promise<void> {
  const now = Date.now();
  const deadlineAt = Date.parse(`${deadlineCivil}:00+10:00`);
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, shoot_date, deadline_at, deadline_local_civil, deadline_zone, deadline_utc_offset_minutes, deadline_fold, deadline_version, created_at, updated_at) VALUES (?, ?, 'awaiting_raw', ?, ?, ?, 'Australia/Sydney', 600, 0, 1, ?, ?)")
    .bind(projectId, street, shoot, deadlineAt, deadlineCivil, now, now).run();
}

async function editor(projectId: string, userId: string): Promise<void> {
  await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, userId, Date.now()).run();
}

async function subtask(projectId: string, title: string, position: number, assignees: string[]): Promise<void> {
  const subtaskId = crypto.randomUUID();
  const now = Date.now();
  const statements = [database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 1, '2026-08-27T17:00', 'timed', '2026-08-27T09:00', 1787785200000, 600, 0, 'timed', 1787814000000, 600, 0, 'Australia/Sydney', 1, ?, ?, ?)")
    .bind(subtaskId, projectId, title, position, adminId, now, now)];
  for (const [index, userId] of assignees.entries()) statements.push(database.DB.prepare("INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at) VALUES (?, ?, 1, ?)").bind(subtaskId, userId, now + index));
  await database.DB.batch(statements);
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await insertUser(adminId, "admin", null, "Admin 680");
  await insertUser(alexId, "editor", tokens.alex, "Alex 680");
  await insertUser(blairId, "editor", null, "Blair 680");
  await insertUser(extId, "external_editor", tokens.ext, "External 680");
  await insertProject(big, "1 Mine Street", "2026-08-10", "2026-08-27T09:00");
  await editor(big, alexId);
  for (let index = 0; index < 105; index += 1) await subtask(big, `C${String(index).padStart(3, "0")}`, index, [blairId]);
  await insertProject(done, "2 Mine Street", "2026-08-11", "2026-08-28T09:00");
  await editor(done, alexId);
  await subtask(done, "O1", 0, [blairId]);
  await subtask(done, "D1", 1, [blairId]);
  await database.DB.prepare("UPDATE project_subtasks SET done = 1 WHERE project_id = ? AND title = 'D1'").bind(done).run();
  await insertProject(extP, "3 Mine Street", "2026-08-12", "2026-08-29T09:00");
  await editor(extP, extId);
  await subtask(extP, "E1", 0, [alexId]);
  await subtask(extP, "E2", 1, []);
});

describe("/api/production-gantt My tasks on a Project I edit (#680)", () => {
  it("a continuation walk over more Subtasks than one page: stable totals, no gaps, no duplicates, ends with null", async () => {
    const first = await get<Body>(`${base}&mine=1`, tokens.alex);
    const row = rowOf(first.body, big)!;
    expect(row.children.total).toBe(105);
    expect(row.children.returned).toBe(100);
    expect(row.children.truncated).toBe(true);
    const seen = titles(row);
    let cursor = row.children.nextCursor;
    let pages = 0;
    while (cursor) {
      const page = await get<ChildBody>(`scope=active&childrenOf=${big}&childCursor=${cursor}&mine=1`, tokens.alex);
      expect(page.status).toBe(200);
      expect(page.body.children.total).toBe(105);
      seen.push(...page.body.children.rows.map((child) => child.title));
      cursor = page.body.children.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(5);
    }
    expect(seen).toHaveLength(105);
    expect(new Set(seen).size).toBe(105);
    expect([...seen].sort()).toEqual(Array.from({ length: 105 }, (_, index) => `C${String(index).padStart(3, "0")}`));
  });

  it("completed Subtasks are hidden by default and shown with completed=1", async () => {
    const hidden = await get<Body>(`${base}&mine=1`, tokens.alex);
    expect(titles(rowOf(hidden.body, done))).toEqual(["O1"]);
    expect(rowOf(hidden.body, done)?.children.total).toBe(1);
    const shown = await get<Body>(`${base}&mine=1&completed=1`, tokens.alex);
    expect(titles(rowOf(shown.body, done))).toEqual(["O1", "D1"]);
    expect(rowOf(shown.body, done)?.children.total).toBe(2);
  });

  it("an External Editor: My tasks on a Project they edit returns all its Subtasks, the same as no filter", async () => {
    const filtered = await get<Body>(`${base}&mine=1`, tokens.ext);
    const unfiltered = await get<Body>(base, tokens.ext);
    expect(filtered.status).toBe(200);
    expect(filtered.body.projects.map((row) => row.id)).toEqual(unfiltered.body.projects.map((row) => row.id));
    expect(titles(rowOf(filtered.body, extP))).toEqual(titles(rowOf(unfiltered.body, extP)));
    expect(titles(rowOf(filtered.body, extP)).length).toBeGreaterThan(0);
  });
});
