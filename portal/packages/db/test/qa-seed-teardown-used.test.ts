/**
 * QA scheduling fixture — teardown of a USED fixture (Sol round 2, findings 1-3). The fixture exists
 * so a browser pass can use it, and using it makes the app write rows against fixture projects.
 * These tests apply the fixture through `cli.mjs`'s own `apply`, plant app-shaped rows
 * (`qa-seed-app-rows.ts`) against a fixture project AND a hand-made control project, run `cli.mjs`'s
 * own `teardown`, and then assert the database is EXACTLY the pre-teardown database minus the
 * fixture-linked rows: nothing fixture-linked survives, nothing else changed by a byte (so no
 * over-deletion in any table either), `PRAGMA foreign_key_check` is empty, and the registry is empty.
 *
 * The per-finding cases plant one finding's shape alone, so each finding is evidenced on its own
 * rather than masked by whichever trap the old teardown hit first.
 */
import { describe, expect, it } from "vitest";
import { apply, teardown } from "../qa-seed/cli.mjs";
import { BOOTSTRAP_ADMIN_ID } from "../qa-seed/dataset";
import { CAPABILITY_TABLE, FIXTURE_BOARD_POSITIONS_TABLE, FIXTURE_ENTITIES_TABLE, FIXTURE_RUN_RECORDS_TABLE, FIXTURE_RUNS_TABLE } from "../qa-seed/sql";
import { FIXTURE_CLOSURE_TABLE } from "../qa-seed/teardown-graph";
import {
  appRows, controlProjectRows, GLOBAL_AUDIT_TYPES, globalRows, insertSql, plantId, PROJECT_DESCENDANT_AUDIT_TYPES, scannedAuditTargetTypes,
  type AppRowGroup, type PlantContext, type PlantRow,
} from "./qa-seed-app-rows";
import { freshFixtureDatabase, sqliteExecutor, type Row, type SqliteDatabase } from "./qa-seed-sqlite-executor";

const ANCHOR = "2026-09-21";
const DEFAULT_EDITOR = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const REGISTRY_TABLES = [FIXTURE_RUNS_TABLE, FIXTURE_ENTITIES_TABLE, FIXTURE_RUN_RECORDS_TABLE, FIXTURE_BOARD_POSITIONS_TABLE, FIXTURE_CLOSURE_TABLE];

type Snapshot = Record<string, Row[]>;

