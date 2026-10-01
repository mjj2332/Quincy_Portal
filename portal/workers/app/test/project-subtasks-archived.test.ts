import { env } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import app from "../src/index";
import type { Env } from "../src/env";

/**
 * #446: an archived Project's Checklist is read-only. Every Subtask write refuses before it touches a row, an assignee, the audit
 * log, the activity feed, the notification outbox or a reminder occurrence, and a write that loses the race to an archive in
 * the batch writes nothing either. Reads keep working. An External Editor cannot see an archived Project, so it is a 404 for them.
 */
const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const adminId = "a1111111-1111-4111-8111-111111111111";
const editorId = "a2222222-2222-4222-8222-222222222222";
const photographerId = "a3333333-3333-4333-8333-333333333333";
const externalId = "a4444444-4444-4444-8444-444444444444";
const tokens = { admin: "arch-admin-token", editor: "arch-editor-token", external: "arch-external-token" } as const;
type Who = keyof typeof tokens;
declare const __PORTAL_MIGRATION_SQL__: string;
declare const __PORTAL_SEED_SQL__: string;

async function executeSql(sql: string) { for (const chunk of sql.split("--> statement-breakpoint")) for (const statement of chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); } }
async function cookie(token: string) { const context = await createAuth(baseEnv).$context; return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`; }

/** Runs the real app. `racingArchive` swaps in a D1 whose first multi-statement batch archives that Project, then runs the real batch. */
async function call(who: Who, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, racingArchive?: string, archiveAfterVisibility?: string) {
  const waits: Promise<unknown>[] = [];
  const executionContext = { waitUntil: (promise: Promise<unknown>) => { waits.push(promise); }, passThroughOnException: () => undefined, props: undefined } as unknown as ExecutionContext;
  const race = { flipped: 0 };
  let visibilityReads = 0;
  const wrap = (stmt: D1PreparedStatement, before: () => Promise<void>): D1PreparedStatement => new Proxy(stmt, {
    get(t, p) {
      if (p === "bind") return (...a: unknown[]) => wrap(t.bind(...a), before);
      if (p === "all" || p === "raw" || p === "first" || p === "run") return async (...a: unknown[]) => { await before(); return (t as never as Record<string, (...x: unknown[]) => unknown>)[p as string]!(...a); };
      const v = Reflect.get(t, p, t); return typeof v === "function" ? v.bind(t) : v;
    },
  });
  // The Project is archived at the second visibility read: after the route's own check, before the command's collaboration check.
  const visibilityRace = archiveAfterVisibility ? new Proxy(database.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!/left join "project_members"/i.test(sql) || !/from "projects"/i.test(sql)) return stmt;
          visibilityReads += 1;
          return visibilityReads === 2 ? wrap(stmt, async () => { race.flipped += 1; await target.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), archiveAfterVisibility).run(); }) : stmt;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database : null;
  const db = visibilityRace ?? (racingArchive ? new Proxy(database.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!race.flipped && statements.length >= 2) {
            race.flipped += 1;
            await target.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), racingArchive).run();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database : database.DB);
  const headers = new Headers({ cookie: await cookie(tokens[who]) });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (method !== "GET") headers.set("origin", baseEnv.APP_ORIGIN);
  const response = await app.fetch(new Request(`https://portal.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { ...baseEnv, DB: db } as Env, executionContext);
  await Promise.all(waits);
  return { response, flipped: race.flipped };
}

const RANGE = (start: string, end: string) => ({ state: "range", start: { localCivil: start }, end: { localCivil: end } });
const FAR = RANGE("2099-12-30T09:00", "2099-12-31T17:00");

async function insertRaw(projectId: string, id: string, position: number) {
  const now = Date.now();
  await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 0, '2099-12-31T17:00', 'timed', '2099-12-31T09:00', 4102351200000, 660, 0, 'timed', 4102380000000, 660, 0, 'Australia/Sydney', 1, ?, ?, ?)").bind(id, projectId, id, position, editorId, now, now).run();
}

type Fixture = { projectId: string; a: string; b: string; c: string; x: string; y: string; t: string };

