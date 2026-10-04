import { describe, expect, it } from "vitest";
import { computePosition, flip, offset, shift, type Platform } from "@floating-ui/core";
import {
  TABLE_BUBBLE_GAP,
  readFloorTop,
  tableBubbleAnchor,
  tableBubbleBoundary,
  tableBubbleOptions,
  tableBubbleZone,
  type TableBubbleTier,
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
    getClippingRect: async ({ boundary, rootBoundary }: { boundary: unknown; rootBoundary?: unknown }) => {
      const b = boundary as { top: number; left: number; right: number; bottom: number };
      // "document" does not clip at the viewport (the page extends past it); "viewport" does.
      const root = rootBoundary === "document" ? { top: -1e6, left: 0, right: VIEWPORT.right, bottom: 1e6 } : VIEWPORT;
      const top = Math.max(b.top, root.top);
      const left = Math.max(b.left, root.left);
      const right = Math.min(b.right, root.right);
      const bottom = Math.min(b.bottom, root.bottom);
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
    onTier?: (tier: TableBubbleTier) => void;
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
    onTier,
  }: PlaceInput) {
    const options = tableBubbleOptions({
      surface: () => surfaceRect,
      floorTop: () => helperTop,
      neighbours: () => ({ prevBottom, nextTop }),
      row: () => row,
      viewport: () => viewport,
      ...(visualOffset ? { visualOffset: () => visualOffset } : {}),
      ...(onTier ? { onTier } : {}),
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

  it("when the full 8px gap would end within 8px of the helper, drops below TIGHT (gap < 8) and still clears the helper", async () => {
    // cell bottom 624; the floor is helperTop - 8 = 685. Above: 553.75 - 500 = 53.75 (< 54). Below: 685 - 624 = 61 (< 62).
    // The roomier side is below, with 61 - 54 - 0.5 = 6.5px of gap: the bar ends at 684.5.
    const lowCell = { x: 20, y: 553.75, width: 300, height: 70.25 };
    const result = await place(693, lowCell);
    expect(result.placement).toBe("bottom-start");
    expect(result.barTop - 624).toBeCloseTo(6.5, 5);
    expect(result.barTop - 624).toBeLessThan(TABLE_BUBBLE_GAP);
    expect(result.barBottom).toBeLessThanOrEqual(693 - TABLE_BUBBLE_GAP);
  });

  it("reports tier none when neither side fits (no clamping onto the row; the host shows the toolbar group)", async () => {
    // floor = 660 - 8 = 652: above 50.5 (< 54), below 652 - 620.75 = 31.25. Neither fits, not even tight.
    const tiers: string[] = [];
    await placeWith({ helperTop: 660, onTier: (tier) => tiers.push(tier) });
    expect(tiers).toEqual(["none"]);
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
    expect(zone).toEqual({ top: 480, bottom: 640, tier: "clean", gap: G, root: "viewport" });
  });

  it("uses the clean zone when only the bottom fits", () => {
    // 530 - 8 - 38 = 484 < 490 (prev), but 560 + 8 + 38 = 606 <= 640 (next).
    const zone = tableBubbleZone({ ...base, row: rect(530, 560), barHeight: 38, prevBottom: 490, nextTop: 640 });
    expect(zone.tier).toBe("clean");
    expect(zone).toMatchObject({ top: 490, bottom: 640 });
  });

  it("a single-row table between two paragraphs has no room anywhere: tier none, and the bar is never widened over a block", () => {
    const zone = tableBubbleZone({ ...base, row: rect(520, 560), barHeight: 38, prevBottom: 515, nextTop: 565 });
    // The limits stay the blocks' edges (515 / 565): there is no wide zone any more.
    expect(zone).toEqual({ top: 515, bottom: 565, tier: "none", gap: G, root: "viewport" });
  });

  it("takes the roomier side TIGHT (gap under 8, EPS clear) when neither side has 8px to spare", () => {
    // The measured #535 case: 41.2 above, 33.2 below, a 37.6px bar.
    const zone = tableBubbleZone({
      ...base, surface: rect(421.51, 584.71), row: rect(490.71, 523.51), barHeight: 37.6, prevBottom: 449.51, nextTop: 556.71,
    });
    expect(zone.tier).toBe("tight");
    expect(zone.gap).toBeCloseTo(41.2 - 37.6 - 0.5, 5);
    expect(zone.gap).toBeGreaterThan(0);
    expect(zone.gap).toBeLessThan(G);
  });

  it("is none when the roomier side leaves under 0.5px of clearance", () => {
    expect(tableBubbleZone({ ...base, row: rect(520, 560), barHeight: 38, prevBottom: 481.6, nextTop: 565 }).tier).toBe("none");
    expect(tableBubbleZone({ ...base, row: rect(520, 560), barHeight: 38, prevBottom: 481.4, nextTop: 565 }).tier).toBe("tight");
  });

  it("an unmeasured bar (height 0) is judged clean, so the toolbar never flickers in before the bar is laid out", () => {
    expect(tableBubbleZone({ ...base, row: rect(520, 560), barHeight: 0, prevBottom: 515, nextTop: 565 }).tier).toBe("clean");
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

  it("counts a viewport that cuts below the row as 'does not fit below': the blocks allow it, so the bar goes partly offscreen", () => {
    const zone = tableBubbleZone({ ...base, row: rect(420, 460), barHeight: 38, nextTop: 520, viewport: { top: 0, bottom: 480 } });
    // Visible: top 420 - 400 = 20, bottom min(520, 480) - 460 = 20: neither fits, even tight. Blocks: bottom 520 - 460 = 60 >= 46.
    expect(zone).toEqual({ top: 400, bottom: 520, tier: "offscreen", gap: G, root: "document" });
  });
});

describe("tableBubbleAnchor", () => {
  it("is the row when the cell sits inside it", () => {
    expect(tableBubbleAnchor(rect(530, 560), rect(530, 560, 30, 120))).toEqual({ top: 530, bottom: 560, left: 30, right: 120 });
  });

  it("spans row and cell vertically (a rowspan cell reaches past the row), horizontally the cell", () => {
    expect(tableBubbleAnchor(rect(530, 560), rect(530, 630, 30, 120))).toEqual({ top: 530, bottom: 630, left: 30, right: 120 });
    expect(tableBubbleAnchor(rect(530, 560), rect(500, 545, 30, 120))).toEqual({ top: 500, bottom: 560, left: 30, right: 120 });
  });
});

describe("table bar zone placement (floating-ui computePosition)", () => {
  const G = TABLE_BUBBLE_GAP;
  const VIEWPORT = { top: 0, left: 0, right: 1200, bottom: 900 };
  const platformFor = (reference: unknown, bar: { width: number; height: number }, viewportBottom = VIEWPORT.bottom) =>
    ({
      getElementRects: async () => ({ reference, floating: { x: 0, y: 0, ...bar } }),
      getDimensions: async () => bar,
      getClippingRect: async ({ boundary, rootBoundary }: { boundary: unknown; rootBoundary?: unknown }) => {
        const b = boundary as { top: number; left: number; right: number; bottom: number };
        // The viewport the scene is run with (`viewportBottom`), or the whole document for "document".
        const root = rootBoundary === "document" ? { top: -1e6, left: 0, right: VIEWPORT.right, bottom: 1e6 } : { ...VIEWPORT, bottom: viewportBottom };
        const top = Math.max(b.top, root.top);
        const left = Math.max(b.left, root.left);
        const right = Math.min(b.right, root.right);
        const bottom = Math.min(b.bottom, root.bottom);
        return { x: left, y: top, width: right - left, height: bottom - top };
      },
    }) as unknown as Platform;

  interface Scene {
    surface: ReturnType<typeof rect>;
    row: ReturnType<typeof rect>;
    /** The active cell, when it differs from the row (a rowspan cell reaches past the row's rect). */
    cell?: ReturnType<typeof rect>;
    barHeight: number;
    prevBottom?: number | null;
    nextTop?: number | null;
    floorTop?: number | null;
    viewport?: { top: number; bottom: number };
    visualOffset?: { x: number; y: number };
  }

  async function run(scene: Scene) {
    const bar = { width: 280, height: scene.barHeight };
    // Production feeds ONE rect to both the anchor and the zone maths: the row/cell union.
    const anchor = tableBubbleAnchor(scene.row, scene.cell ?? scene.row);
    const tiers: TableBubbleTier[] = [];
    const reference = { x: 40, y: anchor.top, width: 200, height: anchor.bottom - anchor.top };
    const options = tableBubbleOptions({
      surface: () => scene.surface,
      floorTop: () => scene.floorTop ?? null,
      neighbours: () => ({ prevBottom: scene.prevBottom ?? null, nextTop: scene.nextTop ?? null }),
      row: () => anchor,
      viewport: () => scene.viewport ?? { top: 0, bottom: 900 },
      onTier: (tier) => tiers.push(tier),
      ...(scene.visualOffset ? { visualOffset: () => scene.visualOffset! } : {}),
    });
    const result = await computePosition(reference as never, {} as never, {
      placement: options.placement,
      platform: platformFor(reference, bar, scene.viewport?.bottom ?? VIEWPORT.bottom),
      middleware: [flip(options.flip as never), shift(options.shift as never), offset(options.offset)],
    });
    return { placement: result.placement, top: result.y, bottom: result.y + bar.height, tiers, gap: result.placement.startsWith("top") ? anchor.top - result.y - bar.height : result.y - anchor.bottom };
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

  it("A: a 46px bar (the old padded bar) has 46px above row 2 and 40px below: no clearance anywhere, so tier none instead of a clamp onto the row", async () => {
    const result = await run({ ...firstBlock, barHeight: 46 });
    expect(result.tiers).toEqual(["none"]);
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

  it("a rowspan cell taller than its row: zone and anchor agree (one union rect), and with no room around it the tier is none", async () => {
    // Zone 500-640, row 530-560, spanning cell 530-630, bar 38. Judged on the union (530-630): 30px above, 10px
    // below. (Judged on the row alone the zone said "below fits" while floating-ui judged the longer cell.) The old
    // rule widened the zone to the helper line and dropped the bar below the cell over the next block; there is no
    // wide tier now, so the host shows the toolbar group.
    const row = rect(530, 560);
    const cell = rect(530, 630);
    const result = await run({ surface: rect(500, 640), row, cell, barHeight: 38, prevBottom: 500, nextTop: 640, floorTop: 760 });
    expect(result.tiers).toEqual(["none"]);
  });

  it("a rowspan cell with room below: the bar clears both the row and the cell, below the union", async () => {
    const row = rect(530, 560);
    const cell = rect(530, 630);
    const result = await run({ surface: rect(500, 760), row, cell, barHeight: 38, prevBottom: 500, nextTop: 760 });
    expect(overlap(result, row)).toBe(0);
    expect(overlap(result, cell)).toBe(0);
    expect(result.placement).toBe("bottom-start");
    expect(result.top - 630).toBe(G);
  });

  it("a single-row table between two paragraphs has no room anywhere: tier none, reported once", async () => {
    const result = await run({ surface: rect(400, 760), row: rect(520, 560), barHeight: 38, prevBottom: 515, nextTop: 565 });
    expect(result.tiers).toEqual(["none"]);
  });

  it("C (measured): the middle row with 41.2px above and 33.2px below takes the TIGHT top: no overlap with the previous block or the row, 0 < gap < 8", async () => {
    const prev = { top: 400, bottom: 449.51 };
    const next = { top: 556.71, bottom: 600 };
    const row = rect(490.71, 523.51);
    const result = await run({ surface: rect(421.51, 584.71), row, barHeight: 37.6, prevBottom: prev.bottom, nextTop: next.top, viewport: { top: 0, bottom: 800 } });
    expect(result.tiers).toEqual(["tight"]);
    expect(result.placement).toBe("top-start");
    expect(overlap(result, prev)).toBe(0);
    expect(overlap(result, next)).toBe(0);
    expect(overlap(result, row)).toBe(0);
    expect(result.gap).toBeGreaterThan(0);
    expect(result.gap).toBeLessThan(G);
    expect(result.gap).toBeCloseTo(3.1, 5);
  });

  describe("B (measured): a middle row near the viewport's bottom", () => {
    const prev = { top: 600, bottom: 673 };
    const row = rect(715, 760); // 42px above, 45 below at best
    const scene = { surface: rect(560, 850), row, barHeight: 37.6, prevBottom: prev.bottom, nextTop: 830, floorTop: 866 };

    it("a 800px viewport leaves 40px below: the bar goes tight on top, clear of the previous block", async () => {
      const result = await run({ ...scene, viewport: { top: 0, bottom: 800 } });
      expect(result.tiers).toEqual(["tight"]);
      expect(result.placement).toBe("top-start");
      expect(overlap(result, prev)).toBe(0);
      expect(overlap(result, row)).toBe(0);
      expect(result.gap).toBeLessThan(G);
    });

    it("a 900px viewport has the room below: clean bottom-start with the full 8px gap, above the helper's floor", async () => {
      const result = await run({ ...scene, viewport: { top: 0, bottom: 900 } });
      expect(result.tiers).toEqual(["clean"]);
      expect(result.placement).toBe("bottom-start");
      expect(result.gap).toBe(G);
      expect(result.bottom).toBeLessThanOrEqual(866 - G);
    });
  });

  it("the viewport cuts the visible room but the blocks allow it: tier offscreen on the document root, gap 8, never clamped onto the row", async () => {
    // Row 420-460, next block at 520, viewport bottom 480: 20px visible each way, 60px of block room below.
    const row = rect(420, 460);
    const result = await run({ surface: rect(400, 700), row, barHeight: 38, nextTop: 520, viewport: { top: 0, bottom: 480 } });
    expect(result.tiers).toEqual(["offscreen"]);
    expect(result.placement).toBe("bottom-start");
    expect(result.gap).toBe(G);
    expect(result.top).toBe(468);
    expect(overlap(result, row)).toBe(0);
    expect(result.bottom).toBeGreaterThan(480); // partly scrolled out, as intended
    const options = tableBubbleOptions({
      surface: () => rect(400, 700), floorTop: () => null, neighbours: () => ({ prevBottom: null, nextTop: 520 }),
      row: () => row, viewport: () => ({ top: 0, bottom: 480 }),
    });
    const state = { placement: "top-start", rects: { reference: {}, floating: { x: 0, y: 0, width: 280, height: 38 } } } as never;
    expect(options.flip(state).rootBoundary).toBe("document");
    expect(options.shift(state).rootBoundary).toBe("document");
  });

  it("deterministic sweep: whatever the row position, bar height, neighbours and viewport, a shown bar never overlaps the previous block, the next block or the row, stays inside [surface top, helper - 8], and keeps the full 8px gap whenever 8px fits", async () => {
    const SURFACE = rect(400, 700);
    const FLOOR_TOP = 780; // 72px under the frame: the helper
    let shown = 0;
    let none = 0;
    for (const barHeight of [37.6, 38, 54]) {
      for (const rowHeight of [34, 40]) {
        for (const rowTop of [440, 470, 500, 530, 560, 590, 620, 650]) {
          for (const above of [null, 4, 20, 42, 80]) { // distance from the previous block's bottom to the row top
            for (const below of [null, 4, 20, 42, 80]) { // distance from the row bottom to the next block's top
              for (const viewportBottom of [500, 600, 700, 900]) {
                const row = rect(rowTop, rowTop + rowHeight);
                const prev = above === null ? null : { top: rowTop - above - 30, bottom: rowTop - above };
                const next = below === null ? null : { top: rowTop + rowHeight + below, bottom: rowTop + rowHeight + below + 30 };
                const label = JSON.stringify({ barHeight, rowTop, rowHeight, above, below, viewportBottom });
                const result = await run({
                  surface: SURFACE, row, barHeight, prevBottom: prev?.bottom ?? null, nextTop: next?.top ?? null,
                  floorTop: FLOOR_TOP, viewport: { top: 0, bottom: viewportBottom },
                });
                const tier = result.tiers.at(-1)!;
                expect(result.tiers.length, label).toBe(1); // the tier is stable across middleware passes
                if (tier === "none") { none += 1; continue; }
                shown += 1;
                if (prev) expect(overlap(result, prev), `prev ${label}`).toBe(0);
                if (next) expect(overlap(result, next), `next ${label}`).toBe(0);
                expect(overlap(result, row), `row ${label}`).toBe(0);
                expect(result.top, `surface top ${label}`).toBeGreaterThanOrEqual(SURFACE.top);
                expect(result.bottom, `helper ${label}`).toBeLessThanOrEqual(FLOOR_TOP - G);
                const ceil = prev ? Math.max(SURFACE.top, prev.bottom) : SURFACE.top;
                const floor = Math.min(Math.max(SURFACE.bottom, FLOOR_TOP - G), next ? next.top : Infinity);
                const fits8 = (top: number, bottom: number) => row.top - top >= barHeight + G || bottom - row.bottom >= barHeight + G;
                const visibleRoom = Math.max(row.top - Math.max(ceil, 0), Math.min(floor, viewportBottom) - row.bottom);
                if (fits8(Math.max(ceil, 0), Math.min(floor, viewportBottom))) { expect(tier, `clean ${label}`).toBe("clean"); expect(result.gap, `clean ${label}`).toBeCloseTo(G, 9); }
                else if (visibleRoom - barHeight >= 0.5) { expect(tier, label).toBe("tight"); expect(result.gap, label).toBeLessThan(G); expect(result.gap, label).toBeGreaterThanOrEqual(0); }
                else if (fits8(ceil, floor)) { expect(tier, `offscreen ${label}`).toBe("offscreen"); expect(result.gap, `offscreen ${label}`).toBeCloseTo(G, 9); }
                else { expect(tier, label).toBe("offscreen"); expect(result.gap, label).toBeLessThan(G); expect(result.gap, label).toBeGreaterThanOrEqual(0); }
              }
            }
          }
        }
      }
    }
    expect(shown).toBeGreaterThan(200);
    expect(none).toBeGreaterThan(20);
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
    const tiers: TableBubbleTier[] = [];
    const options = tableBubbleOptions({
      onTier: (tier) => tiers.push(tier),
      surface: () => rect(480, 700),
      floorTop: () => null,
      neighbours: () => ({ prevBottom: 500, nextTop: null }),
      row: () => rect(526, 560),
      viewport: () => ({ top: 0, bottom: 900 }),
    });
    const withHeight = (height: number) => ({ placement: "top-start", rects: { reference: {}, floating: { x: 0, y: 0, width: 280, height } } });
    // 38px: 526 - 8 - 38 = 480 < 500 (previous block), but the bottom fits: clean (ceiling 500).
    expect(options.flip(withHeight(38) as never).boundary.top).toBe(500);
    expect(tiers).toEqual(["clean"]);
    // 400px fits neither side: tier none. There is no wide zone: the ceiling stays the previous block's bottom.
    expect(options.flip(withHeight(400) as never).boundary.top).toBe(500);
    expect(tiers).toEqual(["clean", "none"]);
    // Offset and padding follow the same pass: a 38px bar at 26px above / 140 below gets the full 8.
    expect(options.offset(withHeight(38) as never)).toBe(8);
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