function snapshot(db: SqliteDatabase): Snapshot {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name;").all().map((row) => String(row.name));
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid;`).all().map((row) => ({ ...row }))]));
}

type Scenario = { db: SqliteDatabase; executor: ReturnType<typeof sqliteExecutor>; fixture: PlantContext; control: PlantContext; fixtureRows: PlantRow[]; controlRows: PlantRow[] };

function scenario(groups?: readonly AppRowGroup[]): Scenario {
  const db = freshFixtureDatabase();
  db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, default_editor, created_at, updated_at) VALUES (?, 'Default Editor', 'default-editor@example.test', 0, 'editor', 1, 1, 0, 0);").run(DEFAULT_EDITOR);
  const executor = sqliteExecutor(db);
  apply(executor, { command: "apply", tier: undefined, anchor: ANCHOR, persistTo: undefined });

  // A fixture project the generator gave a collection, a subtask and a deadline occurrence.
  const project = db.prepare(`
    SELECT p.id AS id FROM projects p
    WHERE p.id IN (SELECT id FROM ${FIXTURE_ENTITIES_TABLE} WHERE kind = 'project')
      AND EXISTS (SELECT 1 FROM project_deadline_occurrences o WHERE o.project_id = p.id)
      AND EXISTS (SELECT 1 FROM project_subtasks s WHERE s.project_id = p.id)
    ORDER BY p.id LIMIT 1;`).get();
  const projectId = String(project?.id);
  const one = (sql: string) => String(db.prepare(sql).get(projectId)?.id);
  const connectionId = plantId("connection");
  const fixture: PlantContext = {
    tag: "fixture", projectId, userId: BOOTSTRAP_ADMIN_ID, connectionId,
    collectionId: one("SELECT id FROM collections WHERE project_id = ? ORDER BY id LIMIT 1;"),
    subtaskId: one("SELECT id FROM project_subtasks WHERE project_id = ? ORDER BY id LIMIT 1;"),
    occurrenceId: one("SELECT id FROM project_deadline_occurrences WHERE project_id = ? ORDER BY id LIMIT 1;"),
  };
  const control: PlantContext = {
    tag: "control", projectId: plantId("control:project"), collectionId: plantId("control:collection"), subtaskId: plantId("control:subtask"),
    occurrenceId: plantId("control:occurrence"), userId: BOOTSTRAP_ADMIN_ID, connectionId,
  };
  const controlRows = [...globalRows(connectionId, BOOTSTRAP_ADMIN_ID), ...controlProjectRows(control), ...appRows(control, groups)];
  const fixtureRows = appRows(fixture, groups);
  for (const row of [...controlRows, ...fixtureRows]) db.exec(insertSql(row));
  return { db, executor, fixture, control, fixtureRows, controlRows };
}

/** The pre-teardown database minus exactly the fixture-linked rows: every registered generator row,
 * every row planted against the fixture project, and the registry itself. */
function expectedAfterTeardown(before: Snapshot, s: Scenario): Snapshot {
  const registeredIds = new Set(before[FIXTURE_ENTITIES_TABLE]!.map((row) => String(row.id)));
  const plantedIds = new Set(s.fixtureRows.map((row) => row.values.id).filter((id): id is string => typeof id === "string"));
  const fixtureLinked = (table: string, row: Row) =>
    registeredIds.has(String(row.id)) || plantedIds.has(String(row.id))
    || (table === "project_comment_read_markers" && row.project_id === s.fixture.projectId);
  return Object.fromEntries(Object.entries(before).map(([table, rows]) => [
    table,
    REGISTRY_TABLES.includes(table) ? [] : rows.filter((row) => !fixtureLinked(table, row)),
  ]));
}

function assertExactTeardown(s: Scenario): { before: Snapshot; after: Snapshot } {
  const before = snapshot(s.db);
  teardown(s.executor);
  const after = snapshot(s.db);
  expect(after).toEqual(expectedAfterTeardown(before, s));
  expect(s.db.prepare("PRAGMA foreign_key_check;").all()).toEqual([]);
  for (const table of REGISTRY_TABLES) expect(after[table], `${table} must be empty after teardown`).toEqual([]);
  expect(after[CAPABILITY_TABLE]!.length).toBe(1);
  return { before, after };
}

describe("the planted app-row set covers what the app actually writes", () => {
  it("plants an audit_log row for every target_type the app writes (scanned from workers/, not guessed)", () => {
    const scanned = scannedAuditTargetTypes();
    expect(scanned.length).toBeGreaterThan(15);
    const planted = new Set<string>([...PROJECT_DESCENDANT_AUDIT_TYPES, ...GLOBAL_AUDIT_TYPES]);
    expect(scanned.filter((type) => !planted.has(type))).toEqual([]);
  });
});

describe("teardown of a used fixture — one finding at a time", () => {
  it("finding 1: an AutoHDR return (edited_source_claims, RESTRICT to the asset and the handoff) does not abort teardown", () => {
    const s = scenario(["autohdr"]);
    expect(s.fixtureRows.some((row) => row.table === "edited_source_claims")).toBe(true);
    assertExactTeardown(s);
    s.db.close();
  });

  it("finding 2: an audit_log row targeting a fixture project_comment is removed, not left orphaned", () => {
    const s = scenario(["audit"]);
    const commentAudit = s.fixtureRows.find((row) => row.table === "audit_log" && row.values.target_type === "project_comment");
    expect(commentAudit).toBeDefined();
    assertExactTeardown(s);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE id = ?;").get(String(commentAudit!.values.id))?.n).toBe(0);
    s.db.close();
  });

  it("finding 3: a rendition_dlq_events row (no FK) for a fixture asset is removed", () => {
    const s = scenario(["dlq"]);
    const dlq = s.fixtureRows.find((row) => row.table === "rendition_dlq_events");
    expect(dlq).toBeDefined();
    assertExactTeardown(s);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM rendition_dlq_events WHERE id = ?;").get(String(dlq!.values.id))?.n).toBe(0);
    s.db.close();
  });
});

describe("teardown of a used fixture — every app-shaped row at once, against a control project", () => {
  it("removes every fixture-linked row, leaves every control row byte-identical, foreign_key_check empty, registry empty", () => {
    const s = scenario();
    const plantedTables = new Set(s.fixtureRows.map((row) => row.table));
    for (const table of [
      "project_comments", "project_comment_mentions", "project_comment_read_markers", "project_activity_events", "audit_log",
      "notification_outbox", "notification_delivery_ledger", "notifications", "jobs", "assets", "asset_renditions", "rendition_dlq_events",
      "edited_source_claims", "autohdr_handoffs", "autohdr_output_mappings", "project_members", "annotations", "collection_links",
      "upload_manifests", "document_uploads", "raw_reconciliation_claims",
    ]) expect(plantedTables.has(table), `${table} planted`).toBe(true);
    const { before, after } = assertExactTeardown(s);
    // The control side really was there to be protected, and survived whole.
    for (const row of s.controlRows) {
      if (typeof row.values.id !== "string") continue;
      expect(after[row.table]!.some((r) => r.id === row.values.id), `${row.table} ${row.values.id} survived`).toBe(true);
    }
    const deleted = Object.entries(before).map(([table, rows]) => [table, rows.length - after[table]!.length] as const).filter(([, n]) => n > 0);
    expect(deleted.length).toBeGreaterThan(20);
    s.db.close();
  });
});
