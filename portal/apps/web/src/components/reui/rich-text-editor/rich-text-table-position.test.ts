import { describe, expect, it } from "vitest";
import { computePosition, flip, offset, shift, type Platform } from "@floating-ui/core";
import {
  TABLE_BUBBLE_GAP,
  readFloorTop,
  tableBubbleBoundary,
  tableBubbleOptions,
  tableBubbleZone,
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

  it("with a counter above the helper, the floor is the counter's top (the first rendered element below the frame)", () => {
    expect(readFloorTop(helper({ top: 628 }), helper({ top: 644 }))).toBe(628);
    expect(readFloorTop(helper({ top: 644 }), helper({ top: 628 }))).toBe(628);
  });
  it("skips absent, hidden or detached elements and falls back to the next one", () => {
    expect(readFloorTop(null, helper({ top: 644 }))).toBe(644);
    expect(readFloorTop(helper({ top: 628, height: 0 }), helper({ top: 644 }))).toBe(644);
    expect(readFloorTop(helper({ top: 628, isConnected: false }), helper({ top: 644 }))).toBe(644);
  });
  it("is null when no element is usable", () => expect(readFloorTop(null, undefined, helper({ width: 0 }))).toBeNull());
});

// Real @floating-ui/core middleware (flip, shift, offset) in the order the pinned Tiptap 3.30.2 BubbleMenu
// uses, over a minimal platform whose clipping rect intersects the Rect boundary with the viewport as
// @floating-ui/dom does. The numbers are the #492 round-6 design review's (a 54px bar); the 390px labels
// below are history: the phone no longer uses this bar (a toolbar group does), so they are math cases.
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

  interface PlaceInput {
    helperTop: number | null;
    cell?: typeof cell;
    surface?: ReturnType<typeof rect>;
    bar?: { width: number; height: number };
    prevBottom?: number | null;
    nextTop?: number | null;
    row?: ReturnType<typeof rect>;
    viewport?: { top: number; bottom: number };
    visualOffset?: { x: number; y: number };
  }

  // The row defaults to the cell's own vertical extent (a one-line row); the viewport is tall enough to never cut.
  async function placeWith({
    helperTop,
    cell: cellOverride = cell,
    surface: surfaceRect = surface,
    bar = BAR,
    prevBottom = null,
    nextTop = null,
    row = rect(cellOverride.y, cellOverride.y + cellOverride.height),
    viewport = { top: 0, bottom: 844 },
    visualOffset,
  }: PlaceInput) {
    const options = tableBubbleOptions({
      surface: () => surfaceRect,
      floorTop: () => helperTop,
      neighbours: () => ({ prevBottom, nextTop }),
      row: () => row,
      viewport: () => viewport,
      ...(visualOffset ? { visualOffset: () => visualOffset } : {}),
    });
    const result = await computePosition(
      cellOverride as never,
      {} as never,
      {
        placement: options.placement,
        platform: {
          ...platform,
          getElementRects: async () => ({ reference: cellOverride, floating: { x: 0, y: 0, ...bar } }),
          getDimensions: async () => bar,
        } as Platform,
        middleware: [flip(options.flip as never), shift(options.shift as never), offset(options.offset)],
      }
    );
    return { ...result, barTop: result.y, barBottom: result.y + bar.height };
  }

  const place = (helperTop: number | null, cellOverride = cell, surfaceRect = surface, bar = BAR) =>
    placeWith({ helperTop, cell: cellOverride, surface: surfaceRect, bar });

  const overlap = (a: { top: number; bottom: number }, b: { top: number; bottom: number }) =>
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

  it("without a floor and with room above the row: top-start, 8px clear of the row, inside the surface", async () => {
    const roomy = { x: 20, y: 570, width: 300, height: 34 }; // 570 - 8 - 54 = 508 >= surface top 500
    const result = await place(null, roomy);
    expect(result.placement).toBe("top-start");
    expect(result.barBottom).toBe(570 - TABLE_BUBBLE_GAP);
    expect(result.barTop).toBeGreaterThanOrEqual(500);
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

  it("keeps top-start when neither side fits (the degrade case: shift clamps to the surface top)", async () => {
    const result = await place(660);
    expect(result.placement).toBe("top-start");
    expect(result.barTop).toBe(500);
    // Documented, not endorsed: the gap to the row is lost here (#535). The zone rules make this a rare geometry.
    expect(550.5 - result.barBottom).toBeLessThan(TABLE_BUBBLE_GAP);
  });

  // Geometry measured in the browser (#535 round 7): a 54px bar. Kept as math cases; the bar is now 38px (no outer padding).
  describe("measured geometry (math cases)", () => {
    const LIVE_BAR = { width: 300, height: 54 };
    const liveCell = { x: 20, y: 538.3, width: 300, height: 34 }; // caret row 538.3-572.3
    const liveSurface = rect(480, 600);
    const FRAME_BOTTOM = 615.8;

    it("math case (was 390px): the helper is 12px under the frame, there is no room below, so top-start clamps (never bottom-start)", async () => {
      const helperTop = FRAME_BOTTOM + 12; // 627.8
      const result = await place(helperTop, liveCell, liveSurface, LIVE_BAR);
      expect(result.placement).toBe("top-start");
      expect(result.placement).not.toBe("bottom-start");
    });

    it("desktop: the helper is 28px under the frame, so the bar drops below the caret row and clears the helper", async () => {
      const helperTop = FRAME_BOTTOM + 28; // 643.8
      const result = await place(helperTop, liveCell, liveSurface, LIVE_BAR);
      expect(result.placement).toBe("bottom-start");
      expect(result.barTop).toBeCloseTo(572.3 + TABLE_BUBBLE_GAP, 5);
      expect(result.barBottom).toBeLessThanOrEqual(helperTop - TABLE_BUBBLE_GAP);
    });

    it("desktop with the counter showing: the floor is the counter's top, so the same bar does not drop onto it", async () => {
      const counterTop = FRAME_BOTTOM + 12; // 627.8, between the frame and the helper
      const helperTop = counterTop + 16 + 8; // under the counter
      const floorTop = readFloorTop(
        { isConnected: true, getBoundingClientRect: () => ({ top: counterTop, bottom: counterTop + 16, left: 0, right: 80, width: 80, height: 16 }) },
        { isConnected: true, getBoundingClientRect: () => ({ top: helperTop, bottom: helperTop + 16, left: 0, right: 200, width: 200, height: 16 }) }
      );
      expect(floorTop).toBe(counterTop);
      const result = await place(floorTop, liveCell, liveSurface, LIVE_BAR);
      expect(result.placement).toBe("top-start");
      // The helper alone (the old floor) would have dropped it over the counter.
      const old = await place(helperTop, liveCell, liveSurface, LIVE_BAR);
      expect(old.barBottom).toBeGreaterThan(counterTop - TABLE_BUBBLE_GAP);
    });
  });
});

