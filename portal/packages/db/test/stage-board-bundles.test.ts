import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APPEND_STAGE_BOTTOM_SQL,
  NORMATIVE_AUDIT_MARKER_SQL,
  NORMATIVE_COMPACTING_SQL,
  NORMATIVE_HANDOFF_EDITING_ENTRY_TOKEN_SQL,
  NORMATIVE_JOB_EDITING_ENTRY_TOKEN_SQL,
  NORMATIVE_NON_COMPACTING_EXACT_SQL,
  buildCompactingStageWinner,
  buildDeadlineSuppressionBundle,
  buildEditingEntryTokenTail,
  buildNonCompactingStageWinner,
  buildStageActivityBundle,
  buildWorkflowTail,
  composeStageBundle,
  deriveStageFinalizerIntent,
  type ChangedCompactionRow,
  type ExpectedTargetCompactionRow,
  type ExpectedTargetPlacementRow,
} from "../src/index";

type SqliteRow = Record<string, unknown>;
type SqliteStatement = {
  all: (...values: unknown[]) => unknown[];
  get: (...values: unknown[]) => unknown;
  run: (...values: unknown[]) => unknown;
};
type SqliteDatabase = {
  close: () => void;
  exec: (source: string) => void;
  prepare: (source: string) => SqliteStatement;
};

type LocalStatement = {
  source: string;
  values: unknown[];
  execute: () => { results: unknown[]; meta: { changes: number } };
};

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

const BREAKPOINT = "--> statement-breakpoint";

function migrationNames(): string[] {
  const directory = new URL("../migrations/", import.meta.url);
  return readdirSync(directory)
    .filter((value) => /^\d{4}_.*\.sql$/.test(value))
    .sort((a, b) => Number(a.slice(0, 4)) - Number(b.slice(0, 4)));
}

function applyAllMigrations(db: SqliteDatabase): void {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of migrationNames()) {
    const source = readFileSync(new URL(name, directory), "utf8");
    for (const segment of source.split(BREAKPOINT).map((value) => value.trim()).filter(Boolean)) db.exec(segment);
  }
}

function localD1(db: SqliteDatabase): D1Database {
  class LocalD1Statement implements LocalStatement {
    constructor(readonly source: string, readonly values: unknown[] = []) {}

    bind(...values: unknown[]): D1PreparedStatement {
      return new LocalD1Statement(this.source, values) as unknown as D1PreparedStatement;
    }

    execute(): { results: unknown[]; meta: { changes: number } } {
      const statement = db.prepare(this.source);
      let results: unknown[] = [];
      try {
        results = statement.all(...this.values);
      } catch {
        statement.run(...this.values);
      }
      const changes = Number((db.prepare("SELECT changes() AS changes").get() as { changes: number }).changes);
      return { results, meta: { changes } };
    }
  }

  return {
    prepare: (source: string) => new LocalD1Statement(source) as unknown as D1PreparedStatement,
    batch: async (statements: D1PreparedStatement[]) => {
      db.exec("BEGIN TRANSACTION");
      try {
        const results = statements.map((statement) => (statement as unknown as LocalStatement).execute());
        db.exec("COMMIT");
        return results as unknown as D1Result<unknown>[];
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // SQLite may already have rolled back the transaction.
        }
        throw error;
      }
    },
  } as unknown as D1Database;
}

function seedFeatureFlag(db: SqliteDatabase): void {
  db.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run();
}

function seedProject(db: SqliteDatabase, input: { id: string; stageKey: string; boardPosition?: number; boardRevision?: number; shootDate?: string }): void {
  const now = 1_787_000_000_000;
  db.prepare("INSERT INTO projects (id, street, shoot_date, stage_key, board_position, board_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(input.id, `${input.id} Street`, input.shootDate ?? null, input.stageKey, input.boardPosition ?? 0, input.boardRevision ?? 0, now, now);
}

function audit(db: SqliteDatabase, id: string, targetId = "target"): void {
  db.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, NULL, 'stage.auto_advance', 'project', ?, '{}', ?)")
    .run(id, targetId, 1_787_000_000_000);
}

