import { describe, expect, it } from "vitest";
import { frameFraction, nearestMarkerId, spanFractions } from "./video-timeline-geometry";

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

describe("nearestMarkerId (#741 5b)", () => {
  const markers = [
    { id: "a", startFrame: 0, endFrame: null },
    { id: "b", startFrame: 150, endFrame: null },
    { id: "r", startFrame: 200, endFrame: 251 },
  ];
  // 1000px lane, 6px thumb half: frame f sits at 6 + 988 * f / 299.
  const x = (frame: number) => 6 + (988 * frame) / 299;

  it("picks the marker under the pointer, within 8px", () => {
    expect(nearestMarkerId(markers, 300, x(150) + 5, 1000, 6)).toBe("b");
    expect(nearestMarkerId(markers, 300, x(0) - 3, 1000, 6)).toBe("a");
  });

  it("picks nothing when no marker is within reach", () => {
    expect(nearestMarkerId(markers, 300, x(100), 1000, 6)).toBeNull();
    expect(nearestMarkerId([], 300, 500, 1000, 6)).toBeNull();
  });

  it("a point inside a range bar is on the bar, and the nearest of two wins", () => {
    expect(nearestMarkerId(markers, 300, x(225), 1000, 6)).toBe("r");
    expect(nearestMarkerId([{ id: "p", startFrame: 10, endFrame: null }, { id: "q", startFrame: 12, endFrame: null }], 300, x(12) + 1, 1000, 6)).toBe("q");
  });
});
