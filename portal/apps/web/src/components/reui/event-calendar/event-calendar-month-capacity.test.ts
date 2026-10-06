/**
 * #614 PR B — cover for the month week-row's capacity split (`splitMonthRowCapacity`).
 * Quincy-authored, not a ReUI vendored file; it lives in the vendored directory so a re-vendor
 * trips over it (see `docs/adr/0009-*.md`).
 *
 * The defect: with `maxEventsPerCell: "auto"` at 1280x720 the measured cap is 1. A lane-0 bar
 * reserved that only row, so the timed-event "+N more" indicator rendered BELOW the lane spacer
 * and the cell's `overflow-hidden` clipped it. The invariant these tests pin: in every column,
 * rows used (bar lanes + shown timed chips + the indicator row) never exceed `cap`.
 */
import { describe, expect, it } from "vitest";
import {
  splitMonthRowCapacity,
  type MonthRowBar,
} from "@/components/reui/event-calendar/event-calendar-lib";

const OFFSETS = [0, 1, 2, 3, 4, 5, 6];
const bar = (key: string, lane: number, colStart: number, colSpan = 1): MonthRowBar => ({
  key,
  lane,
  colStart,
  colSpan,
});
const none = [0, 0, 0, 0, 0, 0, 0];

/** Rows a column actually paints: bar lanes + shown chips + indicator row. */
function rowsUsed(r: ReturnType<typeof splitMonthRowCapacity>, col: number): number {
  return r.reservedLanes[col]! + r.shownTimed[col]! + (r.showIndicator[col] ? 1 : 0);
}

describe("splitMonthRowCapacity", () => {
  it("cap 1, lane-0 bar over a column with timed chips: the bar is hidden and the indicator shows", () => {
    const timed = [0, 0, 21, 0, 0, 0, 0];
    const r = splitMonthRowCapacity({
      cap: 1,
      autoFit: true,
      offsets: OFFSETS,
      bars: [bar("b", 0, 2)],
      timedCounts: timed,
    });
    expect(r.visibleBarKeys).toEqual([]);
    expect([...r.hiddenBarKeysByCol[2]!]).toEqual(["b"]);
    expect(r.reservedLanes[2]).toBe(0);
    expect(r.showIndicator[2]).toBe(true);
    OFFSETS.forEach((_, c) => expect(rowsUsed(r, c)).toBeLessThanOrEqual(1));
  });

  it("cap 2 with no overflow: the bar stays", () => {
    const r = splitMonthRowCapacity({
      cap: 2,
      autoFit: true,
      offsets: OFFSETS,
      bars: [bar("b", 0, 1, 2)],
      timedCounts: [0, 1, 1, 0, 0, 0, 0],
    });
    expect(r.visibleBarKeys).toEqual(["b"]);
    expect(r.reservedLanes.slice(1, 3)).toEqual([1, 1]);
    expect(r.showIndicator.some(Boolean)).toBe(false);
    OFFSETS.forEach((_, c) => expect(rowsUsed(r, c)).toBeLessThanOrEqual(2));
  });

  it("a bar spanning columns where only one overflows: hidden, and listed for every covered column", () => {
    const r = splitMonthRowCapacity({
      cap: 1,
      autoFit: true,
      offsets: OFFSETS,
      bars: [bar("wide", 0, 1, 3)],
      timedCounts: [0, 0, 4, 0, 0, 0, 0],
    });
    expect(r.visibleBarKeys).toEqual([]);
    for (const c of [1, 2, 3]) expect([...r.hiddenBarKeysByCol[c]!]).toEqual(["wide"]);
    expect(r.hiddenBarKeysByCol[0]!.size).toBe(0);
    // the covered column that had no chips now shows the hidden bar via "+1 more"
    expect(r.showIndicator[1]).toBe(true);
    OFFSETS.forEach((_, c) => expect(rowsUsed(r, c)).toBeLessThanOrEqual(1));
  });

  it("adjacent last-lane bars are judged independently: only the bar over the overflowing column goes", () => {
    // Bars in one lane never overlap, so hiding one cannot change another's columns.
    const r = splitMonthRowCapacity({
      cap: 1,
      autoFit: true,
      offsets: OFFSETS,
      bars: [bar("a", 0, 0, 2), bar("c", 0, 2, 2)],
      timedCounts: [1, 0, 0, 0, 0, 0, 0],
    });
    expect(r.visibleBarKeys).toEqual(["c"]);
    expect([...r.hiddenBarKeysByCol[1]!]).toEqual(["a"]);
    expect(r.hiddenBarKeysByCol[2]!.size).toBe(0);
    OFFSETS.forEach((_, c) => expect(rowsUsed(r, c)).toBeLessThanOrEqual(1));
  });

  it("cap 3: only the last visible lane is a candidate; deeper lanes stay hidden as before", () => {
    const r = splitMonthRowCapacity({
      cap: 3,
      autoFit: true,
      offsets: OFFSETS,
      bars: [bar("l0", 0, 0), bar("l1", 1, 0), bar("l2", 2, 0), bar("l3", 3, 0)],
      timedCounts: none,
    });
    // col 0: lane 3 is already hidden (overflow), so the lane-2 bar goes too to fit the indicator
    expect(r.visibleBarKeys).toEqual(["l0", "l1"]);
    expect([...r.hiddenBarKeysByCol[0]!].sort()).toEqual(["l2", "l3"]);
    expect(r.reservedLanes[0]).toBe(2);
    expect(r.showIndicator[0]).toBe(true);
    expect(rowsUsed(r, 0)).toBeLessThanOrEqual(3);
  });

  it("autoFit off: unchanged - only lanes >= cap are hidden, nothing is given up for the indicator", () => {
    const r = splitMonthRowCapacity({
      cap: 1,
      autoFit: false,
      offsets: OFFSETS,
      bars: [bar("l0", 0, 2), bar("l1", 1, 2)],
      timedCounts: [0, 0, 21, 0, 0, 0, 0],
    });
    expect(r.visibleBarKeys).toEqual(["l0"]);
    expect([...r.hiddenBarKeysByCol[2]!]).toEqual(["l1"]);
    expect(r.reservedLanes[2]).toBe(1);
    expect(r.timedSlots[2]).toBe(0);
  });

  it("respects hidden columns: offsets that skip weekend days still cover by day offset", () => {
    const r = splitMonthRowCapacity({
      cap: 1,
      autoFit: true,
      offsets: [1, 2, 3, 4, 5], // Mon-Fri of a Sunday-start row
      bars: [bar("b", 0, 0, 3)], // Sun-Tue; Sun not rendered
      timedCounts: [0, 2, 0, 0, 0],
    });
    expect(r.visibleBarKeys).toEqual([]);
    expect([...r.hiddenBarKeysByCol[0]!]).toEqual(["b"]);
    expect([...r.hiddenBarKeysByCol[1]!]).toEqual(["b"]);
    expect(r.hiddenBarKeysByCol[2]!.size).toBe(0);
  });
});
