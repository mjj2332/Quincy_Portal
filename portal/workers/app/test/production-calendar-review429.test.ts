import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";


const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
declare const __PORTAL_MIGRATION_SQL__: string;

/**
 * `/api/production-calendar` review fixes on #429: an External Editor never matches a People selection
 * through an assignment they cannot see (a person on Project A's team, assigned but not on Project B's team),
 * and the shared Overdue facet is the PROJECT Deadline rule on the checklist layer too.
 */

const adminId = "95111111-1111-4111-8111-111111111111";
const externalId = "95222222-2222-4222-8222-222222222222";
const personId = "95333333-3333-4333-8333-333333333333";
const tokens = { admin: "t429f-admin", external: "t429f-external" };
const id = (n: number) => `95a00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectA = id(1); // external + person on the team
const projectB = id(2); // external on the team; person assigned to a Subtask but NOT on the team
const futureDeadline = id(3); // Deadline 2099, a Subtask past due inside the window
const pastDeadline = id(4); // Deadline in the window's past, live
const deliveredPast = id(5); // past Deadline, delivered
const archivedPast = id(6); // past Deadline, archived
const window1 = "start=2026-08-24&end=2026-09-05&date=2026-08-27&sub=month&scope=active";
const window2 = "start=2026-09-28&end=2026-10-10&date=2026-10-01&sub=month&scope=active";
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

async function insertProject(projectId: string, street: string, options: { stage?: string; archived?: boolean; deadlineUtc: number; deadlineCivil: string; offset: number }): Promise<void> {
  const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, shoot_date, archived_at, deadline_at, deadline_local_civil, deadline_zone, deadline_utc_offset_minutes, deadline_fold, deadline_version, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, 'Australia/Sydney', ?, 0, 1, ?, ?)")
    .bind(projectId, street, options.stage ?? 'awaiting_raw', options.archived ? now : null, options.deadlineUtc, options.deadlineCivil, options.offset, now, now).run();
}

async function editor(projectId: string, userId: string): Promise<void> {
  await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, userId, Date.now()).run();
}

async function subtask(projectId: string, title: string, date: string, assignees: string[]): Promise<void> {
  const subtaskId = crypto.randomUUID();
  const now = Date.now();
  await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, 0, 1, ?, 'timed', ?, ?, 600, 0, 'timed', ?, 600, 0, 'Australia/Sydney', 1, ?, ?, ?)")
    .bind(subtaskId, projectId, title, `${date}T17:00`, `${date}T09:00`, Date.parse(`${date}T09:00:00+10:00`), Date.parse(`${date}T17:00:00+10:00`), adminId, now, now).run();
  for (const [index, userId] of assignees.entries()) {
    await database.DB.prepare("INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at) VALUES (?, ?, 1, ?)").bind(subtaskId, userId, now + index).run();
  }
}


const sydney = (civil: string) => Date.parse(`${civil}:00+10:00`);

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await insertUser(adminId, "admin", tokens.admin, "Admin Fixes");
  await insertUser(externalId, "external_editor", tokens.external, "External Fixes");
  await insertUser(personId, "editor", null, "Person Fixes");
  // A: the person is visible here (the People universe), its own deadline is far outside both windows.
  await insertProject(projectA, "1 Fixes Street", { deadlineUtc: sydney("2027-03-01T09:00"), deadlineCivil: "2027-03-01T09:00", offset: 600 });
  await editor(projectA, externalId);
  await editor(projectA, personId);
  await subtask(projectA, "A visible task", "2026-08-27", [personId]);
  // B: the external is on the team, the person is not; the person's assignment is hidden from the external.
  await insertProject(projectB, "2 Fixes Street", { deadlineUtc: sydney("2027-03-02T09:00"), deadlineCivil: "2027-03-02T09:00", offset: 600 });
  await editor(projectB, externalId);
  await subtask(projectB, "B hidden task", "2026-09-01", [personId]);
  await subtask(projectB, "B hidden later task", "2026-10-01", [personId]);
  await insertProject(futureDeadline, "3 Fixes Street", { deadlineUtc: sydney("2099-01-01T09:00"), deadlineCivil: "2099-01-01T09:00", offset: 600 });
  await subtask(futureDeadline, "Past due task, future Deadline", "2026-08-27", []);
  await insertProject(pastDeadline, "4 Fixes Street", { deadlineUtc: sydney("2026-08-26T09:00"), deadlineCivil: "2026-08-26T09:00", offset: 600 });
  await subtask(pastDeadline, "Task under overdue Project", "2026-08-27", []);
  await insertProject(deliveredPast, "5 Fixes Street", { stage: "delivered", deadlineUtc: sydney("2026-08-26T10:00"), deadlineCivil: "2026-08-26T10:00", offset: 600 });
  await subtask(deliveredPast, "Task under delivered Project", "2026-08-27", []);
  await insertProject(archivedPast, "6 Fixes Street", { archived: true, deadlineUtc: sydney("2026-08-26T11:00"), deadlineCivil: "2026-08-26T11:00", offset: 600 });
  await subtask(archivedPast, "Task under archived Project", "2026-08-27", []);
});

describe("External Editor People filter never matches a hidden assignment (#429)", () => {
  it("selecting a person visible on A does not return their assignment on B, where they are not on the team", async () => {
    const { status, body } = await calendar(`${window1}&layers=project,checklist&editors=${personId}`, tokens.external);
    expect(status).toBe(200);
    expect(subtasks(body)).toEqual(["A visible task"]);
  });

  it("holds when A has nothing in the calendar window", async () => {
    const { status, body } = await calendar(`${window2}&layers=checklist&editors=${personId}`, tokens.external);
    expect(status).toBe(200);
    expect(subtasks(body)).toEqual([]);
  });

  it("a Subtask whose only assignee is hidden reads as unassigned to the External Editor, as the Timeline does", async () => {
    const { body } = await calendar(`${window1}&layers=checklist&unassigned=1`, tokens.external);
    expect(subtasks(body)).toEqual(["B hidden task"]);
  });

  it("an Admin still matches the assignment (the team rule is External Editor only)", async () => {
    const { body } = await calendar(`${window1}&layers=checklist&editors=${personId}`, tokens.admin);
    expect(subtasks(body)).toEqual(["A visible task", "B hidden task"]);
  });
});

describe("the shared Overdue facet is the Project Deadline rule on both Calendar layers (#429)", () => {
  it("excludes a past-due Subtask under a Project whose Deadline is in the future", async () => {
    const { body } = await calendar(`${window1}&layers=checklist&overdue=1&delivered=1&archived=include`, tokens.admin);
    expect(subtasks(body)).toEqual(["Task under overdue Project"]);
  });

  it("excludes delivered and archived Projects from both layers", async () => {
    const { body } = await calendar(`${window1}&layers=project,checklist&overdue=1&delivered=1&archived=include`, tokens.admin);
    expect(deadlines(body)).toEqual([pastDeadline]);
    expect(subtasks(body)).toEqual(["Task under overdue Project"]);
  });
});
