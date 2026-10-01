import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

/**
 * `/api/production-calendar`'s relation and date facets -- #429: Unassigned alone narrows (it used to be
 * ignored unless a known person was also named), My tasks is People = me on both layers, and the Shoot
 * date / Deadline ranges and Overdue apply to both layers.
 */

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
declare const __PORTAL_MIGRATION_SQL__: string;

const adminId = "93111111-1111-4111-8111-111111111111";
const alexId = "93222222-2222-4222-8222-222222222222";
const blairId = "93333333-3333-4333-8333-333333333333";
const tokens = { admin: "t429c-admin", alex: "t429c-alex" };
const id = (n: number) => `93a00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const alexOwns = id(1); // Editor alex, deadline 2026-08-27, shoot 2026-08-10, an unassigned subtask
const noEditor = id(2); // no Editor, deadline 2026-08-28, shoot 2026-08-20, a subtask assigned to blair
const blairOwns = id(3); // Editor blair, deadline 2026-08-29, shoot free text, a subtask assigned to alex
const pastOpen = id(4); // Deadline in June 2020, not archived
const pastArchived = id(5); // Deadline in June 2020, archived
const window = "start=2026-08-24&end=2026-09-05&date=2026-08-27&sub=month&scope=active";
const past = "start=2020-06-01&end=2020-07-01&date=2020-06-15&sub=month&scope=active";

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

type Body = { events: Array<{ kind: string; id: string; title?: string; project: { id: string } }>; range: { appliedFilters: { editorIds: string[] } } };

async function calendar(query: string, token: string): Promise<{ status: number; body: Body }> {
  const response = await SELF.fetch(`https://portal.test/api/production-calendar?${query}`, { headers: { cookie: await cookie(token) } });
  return { status: response.status, body: await response.json() as Body };
}

const deadlines = (body: Body) => body.events.filter((event) => event.kind === "project_deadline").map((event) => event.project.id).sort();
const subtasks = (body: Body) => body.events.filter((event) => event.kind === "checklist").map((event) => event.title).sort();

async function insertUser(userId: string, role: string, token: string | null, name: string): Promise<void> {
  const now = Date.now();
  const statements = [database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, 0, ?, ?)").bind(userId, name, `${userId}@calendar429.test`, role, now, now)];
  if (token) statements.push(database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, token, userId, now, now));
  await database.DB.batch(statements);
}

async function insertProject(projectId: string, street: string, options: { shoot?: string | null; archived?: boolean; deadlineUtc: number; deadlineCivil: string; offset: number }): Promise<void> {
  const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, shoot_date, archived_at, deadline_at, deadline_local_civil, deadline_zone, deadline_utc_offset_minutes, deadline_fold, deadline_version, created_at, updated_at) VALUES (?, ?, 'awaiting_raw', ?, ?, ?, ?, 'Australia/Sydney', ?, 0, 1, ?, ?)")
    .bind(projectId, street, options.shoot ?? null, options.archived ? now : null, options.deadlineUtc, options.deadlineCivil, options.offset, now, now).run();
}

async function editor(projectId: string, userId: string): Promise<void> {
  await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, userId, Date.now()).run();
}

async function subtask(projectId: string, title: string, date: string, assignees: string[]): Promise<void> {
  const subtaskId = crypto.randomUUID();
  const now = Date.now();
  await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_end_kind, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, 0, 1, ?, 'date', ?, 'date', 'Australia/Sydney', 1, ?, ?, ?)")
    .bind(subtaskId, projectId, title, date, date, adminId, now, now).run();
  for (const [index, userId] of assignees.entries()) {
    await database.DB.prepare("INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at) VALUES (?, ?, 1, ?)").bind(subtaskId, userId, now + index).run();
  }
}

