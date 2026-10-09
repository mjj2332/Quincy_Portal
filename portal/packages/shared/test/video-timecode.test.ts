import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPORT_START_TIMECODE,
  frameAtPresentationTime,
  frameContainingTime,
  frameSeekSeconds,
  frameStartSeconds,
  framesToTimecode,
  isNtscRate,
  timecodeBaseFor,
  timecodeToFrames,
} from "../src/video-timecode";
import { rational } from "../src/video-rational";

const R2397 = rational(24000, 1001);
const R2997 = rational(30000, 1001);
const R5994 = rational(60000, 1001);
const DF30 = { nominalFps: 30, dropFrame: true };
const DF60 = { nominalFps: 60, dropFrame: true };

describe("isNtscRate / timecodeBaseFor", () => {
  it("recognises NTSC rates, including QuickTime-style 2997/100", () => {
    expect(isNtscRate(R2397)).toBe(true);
    expect(isNtscRate(R2997)).toBe(true);
    expect(isNtscRate(R5994)).toBe(true);
    expect(isNtscRate(rational(2997, 100))).toBe(true);
    expect(isNtscRate(rational(30, 1))).toBe(false);
    expect(isNtscRate(rational(25, 1))).toBe(false);
    expect(isNtscRate(rational(24, 1))).toBe(false);
  });
  it("uses drop-frame only when tmcd says so and the rate is 30/60 NTSC", () => {
    expect(timecodeBaseFor(R2997, true)).toEqual(DF30);
    expect(timecodeBaseFor(rational(2997, 100), true)).toEqual(DF30);
    expect(timecodeBaseFor(R5994, true)).toEqual(DF60);
    expect(timecodeBaseFor(R2997, false)).toEqual({ nominalFps: 30, dropFrame: false });
    expect(timecodeBaseFor(R2997, null)).toEqual({ nominalFps: 30, dropFrame: false });
    expect(timecodeBaseFor(rational(30, 1), true)).toEqual({ nominalFps: 30, dropFrame: false });
    expect(timecodeBaseFor(R2397, true)).toEqual({ nominalFps: 24, dropFrame: false });
    expect(timecodeBaseFor(rational(25, 1), true)).toEqual({ nominalFps: 25, dropFrame: false });
  });
});

describe("drop-frame labels", () => {
  it("29.97 DF boundaries", () => {
    expect(framesToTimecode(1799, DF30)).toBe("00:00:59;29");
    expect(framesToTimecode(1800, DF30)).toBe("00:01:00;02");
    expect(framesToTimecode(17982, DF30)).toBe("00:10:00;00");
    expect(framesToTimecode(17981, DF30)).toBe("00:09:59;29");
  });
  it("59.94 DF drops four labels", () => {
    expect(framesToTimecode(3599, DF60)).toBe("00:00:59;59");
    expect(framesToTimecode(3600, DF60)).toBe("00:01:00;04");
  });
  it("01:00:00;00 is frame 107892 at 29.97 DF (with and without start offset)", () => {
    expect(timecodeToFrames("01:00:00;00", DF30)).toBe(107892);
    expect(framesToTimecode(0, DF30, 107892)).toBe("01:00:00;00");
    expect(framesToTimecode(107892, DF30)).toBe("01:00:00;00");
  });
  it("rejects skipped labels but accepts every tenth minute", () => {
    expect(timecodeToFrames("00:01:00;00", DF30)).toBeNull();
    expect(timecodeToFrames("00:01:00;01", DF30)).toBeNull();
    expect(timecodeToFrames("00:01:00;02", DF30)).toBe(1800);
    expect(timecodeToFrames("00:10:00;00", DF30)).toBe(17982);
    expect(timecodeToFrames("00:01:00;03", DF60)).toBeNull();
    expect(timecodeToFrames("00:01:00;04", DF60)).toBe(3600);
  });
});

