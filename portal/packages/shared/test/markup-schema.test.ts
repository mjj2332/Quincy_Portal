import { describe, expect, it } from "vitest";
import { MARKUP_SHAPES, markupKind, strokesJsonBytes, strokesSchema, type MarkupItem } from "../src/freehand-strokes";

/**
 * #741 slice 6s-api: the markup wire contract. A freehand stroke stays TYPELESS on the wire (bit-for-bit what every saved
 * annotation already holds); an arrow, line or rectangle is `{ type, points: [start, end], color, width }`.
 */
const pt = { x: 0.25, y: 0.75 };
const freehand = (over: Record<string, unknown> = {}) => ({ points: [pt], color: "#e64b3c", width: 4, ...over });
const shape = (type: string, over: Record<string, unknown> = {}) => ({ type, points: [{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.9 }], color: "#e64b3c", width: 4, ...over });

describe("a saved typeless stroke is preserved byte for byte", () => {
  // Shape of production data: key order points, color, width; numbers as the client wrote them (4 dp).
  const fixtures: [string, string][] = [
    ["a line", '[{"points":[{"x":0.1234,"y":0.5},{"x":0.2,"y":0.6},{"x":1,"y":0}],"color":"#e64b3c","width":4}]'],
    ["a dot", '[{"points":[{"x":0.5,"y":0.5}],"color":"#ffffff","width":7}]'],
    ["2000 points", JSON.stringify([{ points: Array.from({ length: 2000 }, (_, i) => ({ x: i / 2000, y: 0.5 })), color: "#111111", width: 2 }])],
  ];
  for (const [label, json] of fixtures) {
    it(label, () => {
      const parsed = strokesSchema.parse(JSON.parse(json));
      expect(JSON.stringify(parsed)).toBe(json);
      expect(markupKind(parsed[0]!)).toBe("freehand");
    });
  }
});

describe("shapes", () => {
  for (const type of MARKUP_SHAPES) {
    it(`accepts ${type} and keeps its type`, () => {
      const parsed = strokesSchema.parse([shape(type)]);
      expect(parsed[0]).toEqual(shape(type));
      expect(markupKind(parsed[0] as MarkupItem)).toBe(type);
    });
  }
  it("keeps the type of a 2-point shape (union order: shape first, or the loose freehand branch would swallow it)", () => {
    expect((strokesSchema.parse([shape("line")])[0] as { type?: string }).type).toBe("line");
  });
  it("a shape written as [end, start] is stored as dragged", () => {
    const item = shape("arrow", { points: [{ x: 0.9, y: 0.9 }, { x: 0.1, y: 0.1 }] });
    expect(strokesSchema.parse([item])[0]).toEqual(item);
  });
  it("accepts a degenerate shape (both points equal); the renderer tolerates it", () => {
    expect(strokesSchema.safeParse([shape("rectangle", { points: [pt, pt] })]).success).toBe(true);
  });
  const rejected: [string, unknown][] = [
    ["1 point", shape("line", { points: [pt] })],
    ["3 points", shape("line", { points: [pt, pt, pt] })],
    ["type freehand", shape("freehand")],
    ["type circle", shape("circle")],
    ["an unknown type on a 1-point stroke", freehand({ type: "circle" })],
    ["a 1-point stroke with type freehand", freehand({ type: "freehand" })],
    ["a shape point outside 0..1", shape("line", { points: [pt, { x: 1.2, y: 0 }] })],
    ["a shape colour over 32 characters", shape("line", { color: "c".repeat(33) })],
    ["a shape width over 100", shape("line", { width: 101 })],
  ];
  for (const [label, item] of rejected) it(`rejects ${label}`, () => expect(strokesSchema.safeParse([item]).success).toBe(false));

  it("a 2-point stroke with no type is freehand, as it always was", () => {
    const item = freehand({ points: [pt, { x: 0.3, y: 0.3 }] });
    const parsed = strokesSchema.parse([item]);
    expect(parsed[0]).toEqual(item);
    expect(markupKind(parsed[0]!)).toBe("freehand");
  });
  it("strips an extra key on a shape and on a stroke (the loose route)", () => {
    expect(strokesSchema.parse([{ ...shape("line"), extra: 1 }])[0]).toEqual(shape("line"));
    expect(strokesSchema.parse([{ ...freehand(), extra: 1 }])[0]).toEqual(freehand());
  });
});

describe("caps", () => {
  it("200 mixed items are accepted, 201 refused", () => {
    const mixed = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? shape("arrow") : freehand()));
    expect(strokesSchema.safeParse(mixed(200)).success).toBe(true);
    expect(strokesSchema.safeParse(mixed(201)).success).toBe(false);
  });
  it("strokesJsonBytes counts a shape", () => {
    expect(strokesJsonBytes([shape("line") as MarkupItem])).toBe(new TextEncoder().encode(JSON.stringify([shape("line")])).length);
  });
});
