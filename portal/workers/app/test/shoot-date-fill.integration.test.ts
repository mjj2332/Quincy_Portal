import { env } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/auth";
import app from "../src/index";
import { stageMoveConfirmationReasons } from "@quincy/shared";
import type { Env, SessionUser } from "../src/env";
import { moveProjectStage } from "../src/lib/project-stage";
import { queueProjectShootDateFollowUps } from "../src/lib/project-shoot-date";

/**
 * #411 / #413: the Shoot date fill on a manual Stage move out of Awaiting RAW and on a Deadline
 * save. The clock is pinned to an instant whose UTC day (2026-10-01) differs from its Sydney day
 * (2026-10-02), so a naive-UTC implementation fails every date assertion.
 */
const TEST_NOW = new Date("2026-10-01T14:30:00.000Z");
const SYDNEY_DAY = "2026-10-02";

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const adminId = crypto.randomUUID();
const adminToken = `fill-admin-${crypto.randomUUID()}`;
const impersonatorId = crypto.randomUUID();
declare const __PORTAL_MIGRATION_SQL__: string;

async function executeSql(source: string) {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const flat = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of flat.split(";")) {
      const value = statement.replace(/\s+/g, " ").trim();
      if (value) await database.DB.exec(`${value};`);
    }
  }
}

async function cookie(token: string) {
  const context = await createAuth(baseEnv).$context;
  return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes")}`;
}

type CallOptions = { editorAutomation?: string; db?: D1Database };
/** Runs the real app with a recording BACKGROUND and every waitUntil promise awaited. */
async function call(path: string, method: "POST" | "PUT", body: unknown, options: CallOptions = {}) {
  const editorFolderCalls: string[] = [];
  const waits: Promise<unknown>[] = [];
  const executionContext = { waitUntil: (promise: Promise<unknown>) => { waits.push(promise); }, passThroughOnException: () => undefined, props: undefined } as unknown as ExecutionContext;
  const environment = {
    ...baseEnv,
    ...(options.db ? { DB: options.db } : {}),
    DROPBOX_EDITOR_AUTOMATION_ENABLED: options.editorAutomation ?? "1",
    BACKGROUND: { ensureEditorFolder: async (projectId: string) => { editorFolderCalls.push(projectId); return { jobId: "job" }; } } as unknown as Env["BACKGROUND"],
  } as Env;
  const response = await app.fetch(new Request(`https://portal.test${path}`, {
    method,
    headers: { cookie: await cookie(adminToken), origin: baseEnv.APP_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  }), environment, executionContext);
  await Promise.all(waits);
  return { response, editorFolderCalls };
}

async function seedProject(stageKey: string, shootDate: string | null = null, boardPosition = 0) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, shoot_date, board_position, board_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)")
    .bind(id, `Fill ${id}`, stageKey, shootDate, boardPosition, now, now).run();
  return id;
}

const stageBody = (from: string, to: string, boardRevision = 0, confirmation?: { reasons: string[] }) => ({
  expected: { stageKey: from, boardRevision }, targetStageKey: to, placement: { kind: "append" }, ...(confirmation ? { confirmation } : {}),
});

/** Moves a Project, answering any confirmation with exactly the reasons the server demands. */
async function moveStage(projectId: string, from: string, to: string, options: CallOptions = {}) {
  const first = await call(`/api/projects/${projectId}/stage`, "POST", stageBody(from, to), options);
  if (first.response.status !== 409) return first;
  const payload = await first.response.clone().json() as { code?: string; requiredConfirmation?: { reasons: string[] } };
  if (payload.code !== "stage_confirmation_required") return first;
  return call(`/api/projects/${projectId}/stage`, "POST", stageBody(from, to, 0, { reasons: payload.requiredConfirmation!.reasons }), options);
}

const shootDateOf = async (projectId: string) => (await database.DB.prepare("SELECT shoot_date FROM projects WHERE id = ?").bind(projectId).first<{ shoot_date: string | null }>())?.shoot_date ?? null;
const fillAudits = async (projectId: string) => (await database.DB.prepare("SELECT actor_id, meta_json FROM audit_log WHERE target_id = ? AND action = 'project.shoot_date.changed'").bind(projectId).all<{ actor_id: string | null; meta_json: string }>()).results;
const auditCount = async (projectId: string) => (await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ?").bind(projectId).first<{ count: number }>())!.count;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: TEST_NOW });
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run();
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, 'Fill Admin', ?, 1, 'admin', 1, 0, ?, ?)").bind(adminId, `${adminId}@example.test`, now, now),
    database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, adminToken, adminId, now, now),
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, 'Fill Impersonator', ?, 1, 'admin', 1, 0, ?, ?)").bind(impersonatorId, `${impersonatorId}@example.test`, now, now),
  ]);
});
afterAll(() => { vi.useRealTimers(); });

