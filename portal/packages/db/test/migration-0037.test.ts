import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { rollbackBoardOrder0037PreEnable } from "../src/board-order-rollback-0037";

type SqliteRow = Record<string, unknown>;
type SqliteStatement = {
  all: (...values: unknown[]) => unknown[];
  get: (...values: unknown[]) => unknown;
  run: (...values: unknown[]) => unknown;
};
type SqliteDatabase = {
  close: () => void;
  exec: (source: string) => void;
  prepare: (source: string) => SqliteStatement;
};

const BREAKPOINT = "--> statement-breakpoint";
const MIGRATION_NAME = "0037_project_board_order_contract.sql";
const MIGRATION_ONLY_OBJECTS = [
  "project_board_order_0037_rollback",
  "project_board_order_0037_stage_rank_idx",
  "projects_stage_archive_board_order_idx",
];

function localSqlite(filename = ":memory:"): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(filename);
}

function migrationNames(): string[] {
  const directory = new URL("../migrations/", import.meta.url);
  return readdirSync(directory)
    .filter((value) => /^\d{4}_.*\.sql$/.test(value))
    .sort((a, b) => Number(a.slice(0, 4)) - Number(b.slice(0, 4)));
}

function migrationSegments(name: string): string[] {
  const directory = new URL("../migrations/", import.meta.url);
  return readFileSync(new URL(name, directory), "utf8")
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

function migrationSource(): string {
  return readFileSync(new URL(`../migrations/${MIGRATION_NAME}`, import.meta.url), "utf8");
}

function apply0037Transactionally(db: SqliteDatabase): void {
  db.exec("BEGIN TRANSACTION");
  try {
    applyMigration(db, MIGRATION_NAME);
    db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(MIGRATION_NAME);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // SQLite may already have rolled back a failed transaction.
    }
    throw error;
  }
}

function seedMigrationJournal(db: SqliteDatabase, through: number): void {
  db.exec(`
    CREATE TABLE d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )
  `);
  for (const name of migrationNames().filter((value) => Number(value.slice(0, 4)) <= through)) {
    db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
  }
}

function tableInfo(db: SqliteDatabase, table: string): SqliteRow[] {
  return db.prepare(`PRAGMA table_info('${table}')`).all() as SqliteRow[];
}

function hasColumn(db: SqliteDatabase, table: string, column: string): boolean {
  return tableInfo(db, table).some((row) => row.name === column);
}

function sqliteObjects(db: SqliteDatabase, type: string, names: readonly string[]): SqliteRow[] {
  const placeholders = names.map(() => "?").join(", ");
  return db.prepare(`SELECT type, name FROM sqlite_master WHERE type = ? AND name IN (${placeholders}) ORDER BY name`).all(type, ...names) as SqliteRow[];
}

function objectExists(db: SqliteDatabase, type: string, name: string): boolean {
  return sqliteObjects(db, type, [name]).length === 1;
}

type ProjectFixture = {
  id: string;
  stageKey: string;
  priority: number | null;
  boardPosition: number;
  archivedAt?: number | null;
};

const FIXTURE_NOW = 1_787_000_000_000;

const ORDERING_FIXTURES: ProjectFixture[] = [
  { id: "a-tie-1", stageKey: "awaiting_raw", priority: 5, boardPosition: 4 },
  { id: "a-tie-2", stageKey: "awaiting_raw", priority: 5, boardPosition: 4 },
  { id: "a-fraction", stageKey: "awaiting_raw", priority: 1, boardPosition: 4.5 },
  { id: "a-null", stageKey: "awaiting_raw", priority: null, boardPosition: 8 },
  { id: "b-priority-10", stageKey: "raw_review", priority: 10, boardPosition: 2 },
  { id: "b-priority-5", stageKey: "raw_review", priority: 5, boardPosition: 2 },
  { id: "b-null", stageKey: "raw_review", priority: null, boardPosition: -100 },
  { id: "inactive-stage", stageKey: "edited_review", priority: 5, boardPosition: 99 },
  { id: "delivered-project", stageKey: "delivered", priority: null, boardPosition: 7 },
  { id: "archived-project", stageKey: "awaiting_raw", priority: 1, boardPosition: 123.25, archivedAt: FIXTURE_NOW + 1 },
  { id: "archived-noncanonical", stageKey: "legacy_archived", priority: null, boardPosition: 987.5, archivedAt: FIXTURE_NOW + 2 },
];

function seedPipelineStages(db: SqliteDatabase): void {
  db.prepare("INSERT INTO pipeline_stages (key, label, display_order, active) VALUES (?, ?, ?, ?)").run("edited_review", "Edited review", 4, 0);
}

