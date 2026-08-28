import { describe, expect, it } from "vitest";
import { manualInsertNeighbors, orderedBoardRows, renumberedInsertPosition, type BoardRow } from "../src/lib/kanban-ordering";

const row = (id: string, boardPosition: number, priority: number | null): BoardRow => ({
  id,
  stageKey: "raw_review",
  priority,
  boardPosition,
});

describe("TB5A Slice 0 legacy Kanban ordering", () => {
  it("keeps orderedBoardRows on board_position then id, including null Priority and midpoint rows", () => {
    const rows = [
      row("null-first", 512, null),
      row("priority-midpoint", 1536, 2), // 1536 is the legacy midpoint from 1024 and 2048.
      row("priority-tie-b", 2048, 7),
      row("priority-tie-a", 2048, 1),
      row("null-tie-b", 3072, null),
      row("null-tie-a", 3072, null),
    ];

    expect(orderedBoardRows(rows).map((item) => item.id)).toEqual([
      "null-first",
      "priority-midpoint",
      "priority-tie-a",
      "priority-tie-b",
      "null-tie-a",
      "null-tie-b",
    ]);
  });

  it("derives the current directional neighbours for a fractional-position column", () => {
    const rows = [
      row("A", 1024, null),
      row("B", 1536, 2),
      row("C", 2048, null),
      row("D", 3072, 4),
    ];

    expect(manualInsertNeighbors(rows, "C", "up")).toEqual({
      beforeId: "A",
      afterId: "B",
      before: 1024,
      after: 1536,
    });
    expect(manualInsertNeighbors(rows, "C", "down")).toEqual({
      beforeId: "D",
      afterId: null,
      before: 3072,
      after: null,
    });
  });

  it("keeps the legacy renumber offset at 1024, 2048, …", () => {
    const result = renumberedInsertPosition([
      row("A", 1, null),
      row("B", 2, 3),
      row("C", 3, null),
    ], "A", "B");

    // Migration 0037 deliberately differs and starts at 0; this expectation is deleted in Slice 5.
    expect([...result.renumbered.entries()]).toEqual([["A", 1024], ["B", 2048], ["C", 3072]]);
    expect(result.position).toBe(1536);
  });
});
