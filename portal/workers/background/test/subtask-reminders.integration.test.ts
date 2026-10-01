import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildSubtaskReminderMaterialization, buildSubtaskReminderSuppression } from "@quincy/db";
import { NOTIFICATION_OUTBOX_EVENT_TYPES } from "@quincy/shared";
import type { Env } from "../src/env";
import { processNotificationMessage } from "../src/notification-delivery";
import { fireSubtaskReminderOccurrence, reconcileSubtaskReminderOccurrences, scanSubtaskReminderOccurrences } from "../src/subtask-reminders";

const database = env as unknown as { DB: D1Database };
declare const __PORTAL_MIGRATION_SQL__: string;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

function deliveryEnv(send: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ messageId: "subtask-reminder" }), db: D1Database = database.DB): Env {
  return { DB: db, APP_ENV: "test", APP_ORIGIN: "https://portal.test", NOTIFICATION_QUEUE: { send: vi.fn().mockResolvedValue(undefined) }, EMAIL: { send }, NOTIFICATIONS_FROM_ADDRESS: "studio@example.test" } as unknown as Env;
}

function message(outboxId: string) {
  return { body: { type: "notification_outbox", outboxId }, attempts: 0, ack: vi.fn(), retry: vi.fn() } as never;
}

type Role = "editor" | "admin" | "external_editor";
async function addUser(role: Role, now: number): Promise<string> {
  const id = crypto.randomUUID();
  await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, ?, ?)").bind(id, `${role} person`, `${id}@example.test`, role, now, now).run();
  return id;
}
async function addMember(projectId: string, userId: string, now: number): Promise<string> {
  const id = crypto.randomUUID();
  await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(id, projectId, userId, now).run();
  return id;
}
async function assign(subtaskId: string, userId: string, version: number, now: number): Promise<void> {
  await database.DB.prepare("INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at) VALUES (?, ?, ?, ?)").bind(subtaskId, userId, version, now).run();
}

type Seed = { kind?: "advance" | "due_now"; scheduleVersion?: number; dueOffsetMs?: number };

/** A Subtask whose due is `now + offset`, with one occurrence that is due to fire at `now - 1`. */
async function seedSubtask(now: number, options: Seed = {}) {
  const kind = options.kind ?? "due_now";
  const offsetMinutes = kind === "due_now" ? 0 : 1440;
  const fireAt = now - 1;
  const dueAt = fireAt + offsetMinutes * MINUTE;
  const projectId = crypto.randomUUID();
  const subtaskId = crypto.randomUUID();
  const occurrenceId = crypto.randomUUID();
  const version = options.scheduleVersion ?? 3;
  const creator = await addUser("editor", now);
  await database.DB.batch([
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Reminder Street', 'editing_autohdr', ?, ?)").bind(projectId, now, now),
    database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, 'Order the twilight shoot', 0, 1024, '2026-08-27T12:00', 'timed', '2026-08-27T09:00', ?, 600, 0, 'timed', ?, 600, 0, 'Australia/Sydney', ?, ?, ?, ?)").bind(subtaskId, projectId, dueAt - 3 * 60 * MINUTE, dueAt, version, creator, now, now),
    database.DB.prepare("INSERT INTO project_subtask_reminder_occurrences (id, subtask_id, project_id, schedule_version, kind, reminder_offset_minutes, fire_at, due_at, due_local_civil, due_zone, due_utc_offset_minutes, due_fold, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-08-27T12:00', 'Australia/Sydney', 600, 0, 'pending', NULL, ?, ?)").bind(occurrenceId, subtaskId, projectId, version, kind, offsetMinutes, fireAt, dueAt, now, now),
  ]);
  return { projectId, subtaskId, occurrenceId, dueAt, fireAt, version };
}

