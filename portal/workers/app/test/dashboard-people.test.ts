import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

/**
 * `GET /api/dashboard/people` -- #429: the People options, one set for every Dashboard view.
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
const dstDeadline = id(12); //  Deadline 2026-10-04T23:30 Sydney (the DST day)
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

type Body = { people?: Array<{ id: string; name: string; roleLabel: string; isExternal: boolean; active: boolean }>; error?: string; code?: string; capability?: string };

async function request(path: string, token: string): Promise<{ status: number; body: Body }> {
  const response = await SELF.fetch(`https://portal.test${path}`, { headers: { cookie: await cookie(token) } });
  return { status: response.status, body: await response.json() as Body };
}

const names = (body: Body) => (body.people ?? []).map((person) => person.id).sort();
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
  // 2026-10-04 is the Sydney DST change day: 23:30 local is 12:30Z the same UTC day, 11 hours ahead.
  await deadline(dstDeadline, Date.UTC(2026, 9, 4, 12, 30), "2026-10-04T23:30", 660);

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

describe("GET /api/dashboard/people (#429)", () => {
  it("lists every Editor and Subtask assignee on the Projects the viewer sees, inactive ones included and labelled", async () => {
    const { status, body } = await request("/api/dashboard/people", tokens.admin);
    expect(status).toBe(200);
    expect(names(body)).toEqual([alexId, blairId, dormantId, externalId, teammateId, strangerId].sort());
    expect(body.people!.find((person) => person.id === dormantId)).toMatchObject({ active: false, isExternal: false });
    expect(body.people!.find((person) => person.id === alexId)).toMatchObject({ name: "Alex Editor", active: true, roleLabel: expect.any(String) });
    expect(body.people).toEqual([...body.people!].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)));
  });

  it("is team-scoped for an External Editor: own Projects, assignees only if on the team", async () => {
    const { body } = await request("/api/dashboard/people", tokens.external);
    expect(names(body)).toEqual([externalId, teammateId].sort());
    expect(JSON.stringify(body)).not.toContain(strangerId);
    expect(JSON.stringify(body)).not.toContain(blairId);
  });

  it("an internal Editor sees the same universe as an Admin under Hide", async () => {
    const { body } = await request("/api/dashboard/people", tokens.alex);
    expect(names(body)).toEqual([alexId, blairId, dormantId, externalId, teammateId, strangerId].sort());
  });

  it("archived Include and Only are Admin-only (403 otherwise); a malformed query is 400", async () => {
    expect((await request("/api/dashboard/people?archived=include", tokens.admin)).status).toBe(200);
    expect((await request("/api/dashboard/people?archived=only", tokens.admin)).status).toBe(200);
    for (const token of [tokens.alex, tokens.external]) {
      const denied = await request("/api/dashboard/people?archived=only", token);
      expect(denied.status).toBe(403);
      expect(denied.body.capability).toBe("adminBackend");
    }
    for (const query of ["archived=hide", "archived=nope", "q=x", "archived=include&archived=only"]) {
      expect((await request(`/api/dashboard/people?${query}`, tokens.admin)).status, query).toBe(400);
    }
  });

  it("Only restricts the universe to archived Projects", async () => {
    const { body } = await request("/api/dashboard/people?archived=only", tokens.admin);
    expect(names(body)).toEqual([alexId]);
  });

  it("requires a session", async () => {
    const response = await SELF.fetch("https://portal.test/api/dashboard/people");
    expect(response.status).toBe(401);
  });
});
