import { describe, expect, it } from "vitest";
import { planBoardPlacement, type BoardProjectRow } from "../src/lib/project-board-order";

const row = (id: string, boardPosition: number, priority: number | null = null): BoardProjectRow => ({
  id, stageKey: "raw_review", priority, boardPosition, boardRevision: 0,
});

describe("project Board placement planning", () => {
  it("anchors between visible neighbours in the full semantic column", () => {
    const target = row("target", 0);
    const hidden = row("hidden", 1024);
    const after = row("after", 2048);
    const plan = planBoardPlacement({
      target,
      destinationRows: [target, hidden, after],
      visibleRows: [target, after],
      request: {
        expected: { stageKey: "raw_review", boardRevision: 0 },
        targetStageKey: "raw_review",
        placement: { kind: "between", before: null, after: { projectId: after.id, boardRevision: 0 } },
      },
    });
    expect(plan?.destination.map((item) => item.id)).toEqual(["hidden", "target", "after"]);
  });

  it("classifies append placement by the authoritative full column", () => {
    const target = row("target", 1024);
    const after = row("after", 2048);
    const plan = planBoardPlacement({
      target,
      destinationRows: [target, after],
      visibleRows: [target, after],
      request: {
        expected: { stageKey: "raw_review", boardRevision: 0 },
        targetStageKey: "raw_review",
        placement: { kind: "append" },
      },
    });
    expect(plan?.changed).toBe(true);
    const noChange = planBoardPlacement({
      target: after,
      destinationRows: [target, after],
      visibleRows: [target, after],
      request: {
        expected: { stageKey: "raw_review", boardRevision: 0 },
        targetStageKey: "raw_review",
        placement: { kind: "append" },
      },
    });
    expect(noChange?.changed).toBe(false);
  });

  it("holds an unprioritised card in a gap between prioritised cards (#106)", () => {
    const upper = row("upper", 3000, 1);
    const lower = row("lower", 4000, 4);
    const target = row("target", 5000);
    const rows = [upper, lower, target];
    const plan = planBoardPlacement({
      target,
      destinationRows: rows,
      visibleRows: rows,
      request: {
        expected: { stageKey: "raw_review", boardRevision: 0 },
        targetStageKey: "raw_review",
        placement: { kind: "between", before: { projectId: upper.id, boardRevision: 0 }, after: { projectId: lower.id, boardRevision: 0 } },
      },
    });
    expect(plan?.changed).toBe(true);
    expect(plan?.boardPosition).toBe(3500);
    expect(plan?.destination.map((item) => item.id)).toEqual(["upper", "target", "lower"]);
  });

  it("orders a Stage by Board position alone, whatever the Priorities (#106)", () => {
    const unprioritised = row("unprioritised", 0);
    const prioritised = row("prioritised", 1024, 1);
    const target = row("target", 2048);
    const plan = planBoardPlacement({
      target,
      destinationRows: [prioritised, target, unprioritised],
      visibleRows: [prioritised, target, unprioritised],
      request: {
        expected: { stageKey: "raw_review", boardRevision: 0 },
        targetStageKey: "raw_review",
        placement: { kind: "between", before: { projectId: prioritised.id, boardRevision: 0 }, after: null },
      },
    });
    // Already last after `prioritised` in position order, so the slot is unchanged.
    expect(plan?.changed).toBe(false);
    expect(plan?.destination.map((item) => item.id)).toEqual(["unprioritised", "prioritised", "target"]);
  });
});
