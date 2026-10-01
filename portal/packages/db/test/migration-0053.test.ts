import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { subtaskReminderMaterializationSql } from "../src/subtask-reminder-bundles";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0053_subtask_reminders.sql";
const CHECK_FAILED = /CHECK constraint failed/i;
const UNIQUE_FAILED = /UNIQUE constraint failed/i;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

function migrationSql(name: string): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", "");
}

/** Applies a migration the way D1 does: every statement of the file inside ONE transaction. */
function applyAsTransaction(db: SqliteDatabase, name: string): void {
  const source = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  db.exec("BEGIN");
  try {
    for (const statement of source.split("--> statement-breakpoint")) db.exec(statement);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function applyThrough(db: SqliteDatabase, through: number): void {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value) && Number(value.slice(0, 4)) <= through).sort()) db.exec(migrationSql(name));
}

function freshDb(through: number): SqliteDatabase {
  const db = localSqlite();
  db.exec("PRAGMA foreign_keys = ON");
  applyThrough(db, through);
  const now = Date.now();
  db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u@example.test', 1, 'editor', 1, ?, ?)").run(now, now);
  db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('p1', 'Street', 'edited_review', 0, ?, ?)").run(now, now);
  db.prepare("INSERT INTO projects (id, street, stage_key, board_position, archived_at, created_at, updated_at) VALUES ('pa', 'Archived', 'edited_review', 1, ?, ?, ?)").run(now, now, now);
  return db;
}

type SubtaskFixture = { done?: number; projectId?: string; reminderSentAt?: number | null; version?: number };

/** A timed range ending `endAt`. The civil strings are opaque to the migration, which copies `due_date` as it is. */
function insertSubtask(db: SqliteDatabase, id: string, endAt: number, extra: SubtaskFixture = {}): void {
  const now = Date.now();
  db.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, due_date, due_reminder_sent_at, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, 't', ?, 1024, ?, ?, 'timed', '2099-01-01T09:00', ?, 660, 0, 'timed', ?, 660, 0, 'Australia/Sydney', ?, 'u1', ?, ?)")
    .run(id, extra.projectId ?? "p1", extra.done ?? 0, `civil-${id}`, extra.reminderSentAt ?? null, endAt - 3 * HOUR, endAt, extra.version ?? 3, now, now);
}

type Occurrence = { subtask_id: string; schedule_version: number; kind: string; reminder_offset_minutes: number; fire_at: number; due_at: number; due_local_civil: string; due_zone: string; due_utc_offset_minutes: number; due_fold: number; status: string; terminal_reason: string | null; fired_at: number | null; created_by: string | null; project_id: string };
const READ_OCCURRENCES = "SELECT subtask_id, project_id, schedule_version, kind, reminder_offset_minutes, fire_at, due_at, due_local_civil, due_zone, due_utc_offset_minutes, due_fold, status, terminal_reason, fired_at, created_by FROM project_subtask_reminder_occurrences ORDER BY subtask_id, reminder_offset_minutes DESC";
const occurrences = (db: SqliteDatabase) => db.prepare(READ_OCCURRENCES).all() as Occurrence[];

/** The rows both writers must agree on: everything except the random ids and the write timestamps. */
function comparable(rows: Occurrence[]) {
  return rows.map(({ created_by: _createdBy, ...rest }) => rest);
}

function seed(db: SqliteDatabase, now: number): void {
  insertSubtask(db, "future", now + 3 * DAY);
  insertSubtask(db, "soon", now + 2 * HOUR);
  insertSubtask(db, "past", now - 2 * HOUR);
  insertSubtask(db, "done", now + 3 * DAY, { done: 1 });
  insertSubtask(db, "archived", now + 3 * DAY, { projectId: "pa" });
  insertSubtask(db, "legacy-sent", now + 3 * DAY, { reminderSentAt: now - HOUR });
}

