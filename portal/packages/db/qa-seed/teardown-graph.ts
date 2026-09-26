/**
 * QA scheduling fixture — teardown driven by the LIVE foreign-key graph (Sol round 2, findings 1-3).
 * Pure: never spawns, never touches a database. `cli.mjs` introspects the live local D1
 * (`sqlite_master` / `pragma_table_list` / `pragma_table_info` / `pragma_foreign_key_list`), hands the
 * rows to `buildTeardownGraph` (via `emit.ts teardown-plan`), and runs the statements
 * `buildTeardownPlan` returns.
 *
 * Twice this fixture's teardown was a hand-maintained table list, and twice a review found tables it
 * missed (the RESTRICT `edited_source_claims` FKs; `audit_log` rows for target types other than
 * project/subtask; `rendition_dlq_events`). This module replaces that list with the schema itself:
 *
 *  1. **Graph.** Every live table except SQLite's own, wrangler's `_cf_*`, D1's migration ledger,
 *     this fixture's reserved `__quincy_local_*` tables and `project_board_order_0037_rollback`
 *     (asserted excluded, not assumed edge-free). Edges are every FK the live database reports, plus
 *     the ONE remaining hand-written list — `NO_FK_ID_COLUMNS`, columns that hold an entity id without
 *     an FK. `qa-seed-no-fk-columns.guard.test.ts` scans `schema.ts` so a new unreferenced id column
 *     cannot join the schema without being classified.
 *  2. **Capture before delete.** Starting from the registered fixture roots, every row reachable
 *     child-ward along any edge is recorded (table, rowid, id) in `FIXTURE_CLOSURE_TABLE`, round after
 *     round until a round adds nothing — any depth, and self-references (`assets.supersedes_asset_id`)
 *     terminate because `INSERT OR IGNORE` re-captures nothing new.
 *  3. **Delete** in reverse topological order of the FK edges among captured tables — children first,
 *     so RESTRICT/NO ACTION never fire and nothing relies on local-vs-remote cascade behaviour.
 *  4. **`audit_log`** (and every other polymorphic `*` column) matches ANY captured id, whatever its
 *     `target_type`.
 *  5. **Sweep.** After deleting: every captured row is gone, and no column that can hold a captured id
 *     (every FK edge and every no-FK column) still holds one.
 *
 * Every mutator statement carries the capability predicate. Every identifier interpolated here was
 * discovered by introspection and is validated against `SAFE_IDENTIFIER_RE` first; no row id is ever
 * interpolated (the closure is joined by subquery), and the only literal ids — run ids — are
 * canonical-UUID-validated.
 */
import { CAPABILITY_PREDICATE, FIXTURE_BOARD_POSITIONS_TABLE, FIXTURE_ENTITIES_TABLE, FIXTURE_RUN_RECORDS_TABLE, FIXTURE_RUNS_TABLE, sqlId, type FixtureEntityKind } from "./sql";

export const FIXTURE_CLOSURE_TABLE = "__quincy_local_fixture_closure";

/** Identical to `cli.mjs`'s own literal; `qa-seed-wiring.guard.test.ts` cross-checks the two. */
export const SAFE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Registry kind → the table its registered ids live in. These are the closure's ROOTS, not a
 * teardown table list: everything else is found by walking the graph from them. */
export const REGISTRY_ROOT_TABLES: Readonly<Record<FixtureEntityKind, string>> = {
  project: "projects",
  subtask: "project_subtasks",
  collection: "collections",
  deadline_occurrence: "project_deadline_occurrences",
  member: "project_members",
};

/** Never part of the graph. `project_board_order_0037_rollback` is migration 0037's own rollback
 * snapshot, which predates any fixture row — excluded by name and asserted, never inferred from it
 * happening to have no FK edges. `d1_migrations` is D1's migration ledger. */