const outboxFor = (subtaskId: string) => database.DB.prepare("SELECT id, event_type AS eventType, source_key AS sourceKey, recipient_id AS recipientId, recipient_membership_cycle_id AS cycle, actor_id AS actorId, payload_json AS payloadJson FROM notification_outbox WHERE substr(source_key, 1, ?) = ? ORDER BY recipient_id").bind(`subtask-reminder:${subtaskId}:`.length, `subtask-reminder:${subtaskId}:`).all<{ id: string; eventType: string; sourceKey: string; recipientId: string; cycle: string | null; actorId: string; payloadJson: string }>().then((result) => result.results);
const occurrenceRow = (id: string) => database.DB.prepare("SELECT status, terminal_reason AS terminalReason, fired_at AS firedAt FROM project_subtask_reminder_occurrences WHERE id = ?").bind(id).first<{ status: string; terminalReason: string | null; firedAt: number | null }>();
const ledgerFor = (outboxId: string) => database.DB.prepare("SELECT channel, status, last_error_code AS code FROM notification_delivery_ledger WHERE outbox_id = ? ORDER BY channel").bind(outboxId).all<{ channel: string; status: string; code: string | null }>().then((result) => result.results);

/** Runs a mutation after the first batch that wrote an in-app notification, so it lands BETWEEN the in-app and email channels. */
function mutateBetweenChannels(mutation: () => Promise<void>): D1Database {
  const tags = new WeakMap<object, string>();
  let done = false;
  return {
    prepare(sql: string) {
      const statement = database.DB.prepare(sql);
      return new Proxy(statement, {
        get(target, property, receiver) {
          if (property !== "bind") return Reflect.get(target, property, receiver);
          return (...values: unknown[]) => { const bound = target.bind(...values); tags.set(bound, sql); return bound; };
        },
      });
    },
    batch: async (statements: D1PreparedStatement[]) => {
      const result = await database.DB.batch(statements);
      if (!done && statements.some((statement) => tags.get(statement)?.includes("INSERT INTO notifications"))) { done = true; await mutation(); }
      return result;
    },
  } as unknown as D1Database;
}

beforeAll(async () => { await executeSql(__PORTAL_MIGRATION_SQL__); });