describe("tableBubbleZone", () => {
  const G = TABLE_BUBBLE_GAP;
  const surface = rect(400, 700);
  const base = { surface, prevBottom: null, nextTop: null, floorTop: null, viewport: { top: 0, bottom: 844 } };

  it("uses the clean zone (below the previous block, above the next one) when the bar fits above the row", () => {
    const zone = tableBubbleZone({ ...base, row: rect(560, 600), barHeight: 38, prevBottom: 480, nextTop: 640 });
    expect(zone).toEqual({ top: 480, bottom: 640, tier: "clean" });
  });

  it("uses the clean zone when only the bottom fits", () => {
    // 530 - 8 - 38 = 484 < 490 (prev), but 560 + 8 + 38 = 606 <= 640 (next).
    const zone = tableBubbleZone({ ...base, row: rect(530, 560), barHeight: 38, prevBottom: 490, nextTop: 640 });
    expect(zone.tier).toBe("clean");
    expect(zone).toMatchObject({ top: 490, bottom: 640 });
  });

  it("falls back to the wide zone for a single-row table between two paragraphs", () => {
    const zone = tableBubbleZone({ ...base, row: rect(520, 560), barHeight: 38, prevBottom: 515, nextTop: 565 });
    expect(zone).toEqual({ top: 400, bottom: 700, tier: "wide" });
  });

  it("never lets the clean ceiling rise above the surface or the clean floor drop below the wide floor", () => {
    expect(tableBubbleZone({ ...base, row: rect(560, 600), barHeight: 38, prevBottom: 300 }).top).toBe(400);
    expect(tableBubbleZone({ ...base, row: rect(560, 600), barHeight: 38, nextTop: 900 }).bottom).toBe(700);
  });

  it("extends the wide floor to one gap above the helper, as the previous rule did", () => {
    const zone = tableBubbleZone({ ...base, row: rect(420, 460), barHeight: 60, floorTop: 760 });
    expect(zone.bottom).toBe(760 - G);
  });

  it("counts a viewport that cuts above the row as 'does not fit above'", () => {
    // Scrolled: the surface top is above the viewport, the row is 20px under it.
    const zone = tableBubbleZone({ ...base, surface: rect(-200, 700), row: rect(20, 60), barHeight: 38 });
    // 20 - 8 - 38 < 0: the top does not fit, the bottom (60 + 46 = 106 <= 700) does: clean.
    expect(zone.tier).toBe("clean");
  });

  it("counts a viewport that cuts below the row as 'does not fit below'", () => {
    const zone = tableBubbleZone({ ...base, row: rect(420, 460), barHeight: 38, nextTop: 520, viewport: { top: 0, bottom: 480 } });
    // Top: 420 - 46 = 374 < 400; bottom: 460 + 46 = 506 > 480. Neither fits: wide.
    expect(zone.tier).toBe("wide");
  });
});

