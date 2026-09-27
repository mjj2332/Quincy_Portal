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
 *
 * Local D1 also runs SQLite with LOWERED limits, and a statement that is fine on stock SQLite can fail
 * there: `SQLITE_LIMIT_COMPOUND_SELECT` is 5 on local D1 (measured: a 5-term `UNION ALL` runs, a
 * 6-term one fails "too many terms in compound SELECT"), against stock SQLite's 500. `openMemoryDatabase`
 * applies every limit measured so far (`LOCAL_D1_LIMITS`), so a statement shape local D1 rejects fails
 * here too instead of only in a real `--persist-to` run.
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

/** SQLite limits local D1 lowers below stock SQLite's defaults, measured against a real local D1
 * (`wrangler d1 execute --local --persist-to <scratch>`), not taken from documentation. */
export const LOCAL_D1_LIMITS = { compoundSelect: 5 } as const;

/** A compound SELECT of `terms` single-row terms, e.g. `SELECT 1 UNION ALL SELECT 2`. */
function compoundSelectOf(terms: number): string {
  return Array.from({ length: terms }, (_, index) => `SELECT ${index + 1}`).join(" UNION ALL ");
}

/** The limits go in through the `DatabaseSync` constructor (Node >= 24.12). Older Node ignores the
 * option silently, so the probe proves the limit bites instead of trusting that it was set: a
 * statement exactly at the limit must run and one term over it must fail, as it does on local D1. */
export function openMemoryDatabase(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string, options: { limits: Record<string, number> }) => SqliteDatabase };
  const db = new sqlite.DatabaseSync(":memory:", { limits: { ...LOCAL_D1_LIMITS } });
  db.prepare(compoundSelectOf(LOCAL_D1_LIMITS.compoundSelect)).all();
  let overLimitRan = true;
  try {
    db.prepare(compoundSelectOf(LOCAL_D1_LIMITS.compoundSelect + 1)).all();
  } catch {
    overLimitRan = false;
  }
  if (overLimitRan) {
    throw new Error(`node:sqlite did not apply local D1's compoundSelect limit (${LOCAL_D1_LIMITS.compoundSelect}); the DatabaseSync limits option needs Node >= 24.12 (running ${process.version}).`);
  }
  return db;
}

export type SetupExecutor = {
  migrate: () => void;
  run: (sql: string, label: string) => void;
  runFile: (path: string, label: string) => void;
  query: (sql: string) => Row[];
};

/** `setup-local.mjs`'s `setupLocal` executor contract, against this SQLite instead of wrangler. */
export function sqliteSetupExecutor(db: SqliteDatabase): SetupExecutor {
  return {
    migrate: () => {
      const migrations = new URL("../migrations/", import.meta.url);
      for (const name of readdirSync(migrations).filter((value) => /^\d{4}_.*\.sql$/.test(value)).sort()) {
        db.exec(readFileSync(new URL(name, migrations), "utf8").replaceAll("--> statement-breakpoint", ""));
      }
    },
    run: (sql) => db.exec(sql),
    runFile: (path) => db.exec(readFileSync(path, "utf8")),
    query: (sql) => db.prepare(sql).all().map((row) => ({ ...row })),
  };
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