describe("Subtask reminder occurrence scan (#424)", () => {
  it("fires once to every current assignee, staff and External Editor, with an exact payload and two ledger rows each", async () => {
    const now = Date.now();
    const fixture = await seedSubtask(now);
    const staff = await addUser("editor", now);
    const admin = await addUser("admin", now);
    const external = await addUser("external_editor", now);
    const outsider = await addUser("editor", now);
    await addMember(fixture.projectId, staff, now);
    const cycle = await addMember(fixture.projectId, external, now);
    await assign(fixture.subtaskId, staff, 4, now);
    await assign(fixture.subtaskId, admin, 5, now);
    await assign(fixture.subtaskId, external, 6, now);
    await assign(fixture.subtaskId, outsider, 7, now);
    expect(await scanSubtaskReminderOccurrences(deliveryEnv(), now)).toMatchObject({ scanned: 1, fired: 1, published: 3 });
    expect(await scanSubtaskReminderOccurrences(deliveryEnv(), now)).toMatchObject({ scanned: 0, fired: 0, published: 0 });
    const rows = await outboxFor(fixture.subtaskId);
    // The outsider is an editor with no membership, so they are not a recipient. The admin needs none.
    expect(rows.map((row) => row.recipientId).sort()).toEqual([staff, admin, external].sort());
    for (const row of rows) {
      expect(row).toMatchObject({ eventType: NOTIFICATION_OUTBOX_EVENT_TYPES.subtaskReminder, sourceKey: `subtask-reminder:${fixture.subtaskId}:${fixture.occurrenceId}` });
      expect(row.id).toMatch(UUID_V4);
      const payload = JSON.parse(row.payloadJson) as Record<string, Record<string, unknown>>;
      expect(Object.keys(payload)).toEqual(["schemaVersion", "event", "authorizationAtOccurrence", "reminder"]);
      expect(Object.keys(payload.authorizationAtOccurrence ?? {})).toEqual(["kind", "assignmentVersion", "membershipCycle", "startedAt"]);
      expect(Object.keys(payload.reminder ?? {})).toEqual(["occurrenceId", "projectId", "subtaskId", "scheduleVersion", "kind", "offsetMinutes", "dueAt", "dueLocalCivil", "zone", "utcOffsetMinutes", "fold"]);
      expect(payload).not.toHaveProperty("email");
      expect(payload.reminder).toMatchObject({ occurrenceId: fixture.occurrenceId, subtaskId: fixture.subtaskId, kind: "due_now", offsetMinutes: 0, dueAt: new Date(fixture.dueAt).toISOString() });
      expect((await ledgerFor(row.id)).map((ledger) => ledger.channel)).toEqual(["email", "in_app"]);
    }
    const byRecipient = new Map(rows.map((row) => [row.recipientId, row]));
    expect(JSON.parse(byRecipient.get(staff)!.payloadJson).authorizationAtOccurrence).toEqual({ kind: "subtask_assignment", assignmentVersion: 4, membershipCycle: null, startedAt: null });
    expect(byRecipient.get(staff)!.cycle).toBeNull();
    expect(JSON.parse(byRecipient.get(external)!.payloadJson).authorizationAtOccurrence).toEqual({ kind: "subtask_assignment", assignmentVersion: 6, membershipCycle: cycle, startedAt: now });
    expect(byRecipient.get(external)!.cycle).toBe(cycle);
    expect(await occurrenceRow(fixture.occurrenceId)).toMatchObject({ status: "fired", firedAt: now });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'project.subtask.reminder_fired' AND target_id = ?").bind(fixture.occurrenceId).first()).toEqual({ count: 1 });
  });

  it("consumes the occurrence and writes nothing for an unassigned Subtask, and covers someone added before the fire time but not someone removed", async () => {
    const now = Date.now();
    const unassigned = await seedSubtask(now);
    expect(await scanSubtaskReminderOccurrences(deliveryEnv(), now)).toMatchObject({ fired: 1, published: 0 });
    expect(await occurrenceRow(unassigned.occurrenceId)).toMatchObject({ status: "fired" });
    expect(await outboxFor(unassigned.subtaskId)).toEqual([]);

    const fixture = await seedSubtask(now);
    const kept = await addUser("admin", now);
    const removed = await addUser("admin", now);
    const lateAdded = await addUser("admin", now);
    await assign(fixture.subtaskId, kept, 1, now);
    await assign(fixture.subtaskId, removed, 2, now);
    await database.DB.prepare("DELETE FROM project_subtask_assignees WHERE subtask_id = ? AND user_id = ?").bind(fixture.subtaskId, removed).run();
    await assign(fixture.subtaskId, lateAdded, 3, now);
    await scanSubtaskReminderOccurrences(deliveryEnv(), now);
    expect((await outboxFor(fixture.subtaskId)).map((row) => row.recipientId).sort()).toEqual([kept, lateAdded].sort());
  });

  it("holds concurrent scans at the fire batch and lets only the claim winner write rows", async () => {
    const now = Date.now();
    const fixture = await seedSubtask(now);
    const admin = await addUser("admin", now);
    await assign(fixture.subtaskId, admin, 1, now);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let waiting = 0;
    const scanDb = {
      prepare: database.DB.prepare.bind(database.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        if (++waiting === 2) release();
        await gate;
        return database.DB.batch(statements);
      },
    } as unknown as D1Database;
    const both = deliveryEnv(undefined, scanDb);
    const [first, second] = await Promise.all([scanSubtaskReminderOccurrences(both, now), scanSubtaskReminderOccurrences(both, now)]);
    expect([first.fired, second.fired].sort()).toEqual([0, 1]);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'project.subtask.reminder_fired' AND target_id = ?").bind(fixture.occurrenceId).first()).toEqual({ count: 1 });
    expect(await outboxFor(fixture.subtaskId)).toHaveLength(1);
  });

  it.each([
    ["completed", "UPDATE project_subtasks SET done = 1 WHERE id = ?", "subtask_completed"],
    ["rescheduled", "UPDATE project_subtasks SET schedule_version = schedule_version + 1 WHERE id = ?", "schedule_replaced"],
    ["claimed by the legacy 08:00 pass", "UPDATE project_subtasks SET due_reminder_sent_at = 1 WHERE id = ?", "legacy_due_today_sent"],
  ] as const)("supersedes a pending occurrence of a Subtask that was %s, with no recipients", async (_name, update, reason) => {
    const now = Date.now();
    const fixture = await seedSubtask(now);
    const admin = await addUser("admin", now);
    await assign(fixture.subtaskId, admin, 1, now);
    await database.DB.prepare(update).bind(fixture.subtaskId).run();
    expect(await scanSubtaskReminderOccurrences(deliveryEnv(), now)).toMatchObject({ scanned: 1, fired: 0 });
    expect(await occurrenceRow(fixture.occurrenceId)).toEqual({ status: "superseded", terminalReason: reason, firedAt: null });
    expect(await outboxFor(fixture.subtaskId)).toEqual([]);
  });

  it("supersedes with project_archived, and an advance reminder whose due already passed with due_elapsed", async () => {
    const now = Date.now();
    const archived = await seedSubtask(now);
    await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(now, archived.projectId).run();
    await scanSubtaskReminderOccurrences(deliveryEnv(), now);
    expect(await occurrenceRow(archived.occurrenceId)).toMatchObject({ status: "superseded", terminalReason: "project_archived" });

    const late = await seedSubtask(now, { kind: "advance" });
    // The scan runs a day and a minute late, after the due itself.
    await scanSubtaskReminderOccurrences(deliveryEnv(), now + DAY + MINUTE);
    expect(await occurrenceRow(late.occurrenceId)).toMatchObject({ status: "superseded", terminalReason: "due_elapsed" });
    expect(await outboxFor(late.subtaskId)).toEqual([]);
  });

  it("still fires a due-now occurrence that the scan reaches late, because it is a reminder that the due has arrived", async () => {
    const now = Date.now();
    const fixture = await seedSubtask(now);
    const admin = await addUser("admin", now);
    await assign(fixture.subtaskId, admin, 1, now);
    await scanSubtaskReminderOccurrences(deliveryEnv(), now + 10 * MINUTE);
    expect(await occurrenceRow(fixture.occurrenceId)).toMatchObject({ status: "fired" });
    expect(await outboxFor(fixture.subtaskId)).toHaveLength(1);
  });

  it("does not write a second set of rows when an occurrence is fired twice directly", async () => {
    const now = Date.now();
    const fixture = await seedSubtask(now);
    const admin = await addUser("admin", now);
    await assign(fixture.subtaskId, admin, 1, now);
    const occurrence = { id: fixture.occurrenceId, subtaskId: fixture.subtaskId, projectId: fixture.projectId, scheduleVersion: fixture.version, kind: "due_now" as const, fireAt: fixture.fireAt, dueAt: fixture.dueAt };
    expect((await fireSubtaskReminderOccurrence(deliveryEnv(), occurrence, now)).claimed).toBe(true);
    expect((await fireSubtaskReminderOccurrence(deliveryEnv(), occurrence, now)).claimed).toBe(false);
    expect(await outboxFor(fixture.subtaskId)).toHaveLength(1);
  });
});

