import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { POPUP_STACKED_QUERY } from "@/lib/date-time-field";

/**
 * #630: below 721px a date popup is exactly as wide as the space between the gutters, so every picker sits
 * 16/16 instead of a content-width popup hugging whichever side its trigger is on. Source-text contract;
 * happy-dom resolves no media queries or layout.
 */
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../DateTimeField.tsx"), "utf8");

describe("stacked date popup width (#630)", () => {
  it("fills the viewport between the --space-4 gutters at the stacked breakpoint, capped at 24rem so a 720px window does not stretch the day cells", () => {
    expect(POPUP_STACKED_QUERY).toBe("(width < 721px)");
    expect(source).toContain("max-[721px]:w-[min(calc(100vw-2*var(--space-4)),24rem)]");
  });
  it("keeps the desktop width content-sized", () => {
    expect(source).toMatch(/cn\("w-auto max-w-\[calc\(100vw-2\*var\(--space-4\)\)\]/);
  });
  it("no body layout switches to a row below 721px (it would overflow the capped popup at 640-720px)", () => {
    expect(source.match(/(?:^|[\s"'`])(?:max-)?(?:sm|md|lg):[\w[\]*-]/gm) ?? []).toEqual([]);
    expect(source).toContain("min-[721px]:flex-row");
  });
});