function seedProjects(db: SqliteDatabase, fixtures = ORDERING_FIXTURES): void {
  const insert = db.prepare("INSERT INTO projects (id, street, stage_key, priority, board_position, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const project of fixtures) {
    insert.run(project.id, `${project.id} Street`, project.stageKey, project.priority, project.boardPosition, project.archivedAt ?? null, FIXTURE_NOW, FIXTURE_NOW);
  }
}

function snapshotProjects(db: SqliteDatabase): SqliteRow[] {
  return db.prepare("SELECT id, stage_key, priority, board_position, archived_at FROM projects ORDER BY id").all() as SqliteRow[];
}

function localD1(db: SqliteDatabase): D1Database {
  class LocalD1Statement {
    constructor(private readonly source: string, private readonly values: unknown[] = []) {}

    bind(...values: unknown[]): D1PreparedStatement {
      return new LocalD1Statement(this.source, values) as unknown as D1PreparedStatement;
    }

    execute(): D1Result<unknown> {
      const result = db.prepare(this.source).run(...this.values) as { changes?: number | bigint };
      return { success: true, results: [], meta: { changes: Number(result.changes ?? 0) } } as unknown as D1Result<unknown>;
    }

    async first<T>(): Promise<T | null> {
      return (db.prepare(this.source).get(...this.values) as T | undefined) ?? null;
    }
  }

  return {
    prepare: (source: string) => new LocalD1Statement(source) as unknown as D1PreparedStatement,
    batch: async (statements: D1PreparedStatement[]) => {
      db.exec("BEGIN TRANSACTION");
      try {
        const results = statements.map((statement) => (statement as unknown as LocalD1Statement).execute());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // SQLite may already have rolled back a failed transaction.
        }
        throw error;
      }
    },
  } as unknown as D1Database;
}

