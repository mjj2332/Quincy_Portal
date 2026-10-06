import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

/**
 * Seam A for #425: the Subtask API accepts and returns the reminder offset set and the next reminder. Every range is timed
 * 09:00-17:00 Sydney (date-only Subtasks are refused since 0052); the 2099 ones keep a real `now` before every fire time.
 */
const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const adminId = "91111111-1111-4111-8111-111111111111";
const editorId = "92222222-2222-4222-8222-222222222222";
const externalId = "93333333-3333-4333-8333-333333333333";
const projectId = "9aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
declare const __PORTAL_MIGRATION_SQL__: string; declare const __PORTAL_SEED_SQL__: string;

async function executeSql(sql: string) { for (const chunk of sql.split("--> statement-breakpoint")) for (const statement of chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); } }
async function cookie(token: string) { const context = await createAuth(baseEnv).$context; return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`; }
async function request(path: string, token: string, method: "GET" | "POST" | "PATCH" | "DELETE" = "GET", body?: unknown) { const headers = new Headers({ cookie: await cookie(token) }); if (body !== undefined) headers.set("content-type", "application/json"); if (method !== "GET") headers.set("origin", baseEnv.APP_ORIGIN); return workerSelf.fetch(`https://portal.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__); await executeSql(__PORTAL_SEED_SQL__); const now = Date.now();
  for (const [id, role] of [[adminId, "admin"], [editorId, "editor"], [externalId, "external_editor"]] as const) await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, 0, ?, ?)").bind(id, `${role} ${id.slice(0, 4)}`, `${id}@example.test`, role, now, now).run();
  for (const [token, userId] of [["rapi-admin", adminId], ["rapi-editor", editorId], ["rapi-external", externalId]] as const) await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(`${token}-session`, now + 3_600_000, `${token}-token`, userId, now, now).run();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Reminder API Street', 'editing_autohdr', ?, ?)").bind(projectId, now, now).run();
  for (const userId of [editorId, externalId]) await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, userId, now).run();
});

const EDITOR = "rapi-editor-token";
const EXTERNAL = "rapi-external-token";
const base = () => `/api/projects/${projectId}/subtasks`;
const START = "2099-06-10T09:00";
const END = "2099-06-12T17:00";
const END_AT = Date.parse("2099-06-12T17:00:00+10:00");
const range = (start = START, end = END) => ({ state: "range", start: { localCivil: start }, end: { localCivil: end } });
type Reminders = { offsetsMinutes: number[]; nextOccurrence: { kind: string; offsetMinutes: number; firesAt: string } | null };
type Item = { id: string; schedule: { version: number; end: { localCivil: string } }; reminders: Reminders };

async function create(body: Record<string, unknown> = {}, token = EDITOR): Promise<Item> {
  const response = await request(base(), token, "POST", { title: "Reminder subtask", schedule: range(), ...body });
  expect(response.status).toBe(201);
  return await response.json() as Item;
}
const patch = (id: string, body: Record<string, unknown>, token = EDITOR) => request(`${base()}/${id}`, token, "PATCH", body);
const reschedule = (id: string, expectedVersion: number, extra: Record<string, unknown> = {}, schedule = range()) => patch(id, { schedule: { expectedVersion, schedule, ...extra } });
const storedOffsets = async (id: string) => (await database.DB.prepare("SELECT reminder_offsets_json AS offsets FROM project_subtasks WHERE id = ?").bind(id).first<{ offsets: string }>())!.offsets;
const version = async (id: string) => (await database.DB.prepare("SELECT schedule_version AS v FROM project_subtasks WHERE id = ?").bind(id).first<{ v: number }>())!.v;
const auditFor = async (id: string) => (await database.DB.prepare("SELECT meta_json AS meta FROM audit_log WHERE target_id = ? AND action = 'project_subtask.update' ORDER BY created_at, rowid").bind(id).all<{ meta: string }>()).results.map((row) => JSON.parse(row.meta) as { fields: string[]; scheduleVersion: number; reminders?: { before: number[]; after: number[] } });
const activityTypes = async (id: string) => (await database.DB.prepare("SELECT event_type AS type FROM project_activity_events WHERE json_extract(safe_payload_json, '$.itemId') = ? ORDER BY rowid").bind(id).all<{ type: string }>()).results.map((row) => row.type);

