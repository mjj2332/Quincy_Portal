/**
 * QA scheduling fixture — `apply` generates before it tears down (Sol round 3, fix item 1).
 *
 * `apply` replaces the previous fixture. If it tears the old one down FIRST, any throw while building
 * the replacement (the DST table, the anchor, an invariant round-trip) leaves the developer with no
 * fixture and a failed command. The dataset and its SQL are built and validated first; only then is
 * the previous fixture torn down and the new one written. Driven through `cli.mjs`'s own `apply` with
 * a `node:sqlite` executor whose `emit("plan")` throws — the generation step, via the executor seam.
 *
 * Out of scope here: a failure part-way through WRITING (`run`). On the real transport the statements
 * go out as several `--file` batches, which are not one transaction.
 */
import { describe, expect, it } from "vitest";
import { apply, verify } from "../qa-seed/cli.mjs";
import { freshFixtureDatabase, sqliteExecutor, type FixtureExecutor, type Row, type SqliteDatabase } from "./qa-seed-sqlite-executor";

const ANCHOR = "2026-09-21";
const APPLY_OPTIONS = { command: "apply", tier: undefined, anchor: ANCHOR, persistTo: undefined };
const VERIFY_OPTIONS = { command: "verify", tier: undefined, anchor: undefined, persistTo: undefined };

function snapshot(db: SqliteDatabase): Record<string, Row[]> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name;").all().map((row) => String(row.name));
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid;`).all().map((row) => ({ ...row }))]));
}

function failingGeneration(executor: FixtureExecutor): FixtureExecutor {
  return {
    ...executor,
    emit: (mode, args) => {
      if (mode === "plan") throw new Error("injected generation failure");
      return executor.emit(mode, args);
    },
  };
}

describe("fix item 1: apply builds the replacement before tearing down the previous fixture", () => {
  it("a generation failure on re-apply leaves the previous fixture intact, byte for byte, and still verifying", () => {
    const db = freshFixtureDatabase();
    const executor = sqliteExecutor(db);
    apply(executor, APPLY_OPTIONS);
    const before = snapshot(db);
    expect(before["projects"]!.filter((row) => String(row.notes).startsWith("QA-FIXTURE-v1")).length).toBeGreaterThan(0);

    expect(() => apply(failingGeneration(executor), APPLY_OPTIONS)).toThrow(/injected generation failure/);

    expect(snapshot(db)).toEqual(before);
    expect(() => verify(executor, VERIFY_OPTIONS)).not.toThrow();
    db.close();
  });
});
