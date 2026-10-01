import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

/**
 * `/api/projects`'s relation and date facets -- #429: `editors`, `unassigned`, `mine`, `overdue`,
 * `shoot`, `deadline`. Seam A: People is a Project's Editor OR the assignee of one of its OPEN
 * Subtasks, Unassigned is "no Editor", named ids are any-of and Unassigned ORs with them, My tasks is
 * the session user, and none of it moves the authorised Board order or the `total`.
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
  await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_end_kind, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 1, '2026-08-27', 'date', '2026-08-27', 'date', 'Australia/Sydney', 1, ?, ?, ?)")
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

describe("/api/projects People (#429)", () => {
  it("a named person matches the Projects they Edit OR hold an OPEN Subtask on (a done assignment does not)", async () => {
    const { status, body } = await request(`/api/projects?editors=${alexId}`, tokens.admin);
    expect(status).toBe(200);
    expect(mine(body)).toEqual(sorted(alexEdits, blairEditsAlexTask));
    // Editing a Project is not the same as assigning a Subtask: blair edits two Projects and holds one task.
    const blair = await request(`/api/projects?editors=${blairId}`, tokens.admin);
    expect(mine(blair.body)).toEqual(sorted(blairEditsAlexTask, noEditorBlairTask, blairEditsAlexDoneOnly, dormantTask));
  });

  it("named ids are any-of", async () => {
    const { body } = await request(`/api/projects?editors=${alexId},${blairId}`, tokens.admin);
    expect(mine(body)).toEqual(sorted(alexEdits, blairEditsAlexTask, noEditorBlairTask, blairEditsAlexDoneOnly, dormantTask));
  });

  it("Unassigned alone is exactly the Projects with no Editor, even when a Subtask is assigned", async () => {
    const { body } = await request("/api/projects?unassigned=1", tokens.admin);
    expect(mine(body)).toEqual(sorted(bareUnassigned, noEditorBlairTask, overdueOpen, overdueDelivered, futureDeadline, dstDeadline));
  });

  it("Unassigned ORs with named people", async () => {
    const { body } = await request(`/api/projects?editors=${alexId}&unassigned=1`, tokens.admin);
    expect(mine(body)).toEqual(sorted(alexEdits, blairEditsAlexTask, bareUnassigned, noEditorBlairTask, overdueOpen, overdueDelivered, futureDeadline, dstDeadline));
  });

  it("an assignee who has since been deactivated is still a person to filter by", async () => {
    const { body } = await request(`/api/projects?editors=${dormantId}`, tokens.admin);
    expect(mine(body)).toEqual([dormantTask]);
  });

  it("an unknown id is dropped; all-unknown with no Unassigned applies no People filter; unknown beside a known one narrows by the known one", async () => {
    const unknown = "92eeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const all = await request("/api/projects", tokens.admin);
    const onlyUnknown = await request(`/api/projects?editors=${unknown}`, tokens.admin);
    expect(onlyUnknown.body.projects.map((project) => project.id)).toEqual(all.body.projects.map((project) => project.id));
    expect(onlyUnknown.body.search).toBeUndefined();
    const mixed = await request(`/api/projects?editors=${unknown},${alexId}`, tokens.admin);
    expect(mine(mixed.body)).toEqual(sorted(alexEdits, blairEditsAlexTask));
    const withUnassigned = await request(`/api/projects?editors=${unknown}&unassigned=1`, tokens.admin);
    expect(mine(withUnassigned.body)).toEqual(mine((await request("/api/projects?unassigned=1", tokens.admin)).body));
  });

  it("an id that exists only on an archived Project is unknown under the default Archived mode and known under Include", async () => {
    // alex edits an active Project too, so use a person only on the archived Project: the External's teammate is on none.
    const hidden = await request(`/api/projects?editors=${alexId}`, tokens.admin);
    expect(mine(hidden.body)).not.toContain(archivedAlex);
    const include = await request(`/api/projects?editors=${alexId}&archived=include`, tokens.admin);
    expect(mine(include.body)).toEqual(sorted(alexEdits, blairEditsAlexTask, archivedAlex));
  });

  it("rejects malformed or oversized People before any role branch", async () => {
    const tooMany = Array.from({ length: 51 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`).join(",");
    for (const query of [
      "editors=", "editors=nope", `editors=${alexId},${alexId}`, `editors=${alexId},`, `editors=${alexEdits.toUpperCase()}`, `editors=${tooMany}`,
      `editors=${alexId}&editors=${blairId}`, "unassigned=0", "unassigned=", "mine=0", "overdue=0", "shoot=", "shoot=2026-08-01", "shoot=2026-08-31..2026-08-01", "deadline=2026-08-01..",
      "deadline=2026-08-01..2026-08-02&overdue=1",
    ]) {
      for (const token of [tokens.admin, tokens.alex, tokens.external]) {
        const { status, body } = await request(`/api/projects?${query}`, token);
        expect(status, `${query} ${token}`).toBe(400);
        expect(body.code).toBe("project_filter_invalid");
      }
    }
  });
});

describe("/api/projects My tasks (#429)", () => {
  it("is the session user: an Editor of the Project or the assignee of one of its open Subtasks", async () => {
    const asAlex = await request("/api/projects?mine=1", tokens.alex);
    expect(mine(asAlex.body)).toEqual(sorted(alexEdits, blairEditsAlexTask));
    // Another session, another answer: the id is never client-supplied.
    const asExternal = await request("/api/projects?mine=1", tokens.external);
    expect(mine(asExternal.body)).toEqual(sorted(externalOwn, externalStrangerTask, externalNoEditorSelf));
    const asAdmin = await request("/api/projects?mine=1", tokens.admin);
    expect(mine(asAdmin.body)).toEqual([]);
  });

  it("intersects with People (different fields intersect)", async () => {
    const { body } = await request(`/api/projects?mine=1&editors=${blairId}`, tokens.alex);
    expect(mine(body)).toEqual([blairEditsAlexTask]);
  });
});

describe("/api/projects Overdue and the date ranges (#429)", () => {
  it("Overdue is a past Deadline on a Project that is neither Delivered nor archived", async () => {
    const { body } = await request("/api/projects?overdue=1", tokens.admin);
    expect(mine(body)).toEqual([overdueOpen]);
    // Not even under Archived: Include.
    const include = await request("/api/projects?overdue=1&archived=include", tokens.admin);
    expect(mine(include.body)).toEqual([overdueOpen]);
  });

  it("Shoot date is an inclusive range over real calendar days; an unparsed shoot date never matches", async () => {
    const august = await request("/api/projects?shoot=2026-08-10..2026-08-31", tokens.admin);
    expect(mine(august.body)).toEqual(sorted(alexEdits, blairEditsAlexTask));
    const oneDay = await request("/api/projects?shoot=2026-09-01..2026-09-01", tokens.admin);
    expect(mine(oneDay.body)).toEqual([noEditorBlairTask]);
    // The free-text value is on the Project but is in no range, however wide.
    const wide = await request("/api/projects?shoot=2000-01-01..2099-12-31", tokens.admin);
    expect(mine(wide.body)).toEqual(sorted(alexEdits, blairEditsAlexTask, noEditorBlairTask));
  });

  it("Deadline is a range over the Sydney civil day, so the DST day is one day", async () => {
    const { body } = await request("/api/projects?deadline=2026-10-04..2026-10-04", tokens.admin);
    expect(mine(body)).toEqual([dstDeadline]);
    const before = await request("/api/projects?deadline=2026-10-03..2026-10-03", tokens.admin);
    expect(mine(before.body)).toEqual([]);
    const after = await request("/api/projects?deadline=2026-10-05..2026-10-05", tokens.admin);
    expect(mine(after.body)).toEqual([]);
    // A Project with no Deadline is in no range.
    const wide = await request("/api/projects?deadline=2000-01-01..2100-01-01", tokens.admin);
    expect(mine(wide.body)).toEqual(sorted(overdueOpen, overdueDelivered, futureDeadline, dstDeadline));
  });

  it("combines with Stage, Priority, People and q", async () => {
    const { body } = await request(`/api/projects?editors=${alexId}&shoot=2026-08-01..2026-08-15&priority=5&stages=awaiting_raw&q=1+People`, tokens.admin);
    expect(mine(body)).toEqual([alexEdits]);
  });
});

describe("/api/projects relation facets leave the authorised set alone (#429)", () => {
  it("never changes the Board order envelope, and `total` stays the authorised set", async () => {
    const unfiltered = await request("/api/projects", tokens.admin);
    for (const query of [`editors=${alexId}`, "unassigned=1", "overdue=1", "shoot=2026-08-01..2026-08-31", `editors=${blairId}&unassigned=1&deadline=2000-01-01..2100-01-01`]) {
      const filtered = await request(`/api/projects?${query}`, tokens.admin);
      expect(filtered.body.board, query).toEqual(unfiltered.body.board);
      expect(filtered.body.search, query).toMatchObject({ query: "", total: unfiltered.body.projects.length, matching: filtered.body.projects.length });
    }
    // The order the rows come back in is the unfiltered order, restricted.
    const filtered = await request("/api/projects?unassigned=1", tokens.admin);
    const ids = filtered.body.projects.map((project) => project.id);
    expect(ids).toEqual(unfiltered.body.projects.map((project) => project.id).filter((projectId) => ids.includes(projectId)));
  });

  it("an empty result is a 200 with matching 0", async () => {
    const { status, body } = await request(`/api/projects?editors=${alexId}&overdue=1`, tokens.admin);
    expect(status).toBe(200);
    expect(mine(body)).toEqual([]);
    expect(body.search!.matching).toBe(0);
  });
});

describe("/api/projects External Editor (#429)", () => {
  it("allows People, Unassigned, My tasks, Overdue and the ranges", async () => {
    for (const query of [`editors=${externalId}`, "unassigned=1", "mine=1", "overdue=1", "shoot=2026-08-01..2026-08-31", "deadline=2026-08-01..2026-08-31"]) {
      expect((await request(`/api/projects?${query}`, tokens.external)).status, query).toBe(200);
    }
  });

  it("matches a team member's assignment but never a stranger's, and an id outside their universe is unknown, not revealing", async () => {
    const team = await request(`/api/projects?editors=${teammateId}`, tokens.external);
    expect(mine(team.body)).toEqual([externalOwn]);
    // `strangerId` holds an open Subtask on one of this External's Projects but is not on its team: unknown.
    const stranger = await request(`/api/projects?editors=${strangerId}`, tokens.external);
    expect(mine(stranger.body)).toEqual(sorted(externalOwn, externalStrangerTask, externalNoEditorSelf));
    expect(stranger.body.search).toBeUndefined();
    // And an id that exists only on a Project they cannot see is just as unknown.
    const invisible = await request(`/api/projects?editors=${blairId}`, tokens.external);
    expect(mine(invisible.body)).toEqual(sorted(externalOwn, externalStrangerTask, externalNoEditorSelf));
    // The response never names the stranger.
    expect(JSON.stringify(stranger.body)).not.toContain(strangerId);
  });

  it("Unassigned is no Editor: the External's Projects each have one, so none match", async () => {
    const { body } = await request("/api/projects?unassigned=1", tokens.external);
    expect(mine(body)).toEqual([]);
    expect(body.search).toMatchObject({ matching: 0, total: 3 });
  });

  it("Priority is still refused and Archived other than Hide is still 403", async () => {
    expect((await request("/api/projects?priority=5", tokens.external)).status).toBe(400);
    expect((await request("/api/projects?archived=include", tokens.external)).status).toBe(403);
  });
});
