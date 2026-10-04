import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

/**
 * `/api/projects?f=1:<tree>` -- #461: OR, groups, negation and a repeated field over the same seed as
 * `projects-filter-people` (its ids are reused, so the People / Overdue meanings are the pinned ones).
 */

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
declare const __PORTAL_MIGRATION_SQL__: string;

const adminId = "92111111-1111-4111-8111-111111111111";
const alexId = "92222222-2222-4222-8222-222222222222"; // an internal editor (the session for `alex`)
const blairId = "92333333-3333-4333-8333-333333333333"; // another internal editor
const dormantId = "92555555-5555-4555-8555-555555555555"; // deactivated, still assigned
const externalId = "92444444-4444-4444-8444-444444444444";
const teammateId = "92666666-6666-4666-8666-666666666666"; // on the External's team
const strangerId = "92777777-7777-4777-8777-777777777777"; // not on the External's team
const tokens = { admin: "t429-admin", alex: "t429-alex", external: "t429-external" };

const id = (n: number) => `92a00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const alexEdits = id(1); //  Editor alex. shoot 2026-08-10
const blairEditsAlexTask = id(2); //  Editor blair + OPEN subtask assigned to alex. shoot 2026-08-31
const noEditorBlairTask = id(3); //  no Editor + OPEN subtask assigned to blair. shoot 2026-09-01
const bareUnassigned = id(4); //  no Editor, no subtasks. shoot is free text
const blairEditsAlexDoneOnly = id(5); //  Editor blair + only a DONE subtask assigned to alex
const archivedAlex = id(6); //  archived, Editor alex
const dormantTask = id(7); //  Editor blair + OPEN subtask assigned to the deactivated user
const overdueOpen = id(8); //  Deadline past, not delivered
const overdueDelivered = id(9); //  Deadline past, delivered
const overdueArchived = id(10); //  Deadline past, archived
const futureDeadline = id(11); //  Deadline in the future
const dstDeadline = id(12); //  Deadline 2099-10-04T23:30 Sydney (the DST day)
const externalOwn = id(13); //  External's: Editor external + subtask for the teammate
const externalStrangerTask = id(14); //  External's: subtask assigned to a stranger (not on the team)
const externalNoEditorSelf = id(15); //  External's (as a team member, not an Editor? no: Editor) + nothing
const ALL_ACTIVE = [alexEdits, blairEditsAlexTask, noEditorBlairTask, bareUnassigned, blairEditsAlexDoneOnly, dormantTask, overdueOpen, overdueDelivered, futureDeadline, dstDeadline, externalOwn, externalStrangerTask, externalNoEditorSelf];

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

type Body = {
  projects: Array<{ id: string }>;
  board: { orderedProjectIdsByStage: Record<string, string[]> };
  search?: { query: string; matching: number; total: number };
  error?: string; code?: string; capability?: string;
};

async function request(path: string, token: string): Promise<{ status: number; body: Body }> {
  const response = await SELF.fetch(`https://portal.test${path}`, { headers: { cookie: await cookie(token) } });
  return { status: response.status, body: await response.json() as Body };
}

const mine = (body: Body) => body.projects.map((project) => project.id).filter((projectId) => projectId.startsWith("92a00000")).sort();
const sorted = (...ids: string[]) => [...ids].sort();

async function insertUser(userId: string, role: string, token: string | null, name: string, active = 1): Promise<void> {
  const now = Date.now();
  const statements = [database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, 0, ?, ?)").bind(userId, name, `${userId}@people.test`, role, active, now, now)];
  if (token) statements.push(database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, token, userId, now, now));
  await database.DB.batch(statements);
}

async function insertProject(projectId: string, street: string, options: { stage?: string; shoot?: string | null; archived?: boolean; priority?: number | null } = {}): Promise<void> {
  const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, priority, shoot_date, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(projectId, street, options.stage ?? "awaiting_raw", options.priority ?? null, options.shoot ?? null, options.archived ? now : null, now, now).run();
}

async function member(projectId: string, userId: string, roleOnProject: "editor" | "photographer"): Promise<void> {
  await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), projectId, userId, roleOnProject, Date.now()).run();
}

async function subtask(projectId: string, title: string, assignees: string[], done = false): Promise<void> {
  const subtaskId = crypto.randomUUID();
  const now = Date.now();
  await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 1, '2026-08-27T17:00', 'timed', '2026-08-27T09:00', 1787785200000, 600, 0, 'timed', 1787814000000, 600, 0, 'Australia/Sydney', 1, ?, ?, ?)")
    .bind(subtaskId, projectId, title, done ? 1 : 0, adminId, now, now).run();
  for (const [index, userId] of assignees.entries()) {
    await database.DB.prepare("INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at) VALUES (?, ?, 1, ?)").bind(subtaskId, userId, now + index).run();
  }
}

