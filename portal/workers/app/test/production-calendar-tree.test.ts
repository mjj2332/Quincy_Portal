import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

/** `/api/production-calendar?f=1:<tree>` -- #461, over the #429 People seed (its ids are reused). */

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
  await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, 0, 1, ?, 'timed', ?, ?, 600, 0, 'timed', ?, 600, 0, 'Australia/Sydney', 1, ?, ?, ?)")
    .bind(subtaskId, projectId, title, `${date}T17:00`, `${date}T09:00`, Date.parse(`${date}T09:00:00+10:00`), Date.parse(`${date}T17:00:00+10:00`), adminId, now, now).run();
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

const F = (tree: string, extra = "") => `${window}&layers=project,checklist&f=${encodeURIComponent(tree)}${extra}`;

describe("/api/production-calendar filter tree (#461)", () => {
  it("OR: a person OR unassigned reads People per event kind", async () => {
    const { status, body } = await calendar(F(`1:or(people=${alexId};shoot=2026-08-20..2026-08-20)`), tokens.admin);
    expect(status).toBe(200);
    expect(deadlines(body)).toEqual([alexOwns, noEditor].sort());
    expect(subtasks(body)).toEqual(["Alex task", "Blair task"]);
  });

  it("negation and a repeated field; Overdue negated is a live-Project rule", async () => {
    const neg = await calendar(F(`1:and(!people=${alexId};!shoot=2026-08-20..2026-08-20)`), tokens.admin);
    expect(deadlines(neg.body)).toEqual([blairOwns]);
    const repeated = await calendar(F(`1:or(deadline=2026-08-27..2026-08-27;deadline=2026-08-29..2026-08-29)`), tokens.admin);
    expect(deadlines(repeated.body)).toEqual([alexOwns, blairOwns].sort());
    const pastWindow = "start=2020-06-01&end=2020-07-01&date=2020-06-15&sub=month&scope=active&layers=project";
    const live = await calendar(`${pastWindow}&f=${encodeURIComponent("1:and(archived=include;!overdue)")}`, tokens.admin);
    expect(deadlines(live.body)).toEqual([pastArchived]);
  });

  it("a People rule naming only unknown ids is dropped inside an OR, never TRUE", async () => {
    const mineOnly = await calendar(F("1:or(mine;stages=delivered)"), tokens.alex);
    const withUnknown = await calendar(F("1:or(people=93eeeeee-eeee-4eee-8eee-eeeeeeeeeeee;mine;stages=delivered)"), tokens.alex);
    expect(deadlines(withUnknown.body)).toEqual(deadlines(mineOnly.body));
    expect(subtasks(withUnknown.body)).toEqual(subtasks(mineOnly.body));
    expect(deadlines(withUnknown.body)).toEqual([alexOwns]);
  });

  it("echoes the tree in appliedFilters, never emits it for a legacy request", async () => {
    const tree = await calendar(F(`1:or(people=${alexId};mine)`), tokens.admin);
    expect((tree.body.range.appliedFilters as { tree?: unknown }).tree).toBeDefined();
    const legacy = await calendar(`${window}&layers=project&editors=${alexId}`, tokens.admin);
    expect("tree" in legacy.body.range.appliedFilters).toBe(false);
  });

  it("refuses f beside a legacy facet, a malformed tree, a role rule behind OR", async () => {
    expect((await calendar(F(`1:or(mine;overdue)`, "&unassigned=1"), tokens.admin)).status).toBe(400);
    expect((await calendar(F("1:or()"), tokens.admin)).status).toBe(400);
    expect((await calendar(F("1:and(overdue;mine)"), tokens.admin)).status).toBe(400);
    expect((await calendar(F("1:or(archived=only;mine)"), tokens.alex)).status).toBe(403);
  });
});
