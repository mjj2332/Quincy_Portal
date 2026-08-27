import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_OUTBOX_EVENT_TYPES } from "@quincy/shared";
import type { Env } from "../src/env";
import { processNotificationMessage, recoverNotificationOutbox } from "../src/notification-delivery";
import { scanProjectDeadlineOccurrences } from "../src/project-deadline";
import { saveProjectDeadlineSchedule, suppressProjectDeadlineWork } from "../../app/src/lib/project-deadline";

const database = env as unknown as { DB: D1Database };
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function withReminderResolverBarrier(onThirdSuccess: () => Promise<void>): D1Database {
  let resolverSuccesses = 0;
  const realPrepare = database.DB.prepare.bind(database.DB);
  const wrapped = {
    prepare(sql: string) {
      const statement = realPrepare(sql);
      if (!sql.includes("SELECT o.id AS outboxId") || !sql.includes("LEFT JOIN project_deadline_occurrences occurrence")) return statement;
      return new Proxy(statement, {
        get(target, property, receiver) {
          if (property !== "bind") return Reflect.get(target, property, receiver);
          return (...values: unknown[]) => {
            const bound = target.bind(...values);
            return new Proxy(bound, {
              get(boundTarget, boundProperty, boundReceiver) {
                if (boundProperty !== "first") return Reflect.get(boundTarget, boundProperty, boundReceiver);
                return async (...args: unknown[]) => {
                  const result = await (boundTarget as unknown as { first: (...firstArgs: unknown[]) => Promise<unknown> }).first(...args);
                  if (result && ++resolverSuccesses === 3) await onThirdSuccess();
                  return result;
                };
              },
            });
          };
        },
      });
    },
    batch: database.DB.batch.bind(database.DB),
  };
  return wrapped as unknown as D1Database;
}

function deliveryEnv(send: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ messageId: "deadline-message" }), queueSend: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined), db: D1Database = database.DB): Env {
  return { DB: db, APP_ENV: "test", APP_ORIGIN: "https://portal.test", NOTIFICATION_QUEUE: { send: queueSend }, EMAIL: { send }, NOTIFICATIONS_FROM_ADDRESS: "studio@example.test" } as unknown as Env;
}

async function seedDue(now: number, state: "active" | "archived" | "delivered" | "cleared" | "replaced" = "active") {
  const projectId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const occurrenceId = crypto.randomUUID();
  const deadlineAt = now - 1;
  const projectVersion = state === "replaced" ? 2 : 1;
  await database.DB.batch([
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Deadline Editor', ?, 1, 'editor', 1, ?, ?)").bind(userId, `${userId}@example.test`, now, now),
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, archived_at, deadline_at, deadline_local_civil, deadline_zone, deadline_utc_offset_minutes, deadline_fold, deadline_reminder_offsets_json, deadline_version, created_at, updated_at) VALUES (?, 'Deadline Street', ?, ?, ?, '2026-08-27T12:00', 'Australia/Sydney', 600, 0, '[]', ?, ?, ?)").bind(projectId, state === "delivered" ? "delivered" : "editing_autohdr", state === "archived" ? now : null, state === "cleared" ? null : deadlineAt, projectVersion, now, now),
    database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(membershipId, projectId, userId, now),
    database.DB.prepare("INSERT INTO project_deadline_occurrences (id, project_id, schedule_version, kind, reminder_offset_minutes, fire_at, deadline_at, deadline_local_civil, deadline_zone, deadline_utc_offset_minutes, deadline_fold, status, created_by, created_at, updated_at) VALUES (?, ?, 1, 'due_now', 0, ?, ?, '2026-08-27T12:00', 'Australia/Sydney', 600, 0, 'pending', ?, ?, ?)").bind(occurrenceId, projectId, deadlineAt, deadlineAt, userId, now, now),
  ]);
  return { projectId, userId, membershipId, occurrenceId, deadlineAt };
}

function message(outboxId: string) {
  return { body: { type: "notification_outbox", outboxId }, attempts: 0, ack: vi.fn(), retry: vi.fn() } as never;
}

