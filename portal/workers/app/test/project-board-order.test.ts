import { describe, expect, it } from "vitest";
import { planBoardPlacement, sortBoardCardsForRole, type BoardProjectRow, type VisibleBoardRow } from "../src/lib/project-board-order";

const row = (id: string, boardPosition: number, stageKey: BoardProjectRow["stageKey"] = "raw_review"): BoardProjectRow => ({
  id, stageKey, priority: null, boardPosition, boardRevision: 0,
});
const card = (id: string, over: Partial<VisibleBoardRow> = {}): VisibleBoardRow => ({
  id, stageKey: "raw_review", priority: null, boardPosition: 0, boardRevision: 0, street: "1 Alpha St", shootDate: null, ...over,
});

describe("project Board append planning (#470)", () => {
  it("appends a cross-Stage move after the last stored position of the destination column", () => {
    const target = row("target", 0, "awaiting_raw");
    const plan = planBoardPlacement({
      target,
      destinationRows: [row("a", 1024), row("b", 4096)],
      request: { targetStageKey: "raw_review" },
    });
    expect(plan.changed).toBe(true);
    expect(plan.boardPosition).toBe(5120);
    expect(plan.expectedTarget.map((item) => item.projectId)).toEqual(["a", "b"]);
  });

  it("is a no-op when the target is already in the requested Stage", () => {
    const target = row("target", 1024);
    const plan = planBoardPlacement({
      target,
      destinationRows: [target, row("other", 2048)],
      request: { targetStageKey: "raw_review" },
    });
    expect(plan.changed).toBe(false);
  });

  it("maps the Editing transport key to the stored editing_autohdr Stage", () => {
    const target = row("target", 0, "raw_review");
    expect(planBoardPlacement({ target, destinationRows: [], request: { targetStageKey: "editing" } }).changed).toBe(true);
    const editing = row("editing-card", 0, "editing_autohdr");
    expect(planBoardPlacement({ target: editing, destinationRows: [editing], request: { targetStageKey: "editing" } }).changed).toBe(false);
  });
});

describe("viewer Board order per role (#470)", () => {
  const rows = [
    card("late-p5", { priority: 5, shootDate: "2026-09-01" }),
    card("early-none", { shootDate: "2026-01-01" }),
    card("mid-p1", { priority: 1, shootDate: "2026-05-01" }),
  ];

  it("lets every internal role see priority in the order", () => {
    for (const role of ["admin", "editor", "photographer"] as const) {
      expect(sortBoardCardsForRole([...rows], role).map((item) => item.id)).toEqual(["late-p5", "mid-p1", "early-none"]);
    }
  });

  it("keeps priority out of the External Editor order", () => {
    expect(sortBoardCardsForRole([...rows], "external_editor").map((item) => item.id)).toEqual(["early-none", "mid-p1", "late-p5"]);
  });
});
