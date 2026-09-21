/**
 * QA scheduling fixture — teardown schema inventory (#220 follow-on, Sol round 1 fix item 1). This
 * is the mirror image of `qa-seed-wiring.guard.test.ts`'s capability-predicate check: instead of
 * proving every generated mutator is guarded, this proves the *deletion manifest is complete* —
 * every drizzle table carrying a plain `project_id` column IS in `TEARDOWN_TABLES`, full stop.
 *
 * The old version let a table off the hook if "the dataset generator itself never inserts a row
 * there" — but the fixture exists so the APP can be exercised against it (#221's drag-to-reschedule,
 * checklist edits, comments), and the app's own write paths reach `audit_log`, `notification_outbox`,
 * `notification_delivery_ledger`, `jobs`, comments/mentions/read-markers, activity events, and
 * notifications against a fixture project — none of which the generator's own SQL ever touches.
 * "The generator doesn't write it" is no longer an acceptable exemption from being in the manifest.
 * Hand lists rot; this reads `schema.ts` itself so a new project-scoped table added in a future
 * migration fails this test the first time it is added, not the first time teardown silently leaks
 * a row.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { anchorReferenceInstantMs, buildQaFixtureDataset } from "../qa-seed/dataset";
import { buildApplyPlan, buildTeardownStatements, TEARDOWN_TABLES } from "../qa-seed/sql";

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

const ANCHOR = "2026-09-21";
const APPLIED_AT_MS = anchorReferenceInstantMs(ANCHOR);

// A non-empty defaultEditorIds so project_members rows actually exist to check below — an empty
// list would make "never writes project_members" trivially true for the wrong reason.
const dataset = buildQaFixtureDataset({ anchor: ANCHOR, tiers: ["core", "density"], appliedAtMs: APPLIED_AT_MS, defaultEditorIds: ["6b851dc8-14cf-4f90-bd29-ce6c27f86385"] });
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

describe("guard: the teardown manifest covers every table with a plain project_id column — no exemptions", () => {
  const projectIdTables = tablesWithProjectIdColumn(schemaSource);
  const written = tablesWrittenByPlan(plan.statements);

  it("found a non-trivial set of project_id-bearing tables to check (schema.ts parsing didn't silently return nothing)", () => {
    expect(projectIdTables.length).toBeGreaterThan(15);
  });

  it.each(projectIdTables)("%s is in the deletion manifest — 'the generator doesn't write it' is not an exemption", (table) => {
    expect(TEARDOWN_TABLES).toContain(table);
  });

  it("the five tables the generator's own SQL actually inserts into are all in the manifest too", () => {
    for (const table of written) expect(TEARDOWN_TABLES).toContain(table);
  });

  it("never touches project_board_order_0037_rollback — the migration's rollback snapshot, not the live board contract", () => {
    expect(written.has("project_board_order_0037_rollback")).toBe(false);
    expect(TEARDOWN_TABLES).not.toContain("project_board_order_0037_rollback");
  });

  it("deletes projects itself, last of all", () => {
    expect(TEARDOWN_TABLES.at(-1)).toBe("projects");
  });

  it("produces at least one non-empty DELETE statement per table in the manifest, given a non-empty registered project set", () => {
    const teardown = buildTeardownStatements(plan.entities, [plan.runId]);
    for (const table of TEARDOWN_TABLES) {
      expect(teardown.some((statement) => statement.includes(`DELETE FROM ${table} `) || statement.includes(`DELETE FROM ${table}\n`))).toBe(true);
    }
  });
});

describe("guard: the app-written surface (no registry id of its own) is torn down by project/subtask id, not by the generator's own inserts", () => {
  const APP_WRITTEN_NOT_GENERATOR_WRITTEN = [
    "notification_delivery_ledger", "notification_outbox", "project_comment_mentions", "project_comment_read_markers",
    "project_comments", "project_activity_events", "notifications", "audit_log", "jobs",
    "autohdr_path_claims", "autohdr_fetch_claims", "raw_reconciliation_claims", "autohdr_output_mappings",
    "autohdr_scaffold_claims", "autohdr_handoffs", "editor_folder_mappings", "publishes", "client_links",
    "document_uploads", "download_selection_tickets", "external_edited_upload_sessions",
  ];

  it("the generator's own plan never INSERTs into any of these — they are purely app-written", () => {
    const written = tablesWrittenByPlan(plan.statements);
    for (const table of APP_WRITTEN_NOT_GENERATOR_WRITTEN) expect(written.has(table)).toBe(false);
  });

  it("every one of them is still in TEARDOWN_TABLES", () => {
    for (const table of APP_WRITTEN_NOT_GENERATOR_WRITTEN) expect(TEARDOWN_TABLES).toContain(table);
  });

  it("every one of them gets a real DELETE statement keyed by registered project (or subtask) ids, given a non-empty registered set", () => {
    const teardown = buildTeardownStatements(plan.entities, [plan.runId]);
    for (const table of APP_WRITTEN_NOT_GENERATOR_WRITTEN) {
      const statementsForTable = teardown.filter((s) => s.startsWith(`DELETE FROM ${table} `));
      expect(statementsForTable.length).toBeGreaterThan(0);
      // Keyed only by registered ids (never LIKE/street) — the combined text for this table must
      // reference at least one real registered project id (or, for audit_log, a subtask id too).
      const combined = statementsForTable.join("\n");
      const referencesRegisteredProject = dataset.projects.some((project) => combined.includes(project.id));
      const referencesRegisteredSubtask = table === "audit_log" && dataset.subtasks.some((subtask) => combined.includes(subtask.id));
      expect(referencesRegisteredProject || referencesRegisteredSubtask).toBe(true);
    }
  });
});

describe("guard: the three no-plain-FK traps are handled by name, not left to introspection alone", () => {
  it("notification_delivery_ledger is deleted via the outbox rows' own project_id, before notification_outbox", () => {
    const teardown = buildTeardownStatements(plan.entities, [plan.runId]);
    const ledgerIndex = teardown.findIndex((s) => s.startsWith("DELETE FROM notification_delivery_ledger"));
    const outboxIndex = teardown.findIndex((s) => s.startsWith("DELETE FROM notification_outbox"));
    expect(ledgerIndex).toBeGreaterThanOrEqual(0);
    expect(outboxIndex).toBeGreaterThanOrEqual(0);
    expect(ledgerIndex).toBeLessThan(outboxIndex);
    expect(teardown[ledgerIndex]).toContain("SELECT id FROM notification_outbox WHERE project_id IN");
  });

  it("project_comment_mentions is deleted via the comment rows' own project_id, before project_comments", () => {
    const teardown = buildTeardownStatements(plan.entities, [plan.runId]);
    const mentionsIndex = teardown.findIndex((s) => s.startsWith("DELETE FROM project_comment_mentions"));
    const commentsIndex = teardown.findIndex((s) => s.startsWith("DELETE FROM project_comments "));
    expect(mentionsIndex).toBeGreaterThanOrEqual(0);
    expect(commentsIndex).toBeGreaterThanOrEqual(0);
    expect(mentionsIndex).toBeLessThan(commentsIndex);
    expect(teardown[mentionsIndex]).toContain("SELECT id FROM project_comments WHERE project_id IN");
  });

  it("audit_log is deleted by typed target (target_type/target_id), scoped to both project and project_subtask targets", () => {
    const teardown = buildTeardownStatements(plan.entities, [plan.runId]);
    const auditStatements = teardown.filter((s) => s.startsWith("DELETE FROM audit_log"));
    expect(auditStatements.some((s) => s.includes("target_type = 'project' "))).toBe(true);
    expect(auditStatements.some((s) => s.includes("target_type = 'project_subtask' "))).toBe(true);
  });

  it("job-owning claim rows (autohdr_handoffs, autohdr_fetch_claims, raw_reconciliation_claims) are deleted before jobs", () => {
    const teardown = buildTeardownStatements(plan.entities, [plan.runId]);
    const jobsIndex = teardown.findIndex((s) => s.startsWith("DELETE FROM jobs "));
    expect(jobsIndex).toBeGreaterThanOrEqual(0);
    for (const claimTable of ["autohdr_handoffs", "autohdr_fetch_claims", "raw_reconciliation_claims"]) {
      const claimIndex = teardown.findIndex((s) => s.startsWith(`DELETE FROM ${claimTable} `));
      expect(claimIndex).toBeGreaterThanOrEqual(0);
      expect(claimIndex).toBeLessThan(jobsIndex);
    }
  });

  it("deletes project_deadline_occurrences before projects (cascade FK, but explicit anyway)", () => {
    expect(TEARDOWN_TABLES.indexOf("project_deadline_occurrences")).toBeLessThan(TEARDOWN_TABLES.indexOf("projects"));
  });

  it("document_uploads and external_edited_upload_sessions (both FK to collections too) are deleted before collections", () => {
    for (const table of ["document_uploads", "external_edited_upload_sessions"]) {
      expect(TEARDOWN_TABLES.indexOf(table)).toBeLessThan(TEARDOWN_TABLES.indexOf("collections"));
    }
  });
});

describe("guard: every teardown statement still carries the capability predicate, even the new ones", () => {
  it("every statement produced for a non-empty registered project set contains the capability predicate", async () => {
    const { CAPABILITY_PREDICATE } = await import("../qa-seed/sql");
    const teardown = buildTeardownStatements(plan.entities, [plan.runId]);
    expect(teardown.length).toBeGreaterThan(0);
    for (const statement of teardown) expect(statement).toContain(CAPABILITY_PREDICATE);
  });
});
