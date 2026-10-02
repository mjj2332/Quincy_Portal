import { env } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import app from "../src/index";
import type { Env } from "../src/env";

/**
 * #452: an archived Project's Team is read-only. Every membership add and remove (the four /photographers and /editors routes)
 * answers 409 `membership_project_archived` before it touches a row, the audit log, the activity feed, the notification outbox or
 * `projects.updated_at`, and a write that loses the race to an archive inside the batch writes nothing either. This supersedes
 * #446's `subtask_project_archived` on the removal path. Archived wins over every other classification (stale, ineligible,
 * unchanged, confirmation_required). An External Editor cannot see an archived Project; whatever `main` returns for them is pinned.
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
async function call(who: Who, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, racingArchive?: string) {
  const waits: Promise<unknown>[] = [];
  const executionContext = { waitUntil: (promise: Promise<unknown>) => { waits.push(promise); }, passThroughOnException: () => undefined, props: undefined } as unknown as ExecutionContext;
  const race = { flipped: 0 };
  const db = racingArchive ? new Proxy(database.DB, {
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
  }) as D1Database : database.DB;
  const headers = new Headers({ cookie: await cookie(tokens[who]) });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (method !== "GET") headers.set("origin", baseEnv.APP_ORIGIN);
  const response = await app.fetch(new Request(`https://portal.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { ...baseEnv, DB: db } as Env, executionContext);
  await Promise.all(waits);
  return { response, flipped: race.flipped };
}

const freshPhotographerId = "a5555555-5555-4555-8555-555555555555";
const freshEditorId = "a6666666-6666-4666-8666-666666666666";

type Fixture = { projectId: string };

/** A Project with an editor (assigned nothing), a photographer (holding one Subtask assignment) and an External Editor member. */
async function seedProject(archived: boolean): Promise<Fixture> {
  const projectId = crypto.randomUUID(); const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Archived Street', 'editing_autohdr', 0, ?, ?)").bind(projectId, now, now),
    ...([[editorId, "editor"], [photographerId, "photographer"], [externalId, "editor"]] as const).map(([userId, role]) => database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), projectId, userId, role, now)),
  ]);
  const subtaskId = crypto.randomUUID();
  await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, 'Item A', 0, 1000, 0, '2099-12-31T17:00', 'timed', '2099-12-31T09:00', 4102351200000, 660, 0, 'timed', 4102380000000, 660, 0, 'Australia/Sydney', 1, ?, ?, ?)").bind(subtaskId, projectId, editorId, now, now).run();
  await database.DB.prepare("INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at) VALUES (?, ?, 0, ?)").bind(subtaskId, photographerId, now).run();
  if (archived) await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), projectId).run();
  return { projectId };
}

/** Everything a membership write can touch, for one Project. Compared whole before and after a refused write. */
async function footprint(projectId: string) {
  const all = async (sql: string, ...binds: unknown[]) => (await database.DB.prepare(sql).bind(...binds).all()).results;
  return {
    members: await all("SELECT * FROM project_members WHERE project_id = ? ORDER BY id", projectId),
    audit: await all("SELECT id, action, target_id, meta_json FROM audit_log WHERE action LIKE 'project.member.%' AND meta_json LIKE ? ORDER BY id", `%${projectId}%`),
    activity: await all("SELECT * FROM project_activity_events WHERE project_id = ? ORDER BY id", projectId),
    outbox: await all("SELECT id, event_type, source_key, status FROM notification_outbox WHERE project_id = ? ORDER BY id", projectId),
    ledger: await all("SELECT l.id, l.status FROM notification_delivery_ledger l JOIN notification_outbox o ON o.id = l.outbox_id WHERE o.project_id = ? ORDER BY l.id", projectId),
    notifications: await all("SELECT id, type, source_key FROM notifications WHERE project_id = ? ORDER BY id", projectId),
    assignees: await all("SELECT a.* FROM project_subtask_assignees a JOIN project_subtasks s ON s.id = a.subtask_id WHERE s.project_id = ? ORDER BY a.subtask_id, a.user_id", projectId),
    subtasks: await all("SELECT * FROM project_subtasks WHERE project_id = ? ORDER BY id", projectId),
    project: await all("SELECT updated_at, archived_at FROM projects WHERE id = ?", projectId),
  };
}

