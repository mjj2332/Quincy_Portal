/**
 * #219 (PR A) fix — Sol review, sol1 item 3. `gantt-lib.tsx`'s shared overlap-policy helpers
 * (`resolveOverlapPolicy`, `overlapsAnyNeighbour`, `clampToNeighbours`), extracted from
 * `gantt-dnd.tsx`'s pointer-only closures so `gantt.tsx`'s keyboard `nudgeEvent` can reject/clamp
 * IDENTICALLY instead of ignoring "clamp" and only half-honouring "single" mode. Node suite
 * (`vitest.config.ts`): pure functions, no React, no store.
 */
import { describe, expect, it } from "vitest";
import {
  clampToNeighbours,
  overlapsAnyNeighbour,
  resolveOverlapPolicy,
  type GanttOverlapNeighbour,
} from "@/components/reui/gantt/gantt-lib";

const at = (h: number, m = 0) => new Date(2026, 0, 5, h, m, 0, 0);

describe("resolveOverlapPolicy", () => {
  it("a 'single' node always rejects, regardless of the option", () => {
    expect(resolveOverlapPolicy("single", "allow")).toBe("reject");
    expect(resolveOverlapPolicy("single", "clamp")).toBe("reject");
    expect(resolveOverlapPolicy("single", "reject")).toBe("reject");
  });

  it("any other cardinality defers to the option as-is", () => {
    expect(resolveOverlapPolicy("multiple", "allow")).toBe("allow");
    expect(resolveOverlapPolicy("multiple", "clamp")).toBe("clamp");
    expect(resolveOverlapPolicy("multiple", "reject")).toBe("reject");
  });
});

describe("overlapsAnyNeighbour", () => {
  it("true when the proposal's range intersects a neighbour's", () => {
    const neighbours: GanttOverlapNeighbour[] = [{ start: at(10).getTime(), end: at(11).getTime() }];
    expect(overlapsAnyNeighbour(neighbours, { start: at(10, 30), end: at(11, 30) })).toBe(true);
  });

  it("false when the proposal only touches a neighbour's edge (half-open ranges)", () => {
    const neighbours: GanttOverlapNeighbour[] = [{ start: at(10).getTime(), end: at(11).getTime() }];
    expect(overlapsAnyNeighbour(neighbours, { start: at(11), end: at(12) })).toBe(false);
    expect(overlapsAnyNeighbour(neighbours, { start: at(9), end: at(10) })).toBe(false);
  });

  it("false with no neighbours", () => {
    expect(overlapsAnyNeighbour([], { start: at(10), end: at(11) })).toBe(false);
  });
});

describe("clampToNeighbours", () => {
  const anchor = { start: at(10), end: at(11) };

  it("a non-'clamp' policy passes the proposal through unchanged", () => {
    const proposal = { start: at(10, 30), end: at(11, 30) };
    expect(clampToNeighbours("move", anchor, proposal, [], "allow")).toEqual(proposal);
    expect(clampToNeighbours("move", anchor, proposal, [], "reject")).toEqual(proposal);
  });

  it("resize-end stops at the nearest ceiling neighbour", () => {
    const neighbours: GanttOverlapNeighbour[] = [{ start: at(11, 30).getTime(), end: at(12).getTime() }];
    const proposal = { start: at(10), end: at(12) }; // would overlap [11:30, 12:00)
    const clamped = clampToNeighbours("resize-end", anchor, proposal, neighbours, "clamp");
    expect(clamped).toEqual({ start: at(10), end: at(11, 30) });
  });

  it("resize-start stops at the nearest floor neighbour", () => {
    const neighbours: GanttOverlapNeighbour[] = [{ start: at(9).getTime(), end: at(9, 30).getTime() }];
    const proposal = { start: at(8, 30), end: at(11) }; // would overlap [9:00, 9:30)
    const clamped = clampToNeighbours("resize-start", anchor, proposal, neighbours, "clamp");
    expect(clamped).toEqual({ start: at(9, 30), end: at(11) });
  });

  it("move parks against whichever edge it meets, preserving duration", () => {
    const neighbours: GanttOverlapNeighbour[] = [{ start: at(11, 30).getTime(), end: at(12, 30).getTime() }];
    const proposal = { start: at(11), end: at(12) }; // 1h span, would overlap the neighbour
    const clamped = clampToNeighbours("move", anchor, proposal, neighbours, "clamp");
    expect(clamped).toEqual({ start: at(10, 30), end: at(11, 30) });
    expect(clamped.end.getTime() - clamped.start.getTime()).toBe(60 * 60000);
  });

  it("move in the OTHER direction parks against the floor, preserving duration", () => {
    const neighbours: GanttOverlapNeighbour[] = [{ start: at(8).getTime(), end: at(9).getTime() }];
    const proposal = { start: at(8, 30), end: at(9, 30) };
    const clamped = clampToNeighbours("move", anchor, proposal, neighbours, "clamp");
    expect(clamped).toEqual({ start: at(9), end: at(10) });
  });

  it("a bar wedged exactly between two neighbours (zero slack either side) snaps back to its own anchor position", () => {
    // floor sits exactly at the anchor's own start, ceiling exactly at its own end: the window
    // equals the bar's duration with no room to move either way. This exercises the second
    // `from < floor` recheck after the ceiling correction - the move commits back to the anchor.
    const neighbours: GanttOverlapNeighbour[] = [
      { start: at(9).getTime(), end: at(10).getTime() }, // floor = anchor.start
      { start: at(11).getTime(), end: at(12).getTime() }, // ceiling = anchor.end
    ];
    const proposal = { start: at(9, 30), end: at(10, 30) };
    const clamped = clampToNeighbours("move", anchor, proposal, neighbours, "clamp");
    expect(clamped).toEqual(anchor);
  });

  it("neighbours that are not clear of the anchor's CURRENT span never clamp (a pre-existing overlap has no edge)", () => {
    // This neighbour already overlaps the anchor [10:00, 11:00) itself.
    const neighbours: GanttOverlapNeighbour[] = [{ start: at(10, 30).getTime(), end: at(11, 30).getTime() }];
    const proposal = { start: at(10, 15), end: at(11, 15) };
    expect(clampToNeighbours("move", anchor, proposal, neighbours, "clamp")).toEqual(proposal);
  });
});