describe("Shoot date fill on a manual Stage move (#411)", () => {
  it("fills an empty date with the Sydney day when a Project leaves Awaiting RAW, for any destination", async () => {
    for (const destination of ["raw_review", "editing_autohdr", "edited_review", "delivered"]) {
      const projectId = await seedProject("awaiting_raw");
      const { response, editorFolderCalls } = await moveStage(projectId, "awaiting_raw", destination);
      expect(response.status).toBe(200);
      expect(await response.json()).not.toHaveProperty("shootDateFilled");
      expect(await shootDateOf(projectId)).toBe(SYDNEY_DAY);
      const audits = await fillAudits(projectId);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.actor_id).toBe(adminId);
      const meta = JSON.parse(audits[0]!.meta_json);
      expect(meta).toEqual({ shootDate: SYDNEY_DAY, previousShootDate: null, reason: "stage_move" });
      expect(meta).not.toHaveProperty("eventReceivedAt");
      expect(editorFolderCalls).toEqual([projectId]);
    }
  });

  it("keeps a canonical date and unparsed text, writes no fill audit and queues no Editor follow-up", async () => {
    for (const held of ["2026-09-15", "TBC next week"]) {
      const projectId = await seedProject("awaiting_raw", held);
      const { response, editorFolderCalls } = await moveStage(projectId, "awaiting_raw", "raw_review");
      expect(response.status).toBe(200);
      expect(await shootDateOf(projectId)).toBe(held);
      expect(await fillAudits(projectId)).toHaveLength(0);
      expect(editorFolderCalls).toEqual([]);
    }
  });

  it("does not fill on a later-Stage move or on a move back into Awaiting RAW", async () => {
    const forward = await seedProject("raw_review");
    expect((await moveStage(forward, "raw_review", "editing_autohdr")).response.status).toBe(200);
    const backward = await seedProject("raw_review");
    expect((await moveStage(backward, "raw_review", "awaiting_raw")).response.status).toBe(200);
    for (const projectId of [forward, backward]) {
      expect(await shootDateOf(projectId)).toBeNull();
      expect(await fillAudits(projectId)).toHaveLength(0);
    }
  });

  it("writes nothing on the 409 confirmation round trip, and the confirmed request fills", async () => {
    const projectId = await seedProject("awaiting_raw");
    const first = await call(`/api/projects/${projectId}/stage`, "POST", stageBody("awaiting_raw", "delivered"));
    expect(first.response.status).toBe(409);
    const payload = await first.response.json() as { code: string; requiredConfirmation: { reasons: string[] } };
    expect(payload.code).toBe("stage_confirmation_required");
    expect(await shootDateOf(projectId)).toBeNull();
    expect(await auditCount(projectId)).toBe(0);
    expect(await database.DB.prepare("SELECT stage_key, board_revision FROM projects WHERE id = ?").bind(projectId).first()).toEqual({ stage_key: "awaiting_raw", board_revision: 0 });
    expect(first.editorFolderCalls).toEqual([]);

    const confirmed = await call(`/api/projects/${projectId}/stage`, "POST", stageBody("awaiting_raw", "delivered", 0, { reasons: payload.requiredConfirmation.reasons }));
    expect(confirmed.response.status).toBe(200);
    expect(await shootDateOf(projectId)).toBe(SYDNEY_DAY);
    expect(await fillAudits(projectId)).toHaveLength(1);
  });

  it("does not fill on a stale Board revision conflict", async () => {
    const projectId = await seedProject("awaiting_raw");
    const { response, editorFolderCalls } = await call(`/api/projects/${projectId}/stage`, "POST", stageBody("awaiting_raw", "raw_review", 7));
    expect(response.status).toBe(409);
    expect(await shootDateOf(projectId)).toBeNull();
    expect(await auditCount(projectId)).toBe(0);
    expect(editorFolderCalls).toEqual([]);
  });

  it("queues the Editor follow-up only when Editor automation is enabled, but still fills", async () => {
    const projectId = await seedProject("awaiting_raw");
    const { response, editorFolderCalls } = await moveStage(projectId, "awaiting_raw", "raw_review", { editorAutomation: "0" });
    expect(response.status).toBe(200);
    expect(await shootDateOf(projectId)).toBe(SYDNEY_DAY);
    expect(editorFolderCalls).toEqual([]);
  });

  it("still queues the Editor follow-up when a later move wins the reread after the fill committed", async () => {
    const projectId = await seedProject("awaiting_raw");
    // A D1 whose batch commits, then another request moves the Project on before this one rereads it.
    const racingDb = new Proxy(database.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            await target.prepare("UPDATE projects SET stage_key = 'editing_autohdr', board_revision = board_revision + 1 WHERE id = ?").bind(projectId).run();
            return results;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    const body = stageBody("awaiting_raw", "raw_review", 0, { reasons: stageMoveConfirmationReasons("awaiting_raw", "raw_review") });
    const { response, editorFolderCalls } = await call(`/api/projects/${projectId}/stage`, "POST", body, { db: racingDb });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "project_stage_conflict" });
    expect(await shootDateOf(projectId)).toBe(SYDNEY_DAY);
    expect(await fillAudits(projectId)).toHaveLength(1);
    expect(editorFolderCalls).toEqual([projectId]);
  });

  it("carries the impersonating Admin in the fill audit, like the stage audit beside it", async () => {
    const projectId = await seedProject("awaiting_raw");
    const admin = await database.DB.prepare("SELECT id, email, name, role FROM user WHERE id = ?").bind(adminId).first<{ id: string; email: string; name: string; role: SessionUser["role"] }>();
    const principal: SessionUser = { ...admin!, active: true, authorizationEpoch: 0, impersonatedBy: impersonatorId };
    const result = await moveProjectStage({ env: baseEnv, principal, projectId, request: stageBody("awaiting_raw", "raw_review", 0, { reasons: stageMoveConfirmationReasons("awaiting_raw", "raw_review") }) as never, now: TEST_NOW.getTime() });
    expect(result.kind).toBe("moved");
    if (result.kind === "moved") expect(result.shootDateFilled).toBe(true);
    const [fill] = await fillAudits(projectId);
    expect(JSON.parse(fill!.meta_json)).toEqual({ shootDate: SYDNEY_DAY, previousShootDate: null, reason: "stage_move", impersonatedBy: impersonatorId });
    const stageAudit = await database.DB.prepare("SELECT meta_json FROM audit_log WHERE target_id = ? AND action = 'stage.set'").bind(projectId).first<{ meta_json: string }>();
    expect(JSON.parse(stageAudit!.meta_json)).toMatchObject({ impersonatedBy: impersonatorId });
  });
});

