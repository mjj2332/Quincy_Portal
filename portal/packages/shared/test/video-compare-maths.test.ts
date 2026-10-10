import { describe, expect, it } from "vitest";
import { aOf, bOf, compareDomain, driftDecision, medianOfLastThree, offsetBounds, phase } from "../src/video-compare";
import { rational } from "../src/video-rational";

const f25 = rational(25, 1);
const f2997 = rational(30000, 1001);
const f23976 = rational(24000, 1001);
const f5994 = rational(60000, 1001);
const f50 = rational(50, 1);

describe("bOf / aOf", () => {
  it("equal rates reduce to b = a - d", () => {
    for (const d of [-7, 0, 12]) for (const a of [-3, 0, 1, 99]) {
      expect(bOf(a, d, f25, f25)).toBe(a - d);
      expect(aOf(a, d, f25, f25)).toBe(a + d);
    }
  });
  it("25 <-> 29.97 maps the middle of each A frame exactly", () => {
    // A frame 0 spans 0..40 ms, middle 20 ms -> B frame floor(0.02 * 29.97) = 0; A frame 25 middle 1.02 s -> floor(30.57)=30
    expect(bOf(0, 0, f25, f2997)).toBe(0);
    expect(bOf(25, 0, f25, f2997)).toBe(30);
    // 1001/30000 s * 25 = 0.83417 A frames per B frame; B frame 30 middle = 30.5*1001/30000 = 1.0177 s -> A frame floor(25.44)=25
    expect(aOf(30, 0, f25, f2997)).toBe(25);
    // exact: A frame 1000 middle 40.02 s -> 40.02*29.97002997 = 1199.4 -> 1199
    expect(bOf(1000, 0, f25, f2997)).toBe(1199);
  });
  it("23.976 <-> 59.94: 5/2 B frames per A frame", () => {
    expect(bOf(0, 0, f23976, f5994)).toBe(1);
    expect(bOf(1, 0, f23976, f5994)).toBe(3);
    expect(bOf(2, 0, f23976, f5994)).toBe(6);
    expect(aOf(5, 0, f23976, f5994)).toBe(2);
    expect(aOf(4, 0, f23976, f5994)).toBe(1);
  });
  it("25 <-> 50 boundaries", () => {
    expect(bOf(0, 0, f25, f50)).toBe(1);
    expect(bOf(3, 0, f25, f50)).toBe(7);
    expect(aOf(0, 0, f25, f50)).toBe(0);
    expect(aOf(1, 0, f25, f50)).toBe(0);
    expect(aOf(2, 0, f25, f50)).toBe(1);
    expect(bOf(0, 0, f50, f25)).toBe(0);
    expect(bOf(1, 0, f50, f25)).toBe(0);
    expect(bOf(2, 0, f50, f25)).toBe(1);
    expect(aOf(0, 0, f50, f25)).toBe(1);
  });
  it("floors negatives (a before the start)", () => {
    expect(bOf(-1, 0, f25, f50)).toBe(-1);
    expect(bOf(-1, 0, f50, f25)).toBe(-1);
  });
  it("round-trips within one frame across mixed rates and offsets", () => {
    const pairs: Array<[typeof f25, typeof f25]> = [[f25, f2997], [f2997, f25], [f23976, f5994], [f5994, f23976], [f25, f50], [f50, f25], [f25, f25]];
    for (const [fa, fb] of pairs) for (const d of [-40, 0, 17]) for (let a = -50; a < 400; a += 7) {
      const b = bOf(a, d, fa, fb);
      const back = aOf(b, d, fa, fb);
      const bound = Math.max(1, Math.ceil((fa.num * fb.den) / (fa.den * fb.num)));
      expect(Math.abs(back - a)).toBeLessThanOrEqual(bound);
      // and the other way: b -> a -> b stays within the rate ratio
      const again = bOf(aOf(b, d, fa, fb), d, fa, fb);
      expect(Math.abs(again - b)).toBeLessThanOrEqual(Math.max(1, Math.ceil((fb.num * fa.den) / (fb.den * fa.num))));
    }
  });
  it("stays exact at large frame numbers", () => {
    // floor((2a+1) * 1001 * ... ) computed with BigInt by hand: (2_000_001 * 1 * 30000) / (2 * 25 * 1001)
    expect(bOf(1_000_000, 0, f25, f2997)).toBe(Number((2_000_001n * 30000n) / (50n * 1001n)));
    expect(bOf(1_000_000, 5, f25, f2997)).toBe(Number((2_000_001n * 30000n) / (50n * 1001n)) - 5);
  });
});