describe("table bar zone placement (floating-ui computePosition)", () => {
  const G = TABLE_BUBBLE_GAP;
  const VIEWPORT = { top: 0, left: 0, right: 1200, bottom: 900 };
  const platformFor = (reference: unknown, bar: { width: number; height: number }) =>
    ({
      getElementRects: async () => ({ reference, floating: { x: 0, y: 0, ...bar } }),
      getDimensions: async () => bar,
      getClippingRect: async ({ boundary }: { boundary: unknown }) => {
        const b = boundary as { top: number; left: number; right: number; bottom: number };
        const top = Math.max(b.top, VIEWPORT.top);
        const left = Math.max(b.left, VIEWPORT.left);
        const right = Math.min(b.right, VIEWPORT.right);
        const bottom = Math.min(b.bottom, VIEWPORT.bottom);
        return { x: left, y: top, width: right - left, height: bottom - top };
      },
    }) as unknown as Platform;

  interface Scene {
    surface: ReturnType<typeof rect>;
    row: ReturnType<typeof rect>;
    barHeight: number;
    prevBottom?: number | null;
    nextTop?: number | null;
    floorTop?: number | null;
    viewport?: { top: number; bottom: number };
    visualOffset?: { x: number; y: number };
  }

  async function run(scene: Scene) {
    const bar = { width: 280, height: scene.barHeight };
    const reference = { x: 40, y: scene.row.top, width: 200, height: scene.row.bottom - scene.row.top };
    const options = tableBubbleOptions({
      surface: () => scene.surface,
      floorTop: () => scene.floorTop ?? null,
      neighbours: () => ({ prevBottom: scene.prevBottom ?? null, nextTop: scene.nextTop ?? null }),
      row: () => scene.row,
      viewport: () => scene.viewport ?? { top: 0, bottom: 900 },
      ...(scene.visualOffset ? { visualOffset: () => scene.visualOffset! } : {}),
    });
    const result = await computePosition(reference as never, {} as never, {
      placement: options.placement,
      platform: platformFor(reference, bar),
      middleware: [flip(options.flip as never), shift(options.shift as never), offset(options.offset)],
    });
    return { placement: result.placement, top: result.y, bottom: result.y + bar.height };
  }

  const overlap = (a: { top: number; bottom: number }, b: { top: number; bottom: number }) =>
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

  // A first-block table: the surface starts at 480 and the header row is 38px, so row 2 starts at 526.
  const firstBlock = { surface: rect(480, 600), row: rect(526, 560) }; // nothing below: 560 + 8 + 46 > 600

  it("A: a 38px bar over row 2 of a first-block table sits top-start with the full 8px gap, inside the surface", async () => {
    const result = await run({ ...firstBlock, barHeight: 38 });
    expect(result.placement).toBe("top-start");
    expect(firstBlock.row.top - result.bottom).toBe(G);
    expect(result.top).toBeGreaterThanOrEqual(480);
  });

  it("A: a 46px bar (the old padded bar) does not fit above row 2 and is clamped, losing the gap", async () => {
    const result = await run({ ...firstBlock, barHeight: 46 });
    expect(result.placement).toBe("top-start");
    expect(result.top).toBe(480);
    expect(firstBlock.row.top - result.bottom).toBeLessThan(G);
  });

  it("B: a middle row never overlaps the previous block, and the bar stays 8px clear of the row", async () => {
    const prev = { top: 440, bottom: 480 };
    const result = await run({ surface: rect(400, 700), row: rect(560, 600), barHeight: 38, prevBottom: prev.bottom, nextTop: 640 });
    expect(result.placement).toBe("top-start");
    expect(overlap(result, prev)).toBe(0);
    expect(560 - result.bottom).toBe(G);
  });

  it("B: when the top is blocked by the previous block, the bar drops below the row instead of covering the block", async () => {
    const prev = { top: 440, bottom: 490 };
    const next = { top: 640, bottom: 680 };
    const result = await run({ surface: rect(400, 700), row: rect(530, 560), barHeight: 38, prevBottom: prev.bottom, nextTop: next.top });
    expect(result.placement).toBe("bottom-start");
    expect(overlap(result, prev)).toBe(0);
    expect(overlap(result, next)).toBe(0);
    expect(result.top - 560).toBe(G);
  });

  it("B: the last row's bar covers only rows above it, never the previous block", async () => {
    const prev = { top: 440, bottom: 480 };
    const rows = [rect(520, 560), rect(560, 600), rect(600, 640)];
    const result = await run({ surface: rect(400, 760), row: rows[2]!, barHeight: 38, prevBottom: prev.bottom, nextTop: 650 });
    expect(result.placement).toBe("top-start");
    expect(overlap(result, rows[2]!)).toBe(0);
    expect(overlap(result, prev)).toBe(0);
    expect(overlap(result, rows[0]!) + overlap(result, rows[1]!)).toBeGreaterThan(0);
  });

  it("C: the last row's bar does not cover the next block", async () => {
    const next = { top: 660, bottom: 700 };
    const result = await run({ surface: rect(400, 760), row: rect(600, 640), barHeight: 38, prevBottom: 480, nextTop: next.top });
    expect(overlap(result, next)).toBe(0);
    expect(overlap(result, rect(600, 640))).toBe(0);
  });

  it("a single-row table between two paragraphs uses the wide zone and still keeps clear of the row", async () => {
    const result = await run({ surface: rect(400, 760), row: rect(520, 560), barHeight: 38, prevBottom: 515, nextTop: 565 });
    expect(overlap(result, rect(520, 560))).toBe(0);
    expect(result.placement).toBe("top-start");
  });

  it("a viewport that cuts above the row moves the bar below it", async () => {
    const result = await run({ surface: rect(-200, 700), row: rect(20, 60), barHeight: 38, viewport: { top: 0, bottom: 900 } });
    expect(result.placement).toBe("bottom-start");
    expect(result.top - 60).toBe(G);
  });

  it("is deterministic: the zone does not depend on the placement floating-ui is currently trying", () => {
    const options = tableBubbleOptions({
      surface: () => rect(400, 700),
      floorTop: () => null,
      neighbours: () => ({ prevBottom: 480, nextTop: 640 }),
      row: () => rect(560, 600),
      viewport: () => ({ top: 0, bottom: 900 }),
    });
    const stateFor = (placement: string) => ({ placement, rects: { reference: {}, floating: { x: 0, y: 0, width: 280, height: 38 } } });
    const a = options.flip(stateFor("top-start") as never);
    const b = options.flip(stateFor("bottom-start") as never);
    expect(a.boundary).toEqual(b.boundary);
    expect(options.shift(stateFor("bottom-start") as never).boundary).toEqual(a.boundary);
  });

  it("reads the bar height from the floating rect, never a constant", () => {
    const options = tableBubbleOptions({
      surface: () => rect(480, 700),
      floorTop: () => null,
      neighbours: () => ({ prevBottom: 500, nextTop: null }),
      row: () => rect(526, 560),
      viewport: () => ({ top: 0, bottom: 900 }),
    });
    const withHeight = (height: number) => ({ placement: "top-start", rects: { reference: {}, floating: { x: 0, y: 0, width: 280, height } } });
    // 38px: 526 - 8 - 38 = 480 < 500 (previous block), but the bottom fits: the clean zone (ceiling 500).
    expect(options.flip(withHeight(38) as never).boundary.top).toBe(500);
    // 400px fits neither side: the wide zone (ceiling = the surface top, 480).
    expect(options.flip(withHeight(400) as never).boundary.top).toBe(480);
  });

  it("adds the visualViewport offset AFTER deciding the zone", () => {
    const input = {
      surface: () => rect(400, 700),
      floorTop: () => null,
      neighbours: () => ({ prevBottom: 480, nextTop: 640 }),
      row: () => rect(560, 600),
      viewport: () => ({ top: 0, bottom: 900 }),
    };
    const state = { placement: "top-start", rects: { reference: {}, floating: { x: 0, y: 0, width: 280, height: 38 } } } as never;
    const plain = tableBubbleOptions(input).flip(state).boundary;
    const shifted = tableBubbleOptions({ ...input, visualOffset: () => ({ x: 0, y: 30 }) }).flip(state).boundary;
    expect(shifted.top).toBe(plain.top + 30);
    expect(shifted.bottom).toBe(plain.bottom + 30);
    expect(shifted.height).toBe(plain.height);
  });
});