describe("Shoot date fill on a Deadline save (#413)", () => {
  const deadlineBody = (expectedVersion: number, localCivil = "2027-01-15T09:00") => ({ expectedVersion, deadline: { localCivil }, reminderOffsetsMinutes: [] });
  const put = (projectId: string, body: unknown, options: CallOptions = {}) => call(`/api/projects/${projectId}/deadline`, "PUT", body, options);

  it("fills an empty date past Awaiting RAW with reason deadline_set, without widening the response", async () => {
    const projectId = await seedProject("editing_autohdr");
    const { response, editorFolderCalls } = await put(projectId, deadlineBody(0));
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("shootDateFilled");
    expect(await shootDateOf(projectId)).toBe(SYDNEY_DAY);
    const audits = await fillAudits(projectId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor_id).toBe(adminId);
    expect(JSON.parse(audits[0]!.meta_json)).toEqual({ shootDate: SYDNEY_DAY, previousShootDate: null, reason: "deadline_set" });
    expect(editorFolderCalls).toEqual([projectId]);
  });

  it("leaves a Project in Awaiting RAW undated", async () => {
    const projectId = await seedProject("awaiting_raw");
    const { response, editorFolderCalls } = await put(projectId, deadlineBody(0));
    expect(response.status).toBe(200);
    expect(await shootDateOf(projectId)).toBeNull();
    expect(await fillAudits(projectId)).toHaveLength(0);
    expect(editorFolderCalls).toEqual([]);
  });

  it("never changes a held canonical date or held text", async () => {
    for (const held of ["2026-09-15", "TBC next week"]) {
      const projectId = await seedProject("editing_autohdr", held);
      const { response, editorFolderCalls } = await put(projectId, deadlineBody(0));
      expect(response.status).toBe(200);
      expect(await shootDateOf(projectId)).toBe(held);
      expect(await fillAudits(projectId)).toHaveLength(0);
      expect(editorFolderCalls).toEqual([]);
    }
  });

  it("never fills on a clear, and editing an existing Deadline leaves the filled date alone", async () => {
    const projectId = await seedProject("editing_autohdr");
    expect((await put(projectId, deadlineBody(0))).response.status).toBe(200);
    expect(await shootDateOf(projectId)).toBe(SYDNEY_DAY);

    await database.DB.prepare("UPDATE projects SET shoot_date = NULL WHERE id = ?").bind(projectId).run();
    expect((await put(projectId, { expectedVersion: 1, deadline: null })).response.status).toBe(200);
    expect(await shootDateOf(projectId)).toBeNull();

    await database.DB.prepare("UPDATE projects SET shoot_date = '2026-09-15' WHERE id = ?").bind(projectId).run();
    expect((await put(projectId, deadlineBody(2, "2027-02-01T09:00"))).response.status).toBe(200);
    expect(await shootDateOf(projectId)).toBe("2026-09-15");
    expect(await fillAudits(projectId)).toHaveLength(1);
  });

  it("does not fill when the save loses a Deadline version conflict", async () => {
    const projectId = await seedProject("editing_autohdr");
    const { response, editorFolderCalls } = await put(projectId, deadlineBody(5));
    expect(response.status).toBe(409);
    expect(await shootDateOf(projectId)).toBeNull();
    expect(await fillAudits(projectId)).toHaveLength(0);
    expect(editorFolderCalls).toEqual([]);
  });

  it("does not queue the Editor follow-up when Editor automation is disabled, but still fills", async () => {
    const projectId = await seedProject("editing_autohdr");
    const { response, editorFolderCalls } = await put(projectId, deadlineBody(0), { editorAutomation: "0" });
    expect(response.status).toBe(200);
    expect(await shootDateOf(projectId)).toBe(SYDNEY_DAY);
    expect(editorFolderCalls).toEqual([]);
  });
});

