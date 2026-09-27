/**
 * QA fixture verify — the column-coverage guard (Sol round 3, finding 3). `verify` used to compare a
 * column set read off the generator's own fingerprint rows, so a column the fingerprint forgot
 * (`project_subtasks.due_reminder_sent_at`) was never compared — the same class of bug the teardown
 * table list had. `verify` now derives each fingerprinted table's columns from the live table and
 * compares every one except `VERIFY_EXCLUDED_COLUMNS`, each entry of which carries a reason. This
 * guard fails when a column of a table `apply` writes is neither compared nor excluded, against the
 * MIGRATED schema in the `node:sqlite` harness (not `schema.ts`, which can diverge from it).
 */
import { describe, expect, it } from "vitest";
import { VERIFY_DIFF_TABLES, VERIFY_EXCLUDED_COLUMNS } from "../qa-seed/cli.mjs";
import { anchorReferenceInstantMs, BOOTSTRAP_ADMIN_ID, buildQaFixtureDataset } from "../qa-seed/dataset";
import {
  buildApplyPlan, buildVerificationManifest, CAPABILITY_TABLE, FIXTURE_BOARD_POSITIONS_TABLE, FIXTURE_ENTITIES_TABLE, FIXTURE_RUN_RECORDS_TABLE, FIXTURE_RUNS_TABLE,
  type VerificationManifest,
} from "../qa-seed/sql";
import { freshFixtureDatabase, type SqliteDatabase } from "./qa-seed-sqlite-executor";

const ANCHOR = "2026-09-21";
const EDITOR = "0f3c9a4e-7b1d-4c2e-9a5f-1d2e3f4a5b6c";
const RUN_ID = "11111111-1111-4111-8111-111111111111";

const dataset = buildQaFixtureDataset({ anchor: ANCHOR, tiers: ["core", "density"], appliedAtMs: anchorReferenceInstantMs(ANCHOR), defaultEditorIds: [EDITOR] });
const manifest = buildVerificationManifest(dataset, { createdBy: BOOTSTRAP_ADMIN_ID, boardPositions: Object.fromEntries(dataset.projects.map((p) => [p.id, 0])) });
const plan = buildApplyPlan(dataset, { runId: RUN_ID, appliedAtMs: anchorReferenceInstantMs(ANCHOR), createdBy: BOOTSTRAP_ADMIN_ID, defaultEditorIds: [EDITOR] });

type DiffTable = { table: string; manifestKey: keyof VerificationManifest };
const diffTables = VERIFY_DIFF_TABLES as readonly DiffTable[];
const excluded = VERIFY_EXCLUDED_COLUMNS as Readonly<Record<string, string>>;

function liveColumns(db: SqliteDatabase, table: string): string[] {
  return db.prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid;`).all().map((row) => String(row.name));
}

/** `table.column` for every live column of a fingerprinted table that is neither in the generator's
 * fingerprint nor excluded — what `verify` would refuse. */
function uncoveredColumns(db: SqliteDatabase): string[] {
  const out: string[] = [];
  for (const { table, manifestKey } of diffTables) {
    const rows = (manifest[manifestKey] as { rows: Record<string, Record<string, unknown>> }).rows;
    const fingerprinted = new Set(Object.keys(Object.values(rows)[0] ?? {}));
    for (const column of liveColumns(db, table)) {
      if (!fingerprinted.has(column) && !(`${table}.${column}` in excluded)) out.push(`${table}.${column}`);
    }
  }
  return out.sort();
}

describe("guard: every column of every table apply writes is compared by verify, or excluded with a reason", () => {
  it("every table apply inserts into (outside the reserved local tables) is fingerprinted by verify", () => {
    const reserved = new Set([CAPABILITY_TABLE, FIXTURE_RUNS_TABLE, FIXTURE_ENTITIES_TABLE, FIXTURE_RUN_RECORDS_TABLE, FIXTURE_BOARD_POSITIONS_TABLE]);
    const written = new Set([...plan.statements.join("\n").matchAll(/INSERT INTO ([a-z_0-9]+)/g)].map((m) => m[1]!).filter((t) => !reserved.has(t)));
    expect(written.size).toBeGreaterThanOrEqual(5);
    expect([...written].filter((table) => !diffTables.some((d) => d.table === table))).toEqual([]);
  });

  it("the manifest has expected rows for every fingerprinted table (so the key check below is not vacuous)", () => {
    for (const { table, manifestKey } of diffTables) {
      expect(Object.keys((manifest[manifestKey] as { rows: object }).rows).length, `${table} expected rows`).toBeGreaterThan(0);
    }
  });

  it("no live column of a fingerprinted table is neither compared nor excluded", () => {
    const db = freshFixtureDatabase();
    expect(uncoveredColumns(db)).toEqual([]);
    db.close();
  });

  it("no fingerprint key names a column the live table does not have (a stale fingerprint)", () => {
    const db = freshFixtureDatabase();
    for (const { table, manifestKey } of diffTables) {
      const live = new Set(liveColumns(db, table));
      const rows = (manifest[manifestKey] as { rows: Record<string, Record<string, unknown>> }).rows;
      expect(Object.keys(Object.values(rows)[0]!).filter((column) => !live.has(column)), table).toEqual([]);
    }
    db.close();
  });

  it("every exclusion names a live column of a fingerprinted table, carries a written reason, and is not also fingerprinted", () => {
    const db = freshFixtureDatabase();
    for (const [key, reason] of Object.entries(excluded)) {
      const [table, column] = key.split(".");
      const diff = diffTables.find((d) => d.table === table);
      expect(diff, `${key}: table is fingerprinted`).toBeDefined();
      expect(liveColumns(db, table!), `${key}: column exists`).toContain(column);
      expect(reason.trim().length, `${key}: reason`).toBeGreaterThan(20);
      const rows = (manifest[diff!.manifestKey] as { rows: Record<string, Record<string, unknown>> }).rows;
      expect(Object.keys(Object.values(rows)[0]!), `${key}: not also fingerprinted`).not.toContain(column);
    }
    db.close();
  });

  it("the guard fires on a column a migration adds — it cannot pass vacuously", () => {
    const db = freshFixtureDatabase();
    db.exec("ALTER TABLE project_deadline_occurrences ADD COLUMN qa_probe integer;");
    expect(uncoveredColumns(db)).toEqual(["project_deadline_occurrences.qa_probe"]);
    db.close();
  });
});
