import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

/**
 * #484: the Automatic Deadline through the real app over HTTP. The clock is pinned to an instant whose
 * UTC day (Thu 2026-10-01) differs from its Sydney day (Fri 2026-10-02, 00:30), so a naive-UTC
 * implementation of the shoot-date fill fails. Sydney's clocks go forward on Sun 2026-10-04, so a
 * Friday shoot is due Monday 5 Oct 17:00 at +11:00 (06:00Z).
 */
const TEST_NOW = new Date("2026-10-01T14:30:00.000Z");
const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
declare const __PORTAL_MIGRATION_SQL__: string;
const SYSTEM_ACTOR = "00000000-0000-4000-8000-000000000000";

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

const token = `auto-deadline-${crypto.randomUUID()}`;
const userId = crypto.randomUUID();

async function cookie(): Promise<string> {
  const context = await createAuth(baseEnv).$context;
  return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
}

async function request(path: string, method: string, body?: unknown): Promise<Response> {
  const headers = new Headers({ cookie: await cookie(), origin: baseEnv.APP_ORIGIN });
  if (body !== undefined) headers.set("content-type", "application/json");
  return workerSelf.fetch(`https://portal.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

type DeadlineRow = { deadline_at: number | null; deadline_local_civil: string | null; deadline_source: string; deadline_version: number; deadline_utc_offset_minutes: number | null };
const deadlineOf = async (projectId: string) => (await database.DB.prepare("SELECT deadline_at, deadline_local_civil, deadline_source, deadline_version, deadline_utc_offset_minutes FROM projects WHERE id = ?").bind(projectId).first<DeadlineRow>())!;
const automaticAudits = async (projectId: string) => (await database.DB.prepare("SELECT actor_id, meta_json FROM audit_log WHERE target_id = ? AND action = 'project.deadline.automatic_set'").bind(projectId).all<{ actor_id: string | null; meta_json: string }>()).results;
const occurrencesOf = async (projectId: string) => (await database.DB.prepare("SELECT kind, reminder_offset_minutes AS offset, status, terminal_reason AS reason, schedule_version AS version, created_by FROM project_deadline_occurrences WHERE project_id = ? ORDER BY schedule_version, reminder_offset_minutes DESC").bind(projectId).all<{ kind: string; offset: number; status: string; reason: string | null; version: number; created_by: string }>()).results;

async function createProject(body: Record<string, unknown>): Promise<string> {
  const response = await request("/api/projects", "POST", { street: `Auto ${crypto.randomUUID()}`, ...body });
  expect(response.status).toBe(201);
  return (await response.json() as { id: string }).id;
}

async function seedProject(fields: { shootDate?: string | null; stageKey?: string; archived?: boolean } = {}): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, shoot_date, board_position, board_revision, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)")
    .bind(id, `Seed ${id}`, fields.stageKey ?? "editing", fields.shootDate ?? null, fields.archived ? now : null, now, now).run();
  return id;
}

const AUTOMATIC_MONDAY = { at: Date.parse("2026-10-05T06:00:00.000Z"), civil: "2026-10-05T17:00" };

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: TEST_NOW });
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run();
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, 'Auto Admin', ?, 1, 'admin', 1, 0, ?, ?)").bind(userId, `${userId}@example.test`, now, now),
    database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, token, userId, now, now),
  ]);
});
afterAll(() => { vi.useRealTimers(); });

describe("Automatic Deadline on create (#484)", () => {
  it("gives a Project created with a shoot date its Automatic Deadline in the same write", async () => {
    const projectId = await createProject({ shootDate: "2026-10-02" });
    expect(await deadlineOf(projectId)).toEqual({ deadline_at: AUTOMATIC_MONDAY.at, deadline_local_civil: AUTOMATIC_MONDAY.civil, deadline_source: "automatic", deadline_version: 1, deadline_utc_offset_minutes: 660 });
    const audits = await automaticAudits(projectId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor_id).toBeNull();
    expect(JSON.parse(audits[0]!.meta_json)).toMatchObject({ actor: "system", reason: "create", shootDate: "2026-10-02", version: 1, reminderOffsetsMinutes: [1440, 240, 60] });
    const occurrences = await occurrencesOf(projectId);
    expect(occurrences.map((row) => [row.kind, row.offset, row.status, row.version])).toEqual([["advance", 1440, "pending", 1], ["advance", 240, "pending", 1], ["advance", 60, "pending", 1], ["due_now", 0, "pending", 1]]);
    expect(occurrences.every((row) => row.created_by === SYSTEM_ACTOR)).toBe(true);
    const detail = await (await request(`/api/projects/${projectId}`, "GET")).json() as { deadlineSchedule: { source: string; version: number; deadline: { localCivil: string } } };
    expect(detail.deadlineSchedule).toMatchObject({ source: "automatic", version: 1, deadline: { localCivil: AUTOMATIC_MONDAY.civil } });
  });

  it.each([["2026-10-05", "2026-10-06T17:00"], ["2026-10-09", "2026-10-12T17:00"], ["2026-10-10", "2026-10-12T17:00"], ["2026-10-11", "2026-10-12T17:00"]])("a %s shoot is due %s", async (shootDate, civil) => {
    const projectId = await createProject({ shootDate });
    expect((await deadlineOf(projectId)).deadline_local_civil).toBe(civil);
  });

  it("records every occurrence of a backdated Automatic Deadline skipped, so no reminder fires at once", async () => {
    const projectId = await createProject({ shootDate: "2026-09-02" });
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_local_civil: "2026-09-03T17:00", deadline_source: "automatic" });
    const occurrences = await occurrencesOf(projectId);
    expect(occurrences).toHaveLength(4);
    expect(occurrences.every((row) => row.status === "skipped" && row.reason === "elapsed_at_save")).toBe(true);
  });

  it("sets no Deadline when there is no shoot date, or the shoot date is free text", async () => {
    for (const shootDate of [undefined, "TBC next week", "2026-02-30"]) {
      const projectId = await createProject(shootDate === undefined ? {} : { shootDate });
      expect(await deadlineOf(projectId)).toMatchObject({ deadline_at: null, deadline_source: "none", deadline_version: 0 });
      expect(await automaticAudits(projectId)).toHaveLength(0);
      expect(await occurrencesOf(projectId)).toHaveLength(0);
    }
  });
});

describe("Automatic Deadline on Edit details (#484)", () => {
  it("sets one when a shoot date is added to a Project with an empty Deadline, and records it as automatic", async () => {
    const projectId = await seedProject();
    const response = await request(`/api/projects/${projectId}`, "PATCH", { shootDate: "2026-10-02" });
    expect(response.status).toBe(200);
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_at: AUTOMATIC_MONDAY.at, deadline_source: "automatic", deadline_version: 1 });
    expect(JSON.parse((await automaticAudits(projectId))[0]!.meta_json)).toMatchObject({ reason: "details", actor: "system" });
    expect(await occurrencesOf(projectId)).toHaveLength(4);
  });

  it("sets one when free-text shoot date becomes a canonical date", async () => {
    const projectId = await seedProject({ shootDate: "Friday, TBC" });
    expect((await request(`/api/projects/${projectId}`, "PATCH", { shootDate: "2026-10-02" })).status).toBe(200);
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_local_civil: AUTOMATIC_MONDAY.civil, deadline_source: "automatic" });
  });

  it("never replaces a held Deadline", async () => {
    const projectId = await seedProject();
    const held = Date.parse("2026-11-20T06:00:00.000Z");
    await database.DB.prepare("UPDATE projects SET deadline_at = ?, deadline_local_civil = '2026-11-20T17:00', deadline_zone = 'Australia/Sydney', deadline_utc_offset_minutes = 660, deadline_fold = 0, deadline_source = 'manual', deadline_version = 4 WHERE id = ?").bind(held, projectId).run();
    expect((await request(`/api/projects/${projectId}`, "PATCH", { shootDate: "2026-10-02" })).status).toBe(200);
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_at: held, deadline_source: "manual", deadline_version: 4 });
    expect(await automaticAudits(projectId)).toHaveLength(0);
  });

  it("does not backfill a Project that already holds a shoot date, and does not move on a reschedule (#485)", async () => {
    const projectId = await seedProject({ shootDate: "2026-09-15" });
    expect((await request(`/api/projects/${projectId}`, "PATCH", { notes: "unrelated edit" })).status).toBe(200);
    expect((await request(`/api/projects/${projectId}`, "PATCH", { shootDate: "2026-10-02" })).status).toBe(200);
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_at: null, deadline_source: "none", deadline_version: 0 });
    expect(await automaticAudits(projectId)).toHaveLength(0);
  });

  it("does not set one on a Delivered Project", async () => {
    const projectId = await seedProject({ stageKey: "delivered" });
    expect((await request(`/api/projects/${projectId}`, "PATCH", { shootDate: "2026-10-02" })).status).toBe(200);
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_at: null, deadline_source: "none" });
    expect(await occurrencesOf(projectId)).toHaveLength(0);
  });

  it("does not set one from a free-text shoot date", async () => {
    const projectId = await seedProject();
    expect((await request(`/api/projects/${projectId}`, "PATCH", { shootDate: "TBC" })).status).toBe(200);
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_at: null, deadline_source: "none" });
  });
});

describe("a person's save and the Automatic Deadline (#484)", () => {
  const putDeadline = (projectId: string, body: unknown) => request(`/api/projects/${projectId}/deadline`, "PUT", body);

  it("confirming the automatic value flips the source to manual and nothing else: same version, same reminder rows", async () => {
    const projectId = await createProject({ shootDate: "2026-10-02" });
    const rows = () => database.DB.prepare("SELECT id, kind, status, schedule_version AS version, fire_at FROM project_deadline_occurrences WHERE project_id = ? ORDER BY reminder_offset_minutes DESC").bind(projectId).all();
    const before = (await rows()).results;
    // The 1-day reminder has been sent and its delivery is still in flight.
    await database.DB.prepare("UPDATE project_deadline_occurrences SET status = 'fired', fired_at = ? WHERE id = ?").bind(Date.now(), (before[0] as { id: string }).id).run();
    const fired = (await rows()).results;
    const response = await putDeadline(projectId, { expectedVersion: 1, deadline: { localCivil: AUTOMATIC_MONDAY.civil }, reminderOffsetsMinutes: [1440, 240, 60] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ changed: true, current: { version: 1, source: "manual" } });
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_source: "manual", deadline_version: 1, deadline_at: AUTOMATIC_MONDAY.at });
    expect((await rows()).results).toEqual(fired);
    expect(await database.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE target_id = ? AND action = 'project.deadline.schedule_saved'").bind(projectId).first()).toEqual({ n: 1 });
    // Confirming an already-manual Deadline is the ordinary exact no-op.
    expect(await (await putDeadline(projectId, { expectedVersion: 1, deadline: { localCivil: AUTOMATIC_MONDAY.civil }, reminderOffsetsMinutes: [1440, 240, 60] })).json()).toMatchObject({ changed: false, current: { version: 1, source: "manual" } });
    expect(await database.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE target_id = ? AND action = 'project.deadline.schedule_saved'").bind(projectId).first()).toEqual({ n: 1 });
  });

  it("rejects a stale confirmation as a conflict and leaves the Deadline automatic", async () => {
    const projectId = await createProject({ shootDate: "2026-10-02" });
    const response = await putDeadline(projectId, { expectedVersion: 0, deadline: { localCivil: AUTOMATIC_MONDAY.civil }, reminderOffsetsMinutes: [1440, 240, 60] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "deadline_version_conflict", current: { version: 1, source: "automatic" } });
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_source: "automatic", deadline_version: 1 });
  });

  it("records manual for any different value, and clearing leaves no source", async () => {
    const projectId = await createProject({ shootDate: "2026-10-02" });
    const set = await putDeadline(projectId, { expectedVersion: 1, deadline: { localCivil: "2026-10-07T09:00" }, reminderOffsetsMinutes: [60] });
    expect(await set.json()).toMatchObject({ current: { source: "manual", version: 2 } });
    const clear = await putDeadline(projectId, { expectedVersion: 2, deadline: null });
    expect(await clear.json()).toMatchObject({ changed: true, current: { source: null, deadline: null } });
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_source: "none", deadline_at: null });
  });

  it("rejects a stale save as a conflict that carries the automatic source", async () => {
    const projectId = await createProject({ shootDate: "2026-10-02" });
    const stale = await putDeadline(projectId, { expectedVersion: 0, deadline: { localCivil: "2026-10-07T09:00" }, reminderOffsetsMinutes: [] });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "deadline_version_conflict", current: { version: 1, source: "automatic" } });
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_source: "automatic", deadline_version: 1 });
  });

  it("reads a Deadline held without a stored source as manual", async () => {
    const projectId = await seedProject();
    await database.DB.prepare("UPDATE projects SET deadline_at = ?, deadline_local_civil = '2026-11-20T17:00', deadline_zone = 'Australia/Sydney', deadline_utc_offset_minutes = 660, deadline_fold = 0, deadline_version = 1 WHERE id = ?").bind(Date.parse("2026-11-20T06:00:00.000Z"), projectId).run();
    const detail = await (await request(`/api/projects/${projectId}`, "GET")).json() as { deadlineSchedule: { source: string | null } };
    expect(detail.deadlineSchedule.source).toBe("manual");
  });
});

describe("an Automatic Deadline follows a shoot-date reschedule (#485)", () => {
  const putDeadline = (projectId: string, body: unknown) => request(`/api/projects/${projectId}/deadline`, "PUT", body);
  const patchDate = (projectId: string, shootDate: string | null) => request(`/api/projects/${projectId}`, "PATCH", { shootDate });
  const movedAudits = async (projectId: string) => (await database.DB.prepare("SELECT actor_id, meta_json FROM audit_log WHERE target_id = ? AND action = 'project.deadline.automatic_moved'").bind(projectId).all<{ actor_id: string | null; meta_json: string }>()).results;
  const slots = async (projectId: string) => (await database.DB.prepare("SELECT reminder_offset_minutes AS offset, status, terminal_reason AS reason, schedule_version AS version, fire_at, fired_at FROM project_deadline_occurrences WHERE project_id = ? ORDER BY schedule_version, reminder_offset_minutes DESC").bind(projectId).all<{ offset: number; status: string; reason: string | null; version: number; fire_at: number; fired_at: number | null }>()).results;
  const DEFAULT_BODY = { reminderOffsetsMinutes: [1440, 240, 60] };

  it("moves an automatic Deadline across the DST change, bumps its version and audits it with a system actor", async () => {
    // Thu 1 Oct shoot: due Fri 2 Oct 17:00 +10:00. Rescheduled to Fri 2 Oct: due Mon 5 Oct 17:00 +11:00.
    const projectId = await createProject({ shootDate: "2026-10-01" });
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_local_civil: "2026-10-02T17:00", deadline_version: 1, deadline_utc_offset_minutes: 600 });
    expect((await patchDate(projectId, "2026-10-02")).status).toBe(200);
    expect(await deadlineOf(projectId)).toEqual({ deadline_at: AUTOMATIC_MONDAY.at, deadline_local_civil: AUTOMATIC_MONDAY.civil, deadline_source: "automatic", deadline_version: 2, deadline_utc_offset_minutes: 660 });
    const audits = await movedAudits(projectId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor_id).toBeNull();
    expect(JSON.parse(audits[0]!.meta_json)).toMatchObject({ actor: "system", reason: "details", shootDate: "2026-10-02", previousDeadlineLocalCivil: "2026-10-02T17:00", deadlineLocalCivil: AUTOMATIC_MONDAY.civil, version: 2 });
    const rows = await slots(projectId);
    // v1's 24h slot had already elapsed when it was created (skipped); the rest were pending and are replaced.
    expect(rows.filter((row) => row.version === 1).map((row) => [row.offset, row.status, row.reason])).toEqual([[1440, "skipped", "elapsed_at_save"], [240, "superseded", "schedule_replaced"], [60, "superseded", "schedule_replaced"], [0, "superseded", "schedule_replaced"]]);
    expect(rows.filter((row) => row.version === 2).map((row) => [row.offset, row.status, row.fire_at])).toEqual([1440, 240, 60, 0].map((offset) => [offset, "pending", AUTOMATIC_MONDAY.at - offset * 60_000]));
    const detail = await (await request(`/api/projects/${projectId}`, "GET")).json() as { deadlineSchedule: { source: string; version: number; deadline: { localCivil: string } } };
    expect(detail.deadlineSchedule).toMatchObject({ source: "automatic", version: 2, deadline: { localCivil: AUTOMATIC_MONDAY.civil } });
  });

  it("never moves a Deadline a person set, even at exactly the automatic value", async () => {
    const differing = await createProject({ shootDate: "2026-10-01" });
    expect((await putDeadline(differing, { expectedVersion: 1, deadline: { localCivil: "2026-10-20T09:00" }, ...DEFAULT_BODY })).status).toBe(200);
    expect((await patchDate(differing, "2026-10-02")).status).toBe(200);
    expect(await deadlineOf(differing)).toMatchObject({ deadline_local_civil: "2026-10-20T09:00", deadline_source: "manual", deadline_version: 2 });
    expect(await movedAudits(differing)).toHaveLength(0);

    // The binding case: confirming the automatic value bumps no version but makes it manual.
    const confirmed = await createProject({ shootDate: "2026-10-01" });
    expect((await putDeadline(confirmed, { expectedVersion: 1, deadline: { localCivil: "2026-10-02T17:00" }, ...DEFAULT_BODY })).status).toBe(200);
    expect(await deadlineOf(confirmed)).toMatchObject({ deadline_source: "manual", deadline_version: 1 });
    expect((await patchDate(confirmed, "2026-10-02")).status).toBe(200);
    expect(await deadlineOf(confirmed)).toMatchObject({ deadline_local_civil: "2026-10-02T17:00", deadline_source: "manual", deadline_version: 1 });
    expect(await movedAudits(confirmed)).toHaveLength(0);
  });

  it("carries a sent reminder as sent and reschedules the unsent ones, with no notification traffic", async () => {
    const projectId = await createProject({ shootDate: "2026-10-01" });
    const sentAt = Date.now() - 1000;
    await database.DB.prepare("UPDATE project_deadline_occurrences SET status = 'fired', terminal_reason = NULL, fired_at = ? WHERE project_id = ? AND reminder_offset_minutes = 1440").bind(sentAt, projectId).run();
    expect((await patchDate(projectId, "2026-10-02")).status).toBe(200);
    const v2 = (await slots(projectId)).filter((row) => row.version === 2);
    expect(v2.map((row) => [row.offset, row.status, row.fired_at])).toEqual([[1440, "fired", sentAt], [240, "pending", null], [60, "pending", null], [0, "pending", null]]);
    expect(v2.filter((row) => row.status === "pending").map((row) => row.fire_at)).toEqual([240, 60, 0].map((offset) => AUTOMATIC_MONDAY.at - offset * 60_000));
    expect(await database.DB.prepare("SELECT count(*) AS n FROM notification_outbox WHERE project_id = ?").bind(projectId).first()).toEqual({ n: 0 });
  });

  it("carries a sent reminder through a second move", async () => {
    const projectId = await createProject({ shootDate: "2026-10-01" });
    const sentAt = Date.now() - 1000;
    await database.DB.prepare("UPDATE project_deadline_occurrences SET status = 'fired', terminal_reason = NULL, fired_at = ? WHERE project_id = ? AND reminder_offset_minutes = 240").bind(sentAt, projectId).run();
    expect((await patchDate(projectId, "2026-10-02")).status).toBe(200);
    expect((await patchDate(projectId, "2026-10-12")).status).toBe(200);
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_local_civil: "2026-10-13T17:00", deadline_version: 3 });
    const v3 = (await slots(projectId)).filter((row) => row.version === 3);
    expect(v3.map((row) => [row.offset, row.status, row.fired_at])).toEqual([[1440, "pending", null], [240, "fired", sentAt], [60, "pending", null], [0, "pending", null]]);
  });

  it("skips every unsent reminder when the move lands in the past, due-now included", async () => {
    const projectId = await createProject({ shootDate: "2026-10-01" });
    expect((await patchDate(projectId, "2026-09-02")).status).toBe(200);
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_local_civil: "2026-09-03T17:00", deadline_version: 2 });
    const v2 = (await slots(projectId)).filter((row) => row.version === 2);
    expect(v2).toHaveLength(4);
    expect(v2.every((row) => row.status === "skipped" && row.reason === "elapsed_at_save")).toBe(true);
  });

  it("leaves the Deadline alone when the reschedule resolves to the same Deadline", async () => {
    const projectId = await createProject({ shootDate: "2026-10-10" });
    expect((await patchDate(projectId, "2026-10-11")).status).toBe(200);
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_local_civil: "2026-10-12T17:00", deadline_version: 1 });
    expect(await movedAudits(projectId)).toHaveLength(0);
    expect((await slots(projectId)).every((row) => row.version === 1 && row.status === "pending")).toBe(true);
  });

  it("clearing the shoot date, or writing free text, leaves the Deadline automatic; a returning date recomputes it", async () => {
    const projectId = await createProject({ shootDate: "2026-10-01" });
    expect((await patchDate(projectId, null)).status).toBe(200);
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_local_civil: "2026-10-02T17:00", deadline_source: "automatic", deadline_version: 1 });
    expect((await patchDate(projectId, "TBC")).status).toBe(200);
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_local_civil: "2026-10-02T17:00", deadline_source: "automatic", deadline_version: 1 });
    expect(await movedAudits(projectId)).toHaveLength(0);
    expect((await patchDate(projectId, "2026-10-02")).status).toBe(200);
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_local_civil: AUTOMATIC_MONDAY.civil, deadline_source: "automatic", deadline_version: 2 });
    expect(JSON.parse((await movedAudits(projectId))[0]!.meta_json)).toMatchObject({ shootDate: "2026-10-02", reason: "details" });
  });

  it("rejects a Deadline save made against the version from before an automatic move, at any value", async () => {
    const projectId = await createProject({ shootDate: "2026-10-01" });
    expect((await patchDate(projectId, "2026-10-02")).status).toBe(200);
    for (const localCivil of ["2026-10-20T09:00", AUTOMATIC_MONDAY.civil]) {
      const stale = await putDeadline(projectId, { expectedVersion: 1, deadline: { localCivil }, ...DEFAULT_BODY });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ code: "deadline_version_conflict", current: { version: 2, source: "automatic" } });
    }
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_source: "automatic", deadline_version: 2 });
  });

  it("does not move a Delivered Project's Deadline", async () => {
    const projectId = await createProject({ shootDate: "2026-10-01" });
    await database.DB.prepare("UPDATE projects SET stage_key = 'delivered' WHERE id = ?").bind(projectId).run();
    expect((await patchDate(projectId, "2026-10-02")).status).toBe(200);
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_local_civil: "2026-10-02T17:00", deadline_version: 1 });
    expect(await movedAudits(projectId)).toHaveLength(0);
  });

  it("does not backfill a Deadline on a reschedule of a Project that holds a shoot date and no Deadline", async () => {
    const projectId = await seedProject({ shootDate: "2026-09-15" });
    expect((await patchDate(projectId, "2026-10-02")).status).toBe(200);
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_at: null, deadline_source: "none", deadline_version: 0 });
    expect(await movedAudits(projectId)).toHaveLength(0);
    expect(await automaticAudits(projectId)).toHaveLength(0);
  });
});

describe("Deadline and Priority on create (#488)", () => {
  const post = (body: Record<string, unknown>) => request("/api/projects", "POST", { street: `New ${crypto.randomUUID()}`, ...body });
  const projectCount = async () => (await database.DB.prepare("SELECT COUNT(*) AS n FROM projects").first<{ n: number }>())!.n;
  const auditsOf = async (projectId: string, action: string) => (await database.DB.prepare("SELECT actor_id, meta_json FROM audit_log WHERE target_id = ? AND action = ?").bind(projectId, action).all<{ actor_id: string | null; meta_json: string }>()).results;

  it("stores a supplied Deadline as manual with its reminders, in the same write as the Project", async () => {
    const response = await post({ shootDate: "2026-10-02", deadline: { localCivil: "2026-10-06T10:00", reminderOffsetsMinutes: [120, 30] } });
    expect(response.status).toBe(201);
    const { id } = await response.json() as { id: string };
    expect(await deadlineOf(id)).toEqual({ deadline_at: Date.parse("2026-10-05T23:00:00.000Z"), deadline_local_civil: "2026-10-06T10:00", deadline_source: "manual", deadline_version: 1, deadline_utc_offset_minutes: 660 });
    expect((await occurrencesOf(id)).map((row) => [row.kind, row.offset, row.status, row.version, row.created_by])).toEqual([["advance", 120, "pending", 1, userId], ["advance", 30, "pending", 1, userId], ["due_now", 0, "pending", 1, userId]]);
    expect(await automaticAudits(id)).toHaveLength(0);
    const saved = await auditsOf(id, "project.deadline.schedule_saved");
    expect(saved).toHaveLength(1);
    expect(saved[0]!.actor_id).toBe(userId);
    expect(JSON.parse(saved[0]!.meta_json)).toMatchObject({ version: 1, operation: "set", via: "create" });
    const detail = await (await request(`/api/projects/${id}`, "GET")).json() as { deadlineSchedule: { source: string; version: number; reminderOffsetsMinutes: number[]; deadline: { localCivil: string } } };
    expect(detail.deadlineSchedule).toMatchObject({ source: "manual", version: 1, reminderOffsetsMinutes: [120, 30], deadline: { localCivil: "2026-10-06T10:00" } });
  });

  it("defaults a supplied Deadline's reminders to none, stores it without a shoot date, and fills no shoot date", async () => {
    const response = await post({ deadline: { localCivil: "2026-10-06T10:00" } });
    expect(response.status).toBe(201);
    const { id, shootDate } = await response.json() as { id: string; shootDate: string | null };
    expect(shootDate).toBeNull();
    expect((await deadlineOf(id)).deadline_source).toBe("manual");
    expect((await occurrencesOf(id)).map((row) => [row.kind, row.offset])).toEqual([["due_now", 0]]);
    expect((await database.DB.prepare("SELECT shoot_date FROM projects WHERE id = ?").bind(id).first<{ shoot_date: string | null }>())!.shoot_date).toBeNull();
  });

  it("a manual Deadline equal to the automatic value is still manual, and replaces the automatic one", async () => {
    const id = await createProject({ shootDate: "2026-10-02", deadline: { localCivil: AUTOMATIC_MONDAY.civil, reminderOffsetsMinutes: [1440, 240, 60] } });
    expect(await deadlineOf(id)).toMatchObject({ deadline_source: "manual", deadline_version: 1, deadline_local_civil: AUTOMATIC_MONDAY.civil });
    expect(await automaticAudits(id)).toHaveLength(0);
  });

  it("an explicit null Deadline with a shoot date, and an absent one, both get the server-computed automatic value", async () => {
    for (const body of [{ shootDate: "2026-10-02", deadline: null }, { shootDate: "2026-10-02" }]) {
      const id = await createProject(body);
      expect(await deadlineOf(id)).toMatchObject({ deadline_source: "automatic", deadline_local_civil: AUTOMATIC_MONDAY.civil, deadline_version: 1 });
    }
    const noDate = await createProject({ deadline: null });
    expect(await deadlineOf(noDate)).toMatchObject({ deadline_source: "none", deadline_at: null, deadline_version: 0 });
  });

  it("stores Priority and returns it; unset stays null", async () => {
    const response = await post({ priority: 4 });
    expect(response.status).toBe(201);
    const body = await response.json() as { id: string; priority: number | null; stageKey: string };
    expect(body).toMatchObject({ priority: 4, stageKey: "awaiting_raw" });
    expect((await database.DB.prepare("SELECT priority FROM projects WHERE id = ?").bind(body.id).first<{ priority: number | null }>())!.priority).toBe(4);
    expect(JSON.parse((await auditsOf(body.id, "project.create"))[0]!.meta_json)).toMatchObject({ priority: 4 });
    for (const unset of [{ priority: null }, {}]) {
      const created = await (await post(unset)).json() as { priority: number | null; id: string };
      expect(created.priority).toBeNull();
      expect((await database.DB.prepare("SELECT priority FROM projects WHERE id = ?").bind(created.id).first<{ priority: number | null }>())!.priority).toBeNull();
    }
  });

  it("rejects an invalid Priority and creates nothing", async () => {
    const before = await projectCount();
    for (const priority of [0, 6, 2.5, "3", -1]) expect((await post({ priority })).status).toBe(400);
    expect(await projectCount()).toBe(before);
  });

  it("rejects an invalid Deadline and creates nothing", async () => {
    const before = await projectCount();
    const gap = await post({ deadline: { localCivil: "2026-10-04T02:30" } });
    expect(gap.status).toBe(400);
    expect(await gap.json()).toMatchObject({ code: "deadline_nonexistent_local_time" });
    const repeated = await post({ deadline: { localCivil: "2027-04-04T02:30" } });
    expect(repeated.status).toBe(400);
    expect(await repeated.json()).toMatchObject({ code: "deadline_repeated_local_time", choices: expect.any(Array) });
    const badOffsets = await post({ deadline: { localCivil: "2026-10-06T10:00", reminderOffsetsMinutes: [0] } });
    expect(badOffsets.status).toBe(400);
    expect(await badOffsets.json()).toMatchObject({ code: "deadline_invalid_reminder_offsets" });
    expect((await post({ deadline: { localCivil: "not a time" } })).status).toBe(400);
    expect((await post({ deadline: { localCivil: "2026-10-06T10:00", source: "automatic" } })).status).toBe(400);
    expect(await projectCount()).toBe(before);
  });

  it("stores the chosen fold of a repeated local time", async () => {
    const id = await createProject({ deadline: { localCivil: "2027-04-04T02:30", disambiguation: "later" } });
    expect(await deadlineOf(id)).toMatchObject({ deadline_source: "manual", deadline_local_civil: "2027-04-04T02:30", deadline_utc_offset_minutes: 600 });
  });

  it("never accepts a Stage on create", async () => {
    const created = await (await post({ stageKey: "editing", shootDate: "2026-10-02" })).json() as { stageKey: string };
    expect(created.stageKey).toBe("awaiting_raw");
  });

  it("keeps team assignments, services and the manual Deadline together", async () => {
    const editor = crypto.randomUUID();
    const nowMs = Date.now();
    await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, 'Ed', ?, 1, 'editor', 1, 0, ?, ?)").bind(editor, `${editor}@example.test`, nowMs, nowMs).run();
    const response = await post({ shootDate: "2026-10-02", editorUserIds: [editor], orderedServices: ["video"], priority: 2, deadline: { localCivil: "2026-10-06T10:00", reminderOffsetsMinutes: [60] }, agentName: "Pat", orderNo: "N1" });
    expect(response.status).toBe(201);
    const body = await response.json() as { id: string; agentName: string; orderNo: string; priority: number; members: Array<{ userId: string }> };
    expect(body).toMatchObject({ agentName: "Pat", orderNo: "N1", priority: 2 });
    expect(body.members.map((m) => m.userId)).toContain(editor);
    expect(await deadlineOf(body.id)).toMatchObject({ deadline_source: "manual", deadline_local_civil: "2026-10-06T10:00" });
  });
});
