/**
 * Gantt re-skin guard (#219, stage 3 of PR A).
 *
 * Reads the nine vendored Gantt files as TEXT (not JSX test files — see the module list below,
 * which deliberately excludes the `.test.ts`/`.dom.test.tsx` siblings in this directory) and fails
 * on the four things `docs/reui-block-adoption.md` and the re-skin step predict an agent will
 * reintroduce the moment this tree is touched again: a `dark:` variant (the Portal has no Tailwind
 * dark mode — inversion is `styles/tokens/inverse.css`'s `[data-surface="inverse"]` scope, a
 * different mechanism entirely), a `shadow-(xs|sm|md|lg|xl)` class outside the documented allowlist
 * (the Portal's own elevation convention is "almost no drop shadow", `styles/tokens/spacing.css`),
 * a hex or `rgb()`/`rgba()` colour literal, and a non-Quincy Tailwind palette class (`bg-slate-500`,
 * `text-gray-400`, a bare `bg-black`/`text-white` used as paint, …) — the brand is monochrome
 * (`styles/tokens/colors.css`) and every colour a Gantt surface needs already has a semantic role
 * (`bg-background`, `text-foreground`, `border-border`, the inline `--gantt-event-color`, …).
 *
 * Each detector is a pure function over injected text, self-tested against a planted fixture that
 * PLANTS the violation it looks for — same convention as `harness-reachability.guard.test.ts` and
 * `styles/design-system-guards.test.ts` (`docs/lessons.md`: "a grep gate that cannot fail is not a
 * gate"). Comments are stripped first so a comment naming the trap (like this file's own docblock)
 * is never mistaken for an instance of it.
 *
 * The shadow allowlist is empty and must stay empty: every `shadow-*` class this tree shipped with
 * (the move-clone's two shapes in `gantt-dnd.tsx`, the floating zoom control and the offscreen edge
 * chip in `gantt-view.tsx`) was removed in the #219 stage 3 re-skin commit in favour of the hairline
 * each of those surfaces already carries (a `border` class, or an inline `border`/`outline` style).
 * A `shadow-*` class shipping through `TooltipContent`/`PopoverContent`/`ContextMenuContent` (the
 * Portal's own already-reskinned overlay primitives, `components/reui/tooltip.tsx` /
 * `popover.tsx` / `context-menu.tsx`) is out of scope for this guard — it scans only the nine files
 * below, and none of those three own a shadow class inline; they inherit it from the primitive.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ganttDir = dirname(fileURLToPath(import.meta.url));

/** The nine vendored files, verbatim per #219 stage 1's header comment — no test siblings. */
const VENDORED_FILES = [
  "gantt.tsx",
  "gantt-bar.tsx",
  "gantt-dnd.tsx",
  "gantt-i18n.tsx",
  "gantt-lib.tsx",
  "gantt-nav.tsx",
  "gantt-recurrence.tsx",
  "gantt-types.tsx",
  "gantt-view.tsx",
];

/**
 * Allowlisted `shadow-*` classes, by file. Empty, and must stay empty — see this file's header.
 * Shrink or delete entries here rather than add to them; do not use this to make a build pass.
 */
const SHADOW_ALLOWLIST: Record<string, string[]> = {};

