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

  it("records manual even when the person saves exactly the automatic value, and bumps the version", async () => {
    const projectId = await createProject({ shootDate: "2026-10-02" });
    const response = await putDeadline(projectId, { expectedVersion: 1, deadline: { localCivil: AUTOMATIC_MONDAY.civil }, reminderOffsetsMinutes: [1440, 240, 60] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ changed: true, current: { version: 2, source: "manual" } });
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_source: "manual", deadline_version: 2, deadline_at: AUTOMATIC_MONDAY.at });
    const live = (await occurrencesOf(projectId)).filter((row) => row.version === 2);
    expect(live.map((row) => [row.kind, row.offset, row.status])).toEqual([["advance", 1440, "pending"], ["advance", 240, "pending"], ["advance", 60, "pending"], ["due_now", 0, "pending"]]);
    // A second identical save is the ordinary no-op.
    expect(await (await putDeadline(projectId, { expectedVersion: 2, deadline: { localCivil: AUTOMATIC_MONDAY.civil }, reminderOffsetsMinutes: [1440, 240, 60] })).json()).toMatchObject({ changed: false, current: { version: 2, source: "manual" } });
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
