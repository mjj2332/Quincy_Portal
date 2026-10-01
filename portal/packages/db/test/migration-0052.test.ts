import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeChecklistSchedule, SUBTASK_END_PRESET_TIME, SUBTASK_START_PRESET_TIME } from "@quincy/shared";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0052_subtask_ends_are_moments.sql";
const NOW = 1_787_000_000_000;
const CHECK_FAILED = /CHECK constraint failed/i;

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

function migrationSql(name: string): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", "");
}

/**
 * Applies a migration file the way D1 (`wrangler d1 migrations apply`) does: every statement of the file inside ONE
 * transaction, so a failure anywhere rolls the whole file back. A bare `db.exec(migrationSql(...))` autocommits each
 * statement, which would hide a rollback gap between the UPDATE and the ALTER.
 */
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
  db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u@example.test', 1, 'editor', 1, ?, ?)").run(NOW, NOW);
  db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('p1', 'Street', 'edited_review', 0, ?, ?)").run(NOW, NOW);
  return db;
}

/** A legacy date-only range exactly as the pre-0052 writer stored it: civil dates, no instants. */
function insertLegacyDate(db: SqliteDatabase, id: string, start: string, end: string, extra: { done?: number; version?: number; reminderSentAt?: number | null } = {}): void {
  db.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, due_date, due_reminder_sent_at, schedule_start_kind, schedule_start_civil, schedule_end_kind, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, 'p1', 't', ?, 1024, ?, ?, 'date', ?, 'date', 'Australia/Sydney', ?, 'u1', ?, ?)")
    .run(id, extra.done ?? 0, end, extra.reminderSentAt ?? null, start, extra.version ?? 1, NOW, NOW);
}

function insertTimed(db: SqliteDatabase, id: string, start: string, end: string, version = 1): void {
  const result = normalizeChecklistSchedule({ state: "range", start: { localCivil: start }, end: { localCivil: end } }, version);
  if (!result.ok) throw new Error("fixture schedule invalid");
  const v = result.value;
  db.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, 'p1', 't', 0, 1024, ?, 'timed', ?, ?, ?, ?, 'timed', ?, ?, ?, 'Australia/Sydney', ?, 'u1', ?, ?)")
    .run(id, v.dueDate, v.scheduleStartCivil, v.scheduleStartAt, v.scheduleStartUtcOffsetMinutes, v.scheduleStartFold, v.scheduleEndAt, v.scheduleEndUtcOffsetMinutes, v.scheduleEndFold, v.scheduleVersion, NOW, NOW);
}

type Stored = { id: string; due_date: string; schedule_start_kind: string; schedule_start_civil: string; schedule_start_at: number; schedule_start_utc_offset_minutes: number; schedule_start_fold: number; schedule_end_kind: string; schedule_end_at: number; schedule_end_utc_offset_minutes: number; schedule_end_fold: number; schedule_version: number };
const READ = "SELECT id, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_version FROM project_subtasks ORDER BY id";

function expectedFor(start: string, end: string, version: number) {
  const result = normalizeChecklistSchedule({ state: "range", start: { localCivil: `${start}T${SUBTASK_START_PRESET_TIME}` }, end: { localCivil: `${end}T${SUBTASK_END_PRESET_TIME}` } }, version);
  if (!result.ok) throw new Error(`preset range invalid for ${start}..${end}`);
  return result.value;
}

function expectMatches(row: Stored, start: string, end: string, legacyVersion: number): void {
  const expected = expectedFor(start, end, legacyVersion + 1);
  expect({
    due: row.due_date, startKind: row.schedule_start_kind, startCivil: row.schedule_start_civil, startAt: row.schedule_start_at, startOffset: row.schedule_start_utc_offset_minutes, startFold: row.schedule_start_fold,
    endKind: row.schedule_end_kind, endAt: row.schedule_end_at, endOffset: row.schedule_end_utc_offset_minutes, endFold: row.schedule_end_fold, version: row.schedule_version,
  }, `${start}..${end}`).toEqual({
    due: expected.dueDate, startKind: "timed", startCivil: expected.scheduleStartCivil, startAt: expected.scheduleStartAt, startOffset: expected.scheduleStartUtcOffsetMinutes, startFold: 0,
    endKind: "timed", endAt: expected.scheduleEndAt, endOffset: expected.scheduleEndUtcOffsetMinutes, endFold: 0, version: legacyVersion + 1,
  });
}