describe("Subtask reminder delivery (#424)", () => {
  async function fired(options: Seed & { externals?: number; staff?: number } = {}) {
    const now = Date.now();
    const fixture = await seedSubtask(now, options);
    const staff = await addUser("editor", now);
    await addMember(fixture.projectId, staff, now);
    await assign(fixture.subtaskId, staff, 1, now);
    const external = await addUser("external_editor", now);
    await addMember(fixture.projectId, external, now);
    await assign(fixture.subtaskId, external, 2, now);
    await scanSubtaskReminderOccurrences(deliveryEnv(), now);
    const rows = await outboxFor(fixture.subtaskId);
    return { ...fixture, now, staff, external, staffOutbox: rows.find((row) => row.recipientId === staff)!, externalOutbox: rows.find((row) => row.recipientId === external)! };
  }

  it("delivers in-app and email to staff, naming the Subtask in the email, and the External Editor gets only the static copy", async () => {
    const fixture = await fired({ kind: "advance" });
    const send = vi.fn().mockResolvedValue({ messageId: "m1" });
    await processNotificationMessage(deliveryEnv(send), message(fixture.staffOutbox.id));
    await processNotificationMessage(deliveryEnv(send), message(fixture.externalOutbox.id));
    expect(await ledgerFor(fixture.staffOutbox.id)).toMatchObject([{ channel: "email", status: "sent" }, { channel: "in_app", status: "sent" }]);
    expect(await ledgerFor(fixture.externalOutbox.id)).toMatchObject([{ channel: "email", status: "sent" }, { channel: "in_app", status: "sent" }]);
    const notices = (await database.DB.prepare("SELECT user_id AS userId, type, title, body FROM notifications WHERE source_key = ? ORDER BY user_id").bind(fixture.staffOutbox.sourceKey).all<{ userId: string; type: string; title: string; body: string }>()).results;
    const staffNotice = notices.find((notice) => notice.userId === fixture.staff)!;
    const externalNotice = notices.find((notice) => notice.userId === fixture.external)!;
    expect(staffNotice).toMatchObject({ type: "subtask_reminder", title: "Subtask due in 1 day" });
    expect(staffNotice.body).toContain("Reminder Street");
    expect(externalNotice).toMatchObject({ type: "subtask_reminder", title: "Checklist item reminder", body: "An assigned checklist item is due." });
    const mails = send.mock.calls.map(([mail]) => mail as { to: string; text: string });
    expect(mails.find((mail) => mail.to.startsWith(fixture.staff))?.text).toContain("Order the twilight shoot");
    expect(mails.find((mail) => mail.to.startsWith(fixture.external))?.text).not.toContain("Order the twilight shoot");
  });

  it("titles a due-now reminder as such", async () => {
    const fixture = await fired({ kind: "due_now" });
    await processNotificationMessage(deliveryEnv(), message(fixture.staffOutbox.id));
    expect(await database.DB.prepare("SELECT title FROM notifications WHERE user_id = ? AND source_key = ?").bind(fixture.staff, fixture.staffOutbox.sourceKey).first()).toEqual({ title: "Subtask due now" });
  });

  it("keeps in-app delivery while a disabled Subtask reminder preference suppresses only the email", async () => {
    const fixture = await fired();
    await database.DB.prepare("INSERT INTO notification_preferences (user_id, subtask_reminder_emails, updated_at) VALUES (?, 0, ?)").bind(fixture.staff, fixture.now).run();
    const send = vi.fn().mockResolvedValue({ messageId: "never" });
    const queued = message(fixture.staffOutbox.id);
    await processNotificationMessage(deliveryEnv(send), queued);
    expect(send).not.toHaveBeenCalled();
    expect(await ledgerFor(fixture.staffOutbox.id)).toMatchObject([{ channel: "email", status: "suppressed", code: "recipient_preference_disabled" }, { channel: "in_app", status: "sent" }]);
    expect((queued as { ack: ReturnType<typeof vi.fn> }).ack).toHaveBeenCalledOnce();
  });

  it("does not let the Project Deadline email preference switch off a Subtask reminder email", async () => {
    const fixture = await fired();
    await database.DB.prepare("INSERT INTO notification_preferences (user_id, project_deadline_reminder_emails, updated_at) VALUES (?, 0, ?)").bind(fixture.staff, fixture.now).run();
    const send = vi.fn().mockResolvedValue({ messageId: "sent" });
    await processNotificationMessage(deliveryEnv(send), message(fixture.staffOutbox.id));
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    ["removed from the Subtask", (f: Awaited<ReturnType<typeof fired>>) => database.DB.prepare("DELETE FROM project_subtask_assignees WHERE subtask_id = ?").bind(f.subtaskId).run()],
    ["completed", (f: Awaited<ReturnType<typeof fired>>) => database.DB.prepare("UPDATE project_subtasks SET done = 1 WHERE id = ?").bind(f.subtaskId).run()],
    ["rescheduled", (f: Awaited<ReturnType<typeof fired>>) => database.DB.prepare("UPDATE project_subtasks SET schedule_version = schedule_version + 1 WHERE id = ?").bind(f.subtaskId).run()],
    ["archived with its Project", (f: Awaited<ReturnType<typeof fired>>) => database.DB.prepare("UPDATE projects SET archived_at = 1 WHERE id = ?").bind(f.projectId).run()],
  ] as const)("suppresses both channels when the Subtask is %s before delivery", async (_name, mutate) => {
    const fixture = await fired();
    await mutate(fixture);
    const send = vi.fn().mockResolvedValue({ messageId: "never" });
    await processNotificationMessage(deliveryEnv(send), message(fixture.staffOutbox.id));
    expect(send).not.toHaveBeenCalled();
    expect((await ledgerFor(fixture.staffOutbox.id)).every((ledger) => ledger.status === "suppressed")).toBe(true);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notifications WHERE source_key = ? AND user_id = ?").bind(fixture.staffOutbox.sourceKey, fixture.staff).first()).toEqual({ count: 0 });
  });

  it.each([
    ["the assignee is removed", (f: Awaited<ReturnType<typeof fired>>) => database.DB.prepare("DELETE FROM project_subtask_assignees WHERE subtask_id = ? AND user_id = ?").bind(f.subtaskId, f.staff).run()],
    ["the assignee is removed and re-added at a new version", async (f: Awaited<ReturnType<typeof fired>>) => {
      await database.DB.prepare("DELETE FROM project_subtask_assignees WHERE subtask_id = ? AND user_id = ?").bind(f.subtaskId, f.staff).run();
      await assign(f.subtaskId, f.staff, 9, f.now);
    }],
    ["the Subtask is completed", (f: Awaited<ReturnType<typeof fired>>) => database.DB.prepare("UPDATE project_subtasks SET done = 1 WHERE id = ?").bind(f.subtaskId).run()],
    ["the Project is archived", (f: Awaited<ReturnType<typeof fired>>) => database.DB.prepare("UPDATE projects SET archived_at = 1 WHERE id = ?").bind(f.projectId).run()],
    ["the Subtask is rescheduled", (f: Awaited<ReturnType<typeof fired>>) => database.DB.prepare("UPDATE projects SET updated_at = updated_at WHERE id = ?").bind(f.projectId).run().then(() => database.DB.prepare("UPDATE project_subtasks SET schedule_end_at = schedule_end_at + 60000 WHERE id = ?").bind(f.subtaskId).run())],
    ["the person is deactivated", (f: Awaited<ReturnType<typeof fired>>) => database.DB.prepare("UPDATE user SET active = 0 WHERE id = ?").bind(f.staff).run()],
    ["the person leaves the Project", (f: Awaited<ReturnType<typeof fired>>) => database.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").bind(f.projectId, f.staff).run()],
    ["the email preference is switched off", (f: Awaited<ReturnType<typeof fired>>) => database.DB.prepare("INSERT INTO notification_preferences (user_id, subtask_reminder_emails, updated_at) VALUES (?, 0, ?)").bind(f.staff, f.now).run()],
  ] as const)("stops the email when %s between the in-app and email channels", async (_name, mutate) => {
    const fixture = await fired();
    const send = vi.fn().mockResolvedValue({ messageId: "never" });
    const racing = mutateBetweenChannels(async () => { await mutate(fixture); });
    await processNotificationMessage(deliveryEnv(send, racing), message(fixture.staffOutbox.id));
    expect(send).not.toHaveBeenCalled();
    const ledger = await ledgerFor(fixture.staffOutbox.id);
    expect(ledger.find((row) => row.channel === "in_app")?.status).toBe("sent");
    expect(ledger.find((row) => row.channel === "email")?.status).toBe("suppressed");
  });

  it("suppresses an External Editor's reminder when their membership cycle is replaced, and a late legacy due-today job is refused", async () => {
    const fixture = await fired();
    await database.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").bind(fixture.projectId, fixture.external).run();
    await addMember(fixture.projectId, fixture.external, fixture.now + 1);
    const send = vi.fn().mockResolvedValue({ messageId: "never" });
    await processNotificationMessage(deliveryEnv(send), message(fixture.externalOutbox.id));
    expect(send).not.toHaveBeenCalled();
    expect((await ledgerFor(fixture.externalOutbox.id)).every((ledger) => ledger.status === "suppressed")).toBe(true);

    const legacyId = crypto.randomUUID();
    const external = fixture.external;
    await database.DB.batch([
      database.DB.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, recipient_authorization_epoch, payload_json, status, available_at, created_at, updated_at) VALUES (?, 1, 'project.subtask.due_today', ?, ?, ?, ?, 0, '{}', 'queued', ?, ?, ?)").bind(legacyId, `subtask-due:${fixture.subtaskId}:2026-08-27`, fixture.projectId, external, external, fixture.now, fixture.now, fixture.now),
      database.DB.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, attempts, created_at, updated_at) VALUES (?, ?, 'project.subtask.due_today', ?, ?, 'in_app', 'pending', 0, ?, ?)").bind(crypto.randomUUID(), legacyId, `subtask-due:${fixture.subtaskId}:2026-08-27`, external, fixture.now, fixture.now),
    ]);
    await processNotificationMessage(deliveryEnv(send), message(legacyId));
    expect(send).not.toHaveBeenCalled();
    expect(await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(legacyId).first()).toEqual({ status: "suppressed" });
  });
});

