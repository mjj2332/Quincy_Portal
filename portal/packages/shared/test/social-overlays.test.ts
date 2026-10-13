import { describe, expect, it } from "vitest";
import { inspectOverlayPng, SOCIAL_OVERLAY_MAX_BYTES, socialOverlayImagePath } from "../src/social-overlays";
import { pngBytes } from "../src/testing/png-fixture";

describe("inspectOverlayPng (#869)", () => {
  it("accepts RGBA 9:16 and reports its size and alpha kind", () => {
    expect(inspectOverlayPng(pngBytes({ w: 1080, h: 1920, colourType: 6 }))).toEqual({ ok: true, width: 1080, height: 1920, alpha: "channel" });
    expect(inspectOverlayPng(pngBytes({ colourType: 4 }))).toMatchObject({ ok: true, alpha: "channel" });
  });
  it("accepts colour types 0, 2 and 3 only with tRNS before IDAT", () => {
    for (const colourType of [0, 2, 3]) {
      expect(inspectOverlayPng(pngBytes({ colourType, trns: true }))).toMatchObject({ ok: true, alpha: "trns" });
      expect(inspectOverlayPng(pngBytes({ colourType }))).toEqual({ ok: false, code: "png_no_alpha" });
    }
  });
  it("refuses tRNS after the first IDAT", () => {
    expect(inspectOverlayPng(pngBytes({ colourType: 2, trnsAfterIdat: true }))).toEqual({ ok: false, code: "png_no_alpha" });
  });
  it("refuses non-PNG, a non-first IHDR, a bad CRC, truncation and a missing IDAT as not_png", () => {
    expect(inspectOverlayPng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toEqual({ ok: false, code: "not_png" });
    expect(inspectOverlayPng(new Uint8Array())).toEqual({ ok: false, code: "not_png" });
    expect(inspectOverlayPng(pngBytes({ ihdrSecond: true }))).toEqual({ ok: false, code: "not_png" });
    expect(inspectOverlayPng(pngBytes({ badCrc: true }))).toEqual({ ok: false, code: "not_png" });
    expect(inspectOverlayPng(pngBytes({ truncate: 20 }))).toEqual({ ok: false, code: "not_png" });
    expect(inspectOverlayPng(pngBytes({ noIdat: true }))).toEqual({ ok: false, code: "not_png" });
  });
  it("refuses an APNG", () => {
    expect(inspectOverlayPng(pngBytes({ actl: true }))).toEqual({ ok: false, code: "png_animated" });
  });
  it("checks 9:16 within 1% and the width range", () => {
    expect(inspectOverlayPng(pngBytes({ w: 1080, h: 1350 }))).toEqual({ ok: false, code: "png_not_9x16" });
    expect(inspectOverlayPng(pngBytes({ w: 1080, h: 1925 }))).toMatchObject({ ok: true });
    expect(inspectOverlayPng(pngBytes({ w: 1080, h: 1940 }))).toEqual({ ok: false, code: "png_not_9x16" });
    expect(inspectOverlayPng(pngBytes({ w: 400, h: 711 }))).toEqual({ ok: false, code: "png_dimensions" });
    expect(inspectOverlayPng(pngBytes({ w: 4320, h: 7680 }))).toEqual({ ok: false, code: "png_dimensions" });
    expect(inspectOverlayPng(pngBytes({ w: 2160, h: 3840 }))).toMatchObject({ ok: true });
    expect(inspectOverlayPng(pngBytes({ w: 540, h: 960 }))).toMatchObject({ ok: true });
  });
  it("exposes the cap and the staff-style image path", () => {
    expect(SOCIAL_OVERLAY_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(socialOverlayImagePath("o1", "u1")).toBe("/social-overlay-images/o1/u1");
  });
});
