import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "event-calendar-agenda-view.tsx"), "utf8");

describe("agenda view day header formats (#614)", () => {
  it("does not hard-code the vendor's weekday or date literals", () => {
    expect(src).not.toMatch(/format\([^)]*"EEEE"/);
    expect(src).not.toMatch(/"MMMM d, yyyy"/);
  });

  it("reads both formats from the settings' i18n", () => {
    expect(src).toContain("settings.i18n.formats.agendaDayWeekday");
    expect(src).toContain("settings.i18n.formats.agendaDayDate");
  });
});
