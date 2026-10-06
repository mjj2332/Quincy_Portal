import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computePosition, flip, offset, shift, type Platform } from "@floating-ui/core";
import {
  TABLE_BUBBLE_GAP,
  tableBubbleAnchor,
  tableBubbleBoundary,
  tableBubbleOptions,
  tableBubbleZone,
  viewportBelow,
  type TableBubbleTier,
} from "./rich-text-table-position";

const rect = (top: number, bottom: number, left = 20, right = 340) => ({ top, bottom, left, right });

describe("tableBubbleBoundary", () => {
  const surface = rect(500, 640);

  it("is the given rect with the Rect fields filled in", () => {
    expect(tableBubbleBoundary(surface)).toEqual({ x: 20, y: 500, width: 320, height: 140, top: 500, left: 20, right: 340, bottom: 640 });
  });

  it("reads getter-backed DOMRect fields (a spread would lose them)", () => {
    const domRectLike = Object.create({
      get top() { return 500; },
      get bottom() { return 640; },
      get left() { return 20; },
      get right() { return 340; },
    });
    expect(tableBubbleBoundary(domRectLike)).toMatchObject({ top: 500, bottom: 640, left: 20, right: 340, y: 500, x: 20 });
  });

  it("shifts by the visualViewport offset when given one", () => {
    expect(tableBubbleBoundary(surface, { x: 0, y: 30 })).toMatchObject({ top: 530, bottom: 670, y: 530 });
  });
});

const G = TABLE_BUBBLE_GAP;
const overlap = (a: { top: number; bottom: number }, b: { top: number; bottom: number }) =>
  Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

describe("tableBubbleZone (#555: dock to the table, neighbouring blocks do not bound it)", () => {
  const viewport = { top: 75, bottom: 668 }; // the sticky shell header covers the first 75px
  const base = { barHeight: 38, viewport };

  it("measured layout (surface 204-432, table 324-424, a paragraph 8px above it): docks ABOVE, over the paragraph", () => {
    const zone = tableBubbleZone({ ...base, surface: rect(204, 432), row: rect(324, 424) });
    expect(zone.tier).toBe("clean");
    expect(zone.side).toBe("top");
    expect(zone.gap).toBe(G);
  });

  it("room above is measured from the surface top or the visible viewport top, whichever is lower", () => {
    // Surface starts at 20 but the shell covers down to 75: 100 - 75 = 25 < 46, so above does not fit.
    expect(tableBubbleZone({ ...base, surface: rect(20, 500), row: rect(100, 160) }).side).toBe("bottom");
    // The same table with the viewport scrolled clear of the shell: 100 - 20 = 80 fits above.
    expect(tableBubbleZone({ ...base, viewport: { top: 0, bottom: 668 }, surface: rect(20, 500), row: rect(100, 160) }).side).toBe("top");
  });

  it("a table first in the document with only surface padding around it and no room below: tier none", () => {
    // Surface 316-432, table 324-424: 8px above, 8px below.
    expect(tableBubbleZone({ ...base, surface: rect(316, 432), row: rect(324, 424) }).tier).toBe("none");
  });

  it("a first table with room below inside the surface docks below, and ends inside the surface (item 1)", () => {
    const zone = tableBubbleZone({ ...base, surface: rect(316, 500), row: rect(324, 424) });
    expect(zone.side).toBe("bottom");
    expect(424 + G + 38).toBeLessThanOrEqual(500);
    // One pixel short of fitting inside the surface falls back.
    expect(tableBubbleZone({ ...base, surface: rect(316, 468), row: rect(324, 424) }).tier).toBe("none");
  });

  it("the visible viewport bottom limits the room below as the surface bottom does", () => {
    expect(tableBubbleZone({ ...base, viewport: { top: 75, bottom: 450 }, surface: rect(316, 700), row: rect(324, 424) }).tier).toBe("none");
  });

  it("a tall table scrolled past the viewport (top above it, bottom below it): neither docked spot is visible, tier none", () => {
    expect(tableBubbleZone({ ...base, viewport: { top: 0, bottom: 800 }, surface: rect(-400, 1200), row: rect(-300, 1100) }).tier).toBe("none");
  });

  it("a table wholly scrolled below the visible area (or wholly above it) has no visible docked spot: tier none", () => {
    expect(tableBubbleZone({ ...base, surface: rect(0, 1000), row: rect(700, 760) }).tier).toBe("none");
    expect(tableBubbleZone({ ...base, surface: rect(0, 1000), row: rect(-200, -100) }).tier).toBe("none");
  });

  it("an unmeasured bar (height 0) is judged clean, so the toolbar never flickers in before the bar is laid out", () => {
    expect(tableBubbleZone({ ...base, barHeight: 0, surface: rect(316, 432), row: rect(324, 424) }).tier).toBe("clean");
  });

  it("the boundary edges are the visible surface: its top clipped below the shell, its bottom clipped by the viewport", () => {
    const zone = tableBubbleZone({ ...base, surface: rect(20, 900), row: rect(324, 424) });
    expect(zone.top).toBe(75);
    expect(zone.bottom).toBe(668);
  });
});

