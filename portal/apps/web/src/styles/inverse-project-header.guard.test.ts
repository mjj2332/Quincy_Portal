/**
 * The phone Project header on an inverse sheet (#927 D6).
 *
 * ProjectSheet carries `data-surface="inverse"` while a film URL is open, so text resolves to paper-050. The header bars paint
 * `--bg-surface`, which inverse.css does not remap (it feeds the light `[data-surface="default"]` restore, so remapping it there
 * would make a nested default scope paint ink), leaving near-white text on white. Each bar must paint `--background` under the scope.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("./app.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const BARS = [".project-phone__bar", ".project-phone__slim", ".project-header", ".project-header__tabbar"];

function declarations(selector: string): string[] {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  return rules.filter(([, sel]) => sel!.split(",").some((s) => s.trim() === selector)).map(([, , body]) => body!);
}

describe("project header bars under an inverse scope", () => {
  for (const bar of BARS) {
    it(`${bar} paints --background, not --bg-surface, inside [data-surface="inverse"]`, () => {
      const bodies = declarations(`[data-surface="inverse"] ${bar}`);
      expect(bodies.some((b) => /background(-color)?:\s*var\(--background\)/.test(b))).toBe(true);
    });
  }
});
