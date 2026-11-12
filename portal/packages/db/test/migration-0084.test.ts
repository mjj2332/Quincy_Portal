import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0084_jobs_fk_reference_indexes.sql";

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

const indexColumns = (db: SqliteDatabase, name: string) =>
  (db.prepare(`SELECT name FROM pragma_index_info('${name}') ORDER BY seqno`).all() as Array<{ name: string }>).map((row) => row.name);
const tableIndexes = (db: SqliteDatabase, table: string) =>
  (db.prepare(`SELECT name FROM pragma_index_list('${table}') ORDER BY name`).all() as Array<{ name: string }>).map((row) => row.name);

const NEW_INDEXES = [
  ["autohdr_handoffs", "autohdr_handoffs_job_idx", ["job_id"]],
  ["autohdr_fetch_claims", "autohdr_fetch_claims_job_idx", ["job_id"]],
  ["raw_reconciliation_claims", "raw_reconciliation_claims_owner_job_idx", ["owner_job_id"]],
] as const;

describe("migration 0084 indexes the columns that reference jobs.id", () => {
  it("is journaled as idx 84, additive only, and keeps the worker harness's splitting rules", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    const code = sql.split("--> statement-breakpoint").map((statement) => statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim());
    expect(code.join("\n")).not.toMatch(/CREATE TRIGGER|DROP |DELETE |__new_|PRAGMA|UPDATE |ALTER |INSERT INTO/i);
    expect(code).toHaveLength(3);
    for (const statement of code) {
      expect(statement).toMatch(/^CREATE INDEX /);
      expect(statement.endsWith(";"), statement).toBe(true);
      expect(statement.slice(0, -1), statement).not.toContain(";");
    }
    for (const line of sql.split("\n").filter((value) => value.startsWith("--") && !value.startsWith("--> "))) expect(line, line).not.toContain(";");
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION.replace(/\.sql$/, ""));
    expect(entry).toMatchObject({ idx: 84 });
    expect(entry!.when).toBeGreaterThan(Math.max(...journal.entries.filter((candidate) => candidate.idx < 84).map((candidate) => candidate.when)));
    expect(journal.entries.at(-1)!.tag).toBe(MIGRATION.replace(/\.sql$/, ""));
  });

  it("adds the three indexes with exact columns and keeps every existing index on those tables", () => {
    const db = localSqlite();
    applyThrough(db, 83);
    const before = NEW_INDEXES.map(([table]) => tableIndexes(db, table));
    applyMigration(db);
    NEW_INDEXES.forEach(([table, name, columns], position) => {
      expect(indexColumns(db, name)).toEqual([...columns]);
      expect(tableIndexes(db, table)).toEqual([...before[position]!, name].sort());
    });
  });

  it("makes the foreign key check on a jobs delete a seek, changes no row and leaves foreign_key_check empty", () => {
    const db = localSqlite();
    applyThrough(db, 83);
    db.exec("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES ('p1', 'S', 'awaiting_raw', 1, 1)");
    db.exec("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES ('j1', 'editor_reconcile', 'done', 'p1', 1, 2)");
    applyMigration(db);
    expect(db.prepare("SELECT id, kind, status, project_id, created_at, updated_at FROM jobs").all()).toEqual([
      { id: "j1", kind: "editor_reconcile", status: "done", project_id: "p1", created_at: 1, updated_at: 2 },
    ]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const plan = (db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM raw_reconciliation_claims WHERE owner_job_id = 'j1'").all() as Array<{ detail: string }>).map((row) => row.detail).join("\n");
    expect(plan).toContain("raw_reconciliation_claims_owner_job_idx");
  });
});
