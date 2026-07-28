import { describe, expect, it } from "vitest";
import { computeInsertPosition } from "@quincy/db";
import { manualInsertNeighbors, priorityInsertNeighbors, renumberedInsertPosition, type BoardRow } from "../src/lib/kanban-ordering";

const row = (id: string, boardPosition: number, priority: number | null = null): BoardRow => ({ id, stageKey: "raw_review", boardPosition, priority });

describe("Kanban ordering rules", () => {
  it("preserves the worked example's sibling positions", () => {
    let rows = [row("A", 1024), row("B", 2048), row("C", 3072)];
    const first = priorityInsertNeighbors(rows, "A", 8);
    rows = rows.map((item) => item.id === "A" ? { ...item, priority: 8, boardPosition: computeInsertPosition(first.before, first.after) } : item);
    const nudge = manualInsertNeighbors(rows, "B", "up")!;
    rows = rows.map((item) => item.id === "B" ? { ...item, boardPosition: computeInsertPosition(nudge.before, nudge.after) } : item);
    const before = new Map(rows.filter((item) => item.id !== "C").map((item) => [item.id, item.boardPosition]));
    const final = priorityInsertNeighbors(rows, "C", 5);
    expect(final.beforeId).toBe("A");
    expect(new Map(rows.filter((item) => item.id !== "C").map((item) => [item.id, item.boardPosition]))).toEqual(before);
  });

  it("inserts before the first non-empty sibling when no priority anchor qualifies", () => {
    const neighbors = priorityInsertNeighbors([row("A", 4096), row("B", 5120)], "A", 10);
    expect(neighbors).toMatchObject({ beforeId: null, afterId: "B", after: 5120 });
    expect(computeInsertPosition(neighbors.before, neighbors.after)).toBe(4096);
  });

  it("uses the last equal-priority sibling as the tie anchor and clears to the bottom", () => {
    const rows = [row("A", 1024), row("B", 2048, 5), row("C", 3072, 5)];
    expect(priorityInsertNeighbors(rows, "A", 5)).toMatchObject({ beforeId: "C", afterId: null });
    expect(priorityInsertNeighbors(rows, "B", null)).toMatchObject({ beforeId: "C", afterId: null });
  });

  it("treats column edges as no-ops and recomputes after in-memory renumbering", () => {
    const rows = [row("A", 1), row("B", 1), row("C", 2)];
    expect(manualInsertNeighbors(rows, "A", "up")).toBeNull();
    expect(manualInsertNeighbors(rows, "C", "down")).toBeNull();
    const neighbors = manualInsertNeighbors(rows, "C", "up")!;
    expect(computeInsertPosition(neighbors.before, neighbors.after)).toBe(1);
    const renumbered = renumberedInsertPosition(rows, neighbors.beforeId, neighbors.afterId);
    expect(renumbered.renumbered.get("A")).toBe(1024);
    expect(renumbered.position).toBe(1536);
  });
});
