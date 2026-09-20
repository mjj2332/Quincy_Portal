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
 * #219 PR B: the bare-`border` detector this file used to carry (Detector 6, dr-219a HIGH #3) is
 * GONE, and deliberately so. It existed because Tailwind v4 preflight resets every element to
 * `border: 0 solid currentColor` and this app shipped no compat rule, so a bare structural border
 * class painted near-black instead of the greige hairline. #219 PR B fixed the CAUSE —
 * `styles/tokens/base.css` now carries `@layer base { *, *::before, *::after { border-color:
 * var(--border) } }`, so a width-only border class paints the surface's own hairline everywhere in
 * the app, not only in the files a detector happened to scan. A guard whose premise has been
 * removed must be DELETED, not left passing: kept on, it would go on reporting a hazard that no
 * longer exists and quietly teach the next reader that bare borders are still dangerous here. Do
 * not reinstate it without first deleting that compat rule. See `docs/lessons.md`, "Tailwind v4
 * preflight makes a bare `border`/`border-b` paint near-black".
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
 *
 * #219 PR A standards review item 12: the re-skin claimed more rules than this file mechanises.
 * MECHANISED, by the seven detectors below: no `dark:` variant, no `shadow-*` outside the
 * allowlist, no hex/rgb() literal, no non-token Tailwind palette class, no `outline-none` +
 * `focus-visible:ring-*` pairing, no `destructive` on
 * the now-line, and — Detector 8 — square surfaces (no `rounded-lg`/`rounded-xl`/`rounded-2xl` or
 * larger anywhere in the tree; `rounded-sm` on the bar family is a deliberate, documented choice,
 * not an exception this detector carves around — it is simply below the threshold this detector
 * flags). NOT mechanised, and resting on review instead: muted stage tints. "Muted" has no
 * mechanical test — a hue and an alpha value are both individually valid tokens, and whether a
 * given combination reads as "muted" is a judgment call, not a grep. Rather than ship a detector
 * that pretends to check that and does not, there is no detector for it; catching a regression
 * there is a reviewer's job, not this file's.
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
//
// #219 PR B back-port: the bracketed branch is WIDENED to match a hex ANYWHERE inside a `[...]`
// pair, not only immediately after `[` or a single type-hint prefix. `event-calendar-skin.guard.
// test.ts` (this file's sibling for the vendored event-calendar) found a real form the old,
// narrower regex missed: `event-calendar-event.tsx`'s truncation mask, `@max-[10rem]:[mask-image:
// linear-gradient(to_right,#000_calc(100%-0.75rem),transparent)]` — a hex buried arbitrarily deep
// inside a much longer bracketed arbitrary value. Ported here so the two sibling guards do not
// silently diverge; the Gantt tree itself has no `mask-image`/`#000`/`#fff`, so this widening
// cannot turn this guard red (verified before making this change — see `readVendoredFiles()`'s
// nine files for the search).
const HEX_LITERAL = /\[[^\]\n]*#[0-9a-fA-F]{3,8}[^\]]*\]|["'`]#[0-9a-fA-F]{3,8}["'`]/;
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

  // #219 PR B back-port: the widening's whole justification, proven directly against the OLD
  // (pre-#219 PR B) regex — the OLD form misses a hex buried inside a longer bracketed value; the
  // NEW (widened) `HEX_LITERAL` above catches it. See `event-calendar-skin.guard.test.ts`'s sibling
  // copy of this test for the real vendored string this comes from.
  it("Detector 3 widening: the OLD hex regex misses a hex buried inside a longer bracketed value; the NEW (widened) regex catches it", () => {
    const OLD_HEX_LITERAL = /\[(?:[a-zA-Z-]+:)?#[0-9a-fA-F]{3,8}\]|["'`]#[0-9a-fA-F]{3,8}["'`]/;
    const maskImageString =
      "@max-[10rem]:[mask-image:linear-gradient(to_right,#000_calc(100%-0.75rem),transparent)]";
    expect(OLD_HEX_LITERAL.test(maskImageString)).toBe(false);
    expect(HEX_LITERAL.test(maskImageString)).toBe(true);
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
// Detector 8 — square surfaces: no `rounded-lg`/`rounded-xl`/`rounded-2xl` or larger
// ---------------------------------------------------------------------------
/**
 * #219 PR A standards review item 12. `styles/tokens/spacing.css` declares the brand "square-ish"
 * and `--radius-card: var(--radius-none)` — "cards are square by default". The re-skin claimed
 * this Gantt tree followed suit; nothing mechanised it. This flags `rounded-lg`/`rounded-xl`/
 * `rounded-2xl` and any larger named step (`rounded-3xl`, …) — Tailwind's scale from "lg" up —
 * anywhere in the tree, on the bare form or a side/corner-scoped one (`rounded-t-lg`,
 * `rounded-tl-xl`, …).
 *
 * `rounded-sm` (and `rounded-xs`/`rounded-md`/`rounded-none`/`rounded-full`) are NOT flagged.
 * `rounded-sm` on the bar family is a deliberate, documented choice — it matches Quincy's own
 * `badge` — and it needs no special-casing here: it is simply below the threshold this detector
 * targets, the same way a Tailwind utility with a scale this detector does not name was never in
 * its reach to begin with. `rounded-full` (pills, dots, avatars-in-miniature — the resize grips,
 * the zoom control's circular buttons) is a different shape entirely, not a "square surface" this
 * rule is about, so it is likewise untouched.
 */
const ROUNDED_LARGE = /\brounded(?:-(?:t|r|b|l|s|e|tl|tr|bl|br|ss|se|es|ee))?-(?:lg|xl|\dxl)\b/g;

function findLargeRadii(files: Map<string, string>): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const [name, text] of files) {
    const hits = [...text.matchAll(ROUNDED_LARGE)].map((match) => match[0]);
    if (hits.length > 0) found[name] = hits;
  }
  return found;
}

describe("guard: no rounded-lg/rounded-xl/rounded-2xl (or larger) anywhere in the vendored tree", () => {
  it("self-test: the real detector fires on a bare or corner-scoped large radius, not on rounded-sm/md/none/full or a comment naming the trap", () => {
    const planted = new Map([
      ["fixture-lg.tsx", stripComments('className="rounded-lg border"')],
      ["fixture-xl.tsx", stripComments('className="rounded-xl"')],
      ["fixture-2xl.tsx", stripComments('className="rounded-2xl"')],
      ["fixture-3xl.tsx", stripComments('className="rounded-3xl"')],
      ["fixture-corner.tsx", stripComments('className="rounded-tl-lg rounded-br-lg"')],
      ["fixture-side.tsx", stripComments('className="rounded-t-xl"')],
      [
        "fixture-clean.tsx",
        stripComments(
          'className="rounded-sm rounded-xs rounded-md rounded-none rounded-full"\n// not rounded-lg, just this comment'
        ),
      ],
    ]);
    expect(findLargeRadii(planted)).toEqual({
      "fixture-lg.tsx": ["rounded-lg"],
      "fixture-xl.tsx": ["rounded-xl"],
      "fixture-2xl.tsx": ["rounded-2xl"],
      "fixture-3xl.tsx": ["rounded-3xl"],
      "fixture-corner.tsx": ["rounded-tl-lg", "rounded-br-lg"],
      "fixture-side.tsx": ["rounded-t-xl"],
    });
  });

  it("has no rounded-lg/rounded-xl/rounded-2xl (or larger) class in the nine vendored files", () => {
    const found = findLargeRadii(readVendoredFiles());
    const offenders = Object.entries(found).map(([name, hits]) => `  ${name}: ${hits.join(", ")}`);
    expect(offenders, [
      "A rounded-lg/rounded-xl/rounded-2xl (or larger) class survives in the vendored Gantt tree.",
      "The brand is square-ish (styles/tokens/spacing.css) and cards are square by default",
      "(--radius-card: var(--radius-none)). rounded-sm on the bar family (matching Quincy's own",
      "badge) and rounded-full on pills/dots/circular controls are both fine and not what this",
      "flags. Found in:",
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