const sydney = (civil: string) => Date.parse(`${civil}:00+10:00`);

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await insertUser(adminId, "admin", tokens.admin, "Admin Calendar");
  await insertUser(alexId, "editor", tokens.alex, "Alex Calendar");
  await insertUser(blairId, "editor", null, "Blair Calendar");
  await insertProject(alexOwns, "1 Cal People Street", { shoot: "2026-08-10", deadlineUtc: sydney("2026-08-27T09:00"), deadlineCivil: "2026-08-27T09:00", offset: 600 });
  await editor(alexOwns, alexId);
  await subtask(alexOwns, "Alex unassigned task", "2026-08-27", []);
  await insertProject(noEditor, "2 Cal People Street", { shoot: "2026-08-20", deadlineUtc: sydney("2026-08-28T09:00"), deadlineCivil: "2026-08-28T09:00", offset: 600 });
  await subtask(noEditor, "Blair task", "2026-08-28", [blairId]);
  await insertProject(blairOwns, "3 Cal People Street", { shoot: "Sat 15th Aug", deadlineUtc: sydney("2026-08-29T09:00"), deadlineCivil: "2026-08-29T09:00", offset: 600 });
  await editor(blairOwns, blairId);
  await subtask(blairOwns, "Alex task", "2026-08-29", [alexId]);
  await insertProject(pastOpen, "4 Cal People Street", { deadlineUtc: sydney("2020-06-10T09:00"), deadlineCivil: "2020-06-10T09:00", offset: 600 });
  await insertProject(pastArchived, "5 Cal People Street", { archived: true, deadlineUtc: sydney("2020-06-12T09:00"), deadlineCivil: "2020-06-12T09:00", offset: 600 });
});

describe("/api/production-calendar People, My tasks, ranges and Overdue (#429)", () => {
  it("Unassigned alone narrows: Projects with no Editor, and Subtasks with no assignee", async () => {
    const projects = await calendar(`${window}&layers=project&unassigned=1`, tokens.admin);
    expect(deadlines(projects.body)).toEqual([noEditor]);
    const checklist = await calendar(`${window}&layers=checklist&unassigned=1`, tokens.admin);
    expect(subtasks(checklist.body)).toEqual(["Alex unassigned task"]);
  });

  it("a named person keeps Projects they Edit and Subtasks they hold; Unassigned ORs with them", async () => {
    const named = await calendar(`${window}&layers=project,checklist&editors=${alexId}`, tokens.admin);
    expect(deadlines(named.body)).toEqual([alexOwns]);
    expect(subtasks(named.body)).toEqual(["Alex task"]);
    const both = await calendar(`${window}&layers=project&editors=${alexId}&unassigned=1`, tokens.admin);
    expect(deadlines(both.body)).toEqual([alexOwns, noEditor].sort());
  });

  it("an unknown id with no Unassigned applies no People filter", async () => {
    const all = await calendar(`${window}&layers=project`, tokens.admin);
    const unknown = await calendar(`${window}&layers=project&editors=93eeeeee-eeee-4eee-8eee-eeeeeeeeeeee`, tokens.admin);
    expect(deadlines(unknown.body)).toEqual(deadlines(all.body));
    expect(unknown.body.range.appliedFilters.editorIds).toEqual([]);
  });

  it("My tasks is People = me on both layers (the session user)", async () => {
    const { body } = await calendar(`${window}&layers=project,checklist&mine=1`, tokens.alex);
    expect(deadlines(body)).toEqual([alexOwns]);
    expect(subtasks(body)).toEqual(["Alex task"]);
  });

  it("Shoot date and Deadline ranges apply to both layers; an unparsed shoot date never matches", async () => {
    const shoot = await calendar(`${window}&layers=project,checklist&shoot=2026-08-10..2026-08-20`, tokens.admin);
    expect(deadlines(shoot.body)).toEqual([alexOwns, noEditor].sort());
    expect(subtasks(shoot.body)).toEqual(["Alex unassigned task", "Blair task"]);
    const deadline = await calendar(`${window}&layers=project&deadline=2026-08-28..2026-08-29`, tokens.admin);
    expect(deadlines(deadline.body)).toEqual([noEditor, blairOwns].sort());
  });

  it("Overdue is a past Deadline on a live Project, even under Archived: Include", async () => {
    const { body } = await calendar(`${past}&layers=project&overdue=1&archived=include`, tokens.admin);
    expect(deadlines(body)).toEqual([pastOpen]);
  });

  it("rejects a Deadline range together with Overdue, a reversed range and a malformed range", async () => {
    for (const query of ["deadline=2026-08-01..2026-08-02&overdue=1", "shoot=2026-08-31..2026-08-01", "deadline=2026-08-01", "shoot=2026-02-30..2026-03-01"]) {
      const { status } = await calendar(`${window}&layers=project&${query}`, tokens.admin);
      expect(status, query).toBe(400);
    }
  });
});
