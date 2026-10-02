import { describe, expect, it } from "vitest";
import { sortBoardCardsForRole, type VisibleBoardRow } from "../src/lib/project-board-order";

const card = (id: string, over: Partial<VisibleBoardRow> = {}): VisibleBoardRow => ({
  id, stageKey: "raw_review", priority: null, boardRevision: 0, street: "1 Alpha St", shootDate: null, ...over,
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
