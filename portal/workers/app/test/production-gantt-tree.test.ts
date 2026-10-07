import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

/**
 * `/api/production-gantt`'s People, Unassigned, My tasks and range facets -- #429: a Project row is listed
 * when its own Deadline matches OR a visible checklist row does (then it is a context row and the Deadline
 * bar is suppressed through the `dm=1` marker); children, `total`, the child pages and the child cursor
 * all carry the People filter.
 */

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
declare const __PORTAL_MIGRATION_SQL__: string;

const adminId = "94111111-1111-4111-8111-111111111111";
const alexId = "94222222-2222-4222-8222-222222222222";
const blairId = "94333333-3333-4333-8333-333333333333";
const tokens = { admin: "t429g-admin", alex: "t429g-alex" };
const id = (n: number) => `94a00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const g1 = id(1); // Editor alex; subtasks A1 (alex), B1 (blair)
const g2 = id(2); // no Editor; subtask B2 (blair)
const g3 = id(3); // Editor blair; subtasks A3 (alex), U3 (unassigned)
const g4 = id(4); // Editor blair; no subtasks
const g5 = id(5); // no Editor; 105 subtasks all assigned to blair
const g6 = id(6); // Editor alex; Deadline in 2020, overdue; shoot 2026-08-10
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
type Row = { id: string; deadlineInScope?: boolean; deadline: unknown; children: { rows: Child[]; total: number; returned: number; truncated: boolean; nextCursor: string | null } };
type Body = { projects: Row[]; density: { matchedProjects: number; matchedRows: number }; error?: string; code?: string };
type ChildBody = { projectId: string; children: Row["children"] };

async function get<T>(query: string, token: string): Promise<{ status: number; body: T }> {
  const response = await SELF.fetch(`https://portal.test/api/production-gantt?${query}`, { headers: { cookie: await cookie(token) } });
  return { status: response.status, body: await response.json() as T };
}

const mine = (body: Body) => body.projects.map((row) => row.id).filter((projectId) => projectId.startsWith("94a00000")).sort();
const titles = (row: Row | undefined) => (row?.children.rows ?? []).map((child) => child.title);
const rowOf = (body: Body, projectId: string) => body.projects.find((row) => row.id === projectId);

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
  await insertUser(adminId, "admin", tokens.admin, "Admin Gantt");
  await insertUser(alexId, "editor", tokens.alex, "Alex Gantt");
  await insertUser(blairId, "editor", null, "Blair Gantt");
  await insertProject(g1, "1 Gantt People Street", "2026-08-10", "2026-08-27T09:00");
  await editor(g1, alexId);
  await subtask(g1, "A1", 0, [alexId]);
  await subtask(g1, "B1", 1, [blairId]);
  await insertProject(g2, "2 Gantt People Street", "2026-08-11", "2026-08-28T09:00");
  await subtask(g2, "B2", 0, [blairId]);
  await insertProject(g3, "3 Gantt People Street", "2026-08-12", "2026-08-29T09:00");
  await editor(g3, blairId);
  await subtask(g3, "A3", 0, [alexId]);
  await subtask(g3, "U3", 1, []);
  await insertProject(g4, "4 Gantt People Street", "2026-08-13");
  await editor(g4, blairId);
  await insertProject(g5, "5 Gantt People Street", "2026-08-14");
  for (let index = 0; index < 105; index += 1) await subtask(g5, `C${String(index).padStart(3, "0")}`, index, [blairId]);
  await insertProject(g6, "6 Gantt People Street", "2026-08-10", "2020-06-10T09:00");
  await editor(g6, alexId);
});

const F = (tree: string, extra = "") => `${base}&f=${encodeURIComponent(tree)}${extra}`;

