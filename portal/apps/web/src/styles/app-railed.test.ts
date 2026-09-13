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

/**
 * The shell module's source.
 *
 * Reported by Luna: this file first read only `app.css`, so renaming the conditional class in the
 * shell from `app--railed` to `app--rail` left the CSS rule valid, this guard green, and the real
 * shell stacked as a column with the rail above the content. A rule nothing applies is not a
 * layout. Asserted over the SOURCE rather than in a DOM test because
 * `testing/test-seam.guard.test.ts` guards A and C forbid selecting on or asserting a Quincy class
 * name from a DOM test — correctly, since a class name is not behaviour.
 */
const appRouter = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "app-router.tsx"),
  "utf8",
);

describe("the shell applies the rule", () => {
  it("names the same class the CSS defines", () => {
    expect(appRouter).toContain("app--railed");
  });

  it("applies it conditionally on the rail flag, in one expression", () => {
    // Pins the pairing, not just the presence: the class must sit in the same className expression
    // as the flag that gates the rail, so it cannot be left applied unconditionally or dropped.
    const className = appRouter.match(/className=\{cn\((?:[^{}]|\{[^{}]*\})*\)\}/)?.[0] ?? "";
    expect(className, "the shell's root className expression").toContain("app--railed");
    expect(className).toContain("railed &&");
  });
});

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

/**
 * The rail's height and stickiness — added after a live Chrome pass, not after a test failure.
 *
 * Measured on the running build: the rail computed `position: static`, `height: 343px` on a 900px
 * viewport, and at `scrollY: 1200` its top was at `-1200` — the whole navigation scrolled off a
 * 7447px Dashboard, leaving an empty 250px gutter. The Topbar it replaces is
 * `position: sticky; top: 0` and never leaves, so this was a straight regression against the
 * shipped chrome.
 *
 * Neither the two DOM tests nor the first two browser passes caught it: every one of them measured
 * at `scrollY: 0`, where the top of the rail looks correct. These assertions exist so that the
 * height and the stickiness cannot be lost again silently.
 */
describe("the rail is full-height and stays put", () => {
  const railBody = ruleBody(appCss, ".app--railed > .app__rail") ?? "";

  it("declares the rule at all", () => {
    expect(
      ruleBody(appCss, ".app--railed > .app__rail"),
      ".app--railed > .app__rail must exist as a real rule in app.css",
    ).not.toBeNull();
  });

  it("sticks to the top of the viewport", () => {
    // `position: sticky` with the initial `top: auto` never sticks, so the offset is as
    // load-bearing as the position and both are pinned here.
    expect(railBody).toMatch(/position:\s*sticky/);
    expect(railBody).toMatch(/top:\s*0/);
  });

  it("takes the full viewport height in dynamic viewport units", () => {
    // `dvh`, not `vh`: mobile browser chrome would otherwise clip the identity/sign-out footer.
    expect(railBody).toMatch(/height:\s*100dvh/);
    expect(railBody, "vh would be clipped by mobile browser chrome").not.toMatch(/height:\s*100vh/);
  });

  it("opts out of the container's stretch so there is room to stick", () => {
    // `.app--railed` sets `align-items: stretch`, which sizes the rail to the whole DOCUMENT. A
    // sticky item stretched to its container's height has nothing to stick within — this is the
    // declaration that makes the other two work, and the easiest one to delete as redundant.
    expect(railBody).toMatch(/align-self:\s*start/);
  });

  it("does not rely on the primitive's h-full, which resolves to auto here", () => {
    // `h-full` is `height: 100%` against `.app`, which has `min-height: 100vh` and no `height`,
    // so it computed to `auto` and produced the 343px stub. The authored height is what fixes it;
    // this pins that the fix lives in CSS rather than in a utility that would silently collapse.
    expect(appCss).toMatch(/\.app--railed > \.app__rail\s*\{[^}]*height:/);
  });

  it("clears the impersonation banner instead of sitting under it", () => {
    // Mirrors `.app--impersonating .topbar { top: 42px }`. Without this the banner overlaps the
    // wordmark and the rail runs 42px past the bottom of the viewport.
    const impersonating = ruleBody(appCss, ".app--impersonating.app--railed > .app__rail");
    expect(impersonating, "the railed shell must offset the rail under impersonation").not.toBeNull();
    expect(impersonating).toMatch(/top:\s*42px/);
    expect(impersonating).toMatch(/height:\s*calc\(100dvh - 42px\)/);
  });

  it("declares both rules outside any @layer", () => {
    for (const selector of [".app--railed > .app__rail ", ".app--impersonating.app--railed"]) {
      const index = appCss.indexOf(selector);
      expect(index, `${selector} not found`).toBeGreaterThan(-1);
      const before = appCss.slice(0, index);
      const opened = (before.match(/@layer[^;{]*\{/g) ?? []).length;
      const closed = (before.match(/\}/g) ?? []).length;
      expect(opened, `${selector} sits inside an @layer block`).toBeLessThanOrEqual(closed);
    }
  });
});
