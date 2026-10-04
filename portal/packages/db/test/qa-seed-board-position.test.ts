/**
 * #475 (Board order Stage B): the QA fixture generator is a writer too. A fixture project insert must omit
 * `board_position` (the column's DEFAULT 0 lands) instead of computing the old append-to-bottom subquery.
 */
import { describe, expect, it } from "vitest";
import { apply } from "../qa-seed/cli.mjs";
import { anchorReferenceInstantMs, BOOTSTRAP_ADMIN_ID, buildQaFixtureDataset } from "../qa-seed/dataset";
import { buildApplyPlan } from "../qa-seed/sql";
import { freshFixtureDatabase, sqliteExecutor } from "./qa-seed-sqlite-executor";

describe("qa-seed no longer writes board_position (#475)", () => {
  it("applying the fixture leaves every fixture project at the column default, in every stage", () => {
    const db = freshFixtureDatabase();
    apply(sqliteExecutor(db), { command: "apply", tier: undefined, anchor: "2026-09-21", persistTo: undefined });
    const rows = db.prepare("SELECT stage_key, board_position FROM projects;").all();
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.filter((row) => Number(row.board_position) !== 0)).toEqual([]);
    db.close();
  });

  it("the generated project INSERT names no board_position column and no append subquery", () => {
    const dataset = buildQaFixtureDataset({ anchor: "2026-09-21", tiers: ["core", "density"], appliedAtMs: anchorReferenceInstantMs("2026-09-21"), defaultEditorIds: [] });
    const plan = buildApplyPlan(dataset, { runId: "11111111-1111-4111-8111-111111111111", appliedAtMs: anchorReferenceInstantMs("2026-09-21"), createdBy: BOOTSTRAP_ADMIN_ID, defaultEditorIds: [] });
    const inserts = plan.statements.filter((statement) => /^INSERT INTO projects\b/.test(statement));
    expect(inserts.length).toBeGreaterThan(5);
    for (const statement of inserts) expect(statement).not.toMatch(/board_position|MAX\(/);
  });
});