/** A Project with three API-made items (one assigned, one done: so assignees, audit, activity, outbox and occurrences all exist) and a tied pair. */
async function seedProject(archived: boolean): Promise<Fixture> {
  const projectId = crypto.randomUUID(); const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Archived Street', 'editing_autohdr', 0, ?, ?)").bind(projectId, now, now),
    ...([[editorId, "editor"], [photographerId, "photographer"], [externalId, "editor"]] as const).map(([userId, role]) => database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), projectId, userId, role, now)),
  ]);
  const create = async (title: string, extra: object = {}) => {
    const { response } = await call("admin", "POST", `/api/projects/${projectId}/subtasks`, { title, schedule: FAR, ...extra });
    expect(response.status).toBe(201); return (await response.json() as { id: string }).id;
  };
  const a = await create("Item A", { assigneeIds: [photographerId] }); const b = await create("Item B"); const c = await create("Item C");
  expect((await call("admin", "PATCH", `/api/projects/${projectId}/subtasks/${b}`, { done: true })).response.status).toBe(200);
  const [x, y] = [crypto.randomUUID(), crypto.randomUUID()].sort() as [string, string]; const t = crypto.randomUUID();
  await insertRaw(projectId, x, 5000); await insertRaw(projectId, y, 5000); await insertRaw(projectId, t, 9000);
  if (archived) await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), projectId).run();
  return { projectId, a, b, c, x, y, t };
}

/** Everything a Checklist write can touch, for one Project. Compared whole before and after a refused write. */
async function footprint(projectId: string) {
  const all = async (sql: string, ...binds: unknown[]) => (await database.DB.prepare(sql).bind(...binds).all()).results;
  return {
    subtasks: await all("SELECT * FROM project_subtasks WHERE project_id = ? ORDER BY id", projectId),
    assignees: await all("SELECT a.* FROM project_subtask_assignees a JOIN project_subtasks s ON s.id = a.subtask_id WHERE s.project_id = ? ORDER BY a.subtask_id, a.user_id", projectId),
    audit: await all("SELECT id, action, target_id, meta_json FROM audit_log WHERE target_id IN (SELECT id FROM project_subtasks WHERE project_id = ?) ORDER BY id", projectId),
    auditChecklistTotal: await all("SELECT count(*) AS n FROM audit_log WHERE action LIKE 'project_subtask.%'"),
    activity: await all("SELECT * FROM project_activity_events WHERE project_id = ? ORDER BY id", projectId),
    outbox: await all("SELECT id, event_type, source_key, status FROM notification_outbox WHERE project_id = ? ORDER BY id", projectId),
    notifications: await all("SELECT id, type, source_key FROM notifications WHERE project_id = ? ORDER BY id", projectId),
    members: await all("SELECT * FROM project_members WHERE project_id = ? ORDER BY id", projectId),
    occurrences: await all("SELECT * FROM project_subtask_reminder_occurrences WHERE project_id = ? ORDER BY id", projectId),
  };
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__); await executeSql(__PORTAL_SEED_SQL__); const now = Date.now();
  for (const [id, role] of [[adminId, "admin"], [editorId, "editor"], [photographerId, "photographer"], [externalId, "external_editor"]]) await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, ?, ?)").bind(id, `${role} ${id.slice(0, 4)}`, `${id}@example.test`, role, now, now).run();
  for (const [token, userId] of [[tokens.admin, adminId], [tokens.editor, editorId], [tokens.external, externalId]]) await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, token, userId, now, now).run();
});

type Write = { name: string; run: (who: Who, f: Fixture, race?: string) => ReturnType<typeof call> };
const sub = (f: Fixture, id: string) => `/api/projects/${f.projectId}/subtasks/${id}`;
const patchOf = (id: (f: Fixture) => string, body: (f: Fixture) => unknown): Write["run"] => (who, f, race) => call(who, "PATCH", sub(f, id(f)), body(f), race);
const reorder = (target: (f: Fixture) => string, before: (f: Fixture) => string | null, after: (f: Fixture) => string | null): Write["run"] => (who, f, race) => call(who, "POST", `${sub(f, target(f))}/reorder`, { beforeId: before(f), afterId: after(f) }, race);

