import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0064_drop_projects_board_position.sql";
const NOW = 1_800_000_000_000;

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function applyThrough(db: SqliteDatabase, through: number): void {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value) && Number(value.slice(0, 4)) <= through).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
}

function applyMigration(db: SqliteDatabase): void {
  db.exec("BEGIN");
  for (const statement of readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8").split("--> statement-breakpoint")) db.exec(statement);
  db.exec("COMMIT");
}

const columns = (db: SqliteDatabase) => (db.prepare("SELECT name FROM pragma_table_info('projects')").all() as Array<{ name: string }>).map((row) => row.name);
const objects = (db: SqliteDatabase, name: string) => db.prepare("SELECT name FROM sqlite_master WHERE name = ?").all(name);

describe("migration 0064 drops projects.board_position (#476)", () => {
  it("is journaled as idx 64 and is exactly the index drop and the column drop", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    const statements = sql.split("--> statement-breakpoint").map((statement) => statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim());
    expect(statements).toEqual(["DROP INDEX projects_stage_archive_board_order_idx;", "ALTER TABLE projects DROP COLUMN board_position;"]);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--") && !value.startsWith("--> "))) expect(line, line).not.toContain(";");
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION.replace(/\.sql$/, ""));
    expect(entry).toMatchObject({ idx: 64 });
    expect(entry!.when).toBeGreaterThan(Math.max(...journal.entries.filter((candidate) => candidate.idx < 64).map((candidate) => candidate.when)));
  });

  it("removes the column and its index, keeps the 0037 rollback table and index, and keeps every project row", () => {
    const db = localSqlite();
    applyThrough(db, 63);
    expect(columns(db)).toContain("board_position");
    expect(objects(db, "projects_stage_archive_board_order_idx")).toHaveLength(1);
    for (const id of ["p1", "p2"]) db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'S', 'editing', 3, ?, ?)").run(id, NOW, NOW);
    const rollbackBefore = db.prepare("SELECT COUNT(*) AS n FROM project_board_order_0037_rollback").get();
    applyMigration(db);
    expect(columns(db)).not.toContain("board_position");
    expect(columns(db)).toContain("board_revision");
    expect(objects(db, "projects_stage_archive_board_order_idx")).toEqual([]);
    expect(objects(db, "project_board_order_0037_rollback")).toHaveLength(1);
    expect(objects(db, "project_board_order_0037_stage_rank_idx")).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM project_board_order_0037_rollback").get()).toEqual(rollbackBefore);
    expect(db.prepare("SELECT id, stage_key FROM projects ORDER BY id").all()).toEqual([{ id: "p1", stage_key: "editing" }, { id: "p2", stage_key: "editing" }]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });
});
