import { describe, expect, it } from "vitest";
import {
  DRIFT_PLAYING_SECONDS,
  compareClock,
  driftedBeyond,
  markerPosition,
  pausedDriftTolerance,
  sideEnded,
  sideLocalSeconds,
  sideNotStarted,
} from "../src/video-compare";
import { rational } from "../src/video-rational";

const a25 = { fps: rational(25, 1), frameCount: 250 }; // 10 s
const b25 = { fps: rational(25, 1), frameCount: 300 }; // 12 s

describe("compareClock", () => {
  it("has no leads at zero offset and spans the longer side", () => {
    expect(compareClock(a25, b25, 0)).toEqual({ leadA: 0, leadB: 0, totalSeconds: 12 });
  });
  it("positive offset delays B by that many B-frames", () => {
    expect(compareClock(a25, b25, 25)).toEqual({ leadA: 0, leadB: 1, totalSeconds: 13 });
  });
  it("negative offset delays A, in B-frame time", () => {
    const c = compareClock(a25, b25, -50);
    expect(c.leadA).toBe(2);
    expect(c.leadB).toBe(0);
    expect(c.totalSeconds).toBe(12);
  });
  it("converts the offset at B's rate when fps differ (25 vs 29.97)", () => {
    const b = { fps: rational(30000, 1001), frameCount: 300 };
    const c = compareClock(a25, b, 30);
    expect(c.leadA).toBe(0);
    expect(c.leadB).toBeCloseTo((30 * 1001) / 30000, 12);
    expect(c.totalSeconds).toBeCloseTo(c.leadB + (300 * 1001) / 30000, 12);
    const d = compareClock(a25, b, -30);
    expect(d.leadA).toBeCloseTo((30 * 1001) / 30000, 12);
    expect(d.leadB).toBe(0);
  });
});

describe("side state", () => {
  it("holds the first frame, then parks mid-last-frame, never at the duration", () => {
    expect(sideLocalSeconds(1, 2, a25)).toBe(0);
    expect(sideLocalSeconds(5, 2, a25)).toBe(3);
    expect(sideLocalSeconds(100, 2, a25)).toBeCloseTo(9.98, 12);
    expect(sideLocalSeconds(100, 2, a25)).toBeLessThan(10);
  });
  it("tracks started / ended against the lead", () => {
    expect(sideNotStarted(1.9, 2)).toBe(true);
    expect(sideNotStarted(2, 2)).toBe(false);
    expect(sideEnded(11.9, 2, a25)).toBe(false);
    expect(sideEnded(12, 2, a25)).toBe(true);
  });
  it("handles an empty side", () => {
    expect(sideLocalSeconds(5, 0, { fps: rational(25, 1), frameCount: 0 })).toBe(0);
  });
});

describe("markerPosition", () => {
  it("places a frame at (lead + frame time) / total", () => {
    expect(markerPosition(50, a25, 2, 12)).toBeCloseTo(4 / 12, 12);
  });
  it("uses the side's own rate", () => {
    const b = { fps: rational(30000, 1001), frameCount: 300 };
    expect(markerPosition(30, b, 0, 12)).toBeCloseTo(((30 * 1001) / 30000) / 12, 12);
  });
  it("clamps to [0, 1] and survives a zero total", () => {
    expect(markerPosition(10000, a25, 0, 12)).toBe(1);
    expect(markerPosition(0, a25, 0, 0)).toBe(0);
  });
});

describe("drift", () => {
  it("playing tolerance is 50 ms, exclusive", () => {
    expect(DRIFT_PLAYING_SECONDS).toBe(0.05);
    expect(driftedBeyond(10, 10.049, DRIFT_PLAYING_SECONDS)).toBe(false);
    expect(driftedBeyond(10, 10.051, DRIFT_PLAYING_SECONDS)).toBe(true);
    expect(driftedBeyond(10, 9.94, DRIFT_PLAYING_SECONDS)).toBe(true);
  });
  it("paused tolerance is one frame of that side", () => {
    expect(pausedDriftTolerance(rational(25, 1))).toBe(0.04);
    expect(pausedDriftTolerance(rational(30000, 1001))).toBeCloseTo(1001 / 30000, 12);
    const tol = pausedDriftTolerance(rational(25, 1));
    expect(driftedBeyond(1, 1.03, tol)).toBe(false);
    expect(driftedBeyond(1, 1.05, tol)).toBe(true);
  });
});