const WRITES: Write[] = [
  { name: "create", run: (who, f, race) => call(who, "POST", `/api/projects/${f.projectId}/subtasks`, { title: "New item", schedule: FAR }, race) },
  { name: "patch title", run: patchOf((f) => f.a, () => ({ title: "Renamed" })) },
  { name: "patch done true", run: patchOf((f) => f.a, () => ({ done: true })) },
  { name: "patch done false", run: patchOf((f) => f.b, () => ({ done: false })) },
  { name: "assignee delta", run: patchOf((f) => f.a, () => ({ assignees: { expectedVersion: 1, add: [editorId], remove: [] } })) },
  { name: "schedule and reminders", run: patchOf((f) => f.a, () => ({ schedule: { expectedVersion: 1, schedule: RANGE("2099-11-01T09:00", "2099-11-02T17:00"), reminderOffsetsMinutes: [60] } })) },
  { name: "combined title, assignee and schedule", run: patchOf((f) => f.a, () => ({ title: "Combined", assignees: { expectedVersion: 1, add: [editorId], remove: [] }, schedule: { expectedVersion: 1, schedule: RANGE("2099-10-01T09:00", "2099-10-02T17:00") } })) },
  { name: "identical no-op patch", run: patchOf((f) => f.a, () => ({ title: "Item A" })) },
  { name: "reorder", run: reorder((f) => f.c, (f) => f.a, (f) => f.b) },
  { name: "tied reorder (rebase)", run: reorder((f) => f.t, (f) => f.x, (f) => f.y) },
  { name: "delete", run: (who, f, race) => call(who, "DELETE", sub(f, f.a), undefined, race) },
];

describe("an archived Project's Checklist (#446)", () => {
  it("is still readable by staff, and invisible to an External Editor", async () => {
    const f = await seedProject(true);
    for (const who of ["admin", "editor"] as const) {
      expect((await call(who, "GET", `/api/projects/${f.projectId}/subtasks`)).response.status).toBe(200);
      expect((await call(who, "GET", `/api/projects/${f.projectId}/subtask-assignee-options`)).response.status).toBe(200);
    }
    expect((await call("external", "GET", `/api/projects/${f.projectId}/subtasks`)).response.status).toBe(404);
    expect((await call("external", "GET", `/api/projects/${f.projectId}/subtask-assignee-options`)).response.status).toBe(404);
  });

  for (const who of ["admin", "editor"] as const) {
    describe(`refuses every write from ${who} with 409 and changes nothing`, () => {
      for (const write of WRITES) {
        it(write.name, async () => {
          const f = await seedProject(true);
          const before = await footprint(f.projectId);
          const { response } = await write.run(who, f);
          expect(response.status).toBe(409);
          expect(await response.json()).toEqual({ error: "Archived projects are read-only; the checklist can't be changed.", code: "subtask_project_archived" });
          expect(await footprint(f.projectId)).toEqual(before);
        });
      }
    });
  }

  describe("answers an External Editor 404 for every write and changes nothing", () => {
    for (const write of WRITES) {
      it(write.name, async () => {
        const f = await seedProject(true);
        const before = await footprint(f.projectId);
        expect((await write.run("external", f)).response.status).toBe(404);
        expect(await footprint(f.projectId)).toEqual(before);
      });
    }
  });

  describe("when the archive lands between the up-front check and the batch", () => {
    const raced = WRITES.filter((write) => ["create", "combined title, assignee and schedule", "reorder", "tied reorder (rebase)", "delete", "assignee delta", "patch title"].includes(write.name));
    for (const who of ["admin", "external"] as const) {
      for (const write of raced) {
        it(`${write.name} from ${who} is ${who === "admin" ? "409" : "404"} and writes nothing`, async () => {
          const f = await seedProject(false);
          const before = await footprint(f.projectId);
          const { response, flipped } = await write.run(who, f, f.projectId);
          expect(flipped).toBe(1);
          expect(response.status).toBe(who === "admin" ? 409 : 404);
          if (who === "admin") expect(await response.json()).toMatchObject({ code: "subtask_project_archived" });
          expect(await footprint(f.projectId)).toEqual(before);
        });
      }
    }
  });

  it("writes again once restored, and the new Subtask's reminders materialize", async () => {
    const f = await seedProject(true);
    expect((await call("admin", "POST", `/api/projects/${f.projectId}/subtasks`, { title: "Too early", schedule: FAR })).response.status).toBe(409);
    await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(f.projectId).run();
    const created = await call("admin", "POST", `/api/projects/${f.projectId}/subtasks`, { title: "Back", schedule: FAR });
    expect(created.response.status).toBe(201);
    const { id } = await created.response.json() as { id: string };
    const occurrences = (await database.DB.prepare("SELECT count(*) AS n FROM project_subtask_reminder_occurrences WHERE subtask_id = ? AND status = 'pending'").bind(id).first<{ n: number }>())!.n;
    expect(occurrences).toBeGreaterThan(0);
    expect((await call("admin", "PATCH", sub(f, f.a), { title: "Edited after restore" })).response.status).toBe(200);
  });
});

