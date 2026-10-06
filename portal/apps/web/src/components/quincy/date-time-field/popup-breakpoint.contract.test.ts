import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * #602: the date/time popups stack their three columns at the SAME width the calendar swaps to its
 * 44px cells (`max-[721px]` in CalendarPane). `sm` (640px) left a 640-720 window where the time column
 * sat beside the calendar and clipped ("09:" instead of "09:00"). Source-text contract; happy-dom
 * resolves no media queries.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(join(here, file), "utf8");

const STACKING_FILES = ["DateTimeRangePopup.tsx", "DateTimePopup.tsx", "ShortcutList.tsx", "TimeColumn.tsx"] as const;
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
});