describe("non-drop labels", () => {
  it("formats with ':' and an optional start offset", () => {
    const b = { nominalFps: 25, dropFrame: false };
    expect(framesToTimecode(0, b)).toBe("00:00:00:00");
    expect(framesToTimecode(25, b)).toBe("00:00:01:00");
    expect(framesToTimecode(0, b, 25 * 3600)).toBe(DEFAULT_EXPORT_START_TIMECODE);
    expect(timecodeToFrames("01:00:00:00", b)).toBe(90000);
  });
  it("rejects malformed labels and out-of-range fields", () => {
    const b = { nominalFps: 25, dropFrame: false };
    for (const bad of ["", "1:00:00:00", "00:00:00", "aa:bb:cc:dd", "00:60:00:00", "00:00:60:00", "24:00:00:00", "00:00:00:25"]) {
      expect(timecodeToFrames(bad, b)).toBeNull();
    }
  });
});

describe("24h wrap", () => {
  it("wraps non-drop at 24h", () => {
    const b = { nominalFps: 25, dropFrame: false };
    expect(framesToTimecode(25 * 86400, b)).toBe("00:00:00:00");
    expect(framesToTimecode(25 * 86400 - 1, b)).toBe("23:59:59:24");
  });
  it("wraps drop-frame at its shorter day", () => {
    const day = 30 * 86400 - 2 * (1440 - 144);
    expect(framesToTimecode(day, DF30)).toBe("00:00:00;00");
    expect(framesToTimecode(day - 1, DF30)).toBe("23:59:59;29");
    expect(framesToTimecode(5, DF30, day - 5)).toBe("00:00:00;00");
  });
});

describe("round trips", () => {
  const bases = [
    ["23.976", { nominalFps: 24, dropFrame: false }],
    ["24", { nominalFps: 24, dropFrame: false }],
    ["25", { nominalFps: 25, dropFrame: false }],
    ["29.97 DF", DF30],
    ["29.97 NDF", { nominalFps: 30, dropFrame: false }],
    ["50", { nominalFps: 50, dropFrame: false }],
    ["59.94 DF", DF60],
    ["59.94 NDF", { nominalFps: 60, dropFrame: false }],
    ["60", { nominalFps: 60, dropFrame: false }],
  ] as const;
  for (const [name, base] of bases) {
    it(`frame -> label -> frame at ${name}`, () => {
      for (let f = 0; f < 200000; f += 7) {
        const tc = framesToTimecode(f, base);
        expect(timecodeToFrames(tc, base)).toBe(f);
      }
      for (const f of [0, 1, 1798, 1799, 1800, 1801, 17981, 17982, 17983, 107891, 107892]) {
        expect(timecodeToFrames(framesToTimecode(f, base), base)).toBe(f);
      }
    });
  }
});

describe("frame <-> seconds", () => {
  it("seeks to the middle of a frame, including frame 0", () => {
    const fps = rational(25, 1);
    expect(frameStartSeconds(0, fps)).toBe(0);
    expect(frameSeekSeconds(0, fps)).toBeCloseTo(0.02, 12);
    expect(frameSeekSeconds(10, fps)).toBeCloseTo(0.42, 12);
    expect(frameContainingTime(frameSeekSeconds(10, fps), fps)).toBe(10);
  });
  it("frameContainingTime tolerates float error at a frame start", () => {
    const fps = rational(30, 1);
    expect(frameContainingTime(0.1 * 3, fps)).toBe(9);
    expect(frameContainingTime(3 / 30 - 1e-9, fps)).toBe(3);
    expect(frameContainingTime(3 / 30 - 1e-3, fps)).toBe(2);
  });
  for (const fps of [R2997, R2397]) {
    it(`frameAtPresentationTime inverts frameStartSeconds over 100000 frames at ${fps.num}/${fps.den}`, () => {
      for (let f = 0; f <= 100000; f++) {
        expect(frameAtPresentationTime(frameStartSeconds(f, fps), fps)).toBe(f);
      }
    });
  }
});
