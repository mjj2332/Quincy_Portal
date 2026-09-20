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
 *
 * This guard scans ONLY the nine files below — it says nothing about the other vendored primitives
 * the Gantt renders through (`TooltipContent`, `PopoverContent`, `ContextMenuContent`,
 * `DropdownMenuContent`, `SwitchPrimitive`). That is NOT "checked and found clean" — it is not
 * checked at all, and as of #219 PR A standards review item 4 those files are known to carry the
 * same four classes of violation this guard exists to catch, unfixed:
 *
 *   - `components/reui/context-menu.tsx` — 1 `dark:` variant, 2 `shadow-*` classes (`shadow-md`,
 *     `shadow-lg`).
 *   - `components/reui/dropdown-menu.tsx` — 1 `dark:` variant, 2 `shadow-*` classes (`shadow-md`,
 *     `shadow-lg`), same shape as `context-menu.tsx` (shared origin).
 *   - `components/reui/switch.tsx` — 5 `dark:` variants across its two `className` sites (the
 *     root's `data-[size=…]` block and the thumb).
 *   - `components/reui/dialog.tsx:48` and `components/reui/alert-dialog.tsx:43` — one bare
 *     `bg-black/10` (the overlay scrim) each.
 *
 * Re-skinning them is a separate change, deliberately not folded into this one — see the #219 PR A
 * standards review for the filed count. This paragraph exists so a reader does not mistake this
 * guard's silence on those five files for a clean bill of health.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const ganttDir = dirname(fileURLToPath(import.meta.url));
// components/reui/gantt -> components/reui -> components -> src
const srcDir = join(ganttDir, "..", "..", "..");
const relSrc = (file: string) => relative(srcDir, file).split(sep).join("/");

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
// Tailwind class), which is how `gantt-bar.tsx`'s `GANTT_COLORS` preset array spells its ten
// Tailwind-core swatches — data for a colour-picker UI nothing here renders TODAY, not a class on
// any element, so it is structurally out of this detector's reach. That premise ("unused,
// unrendered") is exactly as durable as the fact that nothing imports `GANTT_COLORS` — see the
// self-limiting detector below, which fails the day a consumer appears, rather than leaving this
// carve-out to silently wave through ten chromatic hues in a monochrome-brand app forever.
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
// Detector 4a — GANTT_COLORS has no non-test consumer (#219 PR A standards review item 5)
// ---------------------------------------------------------------------------
/**
 * Detector 4's own carve-out above exists on the premise that `GANTT_COLORS`
 * (`gantt-bar.tsx`'s ten `var(--color-<hue>-500)` presets) is unused and unrendered — data for a
 * colour-picker UI nothing here renders. That premise expires the moment any non-test file imports
 * it: ten chromatic Tailwind hues in a monochrome-brand app, wired to something that actually
 * paints, is exactly the class of defect Detector 4 exists to catch, and `var(--color-…)` VALUES
 * are invisible to a regex built to read Tailwind CLASS NAMES. Rather than leave the carve-out to
 * trust that forever, this scans every non-test `.ts`/`.tsx` file under `src/` (not only the nine
 * vendored Gantt files) for a reference to the name `GANTT_COLORS`, excluding `gantt-bar.tsx`
 * itself (the definition site, not a consumer). The day #220 or anything else wires a consumer,
 * this fails — the fix at that point is to give the consumer real Quincy tokens, not to widen this
 * detector.
 */
const GANTT_COLORS_REFERENCE = /\bGANTT_COLORS\b/;
const ganttBarPath = join(ganttDir, "gantt-bar.tsx");

function findGanttColorsConsumers(files: Map<string, string>): string[] {
  const offenders: string[] = [];
  for (const [name, text] of files) if (GANTT_COLORS_REFERENCE.test(text)) offenders.push(name);
  return offenders.sort();
}

/** Every non-test `.ts`/`.tsx` file under `src/`, `gantt-bar.tsx` itself excluded. */
function nonTestSourceFiles(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || entry.name.includes(".test.")) continue;
      if (full === ganttBarPath) continue;
      out.set(relSrc(full), stripComments(readFileSync(full, "utf8")));
    }
  };
  walk(srcDir);
  return out;
}

