import { describe, expect, it } from "vitest";
import { computePosition, flip, offset, shift, type Platform } from "@floating-ui/core";
import {
  TABLE_BUBBLE_GAP,
  readFloorTop,
  tableBubbleBoundary,
  tableBubbleOptions,
} from "./rich-text-table-position";

const rect = (top: number, bottom: number, left = 20, right = 340) => ({ top, bottom, left, right });

describe("tableBubbleBoundary", () => {
  const surface = rect(500, 640);

  it("is the editable surface when there is no floor", () => {
    expect(tableBubbleBoundary(surface, null)).toEqual({ x: 20, y: 500, width: 320, height: 140, top: 500, left: 20, right: 340, bottom: 640 });
  });

  it("extends down to a floor below the surface", () => {
    const boundary = tableBubbleBoundary(surface, 685);
    expect(boundary.bottom).toBe(685);
    expect(boundary.height).toBe(185);
    expect(boundary.top).toBe(500);
    expect(boundary.left).toBe(20);
    expect(boundary.width).toBe(320);
  });

  it("never shrinks the surface when the floor is above its bottom", () => {
    expect(tableBubbleBoundary(surface, 600).bottom).toBe(640);
  });

  it("falls back to the surface for a non-finite floor", () => {
    expect(tableBubbleBoundary(surface, Number.NaN).bottom).toBe(640);
    expect(tableBubbleBoundary(surface, Number.POSITIVE_INFINITY).bottom).toBe(640);
  });

  it("reads getter-backed DOMRect fields (a spread would lose them)", () => {
    const domRectLike = Object.create({
      get top() { return 500; },
      get bottom() { return 640; },
      get left() { return 20; },
      get right() { return 340; },
    });
    expect(tableBubbleBoundary(domRectLike, 685)).toMatchObject({ top: 500, bottom: 685, left: 20, right: 340, y: 500, x: 20 });
  });

  it("shifts by the visualViewport offset when given one", () => {
    expect(tableBubbleBoundary(surface, null, { x: 0, y: 30 })).toMatchObject({ top: 530, bottom: 670, y: 530 });
  });
});

describe("readFloorTop", () => {
  const helper = (over: Partial<{ isConnected: boolean; top: number; width: number; height: number }> = {}) => {
    const { isConnected = true, top = 693, width = 200, height = 16 } = over;
    return { isConnected, getBoundingClientRect: () => ({ top, bottom: top + height, left: 0, right: width, width, height }) };
  };

  it("returns the helper's top edge", () => expect(readFloorTop(helper())).toBe(693));
  it("is null without a helper", () => { expect(readFloorTop(null)).toBeNull(); expect(readFloorTop(undefined)).toBeNull(); });
  it("is null for a disconnected helper", () => expect(readFloorTop(helper({ isConnected: false }))).toBeNull());
  it("is null for a hidden (zero-size) helper", () => {
    expect(readFloorTop(helper({ width: 0 }))).toBeNull();
    expect(readFloorTop(helper({ height: 0 }))).toBeNull();
  });
  it("is null for a non-finite rect", () => expect(readFloorTop(helper({ top: Number.NaN }))).toBeNull());
});

// Real @floating-ui/core middleware (flip, shift, offset) in the order the pinned Tiptap 3.30.2 BubbleMenu
// uses, over a minimal platform whose clipping rect intersects the Rect boundary with the viewport as
// @floating-ui/dom does. Numbers are the #492 round-6 design review at 390px.
describe("table bar placement (floating-ui computePosition)", () => {
  const BAR = { width: 300, height: 54 };
  const VIEWPORT = { top: 0, left: 0, right: 390, bottom: 844 };
  const cell = { x: 20, y: 550.5, width: 300, height: 70.25 }; // cell bottom 620.75, 50.5px below the surface top
  const surface = rect(500, 640);

  const platform = {
    getElementRects: async () => ({ reference: cell, floating: { x: 0, y: 0, ...BAR } }),
    getDimensions: async () => BAR,
    getClippingRect: async ({ boundary }: { boundary: unknown }) => {
      const b = boundary as { top: number; left: number; right: number; bottom: number };
      const top = Math.max(b.top, VIEWPORT.top);
      const left = Math.max(b.left, VIEWPORT.left);
      const right = Math.min(b.right, VIEWPORT.right);
      const bottom = Math.min(b.bottom, VIEWPORT.bottom);
      return { x: left, y: top, width: right - left, height: bottom - top };
    },
  } as unknown as Platform;

  async function place(helperTop: number | null, cellOverride = cell, surfaceRect = surface) {
    const options = tableBubbleOptions({ surface: () => surfaceRect, floorTop: () => helperTop });
    const result = await computePosition(
      cellOverride as never,
      {} as never,
      {
        placement: options.placement,
        platform: {
          ...platform,
          getElementRects: async () => ({ reference: cellOverride, floating: { x: 0, y: 0, ...BAR } }),
        } as Platform,
        middleware: [flip(options.flip as never), shift(options.shift as never), offset(options.offset)],
      }
    );
    return { ...result, barTop: result.y, barBottom: result.y + BAR.height };
  }

  it("without a floor keeps today's behaviour: top-start, clamped to the surface top", async () => {
    const result = await place(null);
    expect(result.placement).toBe("top-start");
    expect(result.barTop).toBe(500);
  });

  it("with the helper line as the floor drops below the cell, 8px clear of it and of the helper", async () => {
    const helperTop = 693;
    const result = await place(helperTop);
    expect(result.placement).toBe("bottom-start");
    expect(result.barTop).toBe(620.75 + TABLE_BUBBLE_GAP);
    expect(result.barBottom).toBeLessThanOrEqual(helperTop - TABLE_BUBBLE_GAP);
  });

  it("keeps top-start when the bar would end within 8px of the helper (offset is applied after flip)", async () => {
    // cell bottom 624 -> a below placement ends at 624 + 54 + 8 = 686, past helperTop - 8 = 685
    const lowCell = { x: 20, y: 553.75, width: 300, height: 70.25 };
    const result = await place(693, lowCell);
    expect(result.placement).toBe("top-start");
  });

  it("keeps today's top-start clamp when even the extended boundary is too short", async () => {
    const result = await place(660);
    expect(result.placement).toBe("top-start");
    expect(result.barTop).toBe(500);
  });
});
