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

/**
 * #122 (ADR 0005): `.app--railed`'s one in-flow child is now `SidebarProvider`'s wrapper
 * (`RailedShell.tsx`), which is where `min-w-0` moved once app.css stopped splitting
 * `.app--railed`'s children itself — see the "no longer splits" test below.
 */
const railedShell = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "components", "quincy", "RailedShell.tsx"),
  "utf8",
);

/**
 * Sol review (#122 P1): base-nova's `SidebarMenuButton`/`SidebarMenuSubButton` map `isActive`
 * through Base UI's own `state`, which renders a VALUELESS `data-active=""` when true and OMITS
 * the attribute when false — never the string `"true"`/`"false"` #111's trimmed primitive used to
 * write. `data-[active=true]:` (an exact-value Tailwind arbitrary variant) never matches that real
 * output, so the active row's paint silently fell through to base-nova's own
 * `data-active:bg-sidebar-accent` — a happy-dom DOM test cannot see this (it does not compute
 * Tailwind), so this reads the component SOURCE instead, the same way the rest of this file reads
 * `app.css`/`app-router.tsx`/`RailedShell.tsx`.
 */
const navigationRail = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "components", "quincy", "NavigationRail.tsx"),
  "utf8",
);

function stripJsCommentsForRail(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const strippedNavigationRail = stripJsCommentsForRail(navigationRail);

/**
 * `/code-review` (#122 P1): `quincy/menu.tsx`'s `TRIGGER` reset class hardcodes `border-0` (and
 * `bg-transparent`, `justify-center`, …) for the DEFAULT `<button>` trigger. When a caller supplies
 * `triggerRender` instead — `NavigationRail`'s collapsed parents pass a whole `SidebarMenuButton`
 * — Base UI concatenates `className={cn(TRIGGER, triggerClassName)}` onto THAT element, so
 * `TRIGGER`'s `border-0` competes with `ROW_PAINT`'s own `border`/`data-active:border-…` (the
 * active hairline on a collapsed Dashboard trigger can vanish). `TRIGGER` is a reset for the
 * primitive's own bare `<button>`; a caller-supplied element owns its own chrome and needs none of
 * it. A happy-dom DOM test cannot see a class-string collision like this (and
 * `testing/test-seam.guard.test.ts` guard C forbids asserting a class is present in a DOM test
 * either way), so this reads the component SOURCE instead, the same way the rest of this file does.
 */
const menuSource = stripJsCommentsForRail(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "components", "quincy", "menu.tsx"), "utf8"),
);

describe("Menu's TRIGGER reset class is conditional on triggerRender (#122 code review)", () => {
  const triggerTag = menuSource.match(/<MenuPrimitive\.Trigger[\s\S]*?>/)?.[0] ?? "";

  it("finds the MenuPrimitive.Trigger element to scan", () => {
    expect(triggerTag).not.toBe("");
  });

  it("does not unconditionally apply TRIGGER (and its border-0) to a caller-supplied triggerRender", () => {
    expect(triggerTag).not.toMatch(/className=\{cn\(TRIGGER,\s*triggerClassName\)\}/);
  });

  it("applies TRIGGER only when there is no triggerRender", () => {
    expect(triggerTag).toMatch(/triggerRender\s*\?\s*triggerClassName\s*:\s*cn\(TRIGGER,\s*triggerClassName\)/);
  });
});

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

  it("no longer splits .app--railed's children — the provider wrapper is its only in-flow child now", () => {
    // #122 (ADR 0005): `SidebarProvider`'s own `data-slot="sidebar-wrapper"` is `.app--railed`'s
    // one child now (the Sheet root and `RailSheet`'s popup render no in-flow DOM), so there is no
    // rail/content split left for app.css to author. `min-w-0` moved to the provider itself, so a
    // wide table still cannot push it past the viewport.
    expect(appCss).not.toMatch(/\.app--railed\s*>\s*/);
    const providerTag = railedShell.match(/<SidebarProvider[\s\S]*?>/)?.[0] ?? "";
    expect(providerTag, "RailedShell must render <SidebarProvider>").toBeTruthy();
    expect(providerTag).toContain('className="app__shell min-w-0"');
  });

  it("does not reuse the .rail class, which ProjectOverviewRail already owns", () => {
    expect(ruleBody(appCss, ".app--rail")).toBeNull();
    expect(appCss).toContain(".app--impersonating .rail");
  });
});

describe("the rail's active-row paint matches base-nova's boolean-presence data-active (#122 Sol review)", () => {
  it("never selects on data-[active=true], which the primitive's real output cannot match", () => {
    expect(strippedNavigationRail).not.toMatch(/data-\[active=true\]/);
  });

  it("selects on the presence-based data-active: variant instead", () => {
    expect(strippedNavigationRail).toMatch(/data-active:/);
  });
});

/**
 * Luna fix (#122 P1, live Chrome pass): the rail's rows render as `InternalLink` — real `<a>`
 * elements — and `styles/tokens/base.css:21`'s `a { color: inherit }` is imported UNLAYERED
 * (`index.css`), so it beats every LAYERED Tailwind `text-*` utility on an anchor regardless of
 * specificity — a third door on the same unlayered-cascade trap `docs/lessons.md:1181-1219`
 * already names two of (an outline shorthand, then a focus ring). Measured: an inactive row
 * computed `--text-primary` (inherited from the sidebar's own `--sidebar-foreground`) instead of
 * `--text-secondary`. The fix is the same one that trap already prescribes — the `!` important
 * modifier — not moving `base.css` into a layer (cross-cutting, out of scope here).
 */