describe("Subtask reminders on the Subtask API (#425)", () => {
  describe("create", () => {
    it("defaults to 1 day before when no set is sent, and returns the set with the next reminder", async () => {
      const item = await create();
      expect(await storedOffsets(item.id)).toBe("[1440]");
      expect(item.reminders.offsetsMinutes).toEqual([1440]);
      expect(item.reminders.nextOccurrence).toEqual({ kind: "advance", offsetMinutes: 1440, firesAt: new Date(END_AT - 1440 * 60_000).toISOString() });
    });

    it("stores the set it is given, latest first and de-duplicated", async () => {
      const item = await create({ reminderOffsetsMinutes: [60, 1440, 60, 240] });
      expect(item.reminders.offsetsMinutes).toEqual([1440, 240, 60]);
      expect(await storedOffsets(item.id)).toBe("[1440,240,60]");
      // The next reminder is the earliest pending occurrence: the longest lead time.
      expect(item.reminders.nextOccurrence).toMatchObject({ kind: "advance", offsetMinutes: 1440 });
    });

    it("accepts an empty set as Due now only", async () => {
      const item = await create({ reminderOffsetsMinutes: [] });
      expect(item.reminders.offsetsMinutes).toEqual([]);
      expect(item.reminders.nextOccurrence).toEqual({ kind: "due_now", offsetMinutes: 0, firesAt: new Date(END_AT).toISOString() });
      expect(await storedOffsets(item.id)).toBe("[]");
    });

    it("accepts eight offsets and the 30 day maximum", async () => {
      const eight = [43200, 10080, 2880, 1440, 240, 60, 30, 5];
      const item = await create({ reminderOffsetsMinutes: eight });
      expect(item.reminders.offsetsMinutes).toEqual(eight);
    });

    it.each([
      ["zero (Due now cannot be sent)", [0]],
      ["a negative", [-1]],
      ["beyond 30 days", [43201]],
      ["a fraction", [1.5]],
      ["nine distinct values", [1, 2, 3, 4, 5, 6, 7, 8, 9]],
      ["a string", ["60"]],
      ["not an array", 60],
      ["null", null],
    ])("rejects %s with subtask_reminders_invalid and writes nothing", async (_label, offsets) => {
      const before = (await database.DB.prepare("SELECT COUNT(*) AS n FROM project_subtasks WHERE project_id = ?").bind(projectId).first<{ n: number }>())!.n;
      const response = await request(base(), EDITOR, "POST", { title: "Invalid reminders", schedule: range(), reminderOffsetsMinutes: offsets });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "subtask_reminders_invalid", details: { field: "reminderOffsetsMinutes" } });
      expect((await database.DB.prepare("SELECT COUNT(*) AS n FROM project_subtasks WHERE project_id = ?").bind(projectId).first<{ n: number }>())!.n).toBe(before);
    });

    it("rejects a raw array too long to normalise, before any write", async () => {
      const response = await request(base(), EDITOR, "POST", { title: "Too many", schedule: range(), reminderOffsetsMinutes: Array.from({ length: 65 }, (_, index) => index + 1) });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "subtask_reminders_invalid" });
    });
  });

  describe("update", () => {
    it("a reminders-only save bumps the version once, returns the new set, and writes no schedule activity", async () => {
      const item = await create();
      const activitiesBefore = await activityTypes(item.id);
      const response = await reschedule(item.id, 1, { reminderOffsetsMinutes: [1440, 60] });
      expect(response.status).toBe(200);
      const saved = await response.json() as Item;
      expect(saved.schedule.version).toBe(2);
      expect(saved.reminders.offsetsMinutes).toEqual([1440, 60]);
      expect(await storedOffsets(item.id)).toBe("[1440,60]");
      expect(await activityTypes(item.id)).toEqual(activitiesBefore);
      expect(await auditFor(item.id)).toEqual([expect.objectContaining({ fields: ["reminders"], scheduleVersion: 2, reminders: { before: [1440], after: [1440, 60] } })]);
    });

    it("a range change and a reminders change in one request bump the version once and audit both", async () => {
      const item = await create();
      const saved = await (await reschedule(item.id, 1, { reminderOffsetsMinutes: [240] }, range(START, "2099-06-14T17:00"))).json() as Item;
      expect(saved.schedule.version).toBe(2);
      expect(saved.reminders.offsetsMinutes).toEqual([240]);
      expect(await activityTypes(item.id)).toContain("project.checklist.schedule_changed");
      expect((await auditFor(item.id))[0]).toMatchObject({ fields: ["schedule", "reminders"], scheduleVersion: 2 });
    });

    it("the same offsets in a different order, or already stored, are a noop that keeps the version", async () => {
      const item = await create({ reminderOffsetsMinutes: [1440, 60] });
      const response = await reschedule(item.id, 1, { reminderOffsetsMinutes: [60, 1440, 60] });
      expect(response.status).toBe(200);
      expect((await response.json() as Item).schedule.version).toBe(1);
      expect(await version(item.id)).toBe(1);
      expect(await auditFor(item.id)).toEqual([]);
    });

    it("a save without the field keeps the stored set (a drag or an undo sends only the range)", async () => {
      const item = await create({ reminderOffsetsMinutes: [1440, 60] });
      const moved = await (await reschedule(item.id, 1, {}, range(START, "2099-06-15T17:00"))).json() as Item;
      expect(moved.schedule.version).toBe(2);
      expect(moved.reminders.offsetsMinutes).toEqual([1440, 60]);
      expect(await storedOffsets(item.id)).toBe("[1440,60]");
    });

    it("an empty set clears every advance reminder and keeps Due now", async () => {
      const item = await create();
      const saved = await (await reschedule(item.id, 1, { reminderOffsetsMinutes: [] })).json() as Item;
      expect(saved.reminders.offsetsMinutes).toEqual([]);
      expect(saved.reminders.nextOccurrence).toMatchObject({ kind: "due_now" });
    });

    it.each([
      ["zero", [0]], ["a negative", [-5]], ["beyond 30 days", [43201]], ["a fraction", [2.5]], ["nine distinct values", [1, 2, 3, 4, 5, 6, 7, 8, 9]], ["not an array", "1440"],
    ])("rejects %s with subtask_reminders_invalid, changes nothing and keeps the version", async (_label, offsets) => {
      const item = await create();
      const response = await reschedule(item.id, 1, { reminderOffsetsMinutes: offsets });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "subtask_reminders_invalid", details: { field: "schedule.reminderOffsetsMinutes" } });
      expect(await storedOffsets(item.id)).toBe("[1440]");
      expect(await version(item.id)).toBe(1);
    });

    it("a stale expectedVersion is a 409 carrying the latest schedule and the latest reminders", async () => {
      const item = await create();
      expect((await reschedule(item.id, 1, { reminderOffsetsMinutes: [60] })).status).toBe(200);
      const stale = await reschedule(item.id, 1, { reminderOffsetsMinutes: [240] });
      expect(stale.status).toBe(409);
      const body = await stale.json() as { code: string; current: { version: number }; currentSubtask: Item };
      expect(body).toMatchObject({ code: "subtask_schedule_version_conflict", current: { version: 2 } });
      expect(body.currentSubtask.reminders.offsetsMinutes).toEqual([60]);
      expect(await storedOffsets(item.id)).toBe("[60]");
    });

    it("a stale version loses even when the offsets it sends match what is stored now (the version check comes first)", async () => {
      const item = await create();
      expect((await reschedule(item.id, 1, { reminderOffsetsMinutes: [60] })).status).toBe(200);
      const stale = await reschedule(item.id, 1, { reminderOffsetsMinutes: [60] });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ code: "subtask_schedule_version_conflict" });
    });

    it("an item conflict body carries the latest reminders", async () => {
      const item = await create();
      let injected = false;
      // Another tab changes the title between this save's read and its write.
      const racing = new Proxy(baseEnv.DB, {
        get(target, property, receiver) {
          if (property === "batch") return async (statements: D1PreparedStatement[]) => { if (!injected) { injected = true; await database.DB.prepare("UPDATE project_subtasks SET title = 'Someone else' WHERE id = ?").bind(item.id).run(); } return target.batch(statements); };
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as unknown as D1Database;
      const { saveProjectSubtask } = await import("../src/lib/project-subtasks");
      const principal = { id: editorId, email: `${editorId}@example.test`, name: "Reminder Editor", role: "editor", active: true, impersonatedBy: null } as const;
      const result = await saveProjectSubtask({ env: { ...baseEnv, DB: racing }, projectId, principal, operation: { kind: "update", subtaskId: item.id, scheduleRequest: { expectedVersion: 1, schedule: { state: "range", start: { localCivil: START }, end: { localCivil: END } }, reminderOffsetsMinutes: [60] } } });
      expect(result.outcome).toBe("item_conflict");
      if (result.outcome !== "item_conflict") return;
      expect(result.currentSubtask.reminders.offsetsMinutes).toEqual([1440]);
      expect(await storedOffsets(item.id)).toBe("[1440]");
    });

    it("any collaborator who can edit the range can edit the reminders, including an External Editor, whose DTO stays strict", async () => {
      const item = await create();
      expect((await reschedule(item.id, 1, { reminderOffsetsMinutes: [240] })).status).toBe(200);
      const asExternal = await patch(item.id, { schedule: { expectedVersion: await version(item.id), schedule: range(), reminderOffsetsMinutes: [30] } }, EXTERNAL);
      expect(asExternal.status).toBe(200);
      const body = await asExternal.json() as Record<string, unknown> & Item;
      expect(body.reminders).toMatchObject({ offsetsMinutes: [30] });
      expect(Object.keys(body)).not.toContain("currentReminders");
      const listed = await (await request(base(), EXTERNAL)).json() as { subtasks: Array<Item> };
      expect(listed.subtasks.find((row) => row.id === item.id)?.reminders.offsetsMinutes).toEqual([30]);
    });
  });

  describe("reads", () => {
    it("the list carries every Subtask's reminders, and a done Subtask has no next reminder", async () => {
      const item = await create({ reminderOffsetsMinutes: [2880, 60] });
      const done = await create({ title: "Finished" });
      expect((await patch(done.id, { done: true })).status).toBe(200);
      const listed = await (await request(base(), EDITOR)).json() as { subtasks: Item[] };
      expect(listed.subtasks.find((row) => row.id === item.id)?.reminders).toMatchObject({ offsetsMinutes: [2880, 60], nextOccurrence: { offsetMinutes: 2880 } });
      expect(listed.subtasks.find((row) => row.id === done.id)?.reminders).toEqual({ offsetsMinutes: [1440], nextOccurrence: null });
    });

    it("the Timeline rows and the Calendar events carry the reminders", async () => {
      const subtaskId = crypto.randomUUID(); const now = Date.now();
      await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, reminder_offsets_json, created_by, created_at, updated_at) VALUES (?, ?, 'Gantt reminders', 0, 5000, 0, ?, 'timed', ?, ?, 600, 0, 'timed', ?, 600, 0, 'Australia/Sydney', 1, '[2880,60]', ?, ?, ?)")
        .bind(subtaskId, projectId, "2099-07-02T17:00", "2099-07-01T09:00", Date.parse("2099-07-01T09:00:00+10:00"), Date.parse("2099-07-02T17:00:00+10:00"), adminId, now, now).run();
      const gantt = await (await request(`/api/production-gantt?scope=active&childrenOf=${projectId}`, "rapi-admin-token")).json() as { children: { rows: Array<{ id: string; reminders: Reminders }> } };
      expect(gantt.children.rows.find((row) => row.id === subtaskId)?.reminders.offsetsMinutes).toEqual([2880, 60]);
      const embedded = await (await request("/api/production-gantt?scope=active", "rapi-admin-token")).json() as { projects: Array<{ id: string; children: { rows: Array<{ id: string; reminders: Reminders }> } }> };
      expect(embedded.projects.find((row) => row.id === projectId)?.children.rows.every((row) => Array.isArray(row.reminders.offsetsMinutes))).toBe(true);
      const calendar = await (await request("/api/production-calendar?start=2099-06-28&end=2099-07-05&date=2099-07-01&sub=month&scope=active&layers=checklist", "rapi-admin-token")).json() as { events: Array<{ kind: string; id: string; title?: string; reminders?: Reminders }> };
      const event = calendar.events.find((row) => row.kind === "checklist" && row.title === "Gantt reminders");
      expect(event?.reminders).toMatchObject({ offsetsMinutes: [2880, 60] });
      expect(event?.reminders?.nextOccurrence).toBeNull();
    });
  });
});