describe("/api/production-gantt filter tree (#461), over the #429 People seed", () => {
  it("OR across fields: a person's Projects (context rows included) OR a Shoot date", async () => {
    const { status, body } = await get<Body>(F(`1:or(people=${alexId};shoot=2026-08-13..2026-08-14)`, "&dm=1"), tokens.admin);
    expect(status).toBe(200);
    expect(mine(body)).toEqual([g1, g3, g4, g5, g6].sort());
    expect(titles(rowOf(body, g1))).toEqual(["A1"]);
    // g4 matches by its Shoot date alone: deadline context, no child filter narrows through a non-matching Subtask.
    expect(rowOf(body, g4)?.deadlineInScope).toBe(true);
  });

  it("negation and a repeated field", async () => {
    const { body } = await get<Body>(F(`1:and(!people=${alexId};!shoot=2026-08-10..2026-08-10)`), tokens.admin);
    expect(mine(body)).toEqual([g2, g3, g4, g5].sort());
    const twice = await get<Body>(F(`1:or(people=${alexId};people=${blairId})`), tokens.admin);
    expect(mine(twice.body)).toEqual([g1, g2, g3, g4, g5, g6].sort());
  });

  it("a People rule naming only unknown ids is dropped inside an OR", async () => {
    const unknown = "94eeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const a = await get<Body>(F(`1:or(people=${unknown};shoot=2026-08-14..2026-08-14)`), tokens.admin);
    expect(mine(a.body)).toEqual([g5]);
    expect(a.body.appliedFilters.editorIds).toEqual([]);
  });

  it("echoes the tree; a legacy request never carries the key", async () => {
    const tree = await get<Body>(F(`1:or(people=${alexId};overdue)`), tokens.admin);
    expect((tree.body.appliedFilters as { tree?: unknown }).tree).toBeDefined();
    const legacy = await get<Body>(`${base}&editors=${alexId}`, tokens.admin);
    expect("tree" in legacy.body.appliedFilters).toBe(false);
  });

  it("a child page under f= carries the tree's fingerprint; a legacy cursor is refused and vice versa", async () => {
    const tree = `1:or(people=${blairId};overdue)`;
    const first = await get<Body>(F(tree), tokens.admin);
    const cursor = rowOf(first.body, g5)!.children.nextCursor!;
    expect(cursor).toBeTruthy();
    const next = await get<ChildBody>(`scope=active&childrenOf=${g5}&childCursor=${cursor}&f=${encodeURIComponent(tree)}`, tokens.admin);
    expect(next.status).toBe(200);
    expect(next.body.children).toMatchObject({ total: 105, returned: 5, truncated: false });
    expect((await get<ChildBody>(`scope=active&childrenOf=${g5}&childCursor=${cursor}&editors=${blairId}`, tokens.admin)).status).toBe(400);
    expect((await get<ChildBody>(`scope=active&childrenOf=${g5}&childCursor=${cursor}&f=${encodeURIComponent(`1:or(people=${alexId};overdue)`)}`, tokens.admin)).status).toBe(400);
  });

  it("refuses f beside a legacy facet, a malformed or legacy-expressible tree, and a role rule behind OR", async () => {
    expect((await get<Body>(F("1:or(mine;overdue)", "&unassigned=1"), tokens.admin)).status).toBe(400);
    expect((await get<Body>(F("1:or()"), tokens.admin)).status).toBe(400);
    expect((await get<Body>(F("1:and(mine;overdue)"), tokens.admin)).status).toBe(400);
    expect((await get<Body>(F("1:or(archived=only;mine)"), tokens.alex)).status).toBe(403);
  });
});

describe("/api/production-gantt My tasks in a tree (#680)", () => {
  it("an OR tree whose other rule matches nothing equals flat mine=1: every Subtask of a Project I edit, my own elsewhere", async () => {
    const flat = await get<Body>(`${base}&mine=1&dm=1`, tokens.alex);
    const tree = await get<Body>(F("1:or(mine;shoot=2000-01-01..2000-01-02)", "&dm=1"), tokens.alex);
    expect(tree.status).toBe(200);
    expect(mine(tree.body)).toEqual(mine(flat.body));
    for (const projectId of [g1, g3, g6]) expect(titles(rowOf(tree.body, projectId))).toEqual(titles(rowOf(flat.body, projectId)));
    expect(titles(rowOf(tree.body, g1))).toEqual(["A1", "B1"]);
  });

  it("!mine is the strict complement: a Project I edit drops out completely", async () => {
    const { body } = await get<Body>(F("1:and(!mine)"), tokens.alex);
    expect(mine(body)).not.toContain(g1);
    expect(mine(body)).not.toContain(g6);
    // g3 is not mine as a Project, but A3 is: !mine keeps only its other Subtask.
    expect(titles(rowOf(body, g3))).toEqual(["U3"]);
    expect(mine(body)).toEqual([g2, g3, g4, g5].sort());
  });

  it("mine inside an OR with a date rule", async () => {
    const { body } = await get<Body>(F("1:or(mine;shoot=2026-08-13..2026-08-14)", "&dm=1"), tokens.alex);
    expect(mine(body)).toEqual([g1, g3, g4, g5, g6].sort());
    expect(titles(rowOf(body, g1))).toEqual(["A1", "B1"]);
    expect(titles(rowOf(body, g3))).toEqual(["A3"]);
  });
});

