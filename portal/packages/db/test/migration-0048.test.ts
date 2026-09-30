import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeChecklistSchedule } from "@quincy/shared";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => unknown };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0048_project_subtask_assignees.sql";
const NOW = 1_787_000_000_000;

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

/** The post-apply verify, as the operator runs it: comments stripped, `--command`. */
const VERIFY_SQL = readFileSync(new URL("../../../scripts/subtask-assignees-verify.sql", import.meta.url), "utf8").split("\n").filter((line) => !line.startsWith("--")).join("\n");

const range = normalizeChecklistSchedule({ state: "range", start: { kind: "date", localCivil: "2026-08-27" }, end: { kind: "date", localCivil: "2026-08-28" } }, 1);
if (!range.ok) throw new Error("fixture schedule invalid");
const S = range.value;

function insertSubtask(db: SqliteDatabase, id: string, assigneeId: string | null, version: number, updatedAt: number): void {
  db.prepare(
    "INSERT INTO project_subtasks (id, project_id, title, done, position, assignee_id, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, 'p1', 't', 0, 1024, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'u1', ?, ?)",
  ).run(id, assigneeId, version, S.dueDate, S.scheduleStartKind, S.scheduleStartCivil, S.scheduleStartAt, S.scheduleStartUtcOffsetMinutes, S.scheduleStartFold, S.scheduleEndKind, S.scheduleEndAt, S.scheduleEndUtcOffsetMinutes, S.scheduleEndFold, S.scheduleZone, S.scheduleVersion, NOW, updatedAt);
}

function seeded(): SqliteDatabase {
  const db = localSqlite();
  db.exec("PRAGMA foreign_keys = ON");
  applyThrough(db, 47);
  for (const id of ["u1", "u2", "u3"]) db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'U', ?, 1, 'editor', 1, ?, ?)").run(id, `${id}@example.test`, NOW, NOW);
  db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('p1', 'Street', 'edited_review', 0, ?, ?)").run(NOW, NOW);
  insertSubtask(db, "A", "u2", 1, NOW + 1);
  insertSubtask(db, "B", "u3", 3, NOW + 2);
  insertSubtask(db, "C", "u2", 0, NOW + 3);
  insertSubtask(db, "D", null, 0, NOW + 4);
  insertSubtask(db, "E", null, 2, NOW + 5);
  return db;
}

const relation = (db: SqliteDatabase) => db.prepare("SELECT subtask_id, user_id, assignment_version, added_at FROM project_subtask_assignees ORDER BY subtask_id, user_id").all();

describe("migration 0048 creates the Subtask assignee relation and backfills it (#364)", () => {
  it("is additive: no rebuild, no PRAGMA, no trigger, no UPDATE; journaled after 0047 without a snapshot", () => {
    // Comments are prose (they name "PRAGMA" and "updated_at"), so the static check reads statements only.
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8").split("\n").filter((line) => !line.startsWith("--")).join("\n");
    expect(sql).not.toMatch(/DROP TABLE|__new_|PRAGMA|CREATE TRIGGER|\bUPDATE\b/i);
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(1);
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((value) => value.idx === 48);
    expect(entry?.tag).toBe("0048_project_subtask_assignees");
    expect(entry!.when).toBeGreaterThan(journal.entries.find((value) => value.idx === 47)!.when);
  });

  it("backfills exactly one row per assigned Subtask, whatever its version, and leaves project_subtasks byte-identical", () => {
    const db = seeded();
    const before = db.prepare("SELECT * FROM project_subtasks ORDER BY id").all();
    db.exec(migrationSql(MIGRATION));
    expect(relation(db)).toEqual([
      { subtask_id: "A", user_id: "u2", assignment_version: 1, added_at: NOW + 1 },
      { subtask_id: "B", user_id: "u3", assignment_version: 3, added_at: NOW + 2 },
      { subtask_id: "C", user_id: "u2", assignment_version: 0, added_at: NOW + 3 },
    ]);
    expect(db.prepare("SELECT * FROM project_subtasks ORDER BY id").all()).toEqual(before);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    expect(db.prepare(VERIFY_SQL).get()).toEqual({ mismatches: 0 });
    db.close();
  });

  it("enforces the primary key, the user foreign key, and the version check", () => {
    const db = seeded();
    db.exec(migrationSql(MIGRATION));
    expect(() => db.prepare("INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at) VALUES ('A', 'u2', 1, ?)").run(NOW)).toThrow(/UNIQUE|PRIMARY/i);
    expect(() => db.prepare("INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at) VALUES ('A', 'ghost', 1, ?)").run(NOW)).toThrow(/FOREIGN KEY/i);
    expect(() => db.prepare("INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at) VALUES ('D', 'u1', -1, ?)").run(NOW)).toThrow(/CHECK/i);
    expect(() => db.prepare("INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at) VALUES ('D', 'u1', 1.5, ?)").run(NOW)).toThrow(/CHECK/i);
    expect(() => db.prepare("INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at) VALUES ('D', 'u1', 0, ?)").run(NOW)).not.toThrow();
    db.close();
  });

  it("cascades: deleting a Subtask removes its row, deleting a user removes theirs and nulls the column", () => {
    const db = seeded();
    db.exec(migrationSql(MIGRATION));
    db.prepare("DELETE FROM project_subtasks WHERE id = 'A'").run();
    expect(relation(db).map((row) => (row as { subtask_id: string }).subtask_id)).toEqual(["B", "C"]);
    db.prepare("DELETE FROM user WHERE id = 'u3'").run();
    expect(relation(db).map((row) => (row as { subtask_id: string }).subtask_id)).toEqual(["C"]);
    expect(db.prepare("SELECT assignee_id FROM project_subtasks WHERE id = 'B'").get()).toEqual({ assignee_id: null });
    db.close();
  });

  it("the verify script reports drift", () => {
    const db = seeded();
    db.exec(migrationSql(MIGRATION));
    db.prepare("DELETE FROM project_subtask_assignees WHERE subtask_id = 'A'").run();
    expect(db.prepare(VERIFY_SQL).get()).toEqual({ mismatches: 1 });
    db.prepare("INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at) VALUES ('D', 'u1', 0, ?)").run(NOW);
    expect(db.prepare(VERIFY_SQL).get()).toEqual({ mismatches: 2 });
    db.close();
  });
});