async function deadline(projectId: string, atMs: number, localCivil: string, offsetMinutes: number): Promise<void> {
  await database.DB.prepare("UPDATE projects SET deadline_at = ?, deadline_local_civil = ?, deadline_zone = 'Australia/Sydney', deadline_utc_offset_minutes = ?, deadline_fold = 0, deadline_version = 1 WHERE id = ?")
    .bind(atMs, localCivil, offsetMinutes, projectId).run();
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await insertUser(adminId, "admin", tokens.admin, "Admin People");
  await insertUser(alexId, "editor", tokens.alex, "Alex Editor");
  await insertUser(blairId, "editor", null, "Blair Editor");
  await insertUser(dormantId, "editor", null, "Dormant Editor", 0);
  await insertUser(externalId, "external_editor", tokens.external, "External People");
  await insertUser(teammateId, "photographer", null, "Teammate Photographer");
  await insertUser(strangerId, "editor", null, "Stranger Editor");

  await insertProject(alexEdits, "1 People Street", { shoot: "2026-08-10", priority: 5 });
  await member(alexEdits, alexId, "editor");
  await insertProject(blairEditsAlexTask, "2 People Street", { shoot: "2026-08-31" });
  await member(blairEditsAlexTask, blairId, "editor");
  await subtask(blairEditsAlexTask, "Alex open", [alexId]);
  await insertProject(noEditorBlairTask, "3 People Street", { shoot: "2026-09-01" });
  await subtask(noEditorBlairTask, "Blair open", [blairId]);
  await insertProject(bareUnassigned, "4 People Street", { shoot: "Sat 15th Aug" });
  await insertProject(blairEditsAlexDoneOnly, "5 People Street");
  await member(blairEditsAlexDoneOnly, blairId, "editor");
  await subtask(blairEditsAlexDoneOnly, "Alex done", [alexId], true);
  await insertProject(archivedAlex, "6 Archived People Street", { archived: true });
  await member(archivedAlex, alexId, "editor");
  await insertProject(dormantTask, "7 People Street");
  await member(dormantTask, blairId, "editor");
  await subtask(dormantTask, "Dormant open", [dormantId]);

  const hour = 3_600_000;
  await insertProject(overdueOpen, "8 People Street");
  await deadline(overdueOpen, Date.now() - 48 * hour, "2026-07-01T09:00", 600);
  await insertProject(overdueDelivered, "9 People Street", { stage: "delivered" });
  await deadline(overdueDelivered, Date.now() - 48 * hour, "2026-07-02T09:00", 600);
  await insertProject(overdueArchived, "10 Archived People Street", { archived: true });
  await deadline(overdueArchived, Date.now() - 48 * hour, "2026-07-03T09:00", 600);
  await insertProject(futureDeadline, "11 People Street");
  await deadline(futureDeadline, Date.now() + 90 * 24 * hour, "2099-01-01T09:00", 660);
  await insertProject(dstDeadline, "12 People Street");
  // 2099-10-04 is the Sydney DST change day: 23:30 local is 12:30Z the same UTC day, 11 hours ahead.
  await deadline(dstDeadline, Date.UTC(2099, 9, 4, 12, 30), "2099-10-04T23:30", 660);

  await insertProject(externalOwn, "13 External People Street");
  await member(externalOwn, externalId, "editor");
  await member(externalOwn, teammateId, "photographer");
  await subtask(externalOwn, "Teammate open", [teammateId]);
  await insertProject(externalStrangerTask, "14 External People Street");
  await member(externalStrangerTask, externalId, "editor");
  await subtask(externalStrangerTask, "Stranger open", [strangerId]);
  await insertProject(externalNoEditorSelf, "15 External People Street");
  await member(externalNoEditorSelf, externalId, "editor");
});


const F = (tree: string) => `/api/projects?${new URLSearchParams([["f", tree]]).toString()}`;
const idsOf = async (tree: string, token = tokens.admin) => mine((await request(F(tree), token)).body);

