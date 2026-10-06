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
    expect(src).toMatch(/rounded-sm/);
  });
});
