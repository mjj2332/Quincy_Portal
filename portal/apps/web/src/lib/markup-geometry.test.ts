import { describe, expect, it } from "vitest";
import { arrowGeometry, normaliseRect } from "./markup-geometry";

const px = (p: { x: number; y: number }, box: { width: number; height: number }) => ({ x: p.x * box.width, y: p.y * box.height });
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe("arrowGeometry (#741 6s-api)", () => {
  const square = { width: 100, height: 100 };
  it("a horizontal arrow: apex at the end, symmetric ±30° base, shaft ends at the base centre", () => {
    const g = arrowGeometry({ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }, 4, square)!;
    const L = 20; // 3 * 4 + 8
    expect(g.head[0]).toEqual({ x: 0.9, y: 0.5 });
    expect(g.head[1].x * 100).toBeCloseTo(90 - L * Math.cos(Math.PI / 6), 6);
    expect(g.head[1].y * 100).toBeCloseTo(50 + L * Math.sin(Math.PI / 6), 6);
    expect(g.head[2].x * 100).toBeCloseTo(90 - L * Math.cos(Math.PI / 6), 6);
    expect(g.head[2].y * 100).toBeCloseTo(50 - L * Math.sin(Math.PI / 6), 6);
    expect(g.shaftEnd.x * 100).toBeCloseTo(90 - L * Math.cos(Math.PI / 6), 6);
    expect(g.shaftEnd.y).toBeCloseTo(0.5, 9);
  });
  it("on a non-square box the head is symmetric in pixels, not in fractions", () => {
    const box = { width: 400, height: 100 };
    const start = { x: 0.1, y: 0.2 }; const end = { x: 0.8, y: 0.9 };
    const g = arrowGeometry(start, end, 4, box)!;
    const apex = px(g.head[0], box); const a = px(g.head[1], box); const b = px(g.head[2], box);
    expect(dist(apex, a)).toBeCloseTo(dist(apex, b), 6);
    expect(dist(apex, a)).toBeCloseTo(20, 6);
    const back = { x: -Math.cos(Math.atan2(px(end, box).y - px(start, box).y, px(end, box).x - px(start, box).x)), y: -Math.sin(Math.atan2(px(end, box).y - px(start, box).y, px(end, box).x - px(start, box).x)) };
    for (const base of [a, b]) expect(((base.x - apex.x) * back.x + (base.y - apex.y) * back.y) / 20).toBeCloseTo(Math.cos(Math.PI / 6), 6);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    expect(px(g.shaftEnd, box).x).toBeCloseTo(mid.x, 6);
    expect(px(g.shaftEnd, box).y).toBeCloseTo(mid.y, 6);
  });
  it("the head grows with the stroke width", () => {
    const side = (w: number) => { const g = arrowGeometry({ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, w, { width: 1000, height: 100 })!; return dist(px(g.head[0], { width: 1000, height: 100 }), px(g.head[1], { width: 1000, height: 100 })); };
    expect(side(2)).toBeCloseTo(14, 6);
    expect(side(4)).toBeCloseTo(20, 6);
    expect(side(7)).toBeCloseTo(29, 6);
  });
  it("a short shaft clamps the head to 60% of its length", () => {
    const g = arrowGeometry({ x: 0.5, y: 0.5 }, { x: 0.55, y: 0.5 }, 7, square)!; // 5 px long
    expect(dist(px(g.head[0], square), px(g.head[1], square))).toBeCloseTo(3, 6);
  });
  it("a zero length arrow, or an unknown box, has no geometry", () => {
    expect(arrowGeometry({ x: 0.3, y: 0.3 }, { x: 0.3, y: 0.3 }, 4, square)).toBeNull();
    expect(arrowGeometry({ x: 0, y: 0 }, { x: 1, y: 1 }, 4, { width: 0, height: 0 })).toBeNull();
    expect(arrowGeometry({ x: 0, y: 0 }, { x: 1, y: 1 }, 4, { width: 100, height: 0 })).toBeNull();
  });
});

describe("normaliseRect", () => {
  const a = { x: 0.2, y: 0.3 }; const b = { x: 0.7, y: 0.9 };
  const expected = { x: 0.2, y: 0.3, width: 0.5, height: 0.6 };
  const close = (r: ReturnType<typeof normaliseRect>) => { expect(r.x).toBeCloseTo(expected.x, 9); expect(r.y).toBeCloseTo(expected.y, 9); expect(r.width).toBeCloseTo(expected.width, 9); expect(r.height).toBeCloseTo(expected.height, 9); };
  it("draws the same rectangle for all four drag directions", () => {
    close(normaliseRect(a, b));
    close(normaliseRect(b, a));
    close(normaliseRect({ x: a.x, y: b.y }, { x: b.x, y: a.y }));
    close(normaliseRect({ x: b.x, y: a.y }, { x: a.x, y: b.y }));
  });
  it("a degenerate rectangle has zero size", () => {
    expect(normaliseRect(a, a)).toEqual({ x: 0.2, y: 0.3, width: 0, height: 0 });
  });
});
