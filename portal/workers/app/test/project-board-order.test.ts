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
});