describe("tableBubbleAnchor", () => {
  it("is the whole table vertically (never a row) and the active cell's column horizontally", () => {
    expect(tableBubbleAnchor(rect(500, 640, 20, 340), rect(530, 560, 30, 120))).toEqual({ top: 500, bottom: 640, left: 30, right: 120 });
  });

  it("clamps the column to the table's visible width", () => {
    expect(tableBubbleAnchor(rect(500, 640, 20, 340), rect(530, 560, 300, 500))).toEqual({ top: 500, bottom: 640, left: 300, right: 340 });
    expect(tableBubbleAnchor(rect(500, 640, 20, 340), rect(530, 560, -50, 40))).toEqual({ top: 500, bottom: 640, left: 20, right: 40 });
  });
});

describe("table bar placement (floating-ui computePosition)", () => {
  const VIEWPORT = { top: 0, left: 0, right: 1200, bottom: 900 };
  const platformFor = (reference: unknown, bar: { width: number; height: number }, viewportBottom = VIEWPORT.bottom) =>
    ({
      getElementRects: async () => ({ reference, floating: { x: 0, y: 0, ...bar } }),
      getDimensions: async () => bar,
      getClippingRect: async ({ boundary }: { boundary: unknown }) => {
        const b = boundary as { top: number; left: number; right: number; bottom: number };
        const top = Math.max(b.top, VIEWPORT.top);
        const left = Math.max(b.left, VIEWPORT.left);
        const right = Math.min(b.right, VIEWPORT.right);
        const bottom = Math.min(b.bottom, viewportBottom);
        return { x: left, y: top, width: right - left, height: bottom - top };
      },
    }) as unknown as Platform;

  interface Scene {
    surface: ReturnType<typeof rect>;
    /** The whole table. */
    table: ReturnType<typeof rect>;
    cell?: ReturnType<typeof rect>;
    barHeight: number;
    viewport?: { top: number; bottom: number };
    visualOffset?: { x: number; y: number };
  }

  async function run(scene: Scene) {
    const bar = { width: 280, height: scene.barHeight };
    const anchor = tableBubbleAnchor(scene.table, scene.cell ?? scene.table);
    const tiers: TableBubbleTier[] = [];
    const viewport = scene.viewport ?? { top: 0, bottom: 900 };
    const reference = { x: anchor.left, y: anchor.top, width: anchor.right - anchor.left, height: anchor.bottom - anchor.top };
    const options = tableBubbleOptions({
      surface: () => scene.surface,
      row: () => anchor,
      viewport: () => viewport,
      onTier: (tier) => tiers.push(tier),
      ...(scene.visualOffset ? { visualOffset: () => scene.visualOffset! } : {}),
    });
    const result = await computePosition(reference as never, {} as never, {
      placement: options.placement,
      platform: platformFor(reference, bar, viewport.bottom),
      middleware: [flip(options.flip as never), shift(options.shift as never), offset(options.offset)],
    });
    return { placement: result.placement, top: result.y, bottom: result.y + bar.height, tiers };
  }

  // A 3-row table, 40px rows, 560-680, with a paragraph above (8px gap) and below.
  const rows = [rect(560, 600, 30, 330), rect(600, 640, 30, 330), rect(640, 680, 30, 330)];
  const table = rect(560, 680, 30, 330);
  const paragraphAbove = rect(510, 552);
  const paragraphBelow = rect(688, 730);
  const cellIn = (index: number) => rect(rows[index]!.top, rows[index]!.bottom, 120, 220);

  const scenes: Record<string, { surface: ReturnType<typeof rect>; below: boolean }> = {
    "a block above and below (room both sides)": { surface: rect(400, 900), below: true },
    "a block above, nothing after the table": { surface: rect(400, 900), below: false },
    "first in the document (surface padding only above): drops below": { surface: rect(552, 900), below: false },
    "first in the document, a paragraph after": { surface: rect(552, 900), below: true },
  };

  for (const [name, scene] of Object.entries(scenes)) {
    for (const [rowName, index] of [["header", 0], ["middle", 1], ["last", 2]] as const) {
      it(`${name}, caret in the ${rowName} row: the bar covers no cell, stays inside the surface and the viewport`, async () => {
        const result = await run({ surface: scene.surface, table, cell: cellIn(index), barHeight: 38 });
        expect(result.tiers.at(-1)).toBe("clean");
        for (const r of rows) expect(overlap(result, r), `row ${r.top}`).toBe(0);
        expect(overlap(result, table)).toBe(0);
        expect(result.top).toBeGreaterThanOrEqual(scene.surface.top);
        expect(result.bottom).toBeLessThanOrEqual(scene.surface.bottom);
        if (result.placement.startsWith("top")) expect(table.top - result.bottom).toBe(G);
        else expect(result.top - table.bottom).toBe(G);
      });
    }
  }

  it("a paragraph directly above (8px gap): the bar docks above and overlaps that paragraph (owner decision)", async () => {
    const result = await run({ surface: rect(400, 900), table, cell: cellIn(1), barHeight: 38 });
    expect(result.placement).toBe("top-start");
    expect(overlap(result, paragraphAbove)).toBeGreaterThan(0);
    expect(overlap(result, table)).toBe(0);
  });

  it("a paragraph after the table: when above has no room the bar docks below and may overlap that paragraph", async () => {
    const result = await run({ surface: rect(552, 900), table, cell: cellIn(1), barHeight: 38 });
    expect(result.placement).toBe("bottom-start");
    expect(overlap(result, paragraphBelow)).toBeGreaterThan(0);
    expect(overlap(result, table)).toBe(0);
  });

  it("the shell header covers the viewport's first 75px: a table 40px under it docks below, not under the header", async () => {
    const result = await run({ surface: rect(0, 900), table: rect(115, 300), cell: rect(115, 150, 120, 220), barHeight: 38, viewport: { top: 75, bottom: 900 } });
    expect(result.placement).toBe("bottom-start");
    expect(result.top).toBe(308);
  });

  it("with no block after the table the bar's bottom stays inside the surface, and tier none when it cannot", async () => {
    const fits = await run({ surface: rect(552, 740), table, cell: cellIn(1), barHeight: 38 });
    expect(fits.bottom).toBeLessThanOrEqual(740);
    const none = await run({ surface: rect(552, 700), table, cell: cellIn(1), barHeight: 38 });
    expect(none.tiers).toEqual(["none"]);
  });

  it("a tall table scrolled past the viewport: tier none, reported once", async () => {
    const result = await run({ surface: rect(-400, 1200), table: rect(-300, 1100), cell: rect(300, 340, 120, 220), barHeight: 38, viewport: { top: 0, bottom: 800 } });
    expect(result.tiers).toEqual(["none"]);
  });

  it("deterministic sweep: whatever the table position, bar height, surface and viewport, a shown bar never touches the table and never leaves the visible surface; the gap is exactly 8", async () => {
    let shown = 0;
    let none = 0;
    for (const barHeight of [37.6, 38, 54]) {
      for (const tableHeight of [40, 120, 400]) {
        for (const tableTop of [60, 120, 200, 320, 500, 700]) {
          for (const surfaceTop of [0, 100, 300]) {
            for (const surfaceBottom of [500, 760, 1000]) {
              for (const viewport of [{ top: 0, bottom: 668 }, { top: 75, bottom: 900 }]) {
                const t = rect(tableTop, tableTop + tableHeight);
                const surface = rect(surfaceTop, surfaceBottom);
                const label = JSON.stringify({ barHeight, tableTop, tableHeight, surfaceTop, surfaceBottom, viewport });
                const result = await run({ surface, table: t, barHeight, viewport });
                expect(result.tiers.length, label).toBe(1);
                if (result.tiers[0] === "none") { none += 1; continue; }
                shown += 1;
                expect(overlap(result, t), `table ${label}`).toBe(0);
                expect(result.top, label).toBeGreaterThanOrEqual(Math.max(surface.top, viewport.top));
                expect(result.bottom, label).toBeLessThanOrEqual(Math.min(surface.bottom, viewport.bottom));
                if (result.placement.startsWith("top")) expect(t.top - result.bottom, label).toBeCloseTo(G, 9);
                else expect(result.top - t.bottom, label).toBeCloseTo(G, 9);
              }
            }
          }
        }
      }
    }
    expect(shown).toBeGreaterThan(100);
    expect(none).toBeGreaterThan(50);
  });

  it("is deterministic: the zone does not depend on the placement floating-ui is currently trying", () => {
    const options = tableBubbleOptions({ surface: () => rect(400, 700), row: () => rect(560, 600), viewport: () => ({ top: 0, bottom: 900 }) });
    const stateFor = (placement: string) => ({ placement, rects: { reference: {}, floating: { x: 0, y: 0, width: 280, height: 38 } } });
    const a = options.flip(stateFor("top-start") as never);
    const b = options.flip(stateFor("bottom-start") as never);
    expect(a.boundary).toEqual(b.boundary);
    expect(options.shift(stateFor("bottom-start") as never).boundary).toEqual(a.boundary);
  });

  it("reads the bar height from the floating rect, never a constant", () => {
    const tiers: TableBubbleTier[] = [];
    const options = tableBubbleOptions({ onTier: (tier) => tiers.push(tier), surface: () => rect(480, 700), row: () => rect(526, 560), viewport: () => ({ top: 0, bottom: 900 }) });
    const withHeight = (height: number) => ({ placement: "top-start", rects: { reference: {}, floating: { x: 0, y: 0, width: 280, height } } });
    // 38px: 526 - 480 = 46 above fits exactly.
    expect(options.flip(withHeight(38) as never).boundary.top).toBe(480);
    expect(tiers).toEqual(["clean"]);
    // 400px fits neither side: tier none.
    options.flip(withHeight(400) as never);
    expect(tiers).toEqual(["clean", "none"]);
    expect(options.offset(withHeight(38) as never)).toBe(8);
  });

  it("adds the visualViewport offset AFTER deciding the zone", () => {
    const input = { surface: () => rect(400, 700), row: () => rect(560, 600), viewport: () => ({ top: 0, bottom: 900 }) };
    const state = { placement: "top-start", rects: { reference: {}, floating: { x: 0, y: 0, width: 280, height: 38 } } } as never;
    const plain = tableBubbleOptions(input).flip(state).boundary;
    const shifted = tableBubbleOptions({ ...input, visualOffset: () => ({ x: 0, y: 30 }) }).flip(state).boundary;
    expect(shifted.top).toBe(plain.top + 30);
    expect(shifted.bottom).toBe(plain.bottom + 30);
    expect(shifted.height).toBe(plain.height);
  });
});

