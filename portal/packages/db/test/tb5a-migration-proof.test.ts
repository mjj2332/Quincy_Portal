import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APPEND_STAGE_BOTTOM_SQL,
  NORMATIVE_AUDIT_MARKER_SQL,
  NORMATIVE_COMPACTING_SQL,
  NORMATIVE_HANDOFF_EDITING_ENTRY_TOKEN_SQL,
  NORMATIVE_JOB_EDITING_ENTRY_TOKEN_SQL,
  NORMATIVE_NON_COMPACTING_APPEND_SQL,
  NORMATIVE_NON_COMPACTING_EXACT_SQL,
  NORMATIVE_OWNERSHIP_ASSERTION_SQL,
  NORMATIVE_TERMINAL_ASSERTION_SQL,
  buildCompactingStageWinner,
  buildNonCompactingStageWinner,
  rollbackBoardOrder0037PreEnable,
  type ChangedCompactionRow,
  type ExpectedTargetCompactionRow,
  type ExpectedTargetPlacementRow,
} from "../src";
import {
  BREAKPOINT,
  FIXTURE_NOW,
  MIGRATION_NAME,
  apply0037Transactionally,
  applyAllMigrations,
  applyMigration,
  applyThrough,
  enableBoardContract,
  localD1,
  localSqlite,
  migrationNames,
  migrationSegments,
  migrationSource,
  objectExists,
  seedContractProject,
  seedLegacyProject,
  seedMigrationJournal,
  withTemporaryDatabase,
  type SqliteDatabase,
  type SqliteRow,
} from "./tb5a-proof-support";

const MIGRATION_ONLY_OBJECTS = [
  "project_board_order_0037_rollback",
  "project_board_order_0037_stage_rank_idx",
  "projects_stage_archive_board_order_idx",
];

function stageRows(db: SqliteDatabase, stageKey: string): SqliteRow[] {
  return db.prepare("SELECT id, stage_key, priority, board_position, board_revision, archived_at FROM projects WHERE stage_key = ? AND archived_at IS NULL ORDER BY board_position, id").all(stageKey) as SqliteRow[];
}

function journalTail(db: SqliteDatabase): SqliteRow {
  return db.prepare("SELECT id, name FROM d1_migrations ORDER BY id DESC LIMIT 1").get() as SqliteRow;
}

function validCompactionFixture(db: SqliteDatabase): { expected: ExpectedTargetCompactionRow[]; changed: ChangedCompactionRow[] } {
  seedContractProject(db, { id: "target", stageKey: "raw_review", boardPosition: 7, boardRevision: 5 });
  seedContractProject(db, { id: "sibling-a", stageKey: "edited_review", boardPosition: 0, boardRevision: 2 });
  seedContractProject(db, { id: "sibling-b", stageKey: "edited_review", boardPosition: 1024, boardRevision: 3 });
  return {
    expected: [
      { projectId: "sibling-a", stageKey: "edited_review", boardPosition: 0, boardRevision: 2, newBoardPosition: 1024 },
      { projectId: "sibling-b", stageKey: "edited_review", boardPosition: 1024, boardRevision: 3, newBoardPosition: 2048 },
    ],
    changed: [
      { projectId: "target", oldStageKey: "raw_review", oldBoardPosition: 7, oldBoardRevision: 5, newBoardPosition: 0, isTarget: 1 },
      { projectId: "sibling-a", oldStageKey: "edited_review", oldBoardPosition: 0, oldBoardRevision: 2, newBoardPosition: 1024, isTarget: 0 },
      { projectId: "sibling-b", oldStageKey: "edited_review", oldBoardPosition: 1024, oldBoardRevision: 3, newBoardPosition: 2048, isTarget: 0 },
    ],
  };
}

function stageInput(db: D1Database) {
  return {
    db,
    projectId: "target",
    from: "raw_review" as const,
    to: "edited_review" as const,
    oldBoardRevision: 5,
    auditId: "audit-stage",
    actorId: null,
    updatedAt: FIXTURE_NOW + 100,
  };
}

