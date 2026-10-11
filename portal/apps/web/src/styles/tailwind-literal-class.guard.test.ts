import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #741 11b: Tailwind only generates a class it can read whole in the source. An arbitrary value built
 * with template interpolation -- `scroll-mt-[calc(var(--space-4)+${SIZE}+var(--space-2))]` -- never
 * reaches the CSS, so the class silently does nothing (the Review links button's scroll margin measured
 * 0px in the browser while every unit test passed). Write the value out literally.
 */
export const INTERPOLATED_ARBITRARY = /[a-z0-9)\]]-\[[^\]\s`"']*\$\{/;

const srcDir = resolve(__dirname, "..");
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.(tsx?|jsx?)$/.test(entry.name) && !/\.test\.[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

describe("guard: no template interpolation inside a Tailwind arbitrary value (#741 11b)", () => {
  it("the matcher catches the shipped form and leaves literal and plain-interpolated classes alone", () => {
    expect(INTERPOLATED_ARBITRARY.test("`scroll-mt-[calc(var(--space-4)+${SIZE}+var(--space-2))]`")).toBe(true);
    expect(INTERPOLATED_ARBITRARY.test("`max-[721px]:top-[${x}px]`")).toBe(true);
    expect(INTERPOLATED_ARBITRARY.test("`w-[${width}px]`")).toBe(true);
    expect(INTERPOLATED_ARBITRARY.test('"scroll-mt-[calc(var(--space-4)+44px+var(--space-2))]"')).toBe(false);
    expect(INTERPOLATED_ARBITRARY.test("`min-h-11 ${PROJECT_SHEET_CLOSE_SCROLL_MARGIN}`")).toBe(false);
    expect(INTERPOLATED_ARBITRARY.test("`${base} gap-[var(--space-2)]`")).toBe(false);
  });

  it("no source file builds an arbitrary-value class by interpolation", () => {
    const offenders = sources(srcDir).flatMap((file) =>
      readFileSync(file, "utf8").split("\n").flatMap((line, index) => (INTERPOLATED_ARBITRARY.test(line) ? [`${relative(srcDir, file)}:${index + 1}`] : [])));
    expect(offenders, "Tailwind never generates an interpolated arbitrary value; write the value out literally").toEqual([]);
  });
});