describe("Subtask reminder hourly reconcile (#424)", () => {
  it("inserts the occurrences an old Worker left missing, then inserts none on the next pass", async () => {
    const now = Date.now();
    const projectId = crypto.randomUUID();
    const subtaskId = crypto.randomUUID();
    const creator = await addUser("editor", now);
    const dueAt = now + 3 * DAY;
    await database.DB.batch([
      database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Reconcile Street', 'editing_autohdr', ?, ?)").bind(projectId, now, now),
      // An old Worker inserts a Subtask with no occurrence rows, and the column default fills the offsets.
      database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, 'Gap', 0, 1024, '2026-08-27T12:00', 'timed', '2026-08-27T09:00', ?, 600, 0, 'timed', ?, 600, 0, 'Australia/Sydney', 1, ?, ?, ?)").bind(subtaskId, projectId, dueAt - 3 * 60 * MINUTE, dueAt, creator, now, now),
    ]);
    const first = await reconcileSubtaskReminderOccurrences(deliveryEnv(), now);
    expect(first.inserted).toBeGreaterThanOrEqual(2);
    const rows = (await database.DB.prepare("SELECT kind, reminder_offset_minutes AS offset, status, created_by AS createdBy FROM project_subtask_reminder_occurrences WHERE subtask_id = ? ORDER BY reminder_offset_minutes DESC").bind(subtaskId).all()).results;
    expect(rows).toEqual([{ kind: "advance", offset: 1440, status: "pending", createdBy: null }, { kind: "due_now", offset: 0, status: "pending", createdBy: null }]);
    expect((await reconcileSubtaskReminderOccurrences(deliveryEnv(), now)).inserted).toBe(0);
  });
});