describe("TB4B Deadline occurrence scan and delivery", () => {
  beforeAll(async () => { await executeSql(__PORTAL_MIGRATION_SQL__); });

  it("fires once, fans out only to the exact Editor cycle, and persists an exact payload", async () => {
    const now = Date.now();
    const fixture = await seedDue(now);
    const lateEditor = crypto.randomUUID();
    const unassignedAdmin = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Late Editor', ?, 1, 'editor', 1, ?, ?)").bind(lateEditor, `${lateEditor}@example.test`, now + 1, now + 1),
      database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), fixture.projectId, lateEditor, now + 1),
      database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Unassigned Admin', ?, 1, 'admin', 1, ?, ?)").bind(unassignedAdmin, `${unassignedAdmin}@example.test`, now, now),
    ]);
    const result = await scanProjectDeadlineOccurrences(deliveryEnv(), now);
    expect(result).toMatchObject({ scanned: 1, fired: 1, published: 1 });
    expect(await scanProjectDeadlineOccurrences(deliveryEnv(), now)).toMatchObject({ scanned: 0, fired: 0, published: 0 });
    const outbox = await database.DB.prepare("SELECT id, event_type AS eventType, source_key AS sourceKey, recipient_id AS recipientId, payload_json AS payloadJson FROM notification_outbox WHERE project_id = ?").bind(fixture.projectId).all<{ id: string; eventType: string; sourceKey: string; recipientId: string; payloadJson: string }>();
    expect(outbox.results).toHaveLength(1);
    expect(outbox.results[0]).toMatchObject({ eventType: NOTIFICATION_OUTBOX_EVENT_TYPES.projectDeadlineReminder, sourceKey: fixture.occurrenceId, recipientId: fixture.userId });
    expect(outbox.results[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const payload = JSON.parse(outbox.results[0]!.payloadJson) as Record<string, Record<string, unknown>>;
    expect(Object.keys(payload)).toEqual(["schemaVersion", "event", "authorizationAtOccurrence", "reminder"]);
    expect(Object.keys(payload.event ?? {})).toEqual(["type", "sourceKey", "recipientId"]);
    expect(Object.keys(payload.authorizationAtOccurrence ?? {})).toEqual(["kind", "membershipCycle", "startedAt"]);
    expect(Object.keys(payload.reminder ?? {})).toEqual(["occurrenceId", "projectId", "scheduleVersion", "kind", "offsetMinutes", "deadlineAt", "deadlineLocalCivil", "zone", "utcOffsetMinutes", "fold"]);
    expect(payload).not.toHaveProperty("email");
    expect(payload).not.toHaveProperty("street");
    expect(payload).toMatchObject({ event: { sourceKey: fixture.occurrenceId, recipientId: fixture.userId }, authorizationAtOccurrence: { membershipCycle: fixture.membershipId, startedAt: now }, reminder: { occurrenceId: fixture.occurrenceId, projectId: fixture.projectId, kind: "due_now", offsetMinutes: 0, zone: "Australia/Sydney" } });
    const ledger = await database.DB.prepare("SELECT id FROM notification_delivery_ledger WHERE outbox_id = ?").bind(outbox.results[0]!.id).all<{ id: string }>();
    expect(ledger.results).toHaveLength(2);
    expect(ledger.results.every(({ id }) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))).toBe(true);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE recipient_id = ?").bind(unassignedAdmin).first()).toEqual({ count: 0 });
  });

  it("holds concurrent scans at the fire batch and lets only the marker winner fan out", async () => {
    const now = Date.now();
    const fixture = await seedDue(now);
    const bothBatchesReady = deferred<void>();
    const firstBatchFinished = deferred<void>();
    let batchCount = 0;
    const scanDb = {
      prepare: database.DB.prepare.bind(database.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        const batchNumber = ++batchCount;
        if (batchNumber === 2) bothBatchesReady.resolve();
        await bothBatchesReady.promise;
        if (batchNumber === 1) {
          const result = await database.DB.batch(statements);
          const lateEditor = crypto.randomUUID();
          await database.DB.batch([
            database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Late Fire Editor', ?, 1, 'editor', 1, ?, ?)").bind(lateEditor, `${lateEditor}@example.test`, now, now),
            database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), fixture.projectId, lateEditor, now),
          ]);
          firstBatchFinished.resolve();
          return result;
        }
        await firstBatchFinished.promise;
        return database.DB.batch(statements);
      },
    } as unknown as D1Database;
    const envForBoth = deliveryEnv();
    envForBoth.DB = scanDb;
    const [first, second] = await Promise.all([
      scanProjectDeadlineOccurrences(envForBoth, now),
      scanProjectDeadlineOccurrences(envForBoth, now),
    ]);
    expect([first, second]).toEqual(expect.arrayContaining([
      expect.objectContaining({ scanned: 1, fired: 1, published: 1 }),
      expect.objectContaining({ scanned: 1, fired: 0, published: 0 }),
    ]));
    expect(await database.DB.prepare("SELECT status, fired_at AS firedAt FROM project_deadline_occurrences WHERE id = ?").bind(fixture.occurrenceId).first()).toMatchObject({ status: "fired", firedAt: now });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'project.deadline.occurrence_fired' AND target_id = ?").bind(fixture.occurrenceId).first()).toEqual({ count: 1 });
    expect((await database.DB.prepare("SELECT recipient_id AS recipientId FROM notification_outbox WHERE project_id = ?").bind(fixture.projectId).all()).results).toEqual([{ recipientId: fixture.userId }]);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_delivery_ledger WHERE outbox_id IN (SELECT id FROM notification_outbox WHERE project_id = ?)").bind(fixture.projectId).first()).toEqual({ count: 2 });
  });

  it("lazily terminalizes every stale fire-guard state without consuming the next scan", async () => {
    for (const state of ["archived", "delivered", "cleared", "replaced"] as const) {
      const fixture = await seedDue(Date.now(), state);
      await scanProjectDeadlineOccurrences(deliveryEnv(), Date.now());
      const row = await database.DB.prepare("SELECT status, terminal_reason AS terminalReason FROM project_deadline_occurrences WHERE id = ?").bind(fixture.occurrenceId).first();
      expect(row).toEqual({ status: "superseded", terminalReason: state === "archived" ? "project_archived" : state === "delivered" ? "project_delivered" : state === "cleared" ? "deadline_cleared" : "schedule_replaced" });
    }
  });

  it("keeps mandatory in-app delivery while a disabled preference suppresses only pending email", async () => {
    const now = Date.now();
    const fixture = await seedDue(now);
    await scanProjectDeadlineOccurrences(deliveryEnv(), now);
    await database.DB.prepare("INSERT INTO notification_preferences (user_id, project_deadline_reminder_emails, updated_at) VALUES (?, 0, ?)").bind(fixture.userId, now).run();
    const outbox = await database.DB.prepare("SELECT id FROM notification_outbox WHERE project_id = ?").bind(fixture.projectId).first<{ id: string }>();
    const send = vi.fn().mockResolvedValue({ messageId: "should-not-send" });
    const queued = message(outbox!.id);
    await processNotificationMessage(deliveryEnv(send), queued);
    expect(send).not.toHaveBeenCalled();
    expect((await database.DB.prepare("SELECT channel, status, last_error_code AS code FROM notification_delivery_ledger WHERE outbox_id = ? ORDER BY channel").bind(outbox!.id).all()).results).toMatchObject([{ channel: "email", status: "suppressed", code: "recipient_preference_disabled" }, { channel: "in_app", status: "sent" }]);
    expect((queued as { ack: ReturnType<typeof vi.fn> }).ack).toHaveBeenCalledOnce();
  });

  it.each([
    ["Delivered suppression", async (fixture: Awaited<ReturnType<typeof seedDue>>, now: number) => {
      await database.DB.prepare("UPDATE projects SET stage_key = 'delivered' WHERE id = ?").bind(fixture.projectId).run();
      await suppressProjectDeadlineWork(database.DB, fixture.projectId, now + 1, "project_delivered");
    }],
    ["an edit suppression", async (fixture: Awaited<ReturnType<typeof seedDue>>, now: number) => {
      await saveProjectDeadlineSchedule(database.DB, {
        projectId: fixture.projectId,
        principal: { id: fixture.userId, impersonatedBy: null },
        now: now + 1,
        request: { expectedVersion: 1, deadline: { localCivil: "2027-01-15T09:00" }, reminderOffsetsMinutes: [] },
      });
    }],
    ["a clear suppression", async (fixture: Awaited<ReturnType<typeof seedDue>>, now: number) => {
      await saveProjectDeadlineSchedule(database.DB, {
        projectId: fixture.projectId,
        principal: { id: fixture.userId, impersonatedBy: null },
        now: now + 1,
        request: { expectedVersion: 1, deadline: null },
      });
    }],
    ["archive suppression", async (fixture: Awaited<ReturnType<typeof seedDue>>, now: number) => {
      await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(now + 1, fixture.projectId).run();
      await suppressProjectDeadlineWork(database.DB, fixture.projectId, now + 1, "project_archived");
    }],
  ] as const)("keeps an admitted in-flight email terminally sent when %s races it", async (_name, mutate) => {
    const now = Date.now();
    const fixture = await seedDue(now);
    await scanProjectDeadlineOccurrences(deliveryEnv(), now);
    const outbox = await database.DB.prepare("SELECT id FROM notification_outbox WHERE project_id = ?").bind(fixture.projectId).first<{ id: string }>();
    const emailStarted = deferred<void>();
    const releaseEmail = deferred<void>();
    const send = vi.fn(async () => {
      emailStarted.resolve();
      await releaseEmail.promise;
      return { messageId: "in-flight-delivered-email" };
    });
    const delivery = processNotificationMessage(deliveryEnv(send), message(outbox!.id));
    await emailStarted.promise;
    expect(await database.DB.prepare("SELECT status FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'email'").bind(outbox!.id).first()).toEqual({ status: "processing" });
    await mutate(fixture, now);
    expect(await database.DB.prepare("SELECT status FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'email'").bind(outbox!.id).first()).toEqual({ status: "processing" });
    releaseEmail.resolve();
    await delivery;
    expect(send).toHaveBeenCalledOnce();
    expect(await database.DB.prepare("SELECT status, email_message_id AS messageId FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'email'").bind(outbox!.id).first()).toEqual({ status: "sent", messageId: "in-flight-delivered-email" });
    expect(await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(outbox!.id).first()).toEqual({ status: "completed" });
  });

  it.each([
    ["membership removed", async (fixture: Awaited<ReturnType<typeof seedDue>>) => { await database.DB.prepare("DELETE FROM project_members WHERE id = ?").bind(fixture.membershipId).run(); }, "reauthorization_suppressed"],
    ["recipient deactivated", async (fixture: Awaited<ReturnType<typeof seedDue>>) => { await database.DB.prepare("UPDATE user SET active = 0 WHERE id = ?").bind(fixture.userId).run(); }, "reauthorization_suppressed"],
    ["membership cycle replaced", async (fixture: Awaited<ReturnType<typeof seedDue>>) => { await database.DB.prepare("DELETE FROM project_members WHERE id = ?").bind(fixture.membershipId).run(); await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), fixture.projectId, fixture.userId, fixture.deadlineAt - 1).run(); }, "reauthorization_suppressed"],
    ["email preference disabled", async (fixture: Awaited<ReturnType<typeof seedDue>>) => { await database.DB.prepare("INSERT INTO notification_preferences (user_id, project_deadline_reminder_emails, updated_at) VALUES (?, 0, ?) ON CONFLICT(user_id) DO UPDATE SET project_deadline_reminder_emails = 0, updated_at = excluded.updated_at").bind(fixture.userId, Date.now()).run(); }, "recipient_preference_disabled"],
  ] as const)("does not admit a stale reminder channel after %s wins the post-resolve barrier", async (_name, mutate, expectedCode) => {
    const now = Date.now();
    const fixture = await seedDue(now);
    await scanProjectDeadlineOccurrences(deliveryEnv(), now);
    const outbox = await database.DB.prepare("SELECT id FROM notification_outbox WHERE project_id = ?").bind(fixture.projectId).first<{ id: string }>();
    const resolved = deferred<void>();
    const release = deferred<void>();
    const raceDb = withReminderResolverBarrier(async () => {
      resolved.resolve();
      await release.promise;
    });
    const send = vi.fn().mockResolvedValue({ messageId: "should-not-send" });
    const delivery = processNotificationMessage(deliveryEnv(send, undefined, raceDb), message(outbox!.id));
    await resolved.promise;
    await mutate(fixture);
    release.resolve();
    await delivery;
    expect(send).not.toHaveBeenCalled();
    expect((await database.DB.prepare("SELECT channel, status, last_error_code AS code FROM notification_delivery_ledger WHERE outbox_id = ? ORDER BY channel").bind(outbox!.id).all()).results).toMatchObject([{ channel: "email", status: "suppressed", code: expectedCode }, { channel: "in_app", status: "sent" }]);
    expect(await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(outbox!.id).first()).toEqual({ status: "completed" });
  });

  it("measures in-app latency from the later of semantic fire time and materialization", async () => {
    const now = Date.now();
    const fixture = await seedDue(now);
    await scanProjectDeadlineOccurrences(deliveryEnv(), now);
    const outbox = await database.DB.prepare("SELECT id FROM notification_outbox WHERE project_id = ?").bind(fixture.projectId).first<{ id: string }>();
    const occurrence = await database.DB.prepare("SELECT fire_at AS fireAt, created_at AS createdAt FROM project_deadline_occurrences WHERE id = ?").bind(fixture.occurrenceId).first<{ fireAt: number; createdAt: number }>();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await processNotificationMessage(deliveryEnv(), message(outbox!.id));
      const metric = log.mock.calls.find(([label]) => label === "Project Deadline in-app latency")?.[1] as { fireAt: number; operationalMetricBasis: number; deliveredAt: number; latencyMs: number } | undefined;
      const delivered = await database.DB.prepare("SELECT delivered_at AS deliveredAt FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'in_app'").bind(outbox!.id).first<{ deliveredAt: number }>();
      expect(metric).toMatchObject({ fireAt: occurrence!.fireAt, operationalMetricBasis: Math.max(occurrence!.fireAt, occurrence!.createdAt), deliveredAt: delivered!.deliveredAt, latencyMs: delivered!.deliveredAt - Math.max(occurrence!.fireAt, occurrence!.createdAt) });
    } finally {
      log.mockRestore();
    }
  });

  it("does not deliver a fired reminder after C1 is replaced by a distinct C2 cycle", async () => {
    const now = Date.now();
    const fixture = await seedDue(now);
    await scanProjectDeadlineOccurrences(deliveryEnv(), now);
    await database.DB.batch([
      database.DB.prepare("DELETE FROM project_members WHERE id = ?").bind(fixture.membershipId),
      database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), fixture.projectId, fixture.userId, now + 1),
    ]);
    const outbox = await database.DB.prepare("SELECT id FROM notification_outbox WHERE project_id = ?").bind(fixture.projectId).first<{ id: string }>();
    const queued = message(outbox!.id);
    const send = vi.fn().mockResolvedValue({ messageId: "should-not-send" });
    await processNotificationMessage(deliveryEnv(send), queued);
    expect(send).not.toHaveBeenCalled();
    expect(await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(outbox!.id).first()).toEqual({ status: "suppressed" });
    expect((await database.DB.prepare("SELECT channel, status FROM notification_delivery_ledger WHERE outbox_id = ? ORDER BY channel").bind(outbox!.id).all()).results).toMatchObject([{ channel: "email", status: "suppressed" }, { channel: "in_app", status: "suppressed" }]);
  });

  it("fires zero-recipient occurrences once and recovers a committed Queue publication failure", async () => {
    const now = Date.now();
    const empty = await seedDue(now);
    await database.DB.prepare("DELETE FROM project_members WHERE id = ?").bind(empty.membershipId).run();
    const emptyResult = await scanProjectDeadlineOccurrences(deliveryEnv(), now);
    expect(emptyResult).toMatchObject({ scanned: 1, fired: 1, published: 0 });
    expect(await database.DB.prepare("SELECT status FROM project_deadline_occurrences WHERE id = ?").bind(empty.occurrenceId).first()).toEqual({ status: "fired" });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ?").bind(empty.projectId).first()).toEqual({ count: 0 });

    const queued = await seedDue(now);
    const rejected = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    await scanProjectDeadlineOccurrences(deliveryEnv(undefined, rejected), now);
    const outbox = await database.DB.prepare("SELECT id, status, last_error_code AS code FROM notification_outbox WHERE project_id = ?").bind(queued.projectId).first<{ id: string; status: string; code: string }>();
    expect(outbox).toMatchObject({ status: "pending", code: "queue_publish_failed" });
    const recoveredQueue = vi.fn().mockResolvedValue(undefined);
    expect(await recoverNotificationOutbox(deliveryEnv(undefined, recoveredQueue), now + 1)).toBeGreaterThanOrEqual(1);
    expect(recoveredQueue).toHaveBeenCalledWith({ type: "notification_outbox", outboxId: outbox!.id });
    expect(await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(outbox!.id).first()).toEqual({ status: "queued" });
  });
});