function rowJson(rows: readonly (ExpectedTargetPlacementRow | ExpectedTargetCompactionRow)[]): string {
  return JSON.stringify(rows);
}

function changedJson(rows: readonly ChangedCompactionRow[]): string {
  return JSON.stringify(rows);
}

function baseStageInput(db: D1Database) {
  return {
    db,
    projectId: "target",
    from: "raw_review" as const,
    to: "edited_review" as const,
    oldBoardRevision: 5,
    auditId: "audit-stage",
    actorId: null,
    updatedAt: 1_787_000_000_100,
  };
}

function executeBundle(db: D1Database, bundle: { statements: D1PreparedStatement[] }): Promise<D1Result<unknown>[]> {
  return db.batch(bundle.statements);
}

function compactFixture(db: SqliteDatabase): { expected: ExpectedTargetCompactionRow[]; changed: ChangedCompactionRow[] } {
  seedProject(db, { id: "target", stageKey: "raw_review", boardPosition: 4, boardRevision: 5 });
  seedProject(db, { id: "sibling-a", stageKey: "edited_review", boardPosition: 1024, boardRevision: 2 });
  seedProject(db, { id: "sibling-b", stageKey: "edited_review", boardPosition: 4096, boardRevision: 3 });
  const expected: ExpectedTargetCompactionRow[] = [
    { projectId: "sibling-a", stageKey: "edited_review", boardPosition: 1024, boardRevision: 2, newBoardPosition: 0 },
    { projectId: "sibling-b", stageKey: "edited_review", boardPosition: 4096, boardRevision: 3, newBoardPosition: 2048 },
  ];
  const changed: ChangedCompactionRow[] = [
    { projectId: "target", oldStageKey: "raw_review", oldBoardPosition: 4, oldBoardRevision: 5, newBoardPosition: 1024, isTarget: 1 },
    { projectId: "sibling-a", oldStageKey: "edited_review", oldBoardPosition: 1024, oldBoardRevision: 2, newBoardPosition: 0, isTarget: 0 },
    { projectId: "sibling-b", oldStageKey: "edited_review", oldBoardPosition: 4096, oldBoardRevision: 3, newBoardPosition: 2048, isTarget: 0 },
  ];
  return { expected, changed };
}

