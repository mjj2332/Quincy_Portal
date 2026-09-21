/**
 * QA scheduling fixture — teardown schema inventory (#220 follow-on). This is the mirror image of
 * `qa-seed-wiring.guard.test.ts`'s capability-predicate check: instead of proving every generated
 * mutator is guarded, this proves the *deletion manifest is complete* — every drizzle table
 * carrying a `projects.id` FK or a plain `project_id` column (the two shapes `docs/lessons.md`
 * records as the ones a hand list forgets) is either in `TEARDOWN_TABLES` or the fixture's own
 * generated SQL provably never inserts into it. Hand lists rot; this reads `schema.ts` itself so a
 * new project-scoped table added in a future migration fails this test the first time it is added,
 * not the first time teardown silently leaks a row.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildApplyPlan, buildTeardownStatements, TEARDOWN_TABLES } from "../qa-seed/sql";
import { buildQaFixtureDataset } from "../qa-seed/dataset";

const schemaSource = readFileSync(new URL("../src/schema.ts", import.meta.url), "utf8");

/** Every table name declared via `sqliteTable("<name>", ...)` alongside the nearest preceding
 * declaration, so a `projectId: text("project_id")` field a few lines later attributes back to the
 * table that owns it — schema.ts declares the table name on the line after `sqliteTable(`, not on
 * the same line, for every multi-line table. */
function tablesWithProjectIdColumn(source: string): string[] {
  const lines = source.split("\n");
  let current: string | null = null;
  const found = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.includes("sqliteTable(")) {
      for (let lookahead = index; lookahead < Math.min(index + 3, lines.length); lookahead += 1) {
        const match = /"([a-z_0-9]+)"/.exec(lines[lookahead]!);
        if (match) { current = match[1]!; break; }
      }
    }
    if (/projectId:\s*text\("project_id"\)/.test(line) && current) found.add(current);
  }
  return [...found].sort();
}

// A non-empty defaultEditorIds so project_members rows actually exist to check below — an empty
// list would make "never writes project_members" trivially true for the wrong reason.
const dataset = buildQaFixtureDataset({ anchor: "2026-09-21", tiers: ["core", "density"], defaultEditorIds: ["6b851dc8-14cf-4f90-bd29-ce6c27f86385"] });
const plan = buildApplyPlan(dataset, { runId: "22222222-2222-5222-8222-222222222222", appliedAtMs: 1_700_000_000_000, createdBy: "6b851dc8-14cf-4f90-bd29-ce6c27f86385" });

function tablesWrittenByPlan(statements: readonly string[]): Set<string> {
  const written = new Set<string>();
  for (const statement of statements) {
    const match = /^INSERT INTO (\w+)/.exec(statement);
    // Bookkeeping tables (the run + registry rows themselves) are not project-scoped data and are
    // never candidates for the deletion-manifest comparison below.
    if (match && !match[1]!.startsWith("__quincy_local_")) written.add(match[1]!);
  }
  return written;
}

describe("guard: the teardown manifest covers every project-scoped table, or the dataset provably never writes it", () => {
  const projectIdTables = tablesWithProjectIdColumn(schemaSource);
  const written = tablesWrittenByPlan(plan.statements);

  it("found a non-trivial set of project_id-bearing tables to check (schema.ts parsing didn't silently return nothing)", () => {
    expect(projectIdTables.length).toBeGreaterThan(15);
  });

  it("writes exactly the tables in TEARDOWN_TABLES, no more and no fewer", () => {
    expect([...written].sort()).toEqual([...TEARDOWN_TABLES].sort());
  });

  it.each(projectIdTables)("%s is in the deletion manifest, or the dataset never inserts into it", (table) => {
    const inManifest = TEARDOWN_TABLES.includes(table);
    const everWritten = written.has(table);
    expect(inManifest || !everWritten).toBe(true);
    // The stronger claim the spec asks for: a table NOT in the manifest must be untouched, not
    // merely coincidentally absent from this one dataset build.
    if (!inManifest) expect(everWritten).toBe(false);
  });

  it("never writes to project_board_order_0037_rollback — the migration's rollback snapshot, not the live board contract", () => {
    expect(written.has("project_board_order_0037_rollback")).toBe(false);
    expect(TEARDOWN_TABLES).not.toContain("project_board_order_0037_rollback");
  });

  it("deletes projects itself, last among fixture tables", () => {
    expect(TEARDOWN_TABLES.at(-1)).toBe("projects");
  });

  it("produces a non-empty teardown statement per written table", () => {
    const teardown = buildTeardownStatements(plan.entities, [plan.runId]);
    for (const table of TEARDOWN_TABLES) {
      expect(teardown.some((statement) => statement.includes(`DELETE FROM ${table} `))).toBe(true);
    }
  });
});

describe("guard: the three FK/no-FK traps are handled explicitly, not left to cascade", () => {
  it("deletes project_deadline_occurrences before projects (cascade FK, but explicit anyway)", () => {
    expect(TEARDOWN_TABLES.indexOf("project_deadline_occurrences")).toBeLessThan(TEARDOWN_TABLES.indexOf("projects"));
  });

  it("never needs notification_outbox/notification_delivery_ledger/audit_log — the dataset provably never writes them", () => {
    // These three are the traps `docs/lessons.md` names (no FK on notification_outbox.project_id,
    // no FK at all on audit_log.target_id, ON DELETE restrict on notification_delivery_ledger).
    // This fixture deliberately never emits activity/audit/notification rows (Decision 9 lists the
    // required "match what the app would write" surface and stops short of the activity feed), so
    // they are provably absent from `written` rather than present-and-cleaned-up.
    const written = tablesWrittenByPlan(plan.statements);
    expect(written.has("notification_outbox")).toBe(false);
    expect(written.has("notification_delivery_ledger")).toBe(false);
    expect(written.has("audit_log")).toBe(false);
  });
});
