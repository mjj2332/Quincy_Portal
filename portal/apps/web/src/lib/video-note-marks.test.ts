import { describe, expect, it } from "vitest";
import { EMPTY_MARKS, clampMark, markFrame, marksToFrames, rangeStep } from "./video-note-marks";

describe("video-note-marks (#741 5b)", () => {
  it("I only and O only are point notes at the marked frame", () => {
    expect(marksToFrames(markFrame(EMPTY_MARKS, "in", 40), 300)).toEqual({ startFrame: 40, endFrame: null });
    expect(marksToFrames(markFrame(EMPTY_MARKS, "out", 55), 300)).toEqual({ startFrame: 55, endFrame: null });
  });

  it("no marks is no frames", () => {
    expect(marksToFrames(EMPTY_MARKS, 300)).toBeNull();
  });

  it("I then O stores the half-open range [in, out + 1)", () => {
    const marks = markFrame(markFrame(EMPTY_MARKS, "in", 10), "out", 20);
    expect(marksToFrames(marks, 300)).toEqual({ startFrame: 10, endFrame: 21 });
  });

  it("I and O on the same frame is a valid one-frame range", () => {
    const marks = markFrame(markFrame(EMPTY_MARKS, "in", 10), "out", 10);
    expect(marksToFrames(marks, 300)).toEqual({ startFrame: 10, endFrame: 11 });
  });

  it("O on the last frame stores frameCount", () => {
    const marks = markFrame(markFrame(EMPTY_MARKS, "in", 290), "out", 299);
    expect(marksToFrames(marks, 300)).toEqual({ startFrame: 290, endFrame: 300 });
  });

  it("a mark that crosses the other clears it, in both directions", () => {
    const withOut = markFrame(EMPTY_MARKS, "out", 20);
    expect(markFrame(withOut, "in", 30)).toEqual({ in: 30, out: null });
    const withIn = markFrame(EMPTY_MARKS, "in", 20);
    expect(markFrame(withIn, "out", 10)).toEqual({ in: null, out: 10 });
  });

  it("re-marking on the same side replaces it and keeps the other when it still orders", () => {
    const marks = markFrame(markFrame(EMPTY_MARKS, "in", 10), "out", 20);
    expect(markFrame(marks, "in", 15)).toEqual({ in: 15, out: 20 });
    expect(markFrame(marks, "out", 12)).toEqual({ in: 10, out: 12 });
  });

  it("clamps frames into the film", () => {
    expect(marksToFrames({ in: 999, out: null }, 300)).toEqual({ startFrame: 299, endFrame: null });
    expect(marksToFrames({ in: 10, out: 999 }, 300)).toEqual({ startFrame: 10, endFrame: 300 });
  });

});

describe("rangeStep / clampMark (#861)", () => {
  it("the button cycles in -> out -> clear, and an out-only mark reads as Set in", () => {
    expect(rangeStep(EMPTY_MARKS)).toBe("in");
    expect(rangeStep({ in: 4, out: null })).toBe("out");
    expect(rangeStep({ in: 4, out: 9 })).toBe("clear");
    expect(rangeStep({ in: null, out: 9 })).toBe("in");
  });

  it("dragging In never passes Out and Out never passes In, and both stay inside the film; equal is a one-frame range", () => {
    const marks = { in: 10, out: 20 };
    expect(clampMark(marks, "in", 25, 99)).toBe(20);
    expect(clampMark(marks, "out", 3, 99)).toBe(10);
    expect(clampMark(marks, "in", -5, 99)).toBe(0);
    expect(clampMark(marks, "out", 500, 99)).toBe(99);
    expect(clampMark({ in: 10, out: null }, "out", 2, 99)).toBe(10);
    expect(clampMark({ in: null, out: 7 }, "in", 50, 99)).toBe(7);
    expect(clampMark(EMPTY_MARKS, "in", 3.6, 99)).toBe(4);
  });
});