/** The archive itself flips `archived_at`; everything else on the Project row (notably `updated_at`) must be untouched. */
const withoutArchivedAt = (state: Awaited<ReturnType<typeof footprint>>) => ({ ...state, project: state.project.map((row) => ({ updated_at: (row as { updated_at: unknown }).updated_at })) });

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__); await executeSql(__PORTAL_SEED_SQL__); const now = Date.now();
  for (const [id, role] of [[adminId, "admin"], [editorId, "editor"], [photographerId, "photographer"], [externalId, "external_editor"], [freshPhotographerId, "photographer"], [freshEditorId, "editor"]]) await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, ?, ?)").bind(id, `${role} ${id.slice(0, 4)}`, `${id}@example.test`, role, now, now).run();
  for (const [token, userId] of [[tokens.admin, adminId], [tokens.editor, editorId], [tokens.external, externalId]]) await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, token, userId, now, now).run();
});

const ARCHIVED_BODY = { error: "Archived projects are read-only; the team can't be changed.", code: "membership_project_archived" };
const add = (who: Who, f: Fixture, role: "photographer" | "editor", userId: string, race?: string) => call(who, "PUT", `/api/projects/${f.projectId}/${role}s/${userId}`, undefined, race);
const remove = (who: Who, f: Fixture, userId: string, role: "photographer" | "editor", cycle: string, clear = false, count = 0, race?: string, confirmAccessLoss?: boolean) =>
  call(who, "DELETE", `/api/projects/${f.projectId}/${role}s/${userId}`, { membershipCycle: cycle, clearSubtaskAssignments: clear, confirmedAssignmentCount: count, ...(confirmAccessLoss === undefined ? {} : { confirmAccessLoss }) }, race);
const cycleOf = async (f: Fixture, userId: string, role?: string) => (await database.DB.prepare(`SELECT id FROM project_members WHERE project_id = ? AND user_id = ?${role ? " AND role_on_project = ?" : ""}`).bind(...[f.projectId, userId, ...(role ? [role] : [])]).first<{ id: string }>())!.id;

describe("External Editors and an archived Project's Team (#452)", () => {
  it("characterization: every membership write answers 403 (not assigned / no editProject) and changes nothing", async () => {
    const f = await seedProject(true);
    const before = await footprint(f.projectId);
    const statuses = [
      (await add("external", f, "photographer", freshPhotographerId)).response.status,
      (await add("external", f, "editor", freshEditorId)).response.status,
      (await remove("external", f, editorId, "editor", await cycleOf(f, editorId))).response.status,
      (await remove("external", f, photographerId, "photographer", await cycleOf(f, photographerId))).response.status,
    ];
    expect(statuses).toEqual([403, 403, 403, 403]);
    expect(await footprint(f.projectId)).toEqual(before);
  });
});

