/**
 * Shell breakpoint guard — #112, AC11 ("exactly one collapse breakpoint; no behaviour keys off
 * 1007px").
 *
 * The settled design (see `112-plan-final.md` in the #112 build's scratchpad) is one JS-owned
 * breakpoint, `SHELL_NARROW_QUERY = "(max-width: 771px)"` in `lib/shell-rail.ts`, read through
 * `lib/use-media-query.ts`. The JS result sets `data-rail-mode="expanded|collapsed|sheet"` on the
 * content wrapper, and CSS keys off that attribute with **no `@media` of its own**. 771px is
 * inherited from the Topbar's own fold point; the Topbar's *second* stage at 1007/1008px exists
 * only because its identity block competes for horizontal room, and does not carry over to a rail
 * footer — so neither literal may appear anywhere in the shell, and 771 may appear nowhere BUT
 * `shell-rail.ts`. A Tailwind responsive variant (`sm:`/`md:`/`lg:`/`max-[…]`/`min-[…]`) on any of
 * these files would be a second, independent breakpoint hiding beside the JS-owned one.
 *
 * ## The file list, tightened in P3
 *
 * Written in P1 of a three-phase build (see the plan), when only `lib/shell-rail.ts`,
 * `NavigationRail.tsx` and `app.css` existed and `RailedShell.tsx`, `ShellHeader.tsx`,
 * `RailSheet.tsx` and `NotificationBell.tsx` were still P2/P3 work — the list below named all seven
 * up front so a file arriving later than this guard could not arrive uncovered by it, with a
 * skipped-and-counted assertion rather than a silent gap while some of them did not exist yet. All
 * seven now exist, so P3 tightened the floor of 3 to an exact count and file list of 7 (see the P1
 * build report for the reasoning this replaces, and the P3 build report for the tightening itself).
 *
 * Per `docs/lessons.md` — "a grep gate that cannot fail is not a gate" — every detector below is a
 * pure function over injected text, proven against a planted fixture for each rule, alongside the
 * real scan.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const stylesDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(stylesDir, "..");

/**
 * Every file #112 gives the shell, named explicitly rather than discovered by a directory walk —
 * this comment is what names them as the #112 shell files, so a reader hitting this list knows
 * why RailedShell/ShellHeader/RailSheet/NotificationBell are here despite not existing yet.
 */
const SHELL_FILES: readonly { path: string; kind: "script" | "css" }[] = [
  { path: "lib/shell-rail.ts", kind: "script" },
  { path: "components/quincy/NavigationRail.tsx", kind: "script" },
  { path: "components/quincy/RailedShell.tsx", kind: "script" },
  { path: "components/quincy/ShellHeader.tsx", kind: "script" },
  { path: "components/quincy/RailSheet.tsx", kind: "script" },
  { path: "components/quincy/NotificationBell.tsx", kind: "script" },
  { path: "styles/app.css", kind: "css" },
  // #122: base-nova's `sidebar.tsx` now owns the mobile/desktop split itself (patch 2,
  // `docs/adr/0005-…`), and `tooltip.tsx`'s container normalisation ships alongside it — both join
  // the list the P1 build note above already sized for growth.
  { path: "components/reui/sidebar.tsx", kind: "script" },
  { path: "components/reui/tooltip.tsx", kind: "script" },
];

// ---------------------------------------------------------------------------
// Detectors — pure functions over text
// ---------------------------------------------------------------------------

export function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * A numeric literal not itself part of a longer number — `\b` alone will not do here, because a
 * unit suffix like `771px` or `1008px` puts a WORD character (`p`) right after the digits, so
 * `\b1008\b` finds no boundary there and misses the exact "1008px" shape these breakpoints are
 * always spelled as. Excluding a digit on either side (rather than any word character) is what
 * still matches "1008px" while still rejecting "21008" or "10081".
 */
function digitBoundedLiteral(literal: string): RegExp {
  return new RegExp(`(?<!\\d)${literal}(?!\\d)`);
}

/** The Topbar's own second, unrelated stage — must never leak into a #112 shell file. */
export function hasForbiddenTopbarBreakpoint(strippedSource: string): boolean {
  return digitBoundedLiteral("1007").test(strippedSource) || digitBoundedLiteral("1008").test(strippedSource);
}

/** `771` is `shell-rail.ts`'s own literal; every other shell file must reach it through the import. */
export function hasBareNarrowLiteral(strippedSource: string): boolean {
  return digitBoundedLiteral("771").test(strippedSource);
}

