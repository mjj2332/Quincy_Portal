import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => unknown };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

function applyThrough(db: SqliteDatabase, through: number): void {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value) && Number(value.slice(0, 4)) <= through).sort()) {
    db.exec(readFileSync(new URL(name, directory), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
}

describe("migration 0035 checklist scheduling ranges", () => {
  it("is strictly additive and preserves existing due dates", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyThrough(db, 34);
    const now = 1_787_000_000_000;
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('tb4d-user', 'TB4D User', 'tb4d@example.test', 1, 'editor', 1, ?, ?)").run(now, now);
    db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('tb4d-project', 'TB4D Street', 'edited_review', 0, ?, ?)").run(now, now);
    db.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, due_date, created_by, created_at, updated_at) VALUES ('tb4d-subtask', 'tb4d-project', 'Existing item', 0, 1024, '2026-08-27', 'tb4d-user', ?, ?)").run(now, now);

    const migration = readFileSync(new URL("../migrations/0035_project_subtask_scheduling_ranges.sql", import.meta.url), "utf8");
    expect(migration.match(/ALTER TABLE project_subtasks ADD COLUMN/g)).toHaveLength(11);
    expect(migration).not.toMatch(/PRAGMA foreign_keys|DROP TABLE|__new_|INSERT INTO|UPDATE\s+project_subtasks|DELETE FROM/i);
    expect(migration).toMatch(/schedule_version INTEGER NOT NULL DEFAULT 0 CHECK/);
    db.exec(migration.replaceAll("--> statement-breakpoint", ""));

    expect(db.prepare("SELECT due_date, schedule_start_kind, schedule_zone, schedule_version FROM project_subtasks WHERE id = 'tb4d-subtask'").get()).toEqual({ due_date: "2026-08-27", schedule_start_kind: null, schedule_zone: null, schedule_version: 0 });
    expect(db.prepare("PRAGMA table_info('project_subtasks')").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "schedule_start_kind", notnull: 0 }),
      expect.objectContaining({ name: "schedule_start_civil", notnull: 0 }),
      expect.objectContaining({ name: "schedule_start_at", notnull: 0 }),
      expect.objectContaining({ name: "schedule_start_utc_offset_minutes", notnull: 0 }),
      expect.objectContaining({ name: "schedule_start_fold", notnull: 0 }),
      expect.objectContaining({ name: "schedule_end_kind", notnull: 0 }),
      expect.objectContaining({ name: "schedule_end_at", notnull: 0 }),
      expect.objectContaining({ name: "schedule_end_utc_offset_minutes", notnull: 0 }),
      expect.objectContaining({ name: "schedule_end_fold", notnull: 0 }),
      expect.objectContaining({ name: "schedule_zone", notnull: 0 }),
      expect.objectContaining({ name: "schedule_version", notnull: 1, dflt_value: "0" }),
    ]));
    expect(() => db.prepare("UPDATE project_subtasks SET schedule_version = -1 WHERE id = 'tb4d-subtask'").run()).toThrow();
    expect(() => db.prepare("UPDATE project_subtasks SET schedule_start_fold = 2 WHERE id = 'tb4d-subtask'").run()).toThrow();
    expect(() => db.prepare("UPDATE project_subtasks SET schedule_zone = 'UTC' WHERE id = 'tb4d-subtask'").run()).toThrow();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    db.close();
  });

  it("keeps the journal and snapshot tail at 0035", () => {
    const directory = new URL("../migrations/", import.meta.url);
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    const snapshot = JSON.parse(readFileSync(new URL("../migrations/meta/0035_snapshot.json", import.meta.url), "utf8")) as { tables: Record<string, unknown> };
    expect(journal.entries.at(-1)).toMatchObject({ idx: 35, tag: "0035_project_subtask_scheduling_ranges" });
    expect(snapshot.tables).toHaveProperty("project_subtasks");
    expect(readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value)).at(-1)).toBe("0035_project_subtask_scheduling_ranges.sql");
  });
});