describe("viewportBelow (#594: the sticky composer toolbar is a second ceiling under the shell header)", () => {
  // The unit project has no DOM: a 50px shell header and a 900px viewport.
  beforeEach(() => {
    vi.stubGlobal("document", {
      documentElement: { clientHeight: 900 },
      querySelector: () => ({ getBoundingClientRect: () => ({ bottom: 50 }) }),
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("is the shell chrome bottom when there is no ceiling, and the lower of the two when there is", () => {
    const base = viewportBelow()().top;
    expect(viewportBelow(() => 0)().top).toBe(base);
    expect(viewportBelow(() => base - 10)().top).toBe(base);
    expect(viewportBelow(() => base + 48)().top).toBe(base + 48);
  });

  it("a table whose top sits under a toolbar stuck at 50-98 has no room above (tier none or below), where it used to be clean", () => {
    const row = rect(120, 400);
    const surface = rect(0, 900);
    const old = tableBubbleZone({ row, barHeight: 38, surface, viewport: { top: 50, bottom: 900 } });
    const stuck = tableBubbleZone({ row, barHeight: 38, surface, viewport: { top: viewportBelow(() => 98)().top, bottom: 900 } });
    expect(old).toMatchObject({ tier: "clean", side: "top" });
    expect(stuck.top).toBeGreaterThanOrEqual(98);
    expect(stuck.side).not.toBe("top");
  });
});
