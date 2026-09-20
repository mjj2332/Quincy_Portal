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
 * #219 PR A fix (dr-219a HIGH #2), additive detector: `outline-none` paired with a
 * `focus-visible:ring-*` class anywhere in a vendored file — `styles/tokens/base.css:25`'s
 * unlayered `:focus-visible { outline }` beats `@layer utilities`, so the pair ADDS a second focus
 * indicator instead of replacing the global one. See that detector's own doc comment, below.
 *
 * #219 PR A fix (dr-219a HIGH #3), additive detector: a bare `border`/`border-b`/`border-t`/…
 * class with no `border-<token>` colour anywhere on the SAME element — Tailwind v4 preflight
 * resets every element to `border: 0 solid currentColor`, and this app ships no
 * `* { border-color: var(--border) }` compat rule, so a bare structural border class paints near-
 * black instead of the greige hairline. See that detector's own doc comment, below.
 *
 * #219 PR A fix (dr-219a MEDIUM #6), additive detector, scoped to exactly two elements (not the
 * whole file): a `destructive` class on the now-line or its dot cap — red already means
 * overdue/critical elsewhere in this app, and the now-line has no causal link to an overdue bar.
 * See that detector's own doc comment, below.
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
  // #219 PR A fix (Sol re-review round 2, LOW): through the real exported detector
  // (`findDarkVariants`), not the raw regex in isolation — and through `stripComments`, the same
  // preprocessing `readVendoredFiles` applies, so a `dark:` mentioned only in a comment (naming the
  // trap, like this file's own header) is proven NOT to false-positive via the actual pipeline, not
  // just by construction of the regex.
  it("self-test: the real detector fires on a planted `dark:` class, not on `backdrop:`, prose, or a comment naming the trap", () => {
    const planted = new Map([
      ["fixture-dark.tsx", stripComments('/* mentions dark: mode only in a comment */ className="dark:bg-slate-900"')],
      ["fixture-clean.tsx", stripComments('className="backdrop:bg-black/50" // the dark stage in TB8-09')],
    ]);
    expect(findDarkVariants(planted)).toEqual(["fixture-dark.tsx"]);
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
  it("self-test: the real detector fires on a planted `shadow-lg`, not on `shadow-none`, a `box-shadow` word, or a comment naming the trap", () => {
    // Sol's own `stripComments` only strips a WHOLE-LINE `//` comment (`^[ \t]*\/\/`), not a
    // trailing one on a code line - the "not shadow-xl" trap-naming comment below is on its OWN
    // line for that reason, matching what the real function actually strips.
    const planted = new Map([["fixture.tsx", stripComments('className="rounded-sm shadow-lg"\n// not shadow-xl, just this comment')]]);
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
// Bracketed Tailwind arbitrary value (`[#fff]`), the SAME bracketed form with an explicit
// Tailwind v4 type hint (`[color:#fff]`, `bg-[background-color:#0a0a0a]`, … — #219 PR A fix, Sol
// re-review round 2, LOW: the original regex required the `#` immediately after `[` and missed
// this form), or a bare quoted hex string (an inline style value, `"#0a0a0a"`) — NOT a bare
// `#219`-style issue reference in prose, which is neither bracketed nor quoted and would otherwise
// false-positive on a 3-hex-digit read of the issue number (comments are stripped before this
// runs, but a code-level reference like a variable named after an issue could still collide with a
// naive `#[0-9a-f]{3,8}` scan).
const HEX_LITERAL = /\[(?:[a-zA-Z-]+:)?#[0-9a-fA-F]{3,8}\]|["'`]#[0-9a-fA-F]{3,8}["'`]/;
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
  // #219 PR A fix (Sol re-review round 2, LOW): through the real exported detector
  // (`findColorLiterals`), including the `bg-[color:#fff]`-style typed arbitrary value the
  // original regex missed (required `#` immediately after `[`), and through `stripComments`.
  it("self-test: the real detector fires on a bracketed hex, a TYPED bracketed hex, a quoted hex, and rgba(); not on an issue reference or a comment naming the trap", () => {
    const planted = new Map([
      ["fixture-hex-bracket.tsx", stripComments('className="bg-[#0a0a0a]"')],
      ["fixture-hex-typed.tsx", stripComments('className="bg-[color:#fff]"')],
      ["fixture-hex-typed-long.tsx", stripComments('className="bg-[background-color:#0a0a0a]"')],
      ["fixture-hex-quoted.tsx", stripComments('style.background = "#0a0a0a"')],
      ["fixture-rgb.tsx", stripComments("color-mix(in oklab, rgba(0,0,0,.4) 20%, transparent)")],
      ["fixture-clean.tsx", stripComments('// bg-[#0a0a0a] mentioned only in a comment, for #219 (PR A, stage 3 of 3), owner decision on #215/#219')],
    ]);
    const found = findColorLiterals(planted);
    expect(found).toEqual({
      "fixture-hex-bracket.tsx": ["hex"],
      "fixture-hex-typed.tsx": ["hex"],
      "fixture-hex-typed-long.tsx": ["hex"],
      "fixture-hex-quoted.tsx": ["hex"],
      "fixture-rgb.tsx": ["rgb()"],
    });
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
  // #219 PR A fix (Sol re-review round 2, LOW): through the real exported detector
  // (`findNonTokenPalette`) and `stripComments`, not the raw regex in isolation.
  it("self-test: the real detector fires on a scaled palette class and on bare black/white paint, not on a Quincy role, a CSS custom-property value, or a comment naming the trap", () => {
    const planted = new Map([
      ["fixture-slate.tsx", stripComments('className="bg-slate-500"')],
      ["fixture-gray.tsx", stripComments('className="text-gray-400"')],
      ["fixture-black.tsx", stripComments('className="bg-black/40"')],
      ["fixture-white.tsx", stripComments('className="text-white"')],
      // Trap-naming comment on its OWN line - a trailing same-line `//` is NOT what
      // `stripComments` strips (see the shadow self-test above for the same note).
      ["fixture-clean.tsx", stripComments('className="bg-background text-foreground border-border"\n// not bg-slate-500, that is just a comment')],
      ["fixture-var.tsx", stripComments('value: "var(--color-blue-500)"')],
    ]);
    expect(findNonTokenPalette(planted)).toEqual(
      ["fixture-black.tsx", "fixture-gray.tsx", "fixture-slate.tsx", "fixture-white.tsx"].sort()
    );
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
// Detector 5 — `outline-none` paired with a `focus-visible:ring-*` class
// ---------------------------------------------------------------------------
// #219 PR A fix (dr-219a HIGH #2): `styles/tokens/base.css:25` declares an UNLAYERED
// `:focus-visible { outline: … }`, which beats anything in `@layer utilities` (Tailwind's own
// utility classes, including `focus-visible:ring-*`, live in that layer). So `outline-none`
// paired with `focus-visible:ring-*` never REPLACES the global indicator the way it would in an
// app with no such override — it ADDS a second one beside it. `styles/tokens/reui.css:160-166`
// records this exact trap three times already (badge correction 2, button divergence 5, sidebar
// `--sidebar-ring`); this is its fourth appearance, in the Gantt bar and the tree/timeline
// splitter. File-level (not same-className) detection: the splitter's own two classes land in
// SEPARATE string arguments to the same `cn()` call (`outline-none` ends one string, the ring
// classes open the next) — `cn()` concatenates every arg into one class list at runtime, so the
// pairing is real even though the two substrings never share a single string literal.
const OUTLINE_NONE = /(?<![\w-])outline-none\b/;
const FOCUS_VISIBLE_RING = /focus-visible:ring-/;

function findOutlineRingPairs(files: Map<string, string>): string[] {
  const offenders: string[] = [];
  for (const [name, text] of files) {
    if (OUTLINE_NONE.test(text) && FOCUS_VISIBLE_RING.test(text)) offenders.push(name);
  }
  return offenders.sort();
}

describe("guard: no `outline-none` paired with a `focus-visible:ring-*` class", () => {
  it("self-test: the real detector fires when a file has BOTH classes (even in separate string args to the same cn()), not when it has only one, and not on a comment naming the trap", () => {
    const planted = new Map([
      [
        "fixture-same-string.tsx",
        stripComments('className="outline-none focus-visible:ring-2 focus-visible:ring-ring/50"'),
      ],
      [
        "fixture-separate-args.tsx",
        stripComments('cn("relative w-px outline-none", "focus-visible:ring-ring/50 focus-visible:ring-2")'),
      ],
      ["fixture-outline-only.tsx", stripComments('className="rounded-sm outline-none"')],
      ["fixture-ring-only.tsx", stripComments('className="focus-visible:ring-2 focus-visible:ring-ring/50"')],
      [
        "fixture-clean.tsx",
        stripComments(
          '// outline-none and focus-visible:ring-2 mentioned only in this comment\nclassName="rounded-sm"'
        ),
      ],
    ]);
    expect(findOutlineRingPairs(planted)).toEqual(["fixture-same-string.tsx", "fixture-separate-args.tsx"].sort());
  });

  it("has no `outline-none` / `focus-visible:ring-*` pairing in the nine vendored files", () => {
    const offenders = findOutlineRingPairs(readVendoredFiles());
    expect(offenders, [
      "outline-none paired with focus-visible:ring-* adds a SECOND focus indicator instead of",
      "replacing the global one - styles/tokens/base.css:25's unlayered `:focus-visible { outline }`",
      "already beats @layer utilities. Drop both classes and let the global outline stand, as",
      "components/reui/button.tsx does. Found in:",
      ...offenders.map((name) => `  ${name}`),
    ].join("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Detector 6 — a bare `border`/`border-x`/`border-t`-style class with no
// accompanying `border-<token>` class on the SAME element
// ---------------------------------------------------------------------------
// #219 PR A fix (dr-219a HIGH #3): Tailwind v4 preflight resets every element to `border: 0 solid`
// (`currentColor`, never touched by `border-width`/`border-style` utilities alone) — this app ships
// no `* { border-color: var(--border) }` compat rule, so a bare `border`/`border-b`/`border-t`/…
// class paints near-black ink (measured greyscale 16-24) instead of the greige hairline the grid
// lines around it draw from `var(--color-border)` (189-196). `grep -c border-border
// gantt-view.tsx` returned 0 at review time.
//
// Scope is per ELEMENT, not per file or per string: a bare `border-b` in one `cn()` call is not
// excused by an unrelated `border-primary` on a completely different element elsewhere in the
// file (unlike Detector 5 above, which is deliberately file-level for a different reason — see
// that detector's own header). "Element" here means one `cn(…)` call's full balanced-paren body
// (so a colour on a LATER string argument to the same `cn()`, or on a later branch of an
// exhaustive ternary/`&&` chain within it, still counts — `gantt-view.tsx`'s tree/timeline
// scrollbar rail splits `border-t` and `border-t-border` across two string args to ONE `cn()`,
// same as Detector 5's splitter case), or one bare `className="…"` string literal on its own.
//
// A bare `border-0` needs no colour (zero width paints nothing regardless of colour) and is
// excluded. A colour is anything `border(-side)?-` followed by a real token/value: a 2+ letter
// name (`primary`, `destructive`, `border`, `transparent`, …), a parenthesised CSS custom
// property (`border-(--gantt-event-color)`), or a bracketed arbitrary value. Explicitly NOT a
// colour: a single-letter SIDE code standing alone (`border-b` must not satisfy its own check —
// "b" is not a colour), or a `border-style` keyword (`dashed`/`solid`/`dotted`/`double`/`hidden`/
// `none` describe the LINE, not its paint).
const BARE_BORDER = /(?<![\w.-])border(-[xytrbsle])?(-\d+)?\b(?!-)/g;
const BORDER_STYLE_WORDS = "solid|dashed|dotted|double|hidden|none";
const BORDER_COLOR = new RegExp(
  `(?<![\\w.-])border(-[xytrbsle])?-(?:(?!(?:${BORDER_STYLE_WORDS})\\b)[a-z]{2,}|\\(--[\\w-]+\\)|\\[[^\\]]+\\])`
);

/** Extracts one "element's" worth of class text per unit: every `className="…"` literal's
 * string content, and every `cn(…)` call's full balanced-paren body (handles nested parens from
 * arbitrary values like `border-(--gantt-event-color)` inside the call — they net to zero, so a
 * naive depth counter still lands on the real closing paren). */
function extractClassChunks(text: string): string[] {
  const chunks: string[] = [];
  const literalRe = /className="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = literalRe.exec(text))) chunks.push(m[1] ?? "");
  const cnStart = /\bcn\(/g;
  while ((m = cnStart.exec(text))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      i++;
    }
    chunks.push(text.slice(start, i - 1));
  }
  return chunks;
}

function findBareBorderClasses(files: Map<string, string>): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const [name, text] of files) {
    const offenders: string[] = [];
    for (const chunk of extractClassChunks(text)) {
      const bare = [...chunk.matchAll(BARE_BORDER)].map((mm) => mm[0]).filter((tok) => !/-0$/.test(tok));
      if (bare.length > 0 && !BORDER_COLOR.test(chunk)) offenders.push(...bare);
    }
    if (offenders.length > 0) found[name] = offenders;
  }
  return found;
}

describe("guard: no bare `border`-style class without an accompanying `border-<token>` on the same element", () => {
  it("self-test: the real detector fires on a bare border/border-b/border-t with no colour on the SAME element (same className, or a later cn() arg/branch), not when a colour, border-0, a style keyword, or an unrelated element's colour is present, and not on a comment naming the trap", () => {
    const planted = new Map([
      ["fixture-bare-literal.tsx", stripComments('className="flex h-8 border-b"')],
      // NOT an offender: the colour lands on a LATER string argument to the SAME cn() call - the
      // real `gantt-view.tsx` tree/timeline scrollbar rail does exactly this (border-t in one
      // string, border-t-border in the next), same "same element, later arg" rule as Detector 5's
      // splitter case.
      [
        "fixture-bare-paired-in-later-cn-arg.tsx",
        stripComments('cn("h-4 border-t", condition && "bg-background border-t-border")'),
      ],
      [
        "fixture-bare-exhaustive-branch.tsx",
        stripComments('cn("border border-dashed", valid ? "border-(--gantt-event-color)/50" : "border-destructive")'),
      ],
      ["fixture-colored-literal.tsx", stripComments('className="border border-(--gantt-event-color)/60"')],
      ["fixture-primary-paired.tsx", stripComments('className="border-primary border-2"')],
      ["fixture-transparent-named.tsx", stripComments('className="border-b border-b-transparent"')],
      ["fixture-zero-width.tsx", stripComments('className="rounded-none border-0 bg-transparent"')],
      [
        "fixture-style-keyword-not-a-colour.tsx",
        stripComments('cn("border border-dashed")'),
      ],
      [
        "fixture-unrelated-element-does-not-excuse-it.tsx",
        stripComments(
          'function A() { return <div className="border-b" /> }\nfunction B() { return <div className="border-primary" /> }'
        ),
      ],
      [
        "fixture-clean.tsx",
        stripComments('// a bare border-b class mentioned only in this comment\nclassName="rounded-sm"'),
      ],
    ]);
    expect(findBareBorderClasses(planted)).toEqual({
      "fixture-bare-literal.tsx": ["border-b"],
      "fixture-style-keyword-not-a-colour.tsx": ["border"],
      "fixture-unrelated-element-does-not-excuse-it.tsx": ["border-b"],
    });
  });

  it("has no bare border class without an accompanying colour token in the nine vendored files", () => {
    const found = findBareBorderClasses(readVendoredFiles());
    const offenders = Object.entries(found).map(
      ([name, classes]) => `  ${name}: ${classes.join(", ")}`
    );
    expect(offenders, [
      "A bare border/border-<side> class paints Tailwind v4 preflight's default `currentColor`",
      "(near-black) instead of the greige hairline (styles/tokens/colors.css's --border, drawn at",
      "189-196 greyscale by the grid lines around it). Give it an explicit border-<token>",
      "(border-border, or a deliberately different token, named) on the SAME element. Found in:",
      ...offenders,
    ].join("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Detector 7 — a `destructive` token on the today/now-line elements
// ---------------------------------------------------------------------------
// #219 PR A fix (dr-219a MEDIUM #6): the now-line (`GanttNowLine`, `data-slot="gantt-now-
// indicator"`) and its dot cap (`GanttNowDot`, `data-slot="gantt-now-dot"`) used to borrow
// `--signal-critical` (`destructive`/`bg-destructive`) - in this palette red already means
// overdue/critical (an overdue bar's own `data-past` styling, the drag ghost's `!valid` state, the
// row-reorder caret's invalid drop), and an overdue bar can sit rows away from the now-line with no
// causal link between the two. Scoped to exactly those two elements, NOT the whole file -
// `destructive` is legitimate everywhere else in this file (the drag ghost's invalid state, the
// reorder caret's invalid state, the invalid-drop-target backdrop), so a file-wide "no destructive"
// rule would be both wrong and immediately red on real, correct code. `data-today`'s own tinted
// column (`bg-primary/5`, the header's today pill) is a DIFFERENT element and untouched either way
// - this detector does not reach it.
const NOW_LINE_ELEMENT =
  /<(?:div|span)\b[^>]*\bdata-slot="gantt-now-(?:indicator|dot)"[^>]*\/>/g;
const DESTRUCTIVE_TOKEN = /\bdestructive\b/;

function findDestructiveOnNowLine(files: Map<string, string>): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const [name, text] of files) {
    const offenders: string[] = [];
    for (const match of text.matchAll(NOW_LINE_ELEMENT)) {
      if (DESTRUCTIVE_TOKEN.test(match[0])) {
        const slot = /data-slot="(gantt-now-(?:indicator|dot))"/.exec(match[0])?.[1] ?? "?";
        offenders.push(slot);
      }
    }
    if (offenders.length > 0) found[name] = offenders;
  }
  return found;
}

describe("guard: no `destructive` token on the today/now-line elements", () => {
  it("self-test: fires on gantt-now-indicator/gantt-now-dot carrying a destructive class, not on an unrelated element's destructive class or a comment naming the trap", () => {
    const planted = new Map([
      [
        "fixture-now-indicator-destructive.tsx",
        stripComments(
          '<div data-slot="gantt-now-indicator" className="from-destructive/80 via-destructive/45 to-destructive/15 absolute inset-y-0 z-10 w-px bg-linear-to-b" style={{ insetInlineStart: `${fraction * 100}%` }} />'
        ),
      ],
      [
        "fixture-now-dot-destructive.tsx",
        stripComments(
          '<span aria-hidden data-slot="gantt-now-dot" className="bg-destructive absolute -bottom-0.75 z-10 size-1.5 -translate-x-1/2 rounded-full" style={{ insetInlineStart: `${fraction * 100}%` }} />'
        ),
      ],
      [
        "fixture-now-indicator-clean.tsx",
        stripComments(
          '<div data-slot="gantt-now-indicator" className="from-border-strong/80 via-border-strong/45 to-border-strong/15 absolute inset-y-0 z-10 w-px bg-linear-to-b" />'
        ),
      ],
      [
        "fixture-unrelated-destructive-not-flagged.tsx",
        stripComments(
          '<div data-slot="gantt-drag-ghost" className="border-destructive bg-destructive/10 text-destructive" />'
        ),
      ],
      [
        "fixture-clean-comment.tsx",
        stripComments(
          "// the now-line used to be bg-destructive here, fixed\n" +
            '<div data-slot="gantt-now-indicator" className="bg-border-strong" />'
        ),
      ],
    ]);
    expect(findDestructiveOnNowLine(planted)).toEqual({
      "fixture-now-indicator-destructive.tsx": ["gantt-now-indicator"],
      "fixture-now-dot-destructive.tsx": ["gantt-now-dot"],
    });
  });

  it("has no destructive token on gantt-now-indicator or gantt-now-dot in the nine vendored files", () => {
    const found = findDestructiveOnNowLine(readVendoredFiles());
    const offenders = Object.entries(found).map(([name, slots]) => `  ${name}: ${slots.join(", ")}`);
    expect(offenders, [
      "The now-line/now-dot must not borrow --signal-critical (destructive) - red already means",
      "overdue/critical elsewhere in this app, and the now-line has no causal link to an overdue",
      "bar. Use border-strong/ink instead. Found on:",
      ...offenders,
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