export const GRAPH_EXCLUDED_TABLES: readonly string[] = ["project_board_order_0037_rollback", "d1_migrations"];
const RESERVED_PREFIX = "__quincy_local_";

export type NoFkColumn = {
  table: string;
  column: string;
  /** The table whose `id` this column holds, or `"*"` for a polymorphic column (any captured id). */
  references: string;
  evidence: string;
};

/**
 * The one hand-written list that remains: columns holding an entity id with NO foreign key, so
 * `pragma_foreign_key_list` can never discover them. Each is an edge exactly like an FK — a row whose
 * column holds a captured row's id is itself captured — and each is swept after deletion. Every entry
 * cites where the app reads or writes the column as that reference. Kept small and named; the
 * schema-scan guard fails on any `*_id`/`*Id` column in `schema.ts` without `.references()` that is
 * neither here nor in that guard's justified "not an entity reference" allowlist.
 */
export const NO_FK_ID_COLUMNS: readonly NoFkColumn[] = [
  { table: "audit_log", column: "target_id", references: "*", evidence: "polymorphic by target_type — every audit(...) / INSERT INTO audit_log in workers/" },
  { table: "project_activity_events", column: "source_id", references: "*", evidence: "polymorphic by source_kind — packages/db/src/project-activity.ts" },
  { table: "notification_outbox", column: "project_id", references: "projects", evidence: "notification-delivery.ts checks projectId !== outbox.project_id before delivering" },
  { table: "notification_outbox", column: "recipient_membership_cycle_id", references: "project_members", evidence: "notification-delivery.ts: JOIN project_members member ON member.id = o.recipient_membership_cycle_id" },
  { table: "notification_outbox", column: "actor_id", references: "user", evidence: "notification actor user id" },
  { table: "notification_outbox", column: "recipient_id", references: "user", evidence: "notification recipient user id" },
  { table: "notification_delivery_ledger", column: "recipient_id", references: "user", evidence: "delivery recipient user id" },
  { table: "project_activity_events", column: "actor_id", references: "user", evidence: "actor_kind = 'user' ⇒ a user id" },
  { table: "rendition_dlq_events", column: "asset_id", references: "assets", evidence: "workers/app/src/routes/admin.ts rendition DLQ replay reads the asset by it" },
  { table: "projects", column: "cover_asset_id", references: "assets", evidence: "routes/projects.ts project.cover.set" },
  { table: "project_comment_read_markers", column: "last_read_comment_id", references: "project_comments", evidence: "read marker's last-read comment" },
  { table: "document_uploads", column: "pdf_asset_id", references: "assets", evidence: "routes/collections.ts responseFor(upload): { id: upload.pdfAssetId }" },
  { table: "document_uploads", column: "preview_asset_id", references: "assets", evidence: "routes/collections.ts responseFor(upload): { id: upload.previewAssetId }" },
  { table: "document_uploads", column: "pdf_supersedes_asset_id", references: "assets", evidence: "the asset version the uploaded PDF supersedes" },
  { table: "document_uploads", column: "preview_supersedes_asset_id", references: "assets", evidence: "the asset version the uploaded preview supersedes" },
  { table: "document_uploads", column: "completion_audit_id", references: "audit_log", evidence: "routes/collections.ts inserts audit_log with id = upload.completionAuditId" },
  { table: "assets", column: "supersedes_asset_id", references: "assets", evidence: "asset version chain (self-reference)" },
  { table: "assets", column: "replaced_by_asset_id", references: "assets", evidence: "asset version chain (self-reference)" },
  { table: "assets", column: "source_raw_asset_id", references: "assets", evidence: "edited asset's source RAW asset (self-reference)" },
  { table: "assets", column: "autohdr_handoff_id", references: "autohdr_handoffs", evidence: "AutoHDR final imported under a handoff" },
  { table: "external_edited_upload_sessions", column: "asset_id", references: "assets", evidence: "routes/external-uploads.ts reads schema.assets by session.assetId" },
  { table: "external_edited_upload_sessions", column: "membership_cycle_id", references: "project_members", evidence: "external-upload-sweep.ts: INNER JOIN project_members pm ON pm.id = s.membership_cycle_id" },
  { table: "notice_board_read_markers", column: "last_read_post_id", references: "notice_board_posts", evidence: "read marker's last-read notice-board post" },
];

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

