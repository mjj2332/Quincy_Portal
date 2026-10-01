import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => unknown };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0050_drop_subtask_assignee_column.sql";
const NOW = 1_787_000_000_000;
const FLAG = "subtask_multi_assignee";

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

/** A legacy date-only range exactly as the pre-0052 writer stored it (civil dates, no instants). Historical migration tests keep this explicit shape: the shared normalizer is timed-only now (ADR 0016). */
const S = {
  dueDate: "2026-08-28", scheduleStartKind: "date", scheduleStartCivil: "2026-08-27", scheduleStartAt: null, scheduleStartUtcOffsetMinutes: null, scheduleStartFold: null,
  scheduleEndKind: "date", scheduleEndAt: null, scheduleEndUtcOffsetMinutes: null, scheduleEndFold: null, scheduleZone: "Australia/Sydney", scheduleVersion: 1,
} as const;

function insertSubtask(db: SqliteDatabase, id: string, assigneeId: string | null, version: number, updatedAt: number): void {
  db.prepare(
    "INSERT INTO project_subtasks (id, project_id, title, done, position, assignee_id, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, 'p1', ?, 0, 1024, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'u1', ?, ?)",
  ).run(id, `title ${id}`, assigneeId, version, S.dueDate, S.scheduleStartKind, S.scheduleStartCivil, S.scheduleStartAt, S.scheduleStartUtcOffsetMinutes, S.scheduleStartFold, S.scheduleEndKind, S.scheduleEndAt, S.scheduleEndUtcOffsetMinutes, S.scheduleEndFold, S.scheduleZone, S.scheduleVersion, NOW, updatedAt);
}

function insertRelation(db: SqliteDatabase, subtaskId: string, userId: string, version: number, addedAt: number): void {
  db.prepare("INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at) VALUES (?, ?, ?, ?)").run(subtaskId, userId, version, addedAt);
}

/** Schema 49 with every assignee shape the column and the relation can be in. */
function seeded(flag: "enabled" | "disabled" | "absent" = "enabled"): SqliteDatabase {
  const db = localSqlite();
  db.exec("PRAGMA foreign_keys = ON");
  applyThrough(db, 49);
  for (const id of ["u1", "u2", "u3"]) db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'U', ?, 1, 'editor', 1, ?, ?)").run(id, `${id}@example.test`, NOW, NOW);
  db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('p1', 'Street', 'edited_review', 0, ?, ?)").run(NOW, NOW);
  insertSubtask(db, "unassigned", null, 0, NOW + 1);
  insertSubtask(db, "single", "u2", 1, NOW + 2); insertRelation(db, "single", "u2", 1, NOW + 20);
  insertSubtask(db, "multi", "u2", 4, NOW + 3); insertRelation(db, "multi", "u2", 2, NOW + 30); insertRelation(db, "multi", "u3", 4, NOW + 31);
  insertSubtask(db, "stale", "u3", 2, NOW + 4); insertRelation(db, "stale", "u2", 1, NOW + 40); // column value differs from the relation
  insertSubtask(db, "relation-only", null, 3, NOW + 5); insertRelation(db, "relation-only", "u3", 3, NOW + 50); // column NULL, relation row present
  db.prepare("DELETE FROM feature_flags WHERE key = ?").run(FLAG);
  if (flag !== "absent") db.prepare("INSERT INTO feature_flags (key, enabled, updated_by, updated_at) VALUES (?, ?, NULL, ?)").run(FLAG, flag === "enabled" ? 1 : 0, NOW);
  db.prepare("INSERT INTO feature_flags (key, enabled, updated_by, updated_at) VALUES ('unrelated_flag', 1, NULL, ?)").run(NOW);
  return db;
}

type Row = Record<string, unknown>;
const columnNames = (db: SqliteDatabase): string[] => (db.prepare("SELECT name FROM pragma_table_info('project_subtasks')").all() as Array<{ name: string }>).map((row) => row.name);
const relation = (db: SqliteDatabase) => db.prepare("SELECT * FROM project_subtask_assignees ORDER BY subtask_id, user_id").all();
const indexNames = (db: SqliteDatabase): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'project_subtasks' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
const flagRow = (db: SqliteDatabase, key: string) => db.prepare("SELECT key, enabled FROM feature_flags WHERE key = ?").get(key);