function fenceReworkSqlBlocks(): string[] {
  const design = readFileSync(new URL("../../../../docs/plans/implemented/tb5a/fence-rework-sol-design.md", import.meta.url), "utf8");
  return [...design.matchAll(/```sql\n([\s\S]*?)```/g)].map((match) => match[1]!);
}

async function executeBundle(db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
  return db.batch(statements);
}

describe("TB5A Slice 8 consolidated migration and SQL proof", () => {
  it("runs the complete 0000..0037 chain and proves normalized seed order, health, and inert state", () => {
    const names = migrationNames();
    expect(names.map((name) => Number(name.slice(0, 4)))).toEqual(Array.from({ length: 38 }, (_, index) => index));

    const db = localSqlite();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyThrough(db, 36);
      db.prepare("INSERT INTO pipeline_stages (key, label, display_order, active) VALUES ('edited_review', 'Edited review', 4, 0)").run();
      const fixtures = [
        { id: "a-tie-a", stageKey: "awaiting_raw", priority: 5, boardPosition: 4 },
        { id: "a-tie-b", stageKey: "awaiting_raw", priority: 5, boardPosition: 4 },
        { id: "a-fraction", stageKey: "awaiting_raw", priority: 1, boardPosition: 4.5 },
        { id: "a-null", stageKey: "awaiting_raw", priority: null, boardPosition: -100 },
        { id: "b-priority", stageKey: "raw_review", priority: 1, boardPosition: 9 },
        { id: "inactive-occupant", stageKey: "edited_review", priority: 1, boardPosition: 99 },
        { id: "delivered-project", stageKey: "delivered", priority: null, boardPosition: 7 },
        { id: "archived-project", stageKey: "awaiting_raw", priority: 1, boardPosition: 123.25, archivedAt: FIXTURE_NOW + 1 },
        { id: "archived-noncanonical", stageKey: "legacy_archived", priority: null, boardPosition: 987.5, archivedAt: FIXTURE_NOW + 2 },
      ];
      for (const fixture of fixtures) seedLegacyProject(db, fixture);
      const archivedBefore = db.prepare("SELECT id, stage_key, priority, board_position, archived_at FROM projects WHERE archived_at IS NOT NULL ORDER BY id").all();

      applyMigration(db, MIGRATION_NAME);

      expect(stageRows(db, "awaiting_raw").map((row) => row.id)).toEqual(["a-tie-a", "a-tie-b", "a-fraction", "a-null"]);
      expect(stageRows(db, "awaiting_raw").map((row) => row.board_position)).toEqual([0, 1024, 2048, 3072]);
      expect(stageRows(db, "raw_review").map((row) => row.board_position)).toEqual([0]);
      expect(stageRows(db, "edited_review").map((row) => row.board_position)).toEqual([0]);
      expect(stageRows(db, "delivered").map((row) => row.board_position)).toEqual([0]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM projects WHERE archived_at IS NULL AND board_revision = 1").get()).toEqual({ count: 7 });
      expect(db.prepare("SELECT id, stage_key, priority, board_position, archived_at FROM projects WHERE archived_at IS NOT NULL ORDER BY id").all()).toEqual(archivedBefore);
      expect(db.prepare("SELECT COUNT(*) AS count FROM project_board_order_0037_rollback").get()).toEqual({ count: 7 });
      expect(db.prepare("SELECT enabled FROM feature_flags WHERE key = 'tb5a_board_contract_enabled'").get()).toEqual({ enabled: 0 });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '_tb5a_0037_%' ORDER BY name").all()).toEqual([]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
      expect(objectExists(db, "index", "projects_stage_archive_board_order_idx")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("keeps Wrangler splitting at every breakpoint and leaves normative SQL unchanged", async () => {
    const { unstable_splitSqlQuery } = await import("../../../node_modules/wrangler/wrangler-dist/cli.js");
    const source = migrationSource();
    const segments = source.split(BREAKPOINT).map((segment) => segment.trim()).filter(Boolean);
    const statements = unstable_splitSqlQuery(source);
    const withoutTerminalSemicolon = (value: string) => value.trim().replace(/;\s*$/, "");
    expect(statements).toHaveLength(segments.length);
    expect(statements.map(withoutTerminalSemicolon)).toEqual(segments.map(withoutTerminalSemicolon));
    for (const segment of segments) {
      expect(unstable_splitSqlQuery(segment)).toHaveLength(1);
      expect(unstable_splitSqlQuery(`${segment}\n${segment}`)).toHaveLength(2);
    }
    expect(source).not.toMatch(/\bEND\b(?=[^\s;])/i);

    const blocks = fenceReworkSqlBlocks();
    const appendBottomBlock = blocks.find((block) => block.startsWith("SELECT COALESCE(MAX(board_position) + 1024, 0)"));
    const exactBlock = blocks.find((block) => block.startsWith("WITH\n") && block.includes("board_position = ?8") && !block.includes("changed_plan AS"));
    const appendWinnerBlock = blocks.find((block) => block.startsWith("WITH\n") && block.includes("board_position = (\n    SELECT COALESCE(MAX(board_position) + 1024, 0)"));
    const compactingBlock = blocks.find((block) => block.startsWith("WITH\n") && block.includes("changed_plan AS"));
    const auditBlock = blocks.find((block) => block.startsWith("INSERT INTO audit_log (\n") && block.includes("WHERE changes() = ?7"));
    const handoffTokenBlock = blocks.find((block) => block.startsWith("UPDATE autohdr_handoffs\n") && block.includes("editing_entry_board_revision = ("));
    const jobTokenBlock = blocks.find((block) => block.startsWith("UPDATE jobs\n") && block.includes("stage_entry_board_revision = ("));
    const terminalBlock = blocks.find((block) => block.startsWith("WITH assertion_input AS MATERIALIZED (\n") && block.includes("stage.auto_advance.bundle_assertion"));
    const ownershipBlock = blocks.find((block) => block.startsWith("WITH assertion_input AS MATERIALIZED (\n") && block.includes("automatic.closed_bundle_assertion"));

    expect(APPEND_STAGE_BOTTOM_SQL).toBe(appendBottomBlock);
    expect(NORMATIVE_NON_COMPACTING_EXACT_SQL).toBe(exactBlock);
    expect(NORMATIVE_NON_COMPACTING_APPEND_SQL).toBe(appendWinnerBlock);
    expect(NORMATIVE_COMPACTING_SQL).toBe(compactingBlock);
    expect(NORMATIVE_AUDIT_MARKER_SQL).toBe(auditBlock);
    expect(NORMATIVE_HANDOFF_EDITING_ENTRY_TOKEN_SQL).toBe(handoffTokenBlock);
    expect(NORMATIVE_JOB_EDITING_ENTRY_TOKEN_SQL).toBe(jobTokenBlock);
    expect(NORMATIVE_TERMINAL_ASSERTION_SQL).toBe(terminalBlock);
    expect(NORMATIVE_OWNERSHIP_ASSERTION_SQL).toBe(ownershipBlock);
  });

  it("aborts preflight and postflight transactionally without advancing the migration journal", () => {
    withTemporaryDatabase((filename) => {
      let db = localSqlite(filename);
      try {
        db.exec("PRAGMA foreign_keys = ON");
        applyThrough(db, 36);
        seedMigrationJournal(db, 36);
        seedLegacyProject(db, { id: "invalid-stage", stageKey: "not_a_stage", boardPosition: 42 });
        db.close();

        db = localSqlite(filename);
        expect(() => apply0037Transactionally(db)).toThrow();
        expect(journalTail(db)).toMatchObject({ id: 37, name: "0036_external_editor_assigned_scope.sql" });
        expect(objectExists(db, "table", "project_board_order_0037_rollback")).toBe(false);
        expect(objectExists(db, "index", "projects_stage_archive_board_order_idx")).toBe(false);
        expect(db.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = 'invalid-stage'").get()).toEqual({ count: 1 });
      } finally {
        db.close();
      }
    });

    withTemporaryDatabase((filename) => {
      let db = localSqlite(filename);
      try {
        db.exec("PRAGMA foreign_keys = ON");
        applyThrough(db, 36);
        seedMigrationJournal(db, 36);
        for (const project of [
          { id: "valid-a", stageKey: "awaiting_raw", priority: 1, boardPosition: 20 },
          { id: "valid-b", stageKey: "awaiting_raw", priority: 2, boardPosition: 10 },
        ]) seedLegacyProject(db, project);
        db.exec(`
          CREATE TRIGGER tb5a_0037_skip_one_normalization
          BEFORE UPDATE OF board_position ON projects
          WHEN NEW.id = 'valid-a'
          BEGIN
            SELECT RAISE(IGNORE);
          END;
        `);
        const before = db.prepare("SELECT id, stage_key, priority, board_position FROM projects ORDER BY id").all();
        db.close();

        db = localSqlite(filename);
        expect(() => apply0037Transactionally(db)).toThrow();
        expect(journalTail(db)).toMatchObject({ id: 37, name: "0036_external_editor_assigned_scope.sql" });
        expect(db.prepare("SELECT id, stage_key, priority, board_position FROM projects ORDER BY id").all()).toEqual(before);
        expect(objectExists(db, "table", "project_board_order_0037_rollback")).toBe(false);
        expect(objectExists(db, "index", "projects_stage_archive_board_order_idx")).toBe(false);
      } finally {
        db.close();
      }
    });
  });

  it("rolls back every captured position or none when the pre-enable row fence drifts", async () => {
    const db = localSqlite();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyThrough(db, 36);
      for (const project of [
        { id: "rollback-a", stageKey: "awaiting_raw", priority: 1, boardPosition: 20 },
        { id: "rollback-b", stageKey: "awaiting_raw", priority: 2, boardPosition: 10 },
      ]) seedLegacyProject(db, project);
      const original = db.prepare("SELECT id, stage_key, priority, board_position FROM projects ORDER BY id").all();
      applyMigration(db, MIGRATION_NAME);
      const normalized = db.prepare("SELECT id, board_position, board_revision FROM projects ORDER BY id").all();
      const oldPositions = new Map((db.prepare("SELECT project_id, old_board_position FROM project_board_order_0037_rollback").all() as SqliteRow[]).map((row) => [row.project_id, row.old_board_position]));
      await expect(rollbackBoardOrder0037PreEnable(localD1(db))).resolves.toEqual({ rolledBack: 2 });
      expect(db.prepare("SELECT id, stage_key, priority, board_position FROM projects ORDER BY id").all()).toEqual(original);
      expect(db.prepare("SELECT id, board_revision FROM projects ORDER BY id").all()).toEqual(normalized.map((row) => ({ id: row.id, board_revision: 1 })));
      expect(oldPositions.size).toBe(2);

      db.close();
      const drifted = localSqlite();
      try {
        drifted.exec("PRAGMA foreign_keys = ON");
        applyThrough(drifted, 36);
        seedLegacyProject(drifted, { id: "drift-a", stageKey: "awaiting_raw", priority: 1, boardPosition: 20 });
        seedLegacyProject(drifted, { id: "drift-b", stageKey: "awaiting_raw", priority: 2, boardPosition: 10 });
        applyMigration(drifted, MIGRATION_NAME);
        const before = drifted.prepare("SELECT id, stage_key, board_position, board_revision FROM projects ORDER BY id").all();
        drifted.prepare("UPDATE projects SET board_revision = 2 WHERE id = 'drift-a'").run();
        await expect(rollbackBoardOrder0037PreEnable(localD1(drifted))).rejects.toThrow();
        expect(drifted.prepare("SELECT id, stage_key, board_position, board_revision FROM projects ORDER BY id").all()).toEqual(before.map((row) => row.id === "drift-a" ? { ...row, board_revision: 2 } : row));
        expect(objectExists(drifted, "table", "_tb5a_0037_position_rollback_guard")).toBe(false);
      } finally {
        drifted.close();
      }
      return;
    } finally {
      try {
        db.close();
      } catch {
        // The happy-path connection is intentionally closed before the drift case.
      }
    }
  });

  it("refuses rollback when a flag-off project was created after capture", async () => {
    const db = localSqlite();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyThrough(db, 36);
      seedLegacyProject(db, { id: "captured", stageKey: "awaiting_raw", boardPosition: 20 });
      applyMigration(db, MIGRATION_NAME);
      seedContractProject(db, { id: "post-capture", stageKey: "awaiting_raw", boardPosition: 2048, boardRevision: 0 });
      const before = db.prepare("SELECT id, board_position, board_revision FROM projects ORDER BY id").all();

      await expect(rollbackBoardOrder0037PreEnable(localD1(db))).rejects.toThrow();
      expect(db.prepare("SELECT id, board_position, board_revision FROM projects ORDER BY id").all()).toEqual(before);
      expect(objectExists(db, "table", "_tb5a_0037_position_rollback_guard")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("refuses rollback after a Board mutation even when flag updater evidence is deleted", async () => {
    const db = localSqlite();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyThrough(db, 36);
      seedLegacyProject(db, { id: "history", stageKey: "awaiting_raw", boardPosition: 20 });
      applyMigration(db, MIGRATION_NAME);
      db.prepare("UPDATE projects SET board_revision = 2 WHERE id = 'history'").run();
      db.prepare("UPDATE feature_flags SET enabled = 0, updated_by = NULL WHERE key = 'tb5a_board_contract_enabled'").run();
      const before = db.prepare("SELECT id, board_position, board_revision FROM projects ORDER BY id").all();

      await expect(rollbackBoardOrder0037PreEnable(localD1(db))).rejects.toThrow();
      expect(db.prepare("SELECT id, board_position, board_revision FROM projects ORDER BY id").all()).toEqual(before);
      expect(objectExists(db, "table", "_tb5a_0037_position_rollback_guard")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("refuses rollback when every captured row is at revision one but one capture row is missing", async () => {
    const db = localSqlite();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyThrough(db, 36);
      seedLegacyProject(db, { id: "captured", stageKey: "awaiting_raw", boardPosition: 20 });
      applyMigration(db, MIGRATION_NAME);
      seedContractProject(db, { id: "missing-capture", stageKey: "awaiting_raw", boardPosition: 2048, boardRevision: 1 });
      const before = db.prepare("SELECT id, board_position, board_revision FROM projects ORDER BY id").all();

      await expect(rollbackBoardOrder0037PreEnable(localD1(db))).rejects.toThrow();
      expect(db.prepare("SELECT id, board_position, board_revision FROM projects ORDER BY id").all()).toEqual(before);
      expect(objectExists(db, "table", "_tb5a_0037_position_rollback_guard")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("executes both winner forms, pins fence materialization, and rejects every malformed compacting plan", async () => {
    const db = localSqlite();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyAllMigrations(db);
      enableBoardContract(db);
      seedContractProject(db, { id: "target", stageKey: "raw_review", boardRevision: 5 });
      const d1 = localD1(db);
      const append = buildNonCompactingStageWinner({ ...stageInput(d1), placement: "append", expectedTarget: [], expectedTargetRowCount: 0 });
      const appendResults = await executeBundle(d1, append.statements);
      expect(appendResults[append.indexes.winner]!.results).toMatchObject([{ id: "target", stage_key: "edited_review", board_position: 0, board_revision: 6 }]);
      expect(appendResults[append.indexes.auditMarker]!.results).toEqual([{ id: "audit-stage" }]);
    } finally {
      db.close();
    }

    const compactPlanDb = localSqlite();
    try {
      compactPlanDb.exec("PRAGMA foreign_keys = ON");
      applyAllMigrations(compactPlanDb);
      enableBoardContract(compactPlanDb);
      const fixture = validCompactionFixture(compactPlanDb);
      const d1 = localD1(compactPlanDb);
      const compact = buildCompactingStageWinner({ ...stageInput(d1), expectedTarget: fixture.expected, changedPlan: fixture.changed, expectedTargetRowCount: 2, expectedChangedRowCount: 3 });
      const compactResults = await executeBundle(d1, compact.statements);
      expect(compactResults[compact.indexes.winner]!.results).toHaveLength(3);
      expect(compactResults[compact.indexes.auditMarker]!.results).toEqual([{ id: "audit-stage" }]);
      expect(compactPlanDb.prepare("SELECT id, board_position, board_revision FROM projects ORDER BY board_position, id").all()).toEqual([
        { id: "target", board_position: 0, board_revision: 6 },
        { id: "sibling-a", board_position: 1024, board_revision: 3 },
        { id: "sibling-b", board_position: 2048, board_revision: 4 },
      ]);

      const exactPlan = compactPlanDb.prepare(`EXPLAIN QUERY PLAN ${NORMATIVE_NON_COMPACTING_EXACT_SQL}`).all("[]", "tb5a_board_contract_enabled", 0, "edited_review", "target", "raw_review", 5, 0, FIXTURE_NOW) as SqliteRow[];
      const queryPlan = compactPlanDb.prepare(`EXPLAIN QUERY PLAN ${NORMATIVE_COMPACTING_SQL}`).all(JSON.stringify(fixture.expected), JSON.stringify(fixture.changed), "tb5a_board_contract_enabled", 3, 2, "edited_review", "target", "raw_review", 5, FIXTURE_NOW) as SqliteRow[];
      expect(exactPlan.some((row) => String(row.detail).includes("MATERIALIZE fence"))).toBe(true);
      expect(queryPlan.some((row) => String(row.detail).includes("MATERIALIZE fence"))).toBe(true);
    } finally {
      compactPlanDb.close();
    }

    const malformedCases = [
      "duplicate expected ID",
      "duplicate changed-plan ID",
      "sibling as target",
      "stale tuple",
      "missing changed row",
      "extra changed row",
      "wrong count",
    ] as const;
    for (const caseName of malformedCases) {
      const malformedDb = localSqlite();
      try {
        malformedDb.exec("PRAGMA foreign_keys = ON");
        applyAllMigrations(malformedDb);
        enableBoardContract(malformedDb);
        const fixture = validCompactionFixture(malformedDb);
        let expected = fixture.expected;
        let changed = fixture.changed;
        let expectedCount = 2;
        let changedCount = 3;
        if (caseName === "duplicate expected ID") expected = [fixture.expected[0]!, fixture.expected[0]!];
        if (caseName === "duplicate changed-plan ID") changed = [fixture.changed[0]!, fixture.changed[0]!, fixture.changed[2]!];
        if (caseName === "sibling as target") changed = fixture.changed.map((row, index) => index === 1 ? { ...row, isTarget: 1 as const } : row);
        if (caseName === "stale tuple") changed = fixture.changed.map((row, index) => index === 1 ? { ...row, oldBoardRevision: 999 } : row);
        if (caseName === "missing changed row") { changed = fixture.changed.slice(0, 2); changedCount = 2; }
        if (caseName === "extra changed row") {
          changed = [...fixture.changed, { projectId: "ghost", oldStageKey: "edited_review", oldBoardPosition: 4096, oldBoardRevision: 0, newBoardPosition: 3072, isTarget: 0 }];
          changedCount = 4;
        }
        if (caseName === "wrong count") changedCount = 2;
        const before = malformedDb.prepare("SELECT id, stage_key, board_position, board_revision FROM projects ORDER BY id").all();
        const d1 = localD1(malformedDb);
        const bundle = buildCompactingStageWinner({ ...stageInput(d1), expectedTarget: expected, changedPlan: changed, expectedTargetRowCount: expectedCount, expectedChangedRowCount: changedCount });
        const results = await executeBundle(d1, bundle.statements);
        expect(results[bundle.indexes.winner]!.results, caseName).toEqual([]);
        expect(results[bundle.indexes.auditMarker]!.results, caseName).toEqual([]);
        expect(malformedDb.prepare("SELECT id, stage_key, board_position, board_revision FROM projects ORDER BY id").all(), caseName).toEqual(before);
      } finally {
        malformedDb.close();
      }
    }
  });

  it("keeps migration-only rollback objects out of Drizzle schema and snapshot", () => {
    const schema = readFileSync(new URL("../src/schema.ts", import.meta.url), "utf8");
    const snapshot = readFileSync(new URL("../migrations/meta/0037_snapshot.json", import.meta.url), "utf8");
    for (const object of MIGRATION_ONLY_OBJECTS) {
      expect(schema).not.toContain(object);
      expect(snapshot).not.toContain(object);
    }
    expect(schema).not.toContain("_tb5a_0037_");
    expect(snapshot).not.toContain("_tb5a_0037_");
    expect(JSON.parse(snapshot).tables.projects.indexes).not.toHaveProperty("projects_stage_archive_board_order_idx");
  });
});