describe("queueProjectShootDateFollowUps", () => {
  it("logs and swallows a background failure so a committed mutation never fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const background = { ensureEditorFolder: vi.fn(async () => { throw new Error("background down"); }) };
    await expect(queueProjectShootDateFollowUps({ DROPBOX_EDITOR_AUTOMATION_ENABLED: "1", BACKGROUND: background as never }, "p1")).resolves.toBeUndefined();
    expect(background.ensureEditorFolder).toHaveBeenCalledWith("p1");
    expect(error).toHaveBeenCalledWith("Editor scaffold trigger failed", expect.objectContaining({ projectId: "p1" }));
    error.mockRestore();
  });

  it("does nothing unless the flag is exactly 1 or true", async () => {
    const background = { ensureEditorFolder: vi.fn(async () => ({ jobId: "j" })) };
    for (const flag of [undefined, "0", "", false] as const) await queueProjectShootDateFollowUps({ DROPBOX_EDITOR_AUTOMATION_ENABLED: flag, BACKGROUND: background as never }, "p1");
    expect(background.ensureEditorFolder).not.toHaveBeenCalled();
    for (const flag of ["1", true] as const) await queueProjectShootDateFollowUps({ DROPBOX_EDITOR_AUTOMATION_ENABLED: flag, BACKGROUND: background as never }, "p1");
    expect(background.ensureEditorFolder).toHaveBeenCalledTimes(2);
  });
});

type DeadlineRow = { deadline_at: number | null; deadline_local_civil: string | null; deadline_source: string; deadline_version: number };
const deadlineOf = async (projectId: string) => (await database.DB.prepare("SELECT deadline_at, deadline_local_civil, deadline_source, deadline_version FROM projects WHERE id = ?").bind(projectId).first<DeadlineRow>())!;
const automaticAudits = async (projectId: string) => (await database.DB.prepare("SELECT actor_id, meta_json FROM audit_log WHERE target_id = ? AND action = 'project.deadline.automatic_set'").bind(projectId).all<{ actor_id: string | null; meta_json: string }>()).results;
const occurrencesOf = async (projectId: string) => (await database.DB.prepare("SELECT kind, reminder_offset_minutes AS offset, status, terminal_reason, schedule_version, created_by FROM project_deadline_occurrences WHERE project_id = ? ORDER BY reminder_offset_minutes DESC").bind(projectId).all<{ kind: string; offset: number; status: string; terminal_reason: string | null; schedule_version: number; created_by: string }>()).results;