describe("compareDomain / offsetBounds", () => {
  const A = { fps: f25, frameCount: 100 };
  const B = { fps: f25, frameCount: 80 };
  it("is A's range at zero offset when A is longer", () => {
    expect(compareDomain(A, B, 0)).toEqual({ start: 0, end: 99 });
  });
  it("extends before 0 when B starts earlier (negative offset) and after when later", () => {
    expect(compareDomain(A, B, -10)).toEqual({ start: -10, end: 99 });
    expect(compareDomain(A, B, 30)).toEqual({ start: 0, end: 109 });
  });
  it("bounds leave at least one frame of overlap at both extremes", () => {
    for (const [fa, fb, na, nb] of [[f25, f25, 100, 80], [f25, f2997, 250, 300], [f23976, f5994, 48, 200], [f50, f25, 500, 40]] as const) {
      const a = { fps: fa, frameCount: na };
      const b = { fps: fb, frameCount: nb };
      const { min, max } = offsetBounds(a, b);
      for (const d of [min, max]) {
        let overlap = 0;
        for (let i = 0; i < na; i++) { const j = bOf(i, d, fa, fb); if (j >= 0 && j < nb) overlap++; }
        expect(overlap).toBeGreaterThanOrEqual(1);
      }
      for (const d of [min - 1, max + 1]) {
        let overlap = 0;
        for (let i = 0; i < na; i++) { const j = bOf(i, d, fa, fb); if (j >= 0 && j < nb) overlap++; }
        expect(overlap).toBe(0);
      }
    }
  });
  it("equal rates: bounds are (1 - nB) .. (nA - 1)", () => {
    expect(offsetBounds(A, B)).toEqual({ min: -79, max: 99 });
  });
});

describe("phase", () => {
  it("before / live / last / after", () => {
    expect(phase(-1, 9)).toBe("before");
    expect(phase(0, 9)).toBe("live");
    expect(phase(8, 9)).toBe("live");
    expect(phase(9, 9)).toBe("last");
    expect(phase(10, 9)).toBe("after");
    expect(phase(0, 0)).toBe("last");
  });
});

describe("driftDecision", () => {
  const base = { followerFps: f25, rate: 1, trimmed: 1 };
  it("does nothing inside the tolerance (max of 50 ms and a follower frame)", () => {
    expect(driftDecision({ ...base, driftSeconds: 0.04 })).toEqual({ action: "none" });
    // 24 fps follower: one frame is 41.7 ms < 50 ms, so tol is 50 ms; a 15 fps follower has a 66.7 ms frame
    expect(driftDecision({ ...base, followerFps: rational(15, 1), driftSeconds: 0.06 })).toEqual({ action: "none" });
    expect(driftDecision({ ...base, followerFps: rational(15, 1), driftSeconds: 0.07 })).toEqual({ action: "trim", factor: 0.95 });
  });
  it("trims toward the master between tol and hard", () => {
    expect(driftDecision({ ...base, driftSeconds: 0.1 })).toEqual({ action: "trim", factor: 0.95 });
    expect(driftDecision({ ...base, driftSeconds: -0.1 })).toEqual({ action: "trim", factor: 1.05 });
  });
  it("seeks beyond hard = 0.5 s x max(1, rate)", () => {
    expect(driftDecision({ ...base, driftSeconds: 0.51 })).toEqual({ action: "seek" });
    expect(driftDecision({ ...base, driftSeconds: 0.9, rate: 2 })).toEqual({ action: "trim", factor: 0.95 });
    expect(driftDecision({ ...base, driftSeconds: 1.01, rate: 2 })).toEqual({ action: "seek" });
    expect(driftDecision({ ...base, driftSeconds: 0.51, rate: 0.5 })).toEqual({ action: "seek" });
  });
  it("hysteresis: keeps trimming until the drift is under tol / 2", () => {
    expect(driftDecision({ ...base, trimmed: 0.95, driftSeconds: 0.04 })).toEqual({ action: "trim", factor: 0.95 });
    expect(driftDecision({ ...base, trimmed: 0.95, driftSeconds: 0.026 })).toEqual({ action: "trim", factor: 0.95 });
    expect(driftDecision({ ...base, trimmed: 0.95, driftSeconds: 0.024 })).toEqual({ action: "release" });
  });
  it("kill switch: seek-only past tol, never a trim", () => {
    expect(driftDecision({ ...base, driftSeconds: 0.1, trimEnabled: false })).toEqual({ action: "seek" });
    expect(driftDecision({ ...base, driftSeconds: 0.04, trimEnabled: false })).toEqual({ action: "none" });
    expect(driftDecision({ ...base, trimmed: 0.95, driftSeconds: 0.01, trimEnabled: false })).toEqual({ action: "none" });
  });
});

