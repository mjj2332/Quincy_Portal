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

/**
 * `--app-rail-inline-size` per `[data-rail-mode]` — #112. `RailedShell` resolves one JS-owned
 * breakpoint (`lib/shell-rail.ts`) into `expanded | collapsed | sheet` and sets it as
 * `data-rail-mode` on the content column; these three rules are the only place that resolved mode
 * turns back into a pixel value, and `styles/shell-breakpoint.guard.test.ts` is what pins that
 * neither rule sits inside an `@media` block of its own.
 */
describe("the rail's inline size follows data-rail-mode (#112)", () => {
  it("sets 250px expanded, 48px collapsed, and 0px for the Sheet", () => {
    expect(ruleBody(appCss, '[data-rail-mode="expanded"]')).toContain("--app-rail-inline-size: 250px");
    expect(ruleBody(appCss, '[data-rail-mode="collapsed"]')).toContain("--app-rail-inline-size: 48px");
    expect(ruleBody(appCss, '[data-rail-mode="sheet"]')).toContain("--app-rail-inline-size: 0px");
  });

  it("declares all three rules outside any @layer", () => {
    for (const selector of ['[data-rail-mode="expanded"]', '[data-rail-mode="collapsed"]', '[data-rail-mode="sheet"]']) {
      const index = appCss.indexOf(selector);
      expect(index, `${selector} not found`).toBeGreaterThan(-1);
      const before = appCss.slice(0, index);
      const opened = (before.match(/@layer[^;{]*\{/g) ?? []).length;
      const closed = (before.match(/\}/g) ?? []).length;
      expect(opened, `${selector} sits inside an @layer block`).toBeLessThanOrEqual(closed);
    }
  });
});

/**
 * `.shell-header` z-index and impersonation offset — #112 review finding. `ShellHeader.tsx`'s
 * `<header>` is `position: sticky; top: 0` with no z-index of its own, so it slides UNDER the
 * impersonation banner (`.app--impersonating` adds `padding-top: 42px` to `.app`, but nothing
 * pushes the header's own sticky offset down to clear it) and under whatever else in the stacking
 * order reaches for a z-index. `.topbar`, the chrome this header replaces under the rail flag, is
 * the precedent this mirrors exactly: `position: sticky; top: 0; z-index: 75` plus
 * `.app--impersonating .topbar { top: 42px }`.
 */
describe("the shell header clears the impersonation banner and carries a z-index (#112)", () => {
  it("declares z-index 75 on .shell-header, same stacking order as .topbar", () => {
    const body = ruleBody(appCss, ".shell-header");
    expect(body, ".shell-header must exist as a real rule in app.css").not.toBeNull();
    expect(body).toMatch(/z-index:\s*75/);
  });

  it("offsets .shell-header under impersonation, same 42px banner offset as .topbar", () => {
    const body = ruleBody(appCss, ".app--impersonating .shell-header");
    expect(body, ".app--impersonating .shell-header must exist as a real rule in app.css").not.toBeNull();
    expect(body).toMatch(/top:\s*42px/);
  });

  it("declares both rules outside any @layer", () => {
    for (const selector of [".shell-header ", ".app--impersonating .shell-header "]) {
      const index = appCss.indexOf(selector);
      expect(index, `${selector} not found`).toBeGreaterThan(-1);
      const before = appCss.slice(0, index);
      const opened = (before.match(/@layer[^;{]*\{/g) ?? []).length;
      const closed = (before.match(/\}/g) ?? []).length;
      expect(opened, `${selector} sits inside an @layer block`).toBeLessThanOrEqual(closed);
    }
  });
});

/**
 * `.app--railed > .app__rail`'s z-index — #112 review finding. `position: sticky` creates a
 * stacking context with z `auto`, which traps the collapsed flyout's `--z-popover` beneath any
 * later-painted, positioned content — `.worktools` (z-index 20) and now `.shell-header` (z-index
 * 75) both sit later in the DOM and both win. The rail needs a z-index ABOVE the header so the
 * flyout clears page content, but still below `--z-popover`/`--z-dialog` so the Sheet — portalled,
 * outside this stacking context entirely — still covers it regardless.
 */
describe("the rail's stacking context clears the header for the collapsed flyout (#112)", () => {
  it("declares z-index 76 on .app--railed > .app__rail, above .shell-header's 75", () => {
    const railBody = ruleBody(appCss, ".app--railed > .app__rail") ?? "";
    expect(railBody).toMatch(/z-index:\s*76/);

    const headerBody = ruleBody(appCss, ".shell-header") ?? "";
    const headerZ = Number(headerBody.match(/z-index:\s*(\d+)/)?.[1]);
    expect(headerZ).toBe(75);
    const railZ = Number(railBody.match(/z-index:\s*(\d+)/)?.[1]);
    expect(railZ).toBeGreaterThan(headerZ);
  });
});

/**
 * `--toast-inset-inline-start` must be REDECLARED by the `[data-rail-mode]` rules, not just read by
 * them — #112 P3b. `tokens/spacing.css` declares it once, on `:root`, as
 * `calc(var(--app-rail-inline-size) + …)`. A custom property's VALUE is substituted at the point it
 * is declared, not re-evaluated wherever it is read, so overriding `--app-rail-inline-size` on the
 * content column (which is what each `[data-rail-mode]` rule below does) never moves a toast whose
 * own `--toast-inset-inline-start` was fixed at `:root`. Each `[data-rail-mode]` rule has to set
 * this variable itself — either three times over, or once in a rule shared by all three selectors —
 * so `ToastViewport` (mounted inside Dashboard/Admin, inside the content column) inherits the
 * moved value.
 */
describe("--toast-inset-inline-start is redeclared per data-rail-mode (#112 P3b)", () => {
  const EXPECTED_VALUE = "calc(var(--app-rail-inline-size) + max(var(--space-5), env(safe-area-inset-left)))";

  it("redeclares the inset in each [data-rail-mode] rule, or in one shared rule after them", () => {
    const perMode = ['[data-rail-mode="expanded"]', '[data-rail-mode="collapsed"]', '[data-rail-mode="sheet"]']
      .map((selector) => ruleBody(appCss, selector) ?? "");
    const perModeRedeclares = perMode.every((body) => body.includes(`--toast-inset-inline-start: ${EXPECTED_VALUE}`));

    const shared = ruleBody(appCss, "[data-rail-mode]") ?? "";
    const sharedRedeclares = shared.includes(`--toast-inset-inline-start: ${EXPECTED_VALUE}`);

    expect(
      perModeRedeclares || sharedRedeclares,
      "either every [data-rail-mode=\"…\"] rule, or a shared [data-rail-mode] rule after them, must redeclare --toast-inset-inline-start",
    ).toBe(true);
  });

  it("declares the shared rule (if any) outside any @layer, after the three per-mode rules", () => {
    const sharedIndex = appCss.indexOf("[data-rail-mode]");
    if (sharedIndex === -1) return; // No shared rule — the per-mode assertion above covers this shape instead.
    const sheetIndex = appCss.indexOf('[data-rail-mode="sheet"]');
    expect(sheetIndex, '[data-rail-mode="sheet"] not found').toBeGreaterThan(-1);
    expect(sharedIndex, "the shared [data-rail-mode] rule must come after the three per-mode rules").toBeGreaterThan(sheetIndex);

    const before = appCss.slice(0, sharedIndex);
    const opened = (before.match(/@layer[^;{]*\{/g) ?? []).length;
    const closed = (before.match(/\}/g) ?? []).length;
    expect(opened, "[data-rail-mode] sits inside an @layer block").toBeLessThanOrEqual(closed);
  });
});
