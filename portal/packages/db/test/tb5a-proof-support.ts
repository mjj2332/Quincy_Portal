import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export type SqliteRow = Record<string, unknown>;
export type SqliteStatement = {
  all: (...values: unknown[]) => unknown[];
  get: (...values: unknown[]) => unknown;
  run: (...values: unknown[]) => unknown;
};
export type SqliteDatabase = {
  close: () => void;
  exec: (source: string) => void;
  prepare: (source: string) => SqliteStatement;
};

export const BREAKPOINT = "--> statement-breakpoint";
export const MIGRATION_NAME = "0037_project_board_order_contract.sql";
export const FIXTURE_NOW = 1_787_000_000_000;

export function localSqlite(filename = ":memory:"): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(filename);
}

export function migrationNames(): string[] {
  const directory = new URL("../migrations/", import.meta.url);
  return readdirSync(directory)
    .filter((value) => /^\d{4}_.*\.sql$/.test(value))
    .sort((a, b) => Number(a.slice(0, 4)) - Number(b.slice(0, 4)));
}

export function migrationSegments(name: string): string[] {
  const directory = new URL("../migrations/", import.meta.url);
  return readFileSync(new URL(name, directory), "utf8")
    .split(BREAKPOINT)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function migrationSource(): string {
  return readFileSync(new URL(`../migrations/${MIGRATION_NAME}`, import.meta.url), "utf8");
}

export function applyMigration(db: SqliteDatabase, name: string): void {
  for (const segment of migrationSegments(name)) db.exec(segment);
}

export function applyThrough(db: SqliteDatabase, through: number): void {
  for (const name of migrationNames()) {
    if (Number(name.slice(0, 4)) <= through) applyMigration(db, name);
  }
}

export function applyAllMigrations(db: SqliteDatabase): void {
  applyThrough(db, 37);
}

export function seedMigrationJournal(db: SqliteDatabase, through: number): void {
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

export function apply0037Transactionally(db: SqliteDatabase): void {
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

export function localD1(db: SqliteDatabase): D1Database {
  class LocalD1Statement {
    constructor(private readonly source: string, private readonly values: unknown[] = []) {}

    bind(...values: unknown[]): D1PreparedStatement {
      return new LocalD1Statement(this.source, values) as unknown as D1PreparedStatement;
    }

    execute(): D1Result<unknown> {
      const statement = db.prepare(this.source);
      let results: unknown[] = [];
      try {
        results = statement.all(...this.values);
      } catch {
        statement.run(...this.values);
      }
      const changes = Number((db.prepare("SELECT changes() AS changes").get() as { changes: number }).changes);
      return { success: true, results, meta: { changes } } as unknown as D1Result<unknown>;
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

export function enableBoardContract(db: SqliteDatabase): void {
  db.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run();
}

export type LegacyProject = {
  id: string;
  stageKey: string;
  priority?: number | null;
  boardPosition?: number;
  archivedAt?: number | null;
};

export function seedLegacyProject(db: SqliteDatabase, project: LegacyProject): void {
  db.prepare("INSERT INTO projects (id, street, stage_key, priority, board_position, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(project.id, `${project.id} Street`, project.stageKey, project.priority ?? null, project.boardPosition ?? 0, project.archivedAt ?? null, FIXTURE_NOW, FIXTURE_NOW);
}

export function seedContractProject(db: SqliteDatabase, project: LegacyProject & { boardRevision?: number; shootDate?: string | null }): void {
  db.prepare("INSERT INTO projects (id, street, shoot_date, stage_key, priority, board_position, board_revision, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(project.id, `${project.id} Street`, project.shootDate ?? null, project.stageKey, project.priority ?? null, project.boardPosition ?? 0, project.boardRevision ?? 0, project.archivedAt ?? null, FIXTURE_NOW, FIXTURE_NOW);
}

export function withTemporaryDatabase(callback: (filename: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "quincy-tb5a-proof-"));
  const filename = join(directory, "fixture.sqlite");
  try {
    callback(filename);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function objectExists(db: SqliteDatabase, type: string, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) !== undefined;
}