describe("/api/projects filter tree (#461)", () => {
  it("OR across fields: a person OR overdue", async () => {
    expect(await idsOf(`1:or(people=${alexId};overdue)`)).toEqual(sorted(alexEdits, blairEditsAlexTask, overdueOpen));
  });

  it("groups: (Alex AND priority 5) OR Blair-only task", async () => {
    expect(await idsOf(`1:or(and(people=${alexId};priority=5);and(people=${blairId};stages=awaiting_raw;!mine))`)).toEqual(sorted(alexEdits, blairEditsAlexTask, noEditorBlairTask, blairEditsAlexDoneOnly, dormantTask));
  });

  it("the same field twice, and negation", async () => {
    expect(await idsOf(`1:and(people=${alexId};!people=${blairId})`)).toEqual([alexEdits]);
    expect(await idsOf(`1:and(!stages=delivered;people=unassigned)`)).toEqual(sorted(bareUnassigned, noEditorBlairTask, overdueOpen, futureDeadline, dstDeadline));
  });

  it("a Deadline range OR overdue (not spellable in the legacy parameters)", async () => {
    expect(await idsOf("1:or(deadline=2099-10-04..2099-10-04;overdue)")).toEqual(sorted(dstDeadline, overdueOpen));
  });

  it("a People rule naming only unknown people is dropped, never TRUE inside an OR", async () => {
    const unknown = "92eeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    expect(await idsOf(`1:or(people=${unknown};stages=delivered)`)).toEqual([overdueDelivered]);
    const all = await request(F(`1:or(people=${unknown};mine)`), tokens.admin);
    expect(mine(all.body).length).toBeLessThan(ALL_ACTIVE.length);
    const none = await request(F(`1:or(people=${unknown};and(people=${unknown};mine))`), tokens.admin);
    // not a legacy tree, and every rule is not applied or ... mine alone narrows, the rest drop
    expect(none.status).toBe(200);
  });

  it("Archived under OR: the rule decides row by row once the scope is Include", async () => {
    expect(await idsOf(`1:or(archived=only;people=${alexId})`)).toEqual(sorted(alexEdits, blairEditsAlexTask, archivedAlex, overdueArchived));
    expect(await idsOf(`1:and(or(archived=only;stages=delivered);overdue)`)).toEqual([]);
    expect(await idsOf(`1:or(archived=hide;archived=only)`)).toEqual(sorted(...ALL_ACTIVE.filter((projectId) => !projectId.startsWith("never")), archivedAlex, overdueArchived).sort());
  });

  it("a legacy archived=only with an id only active Projects have still returns every archived Project", async () => {
    const { body } = await request(`/api/projects?archived=only&editors=${blairId}`, tokens.admin);
    expect(mine(body)).toEqual(sorted(archivedAlex, overdueArchived));
  });

  it("never moves the Board envelope or the total", async () => {
    const all = await request("/api/projects", tokens.admin);
    const narrowed = await request(F(`1:or(people=${alexId};overdue)`), tokens.admin);
    expect(narrowed.body.board).toEqual(all.body.board);
    expect(narrowed.body.search?.total).toBe(all.body.projects.length);
    expect(narrowed.body.search?.matching).toBe(narrowed.body.projects.length);
  });

  it("refuses a role rule hidden in a group or behind a negation, and a malformed or capped tree", async () => {
    for (const tree of ["1:or(archived=only;stages=editing)", "1:and(!archived=hide;stages=editing;stages=delivered)", "1:or(and(mine;archived=include);stages=editing)"]) {
      expect((await request(F(tree), tokens.alex)).status, tree).toBe(403);
    }
    for (const tree of ["1:or(priority=5;stages=editing)", "1:or(and(!priority=5;mine);stages=editing)"]) {
      const response = await request(F(tree), tokens.external);
      expect(response.status, tree).toBe(400);
      expect(response.body.code).toBe("project_filter_priority_unavailable");
    }
    const invalid = (path: string) => request(path, tokens.admin);
    expect((await invalid(`/api/projects?f=${encodeURIComponent("1:or()")}`)).status).toBe(400);
    expect((await invalid(F("1:and(stages=editing;mine)"))).status).toBe(400);
    expect((await invalid(`${F("1:or(stages=editing;mine)")}&stages=editing`)).status).toBe(400);
    const tooMany = `1:or(${Array.from({ length: 21 }, (_, i) => (i % 2 ? "mine" : "overdue")).join(";")})`;
    expect((await invalid(F(tooMany))).status).toBe(400);
  });

  it("an External Editor's tree filters the Editor's own Projects", async () => {
    const { body } = await request(F(`1:or(people=${teammateId};stages=delivered)`), tokens.external);
    expect(body.projects.map((project) => project.id).sort()).toEqual([externalOwn]);
  });
});
