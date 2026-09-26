/**
 * QA fixture teardown — properties of the graph-driven design itself (`qa-seed/teardown-graph.ts`),
 * exercised through `cli.mjs`'s own `teardown` against a `node:sqlite` database built from the real
 * migrations. Because the graph is introspected LIVE, a table created in these tests after the
 * migrations is exactly what a future migration would look like to teardown.
 *
 *  - A new table, reached only through a depth-3 self-referencing chain, is captured and deleted with
 *    no code change — and a single DELETE removes the chain (SQLite checks a NO ACTION FK at end of
 *    statement), proven below rather than asserted.
 *  - The cases the design cannot handle fail LOUDLY, before anything is deleted: a self-referencing
 *    ON DELETE RESTRICT FK (SQLite checks RESTRICT per row, immediately — also proven below), a
 *    WITHOUT ROWID table, a non-fixture project reached through a back-reference, an FK that targets
 *    a column other than `id`, a composite FK, and a non-identifier table name.
 */
import { describe, expect, it } from "vitest";
import { apply, teardown } from "../qa-seed/cli.mjs";
import { BOOTSTRAP_ADMIN_ID } from "../qa-seed/dataset";
import { FIXTURE_ENTITIES_TABLE } from "../qa-seed/sql";
import { buildTeardownGraph, FIXTURE_CLOSURE_TABLE, type IntrospectedForeignKey, type IntrospectedTable } from "../qa-seed/teardown-graph";
import { freshFixtureDatabase, liveTeardownPlan, sqliteExecutor, type SqliteDatabase } from "./qa-seed-sqlite-executor";
import { controlProjectRows, insertSql, plantId, type PlantContext } from "./qa-seed-app-rows";

const ANCHOR = "2026-09-21";

/** Rows as sorted JSON (not `ORDER BY rowid`: a WITHOUT ROWID table has none). */
function snapshot(db: SqliteDatabase): Record<string, string[]> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name;").all().map((row) => String(row.name));
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}";`).all().map((row) => JSON.stringify({ ...row })).sort()]));
}

function appliedWithControl(): { db: SqliteDatabase; executor: ReturnType<typeof sqliteExecutor>; fixtureProjectId: string; control: PlantContext } {
  const db = freshFixtureDatabase();
  const executor = sqliteExecutor(db);
  apply(executor, { command: "apply", tier: undefined, anchor: ANCHOR, persistTo: undefined });
  const fixtureProjectId = String(db.prepare(`SELECT id FROM ${FIXTURE_ENTITIES_TABLE} WHERE kind = 'project' ORDER BY id LIMIT 1;`).get()?.id);
  const control: PlantContext = {
    tag: "control", projectId: plantId("g:control:project"), collectionId: plantId("g:control:collection"), subtaskId: plantId("g:control:subtask"),
    occurrenceId: plantId("g:control:occurrence"), userId: BOOTSTRAP_ADMIN_ID, connectionId: plantId("g:connection"),
  };
  for (const row of controlProjectRows(control)) db.exec(insertSql(row));
  return { db, executor, fixtureProjectId, control };
}

function threadTable(db: SqliteDatabase, onDelete: "NO ACTION" | "RESTRICT"): void {
  db.exec(`CREATE TABLE qa_threads (
    id text PRIMARY KEY NOT NULL,
    project_id text REFERENCES projects(id),
    parent_id text REFERENCES qa_threads(id) ON DELETE ${onDelete}
  );`);
}

