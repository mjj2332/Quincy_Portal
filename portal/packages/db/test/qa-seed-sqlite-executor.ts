/**
 * Test support (not a test file): a `node:sqlite` in-memory database built from the REAL migrations,
 * the shared seed and `setup-local.mjs`'s own capability SQL, plus an executor with the exact shape
 * `qa-seed/cli.mjs`'s `wranglerExecutor` has. The qa-seed integration tests hand this to cli.mjs's own
 * exported `apply`/`teardown`/`verify`, so what they exercise is the production orchestration, with
 * only the transport swapped — `emit` goes through `emit.ts`'s own `emitMode` dispatch with the same
 * argv strings cli.mjs builds, not a re-implementation.
 *
 * Local D1 always enforces foreign keys; `node:sqlite`'s `DatabaseSync` does too by default, and
 * `freshFixtureDatabase` asserts it, because a RESTRICT/NO ACTION trap that cannot fire here would
 * make every teardown assertion built on it vacuous.
 */
import { readdirSync, readFileSync } from "node:fs";
import { QA_FIXTURE_CAPABILITY_SQL } from "../setup-local.mjs";
import { emitMode } from "../qa-seed/emit";
import { INTROSPECT_FOREIGN_KEYS_SQL, INTROSPECT_TABLES_SQL } from "../qa-seed/cli.mjs";
import { buildTeardownGraph, buildTeardownPlan, type IntrospectedForeignKey, type IntrospectedTable } from "../qa-seed/teardown-graph";

export type Row = Record<string, unknown>;
type Statement = { all: (...values: unknown[]) => Row[]; get: (...values: unknown[]) => Row | undefined; run: (...values: unknown[]) => unknown };
export type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => Statement };

export type FixtureExecutor = {
  query: (sql: string) => Row[];
  run: (statements: string[], label: string) => void;
  emit: (mode: string, args: string[]) => unknown;
};

function openMemoryDatabase(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

/** Every migration (in order), then `seed/0001_seed.sql`, then the local-only capability fence —
 * the same three steps a developer's local D1 has been through before `db:qa:apply` will run. */
export function freshFixtureDatabase(): SqliteDatabase {
  const db = openMemoryDatabase();
  const foreignKeys = db.prepare("PRAGMA foreign_keys;").get();
  if (Number(foreignKeys?.foreign_keys) !== 1) throw new Error("node:sqlite opened with foreign keys OFF — every FK assertion in these tests would be vacuous.");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter((value) => /^\d{4}_.*\.sql$/.test(value)).sort()) {
    db.exec(readFileSync(new URL(name, migrations), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  db.exec(readFileSync(new URL("../seed/0001_seed.sql", import.meta.url), "utf8"));
  db.exec(QA_FIXTURE_CAPABILITY_SQL);
  return db;
}

/** Same contract as `wranglerExecutor`: `query` returns the result rows of one statement, `run`
 * applies a batch of mutator statements atomically (local D1's `--file` execution is one batch),
 * `emit` returns the parsed JSON `emit.ts` would have printed. */
export function sqliteExecutor(db: SqliteDatabase): FixtureExecutor {
  return {
    query: (sql) => db.prepare(sql).all().map((row) => ({ ...row })),
    run: (statements) => {
      db.exec("BEGIN;");
      try {
        for (const statement of statements) db.exec(statement);
        db.exec("COMMIT;");
      } catch (error) {
        db.exec("ROLLBACK;");
        throw error;
      }
    },
    emit: (mode, args) => JSON.parse(JSON.stringify(emitMode(mode, args))),
  };
}

/** The teardown plan `cli.mjs` would build for this database: its own introspection SQL, run here,
 * through `teardown-graph.ts`'s own graph + plan builders. */
export function liveTeardownPlan(db: SqliteDatabase, runIds: readonly string[] = []) {
  const tables = db.prepare(INTROSPECT_TABLES_SQL).all().map((row) => ({ ...row })) as unknown as IntrospectedTable[];
  const foreignKeys = db.prepare(INTROSPECT_FOREIGN_KEYS_SQL).all().map((row) => ({ ...row })) as unknown as IntrospectedForeignKey[];
  const graph = buildTeardownGraph(tables, foreignKeys);
  return { tables, foreignKeys, graph, plan: buildTeardownPlan(graph, runIds) };
}
