/**
 * The rail's layout rule — #111.
 *
 * `.app` is an UNLAYERED `flex-direction: column` in `app.css`. An unlayered declaration beats
 * anything in Tailwind's `@layer utilities` regardless of specificity, so putting `flex-row` on the
 * shell element would be a silent no-op — the same trap `tokens/reui.css` records for `--radius`
 * and the type scale, and the reason the railed shell needs a real rule rather than a utility.
 *
 * This lives in a node test over the CSS SOURCE rather than in a DOM test because there is nothing
 * for a DOM test to see: happy-dom applies no stylesheet, so `getComputedStyle` would report the
 * default either way, and asserting the class name instead is what `testing/test-seam.guard.test.ts`
 * guards A and C correctly forbid. The class name is not the behaviour; this rule is.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Comments are stripped first. Found by this file failing on its own first run: a `/* … */` block
// sitting between two rules is swallowed into the next rule's SELECTOR capture, and the comment
// above `.app--railed` contains commas, so the selector list never matched. The same prose-read-as-
// code trap that `sidebar-token-bridge.guard.test.ts` and the routing-transport guard both hit.
const appCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the first rule whose selector list contains `selector` exactly. */
function ruleBody(css: string, selector: string): string | null {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? "").split(",").map((part) => part.trim());
    if (selectors.includes(selector)) return match[2] ?? "";
  }
  return null;
}

describe("the railed shell layout", () => {
  it("keeps the default shell a column", () => {
    expect(ruleBody(appCss, ".app")).toContain("flex-direction: column");
  });

  it("turns the railed shell into a row in authored CSS, not a utility", () => {
    const body = ruleBody(appCss, ".app--railed");
    expect(body, ".app--railed must exist as a real rule in app.css").not.toBeNull();
    expect(body).toContain("flex-direction: row");
  });

  it("declares both rules outside any @layer", () => {
    // The whole point. If either rule is ever moved inside `@layer`, a Tailwind utility could beat
    // it and the layout would depend on class order.
    for (const selector of [".app ", ".app--railed "]) {
      const index = appCss.indexOf(selector);
      expect(index, `${selector} not found`).toBeGreaterThan(-1);
      const before = appCss.slice(0, index);
      const opened = (before.match(/@layer[^;{]*\{/g) ?? []).length;
      const closed = (before.match(/\}/g) ?? []).length;
      expect(opened, `${selector} sits inside an @layer block`).toBeLessThanOrEqual(closed);
    }
  });

  it("lets the content column shrink so the rail keeps its width", () => {
    // Without `min-width: 0` a wide table inside a page sets the flex item's minimum to its content
    // width and pushes the 250px rail off the viewport.
    expect(appCss).toMatch(/\.app--railed > :not\(\.app__rail\)\s*\{[^}]*min-width:\s*0/);
  });

  it("does not reuse the .rail class, which ProjectOverviewRail already owns", () => {
    expect(ruleBody(appCss, ".app--rail")).toBeNull();
    expect(appCss).toContain(".app--impersonating .rail");
  });
});