describe("SQLite semantics the single-DELETE-per-table plan relies on (proven, not asserted)", () => {
  function selfReferencing(onDelete: "NO ACTION" | "RESTRICT"): SqliteDatabase {
    const db = freshFixtureDatabase();
    db.exec(`CREATE TABLE chain (id text PRIMARY KEY NOT NULL, parent_id text REFERENCES chain(id) ON DELETE ${onDelete});`);
    // Parent inserted first, so a DELETE visiting rows in rowid order reaches the parent while its
    // child still exists.
    db.exec("INSERT INTO chain (id, parent_id) VALUES ('a', NULL), ('b', 'a'), ('c', 'b');");
    return db;
  }

  it("NO ACTION self-reference: one DELETE removing the whole chain succeeds (checked at end of statement)", () => {
    const db = selfReferencing("NO ACTION");
    expect(() => db.exec("DELETE FROM chain WHERE id IN ('a', 'b', 'c');")).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM chain;").get()?.n).toBe(0);
    db.close();
  });

  it("RESTRICT self-reference: the same single DELETE fails (checked per row, immediately) — which is why the planner refuses it", () => {
    const db = selfReferencing("RESTRICT");
    expect(() => db.exec("DELETE FROM chain WHERE id IN ('a', 'b', 'c');")).toThrow(/FOREIGN KEY constraint failed/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM chain;").get()?.n).toBe(3);
    db.close();
  });
});

describe("a table added after this code was written is handled by the live graph, at any depth", () => {
  it("captures a depth-3 self-referencing chain hanging off a fixture project, deletes it with one DELETE, and leaves the control project's chain alone", () => {
    const { db, executor, fixtureProjectId, control } = appliedWithControl();
    threadTable(db, "NO ACTION");
    // Only the first row references the fixture project; the next two are reachable ONLY through
    // the self-reference, one round deeper each.
    db.exec(`INSERT INTO qa_threads (id, project_id, parent_id) VALUES
      ('f1', '${fixtureProjectId}', NULL), ('f2', NULL, 'f1'), ('f3', NULL, 'f2'),
      ('c1', '${control.projectId}', NULL), ('c2', NULL, 'c1');`);
    const controlBefore = db.prepare("SELECT * FROM qa_threads WHERE id IN ('c1', 'c2') ORDER BY id;").all();

    const { plan } = liveTeardownPlan(db);
    expect(plan.deleteOrder).toContain("qa_threads");
    expect(plan.deleteStatements.filter((s) => s.startsWith("DELETE FROM qa_threads "))).toHaveLength(1);

    teardown(executor);
    expect(db.prepare("SELECT id FROM qa_threads ORDER BY id;").all().map((r) => r.id)).toEqual(["c1", "c2"]);
    expect(db.prepare("SELECT * FROM qa_threads WHERE id IN ('c1', 'c2') ORDER BY id;").all()).toEqual(controlBefore);
    expect(db.prepare("PRAGMA foreign_key_check;").all()).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${FIXTURE_CLOSURE_TABLE};`).get()?.n).toBe(0);
    db.close();
  });
});

describe("what the graph teardown cannot handle fails loudly, before deleting anything", () => {
  function expectRefusedUntouched(db: SqliteDatabase, executor: ReturnType<typeof sqliteExecutor>, message: RegExp): void {
    const before = snapshot(db);
    expect(() => teardown(executor)).toThrow(message);
    const after = snapshot(db);
    // The closure may hold the capture it made before refusing; every other table is untouched.
    delete before[FIXTURE_CLOSURE_TABLE];
    delete after[FIXTURE_CLOSURE_TABLE];
    expect(after).toEqual(before);
  }

  it("a self-referencing ON DELETE RESTRICT foreign key", () => {
    const { db, executor, fixtureProjectId } = appliedWithControl();
    threadTable(db, "RESTRICT");
    db.exec(`INSERT INTO qa_threads (id, project_id, parent_id) VALUES ('f1', '${fixtureProjectId}', NULL), ('f2', NULL, 'f1');`);
    expectRefusedUntouched(db, executor, /qa_threads\.parent_id is a self-referencing ON DELETE RESTRICT foreign key/);
    db.close();
  });

  it("a WITHOUT ROWID table reachable from the fixture", () => {
    const { db, executor, fixtureProjectId } = appliedWithControl();
    db.exec("CREATE TABLE qa_tags (project_id text NOT NULL REFERENCES projects(id), tag text NOT NULL, PRIMARY KEY (project_id, tag)) WITHOUT ROWID;");
    db.exec(`INSERT INTO qa_tags (project_id, tag) VALUES ('${fixtureProjectId}', 'x');`);
    expectRefusedUntouched(db, executor, /qa_tags is a WITHOUT ROWID table/);
    db.close();
  });

  it("a non-fixture project reached through a back-reference (projects.cover_asset_id -> a fixture asset)", () => {
    const { db, executor, fixtureProjectId, control } = appliedWithControl();
    const collectionId = String(db.prepare("SELECT id FROM collections WHERE project_id = ? LIMIT 1;").get(fixtureProjectId)?.id);
    const assetId = plantId("g:fixture-asset");
    db.exec(`INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES ('${assetId}', '${collectionId}', 'photo', 'qa/cover', 'cover.jpg', 1, 'upload', 0, 0);`);
    db.exec(`UPDATE projects SET cover_asset_id = '${assetId}' WHERE id = '${control.projectId}';`);
    expectRefusedUntouched(db, executor, new RegExp(`NOT registered fixture projects \\(${control.projectId}\\).*projects\\.cover_asset_id -> assets`));
    db.close();
  });
});

describe("buildTeardownGraph refuses introspection it cannot handle safely", () => {
  const db = freshFixtureDatabase();
  const { tables, foreignKeys } = liveTeardownPlan(db);
  db.close();

  it("a non-identifier-shaped table name", () => {
    const bad: IntrospectedTable[] = [...tables, { name: "evil; DROP TABLE user", without_rowid: 0, columns: "id" }];
    expect(() => buildTeardownGraph(bad, foreignKeys)).toThrow(/non-identifier-shaped table name/);
  });

  it("a non-identifier-shaped column name", () => {
    const bad = tables.map((t) => (t.name === "jobs" ? { ...t, columns: `${t.columns},bad column` } : t));
    expect(() => buildTeardownGraph(bad, foreignKeys)).toThrow(/non-identifier-shaped column of jobs/);
  });

  it("an FK that targets a column other than id", () => {
    const bad: IntrospectedForeignKey[] = [...foreignKeys, { table: "jobs", id: 99, seq: 0, from: "correlation_id", parent: "projects", to: "street", on_delete: "NO ACTION" }];
    expect(() => buildTeardownGraph(tables, bad)).toThrow(/targets a column other than id/);
  });

  it("a composite FK", () => {
    const bad: IntrospectedForeignKey[] = [
      ...foreignKeys,
      { table: "jobs", id: 99, seq: 0, from: "project_id", parent: "projects", to: "id", on_delete: "NO ACTION" },
      { table: "jobs", id: 99, seq: 1, from: "correlation_id", parent: "projects", to: "id", on_delete: "NO ACTION" },
    ];
    expect(() => buildTeardownGraph(tables, bad)).toThrow(/Composite foreign key/);
  });

  it("a no-FK list entry the live schema has since given a real FK", () => {
    const bad: IntrospectedForeignKey[] = [...foreignKeys, { table: "rendition_dlq_events", id: 0, seq: 0, from: "asset_id", parent: "assets", to: "id", on_delete: "CASCADE" }];
    expect(() => buildTeardownGraph(tables, bad)).toThrow(/rendition_dlq_events\.asset_id, but the live schema has a real FK on it/);
  });
});
