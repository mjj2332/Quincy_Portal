import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeChecklistSchedule, type NormalizedChecklistSchedule } from "@quincy/shared";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => unknown };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0047_project_subtasks_require_range.sql";
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

function applyThrough(db: SqliteDatabase, through: number): void {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value) && Number(value.slice(0, 4)) <= through).sort()) db.exec(migrationSql(name));
}

/** The pre-merge production verify, as the operator runs it: comments stripped, `--command`. */
const VERIFY_SQL = readFileSync(new URL("../../../scripts/subtask-range-backfill-verify.sql", import.meta.url), "utf8").split("\n").filter((line) => !line.startsWith("--")).join("\n");

function freshDb(through: number): SqliteDatabase {
  const db = localSqlite();
  db.exec("PRAGMA foreign_keys = ON");
  applyThrough(db, through);
  db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u@example.test', 1, 'editor', 1, ?, ?)").run(NOW, NOW);
  db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('p1', 'Street', 'edited_review', 0, ?, ?)").run(NOW, NOW);
  return db;
}

type Row = Record<string, unknown>;
const COLUMNS = ["due_date", "schedule_start_kind", "schedule_start_civil", "schedule_start_at", "schedule_start_utc_offset_minutes", "schedule_start_fold", "schedule_end_kind", "schedule_end_at", "schedule_end_utc_offset_minutes", "schedule_end_fold", "schedule_zone", "schedule_version"] as const;

function insertRow(db: SqliteDatabase, id: string, overrides: Row): void {
  const values: Row = { due_date: null, schedule_start_kind: null, schedule_start_civil: null, schedule_start_at: null, schedule_start_utc_offset_minutes: null, schedule_start_fold: null, schedule_end_kind: null, schedule_end_at: null, schedule_end_utc_offset_minutes: null, schedule_end_fold: null, schedule_zone: null, schedule_version: 0, ...overrides };
  db.prepare(`INSERT INTO project_subtasks (id, project_id, title, done, position, ${COLUMNS.join(", ")}, created_by, created_at, updated_at) VALUES (?, 'p1', 't', 0, 1024, ${COLUMNS.map(() => "?").join(", ")}, 'u1', ?, ?)`).run(id, ...COLUMNS.map((column) => values[column]), NOW, NOW);
}

function storageRow(schedule: NormalizedChecklistSchedule): Row {
  return { due_date: schedule.dueDate, schedule_start_kind: schedule.scheduleStartKind, schedule_start_civil: schedule.scheduleStartCivil, schedule_start_at: schedule.scheduleStartAt, schedule_start_utc_offset_minutes: schedule.scheduleStartUtcOffsetMinutes, schedule_start_fold: schedule.scheduleStartFold, schedule_end_kind: schedule.scheduleEndKind, schedule_end_at: schedule.scheduleEndAt, schedule_end_utc_offset_minutes: schedule.scheduleEndUtcOffsetMinutes, schedule_end_fold: schedule.scheduleEndFold, schedule_zone: schedule.scheduleZone, schedule_version: schedule.scheduleVersion };
}

function normalized(input: { start: string; end: string }): NormalizedChecklistSchedule {
  const result = normalizeChecklistSchedule({ state: "range", start: { localCivil: input.start }, end: { localCivil: input.end } }, 1);
  if (!result.ok) throw new Error("fixture schedule invalid");
  return result.value;
}

/** A legacy date-only range exactly as the pre-0052 writer stored it. Historical migration tests keep this explicit shape: the shared normalizer is timed-only now (ADR 0016). */
function legacyDate(start: string, end: string): NormalizedChecklistSchedule {
  return {
    state: "range", startChanged: true, endChanged: true, dueDate: end, scheduleStartKind: "date", scheduleStartCivil: start, scheduleStartAt: null, scheduleStartUtcOffsetMinutes: null, scheduleStartFold: null,
    scheduleEndKind: "date", scheduleEndAt: null, scheduleEndUtcOffsetMinutes: null, scheduleEndFold: null, scheduleZone: "Australia/Sydney", scheduleVersion: 1,
  };
}

const DATE_RANGE = legacyDate("2026-08-27", "2026-08-28");
const ONE_DAY = legacyDate("2026-08-29", "2026-08-29");
const TIMED_RANGE = normalized({ start: "2026-08-30T08:00", end: "2026-08-30T09:15" });

const validDate = (): Row => storageRow(DATE_RANGE);
const validTimed = (): Row => storageRow(TIMED_RANGE);