function withTemporaryDatabase(callback: (filename: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "quincy-migration-0037-"));
  const filename = join(directory, "fixture.sqlite");
  try {
    callback(filename);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("migration 0037 project board order contract", () => {
  it("applies the complete 0000..0037 chain and leaves a healthy scratch database", () => {
    const names = migrationNames();
    expect(names.map((name) => Number(name.slice(0, 4)))).toEqual(Array.from({ length: 38 }, (_, index) => index));

    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyThrough(db, 37);

    expect(tableInfo(db, "projects")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "board_revision", type: "INTEGER", notnull: 1, dflt_value: "0" }),
    ]));
    expect(tableInfo(db, "autohdr_handoffs")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "editing_entry_board_revision", type: "INTEGER", notnull: 0, dflt_value: null }),
    ]));
    expect(tableInfo(db, "jobs")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "stage_entry_board_revision", type: "INTEGER", notnull: 0, dflt_value: null }),
    ]));

    expect(objectExists(db, "table", "project_board_order_0037_rollback")).toBe(true);
    expect(sqliteObjects(db, "index", ["project_board_order_0037_stage_rank_idx", "projects_stage_archive_board_order_idx"])).toEqual([
      { type: "index", name: "project_board_order_0037_stage_rank_idx" },
      { type: "index", name: "projects_stage_archive_board_order_idx" },
    ]);
    expect(db.prepare("SELECT enabled FROM feature_flags WHERE key = 'tb5a_board_contract_enabled'").get()).toEqual({ enabled: 0 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '_tb5a_0037_%' ORDER BY name").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    db.close();
  });

  it("normalizes 0036 data by the visible comparator without changing Stage or Priority", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyThrough(db, 36);
    seedPipelineStages(db);
    seedProjects(db);
    const before = snapshotProjects(db);

    applyMigration(db, MIGRATION_NAME);

    const expected = new Map<string, { boardPosition: number; stageKey: string; priority: number | null; archivedAt: number | null }>();
    const visibleByStage = new Map<string, SqliteRow[]>();
    for (const row of before.filter((value) => value.archived_at === null)) {
      const stageRows = visibleByStage.get(String(row.stage_key)) ?? [];
      stageRows.push(row);
      visibleByStage.set(String(row.stage_key), stageRows);
    }
    for (const rows of visibleByStage.values()) {
      rows.sort((left, right) => {
        const leftNull = left.priority === null ? 1 : 0;
        const rightNull = right.priority === null ? 1 : 0;
        return leftNull - rightNull || Number(left.board_position) - Number(right.board_position) || String(left.id).localeCompare(String(right.id));
      });
      rows.forEach((row, index) => expected.set(String(row.id), {
        boardPosition: index * 1024,
        stageKey: String(row.stage_key),
        priority: row.priority as number | null,
        archivedAt: row.archived_at as number | null,
      }));
    }

    const after = db.prepare("SELECT id, stage_key, priority, board_position, board_revision, archived_at FROM projects ORDER BY id").all() as SqliteRow[];
    for (const row of after) {
      const original = before.find((value) => value.id === row.id);
      expect(original).toBeDefined();
      expect(row.stage_key).toBe(original?.stage_key);
      expect(row.priority).toBe(original?.priority);
      if (row.archived_at === null) {
        expect(row.board_position).toBe(expected.get(String(row.id))?.boardPosition);
        expect(row.board_revision).toBe(1);
      } else {
        expect(row.board_position).toBe(original?.board_position);
        expect(row.board_revision).toBe(0);
      }
    }

    const unarchivedCount = before.filter((row) => row.archived_at === null).length;
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_board_order_0037_rollback").get()).toEqual({ count: unarchivedCount });
    expect(db.prepare("SELECT stage_key, visible_rank, COUNT(*) AS count FROM project_board_order_0037_rollback GROUP BY stage_key, visible_rank HAVING COUNT(*) <> 1").all()).toEqual([]);
    expect(db.prepare("SELECT project_id, old_board_position, normalized_board_position, visible_rank FROM project_board_order_0037_rollback ORDER BY stage_key, visible_rank").all()).toHaveLength(unarchivedCount);
    expect(db.prepare("SELECT enabled FROM feature_flags WHERE key = 'tb5a_board_contract_enabled'").get()).toEqual({ enabled: 0 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    db.close();
  });

  it("aborts before capture for a noncanonical unarchived Stage and does not advance the journal", () => {
    withTemporaryDatabase((filename) => {
      let db = localSqlite(filename);
      db.exec("PRAGMA foreign_keys = ON");
      applyThrough(db, 36);
      seedMigrationJournal(db, 36);
      seedProjects(db, [{ id: "invalid-stage", stageKey: "not_a_stage", priority: 1, boardPosition: 42 }]);
      db.close();

      db = localSqlite(filename);
      expect(() => apply0037Transactionally(db)).toThrow();
      db.close();

      db = localSqlite(filename);
      expect(hasColumn(db, "projects", "board_revision")).toBe(false);
      expect(hasColumn(db, "autohdr_handoffs", "editing_entry_board_revision")).toBe(false);
      expect(hasColumn(db, "jobs", "stage_entry_board_revision")).toBe(false);
      expect(objectExists(db, "table", "project_board_order_0037_rollback")).toBe(false);
      expect(objectExists(db, "index", "project_board_order_0037_stage_rank_idx")).toBe(false);
      expect(objectExists(db, "index", "projects_stage_archive_board_order_idx")).toBe(false);
      expect(db.prepare("SELECT key FROM feature_flags WHERE key = 'tb5a_board_contract_enabled'").all()).toEqual([]);
      expect(db.prepare("SELECT COUNT(*) AS count, MAX(id) AS max_id FROM d1_migrations").get()).toEqual({ count: 37, max_id: 37 });
      db.close();
    });
  });

  it("rolls back all migration work when the normalization update skips a captured row", () => {
    withTemporaryDatabase((filename) => {
      let db = localSqlite(filename);
      db.exec("PRAGMA foreign_keys = ON");
      applyThrough(db, 36);
      seedMigrationJournal(db, 36);
      seedProjects(db, ORDERING_FIXTURES.slice(0, 4));
      const before = snapshotProjects(db);
      db.exec(`
        CREATE TRIGGER tb5a_0037_skip_one_normalization
        BEFORE UPDATE OF board_position ON projects
        WHEN NEW.id = 'a-tie-1'
        BEGIN
          SELECT RAISE(IGNORE);
        END;
      `);
      db.close();

      db = localSqlite(filename);
      expect(() => apply0037Transactionally(db)).toThrow();
      db.close();

      db = localSqlite(filename);
      expect(hasColumn(db, "projects", "board_revision")).toBe(false);
      expect(hasColumn(db, "autohdr_handoffs", "editing_entry_board_revision")).toBe(false);
      expect(hasColumn(db, "jobs", "stage_entry_board_revision")).toBe(false);
      expect(objectExists(db, "table", "project_board_order_0037_rollback")).toBe(false);
      expect(objectExists(db, "index", "project_board_order_0037_stage_rank_idx")).toBe(false);
      expect(objectExists(db, "index", "projects_stage_archive_board_order_idx")).toBe(false);
      expect(db.prepare("SELECT key FROM feature_flags WHERE key = 'tb5a_board_contract_enabled'").all()).toEqual([]);
      expect(snapshotProjects(db)).toEqual(before);
      expect(db.prepare("SELECT COUNT(*) AS count, MAX(id) AS max_id FROM d1_migrations").get()).toEqual({ count: 37, max_id: 37 });
      db.close();
    });
  });

  it("proves Wrangler keeps one statement per breakpoint and no unsafe END punctuation", async () => {
    const { unstable_splitSqlQuery } = await import("../../../node_modules/wrangler/wrangler-dist/cli.js");
    const source = migrationSource();
    const segments = source.split(BREAKPOINT).map((segment) => segment.trim()).filter(Boolean);
    const statements = unstable_splitSqlQuery(source);
    const withoutTerminalSemicolon = (value: string) => value.trim().replace(/;\s*$/, "");

    expect(statements).toHaveLength(segments.length);
    expect(statements.map(withoutTerminalSemicolon)).toEqual(segments.map(withoutTerminalSemicolon));
    for (const segment of segments) {
      expect(unstable_splitSqlQuery(segment)).toHaveLength(1);
      expect(unstable_splitSqlQuery(`${segment}\n${segment}`)).toHaveLength(2);
    }
    expect(source).not.toMatch(/\bEND\b(?=[^\s;])/i);
  });

  it("keeps migration-only objects out of the Drizzle schema and snapshot", () => {
    const schema = readFileSync(new URL("../src/schema.ts", import.meta.url), "utf8");
    const snapshot = readFileSync(new URL("../migrations/meta/0037_snapshot.json", import.meta.url), "utf8");
    for (const object of MIGRATION_ONLY_OBJECTS) {
      expect(schema).not.toContain(object);
      expect(snapshot).not.toContain(object);
    }
    expect(schema).not.toContain("_tb5a_0037_");
    expect(snapshot).not.toContain("_tb5a_0037_");
    const parsed = JSON.parse(snapshot) as { tables: Record<string, { columns: Record<string, unknown>; indexes: Record<string, unknown> }> };
    expect(parsed.tables.projects.columns).toHaveProperty("board_revision");
    expect(parsed.tables.autohdr_handoffs.columns).toHaveProperty("editing_entry_board_revision");
    expect(parsed.tables.jobs.columns).toHaveProperty("stage_entry_board_revision");
    expect(parsed.tables.projects.indexes).not.toHaveProperty("projects_stage_archive_board_order_idx");
  });

  it("restores all captured positions on the pre-enable rollback happy path", async () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyThrough(db, 36);
    seedPipelineStages(db);
    seedProjects(db);
    applyMigration(db, MIGRATION_NAME);
    const normalized = db.prepare("SELECT id, board_position FROM projects WHERE archived_at IS NULL ORDER BY id").all() as SqliteRow[];
    const oldPositions = new Map((db.prepare("SELECT project_id, old_board_position FROM project_board_order_0037_rollback").all() as SqliteRow[]).map((row) => [String(row.project_id), row.old_board_position]));

    await expect(rollbackBoardOrder0037PreEnable(localD1(db))).resolves.toEqual({ rolledBack: normalized.length });
    const restored = db.prepare("SELECT id, board_position FROM projects WHERE archived_at IS NULL ORDER BY id").all() as SqliteRow[];
    for (const row of restored) expect(row.board_position).toBe(oldPositions.get(String(row.id)));
    expect(normalized.every((row) => Number(row.board_position) !== Number(oldPositions.get(String(row.id))))).toBe(true);
    db.close();
  });

  it.each(["wrong Stage", "already re-revised"])('rolls back every pre-enable restoration when one row has drifted (%s)', async (drift) => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyThrough(db, 36);
    seedPipelineStages(db);
    seedProjects(db, ORDERING_FIXTURES.slice(0, 4));
    applyMigration(db, MIGRATION_NAME);
    const normalized = db.prepare("SELECT id, board_position FROM projects WHERE archived_at IS NULL ORDER BY id").all() as SqliteRow[];
    const driftedId = String(normalized[0]?.id);
    if (drift === "wrong Stage") {
      db.prepare("UPDATE projects SET stage_key = 'wrong_stage' WHERE id = ?").run(driftedId);
    } else {
      db.prepare("UPDATE projects SET board_revision = 2 WHERE id = ?").run(driftedId);
    }

    await expect(rollbackBoardOrder0037PreEnable(localD1(db))).rejects.toThrow();
    expect(db.prepare("SELECT id, board_position FROM projects WHERE archived_at IS NULL ORDER BY id").all()).toEqual(normalized);
    expect(objectExists(db, "table", "_tb5a_0037_position_rollback_guard")).toBe(false);
    db.close();
  });
});
