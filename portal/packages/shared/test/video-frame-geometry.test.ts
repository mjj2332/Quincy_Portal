import { describe, expect, it } from "vitest";
import { containBox, picturePoint, renderedMediaBox, toNormalizedPoint } from "../src/video-frame-geometry";

const el = (
  naturalWidth: number,
  naturalHeight: number,
  elementWidth: number,
  elementHeight: number,
  offsetLeft = 0,
  offsetTop = 0,
) => ({ naturalWidth, naturalHeight, elementWidth, elementHeight, offsetLeft, offsetTop });

describe("containBox", () => {
  it("pads top/bottom when the content is wider than the box", () => {
    expect(containBox(2, 1, 400, 400)).toEqual({ left: 0, top: 100, width: 400, height: 200 });
  });
  it("pads left/right when the content is taller than the box", () => {
    expect(containBox(1, 2, 400, 400)).toEqual({ left: 100, top: 0, width: 200, height: 400 });
  });
  it("adds no padding when the aspect ratios already match", () => {
    expect(containBox(1600, 900, 800, 450)).toEqual({ left: 0, top: 0, width: 800, height: 450 });
  });
  it("keeps an exact fit exact instead of drifting through an intermediate ratio", () => {
    expect(containBox(1600, 900, 800, 450).width).toBe(800);
    expect(containBox(1920, 1080, 301, 169).width).toBe(300.44444444444446);
  });
});

describe("renderedMediaBox", () => {
  it("image smaller than its container renders at natural size (max-* does not upscale)", () => {
    expect(renderedMediaBox(el(100, 200, 100, 200, 350, 100))).toEqual({ left: 350, top: 100, width: 100, height: 200 });
  });
  it("image larger than its container is shrunk to the contain box", () => {
    expect(renderedMediaBox(el(4000, 1000, 800, 200, 0, 100))).toEqual({ left: 0, top: 100, width: 800, height: 200 });
  });
  it("an element that fills its container letterboxes internally (the <video> pattern)", () => {
    expect(renderedMediaBox(el(100, 200, 800, 400, 0, 0))).toEqual({ left: 300, top: 0, width: 200, height: 400 });
  });
  it("carries the element offset through in both axes", () => {
    expect(renderedMediaBox(el(1, 1, 400, 200, 30, 40))).toEqual({ left: 130, top: 40, width: 200, height: 200 });
  });
  it("falls back to the element box before natural dimensions are known", () => {
    expect(renderedMediaBox(el(0, 0, 800, 400, 5, 6))).toEqual({ left: 5, top: 6, width: 800, height: 400 });
  });
  it("returns null when the element has not been laid out", () => {
    expect(renderedMediaBox(el(100, 200, 0, 0))).toBeNull();
  });
});

describe("toNormalizedPoint / picturePoint", () => {
  const box = { left: 100, top: 50, width: 400, height: 200 };
  it("normalises to the box, clamps to [0,1], rounds to 4 dp", () => {
    expect(toNormalizedPoint(300, 150, box)).toEqual({ x: 0.5, y: 0.5 });
    expect(toNormalizedPoint(0, 1000, box)).toEqual({ x: 0, y: 1 });
    expect(toNormalizedPoint(100 + 400 / 3, 50, box)).toEqual({ x: 0.3333, y: 0 });
  });
  it("maps a degenerate box to the origin", () => {
    expect(toNormalizedPoint(5, 5, { left: 0, top: 0, width: 0, height: 10 })).toEqual({ x: 0, y: 0 });
  });
  it("round-trips through a letterboxed 16:9 picture in a 4:3 element", () => {
    const picture = renderedMediaBox(el(1920, 1080, 800, 600, 10, 20))!;
    expect(picture).toEqual({ left: 10, top: 20 + 75, width: 800, height: 450 });
    expect(picturePoint(410, 320, picture)).toEqual({ x: 0.5, y: 0.5 });
    expect(picturePoint(10, 95, picture)).toEqual({ x: 0, y: 0 });
    expect(picturePoint(810, 545, picture)).toEqual({ x: 1, y: 1 });
    expect(picturePoint(410, 50, picture)).toBeNull(); // top letterbox
    expect(picturePoint(410, 560, picture)).toBeNull(); // bottom letterbox
  });
  it("round-trips through a pillarboxed 9:16 picture in a 4:3 element", () => {
    const picture = renderedMediaBox(el(1080, 1920, 800, 600, 0, 0))!;
    expect(picture.top).toBe(0);
    expect(picture.height).toBe(600);
    expect(picture.width).toBe(337.5);
    expect(picture.left).toBe(231.25);
    expect(picturePoint(400, 300, picture)).toEqual({ x: 0.5, y: 0.5 });
    expect(picturePoint(100, 300, picture)).toBeNull(); // left pillar
    expect(picturePoint(700, 300, picture)).toBeNull(); // right pillar
  });
  it("is null for a degenerate picture", () => {
    expect(picturePoint(1, 1, { left: 0, top: 0, width: 0, height: 0 })).toBeNull();
  });
});