describe("TB5A Slice 3 stage-board bundles", () => {
  it("keeps every normative SQL block byte-for-byte equal to the approved plan", () => {
    const plan = readFileSync(new URL("../../../../docs/plans/Revamp-TB5A-Stage-And-Kanban-Ordering-Contract-Plan.md", import.meta.url), "utf8");
    const blocks = [...plan.matchAll(/```sql\n([\s\S]*?)```/g)].map((match) => match[1]!);
    expect(APPEND_STAGE_BOTTOM_SQL).toBe(blocks.find((block) => block.includes("SELECT COALESCE(MAX(board_position) + 1024, 0)")));
    expect(NORMATIVE_NON_COMPACTING_EXACT_SQL).toBe(blocks.find((block) => block.includes("board_position = ?8")));
    expect(NORMATIVE_COMPACTING_SQL).toBe(blocks.find((block) => block.includes("changed_plan AS")));
    expect(NORMATIVE_AUDIT_MARKER_SQL).toBe(blocks.find((block) => block.includes("WHERE changes() = ?7")));
    expect(NORMATIVE_HANDOFF_EDITING_ENTRY_TOKEN_SQL).toBe(blocks.find((block) => block.includes("UPDATE autohdr_handoffs")));
    expect(NORMATIVE_JOB_EDITING_ENTRY_TOKEN_SQL).toBe(blocks.find((block) => block.includes("UPDATE jobs") && block.includes("stage_entry_board_revision")));
  });

  it("runs the non-compacting append winner at MAX + 1024 and fences exact placement", async () => {
    const db = localSqlite();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyAllMigrations(db);
      seedFeatureFlag(db);
      seedProject(db, { id: "target", stageKey: "raw_review", boardRevision: 5 });
      const d1 = localD1(db);
      const append = buildNonCompactingStageWinner({ ...baseStageInput(d1), placement: "append", expectedTarget: [], expectedTargetRowCount: 0 });
      const appendResults = await executeBundle(d1, append);
      expect((appendResults[append.indexes.winner]!.results as SqliteRow[])).toEqual([{ id: "target", stage_key: "edited_review", board_position: 0, board_revision: 6 }]);
      expect((appendResults[append.indexes.auditMarker]!.results as SqliteRow[])).toEqual([{ id: "audit-stage" }]);
      expect(db.prepare("SELECT stage_key, board_position, board_revision FROM projects WHERE id = 'target'").get()).toEqual({ stage_key: "edited_review", board_position: 0, board_revision: 6 });

      db.prepare("DELETE FROM audit_log WHERE id = 'audit-stage'").run();
      db.prepare("UPDATE projects SET stage_key = 'raw_review', board_position = 3, board_revision = 5 WHERE id = 'target'").run();
      seedProject(db, { id: "destination", stageKey: "edited_review", boardPosition: 1024, boardRevision: 8 });
      const expected: ExpectedTargetPlacementRow[] = [{ projectId: "destination", stageKey: "edited_review", boardPosition: 1024, boardRevision: 8 }];
      const exact = buildNonCompactingStageWinner({ ...baseStageInput(d1), placement: "exact", expectedTarget: expected, boardPosition: 512, expectedTargetRowCount: 1 });
      const exactResults = await executeBundle(d1, exact);
      expect((exactResults[exact.indexes.winner]!.results as SqliteRow[])).toHaveLength(1);
      expect((exactResults[exact.indexes.winner]!.results as SqliteRow[])[0]).toMatchObject({ id: "target", board_position: 512, board_revision: 6 });
      expect((exactResults[exact.indexes.auditMarker]!.results as SqliteRow[])).toEqual([{ id: "audit-stage" }]);

      db.prepare("DELETE FROM audit_log WHERE id = 'audit-stage'").run();
      db.prepare("UPDATE projects SET stage_key = 'raw_review', board_position = 3, board_revision = 5 WHERE id = 'target'").run();
      db.prepare("UPDATE projects SET board_position = 2048 WHERE id = 'destination'").run();
      const stale = buildNonCompactingStageWinner({ ...baseStageInput(d1), placement: "exact", expectedTarget: expected, boardPosition: 512, expectedTargetRowCount: 1 });
      const staleResults = await executeBundle(d1, stale);
      expect(staleResults[stale.indexes.winner]!.results).toEqual([]);
      expect(staleResults[stale.indexes.auditMarker]!.results).toEqual([]);
      expect(db.prepare("SELECT stage_key, board_position, board_revision FROM projects WHERE id = 'target'").get()).toEqual({ stage_key: "raw_review", board_position: 3, board_revision: 5 });
      expect(db.prepare("SELECT id FROM audit_log WHERE id = 'audit-stage'").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("runs compacting normalization as one all-or-zero update and audits changes()", async () => {
    const db = localSqlite();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyAllMigrations(db);
      seedFeatureFlag(db);
      const fixture = compactFixture(db);
      const d1 = localD1(db);
      const bundle = buildCompactingStageWinner({ ...baseStageInput(d1), expectedTarget: fixture.expected, changedPlan: fixture.changed, expectedTargetRowCount: 2, expectedChangedRowCount: 3 });
      const results = await executeBundle(d1, bundle);
      expect((results[bundle.indexes.winner]!.results as SqliteRow[])).toHaveLength(3);
      expect(results[bundle.indexes.winner]!.meta.changes).toBe(3);
      expect((results[bundle.indexes.auditMarker]!.results as SqliteRow[])).toEqual([{ id: "audit-stage" }]);
      expect(db.prepare("SELECT id, stage_key, board_position, board_revision FROM projects ORDER BY id").all()).toEqual([
        { id: "sibling-a", stage_key: "edited_review", board_position: 0, board_revision: 3 },
        { id: "sibling-b", stage_key: "edited_review", board_position: 2048, board_revision: 4 },
        { id: "target", stage_key: "edited_review", board_position: 1024, board_revision: 6 },
      ]);
    } finally {
      db.close();
    }
  });

  it.each([
    "duplicate expected ID",
    "duplicate changed-plan ID",
    "sibling flagged target",
    "stale old tuple",
    "missing changing row",
    "extra unchanged sibling",
    "extra expected row",
    "wrong changed-row count",
    "concurrent snapshot drift",
  ])("rejects malformed compacting plan: %s", async (caseName) => {
    const db = localSqlite();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyAllMigrations(db);
      seedFeatureFlag(db);
      const fixture = compactFixture(db);
      let expected = fixture.expected;
      let changed = fixture.changed;
      let expectedCount = 2;
      let changedCount = 3;
      if (caseName === "duplicate expected ID") expected = [fixture.expected[0]!, fixture.expected[0]!];
      if (caseName === "duplicate changed-plan ID") changed = [fixture.changed[0]!, fixture.changed[0]!, fixture.changed[2]!];
      if (caseName === "sibling flagged target") changed = fixture.changed.map((row, index) => index === 1 ? { ...row, isTarget: 1 } : row);
      if (caseName === "stale old tuple") changed = fixture.changed.map((row, index) => index === 1 ? { ...row, oldBoardRevision: 999 } : row);
      if (caseName === "missing changing row") { changed = fixture.changed.slice(0, 2); changedCount = 2; }
      if (caseName === "extra unchanged sibling") { changed = [...fixture.changed, { projectId: "sibling-b", oldStageKey: "edited_review", oldBoardPosition: 4096, oldBoardRevision: 3, newBoardPosition: 4096, isTarget: 0 }]; changedCount = 4; }
      if (caseName === "extra expected row") { expected = [...fixture.expected, { projectId: "ghost", stageKey: "edited_review", boardPosition: 8192, boardRevision: 1, newBoardPosition: 4096 }]; expectedCount = 3; }
      if (caseName === "wrong changed-row count") changedCount = 2;
      if (caseName === "concurrent snapshot drift") db.prepare("UPDATE projects SET board_position = 8192 WHERE id = 'sibling-b'").run();
      const d1 = localD1(db);
      const bundle = buildCompactingStageWinner({ ...baseStageInput(d1), expectedTarget: expected, changedPlan: changed, expectedTargetRowCount: expectedCount, expectedChangedRowCount: changedCount });
      const before = db.prepare("SELECT id, stage_key, board_position, board_revision FROM projects ORDER BY id").all();
      const results = await executeBundle(d1, bundle);
      expect(results[bundle.indexes.winner]!.results).toEqual([]);
      expect(results[bundle.indexes.auditMarker]!.results).toEqual([]);
      expect(db.prepare("SELECT id, stage_key, board_position, board_revision FROM projects ORDER BY id").all()).toEqual(before);
      expect(db.prepare("SELECT id FROM audit_log WHERE id = 'audit-stage'").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("pins both snapshot fences in the query plan", () => {
    const db = localSqlite();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyAllMigrations(db);
      const exactPlan = db.prepare(`EXPLAIN QUERY PLAN ${NORMATIVE_NON_COMPACTING_EXACT_SQL}`).all("[]", "tb5a_board_contract_enabled", 0, "edited_review", "target", "raw_review", 5, 0, 1_787_000_000_100) as SqliteRow[];
      const compactPlan = db.prepare(`EXPLAIN QUERY PLAN ${NORMATIVE_COMPACTING_SQL}`).all("[]", "[]", "tb5a_board_contract_enabled", 1, 0, "edited_review", "target", "raw_review", 5, 1_787_000_000_100) as SqliteRow[];
      expect(exactPlan.some((row) => String(row.detail).includes("MATERIALIZE fence"))).toBe(true);
      expect(compactPlan.some((row) => String(row.detail).includes("MATERIALIZE fence"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("writes the SQL-reread handoff token and rejects the rev 5 -> 6 -> 7 ABA", async () => {
    const db = localSqlite();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyAllMigrations(db);
      seedProject(db, { id: "target", stageKey: "editing_autohdr", boardRevision: 5 });
      db.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES ('connection', 'dropbox', 'connected', 1, 1)").run();
      db.prepare("INSERT INTO jobs (id, kind, status, project_id, payload_json, created_at, updated_at) VALUES ('entry-job', 'autohdr', 'running', 'target', '{\"projectId\":\"target\",\"generation\":1}', 1, 1)").run();
      db.prepare("INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, state, workflow_id, job_id, lease_expires_at, created_at, updated_at) VALUES ('handoff', 'target', 'connection', 1, 'hash', '[]', '[]', '/Raw/target', 'started', 'workflow', 'entry-job', 2, 1, 1)").run();
      audit(db, "audit-token");
      const d1 = localD1(db);
      const token = buildEditingEntryTokenTail({ db: d1, owner: "handoff", projectId: "target", handoffId: "handoff", connectionId: "connection", generation: 1, state: "started", expectedPriorToken: null, auditId: "audit-token", updatedAt: 1_787_000_000_101 });
      const tokenResults = await executeBundle(d1, token);
      expect(tokenResults[0]!.results).toEqual([{ id: "handoff", project_id: "target", generation: 1, editing_entry_board_revision: 5 }]);
      expect(db.prepare("SELECT editing_entry_board_revision FROM autohdr_handoffs WHERE id = 'handoff'").get()).toEqual({ editing_entry_board_revision: 5 });

      db.prepare("UPDATE projects SET stage_key = 'raw_review', board_revision = 6 WHERE id = 'target'").run();
      db.prepare("UPDATE projects SET stage_key = 'editing_autohdr', board_revision = 7 WHERE id = 'target'").run();
      const completion = db.prepare("UPDATE projects SET stage_key = 'edited_review' WHERE id = ? AND stage_key = 'editing_autohdr' AND board_revision = ?").run("target", 5) as { changes?: number };
      expect(completion.changes).toBe(0);

      db.prepare("UPDATE projects SET board_revision = 7 WHERE id = 'target'").run();
      db.prepare("UPDATE autohdr_handoffs SET editing_entry_board_revision = NULL WHERE id = 'handoff'").run();
      const wrongOwner = buildEditingEntryTokenTail({ db: d1, owner: "handoff", projectId: "target", handoffId: "handoff", connectionId: "wrong-connection", generation: 1, state: "started", expectedPriorToken: null, auditId: "audit-token", updatedAt: 1_787_000_000_102 });
      expect((await executeBundle(d1, wrongOwner))[0]!.results).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rejects every independently stale handoff token premise", async () => {
    const cases = [
      { name: "wrong connection", connectionId: "wrong-connection", generation: 1, state: "started", expectedPriorToken: null, projectStage: "editing_autohdr" },
      { name: "wrong generation", connectionId: "connection", generation: 2, state: "started", expectedPriorToken: null, projectStage: "editing_autohdr" },
      { name: "wrong state", connectionId: "connection", generation: 1, state: "starting", expectedPriorToken: null, projectStage: "editing_autohdr" },
      { name: "non-null token when NULL expected", connectionId: "connection", generation: 1, state: "started", expectedPriorToken: null, projectStage: "editing_autohdr", storedToken: 4 },
      { name: "project not in Editing", connectionId: "connection", generation: 1, state: "started", expectedPriorToken: null, projectStage: "raw_review" },
    ] as const;

    for (const premise of cases) {
      const db = localSqlite();
      try {
        db.exec("PRAGMA foreign_keys = ON");
        applyAllMigrations(db);
        seedProject(db, { id: "target", stageKey: premise.projectStage, boardRevision: 5 });
        db.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES ('connection', 'dropbox', 'connected', 1, 1)").run();
        db.prepare("INSERT INTO jobs (id, kind, status, project_id, payload_json, created_at, updated_at) VALUES ('entry-job', 'autohdr', 'running', 'target', '{\"projectId\":\"target\",\"generation\":1}', 1, 1)").run();
        db.prepare("INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, state, workflow_id, job_id, lease_expires_at, editing_entry_board_revision, created_at, updated_at) VALUES ('handoff', 'target', 'connection', 1, 'hash', '[]', '[]', '/Raw/target', 'started', 'workflow', 'entry-job', 2, ?, 1, 1)").run(premise.storedToken ?? null);
        audit(db, "audit-token");
        const d1 = localD1(db);
        const token = buildEditingEntryTokenTail({
          db: d1,
          owner: "handoff",
          projectId: "target",
          handoffId: "handoff",
          connectionId: premise.connectionId,
          generation: premise.generation,
          state: premise.state,
          expectedPriorToken: premise.expectedPriorToken,
          auditId: "audit-token",
          updatedAt: 1_787_000_000_103,
        });
        expect((await executeBundle(d1, token))[0]!.results, premise.name).toEqual([]);
      } finally {
        db.close();
      }
    }
  });

  it("identifies a final claim by its natural key rather than a fetch-claim id", async () => {
    const db = localSqlite();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyAllMigrations(db);
      seedProject(db, { id: "target", stageKey: "editing_autohdr", boardRevision: 5 });
      db.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES ('connection', 'dropbox', 'connected', 1, 1)").run();
      db.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES ('edited-collection', 'target', 'edited', 'received', 1, 1, 1)").run();
      db.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES ('asset', 'edited-collection', 'edited/asset.jpg', 'asset.jpg', 1, 'dropbox', 1, 1)").run();
      db.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES ('send-job', 'autohdr', 'done', 'target', 1, 1)").run();
      db.prepare("INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, state, workflow_id, job_id, lease_expires_at, created_at, updated_at) VALUES ('handoff', 'target', 'connection', 1, 'hash', '[]', '[]', '/Raw/target', 'started', 'workflow', 'send-job', 2, 1, 1)").run();
      db.prepare("INSERT INTO autohdr_output_mappings (id, project_id, handoff_id, connection_id, generation, state, created_at, updated_at) VALUES ('mapping', 'target', 'handoff', 'connection', 1, 'active', 1, 1)").run();
      db.prepare("INSERT INTO edited_source_claims (id, collection_id, source_path_key, current_asset_id, content_hash, handoff_id, created_at, updated_at) VALUES ('edited-claim', 'edited-collection', '/autohdr/final/asset.jpg', 'asset', 'hash', 'handoff', 1, 1)").run();
      audit(db, "audit-final");

      const d1 = localD1(db);
      const tail = buildWorkflowTail({
        db: d1,
        auditId: "audit-final",
        kind: "autohdr_final_claim",
        collectionId: "edited-collection",
        sourcePathKey: "/autohdr/final/asset.jpg",
        handoffId: "handoff",
        mappingId: "mapping",
        currentAssetId: "asset",
      }, "autohdr_final_completion");
      const results = await executeBundle(d1, tail);
      expect(results[tail.indexes.prerequisiteMarker]!.results).toEqual([{ id: "edited-claim" }]);
      expect(results[tail.indexes.finalClaimState]!.results).toEqual([{ id: "edited-claim", current_asset_id: "asset" }]);
    } finally {
      db.close();
    }
  });

  it("fails closed for missing source-entry-job provenance", async () => {
    const db = localSqlite();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyAllMigrations(db);
      seedProject(db, { id: "target", stageKey: "editing_autohdr", boardRevision: 7 });
      db.prepare("INSERT INTO jobs (id, kind, status, project_id, payload_json, created_at, updated_at) VALUES ('completion-job', 'fetch_edited', 'done', 'target', '{\"projectId\":\"target\",\"generation\":1,\"stageEntrySourceJobId\":\"completion-job\"}', 1, 1)").run();
      audit(db, "audit-completion");
      const d1 = localD1(db);
      const bundle = buildWorkflowTail({ db: d1, auditId: "audit-completion", kind: "autohdr_job", jobId: "completion-job", generation: 1, projectId: "target", jobKind: "fetch_edited", sourceJobKind: "autohdr", sourceJobId: "completion-job" }, "autohdr_job_completion");
      const results = await executeBundle(d1, bundle);
      expect(results[bundle.indexes.sourceEntryJob]!.results).toEqual([]);
      expect(bundle.indexes.completionJobState).toBe(2);
    } finally {
      db.close();
    }
  });

  it("uses the propagated source entry job and rejects an equal-revision impostor", async () => {
    const db = localSqlite();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyAllMigrations(db);
      seedProject(db, { id: "target", stageKey: "editing_autohdr", boardRevision: 5 });
      db.prepare("INSERT INTO jobs (id, kind, status, project_id, payload_json, stage_entry_board_revision, created_at, updated_at) VALUES ('entry-job', 'autohdr', 'done', 'target', '{\"projectId\":\"target\",\"generation\":1,\"stageEntrySourceJobId\":\"entry-job\",\"stageEntryGeneration\":1}', 5, 1, 1)").run();
      db.prepare("INSERT INTO jobs (id, kind, status, project_id, payload_json, stage_entry_board_revision, created_at, updated_at) VALUES ('completion-job', 'fetch_edited', 'done', 'target', '{\"projectId\":\"target\",\"generation\":1,\"stageEntrySourceJobId\":\"entry-job\",\"stageEntryGeneration\":1}', NULL, 1, 1)").run();
      audit(db, "audit-completion");
      const d1 = localD1(db);
      const valid = buildWorkflowTail({ db: d1, auditId: "audit-completion", kind: "autohdr_job", jobId: "completion-job", generation: 1, projectId: "target", jobKind: "fetch_edited", sourceJobKind: "autohdr", sourceJobId: "entry-job" }, "autohdr_job_completion");
      const validResults = await executeBundle(d1, valid);
      expect(validResults[valid.indexes.sourceEntryJob]!.results).toEqual([{ id: "entry-job", project_id: "target", stage_entry_board_revision: 5 }]);
      expect(validResults[valid.indexes.completionJobState]!.results).toEqual([{ id: "completion-job", status: "done" }]);

      db.prepare("UPDATE jobs SET payload_json = '{\"projectId\":\"target\",\"generation\":1,\"stageEntrySourceJobId\":\"impostor-job\",\"stageEntryGeneration\":1}' WHERE id = 'completion-job'").run();
      db.prepare("INSERT INTO jobs (id, kind, status, project_id, payload_json, stage_entry_board_revision, created_at, updated_at) VALUES ('impostor-job', 'autohdr', 'done', 'target', '{\"projectId\":\"target\",\"generation\":1}', 5, 1, 1)").run();
      const impostor = buildWorkflowTail({ db: d1, auditId: "audit-completion", kind: "autohdr_job", jobId: "completion-job", generation: 1, projectId: "target", jobKind: "fetch_edited", sourceJobKind: "autohdr", sourceJobId: "impostor-job" }, "autohdr_job_completion");
      const impostorResults = await executeBundle(d1, impostor);
      expect(impostorResults[impostor.indexes.sourceEntryJob]!.results).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("composes every optional bundle group with exact named offsets", () => {
    const prepares: Array<{ source: string; values: unknown[] }> = [];
    const db = {
      prepare(source: string) {
        return { bind(...values: unknown[]) { prepares.push({ source, values }); return { source, values }; } };
      },
    } as unknown as D1Database;
    const stage = buildNonCompactingStageWinner({ ...baseStageInput(db), placement: "append", expectedTarget: [] });
    const activity = buildStageActivityBundle({ db, projectId: "target", activityId: "activity", actorId: "actor", winnerAuditId: "audit-stage" });
    const deadline = buildDeadlineSuppressionBundle({ db, projectId: "target", reason: "project_delivered", auditId: "audit-stage" });
    const workflowKinds = [
      "none",
      "raw_reconciliation",
      "autohdr_handoff_entry",
      "autohdr_mapping_entry",
      "autohdr_final_completion",
      "autohdr_job_entry",
      "autohdr_job_completion",
    ] as const;
    const prerequisites = [
      { kind: "none" as const },
      { kind: "raw_reconciliation" as const, claimId: "claim", shootDate: "2026-08-29" },
      { kind: "autohdr_handoff" as const, handoffId: "handoff", generation: 1, connectionId: "connection" },
      { kind: "autohdr_mapping" as const, mappingId: "mapping", handoffId: "handoff", generation: 1 },
      { kind: "autohdr_final_claim" as const, collectionId: "collection", sourcePathKey: "/autohdr/final/capture.jpg", handoffId: "handoff", mappingId: "mapping", currentAssetId: "asset" },
      { kind: "autohdr_job" as const, jobId: "job", generation: 1, projectId: "target" },
      { kind: "autohdr_job" as const, jobId: "job", generation: 1, projectId: "target" },
    ] as const;
    const optionalShapes = [
      {},
      { activity },
      { deadline },
      { activity, deadline },
    ] as const;
    for (const [index, workflowKind] of workflowKinds.entries()) {
      const workflow = buildWorkflowTail({ ...prerequisites[index]!, db, auditId: "audit-stage", projectId: "target", connectionId: "connection", jobKind: "autohdr" }, workflowKind);
      for (const optional of optionalShapes) {
        const composed = composeStageBundle({ stage, ...optional, workflow });
        expect(composed.indexes.stage).toEqual({ winner: 0, auditMarker: 1 });
        const activityCount = optional.activity ? 3 : 0;
        const deadlineCount = optional.deadline ? 3 : 0;
        if (optional.activity) expect(composed.indexes.activity).toEqual({ activity: 2, broadOutbox: 3, broadLedger: 4 });
        else expect(composed.indexes.activity).toBeUndefined();
        if (optional.deadline) expect(composed.indexes.deadline).toEqual({ occurrences: 2 + activityCount, ledgers: 3 + activityCount, outboxes: 4 + activityCount });
        else expect(composed.indexes.deadline).toBeUndefined();
        expect(composed.indexes.workflow.kind).toBe(workflowKind);
        const workflowBase = 2 + activityCount + deadlineCount;
        for (const [key, value] of Object.entries(workflow.indexes)) {
          if (typeof value === "number") expect((composed.indexes.workflow as Record<string, unknown>)[key]).toBe(workflowBase + value);
        }
      }
    }
    expect(prepares.length).toBeGreaterThan(0);
  });

  it("derives a finalizer only from full winner agreement", () => {
    const winner = {
      kind: "winner" as const,
      row: { projectId: "target", stageKey: "edited_review" as const, boardPosition: 0, boardRevision: 6 },
      auditId: "audit-stage",
      publicationIds: ["outbox-1"],
      legacyWorkflowNotification: "sent_to_editing" as const,
    };
    expect(deriveStageFinalizerIntent([winner, { ...winner, publicationIds: ["outbox-2"] }])).toEqual({ publicationIds: ["outbox-1", "outbox-2"], legacyWorkflowNotification: "sent_to_editing" });
    expect(deriveStageFinalizerIntent([])).toBeUndefined();
    expect(deriveStageFinalizerIntent([{ kind: "loser" }])).toBeUndefined();
    expect(deriveStageFinalizerIntent([winner, { ...winner, row: { ...winner.row, boardRevision: 7 } }])).toBeUndefined();
    expect(deriveStageFinalizerIntent([winner, { kind: "inconsistent" }])).toBeUndefined();
  });
});
