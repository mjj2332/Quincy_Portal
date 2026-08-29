import { describe, expect, it } from "vitest";
import {
  buildCompactingStageWinner,
  type ChangedCompactionRow,
  type ExpectedTargetCompactionRow,
} from "../src";
import {
  FIXTURE_NOW,
  applyAllMigrations,
  enableBoardContract,
  localD1,
  localSqlite,
  seedContractProject,
  type SqliteDatabase,
} from "./tb5a-proof-support";

type BenchmarkRow = {
  destinationRows: number;
  changedPlanBytes: number;
  expectedTargetBytes: number;
  executionMs: number;
  returningRows: number;
  revisionsIncremented: number;
};

function boardRows(db: SqliteDatabase): Array<{ id: string; board_position: number; board_revision: number }> {
  return db.prepare("SELECT id, board_position, board_revision FROM projects WHERE archived_at IS NULL ORDER BY board_position, id").all() as Array<{ id: string; board_position: number; board_revision: number }>;
}

function compactingPlans(size: number): { expected: ExpectedTargetCompactionRow[]; changed: ChangedCompactionRow[] } {
  const expected: ExpectedTargetCompactionRow[] = [];
  const changed: ChangedCompactionRow[] = [{ projectId: "target", oldStageKey: "raw_review", oldBoardPosition: 777, oldBoardRevision: 5, newBoardPosition: 0, isTarget: 1 }];
  for (let index = 0; index < size; index += 1) {
    const id = `edited-${String(index).padStart(4, "0")}`;
    expected.push({ projectId: id, stageKey: "edited_review", boardPosition: index * 1024, boardRevision: 0, newBoardPosition: (index + 1) * 1024 });
    changed.push({ projectId: id, oldStageKey: "edited_review", oldBoardPosition: index * 1024, oldBoardRevision: 0, newBoardPosition: (index + 1) * 1024, isTarget: 0 });
  }
  return { expected, changed };
}

function seedBenchmarkDatabase(size: number): SqliteDatabase {
  const db = localSqlite();
  db.exec("PRAGMA foreign_keys = ON");
  applyAllMigrations(db);
  enableBoardContract(db);
  seedContractProject(db, { id: "target", stageKey: "raw_review", boardPosition: 777, boardRevision: 5 });
  for (let index = 0; index < size; index += 1) {
    seedContractProject(db, { id: `edited-${String(index).padStart(4, "0")}`, stageKey: "edited_review", boardPosition: index * 1024, boardRevision: 0 });
  }
  return db;
}

describe("TB5A Slice 8 compaction benchmark", () => {
  it("measures bounded full-column compactions and proves one revision bump per changed row", async () => {
    const measurements: BenchmarkRow[] = [];
    for (const size of [25, 100, 250, 500]) {
      const db = seedBenchmarkDatabase(size);
      try {
        const plans = compactingPlans(size);
        const expectedTargetJson = JSON.stringify(plans.expected);
        const changedPlanJson = JSON.stringify(plans.changed);
        const d1 = localD1(db);
        const bundle = buildCompactingStageWinner({
          db: d1,
          projectId: "target",
          from: "raw_review",
          to: "edited_review",
          oldBoardRevision: 5,
          expectedTargetJson,
          changedPlanJson,
          expectedTargetRowCount: size,
          expectedChangedRowCount: size + 1,
          auditId: `benchmark-audit-${size}`,
          actorId: null,
          updatedAt: FIXTURE_NOW,
        });

        const started = globalThis.performance.now();
        const results = await d1.batch(bundle.statements);
        const executionMs = globalThis.performance.now() - started;
        const rows = boardRows(db);
        expect(rows).toHaveLength(size + 1);
        expect(rows.map((row) => row.board_position)).toEqual(Array.from({ length: size + 1 }, (_, index) => index * 1024));
        expect(rows.find((row) => row.id === "target")?.board_revision).toBe(6);
        expect(rows.filter((row) => row.id !== "target").every((row) => row.board_revision === 1)).toBe(true);
        expect(results[bundle.indexes.winner]!.results).toHaveLength(size + 1);
        expect(results[bundle.indexes.auditMarker]!.results).toEqual([{ id: `benchmark-audit-${size}` }]);

        const row = {
          destinationRows: size,
          changedPlanBytes: Buffer.byteLength(changedPlanJson, "utf8"),
          expectedTargetBytes: Buffer.byteLength(expectedTargetJson, "utf8"),
          executionMs: Number(executionMs.toFixed(3)),
          returningRows: (results[bundle.indexes.winner]!.results as unknown[]).length,
          revisionsIncremented: rows.filter((candidate) => candidate.board_revision > 0).length,
        } satisfies BenchmarkRow;
        measurements.push(row);
      } finally {
        db.close();
      }
    }
    console.table(measurements);
    expect(measurements).toHaveLength(4);
    expect(measurements.every((row) => row.returningRows === row.destinationRows + 1)).toBe(true);
    expect(measurements.every((row) => row.revisionsIncremented === row.destinationRows + 1)).toBe(true);
  });
});
