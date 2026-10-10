import { describe, expect, it } from "vitest";
import type { MarkupItem } from "@quincy/shared";
import { cloneMarkupItem, readStoredMarkup } from "./read-stored-markup";

const freehand = { points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }], color: "#e64b3c", width: 4 };
const dot = { points: [{ x: 0.5, y: 0.5 }], color: "#fff", width: 2 };
const arrow = { type: "arrow", points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }], color: "#e64b3c", width: 4 };

describe("readStoredMarkup (#741 6s-api)", () => {
  it("returns well-formed saved data as the same objects, unflagged", () => {
    const raw = [freehand, dot, arrow];
    const read = readStoredMarkup(raw);
    expect(read.unsupported).toBe(false);
    expect(read.items).toHaveLength(3);
    read.items.forEach((item, i) => expect(item).toBe(raw[i]));
  });
  it("an empty list is fine", () => expect(readStoredMarkup([])).toEqual({ items: [], unsupported: false }));
  it("an unknown type is not rendered and flags the annotation, the rest still renders", () => {
    const future = { type: "circle", points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }], color: "#fff", width: 2 };
    const read = readStoredMarkup([freehand, future]);
    expect(read.items).toEqual([freehand]);
    expect(read.items[0]).toBe(freehand);
    expect(read.unsupported).toBe(true);
  });
  it("malformed entries are dropped and flag the annotation", () => {
    const cases: unknown[] = [null, "x", 7, {}, { points: "no", color: "#fff", width: 2 }, { points: [], color: "#fff", width: 2 }, { points: [{ x: "a", y: 1 }], color: "#fff", width: 2 },
      { type: "line", points: [{ x: 0, y: 0 }], color: "#fff", width: 2 }, { ...arrow, points: [{ x: 0, y: 0 }, { x: Number.NaN, y: 0 }] }, { ...freehand, color: 3 }, { ...freehand, width: "4" }];
    for (const bad of cases) {
      const read = readStoredMarkup([bad, freehand]);
      expect(read.items).toEqual([freehand]);
      expect(read.unsupported).toBe(true);
    }
  });
  it("a typeless stroke with type undefined is freehand", () => {
    expect(readStoredMarkup([{ ...freehand, type: undefined }]).unsupported).toBe(false);
  });
});

describe("cloneMarkupItem", () => {
  it("deep copies a stroke", () => {
    const copy = cloneMarkupItem(freehand as MarkupItem);
    expect(copy).toEqual(freehand); expect(copy).not.toBe(freehand); expect(copy.points).not.toBe(freehand.points); expect(copy.points[0]).not.toBe(freehand.points[0]);
    expect("type" in copy).toBe(false);
  });
  it("keeps a shape's type and two-point tuple", () => {
    const copy = cloneMarkupItem(arrow as MarkupItem);
    expect(copy).toEqual(arrow); expect(copy.type).toBe("arrow"); expect(copy.points).toHaveLength(2); expect(copy.points[1]).not.toBe(arrow.points[1]);
  });
  it("keeps key order, so a re-save is byte for byte", () => {
    expect(JSON.stringify(cloneMarkupItem(freehand as MarkupItem))).toBe(JSON.stringify(freehand));
  });
});