describe("an External Editor racing an archive past the visibility check (#446)", () => {
  for (const write of WRITES.filter((w) => ["create", "patch title", "reorder", "delete"].includes(w.name))) {
    it(`${write.name} is 404, not 403, and writes nothing`, async () => {
      const f = await seedProject(false);
      const before = await footprint(f.projectId);
      const { response, flipped } = await call("external", write.name === "create" ? "POST" : write.name === "patch title" ? "PATCH" : write.name === "reorder" ? "POST" : "DELETE",
        write.name === "create" ? `/api/projects/${f.projectId}/subtasks` : write.name === "reorder" ? `${sub(f, f.c)}/reorder` : sub(f, f.a),
        write.name === "create" ? { title: "New", schedule: FAR } : write.name === "patch title" ? { title: "Renamed" } : write.name === "reorder" ? { beforeId: f.a, afterId: f.b } : undefined, undefined, f.projectId);
      expect(flipped).toBe(1);
      expect(response.status).toBe(404);
      expect(await footprint(f.projectId)).toEqual(before);
    });
  }
});

describe("removing a member from an archived Project (#446)", () => {
  const remove = (f: Fixture, userId: string, role: "photographer" | "editor", cycle: string, clear: boolean, count: number, race?: string) =>
    call("admin", "DELETE", `/api/projects/${f.projectId}/${role}s/${userId}`, clear ? { membershipCycle: cycle, clearSubtaskAssignments: true, confirmedAssignmentCount: count } : { membershipCycle: cycle, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 }, race);
  const cycleOf = async (f: Fixture, userId: string) => (await database.DB.prepare("SELECT id FROM project_members WHERE project_id = ? AND user_id = ?").bind(f.projectId, userId).first<{ id: string }>())!.id;
  const archivedBody = { error: "Archived projects are read-only; the checklist can't be changed.", code: "subtask_project_archived" };

  it("refuses a removal that would clear Subtask assignments, and writes nothing", async () => {
    const f = await seedProject(true);
    const before = await footprint(f.projectId);
    const { response } = await remove(f, photographerId, "photographer", await cycleOf(f, photographerId), true, 1);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(archivedBody);
    expect(await footprint(f.projectId)).toEqual(before);
  });

  it("refuses it even without the confirmation, rather than offering one that cannot succeed", async () => {
    const f = await seedProject(true);
    const before = await footprint(f.projectId);
    const { response } = await remove(f, photographerId, "photographer", await cycleOf(f, photographerId), false, 0);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(archivedBody);
    expect(await footprint(f.projectId)).toEqual(before);
  });

  it("is fenced in the batch when the archive lands mid-request", async () => {
    const f = await seedProject(false);
    const before = await footprint(f.projectId);
    const { response, flipped } = await remove(f, photographerId, "photographer", await cycleOf(f, photographerId), true, 1, f.projectId);
    expect(flipped).toBe(1);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(archivedBody);
    expect(await footprint(f.projectId)).toEqual(before);
  });

  it("control: a removal that touches no Subtask assignment still works on an archived Project", async () => {
    const f = await seedProject(true);
    const { response } = await remove(f, editorId, "editor", await cycleOf(f, editorId), false, 0);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "removed", subtaskAssignmentsCleared: 0 });
    expect(await database.DB.prepare("SELECT 1 AS x FROM project_members WHERE project_id = ? AND user_id = ?").bind(f.projectId, editorId).first()).toBeNull();
  });
});