/** Every shape the parity matrix covers: a name, the row, and whether the range predicate accepts it. */
const SHAPES: Array<{ name: string; row: Row; complete: boolean }> = [
  { name: "date range", row: validDate(), complete: true },
  { name: "one-day date range", row: storageRow(ONE_DAY), complete: true },
  { name: "timed range", row: validTimed(), complete: true },
  { name: "unscheduled v0", row: {}, complete: false },
  { name: "unscheduled v1", row: { schedule_version: 1 }, complete: false },
  { name: "due-only date v0", row: { due_date: "2026-08-27" }, complete: false },
  { name: "due-only date v1", row: { due_date: "2026-08-27", schedule_version: 1 }, complete: false },
  { name: "due-only timed v1", row: { due_date: "2026-08-27T09:00", schedule_version: 1 }, complete: false },
  { name: "mixed kinds", row: { ...validDate(), schedule_end_kind: "timed" }, complete: false },
  { name: "inverted date range", row: { ...validDate(), schedule_start_civil: "2026-08-29" }, complete: false },
  { name: "timed start equals end", row: { ...validTimed(), schedule_end_at: TIMED_RANGE.scheduleStartAt }, complete: false },
  { name: "timed start after end", row: { ...validTimed(), schedule_start_at: (TIMED_RANGE.scheduleEndAt as number) + 1 }, complete: false },
  { name: "zone NULL", row: { ...validDate(), schedule_zone: null }, complete: false },
  { name: "version 0 carrying a full range", row: { ...validDate(), schedule_version: 0 }, complete: false },
  { name: "date range with a stray start instant", row: { ...validDate(), schedule_start_at: 1 }, complete: false },
  { name: "date range with a stray end fold", row: { ...validDate(), schedule_end_fold: 0 }, complete: false },
  { name: "timed range missing a fold", row: { ...validTimed(), schedule_end_fold: null }, complete: false },
  { name: "timed range missing an offset", row: { ...validTimed(), schedule_start_utc_offset_minutes: null }, complete: false },
  { name: "timed range missing the end instant", row: { ...validTimed(), schedule_end_at: null }, complete: false },
  { name: "range missing its start civil", row: { ...validDate(), schedule_start_civil: null }, complete: false },
  { name: "range missing its due date", row: { ...validDate(), due_date: null }, complete: false },
  { name: "range missing its end kind", row: { ...validDate(), schedule_end_kind: null }, complete: false },
];