describe("Editing a Subtask's reminders, then the real scan and delivery (#425)", () => {
  const HOUR = 60 * MINUTE;
  const t0 = Date.now();
  const dueAt = t0 + 3 * DAY;

  /** A Subtask due in three days with one staff assignee, its occurrences materialised by the real bundle at `t0`. */
  async function editable(offsets: number[]) {
    const fixture = await seedSubtask(t0, { kind: "advance" });
    await database.DB.prepare("DELETE FROM project_subtask_reminder_occurrences WHERE subtask_id = ?").bind(fixture.subtaskId).run();
    await database.DB.prepare("UPDATE project_subtasks SET schedule_start_at = ?, schedule_end_at = ?, reminder_offsets_json = ? WHERE id = ?").bind(dueAt - 8 * HOUR, dueAt, JSON.stringify(offsets), fixture.subtaskId).run();
    const staff = await addUser("editor", t0);
    await addMember(fixture.projectId, staff, t0);
    await assign(fixture.subtaskId, staff, 1, t0);
    await database.DB.batch(buildSubtaskReminderMaterialization({ db: database.DB, scope: { kind: "subtask", subtaskId: fixture.subtaskId }, now: t0, createdBy: null }).statements);
    return { ...fixture, staff };
  }

  /** The API's reminders-only edit: a new schedule version and offset set, the old pending set superseded, the new one materialised. */
  async function editReminders(fixture: { projectId: string; subtaskId: string }, offsets: number[], now: number) {
    const auditId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, NULL, 'project.subtask.update', 'project_subtask', ?, NULL, ?)").bind(auditId, fixture.subtaskId, now).run();
    const gate = { db: database.DB, now, gateAuditId: auditId } as const;
    await database.DB.batch([
      database.DB.prepare("UPDATE project_subtasks SET schedule_version = schedule_version + 1, reminder_offsets_json = ? WHERE id = ?").bind(JSON.stringify(offsets), fixture.subtaskId),
      ...buildSubtaskReminderSuppression({ ...gate, scope: { kind: "subtask", projectId: fixture.projectId, subtaskId: fixture.subtaskId }, reason: "reminders_changed" }).statements,
      ...buildSubtaskReminderMaterialization({ ...gate, scope: { kind: "subtask", subtaskId: fixture.subtaskId }, createdBy: null }).statements,
    ]);
  }

  /** Delivery re-reads the clock, so it runs at the simulated time, after the reminder's fire time. */
  async function deliverAt(now: number, deliveryEnvironment: Env, outboxId: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try { await processNotificationMessage(deliveryEnvironment, message(outboxId)); } finally { vi.useRealTimers(); }
  }

  const offsetOf = (row: { payloadJson: string }) => (JSON.parse(row.payloadJson) as { reminder: { offsetMinutes: number } }).reminder.offsetMinutes;
  const statusOf = (outboxId: string) => database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(outboxId).first<{ status: string }>().then((row) => row?.status);

  it("delivers a newly added offset, never delivers a removed one, and still delivers Due now", async () => {
    const fixture = await editable([1440]);
    await editReminders(fixture, [60], t0 + HOUR);
    // Past the removed 1-day fire time: nothing is pending to fire.
    await scanSubtaskReminderOccurrences(deliveryEnv(), dueAt - DAY + MINUTE);
    expect(await outboxFor(fixture.subtaskId)).toEqual([]);
    // The added 1-hour offset fires and is delivered through both channels.
    await scanSubtaskReminderOccurrences(deliveryEnv(), dueAt - HOUR + MINUTE);
    expect(await outboxFor(fixture.subtaskId)).toHaveLength(1);
    const [advance] = await outboxFor(fixture.subtaskId);
    expect(offsetOf(advance!)).toBe(60);
    const send = vi.fn().mockResolvedValue({ messageId: "added" });
    await deliverAt(dueAt - HOUR + MINUTE, deliveryEnv(send), advance!.id);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await ledgerFor(advance!.id)).toMatchObject([{ channel: "email", status: "sent" }, { channel: "in_app", status: "sent" }]);
    // Due now is untouched by the edit.
    await scanSubtaskReminderOccurrences(deliveryEnv(), dueAt);
    expect((await outboxFor(fixture.subtaskId)).map(offsetOf).sort((a, b) => a - b)).toEqual([0, 60]);
  });

  it("an offset removed after it fired and was queued is suppressed, never delivered", async () => {
    const fixture = await editable([1440]);
    await scanSubtaskReminderOccurrences(deliveryEnv(), dueAt - DAY + MINUTE);
    const [queued] = await outboxFor(fixture.subtaskId);
    expect(offsetOf(queued!)).toBe(1440);
    expect(await statusOf(queued!.id)).toBe("queued");
    await editReminders(fixture, [], dueAt - DAY + 2 * MINUTE);
    expect(await statusOf(queued!.id)).toBe("suppressed");
    expect((await ledgerFor(queued!.id)).every((row) => row.status === "suppressed")).toBe(true);
    const send = vi.fn().mockResolvedValue({ messageId: "never" });
    await deliverAt(dueAt - DAY + 3 * MINUTE, deliveryEnv(send), queued!.id);
    expect(send).not.toHaveBeenCalled();
    expect((await ledgerFor(queued!.id)).some((row) => row.status === "sent")).toBe(false);
  });

  it("an offset removed while its delivery is already claimed stops the email at the delivery re-check", async () => {
    const fixture = await editable([1440]);
    await scanSubtaskReminderOccurrences(deliveryEnv(), dueAt - DAY + MINUTE);
    const [row] = await outboxFor(fixture.subtaskId);
    const send = vi.fn().mockResolvedValue({ messageId: "never" });
    const racing = mutateBetweenChannels(() => editReminders(fixture, [], dueAt - DAY + 2 * MINUTE));
    await deliverAt(dueAt - DAY + MINUTE, deliveryEnv(send, racing), row!.id);
    expect(send).not.toHaveBeenCalled();
    const ledger = await ledgerFor(row!.id);
    expect(ledger.find((entry) => entry.channel === "email")?.status).toBe("suppressed");
  });
});