describe("medianOfLastThree", () => {
  it("takes the median of the last three", () => {
    expect(medianOfLastThree([9, 0.1, 0.3, 0.2])).toBe(0.2);
    expect(medianOfLastThree([0.5])).toBe(0.5);
    expect(medianOfLastThree([])).toBe(0);
  });
});

describe("compareDomain is tight (every position has a frame on at least one side)", () => {
  const rates = [f25, f50, f2997, f23976, f5994, rational(60, 1), rational(24, 1), rational(15, 1)];
  const has = (frame: number, n: number) => frame >= 0 && frame < n;
  it("holds across many rate pairs and offsets over the full bounds", () => {
    for (const fa of rates) for (const fb of rates) for (const [na, nb] of [[100, 60], [60, 100], [7, 40], [1, 9], [48, 48]] as const) {
      const A = { fps: fa, frameCount: na };
      const B = { fps: fb, frameCount: nb };
      const { min, max } = offsetBounds(A, B);
      const step = Math.max(1, Math.floor((max - min) / 23));
      const offsets = new Set<number>([min, max, 0, ...Array.from({ length: 24 }, (_, i) => min + i * step).filter((d) => d <= max)]);
      for (const d of offsets) {
        const { start, end } = compareDomain(A, B, d);
        const anyFrame = (a: number) => has(a, na) || has(bOf(a, d, fa, fb), nb);
        expect(anyFrame(start), `${fa.num}/${fa.den} ${fb.num}/${fb.den} d=${d} start ${start}`).toBe(true);
        expect(anyFrame(end), `end ${end}`).toBe(true);
        // tight: one step beyond either end has no frame at all
        expect(anyFrame(start - 1), `start-1 ${start - 1}`).toBe(false);
        expect(anyFrame(end + 1), `end+1 ${end + 1}`).toBe(false);
        for (let a = start; a <= end; a++) {
          expect(anyFrame(a), `a=${a}`).toBe(true);
          // Nothing is ever waiting to start while nothing plays: where no side is live, neither is before its start. (The tail where
          // the longer side shows its last frame for several positions has no live side; playback has finished there.)
          const phases = [phase(a, na - 1), phase(bOf(a, d, fa, fb), nb - 1)];
          if (!phases.includes("live")) expect(phases, `a=${a}`).not.toContain("before");
          if (a === start && na + nb > 2) expect(phases, `playable at start`).toContain("live");
        }
      }
    }
  });
  it("25 fps A, 60 fps B, offset -1", () => {
    const A = { fps: f25, frameCount: 100 };
    const B = { fps: rational(60, 1), frameCount: 240 };
    const { start } = compareDomain(A, B, -1);
    expect(bOf(start, -1, f25, rational(60, 1))).toBeGreaterThanOrEqual(0);
    expect(bOf(start - 1, -1, f25, rational(60, 1))).toBeLessThan(0);
  });
});
