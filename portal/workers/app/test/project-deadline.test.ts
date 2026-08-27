import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";
import { ProjectDeadlineError, readProjectDeadlineSchedule, saveProjectDeadlineSchedule, suppressProjectDeadlineWork } from "../src/lib/project-deadline";
import { scanProjectDeadlineOccurrences } from "../../background/src/project-deadline";

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
declare const __PORTAL_MIGRATION_SQL__: string;

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

async function cookie(token: string): Promise<string> {
  const context = await createAuth(baseEnv).$context;
  return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
}

async function request(path: string, token: string, method = "GET", body?: unknown): Promise<Response> {
  const headers = new Headers({ cookie: await cookie(token), origin: baseEnv.APP_ORIGIN });
  if (body !== undefined) headers.set("content-type", "application/json");
  return workerSelf.fetch(`https://portal.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function normalizeEventIntent(intent: NonNullable<Awaited<ReturnType<typeof saveProjectDeadlineSchedule>>["eventIntent"]>, projectId: string) {
  return {
    schemaVersion: intent.schemaVersion,
    activity: {
      ...intent.activity,
      id: "activity-id",
      projectId: "project-id",
      source: { ...intent.activity.source, id: "source-id", key: intent.activity.source.key.replace(projectId, "project-id") },
      deepLink: { ...intent.activity.deepLink, path: "/projects/project-id" },
    },
    broadDelivery: { ...intent.broadDelivery, sourceActivityId: "activity-id" },
  };
}

describe("TB4B Deadline and personal preference APIs", () => {
  const token = `tb4b-deadline-${crypto.randomUUID()}`;
  const userId = crypto.randomUUID();
  const projectId = crypto.randomUUID();

  beforeAll(async () => {
    await executeSql(__PORTAL_MIGRATION_SQL__);
    const now = Date.now();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'TB4B Operator', ?, 1, 'admin', 1, ?, ?)").bind(userId, `${userId}@example.test`, now, now),
      database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, token, userId, now, now),
      database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Deadline API Street', 'edited_review', 0, ?, ?)").bind(projectId, now, now),
    ]);
  });

  it("sets, no-ops, conflicts, clears, and rejects the trailing-slash route without mutation", async () => {
    const deadline = { localCivil: "2027-01-15T09:00" };
    const set = await request(`/api/projects/${projectId}/deadline`, token, "PUT", { expectedVersion: 0, deadline, reminderOffsetsMinutes: [1440, 60] });
    expect(set.status).toBe(200);
    const setBody = await set.json() as { changed: boolean; current: { version: number; reminderOffsetsMinutes: number[]; deadline: { zone: string; fold: number } }; eventIntent: unknown };
    expect(setBody).toMatchObject({ changed: true, current: { version: 1, reminderOffsetsMinutes: [1440, 60], deadline: { zone: "Australia/Sydney", fold: 0 } }, eventIntent: { activity: { type: "project.deadline.schedule_changed", safePayload: { operation: "set", version: 1 } } } });

    const noOp = await request(`/api/projects/${projectId}/deadline`, token, "PUT", { expectedVersion: 1, deadline, reminderOffsetsMinutes: [60, 1440] });
    expect(noOp.status).toBe(200);
    expect(await noOp.json()).toMatchObject({ changed: false, current: { version: 1 } });

    const conflict = await request(`/api/projects/${projectId}/deadline`, token, "PUT", { expectedVersion: 0, deadline: { localCivil: "2027-01-16T09:00" }, reminderOffsetsMinutes: [] });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "deadline_version_conflict", current: { version: 1 } });

    const slash = await request(`/api/projects/${projectId}/deadline/`, token, "PUT", { expectedVersion: 1, deadline: null });
    expect(slash.status).toBe(404);
    expect(await database.DB.prepare("SELECT deadline_version AS version FROM projects WHERE id = ?").bind(projectId).first()).toEqual({ version: 1 });

    const clear = await request(`/api/projects/${projectId}/deadline`, token, "PUT", { expectedVersion: 1, deadline: null });
    expect(clear.status).toBe(200);
    expect(await clear.json()).toMatchObject({ changed: true, current: { version: 2, deadline: null, reminderOffsetsMinutes: [], state: "unset" } });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'project.deadline.schedule_saved' AND target_id = ?").bind(projectId).first()).toEqual({ count: 2 });

    await database.DB.prepare("UPDATE projects SET stage_key = 'delivered' WHERE id = ?").bind(projectId).run();
    const delivered = await request(`/api/projects/${projectId}/deadline`, token, "PUT", { expectedVersion: 2, deadline: { localCivil: "2027-01-20T09:00" }, reminderOffsetsMinutes: [] });
    expect(delivered.status).toBe(409);
    expect(await delivered.json()).toMatchObject({ code: "deadline_project_delivered" });
    expect(await database.DB.prepare("SELECT deadline_version AS version, deadline_at AS deadlineAt FROM projects WHERE id = ?").bind(projectId).first()).toEqual({ version: 2, deadlineAt: null });
  });

  it("is strict, self-only, default-on, and idempotent for personal preferences", async () => {
    const initial = await request("/api/notification-preferences", token);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ projectDeadlineReminderEmails: true });

    const disabled = await request("/api/notification-preferences", token, "PATCH", { projectDeadlineReminderEmails: false });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toEqual({ projectDeadlineReminderEmails: false });
    const repeated = await request("/api/notification-preferences", token, "PATCH", { projectDeadlineReminderEmails: false });
    expect(await repeated.json()).toEqual({ projectDeadlineReminderEmails: false });

    const extra = await request("/api/notification-preferences", token, "PATCH", { projectDeadlineReminderEmails: true, anotherUserId: crypto.randomUUID() });
    expect(extra.status).toBe(400);
    expect((await database.DB.prepare("SELECT user_id AS userId, project_deadline_reminder_emails AS enabled FROM notification_preferences").all()).results).toMatchObject([{ userId, enabled: 0 }]);
  });

  it("keeps a surviving current-version occurrence active instead of exposing Resume", async () => {
    const now = Date.now();
    const residualProjectId = crypto.randomUUID();
    const deadlineAt = now + 3_600_000;
    await database.DB.batch([
      database.DB.prepare("INSERT INTO projects (id, street, stage_key, deadline_at, deadline_local_civil, deadline_zone, deadline_utc_offset_minutes, deadline_fold, deadline_reminder_offsets_json, deadline_version, created_at, updated_at) VALUES (?, 'Residual Deadline Street', 'editing_autohdr', ?, '2027-01-15T09:00', 'Australia/Sydney', 600, 0, '[]', 1, ?, ?)").bind(residualProjectId, deadlineAt, now, now),
      database.DB.prepare("INSERT INTO project_deadline_occurrences (id, project_id, schedule_version, kind, reminder_offset_minutes, fire_at, deadline_at, deadline_local_civil, deadline_zone, deadline_utc_offset_minutes, deadline_fold, status, terminal_reason, created_by, created_at, updated_at) VALUES (?, ?, 1, 'advance', 60, ?, ?, '2027-01-15T09:00', 'Australia/Sydney', 600, 0, 'superseded', 'project_delivered', ?, ?, ?), (?, ?, 1, 'due_now', 0, ?, ?, '2027-01-15T09:00', 'Australia/Sydney', 600, 0, 'pending', NULL, ?, ?, ?)").bind(crypto.randomUUID(), residualProjectId, deadlineAt - 3_600_000, deadlineAt, userId, now, now, crypto.randomUUID(), residualProjectId, deadlineAt, deadlineAt, userId, now, now),
    ]);
    const schedule = await readProjectDeadlineSchedule(database.DB, residualProjectId, now);
    expect(schedule).toMatchObject({ canResume: false, nextOccurrence: { kind: "due_now" } });
  });

  it("materializes Due-now plus elapsed skips and preserves processing history on edit", async () => {
    const now = Date.now();
    const commandProjectId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Command Deadline Street', 'editing_autohdr', ?, ?)").bind(commandProjectId, now, now).run();
    const past = await saveProjectDeadlineSchedule(database.DB, {
      projectId: commandProjectId,
      principal: { id: userId, impersonatedBy: null },
      now,
      request: { expectedVersion: 0, deadline: { localCivil: "2026-08-26T09:00" }, reminderOffsetsMinutes: [1440, 60] },
    });
    expect(past).toMatchObject({ changed: true, current: { version: 1, state: "overdue", skippedReminderOffsetsMinutes: [1440, 60] }, eventIntent: { activity: { safePayload: { operation: "set", version: 1 } } } });
    expect((await database.DB.prepare("SELECT kind, status, terminal_reason AS terminalReason FROM project_deadline_occurrences WHERE project_id = ? ORDER BY kind, reminder_offset_minutes DESC").bind(commandProjectId).all()).results).toMatchObject([
      { kind: "advance", status: "skipped", terminalReason: "elapsed_at_save" },
      { kind: "advance", status: "skipped", terminalReason: "elapsed_at_save" },
      { kind: "due_now", status: "pending", terminalReason: null },
    ]);

    const liveProjectId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Edit Deadline Street', 'editing_autohdr', ?, ?)").bind(liveProjectId, now, now).run();
    await saveProjectDeadlineSchedule(database.DB, { projectId: liveProjectId, principal: { id: userId, impersonatedBy: null }, now, request: { expectedVersion: 0, deadline: { localCivil: "2027-01-15T09:00" }, reminderOffsetsMinutes: [60] } });
    const old = await database.DB.prepare("SELECT id, fire_at AS fireAt FROM project_deadline_occurrences WHERE project_id = ? AND kind = 'due_now'").bind(liveProjectId).first<{ id: string; fireAt: number }>();
    const outboxId = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, status, available_at, lease_token, lease_expires_at, created_at, updated_at) VALUES (?, 1, 'project.deadline.reminder', ?, ?, ?, ?, '{}', 'processing', ?, 'live-lease', ?, ?, ?)").bind(outboxId, old!.id, liveProjectId, userId, userId, now, now + 600_000, now, now),
      database.DB.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, created_at, updated_at) VALUES (?, ?, 'project.deadline.reminder', ?, ?, 'in_app', 'pending', ?, ?), (?, ?, 'project.deadline.reminder', ?, ?, 'email', 'processing', ?, ?)").bind(crypto.randomUUID(), outboxId, old!.id, userId, now, now, crypto.randomUUID(), outboxId, old!.id, userId, now, now),
    ]);
    await saveProjectDeadlineSchedule(database.DB, { projectId: liveProjectId, principal: { id: userId, impersonatedBy: null }, now: now + 1, request: { expectedVersion: 1, deadline: { localCivil: "2027-01-16T09:00" }, reminderOffsetsMinutes: [240] } });
    expect((await database.DB.prepare("SELECT status, terminal_reason AS terminalReason FROM project_deadline_occurrences WHERE project_id = ? AND schedule_version = 1 ORDER BY kind, reminder_offset_minutes DESC").bind(liveProjectId).all()).results).toMatchObject([
      { status: "superseded", terminalReason: "schedule_replaced" },
      { status: "superseded", terminalReason: "schedule_replaced" },
    ]);
    expect((await database.DB.prepare("SELECT channel, status FROM notification_delivery_ledger WHERE outbox_id = ? ORDER BY channel").bind(outboxId).all()).results).toMatchObject([{ channel: "email", status: "processing" }, { channel: "in_app", status: "suppressed" }]);
    expect(await database.DB.prepare("SELECT status, lease_token AS leaseToken FROM notification_outbox WHERE id = ?").bind(outboxId).first()).toEqual({ status: "processing", leaseToken: "live-lease" });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM project_deadline_occurrences WHERE project_id = ? AND schedule_version = 2").bind(liveProjectId).first()).toEqual({ count: 2 });
  });

  it("records immutable impersonation provenance for a direct Deadline command", async () => {
    const now = Date.now();
    const commandProjectId = crypto.randomUUID();
    const impersonatedBy = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Impersonated Deadline Street', 'editing_autohdr', ?, ?)").bind(commandProjectId, now, now).run();

    const saved = await saveProjectDeadlineSchedule(database.DB, {
      projectId: commandProjectId,
      principal: { id: userId, impersonatedBy },
      now,
      request: { expectedVersion: 0, deadline: { localCivil: "2027-01-15T09:00" }, reminderOffsetsMinutes: [60] },
    });

    expect(saved.changed).toBe(true);
    const auditRow = await database.DB.prepare("SELECT actor_id AS actorId, meta_json AS metaJson FROM audit_log WHERE action = 'project.deadline.schedule_saved' AND target_id = ?").bind(commandProjectId).first<{ actorId: string; metaJson: string }>();
    expect(auditRow?.actorId).toBe(userId);
    expect(JSON.parse(auditRow!.metaJson)).toEqual({ impersonatedBy, version: 1, operation: "set" });
  });

  it("holds concurrent different-schedule saves at the guarded boundary and leaves no loser footprint", async () => {
    const now = Date.now();
    const concurrentProjectId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Concurrent Deadline Street', 'editing_autohdr', ?, ?)").bind(concurrentProjectId, now, now).run();
    const bothAtBoundary = deferred<void>();
    let batches = 0;
    const concurrentDb = {
      prepare: database.DB.prepare.bind(database.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        batches += 1;
        if (batches === 2) bothAtBoundary.resolve();
        await bothAtBoundary.promise;
        return database.DB.batch(statements);
      },
    } as unknown as D1Database;
    const outcomes = await Promise.allSettled([
      saveProjectDeadlineSchedule(concurrentDb, { projectId: concurrentProjectId, principal: { id: userId, impersonatedBy: null }, now, request: { expectedVersion: 0, deadline: { localCivil: "2027-01-17T09:00" }, reminderOffsetsMinutes: [60] } }),
      saveProjectDeadlineSchedule(concurrentDb, { projectId: concurrentProjectId, principal: { id: userId, impersonatedBy: null }, now, request: { expectedVersion: 0, deadline: { localCivil: "2027-01-18T09:00" }, reminderOffsetsMinutes: [240] } }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const winner = outcomes.find((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof saveProjectDeadlineSchedule>>> => outcome.status === "fulfilled");
    expect(winner?.value).toMatchObject({ changed: true, current: { version: 1 }, eventIntent: { activity: { safePayload: { operation: "set", version: 1 } } }, publicationIds: [] });
    expect([[60], [240]]).toContainEqual(winner?.value.current.reminderOffsetsMinutes);
    const loser = outcomes.find((outcome) => outcome.status === "rejected");
    expect(loser?.status === "rejected" && loser.reason).toBeInstanceOf(ProjectDeadlineError);
    if (loser?.status === "rejected") {
      expect(loser.reason).toMatchObject({ status: 409, code: "deadline_version_conflict" });
      expect(loser.reason).not.toHaveProperty("eventIntent");
      expect(loser.reason).not.toHaveProperty("publicationIds");
    }
    expect(await database.DB.prepare("SELECT deadline_version AS version FROM projects WHERE id = ?").bind(concurrentProjectId).first()).toEqual({ version: 1 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM project_deadline_occurrences WHERE project_id = ?").bind(concurrentProjectId).first()).toEqual({ count: 2 });
    expect((await database.DB.prepare("SELECT reminder_offset_minutes AS offsetMinutes FROM project_deadline_occurrences WHERE project_id = ? ORDER BY reminder_offset_minutes DESC").bind(concurrentProjectId).all()).results).toMatchObject([{ offsetMinutes: winner?.value.current.reminderOffsetsMinutes[0] }, { offsetMinutes: 0 }]);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ?").bind(concurrentProjectId).first()).toEqual({ count: 0 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_delivery_ledger WHERE outbox_id IN (SELECT id FROM notification_outbox WHERE project_id = ?)").bind(concurrentProjectId).first()).toEqual({ count: 0 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'project.deadline.schedule_saved' AND target_id = ?").bind(concurrentProjectId).first()).toEqual({ count: 1 });
  });

  it("keeps rail and synthetic Calendar adapters identical across ordinary, DST, and conflict outcomes", async () => {
    const now = Date.now();
    type CalendarInput = { projectId: string; expectedVersion: number; localCivil: string; disambiguation?: "earlier" | "later"; reminderOffsetsMinutes: number[] };
    const createPair = async (label: string) => {
      const railProjectId = crypto.randomUUID();
      const calendarProjectId = crypto.randomUUID();
      await database.DB.batch([
        database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, ?, 'editing_autohdr', ?, ?)").bind(railProjectId, `Rail ${label}`, now, now),
        database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, ?, 'editing_autohdr', ?, ?)").bind(calendarProjectId, `Calendar ${label}`, now, now),
      ]);
      return { railProjectId, calendarProjectId };
    };
    const railAdapter = (projectId: string, request: Parameters<typeof saveProjectDeadlineSchedule>[1]["request"]) => saveProjectDeadlineSchedule(database.DB, { projectId, principal: { id: userId, impersonatedBy: null }, now, request });
    const calendarAdapter = (input: CalendarInput) => saveProjectDeadlineSchedule(database.DB, {
      projectId: input.projectId,
      principal: { id: userId, impersonatedBy: null },
      now,
      request: { expectedVersion: input.expectedVersion, deadline: { localCivil: input.localCivil, ...(input.disambiguation ? { disambiguation: input.disambiguation } : {}) }, reminderOffsetsMinutes: input.reminderOffsetsMinutes },
    });
    const stateFor = async (projectId: string) => ({
      project: await database.DB.prepare("SELECT deadline_local_civil AS localCivil, deadline_zone AS zone, deadline_utc_offset_minutes AS offsetMinutes, deadline_fold AS fold, deadline_at AS deadlineAt, deadline_reminder_offsets_json AS offsetsJson, deadline_version AS version FROM projects WHERE id = ?").bind(projectId).first(),
      occurrences: (await database.DB.prepare("SELECT kind, reminder_offset_minutes AS offsetMinutes, fire_at AS fireAt, deadline_at AS deadlineAt, deadline_local_civil AS localCivil, deadline_zone AS zone, deadline_utc_offset_minutes AS deadlineOffsetMinutes, deadline_fold AS fold, status, terminal_reason AS terminalReason, fired_at AS firedAt, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt FROM project_deadline_occurrences WHERE project_id = ? ORDER BY fire_at, kind").bind(projectId).all()).results,
      audit: (await database.DB.prepare("SELECT actor_id AS actorId, action, meta_json AS metaJson, created_at AS createdAt FROM audit_log WHERE action = 'project.deadline.schedule_saved' AND target_id = ?").bind(projectId).all()).results,
    });
    const errorShape = (outcome: PromiseSettledResult<unknown>) => {
      expect(outcome.status).toBe("rejected");
      const error = (outcome as PromiseRejectedResult).reason as ProjectDeadlineError;
      return { name: error.name, message: error.message, status: error.status, code: error.code, details: error.details };
    };

    const ordinary = await createPair("ordinary");
    const ordinaryRequest = { expectedVersion: 0, deadline: { localCivil: "2027-02-03T09:00" }, reminderOffsetsMinutes: [240, 60] } as const;
    const [ordinaryRail, ordinaryCalendar] = await Promise.all([
      railAdapter(ordinary.railProjectId, ordinaryRequest),
      calendarAdapter({ projectId: ordinary.calendarProjectId, expectedVersion: 0, localCivil: ordinaryRequest.deadline.localCivil, reminderOffsetsMinutes: [...ordinaryRequest.reminderOffsetsMinutes] }),
    ]);
    expect(normalizeEventIntent(ordinaryRail.eventIntent!, ordinary.railProjectId)).toEqual(normalizeEventIntent(ordinaryCalendar.eventIntent!, ordinary.calendarProjectId));
    expect(await stateFor(ordinary.calendarProjectId)).toEqual(await stateFor(ordinary.railProjectId));

    const repeated = await createPair("repeated");
    const repeatedRequest = { expectedVersion: 0, deadline: { localCivil: "2026-04-05T02:30" }, reminderOffsetsMinutes: [60] } as const;
    const repeatedOutcomes = await Promise.allSettled([
      railAdapter(repeated.railProjectId, repeatedRequest),
      calendarAdapter({ projectId: repeated.calendarProjectId, expectedVersion: 0, localCivil: repeatedRequest.deadline.localCivil, reminderOffsetsMinutes: [...repeatedRequest.reminderOffsetsMinutes] }),
    ]);
    expect(errorShape(repeatedOutcomes[0]!)).toEqual(errorShape(repeatedOutcomes[1]!));
    expect(await stateFor(repeated.calendarProjectId)).toEqual(await stateFor(repeated.railProjectId));
    const laterRequest = { expectedVersion: 0, deadline: { localCivil: "2026-04-05T02:30", disambiguation: "later" as const }, reminderOffsetsMinutes: [60] };
    const [laterRail, laterCalendar] = await Promise.all([
      railAdapter(repeated.railProjectId, laterRequest),
      calendarAdapter({ projectId: repeated.calendarProjectId, expectedVersion: 0, localCivil: laterRequest.deadline.localCivil, disambiguation: laterRequest.deadline.disambiguation, reminderOffsetsMinutes: [...laterRequest.reminderOffsetsMinutes] }),
    ]);
    expect(laterRail.current).toMatchObject({ deadline: { utcOffsetMinutes: 600, fold: 1 }, reminderOffsetsMinutes: [60] });
    expect(laterCalendar.current).toMatchObject({ deadline: { utcOffsetMinutes: 600, fold: 1 }, reminderOffsetsMinutes: [60] });
    expect(normalizeEventIntent(laterRail.eventIntent!, repeated.railProjectId)).toEqual(normalizeEventIntent(laterCalendar.eventIntent!, repeated.calendarProjectId));
    expect(await stateFor(repeated.calendarProjectId)).toEqual(await stateFor(repeated.railProjectId));

    const gap = await createPair("gap");
    const gapRequest = { expectedVersion: 0, deadline: { localCivil: "2026-10-04T02:30" }, reminderOffsetsMinutes: [60] } as const;
    const gapOutcomes = await Promise.allSettled([
      railAdapter(gap.railProjectId, gapRequest),
      calendarAdapter({ projectId: gap.calendarProjectId, expectedVersion: 0, localCivil: gapRequest.deadline.localCivil, reminderOffsetsMinutes: [...gapRequest.reminderOffsetsMinutes] }),
    ]);
    expect(errorShape(gapOutcomes[0]!)).toEqual(errorShape(gapOutcomes[1]!));
    expect(await stateFor(gap.calendarProjectId)).toEqual(await stateFor(gap.railProjectId));

    const conflict = await createPair("conflict");
    const initialRequest = { expectedVersion: 0, deadline: { localCivil: "2027-02-04T09:00" }, reminderOffsetsMinutes: [240, 60] } as const;
    const [initialRail, initialCalendar] = await Promise.all([
      railAdapter(conflict.railProjectId, initialRequest),
      calendarAdapter({ projectId: conflict.calendarProjectId, expectedVersion: 0, localCivil: initialRequest.deadline.localCivil, reminderOffsetsMinutes: [...initialRequest.reminderOffsetsMinutes] }),
    ]);
    const staleRequest = { expectedVersion: 0, deadline: { localCivil: "2027-02-05T09:00" }, reminderOffsetsMinutes: [1440] } as const;
    const conflictOutcomes = await Promise.allSettled([
      railAdapter(conflict.railProjectId, staleRequest),
      calendarAdapter({ projectId: conflict.calendarProjectId, expectedVersion: 0, localCivil: staleRequest.deadline.localCivil, reminderOffsetsMinutes: [...staleRequest.reminderOffsetsMinutes] }),
    ]);
    expect(errorShape(conflictOutcomes[0]!)).toEqual(errorShape(conflictOutcomes[1]!));
    expect((conflictOutcomes[0] as PromiseRejectedResult).reason).toMatchObject({ details: { current: { version: 1, reminderOffsetsMinutes: [240, 60] } } });
    expect(initialRail.current).toMatchObject({ version: 1, reminderOffsetsMinutes: [240, 60] });
    expect(initialCalendar.current).toMatchObject({ version: 1, reminderOffsetsMinutes: [240, 60] });
    expect(await stateFor(conflict.calendarProjectId)).toEqual(await stateFor(conflict.railProjectId));
  });

  it("requires explicit resume after Delivered and archive terminalization", async () => {
    const now = Date.now();
    const deliveredProjectId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Delivered Deadline Street', 'editing_autohdr', ?, ?)").bind(deliveredProjectId, now, now).run();
    const initial = await saveProjectDeadlineSchedule(database.DB, { projectId: deliveredProjectId, principal: { id: userId, impersonatedBy: null }, now, request: { expectedVersion: 0, deadline: { localCivil: "2027-01-20T09:00" }, reminderOffsetsMinutes: [60] } });
    await database.DB.prepare("UPDATE projects SET stage_key = 'delivered' WHERE id = ?").bind(deliveredProjectId).run();
    await suppressProjectDeadlineWork(database.DB, deliveredProjectId, now + 1, "project_delivered");
    expect(await readProjectDeadlineSchedule(database.DB, deliveredProjectId, now + 1)).toMatchObject({ state: "inactive_delivered", version: 1, canResume: false });
    await database.DB.prepare("UPDATE projects SET stage_key = 'editing_autohdr' WHERE id = ?").bind(deliveredProjectId).run();
    const inactive = await readProjectDeadlineSchedule(database.DB, deliveredProjectId, now + 2);
    expect(inactive).toMatchObject({ canResume: true, deadline: { localCivil: "2027-01-20T09:00" } });
    const resumed = await saveProjectDeadlineSchedule(database.DB, { projectId: deliveredProjectId, principal: { id: userId, impersonatedBy: null }, now: now + 2, request: { expectedVersion: 1, deadline: { localCivil: "2027-01-20T09:00", disambiguation: "earlier" }, reminderOffsetsMinutes: initial.current.reminderOffsetsMinutes, resume: true } });
    expect(resumed).toMatchObject({ changed: true, eventIntent: { activity: { safePayload: { operation: "resume", version: 2 } } }, current: { version: 2, canResume: false } });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM project_deadline_occurrences WHERE project_id = ? AND schedule_version = 1 AND status = 'superseded' AND terminal_reason = 'project_delivered'").bind(deliveredProjectId).first()).toEqual({ count: 2 });

    const archivedProjectId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Archived Deadline Street', 'editing_autohdr', ?, ?)").bind(archivedProjectId, now, now).run();
    await saveProjectDeadlineSchedule(database.DB, { projectId: archivedProjectId, principal: { id: userId, impersonatedBy: null }, now, request: { expectedVersion: 0, deadline: { localCivil: "2027-01-21T09:00" }, reminderOffsetsMinutes: [60] } });
    expect((await request(`/api/projects/${archivedProjectId}/archive`, token, "POST")).status).toBe(200);
    expect((await database.DB.prepare("SELECT status, terminal_reason AS terminalReason FROM project_deadline_occurrences WHERE project_id = ?").bind(archivedProjectId).all()).results).toMatchObject([{ status: "superseded", terminalReason: "project_archived" }, { status: "superseded", terminalReason: "project_archived" }]);
    expect((await request(`/api/projects/${archivedProjectId}/restore`, token, "POST")).status).toBe(200);
    expect(await readProjectDeadlineSchedule(database.DB, archivedProjectId, now + 3)).toMatchObject({ canResume: true });
  });

  it("uses the real Stage route for Delivered races and leaves the residual window observable", async () => {
    const now = Date.now();
    const projectIdForRace = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Stage route Deadline race', 'editing_autohdr', ?, ?)").bind(projectIdForRace, now, now).run();
    const saved = await saveProjectDeadlineSchedule(database.DB, {
      projectId: projectIdForRace,
      principal: { id: userId, impersonatedBy: null },
      now,
      request: { expectedVersion: 0, deadline: { localCivil: "2027-01-22T09:00" }, reminderOffsetsMinutes: [] },
    });
    const occurrence = await database.DB.prepare("SELECT id, fire_at AS fireAt FROM project_deadline_occurrences WHERE project_id = ? AND kind = 'due_now'").bind(projectIdForRace).first<{ id: string; fireAt: number }>();
    expect(saved.current.nextOccurrence).toMatchObject({ kind: "due_now" });
    await database.DB.exec("CREATE TRIGGER tb4b_stage_deadline_hook_failure BEFORE UPDATE OF status ON project_deadline_occurrences WHEN NEW.terminal_reason = 'project_delivered' BEGIN SELECT RAISE(ABORT, 'forced Deadline hook failure'); END;");
    try {
      const entered = await request(`/api/projects/${projectIdForRace}/stage`, token, "POST", { stageKey: "delivered" });
      expect(entered.status).toBe(200);
    } finally {
      await database.DB.exec("DROP TRIGGER IF EXISTS tb4b_stage_deadline_hook_failure;");
    }
    expect(await database.DB.prepare("SELECT stage_key AS stageKey FROM projects WHERE id = ?").bind(projectIdForRace).first()).toEqual({ stageKey: "delivered" });
    expect(await database.DB.prepare("SELECT status FROM project_deadline_occurrences WHERE id = ?").bind(occurrence!.id).first()).toEqual({ status: "pending" });

    const left = await request(`/api/projects/${projectIdForRace}/stage`, token, "POST", { stageKey: "editing_autohdr" });
    expect(left.status).toBe(200);
    const dueBeforeScan = await database.DB.prepare("SELECT id FROM project_deadline_occurrences WHERE status = 'pending' AND fire_at <= ? ORDER BY fire_at, project_id, id LIMIT 100").bind(occurrence!.fireAt + 1).all<{ id: string }>();
    expect(dueBeforeScan.results.map((row) => row.id)).toContain(occurrence!.id);
    const scan = await scanProjectDeadlineOccurrences({ DB: database.DB } as never, occurrence!.fireAt + 1);
    expect(scan.scanned).toBe(dueBeforeScan.results.length);
    expect(scan.fired).toBeGreaterThanOrEqual(1);
    expect(await database.DB.prepare("SELECT status FROM project_deadline_occurrences WHERE id = ?").bind(occurrence!.id).first()).toEqual({ status: "fired" });
  });

  it("atomically suppresses pending Deadline delivery channels in the real archive route", async () => {
    const now = Date.now();
    const projectIdForArchive = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Archive route Deadline race', 'editing_autohdr', ?, ?)").bind(projectIdForArchive, now, now).run();
    await saveProjectDeadlineSchedule(database.DB, {
      projectId: projectIdForArchive,
      principal: { id: userId, impersonatedBy: null },
      now,
      request: { expectedVersion: 0, deadline: { localCivil: "2027-01-23T09:00" }, reminderOffsetsMinutes: [60] },
    });
    const occurrence = await database.DB.prepare("SELECT id FROM project_deadline_occurrences WHERE project_id = ? AND kind = 'due_now'").bind(projectIdForArchive).first<{ id: string }>();
    const outboxId = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, status, available_at, created_at, updated_at) VALUES (?, 1, 'project.deadline.reminder', ?, ?, ?, ?, '{}', 'pending', ?, ?, ?)").bind(outboxId, occurrence!.id, projectIdForArchive, userId, userId, now, now, now),
      database.DB.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, created_at, updated_at) VALUES (?, ?, 'project.deadline.reminder', ?, ?, 'in_app', 'pending', ?, ?), (?, ?, 'project.deadline.reminder', ?, ?, 'email', 'pending', ?, ?)").bind(crypto.randomUUID(), outboxId, occurrence!.id, userId, now, now, crypto.randomUUID(), outboxId, occurrence!.id, userId, now, now),
    ]);
    const archived = await request(`/api/projects/${projectIdForArchive}/archive`, token, "POST");
    expect(archived.status).toBe(200);
    expect(await database.DB.prepare("SELECT archived_at IS NOT NULL AS archived FROM projects WHERE id = ?").bind(projectIdForArchive).first()).toEqual({ archived: 1 });
    expect(await database.DB.prepare("SELECT status, terminal_reason AS terminalReason FROM project_deadline_occurrences WHERE id = ?").bind(occurrence!.id).first()).toEqual({ status: "superseded", terminalReason: "project_archived" });
    expect((await database.DB.prepare("SELECT channel, status FROM notification_delivery_ledger WHERE outbox_id = ? ORDER BY channel").bind(outboxId).all()).results).toEqual([{ channel: "email", status: "suppressed" }, { channel: "in_app", status: "suppressed" }]);
    expect(await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(outboxId).first()).toEqual({ status: "suppressed" });
  });
});