function subtasksWithout(db: SqliteDatabase, dropped: string): Row[] {
  return (db.prepare("SELECT * FROM project_subtasks ORDER BY id").all() as Row[]).map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== dropped)));
}

describe("migration 0050 drops project_subtasks.assignee_id (#373 part 2, ADR 0012 contract step)", () => {
  it("is journaled after 0049", () => {
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((value) => value.idx === 50);
    expect(entry?.tag).toBe("0050_drop_subtask_assignee_column");
    expect(entry!.when).toBeGreaterThan(journal.entries.find((value) => value.idx === 49)!.when);
    expect(journal.entries.at(-1)?.idx).toBeGreaterThanOrEqual(50);
  });

  it("removes the column and its index, and keeps every other Subtask column, row and index", () => {
    const db = seeded();
    expect(columnNames(db)).toContain("assignee_id");
    expect(indexNames(db)).toContain("project_subtasks_assignee_idx");
    const beforeRows = subtasksWithout(db, "assignee_id");
    const beforeColumns = columnNames(db).filter((name) => name !== "assignee_id");
    const beforeIndexes = indexNames(db).filter((name) => name !== "project_subtasks_assignee_idx");
    db.exec(migrationSql(MIGRATION));
    expect(columnNames(db)).not.toContain("assignee_id");
    expect(columnNames(db)).toEqual(beforeColumns);
    expect(indexNames(db)).not.toContain("project_subtasks_assignee_idx");
    expect(indexNames(db)).toEqual(beforeIndexes);
    expect(beforeIndexes).toContain("project_subtasks_project_position_idx");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE sql LIKE '%assignee_id%'").all()).toEqual([]);
    expect(subtasksWithout(db, "assignee_id")).toEqual(beforeRows);
    expect(beforeRows).toHaveLength(5);
    db.close();
  });

  it("leaves project_subtask_assignees byte-for-byte identical and the database consistent", () => {
    const db = seeded();
    const before = relation(db);
    db.exec(migrationSql(MIGRATION));
    expect(relation(db)).toEqual(before);
    expect(before).toHaveLength(5);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    db.close();
  });

  it("keeps 0047's range CHECK: a range-less UPDATE is still refused", () => {
    const db = seeded();
    db.exec(migrationSql(MIGRATION));
    expect(() => db.prepare("UPDATE project_subtasks SET schedule_start_kind = NULL, schedule_end_kind = NULL WHERE id = 'single'").run()).toThrow();
    expect(() => db.prepare("UPDATE project_subtasks SET title = 'renamed' WHERE id = 'single'").run()).not.toThrow();
    db.close();
  });

  it("keeps the relation's foreign keys: orphans are refused and deletes cascade", () => {
    const db = seeded();
    db.exec(migrationSql(MIGRATION));
    expect(() => insertRelation(db, "no-such-subtask", "u2", 1, NOW)).toThrow();
    expect(() => insertRelation(db, "single", "no-such-user", 1, NOW)).toThrow();
    db.prepare("DELETE FROM project_subtasks WHERE id = 'multi'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM project_subtask_assignees WHERE subtask_id = 'multi'").get()).toEqual({ n: 0 });
    db.prepare("DELETE FROM user WHERE id = 'u3'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM project_subtask_assignees WHERE user_id = 'u3'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM project_subtask_assignees WHERE subtask_id = 'single'").get()).toEqual({ n: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it.each(["enabled", "disabled"] as const)("deletes the subtask_multi_assignee flag row when it is %s, leaving other flags alone", (state) => {
    const db = seeded(state);
    expect(flagRow(db, FLAG)).toBeDefined();
    db.exec(migrationSql(MIGRATION));
    expect(flagRow(db, FLAG)).toBeUndefined();
    expect(flagRow(db, "unrelated_flag")).toEqual({ key: "unrelated_flag", enabled: 1 });
    db.close();
  });

  it("applies cleanly when the flag row is absent", () => {
    const db = seeded("absent");
    expect(flagRow(db, FLAG)).toBeUndefined();
    db.exec(migrationSql(MIGRATION));
    expect(columnNames(db)).not.toContain("assignee_id");
    expect(flagRow(db, FLAG)).toBeUndefined();
    expect(flagRow(db, "unrelated_flag")).toEqual({ key: "unrelated_flag", enabled: 1 });
    db.close();
  });
});
