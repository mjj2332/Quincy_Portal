import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0054_project_edited_arrival.sql";
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

function seedProject(db: SqliteDatabase, id: string): void {
  const now = Date.now();
  db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Street', 'editing_autohdr', 0, ?, ?)").run(id, now, now);
}

describe("migration 0054 records the latest Edited arrival (#486)", () => {
  it("adds a nullable column that leaves every existing Project without a pending arrival", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyThrough(db, 53);
    seedProject(db, "before");
    db.exec(migrationSql(MIGRATION));
    expect(db.prepare("SELECT edited_arrived_at AS v FROM projects WHERE id = 'before'").get()).toEqual({ v: null });
    seedProject(db, "after");
    expect(db.prepare("SELECT edited_arrived_at AS v FROM projects WHERE id = 'after'").get()).toEqual({ v: null });
    db.close();
  });

  it("accepts epoch milliseconds and rejects a non-integer value", () => {
    const db = localSqlite();
    applyThrough(db, 54);
    seedProject(db, "p1");
    db.prepare("UPDATE projects SET edited_arrived_at = ? WHERE id = 'p1'").run(1_790_000_000_000);
    expect(db.prepare("SELECT edited_arrived_at AS v FROM projects WHERE id = 'p1'").get()).toEqual({ v: 1_790_000_000_000 });
    expect(() => db.prepare("UPDATE projects SET edited_arrived_at = 'soon' WHERE id = 'p1'").run()).toThrow(CHECK_FAILED);
    expect(() => db.prepare("UPDATE projects SET edited_arrived_at = 1.5 WHERE id = 'p1'").run()).toThrow(CHECK_FAILED);
    db.close();
  });

  it("creates the partial pending index and adds no trigger", () => {
    const db = localSqlite();
    applyThrough(db, 54);
    const index = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'projects_edited_arrival_pending_idx'").get() as { sql: string } | undefined;
    expect(index?.sql).toMatch(/WHERE edited_arrived_at IS NOT NULL/i);
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%edited_arrived_at%'").all();
    expect(triggers).toEqual([]);
    db.close();
  });
});
