import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BOARD_SCHEMA_MARKER_SQL, boardSchemaVariant, projectColumnsForVariant } from "../src";

type SqliteStatement = { get: (...values: unknown[]) => unknown };
type SqliteDatabase = { exec: (source: string) => void; prepare: (source: string) => SqliteStatement; close: () => void };
const BREAKPOINT = "--> statement-breakpoint";

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

function migrationNames(): string[] {
  const directory = new URL("../migrations/", import.meta.url);
  return readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value))
    .sort((left, right) => Number(left.slice(0, 4)) - Number(right.slice(0, 4)));
}

function applyThrough0036(db: SqliteDatabase): void {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of migrationNames().filter((value) => Number(value.slice(0, 4)) <= 36)) {
    const source = readFileSync(new URL(name, directory), "utf8");
    for (const segment of source.split(BREAKPOINT).map((value) => value.trim()).filter(Boolean)) db.exec(segment);
  }
}

function sourceFiles(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(entry.name, directory);
    if (entry.isDirectory()) return sourceFiles(new URL(`${entry.name}/`, directory));
    return entry.name.endsWith(".ts") ? [child] : [];
  });
}

function deferredMarkerD1(calls: string[]): { database: D1Database; release: () => void } {
  let release!: () => void;
  const marker = new Promise<{ tb5a_0037_exists: number }>((resolve) => {
    release = () => resolve({ tb5a_0037_exists: 0 });
  });
  const database = {
    prepare(source: string) {
      calls.push(source);
      return { first: async <T>() => marker as T } as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
  return { database, release };
}

function sqliteD1(sqlite: SqliteDatabase, calls: string[]): D1Database {
  return {
    prepare(source: string) {
      calls.push(source);
      return {
        first: async <T>() => (sqlite.prepare(source).get() as T | undefined) ?? null,
      } as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

describe("TB5A board schema variant", () => {
  it("detects a real 0036 database with only the old-schema-safe marker query", async () => {
    const sqlite = localSqlite();
    applyThrough0036(sqlite);
    expect(() => sqlite.prepare("SELECT board_revision FROM projects").get()).toThrow();

    const calls: string[] = [];
    const database = sqliteD1(sqlite, calls);
    await expect(boardSchemaVariant(database)).resolves.toBe("pre_0037");
    await expect(boardSchemaVariant(database)).resolves.toBe("pre_0037");
    expect(calls).toEqual([BOARD_SCHEMA_MARKER_SQL, BOARD_SCHEMA_MARKER_SQL]);
    expect(Object.hasOwn(projectColumnsForVariant("pre_0037"), "boardRevision")).toBe(false);
    sqlite.close();
  });

  it("does not prepare a post-marker statement before the marker completes", async () => {
    const calls: string[] = [];
    const { database, release } = deferredMarkerD1(calls);
    const pending = boardSchemaVariant(database);
    await Promise.resolve();
    expect(calls).toEqual([BOARD_SCHEMA_MARKER_SQL]);
    release();
    const variant = await pending;
    expect(variant).toBe("pre_0037");
    expect(calls).toEqual([BOARD_SCHEMA_MARKER_SQL]);
    expect(Object.hasOwn(projectColumnsForVariant(variant), "boardRevision")).toBe(false);
  });

  it("keeps every audited full-project read behind an explicit variant projection", () => {
    const appProjects = readFileSync(new URL("../../../workers/app/src/routes/projects.ts", import.meta.url), "utf8");
    const tonomo = readFileSync(new URL("../../../workers/background/src/tonomo/process.ts", import.meta.url), "utf8");
    for (const sourceUrl of [
      ...sourceFiles(new URL("../../../workers/app/src/", import.meta.url)),
      ...sourceFiles(new URL("../../../workers/background/src/", import.meta.url)),
    ]) {
      const source = readFileSync(sourceUrl, "utf8");
      expect(source).not.toMatch(/\.select\(\s*\)\s*\.from\(\s*(?:schema\.)?projects\s*\)/);
      expect(source).not.toMatch(/select\(\s*\{\s*project\s*:\s*(?:schema\.)?projects\s*(?:[,}])/);
    }
    expect(appProjects.indexOf("const variant = await boardSchemaVariant(c.env.DB)"))
      .toBeGreaterThanOrEqual(0);
    expect(tonomo.indexOf("const variant = await boardSchemaVariant(env.DB)"))
      .toBeLessThan(tonomo.indexOf("const match = await findProject(env, order, variant)"));
  });
});
