import { describe, expect, it } from "vitest";
import { frameFraction, spanFractions } from "./video-timeline-geometry";

describe("video-timeline-geometry (#741 5b)", () => {
  it("frame 0 is 0 and the last frame is 1", () => {
    expect(frameFraction(0, 300)).toBe(0);
    expect(frameFraction(299, 300)).toBe(1);
    expect(frameFraction(149.5, 300)).toBeCloseTo(0.5, 5);
  });

  it("a one-frame film does not divide by zero", () => {
    expect(frameFraction(0, 1)).toBe(0);
    expect(Number.isNaN(frameFraction(0, 1))).toBe(false);
  });

  it("clamps outside the film", () => {
    expect(frameFraction(-5, 300)).toBe(0);
    expect(frameFraction(900, 300)).toBe(1);
  });

  it("a span ends at the last included frame (end - 1), clamped to the last frame", () => {
    expect(spanFractions(0, 300, 300)).toEqual([0, 1]);
    expect(spanFractions(10, 21, 300)).toEqual([frameFraction(10, 300), frameFraction(20, 300)]);
    expect(spanFractions(10, 9999, 300)[1]).toBe(1);
  });
});