/** Blanks `/* … *\/` and `// …` comment bodies so a comment naming a trap is never flagged. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function readVendoredFiles(): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of VENDORED_FILES) out.set(name, stripComments(readFileSync(join(ganttDir, name), "utf8")));
  return out;
}

// ---------------------------------------------------------------------------
// Detector 1 — a `dark:` variant
// ---------------------------------------------------------------------------
const DARK_VARIANT = /(?<![\w-])dark:/;

function findDarkVariants(files: Map<string, string>): string[] {
  const offenders: string[] = [];
  for (const [name, text] of files) if (DARK_VARIANT.test(text)) offenders.push(name);
  return offenders.sort();
}

describe("guard: no `dark:` variant", () => {
  it("self-test: fires on a planted `dark:` class, not on `backdrop:` or prose", () => {
    expect(DARK_VARIANT.test('className="dark:bg-slate-900"')).toBe(true);
    expect(DARK_VARIANT.test('className="backdrop:bg-black/50"')).toBe(false);
    expect(DARK_VARIANT.test("// the dark stage in TB8-09")).toBe(false);
  });

  it("has no `dark:` variant in the nine vendored files", () => {
    const offenders = findDarkVariants(readVendoredFiles());
    expect(offenders, [
      "The Portal has no Tailwind dark mode (`styles/tokens/reui.css` rebinds `dark` to `.dark *`,",
      "which nothing in this app sets). Inversion is `styles/tokens/inverse.css`'s",
      "[data-surface=\"inverse\"] scope — a different mechanism. Delete the `dark:` class(es) in:",
      ...offenders.map((name) => `  ${name}`),
    ].join("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Detector 2 — a `shadow-(xs|sm|md|lg|xl)` class outside the allowlist
// ---------------------------------------------------------------------------
const SHADOW_CLASS = /\bshadow-(?:xs|sm|md|lg|xl)\b/g;

function findShadowClasses(files: Map<string, string>): Record<string, number> {
  const found: Record<string, number> = {};
  for (const [name, text] of files) {
    const count = (text.match(SHADOW_CLASS) ?? []).length;
    if (count > 0) found[name] = count;
  }
  return found;
}

describe("guard: no `shadow-(xs|sm|md|lg|xl)` class outside the allowlist", () => {
  it("self-test: fires on a planted `shadow-lg`, not on `shadow-none` or a `box-shadow` word", () => {
    const planted = new Map([["fixture.tsx", stripComments('className="rounded-sm shadow-lg"')]]);
    expect(findShadowClasses(planted)).toEqual({ "fixture.tsx": 1 });
    expect(findShadowClasses(new Map([["f.tsx", 'className="shadow-none"']]))).toEqual({});
    expect(findShadowClasses(new Map([["f.tsx", "// no box-shadow needed here"]]))).toEqual({});
  });

  it("has no shadow class beyond the (empty) allowlist", () => {
    const found = findShadowClasses(readVendoredFiles());
    const over = Object.entries(found)
      .filter(([name, count]) => count > (SHADOW_ALLOWLIST[name]?.length ?? 0))
      .map(([name, count]) => `  ${name}: ${count} (allowlist ${SHADOW_ALLOWLIST[name]?.length ?? 0})`);
    expect(over, [
      "A shadow-(xs|sm|md|lg|xl) class survives outside SHADOW_ALLOWLIST. The Portal's elevation",
      "convention is hairline borders, not drop shadow (styles/tokens/spacing.css). Remove the",
      "class in favour of a `border`/`border-border`, or document the exception in the allowlist",
      "with a reason (see this file's header for why the allowlist is empty today).",
      ...over,
    ].join("\n")).toEqual([]);
  });

  it("keeps the allowlist honest — it stays empty", () => {
    expect(SHADOW_ALLOWLIST, "SHADOW_ALLOWLIST grew. Shrink it back — see this file's header.").toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Detector 3 — a hex or rgb()/rgba() colour literal
// ---------------------------------------------------------------------------
// Bracketed Tailwind arbitrary value (`[#fff]`) or a bare quoted hex string (an inline style
// value, `"#0a0a0a"`) — NOT a bare `#219`-style issue reference in prose, which is neither
// bracketed nor quoted and would otherwise false-positive on a 3-hex-digit read of the issue
// number (comments are stripped before this runs, but a code-level reference like a variable
// named after an issue could still collide with a naive `#[0-9a-f]{3,8}` scan).
const HEX_LITERAL = /\[#[0-9a-fA-F]{3,8}\]|["'`]#[0-9a-fA-F]{3,8}["'`]/;
const RGB_LITERAL = /\brgba?\(/;

function findColorLiterals(files: Map<string, string>): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const [name, text] of files) {
    const hits: string[] = [];
    if (HEX_LITERAL.test(text)) hits.push("hex");
    if (RGB_LITERAL.test(text)) hits.push("rgb()");
    if (hits.length > 0) found[name] = hits;
  }
  return found;
}

describe("guard: no hex or rgb()/rgba() colour literal", () => {
  it("self-test: fires on a bracketed and a quoted hex, and on rgba(); not on an issue reference", () => {
    expect(HEX_LITERAL.test('className="bg-[#0a0a0a]"')).toBe(true);
    expect(HEX_LITERAL.test('style.background = "#0a0a0a"')).toBe(true);
    expect(HEX_LITERAL.test("for #219 (PR A, stage 3 of 3)")).toBe(false);
    expect(RGB_LITERAL.test('color-mix(in oklab, rgba(0,0,0,.4) 20%, transparent)')).toBe(true);
    expect(RGB_LITERAL.test("owner decision on #215/#219")).toBe(false);
  });

  it("has no hex or rgb()/rgba() literal in the nine vendored files", () => {
    const found = findColorLiterals(readVendoredFiles());
    const offenders = Object.entries(found).map(([name, hits]) => `  ${name}: ${hits.join(", ")}`);
    expect(offenders, [
      "A literal colour survives instead of a semantic token. Every colour a Gantt surface needs",
      "already has a role (bg-background, text-foreground, border-border, the inline",
      "--gantt-event-color, …) — see styles/tokens/colors.css and tokens/tailwind.css.",
      ...offenders,
    ].join("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Detector 4 — a non-Quincy Tailwind palette class (incl. black/white used as paint)
// ---------------------------------------------------------------------------
const PALETTE_NAMES =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const PALETTE_PREFIXES = "bg|text|border|ring|from|via|to|fill|stroke|outline|accent|caret|divide|shadow|decoration";
// Scaled palette utility (`bg-slate-500`) or a bare black/white paint utility (`bg-black`,
// `text-white`) — NOT `bg-background`/`text-white-space-…`-shaped tokens, which this prefix/suffix
// pairing cannot produce, and NOT `var(--color-blue-500)` (a CSS custom-property VALUE, not a
// Tailwind class), which is how `gantt-bar.tsx`'s unused, unrendered `GANTT_COLORS` preset array
// spells its ten Tailwind-core swatches — data for a colour-picker UI nothing here renders, not a
// class on any element, so it is deliberately out of this detector's reach.
const NON_TOKEN_PALETTE = new RegExp(`\\b(?:${PALETTE_PREFIXES})-(?:(?:${PALETTE_NAMES})-\\d{2,3}|black|white)\\b`);

function findNonTokenPalette(files: Map<string, string>): string[] {
  const offenders: string[] = [];
  for (const [name, text] of files) if (NON_TOKEN_PALETTE.test(text)) offenders.push(name);
  return offenders.sort();
}

describe("guard: no non-token Tailwind palette class", () => {
  it("self-test: fires on a scaled palette class and on bare black/white paint, not on a Quincy role", () => {
    expect(NON_TOKEN_PALETTE.test('className="bg-slate-500"')).toBe(true);
    expect(NON_TOKEN_PALETTE.test('className="text-gray-400"')).toBe(true);
    expect(NON_TOKEN_PALETTE.test('className="bg-black/40"')).toBe(true);
    expect(NON_TOKEN_PALETTE.test('className="text-white"')).toBe(true);
    expect(NON_TOKEN_PALETTE.test('className="bg-background text-foreground border-border"')).toBe(false);
    expect(NON_TOKEN_PALETTE.test('value: "var(--color-blue-500)"')).toBe(false);
  });

  it("has no non-token palette class in the nine vendored files", () => {
    const offenders = findNonTokenPalette(readVendoredFiles());
    expect(offenders, [
      "A Tailwind core-palette class (or a bare black/white paint utility) survives instead of a",
      "semantic token. The brand is monochrome (styles/tokens/colors.css) — replace it with the",
      "Quincy role that already covers this ground (bg-background, text-foreground, bg-muted,",
      "border-border, ring-ring, the inline --gantt-event-color, …). Found in:",
      ...offenders.map((name) => `  ${name}`),
    ].join("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sanity — the scan itself reads the real vendored files, not an empty set
// ---------------------------------------------------------------------------
describe("the file scan itself", () => {
  it("reads all nine vendored files with real content", () => {
    const files = readVendoredFiles();
    expect(files.size).toBe(9);
    for (const [name, text] of files) expect(text.length, `${name} read as empty`).toBeGreaterThan(500);
  });
});