const TAILWIND_RESPONSIVE_VARIANT = /\b(?:sm|md|lg):[a-zA-Z0-9[]/;
const ARBITRARY_BREAKPOINT_VARIANT = /\b(?:max|min)-\[/;

/** A second, CSS-owned breakpoint hiding beside the single JS-owned one. */
export function hasTailwindResponsiveVariant(strippedSource: string): boolean {
  return TAILWIND_RESPONSIVE_VARIANT.test(strippedSource) || ARBITRARY_BREAKPOINT_VARIANT.test(strippedSource);
}

const RAILED_SELECTOR = /railed|data-rail-mode/;

/** Every `@media` block's own body, brace-counted so a nested at-rule inside one is not mistaken for its end. */
export function mediaQueryBodiesIn(css: string): string[] {
  const scrubbed = stripCssComments(css);
  const bodies: string[] = [];
  for (const opener of scrubbed.matchAll(/@media[^{]*\{/g)) {
    let depth = 1;
    let index = (opener.index ?? 0) + opener[0].length;
    const start = index;
    while (index < scrubbed.length && depth > 0) {
      const char = scrubbed[index];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      index += 1;
    }
    bodies.push(scrubbed.slice(start, index - 1));
  }
  return bodies;
}

/**
 * True if a rail-shell rule — its selector mentions `railed` or `data-rail-mode` — sits nested
 * inside an `@media` block anywhere in the given CSS. The design is JS-owned breakpoint, CSS keys
 * off the resulting attribute with no `@media` of its own — this is the rule that says so.
 */
export function railedRuleWrappedInMediaQuery(css: string): boolean {
  return mediaQueryBodiesIn(css).some((body) => RAILED_SELECTOR.test(body));
}

// ---------------------------------------------------------------------------
// The real scan
// ---------------------------------------------------------------------------

function readShellFile(entry: (typeof SHELL_FILES)[number]): { path: string; raw: string; stripped: string } | null {
  const fullPath = join(srcDir, entry.path);
  if (!existsSync(fullPath)) return null;
  const raw = readFileSync(fullPath, "utf8");
  return { path: entry.path, raw, stripped: entry.kind === "css" ? stripCssComments(raw) : stripJsComments(raw) };
}

describe("guard: the #112 shell has exactly one collapse breakpoint (AC11)", () => {
  const found = SHELL_FILES.map(readShellFile);
  const existing = found.filter((file): file is NonNullable<typeof file> => file !== null);
  const missingCount = found.length - existing.length;

  it("scans every #112 shell file — tightened in P3 now that all seven exist", () => {
    // A fixed count, not a floor any more: P1 named all seven up front (`lib/shell-rail.ts`,
    // `NavigationRail.tsx` and `app.css` existed then; `RailedShell.tsx`, `ShellHeader.tsx`,
    // `RailSheet.tsx` and `NotificationBell.tsx` have landed since). A floor stops meaning anything
    // once every file it is a floor for has arrived — this is the tightening the P1 report named.
    expect(existing.length).toBe(SHELL_FILES.length);
    expect(existing.map((file) => file.path)).toEqual(SHELL_FILES.map((file) => file.path));
  });

  it("counts, rather than silently drops, any shell file that stops existing", () => {
    // Always 0 today — all seven have landed — but this stays a counted assertion rather than a
    // silent one, so a shell file deleted later shows up here instead of just shrinking `existing`.
    expect(missingCount).toBe(SHELL_FILES.length - existing.length);
    expect(missingCount).toBe(0);
  });

  it("has no 1007 or 1008 in any shell file that exists", () => {
    const offenders = existing
      .filter((file) => hasForbiddenTopbarBreakpoint(file.stripped))
      .map((file) => file.path);
    expect(
      offenders,
      "The Topbar's second, unrelated stage (1007/1008px) must not leak into the #112 shell — one breakpoint, not two.",
    ).toEqual([]);
  });

  it("has no bare 771 outside shell-rail.ts", () => {
    const offenders = existing
      .filter((file) => file.path !== "lib/shell-rail.ts")
      .filter((file) => hasBareNarrowLiteral(file.stripped))
      .map((file) => file.path);
    expect(
      offenders,
      "771 is shell-rail.ts's own literal (SHELL_NARROW_QUERY) — every other shell file must reach it through that export, not its own copy.",
    ).toEqual([]);
  });

  it("has no Tailwind responsive variant (sm:/md:/lg:/max-[/min-[) in any shell script file", () => {
    const offenders = existing
      .filter((file) => file.path !== "styles/app.css")
      .filter((file) => hasTailwindResponsiveVariant(file.stripped))
      .map((file) => file.path);
    expect(
      offenders,
      "A Tailwind responsive variant is a second, CSS-owned breakpoint hiding beside the single JS-owned one (data-rail-mode).",
    ).toEqual([]);
  });

  it("wraps no railed/data-rail-mode rule in app.css inside an @media block", () => {
    const appCss = existing.find((file) => file.path === "styles/app.css");
    expect(appCss, "styles/app.css must exist for this assertion to mean anything").not.toBeNull();
    expect(
      railedRuleWrappedInMediaQuery(appCss!.raw),
      "The rail's CSS keys off [data-rail-mode] with no @media of its own — the mode is resolved once, in JS.",
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Self-test — every detector above, against a planted violation
// ---------------------------------------------------------------------------

describe("guard self-test: the detectors catch a planted violation", () => {
  it("catches a bare 1007", () => {
    expect(hasForbiddenTopbarBreakpoint("const NARROW = 1007;")).toBe(true);
  });

  it("catches a bare 1008", () => {
    expect(hasForbiddenTopbarBreakpoint("(max-width: 1008px)")).toBe(true);
  });

  it("does not fire on an unrelated number", () => {
    expect(hasForbiddenTopbarBreakpoint("const width = 1006;")).toBe(false);
  });

  it("ignores 1007/1008 mentioned only in a comment", () => {
    const source = "// the Topbar's second stage is 1007px and does not carry over here";
    expect(hasForbiddenTopbarBreakpoint(stripJsComments(source))).toBe(false);
  });

  it("catches a bare 771 outside shell-rail.ts", () => {
    expect(hasBareNarrowLiteral('const QUERY = "(max-width: 771px)";')).toBe(true);
  });

  it("catches a Tailwind sm: variant", () => {
    expect(hasTailwindResponsiveVariant('className="flex sm:hidden"')).toBe(true);
  });

  it("catches a Tailwind md: variant", () => {
    expect(hasTailwindResponsiveVariant('className="md:flex"')).toBe(true);
  });

  it("catches a Tailwind lg: variant", () => {
    expect(hasTailwindResponsiveVariant('className="lg:w-64"')).toBe(true);
  });

  it("catches an arbitrary max-[] breakpoint", () => {
    expect(hasTailwindResponsiveVariant('className="max-[771px]:hidden"')).toBe(true);
  });

  it("catches an arbitrary min-[] breakpoint", () => {
    expect(hasTailwindResponsiveVariant('className="min-[772px]:flex"')).toBe(true);
  });

  it("does not fire on an unrelated colon (e.g. an object literal key)", () => {
    expect(hasTailwindResponsiveVariant('const style = { sm: "8px" };')).toBe(false);
  });

  it("finds a railed rule nested inside an @media block", () => {
    const css = `
      @media (max-width: 771px) {
        [data-rail-mode="sheet"] { display: block; }
      }
    `;
    expect(railedRuleWrappedInMediaQuery(css)).toBe(true);
  });

  it("finds an .app--railed rule nested inside an @media block", () => {
    const css = `@media (max-width: 720px) { .app--railed { flex-direction: column; } }`;
    expect(railedRuleWrappedInMediaQuery(css)).toBe(true);
  });

  it("does not fire on an unrelated rule inside an @media block", () => {
    const css = `@media (max-width: 720px) { .topbar { height: 58px; } }`;
    expect(railedRuleWrappedInMediaQuery(css)).toBe(false);
  });

  it("does not fire on a railed rule that sits outside any @media block", () => {
    const css = `.app--railed { flex-direction: row; } @media (max-width: 720px) { .topbar { height: 58px; } }`;
    expect(railedRuleWrappedInMediaQuery(css)).toBe(false);
  });

  it("counts braces correctly with a nested at-rule inside the @media body", () => {
    const css = `
      @media (max-width: 771px) {
        .unrelated { color: red; }
        @supports (display: grid) { .also-unrelated { display: grid; } }
        [data-rail-mode="collapsed"] { width: 48px; }
      }
    `;
    expect(railedRuleWrappedInMediaQuery(css)).toBe(true);
  });
});
