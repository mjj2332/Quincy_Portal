/**
 * QA scheduling fixture — apply → verify → teardown, end to end, through `cli.mjs`'s own exported
 * orchestration against a `node:sqlite` database built from the real migrations (see
 * `qa-seed-sqlite-executor.ts`). The baseline every other qa-seed integration test builds on: an
 * untouched apply verifies clean, and teardown returns the database to exactly its pre-apply rows.
 */
import { describe, expect, it } from "vitest";
import { apply, assertCapabilityPresent, teardown, verify } from "../qa-seed/cli.mjs";
import { freshFixtureDatabase, sqliteExecutor, type SqliteDatabase } from "./qa-seed-sqlite-executor";

const ANCHOR = "2026-09-21";

function tableNames(db: SqliteDatabase): string[] {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name;").all().map((row) => String(row.name));
}

function snapshot(db: SqliteDatabase): Record<string, string[]> {
  return Object.fromEntries(tableNames(db).map((table) => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid;`).all().map((row) => JSON.stringify(row))]));
}

describe("qa-seed round trip through cli.mjs's own orchestration (node:sqlite transport)", () => {
  it("applies, verifies clean, and tears down to the exact pre-apply database", () => {
    const db = freshFixtureDatabase();
    const executor = sqliteExecutor(db);
    assertCapabilityPresent(executor);
    const before = snapshot(db);

    apply(executor, { command: "apply", tier: undefined, anchor: ANCHOR, persistTo: undefined });
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM projects;").get()?.n)).toBeGreaterThan(5);
    expect(() => verify(executor, { command: "verify", tier: undefined, anchor: undefined, persistTo: undefined })).not.toThrow();

    teardown(executor);
    expect(snapshot(db)).toEqual(before);
    db.close();
  });
});
