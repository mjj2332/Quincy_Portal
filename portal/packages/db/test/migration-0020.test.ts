import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { get: () => unknown; run: (...values: unknown[]) => unknown };
type SqliteDatabase = { exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

function applyMigrations(db: SqliteDatabase) {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((value) => value.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(name, directory), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
}

describe("migration 0020 priority check", () => {
  it("rejects out-of-range and non-integer priorities in SQLite itself", () => {
    const db = localSqlite();
    applyMigrations(db);
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get() as { sql: string };
    // The applied migration uses a bare (unnamed) inline CHECK — see docs/lessons.md on why
    // this replaced drizzle-kit's originally-generated named-constraint table-rebuild form
    // (PRAGMA foreign_keys=OFF doesn't reliably persist across D1's remote migration
    // execution). Assert on the check clause's content, not a constraint name that no longer
    // exists in the actual applied SQL.
    expect(table.sql).toContain("typeof(\"projects\".\"priority\") = 'integer'");
    const insert = db.prepare("INSERT INTO projects (id, street, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    for (const priority of [0, 11, 5.5]) {
      expect(() => insert.run(crypto.randomUUID(), `invalid-${priority}`, priority, Date.now(), Date.now())).toThrow(/CHECK constraint failed/);
    }
  });
});