describe("guard: GANTT_COLORS has no non-test consumer", () => {
  it("self-test: the real detector fires on a planted import, not on an unrelated identifier or a comment naming it", () => {
    const planted = new Map([
      [
        "fixture-consumer.tsx",
        stripComments('import { GANTT_COLORS } from "@/components/reui/gantt/gantt-bar";'),
      ],
      [
        "fixture-clean.tsx",
        stripComments(
          '// GANTT_COLORS mentioned only in a comment\nimport { GanttBar } from "@/components/reui/gantt/gantt-bar";'
        ),
      ],
      ["fixture-unrelated.tsx", stripComments('const GANTT_COLOR = "var(--gantt-event-color)";')],
    ]);
    expect(findGanttColorsConsumers(planted)).toEqual(["fixture-consumer.tsx"]);
  });

  it("has no non-test consumer anywhere under src/ — the Detector 4 carve-out above still holds", () => {
    const offenders = findGanttColorsConsumers(nonTestSourceFiles());
    expect(offenders, [
      "GANTT_COLORS now has a non-test consumer. Detector 4's carve-out for `var(--color-…-500)`",
      "values (this file, above) is premised on GANTT_COLORS being unused and unrendered — that is",
      "no longer true. Wire the new consumer to real Quincy tokens (the brand is monochrome —",
      "styles/tokens/colors.css) instead of the ten chromatic Tailwind hues GANTT_COLORS carries,",
      "or widen Detector 4 itself with a stated reason if a chromatic palette is now a real product",
      "decision. Found in:",
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
// exhaustive ternary within it, still counts — `gantt-view.tsx`'s tree/timeline scrollbar rail
// carries its bare token and its colour together in ONE always-present string, same "same
// element" idea), or one bare `className="…"` string literal on its own.
//
// #219 PR A fix (dr-219a r6 MEDIUM #3b): "the same `cn()` call" is not by itself a strong enough
// guarantee — a colour reachable only through `condition && "…"` is not GUARANTEED alongside a
// bare border that sits in an unconditional string argument, because when `condition` is false
// at runtime neither the colour NOR whatever else that same string carries ever renders, and
// nothing forces the bare border to disappear along with it. `cn("border-t", condition &&
// "border-t-border")` used to read as clean (the whole `cn()` body contains the text
// `border-t-border` somewhere), but the FALSE branch renders exactly the bare `border-t` this
// detector exists to catch. `argSegments`/`extractClassUnits` below track which `cn()` ARGUMENT
// each token came from and whether that argument is GUARANTEED to render (a plain string/template
// literal always does; an `EXPR && "…"` argument might not; an exhaustive `EXPR ? "A" : "B"`
// ternary always renders exactly one of its two branches, so it counts as guaranteed only where
// BOTH branches independently already carry a colour — otherwise picking the uncoloured branch is
// exactly as unsafe as the `&&` case). A bare border INSIDE a non-guaranteed argument is still
// safe if that SAME argument also carries its own colour (present together or absent together,
// `condition && "border-t border-t-border"`).
//
// A bare `border-0` needs no colour (zero width paints nothing regardless of colour) and is
// excluded. A colour is anything `border(-side)?-` followed by a real token/value: a 2+ letter
// name (`primary`, `destructive`, `border`, `transparent`, …), a parenthesised CSS custom
// property (`border-(--gantt-event-color)`), or a bracketed arbitrary value. Explicitly NOT a
// colour: a single-letter SIDE code standing alone (`border-b` must not satisfy its own check —
// "b" is not a colour), a `border-style` keyword (`dashed`/`solid`/`dotted`/`double`/`hidden`/
// `none` describe the LINE, not its paint), or (dr-219a r6 MEDIUM #3a) a `border-layout` keyword
// (`collapse`/`separate`, Tailwind's TABLE-layout utilities — `border-collapse`/`border-separate`
// describe cell-border MERGING, not paint) — a bare `border` sharing an element with only
// `border-collapse` alongside it used to read as "already coloured" the same way a real token
// name (`primary`) does, because the old check was "2+ letters that aren't a style word," and
// "collapse" is exactly that.
const BARE_BORDER = /(?<![\w.-])border(-[xytrbsle])?(-\d+)?\b(?!-)/g;
const BORDER_STYLE_WORDS = "solid|dashed|dotted|double|hidden|none";
const BORDER_LAYOUT_WORDS = "collapse|separate";
const BORDER_COLOR = new RegExp(
  `(?<![\\w.-])border(-[xytrbsle])?-(?:(?!(?:${BORDER_STYLE_WORDS}|${BORDER_LAYOUT_WORDS})\\b)[a-z]{2,}|\\(--[\\w-]+\\)|\\[[^\\]]+\\])`
);

type ClassSegment = { text: string; guaranteed: boolean };

/** Splits a `cn(...)` call's BODY text into its top-level, comma-separated arguments — respecting
 * nested parens/brackets/braces and quoted strings, so a comma inside an arbitrary value like
 * `border-(--gantt-event-color)` (or inside a nested bracket) never splits one argument in two. */
function splitTopLevelArgs(body: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      args.push(body.slice(start, i));
      start = i + 1;
    }
  }
  args.push(body.slice(start));
  return args.map((a) => a.trim()).filter(Boolean);
}

const STRING_LITERAL = /^(["'`])[\s\S]*\1$/;
const AND_GATED = /&&\s*(["'`][\s\S]*?["'`])\s*$/;
const TERNARY = /^[^?]*\?\s*(["'`][\s\S]*?["'`])\s*:\s*(["'`][\s\S]*?["'`])\s*$/;

/** One `cn()` ARGUMENT's contribution, split into segments this detector can reason about — see
 * the detector's own header comment (dr-219a r6 MEDIUM #3b) for why "guaranteed" matters. */
function argSegments(arg: string): ClassSegment[] {
  const ternary = TERNARY.exec(arg);
  if (ternary) {
    const [, branch1, branch2] = ternary;
    const bothColored = BORDER_COLOR.test(branch1!) && BORDER_COLOR.test(branch2!);
    return [
      { text: branch1!, guaranteed: bothColored },
      { text: branch2!, guaranteed: bothColored },
    ];
  }
  const andGated = AND_GATED.exec(arg);
  if (andGated) return [{ text: andGated[1]!, guaranteed: false }];
  if (STRING_LITERAL.test(arg)) return [{ text: arg, guaranteed: true }];
  // An unrecognised shape (a bare identifier, a nested cn() call, a computed expression …)
  // carries no string-literal TEXT for BARE_BORDER/BORDER_COLOR to match anyway - treating it as
  // guaranteed is harmless, since there is nothing here for either regex to find.
  return [{ text: arg, guaranteed: true }];
}

/** One "element" this detector reasons about: `raw` is the exact source text the unit came from
 * (a `className="…"` literal's own quoted content, or a `cn(…)` call's full argument-list body,
 * BEFORE any parsing) — kept so a caller can match against real source text (see
 * `BARE_BORDER_ALLOWLIST` below) without reconstructing it from parsed segments. `segments` is the
 * parsed, guarantee-tagged breakdown `argSegments` produces. */
type ClassUnit = { raw: string; segments: ClassSegment[] };

/** Extracts one "element's" worth of class SEGMENTS per unit: every `className="…"` literal's
 * string content (a single guaranteed segment - a plain string has no conditional branches), and
 * every `cn(…)` call's arguments, each split into its own guarantee-tagged segment(s) — see
 * `argSegments`. Handles nested parens from arbitrary values like `border-(--gantt-event-color)`
 * inside the call (they net to zero, so a naive depth counter still lands on the real closing
 * paren). */
function extractClassUnits(text: string): ClassUnit[] {
  const units: ClassUnit[] = [];
  const literalRe = /className="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = literalRe.exec(text))) {
    const raw = m[1] ?? "";
    units.push({ raw, segments: [{ text: raw, guaranteed: true }] });
  }
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
    const raw = text.slice(start, i - 1);
    units.push({ raw, segments: splitTopLevelArgs(raw).flatMap(argSegments) });
  }
  return units;
}

/**
 * Is a border colour GUARANTEED to render somewhere on this element, whichever runtime path is
 * taken? Exactly one way to earn that: any GUARANTEED segment (an unconditional string/template
 * literal, or a ternary whose two branches both independently carry a colour) already carries one.
 *
 * #219 PR A fix (Sol round-7 HIGH #1): this used to ALSO trust two or more DIFFERENT
 * `EXPR && "…"` conditional segments that each independently carried a colour, on the theory that
 * multiple independent conditional colours read as a deliberate multi-branch dispatch. That is not
 * a guarantee - two ordinary, UNRELATED conditionals (an error state and a selection state, say)
 * can both be false at once with nothing left to render, which is exactly the defect this detector
 * exists to catch:
 *
 *   cn("border", isError && "border-destructive", isSelected && "border-primary")
 *
 * Both conditions can be false, leaving the bare `border` alone. A count of independent
 * conditionals proves nothing about exhaustiveness; only a real proof does (an unconditional
 * literal, or a ternary's two structurally-exhaustive branches). `gantt-view.tsx`'s drag-ghost
 * DOES have a real exhaustiveness proof for its three `&&`-gated colours (`!ghost.valid`,
 * `ghost.valid && ghost.kind === "move"`, `ghost.valid && ghost.kind !== "move"` cover every
 * reachable state) - but this guard is not a control-flow analyser and cannot verify that from
 * syntax alone, so that one call site is named explicitly in `BARE_BORDER_ALLOWLIST` below instead
 * of being waved through by a heuristic that also passes the unsound example above.
 */
function guaranteedColorPresent(segments: ClassSegment[]): boolean {
  return segments.some((s) => s.guaranteed && BORDER_COLOR.test(s.text));
}

/** Collapses runs of whitespace to a single space, so the allowlist match survives reformatting
 * (a wrapped line, re-indentation) without also matching a DIFFERENT call site that merely shares
 * some of the same class text. */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Last-resort, per-call-site allowlist for Detector 6. A bare border whose colour is guaranteed
 * only by a control-flow exhaustiveness proof this syntactic guard cannot perform (see
 * `guaranteedColorPresent`'s doc comment) goes here, ONE exact entry at a time - never a pattern,
 * and never a second count-based heuristic. Keyed by vendored file name; the value is the EXACT
 * (whitespace-normalised) raw text of the specific `cn(…)` call's argument list being exempted —
 * matched against `ClassUnit.raw`, i.e. real source text, not a reconstruction — so a change to
 * that call site (a reworded class, an added branch, a copy-paste to a different element) stops
 * matching and the guard goes back to flagging it. Every entry needs a comment proving the
 * exhaustiveness by hand.
 */
const BARE_BORDER_ALLOWLIST: Record<string, string> = {
  // gantt-view.tsx's drag-ghost `cn()` call (the `data-slot="gantt-drag-ghost"` element): its bare
  // `border border-dashed` base is followed by three mutually exclusive `&&`-gated colours -
  // `!ghost.valid`, `ghost.valid && ghost.kind === "move"`, and `ghost.valid && ghost.kind !==
  // "move"`. `ghost.valid` and `ghost.kind === "move"` between them are a two-way boolean split
  // with no remaining state, so exactly one of the three always fires and a colour always lands.
  "gantt-view.tsx": normalizeWhitespace(`
    "pointer-events-none absolute z-40 h-(--gantt-ghost-height) rounded-sm border border-dashed font-medium",
    !ghost.valid &&
      "border-destructive bg-destructive/10 text-destructive",
    ghost.valid &&
      ghost.kind === "move" &&
      "border-(--gantt-event-color)/50 bg-(--gantt-event-color)/8",
    ghost.valid &&
      ghost.kind !== "move" &&
      "text-foreground border-(--gantt-event-color)/70 bg-(--gantt-event-color)/22",
  `),
};

function findBareBorderClasses(files: Map<string, string>): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const [name, text] of files) {
    const offenders: string[] = [];
    const allowlisted = BARE_BORDER_ALLOWLIST[name] ?? null;
    for (const unit of extractClassUnits(text)) {
      if (allowlisted && normalizeWhitespace(unit.raw).includes(allowlisted)) continue;
      const segments = unit.segments;
      const colorGuaranteed = guaranteedColorPresent(segments);
      for (const segment of segments) {
        const bare = [...segment.text.matchAll(BARE_BORDER)].map((mm) => mm[0]).filter((tok) => !/-0$/.test(tok));
        if (bare.length === 0) continue;
        const safe = segment.guaranteed
          ? colorGuaranteed
          : colorGuaranteed || BORDER_COLOR.test(segment.text);
        if (!safe) offenders.push(...bare);
      }
    }
    if (offenders.length > 0) found[name] = offenders;
  }
  return found;
}

describe("guard: no bare `border`-style class without an accompanying `border-<token>` on the same element", () => {
  it("self-test: the real detector fires on a bare border/border-b/border-t with no colour on the SAME element (same className, or a later cn() arg/branch), not when a colour, border-0, a style keyword, or an unrelated element's colour is present, and not on a comment naming the trap", () => {
    const planted = new Map([
      ["fixture-bare-literal.tsx", stripComments('className="flex h-8 border-b"')],
      // OFFENDER (dr-219a r6 MEDIUM #3b): the colour lands ONLY behind `condition && "…"` - when
      // `condition` is false at runtime, NEITHER "bg-background" NOR "border-t-border" ever
      // renders, leaving the unconditional "h-4 border-t" alone on the element: exactly the bare
      // border this detector exists to catch. A `condition && "…"` segment is not the same
      // guarantee as a second UNCONDITIONAL string argument to the same `cn()` call (Detector 5's
      // splitter case, and the real `gantt-view.tsx` scrollbar rail's own single literal
      // `"bg-background border-t-border … border-t"`, where the bare token and its colour sit
      // together in ONE always-present string) - the colour there can never be absent when the
      // border is present, because nothing gates it.
      [
        "fixture-bare-only-in-conditional-arg.tsx",
        stripComments('cn("h-4 border-t", condition && "bg-background border-t-border")'),
      ],
      // NOT an offender: the SAME conditional segment carries its own bare token AND its own
      // colour together - present together or absent together, so the false branch leaves no
      // bare border behind either.
      [
        "fixture-bare-self-paired-in-conditional-arg.tsx",
        stripComments('cn("h-4", condition && "border-t border-t-border")'),
      ],
      [
        "fixture-bare-exhaustive-branch.tsx",
        stripComments('cn("border border-dashed", valid ? "border-(--gantt-event-color)/50" : "border-destructive")'),
      ],
      // OFFENDER: an EXHAUSTIVE ternary only rescues the guaranteed bare border if EVERY branch
      // carries a colour - here only one branch does, so the OTHER branch leaves it bare.
      [
        "fixture-ternary-only-one-branch-colored.tsx",
        stripComments('cn("border border-dashed", valid ? "border-(--gantt-event-color)/50" : "opacity-50")'),
      ],
      ["fixture-colored-literal.tsx", stripComments('className="border border-(--gantt-event-color)/60"')],
      ["fixture-primary-paired.tsx", stripComments('className="border-primary border-2"')],
      ["fixture-transparent-named.tsx", stripComments('className="border-b border-b-transparent"')],
      ["fixture-zero-width.tsx", stripComments('className="rounded-none border-0 bg-transparent"')],
      [
        "fixture-style-keyword-not-a-colour.tsx",
        stripComments('cn("border border-dashed")'),
      ],
      // OFFENDER (dr-219a r6 MEDIUM #3a): `border-collapse` is a Tailwind TABLE-LAYOUT utility
      // (`border-collapse`/`border-separate`), not a colour - "collapse" happened to satisfy the
      // old bare `[a-z]{2,}` colour test the same way a real token name (`primary`, `destructive`)
      // does, so a bare `border` sharing an element with only `border-collapse` alongside it read
      // as "already coloured" when it is not.
      [
        "fixture-table-layout-utility-is-not-a-colour.tsx",
        stripComments('className="border border-collapse"'),
      ],
      [
        "fixture-unrelated-element-does-not-excuse-it.tsx",
        stripComments(
          'function A() { return <div className="border-b" /> }\nfunction B() { return <div className="border-primary" /> }'
        ),
      ],
      // OFFENDER (Sol round-7 HIGH #1): TWO independent `&&`-gated colours used to be trusted as
      // "probably exhaustive" (`conditionalColored.length >= 2`) - but two ordinary, unrelated
      // conditionals (an error state and a selection state, here) can BOTH be false at once, with
      // nothing forcing either colour to render. That leaves the unconditional bare "border" alone
      // on the element - exactly the defect this detector exists to catch. Count-based "probably
      // exhaustive" is not the same guarantee as a ternary's two branches (which structurally
      // cannot both be skipped) or an unconditional literal (which always renders).
      [
        "fixture-two-independent-conditionals-is-not-exhaustive.tsx",
        stripComments('cn("border", isError && "border-destructive", isSelected && "border-primary")'),
      ],
      [
        "fixture-clean.tsx",
        stripComments('// a bare border-b class mentioned only in this comment\nclassName="rounded-sm"'),
      ],
    ]);
    expect(findBareBorderClasses(planted)).toEqual({
      "fixture-bare-literal.tsx": ["border-b"],
      "fixture-bare-only-in-conditional-arg.tsx": ["border-t"],
      "fixture-ternary-only-one-branch-colored.tsx": ["border"],
      "fixture-style-keyword-not-a-colour.tsx": ["border"],
      "fixture-table-layout-utility-is-not-a-colour.tsx": ["border"],
      "fixture-unrelated-element-does-not-excuse-it.tsx": ["border-b"],
      "fixture-two-independent-conditionals-is-not-exhaustive.tsx": ["border"],
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
//
// #219 PR A fix (dr-219a r6 LOW #4): the opening tag used to be required to end in a literal
// `/>` (self-closing) - GanttNowLine/GanttNowDot render exactly that shape today (no children),
// but an ordinary refactor giving either element a child (a label, an icon) turns it into paired
// JSX (`<div …>…</div>`), and the old regex would silently stop matching - no red test, no
// warning, just a detector that quietly checks nothing from that point on. This detector only
// ever inspects the OPENING tag's own attributes either way (it has never looked at children), so
// the fix is simply not to require a particular way of closing that tag: `/?>` accepts a bare `>`
// (paired) exactly as readily as `/>` (self-closing).
const NOW_LINE_ELEMENT =
  /<(?:div|span)\b[^>]*\bdata-slot="gantt-now-(?:indicator|dot)"[^>]*\/?>/g;
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
      // #219 PR A fix (dr-219a r6 LOW #4): PAIRED JSX, not self-closing - an ordinary refactor
      // that gives the now-indicator children (a label, an icon, …) would otherwise silently
      // disable this detector, since the old regex demanded a literal `/>` at the end.
      [
        "fixture-now-indicator-destructive-paired.tsx",
        stripComments(
          '<div data-slot="gantt-now-indicator" className="bg-destructive absolute inset-y-0 z-10 w-px"><span className="sr-only">Now</span></div>'
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
      "fixture-now-indicator-destructive-paired.tsx": ["gantt-now-indicator"],
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