describe("ROW_PAINT's text colour survives the unlayered `a { color: inherit }` cascade (Luna fix)", () => {
  const rowPaint = strippedNavigationRail.match(/const ROW_PAINT = cn\(([\s\S]*?)\n\);/)?.[1] ?? "";

  it("finds the ROW_PAINT declaration to scan", () => {
    expect(rowPaint).not.toBe("");
  });

  it("uses the important modifier on all three text colour utilities", () => {
    expect(rowPaint).toContain("!text-[color:var(--text-secondary)]");
    expect(rowPaint).toContain("hover:!text-[color:var(--text-primary)]");
    expect(rowPaint).toContain("data-active:!text-[color:var(--text-primary)]");
  });

  it("leaves no non-important text-[color:var(--text- utility behind", () => {
    // A negative lookbehind for `!` immediately before `text-[color:var(--text-` — every match
    // that survives is a colour utility an unlayered `a { color: inherit }` would still beat.
    expect(rowPaint).not.toMatch(/(?<!!)text-\[color:var\(--text-/);
  });
});

/**
 * The rail's impersonation offset — #122 (ADR 0005).
 *
 * base-nova's `Sidebar` now owns positioning and full-height sizing itself (`sidebar-container` is
 * `fixed inset-y-0 h-svh`), so app.css no longer authors a sticky/height/z-index rule for the rail
 * at all — the P1 build deleted `.app--railed > .app__rail` and its z-76 flyout-clearing rule along
 * with it (the collapsed menu is now a portalled `quincy/menu.tsx` popup at `--z-popover`, not an
 * inline flyout that needed the rail's own stacking context raised above the header). The one thing
 * left for this file to own is the impersonation-banner offset, which the vendored primitive cannot
 * know about — mirroring `.app--impersonating .topbar { top: 42px }`.
 */
describe("the rail's impersonation offset (#122)", () => {
  it("declares the rule at all", () => {
    expect(
      ruleBody(appCss, ".app--impersonating .app__rail"),
      ".app--impersonating .app__rail must exist as a real rule in app.css",
    ).not.toBeNull();
  });

  it("offsets 42px under impersonation, with a matching 42px-reduced height", () => {
    const body = ruleBody(appCss, ".app--impersonating .app__rail") ?? "";
    expect(body).toMatch(/top:\s*42px/);
    expect(body).toMatch(/height:\s*calc\(100dvh - 42px\)/);
  });

  it("declares the rule outside any @layer", () => {
    const selector = ".app--impersonating .app__rail ";
    const index = appCss.indexOf(selector);
    expect(index, `${selector} not found`).toBeGreaterThan(-1);
    const before = appCss.slice(0, index);
    const opened = (before.match(/@layer[^;{]*\{/g) ?? []).length;
    const closed = (before.match(/\}/g) ?? []).length;
    expect(opened, `${selector} sits inside an @layer block`).toBeLessThanOrEqual(closed);
  });

  // Sol review (#122 P1): `SidebarProvider`'s own `min-h-svh` (`reui/sidebar.tsx`'s
  // `data-slot="sidebar-wrapper"`) is a MINIMUM, and `.app--impersonating`'s `padding-top: 42px`
  // on `.app` adds to it rather than sharing it, so a short impersonated page renders 42px taller
  // than the viewport. `app__shell` is the class `RailedShell.tsx` gives the provider for this.
  it("carries app__shell on the SidebarProvider, for the impersonation min-height fix", () => {
    const providerTag = railedShell.match(/<SidebarProvider[\s\S]*?>/)?.[0] ?? "";
    expect(providerTag).toContain('className="app__shell min-w-0"');
  });

  it("declares .app--impersonating .app__shell with a 42px-reduced min-height", () => {
    const body = ruleBody(appCss, ".app--impersonating .app__shell");
    expect(body, ".app--impersonating .app__shell must exist as a real rule in app.css").not.toBeNull();
    expect(body).toMatch(/min-height:\s*calc\(100svh - 42px\)/);
  });

  it("declares the app__shell impersonation rule outside any @layer", () => {
    const selector = ".app--impersonating .app__shell ";
    const index = appCss.indexOf(selector);
    expect(index, `${selector} not found`).toBeGreaterThan(-1);
    const before = appCss.slice(0, index);
    const opened = (before.match(/@layer[^;{]*\{/g) ?? []).length;
    const closed = (before.match(/\}/g) ?? []).length;
    expect(opened, `${selector} sits inside an @layer block`).toBeLessThanOrEqual(closed);
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
  it("sets 260px expanded, the icon-width calc collapsed, and 0px for the Sheet (#122)", () => {
    expect(ruleBody(appCss, '[data-rail-mode="expanded"]')).toContain("--app-rail-inline-size: 260px");
    expect(ruleBody(appCss, '[data-rail-mode="collapsed"]')).toContain(
      "--app-rail-inline-size: calc(3rem + var(--space-4) + var(--space-2))",
    );
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
