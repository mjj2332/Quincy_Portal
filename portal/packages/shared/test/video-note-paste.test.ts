import { describe, expect, it } from "vitest";
import { mapBoundary, mapFrame, planPaste, type PasteNote } from "../src/video-note-paste";
import { rational } from "../src/video-rational";

const F25 = rational(25, 1);
const F2997 = rational(30000, 1001);
const none = new Set<string>();
const note = (id: string, startFrame: number, endFrame: number | null = null, drawingFrame: number | null = null): PasteNote => ({
  id,
  startFrame,
  endFrame,
  drawingFrame,
});
const target = (fps = F2997, frameCount = 10000) => ({ fps, frameCount });

describe("mapFrame / mapBoundary", () => {
  it("is the identity at equal rates", () => {
    for (const f of [0, 1, 99, 100000]) {
      expect(mapFrame(f, F25, F25)).toBe(f);
      expect(mapBoundary(f, F25, F25)).toBe(f);
    }
  });
  it("maps by the source frame's middle moment, 25 -> 29.97", () => {
    // frame 25 spans 1.000-1.040 s, middle 1.020 s -> 1.020 * 29.97 = 30.57 -> 30
    expect(mapFrame(25, F25, F2997)).toBe(30);
    expect(mapFrame(0, F25, F2997)).toBe(0); // middle 0.02 s -> 0.59
    expect(mapFrame(1, F25, F2997)).toBe(1); // middle 0.06 s -> 1.79
  });
  it("maps by the middle moment, 29.97 -> 25", () => {
    // frame 30 spans 1.001-1.0343, middle 1.01768 -> 25.44 -> 25
    expect(mapFrame(30, F2997, F25)).toBe(25);
    expect(mapFrame(0, F2997, F25)).toBe(0);
  });
  it("rounds exclusive ends", () => {
    expect(mapBoundary(25, F25, F2997)).toBe(30); // 1.0 s -> 29.97
    expect(mapBoundary(1, F25, F2997)).toBe(1); // 0.04 s -> 1.1988
    expect(mapBoundary(30, F2997, F25)).toBe(25); // 1.001 s -> 25.025
  });
  it("is exact for large frames (no float drift)", () => {
    // 30000/1001 -> 25 fps at a large frame: compare to BigInt-derived closed form
    const f = 9_000_000;
    const expected = Number((BigInt(2 * f + 1) * 1001n * 25n) / (2n * 30000n * 1n));
    expect(mapFrame(f, F2997, F25)).toBe(expected);
  });
  it("rejects non-integer frames", () => {
    expect(() => mapFrame(1.5, F25, F25)).toThrow(RangeError);
  });
});

describe("planPaste", () => {
  it("maps the same moment across rates", () => {
    const [row] = planPaste([note("a", 25, 50)], F25, target(), 0, none);
    expect(row).toEqual({ noteId: "a", status: "mapped", startFrame: 30, endFrame: 60, drawingFrame: null, shortened: false });
    const [back] = planPaste([note("a", 30, 60)], F2997, target(F25), 0, none);
    expect(back).toMatchObject({ status: "mapped", startFrame: 25, endFrame: 50 });
  });
  it("is the identity at equal rates and keeps a point note a point", () => {
    expect(planPaste([note("a", 7)], F25, target(F25), 0, none)).toEqual([
      { noteId: "a", status: "mapped", startFrame: 7, endFrame: null, drawingFrame: null, shortened: false },
    ]);
  });
  it("applies a positive and a negative offset after mapping", () => {
    const [plus] = planPaste([note("a", 10, 20)], F25, target(F25), 5, none);
    expect(plus).toMatchObject({ startFrame: 15, endFrame: 25 });
    const [minus] = planPaste([note("a", 10, 20)], F25, target(F25), -4, none);
    expect(minus).toMatchObject({ startFrame: 6, endFrame: 16 });
  });
  it("skips before the start and past the end", () => {
    expect(planPaste([note("a", 3)], F25, target(F25), -4, none)[0]).toEqual({ noteId: "a", status: "skipped", reason: "before_start" });
    expect(planPaste([note("a", 100)], F25, target(F25, 100), 0, none)[0]).toEqual({ noteId: "a", status: "skipped", reason: "past_end" });
    expect(planPaste([note("a", 99)], F25, target(F25, 100), 0, none)[0]).toMatchObject({ status: "mapped", startFrame: 99 });
    expect(planPaste([note("a", 99)], F25, target(F25, 100), 1, none)[0]).toMatchObject({ status: "skipped", reason: "past_end" });
  });
  it("shortens a range that runs past the end", () => {
    expect(planPaste([note("a", 90, 120)], F25, target(F25, 100), 0, none)[0]).toEqual({
      noteId: "a", status: "mapped", startFrame: 90, endFrame: 100, drawingFrame: null, shortened: true,
    });
  });
  it("never collapses a range below one frame", () => {
    // 29.97 -> 25: a one-frame range maps to less than one target frame
    const [row] = planPaste([note("a", 31, 32)], F2997, target(F25), 0, none);
    expect(row).toMatchObject({ status: "mapped" });
    if (row?.status === "mapped") expect(row.endFrame! - row.startFrame).toBeGreaterThanOrEqual(1);
    const [exact] = planPaste([note("b", 5, 6)], F25, target(F25), 0, none);
    expect(exact).toMatchObject({ startFrame: 5, endFrame: 6, shortened: false });
  });
  it("keeps a one-frame range at the last frame as one frame, not shortened", () => {
    expect(planPaste([note("a", 99, 100)], F25, target(F25, 100), 0, none)[0]).toMatchObject({
      startFrame: 99, endFrame: 100, shortened: false,
    });
  });
  it("carries a drawing frame that stays on the note", () => {
    const rows = planPaste([note("p", 10, null, 10), note("r", 10, 20, 15)], F25, target(F25), 3, none);
    expect(rows[0]).toMatchObject({ status: "mapped", startFrame: 13, drawingFrame: 13 });
    expect(rows[1]).toMatchObject({ status: "mapped", startFrame: 13, endFrame: 23, drawingFrame: 18 });
  });
  it("skips (does not drop) markup that falls outside the mapped note", () => {
    const rows = planPaste(
      [note("point", 10, null, 11), note("before", 10, 20, 9), note("after", 10, 20, 20), note("shortened", 90, 120, 105)],
      F25,
      target(F25, 100),
      0,
      none,
    );
    for (const row of rows) expect(row).toMatchObject({ status: "skipped", reason: "drawing_outside" });
  });
  it("skips notes already copied", () => {
    const rows = planPaste([note("a", 1), note("b", 2)], F25, target(F25), 0, new Set(["a"]));
    expect(rows[0]).toEqual({ noteId: "a", status: "skipped", reason: "already_copied" });
    expect(rows[1]).toMatchObject({ status: "mapped" });
  });
  it("returns one row per note, in order", () => {
    const rows = planPaste([note("a", 1), note("b", 500), note("c", 3)], F25, target(F25, 100), 0, none);
    expect(rows.map((r) => r.noteId)).toEqual(["a", "b", "c"]);
  });
});
