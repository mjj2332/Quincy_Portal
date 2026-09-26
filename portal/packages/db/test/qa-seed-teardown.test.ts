/**
 * QA scheduling fixture — teardown coverage (#220 follow-on; Sol round 1 item 1, re-based onto the
 * graph-driven teardown in Sol round 2). Teardown no longer carries a table list at all: its plan is
 * derived from the LIVE foreign-key graph (`qa-seed/teardown-graph.ts`). These assertions are the
 * round-1 manifest assertions carried over one-for-one onto that plan, built here exactly the way
 * `cli.mjs` builds it — its own introspection SQL, run against a `node:sqlite` database made from the
 * real migrations — so "is this table covered, in the right order" is a question about the real
 * schema, not about a list someone remembered to update.
 *
 * One round-1 assertion is deliberately INVERTED, not dropped: `audit_log` used to be asserted to be
 * deleted by typed target (`target_type IN ('project', 'project_subtask')`). That typing was Sol
 * round 2's finding 2 — the app also audits comments, members, assets and more against fixture
 * rows — so it is now asserted to match ANY captured id, whatever the target_type.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { anchorReferenceInstantMs, buildQaFixtureDataset } from "../qa-seed/dataset";
import { buildApplyPlan, CAPABILITY_PREDICATE, FIXTURE_ENTITIES_TABLE } from "../qa-seed/sql";
import { buildTeardownGraph, FIXTURE_CLOSURE_TABLE, GRAPH_EXCLUDED_TABLES } from "../qa-seed/teardown-graph";
import { freshFixtureDatabase, liveTeardownPlan } from "./qa-seed-sqlite-executor";

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
const RUN_ID = "22222222-2222-5222-8222-222222222222";

// A non-empty defaultEditorIds so project_members rows actually exist to check below — an empty
// list would make "never writes project_members" trivially true for the wrong reason.
const dataset = buildQaFixtureDataset({ anchor: ANCHOR, tiers: ["core", "density"], appliedAtMs: APPLIED_AT_MS, defaultEditorIds: ["6b851dc8-14cf-4f90-bd29-ce6c27f86385"] });
const plan = buildApplyPlan(dataset, { runId: RUN_ID, appliedAtMs: 1_700_000_000_000, createdBy: "6b851dc8-14cf-4f90-bd29-ce6c27f86385", defaultEditorIds: ["6b851dc8-14cf-4f90-bd29-ce6c27f86385"] });

const db = freshFixtureDatabase();
const live = liveTeardownPlan(db, [RUN_ID]);
db.close();
const teardownPlan = live.plan;
const deleteOrder = teardownPlan.deleteOrder;
const mutators = [...teardownPlan.captureRootStatements, ...teardownPlan.captureRoundStatements, ...teardownPlan.deleteStatements, ...teardownPlan.registryStatements];
const allStatements = [...mutators, ...teardownPlan.remainingQueries, ...teardownPlan.sweepQueries, teardownPlan.closureCountQuery, teardownPlan.capturedCountsQuery, teardownPlan.overCaptureQuery];

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

const deleteStatementFor = (table: string) => teardownPlan.deleteStatements.filter((s) => s.startsWith(`DELETE FROM ${table} `));
const captureStatementsFor = (table: string) => teardownPlan.captureRoundStatements.filter((s) => s.includes(`\nSELECT '${table}', `));
const before = (child: string, parent: string) => {
  expect(deleteOrder.indexOf(child), `${child} is deleted`).toBeGreaterThanOrEqual(0);
  expect(deleteOrder.indexOf(parent), `${parent} is deleted`).toBeGreaterThanOrEqual(0);
  expect(deleteOrder.indexOf(child), `${child} before ${parent}`).toBeLessThan(deleteOrder.indexOf(parent));
};

describe("guard: the graph teardown covers every table with a plain project_id column — no exemptions", () => {
  const projectIdTables = tablesWithProjectIdColumn(schemaSource);
  const written = tablesWrittenByPlan(plan.statements);

  it("found a non-trivial set of project_id-bearing tables to check (schema.ts parsing didn't silently return nothing)", () => {
    expect(projectIdTables.length).toBeGreaterThan(15);
  });

  it.each(projectIdTables)("%s is reachable from the fixture roots and in the delete order — 'the generator doesn't write it' is not an exemption", (table) => {
    expect(deleteOrder).toContain(table);
  });

  it("the five tables the generator's own SQL actually inserts into are all in the delete order too", () => {
    expect(written.size).toBe(5);
    for (const table of written) expect(deleteOrder).toContain(table);
  });

  it("never touches project_board_order_0037_rollback — the migration's rollback snapshot, not the live board contract", () => {
    expect(GRAPH_EXCLUDED_TABLES).toContain("project_board_order_0037_rollback");
    expect(written.has("project_board_order_0037_rollback")).toBe(false);
    expect(live.tables.some((t) => t.name === "project_board_order_0037_rollback")).toBe(true); // it IS in the live schema…
    expect(live.graph.involved).not.toContain("project_board_order_0037_rollback"); // …and still excluded
    for (const statement of allStatements) expect(statement).not.toContain("project_board_order_0037_rollback");
  });

  it("stays excluded even if it had an FK edge into projects — excluded by name, not by happening to have no edges", () => {
    const withEdge = [...live.foreignKeys, { table: "project_board_order_0037_rollback", id: 0, seq: 0, from: "project_id", parent: "projects", to: "id", on_delete: "CASCADE" }];
    const tables = live.tables.map((t) => (t.name === "project_board_order_0037_rollback" && !t.columns.split(",").includes("project_id") ? { ...t, columns: `${t.columns},project_id` } : t));
    const graph = buildTeardownGraph(tables, withEdge);
    expect(graph.involved).not.toContain("project_board_order_0037_rollback");
    expect(graph.deleteOrder).not.toContain("project_board_order_0037_rollback");
  });

  it("deletes projects itself, last of all", () => {
    expect(deleteOrder.at(-1)).toBe("projects");
  });

  it("produces exactly one DELETE statement per table in the delete order", () => {
    for (const table of deleteOrder) expect(deleteStatementFor(table)).toHaveLength(1);
  });
});

describe("guard: the app-written surface (no registry id of its own) is captured through the graph from registered ids", () => {
  const APP_WRITTEN_NOT_GENERATOR_WRITTEN = [
    "notification_delivery_ledger", "notification_outbox", "project_comment_mentions", "project_comment_read_markers",
    "project_comments", "project_activity_events", "notifications", "audit_log", "jobs",
    "autohdr_path_claims", "autohdr_fetch_claims", "raw_reconciliation_claims", "autohdr_output_mappings",
    "autohdr_scaffold_claims", "autohdr_handoffs", "editor_folder_mappings", "publishes", "client_links",
    "document_uploads", "download_selection_tickets", "external_edited_upload_sessions",
    // Sol round 2: the three the round-1 hand list missed.
    "edited_source_claims", "rendition_dlq_events", "assets",
  ];

  it("the generator's own plan never INSERTs into any of these — they are purely app-written", () => {
    const written = tablesWrittenByPlan(plan.statements);
    for (const table of APP_WRITTEN_NOT_GENERATOR_WRITTEN) expect(written.has(table)).toBe(false);
  });

  it("every one of them is in the delete order", () => {
    for (const table of APP_WRITTEN_NOT_GENERATOR_WRITTEN) expect(deleteOrder).toContain(table);
  });

  it("every one of them has a capture statement and a DELETE keyed by the captured closure — never by LIKE/street", () => {
    for (const table of APP_WRITTEN_NOT_GENERATOR_WRITTEN) {
      expect(captureStatementsFor(table).length, `${table} captured`).toBeGreaterThan(0);
      expect(deleteStatementFor(table)[0]).toContain(FIXTURE_CLOSURE_TABLE);
    }
    for (const statement of mutators) {
      expect(statement).not.toMatch(/\bLIKE\b/);
      expect(statement).not.toContain("street");
    }
  });

  it("the closure's roots are exactly the registered ids, by kind", () => {
    const roots = teardownPlan.captureRootStatements.filter((s) => s.startsWith("INSERT"));
    expect(roots).toHaveLength(5);
    for (const statement of roots) expect(statement).toContain(`IN (SELECT id FROM ${FIXTURE_ENTITIES_TABLE} WHERE kind = '`);
  });
});

describe("guard: the no-plain-FK traps are ordered and captured by the graph, not by name", () => {
  it("notification_delivery_ledger is captured via its outbox_id FK and deleted before notification_outbox", () => {
    before("notification_delivery_ledger", "notification_outbox");
    expect(captureStatementsFor("notification_delivery_ledger").some((s) => s.includes("notification_delivery_ledger.outbox_id IN (") && s.includes("table_name = 'notification_outbox'"))).toBe(true);
  });

  it("notification_outbox (no FK at all) is captured via the no-FK list's project_id edge", () => {
    expect(captureStatementsFor("notification_outbox").some((s) => s.includes("notification_outbox.project_id IN (") && s.includes("table_name = 'projects'"))).toBe(true);
  });

  it("project_comment_mentions is captured via its comment_id FK and deleted before project_comments", () => {
    before("project_comment_mentions", "project_comments");
    expect(captureStatementsFor("project_comment_mentions").some((s) => s.includes("project_comment_mentions.comment_id IN (") && s.includes("table_name = 'project_comments'"))).toBe(true);
  });

  it("INVERTED from round 1: audit_log matches ANY captured id, whatever its target_type (Sol round 2, finding 2)", () => {
    const audit = captureStatementsFor("audit_log");
    expect(audit.some((s) => s.includes("audit_log.target_id IN (") && s.includes("WHERE entity_id IS NOT NULL)"))).toBe(true);
    for (const statement of [...audit, ...deleteStatementFor("audit_log")]) expect(statement).not.toContain("target_type");
  });

  it("rendition_dlq_events (no FK) is captured via asset_id -> assets (Sol round 2, finding 3)", () => {
    expect(captureStatementsFor("rendition_dlq_events").some((s) => s.includes("rendition_dlq_events.asset_id IN (") && s.includes("table_name = 'assets'"))).toBe(true);
  });

  it("edited_source_claims (RESTRICT to assets and autohdr_handoffs) is deleted before both (Sol round 2, finding 1)", () => {
    before("edited_source_claims", "assets");
    before("edited_source_claims", "autohdr_handoffs");
  });

  it("job-owning claim rows (autohdr_handoffs, autohdr_fetch_claims, raw_reconciliation_claims) are deleted before jobs", () => {
    for (const claimTable of ["autohdr_handoffs", "autohdr_fetch_claims", "raw_reconciliation_claims"]) before(claimTable, "jobs");
  });

  it("deletes project_deadline_occurrences before projects (cascade FK, but explicit anyway)", () => {
    before("project_deadline_occurrences", "projects");
  });

  it("document_uploads and external_edited_upload_sessions (both FK to collections too) are deleted before collections", () => {
    for (const table of ["document_uploads", "external_edited_upload_sessions"]) before(table, "collections");
  });

  it("every FK edge among involved tables is respected by the delete order (children first)", () => {
    for (const edge of live.graph.edges) {
      if (edge.kind !== "fk" || edge.child === edge.parent) continue;
      before(edge.child, edge.parent);
    }
  });
});

describe("guard: every teardown statement still carries the capability predicate, even the new ones", () => {
  it("every mutator statement in the graph plan contains the capability predicate", () => {
    expect(mutators.length).toBeGreaterThan(deleteOrder.length);
    for (const statement of mutators) expect(statement).toContain(CAPABILITY_PREDICATE);
  });

  it("the only literal ids any teardown statement inlines are canonical-UUID run ids", () => {
    const quotedUuids = mutators.flatMap((s) => [...s.matchAll(/'([0-9a-f]{8}-[0-9a-f-]{27})'/g)].map((m) => m[1]!));
    expect(new Set(quotedUuids)).toEqual(new Set([RUN_ID]));
  });
});
