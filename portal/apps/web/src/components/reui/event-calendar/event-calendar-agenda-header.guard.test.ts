import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "event-calendar-agenda-view.tsx"), "utf8");
const timeGrid = readFileSync(join(here, "event-calendar-time-grid.tsx"), "utf8");

describe("agenda view day header formats (#614)", () => {
  it("does not hard-code the vendor's weekday or date literals", () => {
    expect(src).not.toMatch(/format\([^)]*"EEEE"/);
    expect(src).not.toMatch(/"MMMM d, yyyy"/);
  });

  it("reads both formats from the settings' i18n", () => {
    expect(src).toContain("settings.i18n.formats.agendaDayWeekday");
    expect(src).toContain("settings.i18n.formats.agendaDayDate");
  });

  it("paints the sticky day header solid, so rows never show through it", () => {
    const header = src.match(/"[^"]*\bsticky top-0[^"]*"/)?.[0] ?? "";
    expect(header).toMatch(/\bbg-muted\b(?!\/)/);
  });
});

describe("today highlight is a chip, not near-black text (#643)", () => {
  // `--primary` is near-black, so `text-primary` on today is invisible against the other days.
  it("agenda and time-grid headers carry no bare today text-primary", () => {
    expect(src).not.toMatch(/isToday\([^)]*\)\s*&&\s*"text-primary"/);
    expect(timeGrid).not.toContain("data-today:text-primary");
  });

  it("the today branch uses the month view's chip classes", () => {
    const chip = /isToday(?:\([^)]*\))?\s*&&\s*"[^"]*bg-primary text-primary-foreground[^"]*"/;
    expect(src).toMatch(chip);
    expect(timeGrid).toMatch(chip);
    // A week column on a phone is narrower than the chip: it must shrink and ellipsise with its
    // neighbours instead of overflowing the column (#643 browser pass, 30.9px columns at 320).
    expect(timeGrid).toMatch(/isToday\s*&&\s*"[^"]*\binline-block max-w-full truncate align-bottom\b[^"]*"/);
    expect(src).toMatch(/rounded-sm/);
  });
});

describe("week/day header is stacked on phones (#643)", () => {
  it("renders a stacked narrow-weekday + date-number variant below 721px, hidden at >=721px", () => {
    expect(timeGrid).toContain('"EEEEE"');
    expect(timeGrid).toContain('"d"');
    expect(timeGrid).toContain("max-[721px]:hidden");
    expect(timeGrid).toContain("min-[721px]:hidden");
    expect(timeGrid).toContain("max-[721px]:px-0.5 max-[721px]:text-center");
  });

  it("circles only the today numeral, with the month view's marker classes", () => {
    expect(timeGrid).toMatch(/isToday\s*&&\s*"[^"]*\brounded-full\b[^"]*"/);
    expect(timeGrid).toMatch(/isToday\s*&&\s*"[^"]*\bbg-primary text-primary-foreground\b[^"]*"/);
    expect(timeGrid).toMatch(/\bsize-5\b/);
  });

  it("the >=721 week chip matches the agenda chip's weight and line-height", () => {
    expect(src).toMatch(/font-semibold/);
    expect(timeGrid).toMatch(/isToday\s*&&\s*"[^"]*\bfont-semibold leading-\[inherit\][^"]*"/);
  });
});

describe("Calendar toolbar toggle (#643)", () => {
  const toolbar = readFileSync(join(here, "../../ProductionEventCalendar.tsx"), "utf8");

  it("icon-only toggle is an outline icon Button, not an IconButton", () => {
    expect(toolbar).toMatch(/<Button[^>]*variant="outline"[^>]*size="icon"[^>]*aria-label="Calendar"/s);
    expect(toolbar).not.toContain("IconButton");
  });

  it("Prev/Next wrapper pins right with ml-auto", () => {
    expect(toolbar).toMatch(/className="ml-auto flex shrink-0 items-center"/);
  });
});