/** One row of `cli.mjs`'s table introspection query. `columns` is a comma list. */
export type IntrospectedTable = { name: string; without_rowid: number; columns: string };
/** One row of `cli.mjs`'s FK introspection query (`pragma_foreign_key_list` joined per table). */
export type IntrospectedForeignKey = { table: string; id: number; seq: number; from: string; parent: string; to: string | null; on_delete: string };

export type GraphEdge = { child: string; column: string; parent: string; kind: "fk" | "no-fk"; onDelete: string | null };
export type TeardownGraph = {
  /** Tables reachable from a registry root — the only tables capture, deletion and sweep touch. */
  involved: string[];
  /** Tables that carry an `id` column (their captured ids are what `*` columns and FKs match). */
  withId: string[];
  /** Every edge whose parent is involved (or `*`). */
  edges: GraphEdge[];
  /** Involved tables, children before parents. */
  deleteOrder: string[];
};

function identifier(value: unknown, describe: string): string {
  if (typeof value !== "string" || !SAFE_IDENTIFIER_RE.test(value)) {
    throw new Error(`Refusing to interpolate a non-identifier-shaped ${describe} discovered via schema introspection: ${JSON.stringify(value)}`);
  }
  return value;
}

function isExcluded(table: string): boolean {
  return table.startsWith("sqlite_") || table.startsWith("_cf_") || table.startsWith(RESERVED_PREFIX) || GRAPH_EXCLUDED_TABLES.includes(table);
}

const ROWID_ALIASES = new Set(["rowid", "oid", "_rowid_"]);

