import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeChecklistSchedule } from "@quincy/shared";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => unknown };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0049_project_subtask_assignees_resync.sql";
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

const VERIFY_SQL = readFileSync(new URL("./subtask-assignees-verify.fixture.sql", import.meta.url), "utf8").split("\n").filter((line) => !line.startsWith("--")).join("\n");

const range = normalizeChecklistSchedule({ state: "range", start: { kind: "date", localCivil: "2026-08-27" }, end: { kind: "date", localCivil: "2026-08-28" } }, 1);
if (!range.ok) throw new Error("fixture schedule invalid");
const S = range.value;

function insertSubtask(db: SqliteDatabase, id: string, assigneeId: string | null, version: number, updatedAt: number): void {
  db.prepare(
    "INSERT INTO project_subtasks (id, project_id, title, done, position, assignee_id, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, 'p1', 't', 0, 1024, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'u1', ?, ?)",
  ).run(id, assigneeId, version, S.dueDate, S.scheduleStartKind, S.scheduleStartCivil, S.scheduleStartAt, S.scheduleStartUtcOffsetMinutes, S.scheduleStartFold, S.scheduleEndKind, S.scheduleEndAt, S.scheduleEndUtcOffsetMinutes, S.scheduleEndFold, S.scheduleZone, S.scheduleVersion, NOW, updatedAt);
}

function insertRelation(db: SqliteDatabase, subtaskId: string, userId: string, version: number, addedAt: number): void {
  db.prepare("INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at) VALUES (?, ?, ?, ?)").run(subtaskId, userId, version, addedAt);
}

/** Schema 48 with every drift shape 0049 has to heal. */
function seeded(): SqliteDatabase {
  const db = localSqlite();
  db.exec("PRAGMA foreign_keys = ON");
  applyThrough(db, 48);
  for (const id of ["u1", "u2", "u3"]) db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'U', ?, 1, 'editor', 1, ?, ?)").run(id, `${id}@example.test`, NOW, NOW);
  db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('p1', 'Street', 'edited_review', 0, ?, ?)").run(NOW, NOW);
  insertSubtask(db, "missing", "u2", 1, NOW + 1); // assigned, no row
  insertSubtask(db, "reassigned", "u3", 2, NOW + 2); insertRelation(db, "reassigned", "u2", 1, NOW + 20); // column moved on, row is the old assignee
  insertSubtask(db, "stale", "u2", 3, NOW + 3); insertRelation(db, "stale", "u2", 1, NOW + 30); // A->B->A: column A v3, row A v1
  insertSubtask(db, "cleared", null, 2, NOW + 4); insertRelation(db, "cleared", "u3", 1, NOW + 40); // column cleared, row lingers
  insertSubtask(db, "correct", "u2", 1, NOW + 5); insertRelation(db, "correct", "u2", 1, NOW + 50);
  insertSubtask(db, "empty", null, 0, NOW + 6);
  return db;
}

const relation = (db: SqliteDatabase) => db.prepare("SELECT subtask_id, user_id, assignment_version, added_at FROM project_subtask_assignees ORDER BY subtask_id, user_id").all();
const flag = (db: SqliteDatabase) => db.prepare("SELECT enabled, updated_by FROM feature_flags WHERE key = 'subtask_multi_assignee'").get();

describe("migration 0049 re-syncs the assignee relation and seeds the multi-assignee gate off (#368)", () => {
  it("is additive: no PRAGMA, no trigger, no UPDATE, no rebuild; journaled after 0048 without a snapshot", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8").split("\n").filter((line) => !line.startsWith("--")).join("\n");
    expect(sql).not.toMatch(/DROP TABLE|__new_|PRAGMA|CREATE TRIGGER|\bUPDATE\b|CREATE TABLE/i);
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((value) => value.idx === 49);
    expect(entry?.tag).toBe("0049_project_subtask_assignees_resync");
    expect(entry!.when).toBeGreaterThan(journal.entries.find((value) => value.idx === 48)!.when);
  });

  it("makes the relation the exact projection of the column, keeping a correct row's added_at", () => {
    const db = seeded();
    expect(db.prepare(VERIFY_SQL).get()).not.toEqual({ mismatches: 0 });
    const before = db.prepare("SELECT * FROM project_subtasks ORDER BY id").all();
    db.exec(migrationSql(MIGRATION));
    expect(relation(db)).toEqual([
      { subtask_id: "correct", user_id: "u2", assignment_version: 1, added_at: NOW + 50 },
      { subtask_id: "missing", user_id: "u2", assignment_version: 1, added_at: NOW + 1 },
      { subtask_id: "reassigned", user_id: "u3", assignment_version: 2, added_at: NOW + 2 },
      { subtask_id: "stale", user_id: "u2", assignment_version: 3, added_at: NOW + 3 },
    ]);
    expect(db.prepare(VERIFY_SQL).get()).toEqual({ mismatches: 0 });
    expect(db.prepare("SELECT * FROM project_subtasks ORDER BY id").all()).toEqual(before);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    db.close();
  });

  it("seeds subtask_multi_assignee off, and never re-asserts an operator-owned value", () => {
    const db = seeded();
    db.exec(migrationSql(MIGRATION));
    expect(flag(db)).toEqual({ enabled: 0, updated_by: null });
    db.close();

    const flipped = seeded();
    flipped.prepare("INSERT INTO feature_flags (key, enabled, updated_by, updated_at) VALUES ('subtask_multi_assignee', 1, NULL, ?)").run(NOW);
    flipped.exec(migrationSql(MIGRATION));
    expect(flag(flipped)).toEqual({ enabled: 1, updated_by: null });
    flipped.close();
  });
});
