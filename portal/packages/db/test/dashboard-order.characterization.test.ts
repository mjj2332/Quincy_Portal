import { describe, expect, it } from "vitest";
import { createDb, dashboardProjectOrder, schema } from "../src/index";

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

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (globalThis as unknown as { process: { getBuiltinModule: (name: string) => unknown } }).process.getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

class LocalD1Statement {
  constructor(private readonly db: SqliteDatabase, private readonly sql: string) {}

  bind(...values: unknown[]): D1PreparedStatement {
    const statement = this.db.prepare(this.sql);
    return {
      all: async <T>() => ({ results: statement.all(...values) as T[] }),
      raw: async <T>() => (statement.all(...values) as Array<Record<string, unknown>>).map((row) => Object.values(row)) as T[],
    } as unknown as D1PreparedStatement;
  }
}

function localD1(db: SqliteDatabase): D1Database {
  return { prepare: (sql: string) => new LocalD1Statement(db, sql) } as unknown as D1Database;
}

describe("TB5A Slice 0 dashboardProjectOrder", () => {
  it("preserves the current list query's shoot-date ordering rather than Board ordering", async () => {
    const sqlite = localSqlite();
    try {
      sqlite.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, shoot_date TEXT, priority INTEGER, board_position REAL NOT NULL)");
      sqlite.exec("INSERT INTO projects (id, shoot_date, priority, board_position) VALUES ('null-priority', '2026-07-22', NULL, 4096), ('priority-midpoint', '2026-07-21', 2, 1536), ('priority-tie', '2026-07-20', 1, 1536), ('no-date', NULL, NULL, 0)");

      const db = createDb(localD1(sqlite));
      const rows = await db.select({ id: schema.projects.id, shootDate: schema.projects.shootDate })
        .from(schema.projects)
        .orderBy(...dashboardProjectOrder)
        .all();

      // The Board comparator is characterized separately in the app/web suites. This is the
      // current dashboard list owner and intentionally remains shoot date → null-date last.
      expect(rows.map((row) => row.id)).toEqual(["null-priority", "priority-midpoint", "priority-tie", "no-date"]);
    } finally {
      sqlite.close();
    }
  });
});