export function buildTeardownGraph(tables: readonly IntrospectedTable[], foreignKeys: readonly IntrospectedForeignKey[]): TeardownGraph {
  const columnsByTable = new Map<string, Set<string>>();
  const withoutRowid = new Set<string>();
  for (const row of tables) {
    const name = identifier(row.name, "table name");
    if (isExcluded(name)) continue;
    const columns = String(row.columns ?? "").split(",").filter(Boolean).map((c) => identifier(c, `column of ${name}`));
    columnsByTable.set(name, new Set(columns));
    if (Number(row.without_rowid) !== 0) withoutRowid.add(name);
  }
  for (const root of Object.values(REGISTRY_ROOT_TABLES)) {
    if (!columnsByTable.has(root)) throw new Error(`Registry root table ${root} is missing from the live schema.`);
  }

  // FK edges, as the live database reports them.
  const fkGroups = new Map<string, IntrospectedForeignKey[]>();
  for (const fk of foreignKeys) {
    const child = identifier(fk.table, "FK child table");
    if (isExcluded(child)) continue;
    const key = `${child}#${fk.id}`;
    fkGroups.set(key, [...(fkGroups.get(key) ?? []), fk]);
  }
  const edges: GraphEdge[] = [];
  for (const group of fkGroups.values()) {
    const fk = group[0]!;
    const child = identifier(fk.table, "FK child table");
    const parent = identifier(fk.parent, "FK parent table");
    const column = identifier(fk.from, "FK column");
    if (isExcluded(parent)) continue;
    if (group.length > 1) throw new Error(`Composite foreign key ${child}(${group.map((g) => g.from).join(", ")}) → ${parent} is not supported by the graph teardown; extend teardown-graph.ts before relying on it.`);
    // `to` is NULL when the FK names only the parent table (its primary key); the closure keys on `id`.
    const target = fk.to === null || fk.to === undefined ? "id" : identifier(fk.to, "FK target column");
    if (target !== "id") throw new Error(`Foreign key ${child}.${column} → ${parent}.${target} targets a column other than id; the graph teardown keys captured rows on id. Extend teardown-graph.ts before relying on it.`);
    if (!columnsByTable.get(parent)?.has("id")) throw new Error(`Foreign key ${child}.${column} → ${parent}.id, but ${parent} has no id column.`);
    edges.push({ child, column, parent, kind: "fk", onDelete: String(fk.on_delete ?? "NO ACTION").toUpperCase() });
  }

  // No-FK edges — the one hand list. A stale entry (table/column gone, or it has since gained a real
  // FK) fails loudly rather than being silently skipped.
  for (const entry of NO_FK_ID_COLUMNS) {
    const columns = columnsByTable.get(entry.table);
    if (!columns?.has(entry.column)) throw new Error(`NO_FK_ID_COLUMNS lists ${entry.table}.${entry.column}, which the live schema does not have. Update teardown-graph.ts.`);
    if (edges.some((edge) => edge.child === entry.table && edge.column === entry.column)) {
      throw new Error(`NO_FK_ID_COLUMNS lists ${entry.table}.${entry.column}, but the live schema has a real FK on it. Remove it from the no-FK list.`);
    }
    if (entry.references !== "*" && !columnsByTable.get(entry.references)?.has("id")) {
      throw new Error(`NO_FK_ID_COLUMNS: ${entry.table}.${entry.column} references ${entry.references}, which has no id column in the live schema.`);
    }
    edges.push({ child: identifier(entry.table, "no-FK table"), column: identifier(entry.column, "no-FK column"), parent: entry.references, kind: "no-fk", onDelete: null });
  }

  // Involved = reachable child-ward from the registry roots. A `*` edge is reachable from any
  // involved table that carries an id.
  const involved = new Set<string>(Object.values(REGISTRY_ROOT_TABLES));
  for (let changed = true; changed; ) {
    changed = false;
    for (const edge of edges) {
      if (involved.has(edge.child)) continue;
      const reachable = edge.parent === "*" ? [...involved].some((t) => columnsByTable.get(t)?.has("id")) : involved.has(edge.parent);
      if (reachable) { involved.add(edge.child); changed = true; }
    }
  }
  const involvedEdges = edges.filter((edge) => involved.has(edge.child) && (edge.parent === "*" || involved.has(edge.parent)));

  for (const table of involved) {
    if (withoutRowid.has(table)) throw new Error(`${table} is a WITHOUT ROWID table; the graph teardown captures rows by rowid and cannot handle it. Extend teardown-graph.ts before relying on it.`);
    const shadow = [...(columnsByTable.get(table) ?? [])].find((c) => ROWID_ALIASES.has(c.toLowerCase()));
    if (shadow) throw new Error(`${table} has a column named ${shadow}, which shadows SQLite's rowid; the graph teardown cannot capture it by rowid.`);
  }
  // A single DELETE per table is safe for a self-referencing FK only when SQLite checks it at end of
  // statement (NO ACTION) or resolves it itself (CASCADE / SET NULL). RESTRICT fires per row,
  // immediately — `qa-seed-teardown-graph.test.ts` proves both — so it is refused here.
  for (const edge of involvedEdges) {
    if (edge.kind === "fk" && edge.child === edge.parent && edge.onDelete === "RESTRICT") {
      throw new Error(`${edge.child}.${edge.column} is a self-referencing ON DELETE RESTRICT foreign key; a single DELETE cannot remove a captured chain under it. Extend teardown-graph.ts before relying on it.`);
    }
  }

  // Reverse topological order over FK edges only (no-FK edges impose no constraint on deletion
  // order), ignoring self-edges. Kahn's algorithm, children first; ties broken by name so the plan
  // is deterministic.
  const fkEdges = involvedEdges.filter((edge) => edge.kind === "fk" && edge.child !== edge.parent);
  const remaining = new Set(involved);
  const deleteOrder: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((table) => !fkEdges.some((edge) => edge.parent === table && remaining.has(edge.child))).sort();
    if (ready.length === 0) throw new Error(`Foreign-key cycle among ${[...remaining].sort().join(", ")}; the graph teardown cannot order their deletes.`);
    const next = ready[0]!;
    deleteOrder.push(next);
    remaining.delete(next);
  }

  return {
    involved: [...involved].sort(),
    withId: [...involved].filter((t) => columnsByTable.get(t)?.has("id")).sort(),
    edges: involvedEdges,
    deleteOrder,
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type TeardownPlan = {
  /** Clears any closure a previous (possibly failed) teardown left, then captures the roots. */
  captureRootStatements: string[];
  /** One fixed-point round: re-run until `closureCountQuery` stops growing. */
  captureRoundStatements: string[];
  closureCountQuery: string;
  capturedCountsQuery: string;
  /** Rows of `projects` captured WITHOUT being a registered fixture project — a non-fixture project
   * reached through a back-reference. Teardown must abort before deleting anything if this is
   * non-empty. */
  overCaptureQuery: string;
  deleteStatements: string[];
  /** Each returns rows `{ label, n }`; every `n` must be 0 after the deletes. */
  remainingQueries: string[];
  sweepQueries: string[];
  registryStatements: string[];
  deleteOrder: string[];
};

const SWEEP_QUERY_CHUNK = 40;

/** One `(label, n)` row per count, as ONE statement WITHOUT a compound SELECT. Local D1 caps
 * `SQLITE_LIMIT_COMPOUND_SELECT` at 5 (a 6-term `UNION ALL` fails "too many terms in compound
 * SELECT"), so a `UNION ALL` of per-table counts breaks on the real transport. A multi-row `VALUES`
 * is not subject to that limit (measured on local D1 with 120 rows), and its scalar subqueries keep
 * the result shape the caller reads. */
function countRowsQuery(counts: readonly { label: string; countSql: string }[]): string {
  return `SELECT column1 AS label, column2 AS n FROM (VALUES\n${counts.map(({ label, countSql }) => `('${label}', (${countSql}))`).join(",\n")}\n);`;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function capturedIdsOf(parent: string): string {
  return parent === "*"
    ? `SELECT entity_id FROM ${FIXTURE_CLOSURE_TABLE} WHERE entity_id IS NOT NULL`
    : `SELECT entity_id FROM ${FIXTURE_CLOSURE_TABLE} WHERE table_name = '${identifier(parent, "parent table")}' AND entity_id IS NOT NULL`;
}

/** Captured rows of `table` that are still present — paired on rowid AND id where the table has one,
 * so a rowid reused by an unrelated row can never be mistaken for a captured row. */
function capturedRowPredicate(table: string, hasId: boolean): string {
  return hasId
    ? `EXISTS (SELECT 1 FROM ${FIXTURE_CLOSURE_TABLE} k WHERE k.table_name = '${table}' AND k.row_id = ${table}.rowid AND k.entity_id = ${table}.id)`
    : `rowid IN (SELECT row_id FROM ${FIXTURE_CLOSURE_TABLE} WHERE table_name = '${table}')`;
}

export function buildTeardownPlan(graph: TeardownGraph, runIds: readonly string[]): TeardownPlan {
  const hasId = new Set(graph.withId);
  for (const table of graph.involved) {
    identifier(table, "table name");
    if (isExcluded(table)) throw new Error(`Refusing to plan a teardown that touches excluded table ${table}.`);
  }
  const insertCaptured = (table: string, where: string) =>
    `INSERT OR IGNORE INTO ${FIXTURE_CLOSURE_TABLE} (table_name, row_id, entity_id)\nSELECT '${table}', ${table}.rowid, ${hasId.has(table) ? `${table}.id` : "NULL"} FROM ${table}\nWHERE ${where} AND ${CAPABILITY_PREDICATE};`;

  const captureRootStatements = [
    `DELETE FROM ${FIXTURE_CLOSURE_TABLE} WHERE ${CAPABILITY_PREDICATE};`,
    ...Object.entries(REGISTRY_ROOT_TABLES).map(([kind, table]) =>
      insertCaptured(table, `${table}.id IN (SELECT id FROM ${FIXTURE_ENTITIES_TABLE} WHERE kind = '${kind}')`)),
  ];
  const captureRoundStatements = graph.edges.map((edge) => insertCaptured(edge.child, `${edge.child}.${edge.column} IN (${capturedIdsOf(edge.parent)})`));

  const deleteStatements = graph.deleteOrder.map((table) => `DELETE FROM ${table} WHERE ${capturedRowPredicate(table, hasId.has(table))} AND ${CAPABILITY_PREDICATE};`);

  const remainingQueries = chunk(graph.deleteOrder, SWEEP_QUERY_CHUNK).map((tables) =>
    countRowsQuery(tables.map((table) => ({ label: table, countSql: `SELECT COUNT(*) FROM ${table} WHERE ${capturedRowPredicate(table, hasId.has(table))}` }))));
  const sweepQueries = chunk(graph.edges, SWEEP_QUERY_CHUNK).map((edges) =>
    countRowsQuery(edges.map((edge) => ({
      label: `${edge.child}.${edge.column} -> ${edge.parent === "*" ? "any captured id" : `${edge.parent}.id`}`,
      countSql: `SELECT COUNT(*) FROM ${edge.child} WHERE ${edge.column} IN (${capturedIdsOf(edge.parent)})`,
    }))));

  const runIdList = runIds.map((id) => sqlId(id, "run id")).join(", ");
  const registryStatements = [
    ...(runIds.length > 0
      ? [
        `DELETE FROM ${FIXTURE_ENTITIES_TABLE} WHERE run_id IN (${runIdList}) AND ${CAPABILITY_PREDICATE};`,
        `DELETE FROM ${FIXTURE_BOARD_POSITIONS_TABLE} WHERE run_id IN (${runIdList}) AND ${CAPABILITY_PREDICATE};`,
        `DELETE FROM ${FIXTURE_RUN_RECORDS_TABLE} WHERE run_id IN (${runIdList}) AND ${CAPABILITY_PREDICATE};`,
        `DELETE FROM ${FIXTURE_RUNS_TABLE} WHERE id IN (${runIdList}) AND ${CAPABILITY_PREDICATE};`,
      ]
      : []),
    `DELETE FROM ${FIXTURE_CLOSURE_TABLE} WHERE ${CAPABILITY_PREDICATE};`,
  ];

  return {
    captureRootStatements,
    captureRoundStatements,
    closureCountQuery: `SELECT COUNT(*) AS n FROM ${FIXTURE_CLOSURE_TABLE};`,
    capturedCountsQuery: `SELECT table_name AS label, COUNT(*) AS n FROM ${FIXTURE_CLOSURE_TABLE} GROUP BY table_name ORDER BY table_name;`,
    overCaptureQuery: `SELECT entity_id AS id FROM ${FIXTURE_CLOSURE_TABLE} WHERE table_name = 'projects' AND entity_id NOT IN (SELECT id FROM ${FIXTURE_ENTITIES_TABLE} WHERE kind = 'project') ORDER BY entity_id;`,
    deleteStatements,
    remainingQueries,
    sweepQueries,
    registryStatements,
    deleteOrder: graph.deleteOrder,
  };
}

/** Where a captured non-fixture `projects` row can have come from: every edge whose child is
 * `projects` (today only the no-FK `projects.cover_asset_id`). Named in the over-capture abort. */
export function edgesIntoProjects(graph: TeardownGraph): string[] {
  return graph.edges.filter((edge) => edge.child === "projects").map((edge) => `projects.${edge.column} -> ${edge.parent}`);
}