describe("migration 0047 requires every Subtask to have a range (#343)", () => {
  it("is one additive ALTER: no rebuild, no data statements, journaled without a snapshot", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    expect(sql.match(/ALTER TABLE `project_subtasks` ADD COLUMN/g)).toHaveLength(1);
    expect(sql).not.toMatch(/DROP TABLE|__new_|PRAGMA|INSERT INTO|UPDATE\s+`?project_subtasks|DELETE FROM|CREATE TRIGGER/i);
    expect(sql).toMatch(/COALESCE\(/);
    expect(sql).not.toContain("--> statement-breakpoint");
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((entry) => entry.idx === 47)?.tag).toBe(MIGRATION.replace(/\.sql$/, ""));
  });

  it("refuses to apply while a range-less row exists, and leaves the table untouched", () => {
    const db = freshDb(46);
    insertRow(db, "bad", {});
    expect(() => db.exec(migrationSql(MIGRATION))).toThrow(CHECK_FAILED);
    expect(db.prepare("SELECT name FROM pragma_table_info('project_subtasks') WHERE name = 'schedule_range_required'").all()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM project_subtasks").get()).toEqual({ n: 1 });
    db.close();
  });

  it("applies over a clean database, preserving rows and foreign keys", () => {
    const db = freshDb(46);
    insertRow(db, "date", validDate());
    insertRow(db, "timed", validTimed());
    const before = db.prepare("SELECT id, project_id, title, due_date, schedule_start_at, schedule_end_at, created_by FROM project_subtasks ORDER BY id").all();
    db.exec(migrationSql(MIGRATION));
    expect(db.prepare("SELECT id, project_id, title, due_date, schedule_start_at, schedule_end_at, created_by FROM project_subtasks ORDER BY id").all()).toEqual(before);
    expect(db.prepare("SELECT name, \"notnull\" AS nn, dflt_value FROM pragma_table_info('project_subtasks') WHERE name = 'schedule_range_required'").get()).toEqual({ name: "schedule_range_required", nn: 1, dflt_value: "1" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    db.close();
  });

  it("accepts a date range and a timed range on insert, and an in-place range edit", () => {
    const db = freshDb(47);
    insertRow(db, "date", validDate());
    insertRow(db, "timed", validTimed());
    expect(() => db.prepare("UPDATE project_subtasks SET title = 'renamed', position = 2048, assignee_id = 'u1', due_reminder_sent_at = ? WHERE id = 'date'").run(NOW)).not.toThrow();
    db.close();
  });

  it("rejects every incomplete shape on INSERT and on UPDATE", () => {
    for (const shape of SHAPES.filter((s) => !s.complete)) {
      const db = freshDb(47);
      expect(() => insertRow(db, "x", shape.row), `insert: ${shape.name}`).toThrow(CHECK_FAILED);
      // UPDATE: start from a valid row and move it into the incomplete shape.
      insertRow(db, "ok", validDate());
      const sets = COLUMNS.map((column) => `${column} = ?`).join(", ");
      const target = { due_date: null, schedule_start_kind: null, schedule_start_civil: null, schedule_start_at: null, schedule_start_utc_offset_minutes: null, schedule_start_fold: null, schedule_end_kind: null, schedule_end_at: null, schedule_end_utc_offset_minutes: null, schedule_end_fold: null, schedule_zone: null, schedule_version: 0, ...shape.row } as Row;
      expect(() => db.prepare(`UPDATE project_subtasks SET ${sets} WHERE id = 'ok'`).run(...COLUMNS.map((column) => target[column])), `update: ${shape.name}`).toThrow(CHECK_FAILED);
      db.close();
    }
  });

  it("rejects clearing a single endpoint field of a valid range", () => {
    for (const column of ["due_date", "schedule_start_kind", "schedule_start_civil", "schedule_end_kind", "schedule_zone"]) {
      const db = freshDb(47);
      insertRow(db, "ok", validDate());
      expect(() => db.prepare(`UPDATE project_subtasks SET ${column} = NULL WHERE id = 'ok'`).run(), column).toThrow(CHECK_FAILED);
      db.close();
    }
  });

  it("refuses to write the marker column to anything but 1", () => {
    const db = freshDb(47);
    insertRow(db, "ok", validDate());
    expect(() => db.prepare("UPDATE project_subtasks SET schedule_range_required = 0 WHERE id = 'ok'").run()).toThrow(CHECK_FAILED);
    expect(() => db.prepare("UPDATE project_subtasks SET schedule_range_required = NULL WHERE id = 'ok'").run()).toThrow();
    db.close();
  });

  it("parity: the rows the pre-merge verify SQL counts are exactly the rows the constraint rejects", () => {
    for (const shape of SHAPES) {
      const before = freshDb(46);
      insertRow(before, "x", shape.row);
      const counted = (before.prepare(VERIFY_SQL).get() as { without_complete_range: number }).without_complete_range;
      before.close();

      const after = freshDb(47);
      let rejected = 0;
      try { insertRow(after, "x", shape.row); } catch (error) { if (!CHECK_FAILED.test(String(error))) throw error; rejected = 1; }
      after.close();

      expect(rejected, `${shape.name}: constraint vs verify`).toBe(counted);
      expect(counted, `${shape.name}: expected completeness`).toBe(shape.complete ? 0 : 1);
    }
  });

  it("parity: verify = 0 guarantees 0047 applies, and verify > 0 means it refuses", () => {
    for (const shape of SHAPES) {
      const db = freshDb(46);
      insertRow(db, "x", shape.row);
      const counted = (db.prepare(VERIFY_SQL).get() as { without_complete_range: number }).without_complete_range;
      let applied = true;
      try { db.exec(migrationSql(MIGRATION)); } catch (error) { if (!CHECK_FAILED.test(String(error))) throw error; applied = false; }
      db.close();
      expect(applied, shape.name).toBe(counted === 0);
    }
  });

  it("rollback is a forward DROP COLUMN, after which a range-less insert works again", () => {
    const db = freshDb(47);
    expect(() => insertRow(db, "bad", {})).toThrow(CHECK_FAILED);
    db.exec("ALTER TABLE project_subtasks DROP COLUMN schedule_range_required");
    expect(() => insertRow(db, "bad", {})).not.toThrow();
    db.close();
  });

  it("trap: while the marker exists, dropping a schedule column or due_date fails (drop the marker first)", () => {
    for (const column of ["due_date", "schedule_start_at", "schedule_zone"]) {
      const db = freshDb(47);
      expect(() => db.exec(`ALTER TABLE project_subtasks DROP COLUMN ${column}`), column).toThrow();
      db.close();
    }
  });
});
