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

describe("/api/production-gantt People, Unassigned and My tasks (#429)", () => {
  it("lists a Project whose Editor matches, with only the matching children, and a context row for a matching child alone", async () => {
    const { status, body } = await get<Body>(`${base}&editors=${alexId}&dm=1`, tokens.admin);
    expect(status).toBe(200);
    // g1 and g6 are Edited by alex; g3 holds alex's subtask A3 (blair is its Editor).
    expect(mine(body)).toEqual([g1, g3, g6].sort());
    expect(titles(rowOf(body, g1))).toEqual(["A1"]);
    expect(titles(rowOf(body, g3))).toEqual(["A3"]);
    expect(rowOf(body, g1)?.children).toMatchObject({ total: 1, returned: 1, truncated: false });
    // The Deadline bar is drawn for a Project whose own Deadline matched, never for a context parent.
    expect(rowOf(body, g1)?.deadlineInScope).toBe(true);
    expect(rowOf(body, g6)?.deadlineInScope).toBe(true);
    expect(rowOf(body, g3)?.deadlineInScope).toBe(false);
    // The Deadline itself is untouched on the context row.
    expect(rowOf(body, g3)?.deadline).not.toBeNull();
  });

  it("without dm=1 the marker is absent, so an older bundle's strict decoder never meets it", async () => {
    const { body } = await get<Body>(`${base}&editors=${alexId}`, tokens.admin);
    expect(rowOf(body, g3)).not.toHaveProperty("deadlineInScope");
  });

  it("Unassigned alone: Projects with no Editor, or with an unassigned checklist row", async () => {
    const { body } = await get<Body>(`${base}&unassigned=1&dm=1`, tokens.admin);
    expect(mine(body)).toEqual([g2, g3, g5].sort());
    expect(rowOf(body, g2)?.deadlineInScope).toBe(true);
    expect(rowOf(body, g5)?.deadlineInScope).toBe(true);
    // g2 has no Editor so its row matches by Deadline, and its only child is assigned: none are shown.
    expect(titles(rowOf(body, g2))).toEqual([]);
    expect(titles(rowOf(body, g3))).toEqual(["U3"]);
    expect(rowOf(body, g3)?.deadlineInScope).toBe(false);
  });

  it("an unknown id applies no People filter; unknown beside a known one narrows by the known one", async () => {
    const all = await get<Body>(base, tokens.admin);
    const unknown = await get<Body>(`${base}&editors=94eeeeee-eeee-4eee-8eee-eeeeeeeeeeee`, tokens.admin);
    expect(mine(unknown.body)).toEqual(mine(all.body));
    const mixed = await get<Body>(`${base}&editors=94eeeeee-eeee-4eee-8eee-eeeeeeeeeeee,${alexId}`, tokens.admin);
    expect(mine(mixed.body)).toEqual([g1, g3, g6].sort());
  });

  it("My tasks is People = me: the session user as Editor or checklist assignee", async () => {
    const { body } = await get<Body>(`${base}&mine=1&dm=1`, tokens.alex);
    expect(mine(body)).toEqual([g1, g3, g6].sort());
    expect(titles(rowOf(body, g1))).toEqual(["A1"]);
  });

  it("density and the page's totals describe the filtered set; the checklist progress counts stay whole", async () => {
    const { body } = await get<Body>(`${base}&editors=${alexId}`, tokens.admin);
    const inScope = body.projects.filter((row) => mine({ projects: [row] } as Body).length === 1);
    expect(body.density.matchedProjects).toBe(inScope.length);
    // g1 has two checklist rows overall, one of them alex's.
    expect(rowOf(body, g1)).toMatchObject({ checklist: { total: 2 } });
    expect(rowOf(body, g1)?.children.total).toBe(1);
  });
});

