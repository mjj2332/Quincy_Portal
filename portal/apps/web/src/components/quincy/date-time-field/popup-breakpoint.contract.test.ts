import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { POPUP_STACKED_QUERY } from "@/lib/date-time-field";

/**
 * #602: the date/time popups stack their three columns at the SAME width the calendar swaps to its
 * 44px cells (`max-[721px]` in CalendarPane). `sm` (640px) left a 640-720 window where the time column
 * sat beside the calendar and clipped ("09:" instead of "09:00"). Source-text contract; happy-dom
 * resolves no media queries.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(join(here, file), "utf8");

const STACKING_FILES = ["DateTimeRangePopup.tsx", "DateTimePopup.tsx", "ShortcutList.tsx", "TimeColumn.tsx", "PopupFrame.tsx"] as const;
const CELL_BREAKPOINT = /max-\[(\d+)px\]:\[--cell-size:/.exec(read("CalendarPane.tsx"))?.[1];

describe("date popup stacking breakpoint (#602)", () => {
  it("reads the calendar's cell breakpoint", () => {
    expect(CELL_BREAKPOINT).toBe("721");
  });

  for (const file of STACKING_FILES) {
    it(`${file} stacks at the cell breakpoint, not at sm`, () => {
      const source = read(file);
      // `sm:` / `max-sm:` utilities (prose in comments is not a class).
      expect(source.match(/(?:^|[\s"'`])(?:max-)?sm:[\w[\]*-]/gm) ?? []).toEqual([]);
      expect(source).toMatch(new RegExp(`min-\\[${CELL_BREAKPOINT}px\\]:`));
    });
  }

  it("TimeColumn's slots keep a 44px touch target", () => {
    const source = read("TimeColumn.tsx");
    expect(source).toContain("pointer-coarse:min-h-[44px]");
    expect(source).toContain("max-[721px]:min-h-[44px]");
  });

  it("CalendarPane gives the Month/Year selects a hit area", () => {
    const source = read("CalendarPane.tsx");
    expect(source).toContain("**:[.rdp-dropdown\\_root]:min-h-(--cell-size)");
    expect(source).toContain("pointer-coarse:**:[.rdp-dropdown\\_root]:min-h-[44px]");
  });

  it("DateTimeField's slide-over placement switches at the same width as the stack, from the shared query", () => {
    const source = readFileSync(join(here, "../DateTimeField.tsx"), "utf8");
    expect(POPUP_STACKED_QUERY).toBe(`(width < ${CELL_BREAKPOINT}px)`);
    expect(source).not.toContain("40rem");
    expect(source).toContain("useMediaQuery(POPUP_STACKED_QUERY)");
  });
});

/**
 * #636: at 360 the stacked popup body is ~306px wide (popup = 100vw - 2 gutters, less the frame and scrollbar, then the 24px panel padding), and seven 44px cells are 308 against ~298 of grid. The cell size is capped by the room: min(44px, (100vw - chrome) / 7).
 * Source-text contract; happy-dom resolves no layout. The chrome allowance must cover the gutters, frame/scrollbar and panel padding (66px).
 */
describe("calendar cells fit the stacked popup (#636)", () => {
  const rule = /max-\[721px\]:\[--cell-size:min\(--spacing\(11\),calc\(\(100vw-([\d.]+)rem\)\/7\)\)\]/.exec(read("CalendarPane.tsx"));
  const chromePx = rule ? Number(rule[1]) * 16 : NaN;
  const cell = (viewport: number) => Math.min(44, (viewport - chromePx) / 7);
  // 32px gutters + 10px popup-to-body (frame, scrollbar) + 24px panel padding (measured at 360 in the #636 browser pass).
  const POPUP_CHROME_PX = 32 + 10 + 24;

  it("caps the 44px cell by the room left across seven columns", () => {
    expect(rule).not.toBeNull();
    expect(chromePx).toBeGreaterThanOrEqual(POPUP_CHROME_PX);
  });
  it("seven cells fit the body at 320-390 and the cell stays at least 40px from 335 up", () => {
    for (const width of [320, 360, 375, 390]) {
      const body = Math.min(width - 32, 384) - 10 - 24;
      expect(7 * cell(width)).toBeLessThanOrEqual(body);
    }
    for (const width of [360, 375, 390]) expect(cell(width)).toBeGreaterThanOrEqual(40);
    expect(cell(390)).toBe(44);
  });
});