describe("Automatic Deadline on the Shoot date fill (#484)", () => {
  it("gives the filled Shoot date an Automatic Deadline: Sydney Friday 2 Oct shoot is due Monday 5 Oct 17:00", async () => {
    const projectId = await seedProject("awaiting_raw");
    const { response } = await moveStage(projectId, "awaiting_raw", "raw_review");
    expect(response.status).toBe(200);
    expect(await shootDateOf(projectId)).toBe(SYDNEY_DAY);
    expect(await deadlineOf(projectId)).toEqual({ deadline_at: Date.parse("2026-10-05T06:00:00.000Z"), deadline_local_civil: "2026-10-05T17:00", deadline_source: "automatic", deadline_version: 1 });
    const audits = await automaticAudits(projectId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor_id).toBeNull();
    expect(JSON.parse(audits[0]!.meta_json)).toMatchObject({ actor: "system", reason: "shoot_date_fill", shootDate: SYDNEY_DAY, deadlineLocalCivil: "2026-10-05T17:00", version: 1, reminderOffsetsMinutes: [1440, 240, 60] });
    const occurrences = await occurrencesOf(projectId);
    expect(occurrences.map((row) => [row.kind, row.offset, row.status])).toEqual([["advance", 1440, "pending"], ["advance", 240, "pending"], ["advance", 60, "pending"], ["due_now", 0, "pending"]]);
    expect(new Set(occurrences.map((row) => row.schedule_version))).toEqual(new Set([1]));
    expect(occurrences.every((row) => row.created_by === "00000000-0000-4000-8000-000000000000")).toBe(true);
  });

  it("never replaces a held Deadline and does not mark it automatic", async () => {
    const projectId = await seedProject("awaiting_raw");
    const held = Date.parse("2026-11-20T06:00:00.000Z");
    await database.DB.prepare("UPDATE projects SET deadline_at = ?, deadline_local_civil = '2026-11-20T17:00', deadline_zone = 'Australia/Sydney', deadline_utc_offset_minutes = 660, deadline_fold = 0, deadline_source = 'manual', deadline_version = 3 WHERE id = ?").bind(held, projectId).run();
    expect((await moveStage(projectId, "awaiting_raw", "editing_autohdr")).response.status).toBe(200);
    expect(await shootDateOf(projectId)).toBe(SYDNEY_DAY);
    expect(await deadlineOf(projectId)).toEqual({ deadline_at: held, deadline_local_civil: "2026-11-20T17:00", deadline_source: "manual", deadline_version: 3 });
    expect(await automaticAudits(projectId)).toHaveLength(0);
    expect(await occurrencesOf(projectId)).toHaveLength(0);
  });

  it("sets no Deadline when the move goes straight to Delivered", async () => {
    const projectId = await seedProject("awaiting_raw");
    expect((await moveStage(projectId, "awaiting_raw", "delivered")).response.status).toBe(200);
    expect(await shootDateOf(projectId)).toBe(SYDNEY_DAY);
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_at: null, deadline_source: "none", deadline_version: 0 });
    expect(await occurrencesOf(projectId)).toHaveLength(0);
  });

  it("leaves a Project that already holds a Shoot date untouched by a stage move", async () => {
    const projectId = await seedProject("awaiting_raw", "2026-09-15");
    expect((await moveStage(projectId, "awaiting_raw", "raw_review")).response.status).toBe(200);
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_at: null, deadline_source: "none" });
    expect(await automaticAudits(projectId)).toHaveLength(0);
  });

  it("writes nothing when the move loses a board revision race", async () => {
    const projectId = await seedProject("awaiting_raw");
    const stale = await call(`/api/projects/${projectId}/stage`, "POST", stageBody("awaiting_raw", "raw_review", 7));
    expect(stale.response.status).toBe(409);
    expect(await shootDateOf(projectId)).toBeNull();
    expect(await deadlineOf(projectId)).toMatchObject({ deadline_at: null, deadline_source: "none" });
    expect(await automaticAudits(projectId)).toHaveLength(0);
  });
});