describe("/api/production-gantt ranges and Overdue (#429)", () => {
  it("Shoot date narrows the list; Deadline range and Overdue select by the Project's own Deadline", async () => {
    const shoot = await get<Body>(`${base}&shoot=2026-08-10..2026-08-11`, tokens.admin);
    expect(mine(shoot.body)).toEqual([g1, g2, g6].sort());
    const deadline = await get<Body>(`${base}&deadline=2026-08-28..2026-08-29`, tokens.admin);
    expect(mine(deadline.body)).toEqual([g2, g3].sort());
    const overdue = await get<Body>(`${base}&overdue=1`, tokens.admin);
    // Every Deadline here is in the past (g4 and g5 have none), so Overdue is exactly the Projects with one.
    expect(mine(overdue.body)).toEqual([g1, g2, g3, g6].sort());
  });

  it("rejects a Deadline range with Overdue, a malformed range and a bad flag", async () => {
    for (const query of ["deadline=2026-08-01..2026-08-02&overdue=1", "shoot=2026-08-31..2026-08-01", "deadline=2026-08-01", "unassigned=0", "mine=", "dm=2", "overdue=0"]) {
      expect((await get<Body>(`${base}&${query}`, tokens.admin)).status, query).toBe(400);
    }
  });
});

describe("/api/production-gantt child pages (#429)", () => {
  it("a child page honours the People filter, its total and its cursor fingerprint", async () => {
    const first = await get<Body>(`${base}&editors=${blairId}`, tokens.admin);
    const row = rowOf(first.body, g5)!;
    expect(row.children.total).toBe(105);
    expect(row.children.returned).toBe(100);
    expect(row.children.truncated).toBe(true);
    const cursor = row.children.nextCursor!;
    expect(cursor).toBeTruthy();
    // The same filter continues, and walks the filtered list to its end.
    const page = await get<ChildBody>(`scope=active&childrenOf=${g5}&childCursor=${cursor}&editors=${blairId}`, tokens.admin);
    expect(page.status).toBe(200);
    expect(page.body.children).toMatchObject({ total: 105, returned: 5, truncated: false, nextCursor: null });
    // A different filter (or none) than the cursor was minted under is refused.
    for (const query of [`childCursor=${cursor}`, `childCursor=${cursor}&editors=${alexId}`, `childCursor=${cursor}&editors=${blairId}&mine=1`, `childCursor=${cursor}&editors=${blairId}&unassigned=1`]) {
      expect((await get<ChildBody>(`scope=active&childrenOf=${g5}&${query}`, tokens.admin)).status, query).toBe(400);
    }
  });

  it("a first child page narrows to the matching checklist rows and counts only them", async () => {
    const page = await get<ChildBody>(`scope=active&childrenOf=${g1}&editors=${alexId}`, tokens.admin);
    expect(page.body.children.rows.map((child) => child.title)).toEqual(["A1"]);
    expect(page.body.children.total).toBe(1);
    const unassigned = await get<ChildBody>(`scope=active&childrenOf=${g3}&unassigned=1`, tokens.admin);
    expect(unassigned.body.children.rows.map((child) => child.title)).toEqual(["U3"]);
    const mineOnly = await get<ChildBody>(`scope=active&childrenOf=${g3}&mine=1`, tokens.alex);
    expect(mineOnly.body.children.rows.map((child) => child.title)).toEqual(["A3"]);
    // Unfiltered is unchanged.
    const all = await get<ChildBody>(`scope=active&childrenOf=${g3}`, tokens.admin);
    expect(all.body.children.total).toBe(2);
  });

  it("an unfiltered cursor is byte-identical to the one every earlier build minted (no `people` key)", async () => {
    const first = await get<Body>(base, tokens.admin);
    const cursor = rowOf(first.body, g5)!.children.nextCursor!;
    const decoded = JSON.parse(atob(cursor.replace(/-/gu, "+").replace(/_/gu, "/")));
    expect(Object.keys(decoded)).toEqual(["projectId", "position", "id", "completed"]);
  });

  it("refuses the Project-level facets on a child page, as it refuses priority", async () => {
    for (const query of ["stages=raw_review", "shoot=2026-08-01..2026-08-31", "deadline=2026-08-01..2026-08-31", "overdue=1", "dm=1", "priority=5"]) {
      expect((await get<ChildBody>(`scope=active&childrenOf=${g1}&${query}`, tokens.admin)).status, query).toBe(400);
    }
  });
});
