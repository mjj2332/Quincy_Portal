import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteRow = Record<string, unknown>;
type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => unknown };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const BREAKPOINT = "--> statement-breakpoint";
const MIGRATION_NAME = "0038_project_activity_feed_index.sql";
const INDEX_NAME = "project_activity_events_project_occurred_idx";

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

function migrationNames(): string[] {
  const directory = new URL("../migrations/", import.meta.url);
  return readdirSync(directory)
    .filter((value) => /^\d{4}_.*\.sql$/.test(value))
    .sort((a, b) => Number(a.slice(0, 4)) - Number(b.slice(0, 4)));
}

function migrationSegments(name: string): string[] {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8")
    .split(BREAKPOINT)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function applyMigration(db: SqliteDatabase, name: string): void {
  for (const segment of migrationSegments(name)) db.exec(segment);
}

function applyThrough(db: SqliteDatabase, through: number): void {
  for (const name of migrationNames()) {
    if (Number(name.slice(0, 4)) <= through) applyMigration(db, name);
  }
}

function seedProjects(db: SqliteDatabase): void {
  const insert = db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
  insert.run("project-1", "1 Activity Street", "awaiting_raw", 0, 1_700_000_000_000, 1_700_000_000_000);
  insert.run("project-2", "2 Activity Street", "raw_review", 0, 1_700_000_000_001, 1_700_000_000_001);
}

function seedActivity(db: SqliteDatabase): void {
  const insert = db.prepare(`
    INSERT INTO project_activity_events (
      id, schema_version, event_type, category, project_id, actor_kind, actor_id,
      occurred_at, source_kind, source_id, source_key, safe_payload_json,
      deep_link_kind, deep_link_path, created_at
    ) VALUES (?, 1, ?, ?, ?, 'system', NULL, ?, ?, ?, ?, '{}', 'project', ?, ?)
  `);
  const rows = [
    ["activity-1", "project.priority.changed", "priority", "project-1", 2_000, "project_priority", "source-1", "priority:1", "/projects/project-1", 2_000],
    ["activity-2", "project.details.changed", "project_metadata", "project-1", 3_000, "project_details", "source-2", "details:2", "/projects/project-1", 3_000],
    ["activity-3", "project.archived", "coordination", "project-1", 3_000, "project", "source-3", "archived:3", "/projects/project-1", 3_001],
    ["activity-4", "project.stage.changed", "stage", "project-2", 1_000, "project_stage", "source-4", "stage:4", "/projects/project-2", 1_000],
  ];
  for (const row of rows) insert.run(...row);
}

function activityRows(db: SqliteDatabase): SqliteRow[] {
  return db.prepare("SELECT * FROM project_activity_events ORDER BY id").all() as SqliteRow[];
}

function indexColumns(db: SqliteDatabase): SqliteRow[] {
  return db.prepare(`PRAGMA index_info('${INDEX_NAME}')`).all() as SqliteRow[];
}

function keyedIndexColumns(db: SqliteDatabase): SqliteRow[] {
  return (db.prepare(`PRAGMA index_xinfo('${INDEX_NAME}')`).all() as SqliteRow[]).filter((row) => row.key === 1);
}

describe("migration 0038 project activity feed index", () => {
  it("applies 0000 through 0038 from empty and creates the ordered feed index", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    expect(migrationNames().map((name) => Number(name.slice(0, 4)))).toEqual(Array.from({ length: 40 }, (_, index) => index));
    applyThrough(db, 38);

    expect(db.prepare("SELECT type, name FROM sqlite_master WHERE type = 'index' AND name = ?").all(INDEX_NAME)).toEqual([{ type: "index", name: INDEX_NAME }]);
    expect(indexColumns(db)).toEqual([
      { seqno: 0, cid: 4, name: "project_id" },
      { seqno: 1, cid: 7, name: "occurred_at" },
      { seqno: 2, cid: 0, name: "id" },
    ]);
    expect(keyedIndexColumns(db).map((row) => ({ name: row.name, desc: row.desc }))).toEqual([
      { name: "project_id", desc: 0 },
      { name: "occurred_at", desc: 1 },
      { name: "id", desc: 1 },
    ]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    db.close();
  });

  it("upgrades a representative 0037 fixture without changing activity rows or referential integrity", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyThrough(db, 37);
    seedProjects(db);
    seedActivity(db);
    const before = activityRows(db);

    applyMigration(db, MIGRATION_NAME);

    expect(activityRows(db)).toEqual(before);
    expect(activityRows(db)).toHaveLength(4);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    db.close();
  });

  it("uses the feed index for the D4 project/cursor/order query, including tie ordering", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyThrough(db, 37);
    seedProjects(db);
    seedActivity(db);
    applyMigration(db, MIGRATION_NAME);

    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id, occurred_at
      FROM project_activity_events
      WHERE project_id = ?
        AND (occurred_at, id) < (?, ?)
      ORDER BY occurred_at DESC, id DESC
      LIMIT ?
    `).all("project-1", 9_999, "zzzz", 10) as SqliteRow[];
    const details = plan.map((row) => String(row.detail));
    expect(details.join(" ")).toContain(INDEX_NAME);
    expect(details.join(" ")).toMatch(new RegExp(`USING (?:COVERING )?INDEX ${INDEX_NAME}`));
    expect(details.join(" ")).not.toMatch(/SCAN project_activity_events/i);

    const rows = db.prepare(`
      SELECT id, occurred_at
      FROM project_activity_events
      WHERE project_id = ? AND (occurred_at, id) < (?, ?)
      ORDER BY occurred_at DESC, id DESC
      LIMIT ?
    `).all("project-1", 9_999, "zzzz", 10);
    expect(rows).toEqual([
      { id: "activity-3", occurred_at: 3_000 },
      { id: "activity-2", occurred_at: 3_000 },
      { id: "activity-1", occurred_at: 2_000 },
    ]);
    db.close();
  });

  it("supports rollback rehearsal by dropping only the index and retaining table data", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyThrough(db, 37);
    seedProjects(db);
    seedActivity(db);
    applyMigration(db, MIGRATION_NAME);
    const before = activityRows(db);

    db.exec(`DROP INDEX ${INDEX_NAME}`);

    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_activity_events'").all()).toEqual([{ name: "project_activity_events" }]);
    expect(activityRows(db)).toEqual(before);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").all(INDEX_NAME)).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    db.close();
  });

  it("keeps the exact bare migration and Drizzle journal/snapshot metadata", () => {
    const source = readFileSync(new URL(`../migrations/${MIGRATION_NAME}`, import.meta.url), "utf8");
    expect(source.trim()).toBe("CREATE INDEX project_activity_events_project_occurred_idx\n  ON project_activity_events(project_id, occurred_at DESC, id DESC);");
    expect(source).not.toMatch(/ALTER TABLE|PRAGMA foreign_keys|DROP TABLE|__new_/i);

    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; version: string; tag: string; breakpoints: boolean }> };
    const snapshot = JSON.parse(readFileSync(new URL("../migrations/meta/0038_snapshot.json", import.meta.url), "utf8")) as { version: string; dialect: string; prevId: string; tables: Record<string, { indexes?: Record<string, unknown> }> };
    expect(journal.entries.find((entry) => entry.tag === "0038_project_activity_feed_index")).toEqual(expect.objectContaining({ idx: 38, version: "6", tag: "0038_project_activity_feed_index", breakpoints: true }));
    expect(snapshot).toMatchObject({ version: "6", dialect: "sqlite", prevId: "d695c6f4-eb5e-41c2-b9b0-9e9338307729" });
    expect(snapshot.tables.project_activity_events.indexes).toHaveProperty(INDEX_NAME);
  });
});