function* days(fromYear: number, toYear: number): Generator<string> {
  const cursor = new Date(Date.UTC(fromYear, 0, 1));
  while (cursor.getUTCFullYear() <= toYear) {
    yield cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

describe("migration 0052 makes every Subtask end a moment (#423, ADR 0016)", () => {
  it("is journaled, converts then seals, and uses the shared preset literals", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    expect(sql.match(/--> statement-breakpoint/g)).toHaveLength(1);
    expect(sql.match(/ALTER TABLE `project_subtasks` ADD COLUMN/g)).toHaveLength(1);
    expect(sql).not.toMatch(/DROP TABLE|__new_|PRAGMA|INSERT INTO|DELETE FROM|CREATE TRIGGER/i);
    // The literals the SQL writes are exactly the code constants.
    expect(sql).toContain(`'T${SUBTASK_START_PRESET_TIME}'`);
    expect(sql).toContain(`'T${SUBTASK_END_PRESET_TIME}'`);
    expect(sql).toContain(`' ${SUBTASK_START_PRESET_TIME}'`);
    expect(sql).toContain(`' ${SUBTASK_END_PRESET_TIME}'`);
    // The harness that applies migrations splits statements on ";" and drops comment lines, so a ";" in a comment is a trap.
    for (const line of sql.split("\n").filter((value) => value.startsWith("--"))) expect(line, line).not.toContain(";");
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((entry) => entry.idx === 52)?.tag).toBe(MIGRATION.replace(/\.sql$/, ""));
  });

  it("converts a one-day range on every day from 2008 to 2040 exactly as normalizeChecklistSchedule resolves it", () => {
    const db = freshDb(51);
    const all = [...days(2008, 2040)];
    db.exec("BEGIN");
    all.forEach((day, index) => insertLegacyDate(db, `d${String(index).padStart(6, "0")}`, day, day));
    db.exec("COMMIT");
    db.exec(migrationSql(MIGRATION));
    const rows = db.prepare(READ).all() as Stored[];
    expect(rows).toHaveLength(all.length);
    rows.forEach((row, index) => expectMatches(row, all[index]!, all[index]!, 1));
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  }, 120_000);

  it("converts start and end days independently, including across both daylight-saving changes", () => {
    const db = freshDb(51);
    const ranges: Array<[string, string]> = [
      ["2026-04-04", "2026-04-06"], ["2026-04-05", "2026-04-05"], ["2026-10-03", "2026-10-05"], ["2026-10-04", "2026-10-04"],
      ["2026-03-30", "2026-10-30"], ["2008-04-06", "2008-10-05"], ["2024-02-29", "2024-03-01"], ["2040-12-31", "2040-12-31"],
    ];
    ranges.forEach(([start, end], index) => insertLegacyDate(db, `r${index}`, start, end));
    db.exec(migrationSql(MIGRATION));
    const rows = db.prepare(READ).all() as Stored[];
    ranges.forEach(([start, end], index) => expectMatches(rows.find((row) => row.id === `r${index}`)!, start, end, 1));
    db.close();
  });

  it("lands the documented anchors: autumn 2026-04-05 at +600 and spring 2026-10-04 at +660, fold 0", () => {
    const db = freshDb(51);
    insertLegacyDate(db, "autumn", "2026-04-05", "2026-04-05");
    insertLegacyDate(db, "spring", "2026-10-04", "2026-10-04");
    db.exec(migrationSql(MIGRATION));
    const byId = Object.fromEntries((db.prepare(READ).all() as Stored[]).map((row) => [row.id, row]));
    expect(new Date(byId.autumn!.schedule_start_at).toISOString()).toBe("2026-04-04T23:00:00.000Z");
    expect(new Date(byId.autumn!.schedule_end_at).toISOString()).toBe("2026-04-05T07:00:00.000Z");
    expect([byId.autumn!.schedule_start_utc_offset_minutes, byId.autumn!.schedule_end_utc_offset_minutes]).toEqual([600, 600]);
    expect(new Date(byId.spring!.schedule_start_at).toISOString()).toBe("2026-10-03T22:00:00.000Z");
    expect(new Date(byId.spring!.schedule_end_at).toISOString()).toBe("2026-10-04T06:00:00.000Z");
    expect([byId.spring!.schedule_start_utc_offset_minutes, byId.spring!.schedule_end_utc_offset_minutes]).toEqual([660, 660]);
    expect([byId.autumn!.schedule_start_fold, byId.autumn!.schedule_end_fold, byId.spring!.schedule_start_fold, byId.spring!.schedule_end_fold]).toEqual([0, 0, 0, 0]);
    db.close();
  });

  it("converts completed Subtasks, bumps schedule_version by one, and leaves reminders, updated_at, timed rows and counts alone", () => {
    const db = freshDb(51);
    insertLegacyDate(db, "open", "2026-08-27", "2026-08-28", { version: 3, reminderSentAt: NOW });
    insertLegacyDate(db, "done", "2026-08-29", "2026-08-30", { done: 1, version: 7 });
    insertTimed(db, "timed", "2026-08-30T08:00", "2026-08-30T09:15", 5);
    const timedBefore = db.prepare("SELECT * FROM project_subtasks WHERE id = 'timed'").get();
    db.exec(migrationSql(MIGRATION));
    const rows = db.prepare(READ).all() as Stored[];
    expect(rows).toHaveLength(3);
    expectMatches(rows.find((row) => row.id === "open")!, "2026-08-27", "2026-08-28", 3);
    expectMatches(rows.find((row) => row.id === "done")!, "2026-08-29", "2026-08-30", 7);
    expect(db.prepare("SELECT due_reminder_sent_at, updated_at, done FROM project_subtasks WHERE id = 'open'").get()).toEqual({ due_reminder_sent_at: NOW, updated_at: NOW, done: 0 });
    expect(db.prepare("SELECT updated_at, done FROM project_subtasks WHERE id = 'done'").get()).toEqual({ updated_at: NOW, done: 1 });
    const timedAfter = db.prepare("SELECT * FROM project_subtasks WHERE id = 'timed'").get() as Record<string, unknown>;
    expect(timedAfter).toMatchObject({ ...(timedBefore as Record<string, unknown>), schedule_timed_required: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM project_activity_events").get()).toEqual({ n: 0 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    db.close();
  });

  it("a second conversion pass changes nothing", () => {
    const db = freshDb(51);
    insertLegacyDate(db, "a", "2026-08-27", "2026-08-28");
    db.exec(migrationSql(MIGRATION));
    const before = db.prepare(READ).all();
    const update = migrationSql(MIGRATION).split("ALTER TABLE")[0]!;
    expect(db.prepare(update.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim().replace(/;$/, "")).run().changes).toBe(0);
    expect(db.prepare(READ).all()).toEqual(before);
    db.close();
  });

  it("refuses to apply over a malformed date, leaving the table untouched and the marker absent", () => {
    const db = freshDb(51);
    insertLegacyDate(db, "good", "2026-08-27", "2026-08-28");
    insertLegacyDate(db, "bad", "2026-08-1", "2026-08-2");
    const before = db.prepare(READ).all();
    expect(() => db.exec(migrationSql(MIGRATION))).toThrow(CHECK_FAILED);
    expect(db.prepare(READ).all()).toEqual(before);
    expect(db.prepare("SELECT name FROM pragma_table_info('project_subtasks') WHERE name = 'schedule_timed_required'").all()).toEqual([]);
    db.close();
  });

  it("rolls the whole file back when the UPDATE succeeds and the later ALTER fails", () => {
    const db = freshDb(51);
    insertLegacyDate(db, "open", "2026-08-27", "2026-08-28", { version: 3, reminderSentAt: NOW });
    insertLegacyDate(db, "done", "2026-08-29", "2026-08-30", { done: 1, version: 7 });
    // The marker column already exists, so the file's ALTER ... ADD COLUMN fails AFTER step 1 converted both rows.
    db.exec("ALTER TABLE project_subtasks ADD COLUMN schedule_timed_required integer");
    const before = db.prepare("SELECT * FROM project_subtasks ORDER BY id").all();
    expect(() => applyAsTransaction(db, MIGRATION)).toThrow(/duplicate column name/i);
    expect(db.prepare("SELECT * FROM project_subtasks ORDER BY id").all()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM project_subtasks WHERE schedule_start_kind = 'date'").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM project_subtasks WHERE schedule_start_kind = 'timed'").get()).toEqual({ n: 0 });
    // The UPDATE alone would have converted them: the rollback, not a no-op UPDATE, is what kept them date-only.
    db.exec("BEGIN");
    const converted = db.prepare(migrationSql(MIGRATION).split("ALTER TABLE")[0]!.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim().replace(/;$/, "")).run().changes;
    db.exec("ROLLBACK");
    expect(Number(converted)).toBe(2);
    db.close();
  });

  it("applies as one transaction when nothing fails", () => {
    const db = freshDb(51);
    insertLegacyDate(db, "a", "2026-08-27", "2026-08-28");
    applyAsTransaction(db, MIGRATION);
    expect(db.prepare("SELECT COUNT(*) AS n FROM project_subtasks WHERE schedule_start_kind = 'timed'").get()).toEqual({ n: 1 });
    db.close();
  });

  it("applies cleanly over an empty table and adds the marker column", () => {
    const db = freshDb(51);
    db.exec(migrationSql(MIGRATION));
    expect(db.prepare("SELECT name, \"notnull\" AS nn, dflt_value FROM pragma_table_info('project_subtasks') WHERE name = 'schedule_timed_required'").get()).toEqual({ name: "schedule_timed_required", nn: 1, dflt_value: "1" });
    db.close();
  });

  it("afterwards refuses a date-only row on insert and on update, and refuses to write the marker", () => {
    const db = freshDb(52);
    expect(() => insertLegacyDate(db, "x", "2026-08-27", "2026-08-28")).toThrow(CHECK_FAILED);
    insertTimed(db, "ok", "2026-08-27T09:00", "2026-08-27T17:00");
    expect(db.prepare("UPDATE project_subtasks SET title = 'renamed', due_reminder_sent_at = ? WHERE id = 'ok'").run(NOW).changes).toBe(1);
    expect(() => db.prepare("UPDATE project_subtasks SET schedule_start_kind = 'date', schedule_end_kind = 'date' WHERE id = 'ok'").run()).toThrow(CHECK_FAILED);
    expect(() => db.prepare("UPDATE project_subtasks SET schedule_end_kind = NULL WHERE id = 'ok'").run()).toThrow(CHECK_FAILED);
    expect(() => db.prepare("UPDATE project_subtasks SET schedule_timed_required = 0 WHERE id = 'ok'").run()).toThrow(CHECK_FAILED);
    db.close();
  });

  it("rollback is a forward DROP COLUMN, after which a date row inserts again and timed data stays", () => {
    const db = freshDb(52);
    insertTimed(db, "ok", "2026-08-27T09:00", "2026-08-27T17:00");
    expect(() => insertLegacyDate(db, "x", "2026-08-27", "2026-08-28")).toThrow(CHECK_FAILED);
    db.exec("ALTER TABLE project_subtasks DROP COLUMN schedule_timed_required");
    expect(() => insertLegacyDate(db, "x", "2026-08-27", "2026-08-28")).not.toThrow();
    expect(db.prepare("SELECT schedule_start_kind AS k FROM project_subtasks WHERE id = 'ok'").get()).toEqual({ k: "timed" });
    db.close();
  });

  it("trap: while the marker exists, dropping a kind column fails (drop the marker first)", () => {
    for (const column of ["schedule_start_kind", "schedule_end_kind"]) {
      const db = freshDb(52);
      expect(() => db.exec(`ALTER TABLE project_subtasks DROP COLUMN ${column}`), column).toThrow();
      db.close();
    }
  });
});