describe("migration 0053 gives every Subtask its reminders (#424, ADR 0016)", () => {
  it("is journaled, additive, and free of triggers and semicolons in comments", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    expect(sql).not.toMatch(/CREATE TRIGGER|DROP TABLE|__new_|PRAGMA/i);
    // The harness that applies migrations splits statements on ";" and drops comment lines, so a ";" anywhere in a comment or literal is a trap.
    for (const line of sql.split("\n").filter((value) => value.startsWith("--"))) expect(line, line).not.toContain(";");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const code = statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim();
      expect(code.endsWith(";"), code.slice(0, 60)).toBe(true);
      expect(code.slice(0, -1), code.slice(0, 60)).not.toContain(";");
    }
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((entry) => entry.idx === 53)?.tag).toBe(MIGRATION.replace(/\.sql$/, ""));
  });

  it("applies as one transaction, defaults every Subtask to [1440] and backfills only the reminders still ahead", () => {
    const db = freshDb(52);
    const now = Date.now();
    seed(db, now);
    applyAsTransaction(db, MIGRATION);
    // Every row, completed and archived included, carries the default offsets.
    expect(db.prepare("SELECT id, reminder_offsets_json AS offsets FROM project_subtasks ORDER BY id").all()).toHaveLength(6);
    for (const row of db.prepare("SELECT reminder_offsets_json AS offsets FROM project_subtasks").all() as Array<{ offsets: string }>) expect(row.offsets).toBe("[1440]");
    const rows = occurrences(db);
    const byId = (id: string) => rows.filter((row) => row.subtask_id === id).map((row) => ({ kind: row.kind, offset: row.reminder_offset_minutes }));
    expect(byId("future")).toEqual([{ kind: "advance", offset: 1440 }, { kind: "due_now", offset: 0 }]);
    // One day before the due has already passed, so only the future "Due now" is stored (D3).
    expect(byId("soon")).toEqual([{ kind: "due_now", offset: 0 }]);
    for (const id of ["past", "done", "archived", "legacy-sent"]) expect(byId(id), id).toEqual([]);
    expect(rows).toHaveLength(3);
    const future = db.prepare("SELECT schedule_end_at AS endAt FROM project_subtasks WHERE id = 'future'").get() as { endAt: number };
    expect(rows.filter((row) => row.subtask_id === "future")).toEqual([
      expect.objectContaining({ schedule_version: 3, kind: "advance", reminder_offset_minutes: 1440, fire_at: future.endAt - DAY, due_at: future.endAt, due_local_civil: "civil-future", due_zone: "Australia/Sydney", due_utc_offset_minutes: 660, due_fold: 0, status: "pending", terminal_reason: null, fired_at: null, created_by: null, project_id: "p1" }),
      expect.objectContaining({ schedule_version: 3, kind: "due_now", reminder_offset_minutes: 0, fire_at: future.endAt, due_at: future.endAt, status: "pending" }),
    ]);
    // The migration wrote no audit row and no activity.
    expect(db.prepare("SELECT count(*) AS n FROM audit_log").get()).toEqual({ n: 0 });
    db.close();
  });

  it("is pinned to the TypeScript builder: scope all writes exactly the rows the migration backfilled, and a second run writes none", () => {
    const now = Date.now();
    const migrated = freshDb(52);
    seed(migrated, now);
    applyAsTransaction(migrated, MIGRATION);
    const viaMigration = comparable(occurrences(migrated));

    const built = freshDb(52);
    seed(built, now);
    applyAsTransaction(built, MIGRATION);
    built.exec("DELETE FROM project_subtask_reminder_occurrences");
    const { sql, values } = subtaskReminderMaterializationSql({ scope: { kind: "all" }, now: Date.now(), createdBy: null });
    expect(built.prepare(sql).run(...values).changes).toBe(3);
    expect(comparable(occurrences(built))).toEqual(viaMigration);
    // Idempotent: the live rows block a repeat.
    expect(built.prepare(sql).run(...values).changes).toBe(0);
    // Scope subtask and scope project select the same rows as the whole backfill.
    built.exec("DELETE FROM project_subtask_reminder_occurrences");
    const one = subtaskReminderMaterializationSql({ scope: { kind: "subtask", subtaskId: "future" }, now: Date.now(), createdBy: "u1" });
    expect(built.prepare(one.sql).run(...one.values).changes).toBe(2);
    const project = subtaskReminderMaterializationSql({ scope: { kind: "project", projectId: "p1" }, now: Date.now(), createdBy: "u1" });
    expect(built.prepare(project.sql).run(...project.values).changes).toBe(1);
    expect(comparable(occurrences(built))).toEqual(viaMigration);
    expect((occurrences(migrated)[0] as Occurrence).created_by).toBeNull();
    expect((occurrences(built)[0] as Occurrence).created_by).toBe("u1");
    migrated.close();
    built.close();
  });

  it("a gated builder writes nothing when its audit row is absent", () => {
    const db = freshDb(53);
    const now = Date.now();
    insertSubtask(db, "s1", now + 3 * DAY);
    db.exec("DELETE FROM project_subtask_reminder_occurrences");
    const missing = subtaskReminderMaterializationSql({ scope: { kind: "subtask", subtaskId: "s1" }, now, createdBy: "u1", gateAuditId: "no-such-audit" });
    expect(db.prepare(missing.sql).run(...missing.values).changes).toBe(0);
    db.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES ('a1', 'u1', 'project_subtask.update', 'project_subtask', 's1', NULL, ?)").run(now);
    const present = subtaskReminderMaterializationSql({ scope: { kind: "subtask", subtaskId: "s1" }, now, createdBy: "u1", gateAuditId: "a1" });
    expect(db.prepare(present.sql).run(...present.values).changes).toBe(2);
    db.close();
  });

  it("an old Worker that does not know the new column or table still inserts a Subtask and a preferences row", () => {
    const db = freshDb(53);
    const now = Date.now();
    // The pre-0053 INSERT column list, exactly as saveProjectSubtask wrote it.
    db.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES ('old', 'p1', 't', 0, 1024, 0, '2099-01-02T17:00', 'timed', '2099-01-01T09:00', 1, 660, 0, 'timed', ?, 660, 0, 'Australia/Sydney', 1, 'u1', ?, ?)").run(now + DAY, now, now);
    expect(db.prepare("SELECT reminder_offsets_json AS offsets FROM project_subtasks WHERE id = 'old'").get()).toEqual({ offsets: "[1440]" });
    db.prepare("INSERT INTO notification_preferences (user_id, project_deadline_reminder_emails, updated_at) VALUES ('u1', 0, ?) ON CONFLICT (user_id) DO UPDATE SET project_deadline_reminder_emails = excluded.project_deadline_reminder_emails, updated_at = excluded.updated_at").run(now);
    expect(db.prepare("SELECT project_deadline_reminder_emails AS deadline, subtask_reminder_emails AS subtask FROM notification_preferences WHERE user_id = 'u1'").get()).toEqual({ deadline: 0, subtask: 1 });
    db.close();
  });

  it("refuses offsets that are not a JSON array and preference values outside 0 and 1", () => {
    const db = freshDb(53);
    const now = Date.now();
    insertSubtask(db, "s1", now + DAY);
    for (const bad of ["not json", "1440", "{\"a\":1}", "\"x\""]) expect(() => db.prepare("UPDATE project_subtasks SET reminder_offsets_json = ? WHERE id = 's1'").run(bad), bad).toThrow(CHECK_FAILED);
    expect(() => db.prepare("UPDATE project_subtasks SET reminder_offsets_json = NULL WHERE id = 's1'").run()).toThrow();
    db.prepare("UPDATE project_subtasks SET reminder_offsets_json = '[]' WHERE id = 's1'").run();
    db.prepare("UPDATE project_subtasks SET reminder_offsets_json = '[2880,1440]' WHERE id = 's1'").run();
    db.prepare("INSERT INTO notification_preferences (user_id, updated_at) VALUES ('u1', ?)").run(now);
    expect(() => db.prepare("UPDATE notification_preferences SET subtask_reminder_emails = 2 WHERE user_id = 'u1'").run()).toThrow(CHECK_FAILED);
    expect(() => db.prepare("UPDATE notification_preferences SET subtask_reminder_emails = NULL WHERE user_id = 'u1'").run()).toThrow();
    db.close();
  });

  it("enforces the occurrence table's CHECKs and the partial unique index", () => {
    const db = freshDb(53);
    const now = Date.now();
    insertSubtask(db, "s1", now + 3 * DAY);
    db.exec("DELETE FROM project_subtask_reminder_occurrences");
    const due = now + 3 * DAY;
    let counter = 0;
    const insert = (over: Partial<Record<string, unknown>> = {}) => {
      const row = { id: `o${++counter}`, subtask_id: "s1", project_id: "p1", schedule_version: 3, kind: "advance", reminder_offset_minutes: 1440, fire_at: due - DAY, due_at: due, due_local_civil: "c", due_zone: "Australia/Sydney", due_utc_offset_minutes: 660, due_fold: 0, status: "pending", terminal_reason: null, fired_at: null, created_by: null, created_at: now, updated_at: now, ...over };
      const columns = Object.keys(row);
      return db.prepare(`INSERT INTO project_subtask_reminder_occurrences (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(row));
    };
    expect(() => insert({ kind: "due_now" })).toThrow(CHECK_FAILED);
    expect(() => insert({ kind: "advance", reminder_offset_minutes: 0, fire_at: due })).toThrow(CHECK_FAILED);
    expect(() => insert({ kind: "weekly" })).toThrow(CHECK_FAILED);
    expect(() => insert({ reminder_offset_minutes: 43201, fire_at: due - 43201 * MINUTE })).toThrow(CHECK_FAILED);
    expect(() => insert({ fire_at: due - HOUR })).toThrow(CHECK_FAILED);
    expect(() => insert({ schedule_version: 0 })).toThrow(CHECK_FAILED);
    expect(() => insert({ due_zone: "UTC" })).toThrow(CHECK_FAILED);
    expect(() => insert({ due_fold: 2 })).toThrow(CHECK_FAILED);
    expect(() => insert({ status: "skipped", terminal_reason: "due_elapsed" })).toThrow(CHECK_FAILED);
    expect(() => insert({ status: "pending", terminal_reason: "due_elapsed" })).toThrow(CHECK_FAILED);
    expect(() => insert({ status: "pending", fired_at: now })).toThrow(CHECK_FAILED);
    expect(() => insert({ status: "fired", fired_at: null })).toThrow(CHECK_FAILED);
    expect(() => insert({ status: "fired", fired_at: now, terminal_reason: "due_elapsed" })).toThrow(CHECK_FAILED);
    expect(() => insert({ status: "superseded", terminal_reason: null })).toThrow(CHECK_FAILED);
    expect(() => insert({ status: "superseded", terminal_reason: "nonsense" })).toThrow(CHECK_FAILED);
    expect(() => insert({ subtask_id: "missing" })).toThrow(/FOREIGN KEY/i);
    for (const reason of ["schedule_replaced", "reminders_changed", "subtask_completed", "project_archived", "due_elapsed", "legacy_due_today_sent"]) insert({ status: "superseded", terminal_reason: reason });
    // Superseded rows never block a live one, but two live rows for the same version, kind and offset are refused.
    insert();
    expect(() => insert()).toThrow(UNIQUE_FAILED);
    insert({ status: "fired", fired_at: now, schedule_version: 4 });
    expect(() => insert({ status: "fired", fired_at: now, schedule_version: 4 })).toThrow(UNIQUE_FAILED);
    expect(() => insert({ status: "pending", schedule_version: 4 })).toThrow(UNIQUE_FAILED);
    insert({ kind: "due_now", reminder_offset_minutes: 0, fire_at: due });
    // Deleting the Subtask or the Project removes its occurrences.
    db.prepare("DELETE FROM project_subtasks WHERE id = 's1'").run();
    expect(occurrences(db)).toEqual([]);
    db.close();
  });

  it("suppresses undelivered legacy due-today deliveries and leaves delivered history alone", () => {
    const db = freshDb(52);
    const now = Date.now();
    const outbox = (id: string, eventType: string, status: string) => db.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, status, available_at, created_at, updated_at) VALUES (?, 1, ?, ?, 'p1', 'u1', 'u1', '{}', ?, ?, ?, ?)").run(id, eventType, `k-${id}`, status, now, now, now);
    const ledger = (id: string, outboxId: string, eventType: string, channel: string, status: string) => db.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'u1', ?, ?, ?, ?)").run(id, outboxId, eventType, `k-${outboxId}`, channel, status, now, now);
    outbox("queued", "project.subtask.due_today", "queued"); ledger("l1", "queued", "project.subtask.due_today", "in_app", "pending"); ledger("l2", "queued", "project.subtask.due_today", "email", "pending");
    outbox("pending", "project.subtask.due_today", "pending"); ledger("l3", "pending", "project.subtask.due_today", "in_app", "pending");
    outbox("half", "project.subtask.due_today", "queued"); ledger("l4", "half", "project.subtask.due_today", "in_app", "sent"); ledger("l5", "half", "project.subtask.due_today", "email", "pending");
    outbox("done", "project.subtask.due_today", "completed"); ledger("l6", "done", "project.subtask.due_today", "in_app", "sent"); ledger("l7", "done", "project.subtask.due_today", "email", "sent");
    outbox("leased", "project.subtask.due_today", "queued"); ledger("l8", "leased", "project.subtask.due_today", "in_app", "processing");
    outbox("other", "project.subtask.assigned", "queued"); ledger("l9", "other", "project.subtask.assigned", "in_app", "pending");
    applyAsTransaction(db, MIGRATION);
    const status = (table: string, id: string) => (db.prepare(`SELECT status FROM ${table} WHERE id = ?`).get(id) as { status: string }).status;
    expect(["l1", "l2", "l3", "l5"].map((id) => status("notification_delivery_ledger", id))).toEqual(["suppressed", "suppressed", "suppressed", "suppressed"]);
    expect(["queued", "pending", "half"].map((id) => status("notification_outbox", id))).toEqual(["suppressed", "suppressed", "suppressed"]);
    expect(db.prepare("SELECT last_error_code AS code, completed_at IS NOT NULL AS closed, lease_token AS lease FROM notification_outbox WHERE id = 'queued'").get()).toEqual({ code: "reauthorization_suppressed", closed: 1, lease: null });
    // History and in-flight work are untouched, and so is every other event type.
    expect(["l4", "l6", "l7"].map((id) => status("notification_delivery_ledger", id))).toEqual(["sent", "sent", "sent"]);
    expect(status("notification_outbox", "done")).toBe("completed");
    expect(status("notification_delivery_ledger", "l8")).toBe("processing");
    expect(status("notification_outbox", "leased")).toBe("queued");
    expect(status("notification_delivery_ledger", "l9")).toBe("pending");
    expect(status("notification_outbox", "other")).toBe("queued");
    db.close();
  });

  it("rolls the whole file back when a step fails", () => {
    const db = freshDb(52);
    const now = Date.now();
    insertSubtask(db, "s1", now + DAY * 3);
    // A pre-existing table of the same name makes step 2 fail, which must undo step 1's ALTER.
    db.exec("CREATE TABLE project_subtask_reminder_occurrences (id text)");
    expect(() => applyAsTransaction(db, MIGRATION)).toThrow();
    expect(db.prepare("SELECT name FROM pragma_table_info('project_subtasks') WHERE name = 'reminder_offsets_json'").all()).toEqual([]);
    db.close();
  });
});
