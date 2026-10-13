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
  it("refuses illegal IHDR fields as not_png (Sol 1)", () => {
    for (const colourType of [1, 5, 7, 255]) expect(inspectOverlayPng(pngBytes({ colourType, trns: true, trnsLen: 2 })), `colour type ${colourType}`).toEqual({ ok: false, code: "not_png" });
    const illegalDepth: Array<[number, number]> = [[6, 4], [6, 1], [4, 4], [2, 4], [2, 1], [3, 16], [0, 3], [0, 32], [6, 0]];
    for (const [colourType, bitDepth] of illegalDepth) expect(inspectOverlayPng(pngBytes({ colourType, bitDepth, trns: colourType === 0 || colourType === 2 || colourType === 3 })), `type ${colourType} depth ${bitDepth}`).toEqual({ ok: false, code: "not_png" });
    for (const [colourType, bitDepth] of [[6, 8], [6, 16], [4, 8], [4, 16]] as const) expect(inspectOverlayPng(pngBytes({ colourType, bitDepth })), `type ${colourType} depth ${bitDepth}`).toMatchObject({ ok: true });
    for (const [colourType, bitDepth] of [[0, 1], [0, 16], [2, 16], [3, 1], [3, 4]] as const) expect(inspectOverlayPng(pngBytes({ colourType, bitDepth, trns: true })), `type ${colourType} depth ${bitDepth}`).toMatchObject({ ok: true });
    expect(inspectOverlayPng(pngBytes({ compression: 1 }))).toEqual({ ok: false, code: "not_png" });
    expect(inspectOverlayPng(pngBytes({ filter: 1 }))).toEqual({ ok: false, code: "not_png" });
    expect(inspectOverlayPng(pngBytes({ interlace: 2 }))).toEqual({ ok: false, code: "not_png" });
    expect(inspectOverlayPng(pngBytes({ interlace: 1 }))).toMatchObject({ ok: true });
  });
  it("refuses tRNS on colour types 4 and 6, an empty or mis-sized tRNS, and a palette PNG with no PLTE or too few entries (Sol 1)", () => {
    expect(inspectOverlayPng(pngBytes({ colourType: 6, trns: true }))).toEqual({ ok: false, code: "not_png" });
    expect(inspectOverlayPng(pngBytes({ colourType: 4, trns: true }))).toEqual({ ok: false, code: "not_png" });
    expect(inspectOverlayPng(pngBytes({ colourType: 2, trns: true, trnsLen: 0 }))).toEqual({ ok: false, code: "not_png" });
    expect(inspectOverlayPng(pngBytes({ colourType: 0, trns: true, trnsLen: 0 }))).toEqual({ ok: false, code: "not_png" });
    expect(inspectOverlayPng(pngBytes({ colourType: 0, trns: true, trnsLen: 3 }))).toEqual({ ok: false, code: "not_png" });
    expect(inspectOverlayPng(pngBytes({ colourType: 2, trns: true, trnsLen: 2 }))).toEqual({ ok: false, code: "not_png" });
    expect(inspectOverlayPng(pngBytes({ colourType: 3, trns: true, trnsLen: 0 }))).toEqual({ ok: false, code: "not_png" });
    expect(inspectOverlayPng(pngBytes({ colourType: 3, trns: true, trnsLen: 3 }))).toEqual({ ok: false, code: "not_png" });
    expect(inspectOverlayPng(pngBytes({ colourType: 3, trns: true, trnsLen: 2 }))).toMatchObject({ ok: true });
    expect(inspectOverlayPng(pngBytes({ colourType: 3, plteEntries: 0, trns: true }))).toEqual({ ok: false, code: "not_png" });
    expect(inspectOverlayPng(pngBytes({ colourType: 3, plteEntries: 0 }))).toEqual({ ok: false, code: "not_png" });
    expect(inspectOverlayPng(pngBytes({ colourType: 3, plteEntries: 257, trns: true, trnsLen: 256 }))).toEqual({ ok: false, code: "not_png" });
    expect(inspectOverlayPng(pngBytes({ colourType: 0, plteEntries: 2, trns: true }))).toEqual({ ok: false, code: "not_png" });
  });
  it("requires a complete IEND as the final chunk (Sol 1)", () => {
    expect(inspectOverlayPng(pngBytes({ noIend: true }))).toEqual({ ok: false, code: "not_png" });
    expect(inspectOverlayPng(pngBytes({ truncate: pngBytes().length - 4 }))).toEqual({ ok: false, code: "not_png" });
    expect(inspectOverlayPng(pngBytes({ iendWithData: true }))).toEqual({ ok: false, code: "not_png" });
    expect(inspectOverlayPng(pngBytes({ trailing: [0, 0, 0] }))).toEqual({ ok: false, code: "not_png" });
    expect(inspectOverlayPng(pngBytes({ trailing: [0] }))).toEqual({ ok: false, code: "not_png" });
  });
  it("exposes the cap and the staff-style image path", () => {
    expect(SOCIAL_OVERLAY_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(socialOverlayImagePath("o1", "u1")).toBe("/social-overlay-images/o1/u1");
  });
});