describe("an Admin changing an archived Project's Team (#452)", () => {
  type Case = { name: string; setup?: (f: Fixture) => Promise<unknown>; run: (f: Fixture) => ReturnType<typeof call> };
  const CASES: Case[] = [
    { name: "adds a photographer", run: (f) => add("admin", f, "photographer", freshPhotographerId) },
    { name: "adds an editor", run: (f) => add("admin", f, "editor", freshEditorId) },
    { name: "re-adds an existing member (idempotent add)", run: (f) => add("admin", f, "editor", editorId) },
    { name: "adds an ineligible user (archived wins over 422)", run: (f) => add("admin", f, "photographer", externalId) },
    { name: "removes a member who holds no assignments", run: async (f) => remove("admin", f, editorId, "editor", await cycleOf(f, editorId)) },
    { name: "removes a member whose removal would clear assignments, confirmed", run: async (f) => remove("admin", f, photographerId, "photographer", await cycleOf(f, photographerId), true, 1) },
    { name: "removes it without the confirmation", run: async (f) => remove("admin", f, photographerId, "photographer", await cycleOf(f, photographerId), false, 0) },
    { name: "removes the External Editor's final role with access-loss confirmed", run: async (f) => remove("admin", f, externalId, "editor", await cycleOf(f, externalId), false, 0, undefined, true) },
    { name: "removes an active Admin",
      setup: (f) => database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), f.projectId, adminId, Date.now()).run(),
      run: async (f) => remove("admin", f, adminId, "editor", await cycleOf(f, adminId)) },
    { name: "removes with a stale membershipCycle (archived wins over stale)", run: (f) => remove("admin", f, editorId, "editor", crypto.randomUUID()) },
  ];
  for (const c of CASES) {
    it(`${c.name}: 409 membership_project_archived, footprint identical`, async () => {
      const f = await seedProject(true);
      await c.setup?.(f);
      const before = await footprint(f.projectId);
      const { response } = await c.run(f);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(ARCHIVED_BODY);
      expect(await footprint(f.projectId)).toEqual(before);
    });
  }

  describe("when the archive lands inside the batch", () => {
    it("an add is 409 and writes nothing", async () => {
      const f = await seedProject(false);
      const before = await footprint(f.projectId);
      const { response, flipped } = await add("admin", f, "photographer", freshPhotographerId, f.projectId);
      expect(flipped).toBe(1);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(ARCHIVED_BODY);
      const after = await footprint(f.projectId);
      expect(withoutArchivedAt(after)).toEqual(withoutArchivedAt(before));
    });
    it("a remove is 409 and writes nothing", async () => {
      const f = await seedProject(false);
      const before = await footprint(f.projectId);
      const { response, flipped } = await remove("admin", f, photographerId, "photographer", await cycleOf(f, photographerId), true, 1, f.projectId);
      expect(flipped).toBe(1);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(ARCHIVED_BODY);
      const after = await footprint(f.projectId);
      expect(withoutArchivedAt(after)).toEqual(withoutArchivedAt(before));
    });
    it("a no-assignment remove is 409 too (the fence is the archive, not the assignments)", async () => {
      const f = await seedProject(false);
      const before = await footprint(f.projectId);
      const { response, flipped } = await remove("admin", f, editorId, "editor", await cycleOf(f, editorId), false, 0, f.projectId);
      expect(flipped).toBe(1);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(ARCHIVED_BODY);
      expect(withoutArchivedAt(await footprint(f.projectId))).toEqual(withoutArchivedAt(before));
    });
  });

  it("restoring adds nobody, and the Team can be changed again afterwards", async () => {
    const flag = await database.DB.prepare("SELECT enabled FROM feature_flags WHERE key = 'tb5a_board_contract_enabled'").first<{ enabled: number }>();
    await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run();
    try {
      const f = await seedProject(true);
      const before = await footprint(f.projectId);
      expect((await call("admin", "POST", `/api/projects/${f.projectId}/restore`)).response.status).toBe(200);
      expect((await footprint(f.projectId)).members).toEqual(before.members);
      const added = await add("admin", f, "photographer", freshPhotographerId);
      expect(added.response.status).toBe(201);
      const removed = await remove("admin", f, freshPhotographerId, "photographer", await cycleOf(f, freshPhotographerId));
      expect(removed.response.status).toBe(200);
      expect(await removed.response.json()).toMatchObject({ outcome: "removed" });
    } finally {
      await database.DB.prepare("UPDATE feature_flags SET enabled = ? WHERE key = 'tb5a_board_contract_enabled'").bind(flag?.enabled ?? 0).run();
    }
  });
});
