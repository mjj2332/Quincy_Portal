/**
 * Event-calendar re-skin guard (#219, PR B). Sibling of `gantt/gantt-skin.guard.test.ts` (PR A) —
 * same idiom, same detector families, ported and extended for this tree's own shape.
 *
 * Reads the thirteen vendored event-calendar files as TEXT (not JSX test files — the module list
 * below deliberately excludes the `.test.ts`/`.dom.test.tsx` siblings in this directory) and fails
 * on the same four things the Gantt guard's header explains: a `dark:` variant (Quincy's dark
 * surface is `[data-surface="inverse"]`, which re-scopes tokens — a `dark:` variant is dead code
 * that silently activates the moment someone adds that class), a `shadow-(xs|sm|md|lg|xl)` class
 * outside the documented allowlist, a hex/`rgb()`/`rgba()` colour literal, and a non-Quincy
 * Tailwind palette class. The Quincy-authored external-drop adapter code inside
 * `event-calendar-dnd.tsx` is in scope — it is part of the file, not a separate module.
 *
 * Detector 6 (bare `border*`) from the Gantt guard is NOT ported here, and deliberately so — see
 * that guard's own header. `styles/tokens/base.css` now carries an unlayered `@layer base { *,
 * *::before, *::after { border-color: var(--border) } }` compat rule that removes the defect class
 * (Tailwind v4 preflight's `border: 0 solid currentColor` painting near-black) repo-wide, not only
 * in files a detector happens to scan. A guard whose premise has been removed must stay deleted;
 * reinstating a bare-border detector here would require deleting that compat rule FIRST, which
 * would reopen the defect everywhere else in the app it currently protects.
 *
 * Detector 3 (hex/rgb() literal) is WIDENED relative to the Gantt guard's own copy, and the same
 * widening is back-ported to `gantt-skin.guard.test.ts` in this change so the two sibling guards do
 * not silently diverge — see that detector's own comment below for the real bracketed string this
 * tree ships that the old, narrower regex missed.
 *
 * Detector 7 (the now-indicator) is RESCOPED, not ported verbatim, and that rescope is the point:
 * the Gantt's `NOW_LINE_ELEMENT` regex matches an opening tag and tests for `destructive` inside
 * it, because the Gantt's now-line and now-dot ARE the elements that carry the fill classes. Ported
 * unchanged here it would be VACUOUSLY GREEN — this calendar's `data-slot="event-calendar-now-
 * indicator"` is a bare wrapper `<div>` with no classes of its own; the three fills live on CHILD
 * `<div>`s that carry no `data-slot` at all. So this detector scopes to the `EventCalendarNowIndicator`
 * FUNCTION BODY (from `function EventCalendarNowIndicator` to the next top-level `function`/`export`
 * declaration) in `event-calendar-time-grid.tsx` and forbids `destructive` anywhere in it, rather
 * than trying to name three anonymous children by attribute. `destructive` is legitimate elsewhere
 * in that same file (the drag-create slot draft's invalid marking) and in `event-calendar-dnd.tsx`
 * (the cursor-following refusal hint), so a file-wide rule would be wrong, not merely imprecise.
 *
 * NEW for this tree, with no Gantt analogue:
 *
 *   - Detector 4a is ported for `EVENT_CALENDAR_COLORS`, the registry's own ten-hue palette
 *     constant, deleted from `event-calendar-event.tsx` in #219 PR B stage 4 for the same reason
 *     `GANTT_COLORS` earns Detector 4a in the Gantt guard: it is invisible to Detector 4 (a CSS
 *     custom-property VALUE, not a Tailwind class name) and a re-vendor will bring it back. If this
 *     goes red, the fix is real Quincy tokens for whatever imported it, never a widened detector.
 *   - Detector 9 pins an architectural decision, not a class name: the external-drop adapter's
 *     whole justification (`event-calendar-dnd.tsx`'s own banner comment, ~line 1028) is that the
 *     vendor's `data-ec-day` / `-bounds-start` / `-bounds-end` / `-resource` attribute contract is
 *     read ONLY from inside this directory. A consumer outside it reading those attributes directly
 *     would bypass the adapter and couple itself to vendor internals the next re-vendor is free to
 *     rename.
 *   - Detector 10 pins `docs/lessons.md`'s bare-`.focus()` trap: every `.focus()` call in the tree
 *     must pass `{ preventScroll: true }`, or the browser's default focus-follows-scroll silently
 *     yanks the viewport out from under whatever the user was reading. There is exactly one call
 *     site (`event-calendar-month-view.tsx`, fixed in #219 PR B stage 3).
 *
 * Each detector is a pure function over injected text, self-tested against a planted fixture that
 * PLANTS the violation it looks for — same convention as the Gantt guard and
 * `harness-reachability.guard.test.ts` (`docs/lessons.md`: "a grep gate that cannot fail is not a
 * gate"). Comments are stripped first so a comment naming the trap (like this file's own docblock)
 * is never mistaken for an instance of it.
 *
 * The shadow allowlist is empty and must stay empty, same convention as the Gantt guard: every
 * `shadow-*` class this tree ships with today is zero: `event-calendar-dnd.tsx`'s cursor-following
 * overlays (the carry clone, the refusal hint) dropped `shadow-md`/`shadow-sm` in #219 PR B stage 4
 * in favour of the hairline each already carries (`border-border`, `border-destructive/40`).
 *
 * NOT mechanised, and resting on review instead, same as the Gantt guard: muted stage tints.
 * "Muted" has no mechanical test — a hue and an alpha value are both individually valid tokens, and
 * whether a given combination reads as "muted" is a judgment call, not a grep. Rather than ship a
 * detector that pretends to check that and does not, there is no detector for it; catching a
 * regression there is a reviewer's job, not this file's.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const eventCalendarDir = dirname(fileURLToPath(import.meta.url));
// components/reui/event-calendar -> components/reui -> components -> src
const srcDir = join(eventCalendarDir, "..", "..", "..");
const relSrc = (file: string) => relative(srcDir, file).split(sep).join("/");

/** The thirteen vendored files, per this directory's own header comments — no test siblings. */
const VENDORED_FILES = [
  "event-calendar.tsx",
  "event-calendar-agenda-view.tsx",
  "event-calendar-content.tsx",
  "event-calendar-dnd.tsx",
  "event-calendar-event.tsx",
  "event-calendar-i18n.tsx",
  "event-calendar-lib.tsx",
  "event-calendar-month-view.tsx",
  "event-calendar-nav.tsx",
  "event-calendar-recurrence.tsx",
  "event-calendar-resource-view.tsx",
  "event-calendar-time-grid.tsx",
  "event-calendar-types.tsx",
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
  for (const name of VENDORED_FILES) out.set(name, stripComments(readFileSync(join(eventCalendarDir, name), "utf8")));
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
  it("self-test: the real detector fires on a planted `dark:` class, not on `backdrop:`, prose, or a comment naming the trap", () => {
    const planted = new Map([
      ["fixture-dark.tsx", stripComments('/* mentions dark: mode only in a comment */ className="dark:bg-slate-900"')],
      ["fixture-clean.tsx", stripComments('className="backdrop:bg-black/50" // the dark stage in TB8-09')],
    ]);
    expect(findDarkVariants(planted)).toEqual(["fixture-dark.tsx"]);
  });

  it("has no `dark:` variant in the thirteen vendored files", () => {
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
// WIDENED relative to the Gantt guard's own copy of this detector. The Gantt's bracketed branch —
// `\[(?:[a-zA-Z-]+:)?#[0-9a-fA-F]{3,8}\]` — requires the `#` to sit immediately after the `[` or
// after a single type-hint prefix, so the ENTIRE bracket content has to be just `#hex` or
// `type:#hex`. This tree ships a real form that shape cannot see:
// `event-calendar-event.tsx`'s truncation mask, `@max-[10rem]:[mask-image:linear-gradient(to_right,
// #000_calc(100%-0.75rem),transparent)]` — a hex buried arbitrarily deep inside a much longer
// bracketed arbitrary value. This widens the bracketed branch to match a hex ANYWHERE inside a
// `[...]` pair (no nested `]`, which Tailwind arbitrary values never contain — the delimiter for
// nested calls is always `()`), while leaving the quoted-string branch and the bare-`#219`-in-prose
// exclusion exactly as the Gantt guard already reasoned about them.
const HEX_LITERAL_SOURCE = String.raw`\[[^\]\n]*#[0-9a-fA-F]{3,8}[^\]]*\]|["'\`]#[0-9a-fA-F]{3,8}["'\`]`;
const HEX_LITERAL = new RegExp(HEX_LITERAL_SOURCE);
const HEX_LITERAL_GLOBAL = new RegExp(HEX_LITERAL_SOURCE, "g");
const RGB_LITERAL = /\brgba?\(/;

/**
 * The one real site the widened regex now (correctly) catches: `event-calendar-event.tsx`'s
 * truncation-fade mask, LTR and RTL (two separate bracketed values, one hex each). `#000` there is
 * a mask ALPHA stop — the gradient's opaque end, consumed by `mask-image` as a coverage value, not
 * painted as a colour — not paint. Any fully opaque colour is equivalent, and Tailwind's own
 * `mask-*` utilities spell that stop the same way (see Tailwind's mask documentation). Allowlisted
 * by exact count so a THIRD hex sneaking into that file (a real paint colour, not a mask stop)
 * still fails this guard.
 */
const HEX_ALLOWLIST: Record<string, number> = {
  "event-calendar-event.tsx": 2,
};

function countHexLiterals(text: string): number {
  return (text.match(HEX_LITERAL_GLOBAL) ?? []).length;
}

function findColorLiterals(files: Map<string, string>): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const [name, text] of files) {
    const hits: string[] = [];
    const hexCount = countHexLiterals(text);
    const allowed = HEX_ALLOWLIST[name] ?? 0;
    if (hexCount > allowed) hits.push(`hex (${hexCount}, allowlist ${allowed})`);
    if (RGB_LITERAL.test(text)) hits.push("rgb()");
    if (hits.length > 0) found[name] = hits;
  }
  return found;
}

describe("guard: no hex or rgb()/rgba() colour literal", () => {
  it("self-test: the real detector fires on a bracketed hex, a TYPED bracketed hex, a quoted hex, and rgba(); not on an issue reference or a comment naming the trap", () => {
    const planted = new Map([
      ["fixture-hex-bracket.tsx", stripComments('className="bg-[#0a0a0a]"')],
      ["fixture-hex-typed.tsx", stripComments('className="bg-[color:#fff]"')],
      ["fixture-hex-typed-long.tsx", stripComments('className="bg-[background-color:#0a0a0a]"')],
      ["fixture-hex-quoted.tsx", stripComments('style.background = "#0a0a0a"')],
      ["fixture-rgb.tsx", stripComments("color-mix(in oklab, rgba(0,0,0,.4) 20%, transparent)")],
      ["fixture-clean.tsx", stripComments('// bg-[#0a0a0a] mentioned only in a comment, for #219 (PR B, stage 4), owner decision on #215/#219')],
    ]);
    const found = findColorLiterals(planted);
    expect(found).toEqual({
      "fixture-hex-bracket.tsx": ["hex (1, allowlist 0)"],
      "fixture-hex-typed.tsx": ["hex (1, allowlist 0)"],
      "fixture-hex-typed-long.tsx": ["hex (1, allowlist 0)"],
      "fixture-hex-quoted.tsx": ["hex (1, allowlist 0)"],
      "fixture-rgb.tsx": ["rgb()"],
    });
  });

  // The widening's whole justification, proven directly: the OLD (Gantt) regex misses the exact
  // bracketed mask-image string this tree ships, and the NEW (widened) regex catches it. Written
  // BEFORE the widening was made (per the task's own ordering), and kept here afterwards as the
  // permanent evidence that the widening is real, not cosmetic.
  it("Detector 3 widening: the OLD (Gantt) hex regex misses a hex buried inside a longer bracketed value; the NEW (widened) regex catches it", () => {
    const OLD_HEX_LITERAL = /\[(?:[a-zA-Z-]+:)?#[0-9a-fA-F]{3,8}\]|["'`]#[0-9a-fA-F]{3,8}["'`]/;
    const maskImageString =
      "@max-[10rem]:[mask-image:linear-gradient(to_right,#000_calc(100%-0.75rem),transparent)]";
    expect(OLD_HEX_LITERAL.test(maskImageString)).toBe(false);
    expect(HEX_LITERAL.test(maskImageString)).toBe(true);
  });

  it("has no hex or rgb()/rgba() literal beyond the (documented) allowlist in the thirteen vendored files", () => {
    const found = findColorLiterals(readVendoredFiles());
    const offenders = Object.entries(found).map(([name, hits]) => `  ${name}: ${hits.join(", ")}`);
    expect(offenders, [
      "A literal colour survives instead of a semantic token, beyond HEX_ALLOWLIST's documented",
      "mask-alpha exception. See styles/tokens/colors.css and tokens/tailwind.css for the token",
      "roles already covering this ground.",
      ...offenders,
    ].join("\n")).toEqual([]);
  });

  it("keeps the hex allowlist honest — exactly the one documented mask-alpha site", () => {
    expect(HEX_ALLOWLIST, "HEX_ALLOWLIST changed shape. See this file's header for why it holds exactly one entry.").toEqual({
      "event-calendar-event.tsx": 2,
    });
  });
});

// ---------------------------------------------------------------------------
// Detector 4 — a non-Quincy Tailwind palette class (incl. black/white used as paint)
// ---------------------------------------------------------------------------
// Verbatim from the Gantt guard's Detector 4 — same palette, same prefixes, same reasoning.
const PALETTE_NAMES =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const PALETTE_PREFIXES = "bg|text|border|ring|from|via|to|fill|stroke|outline|accent|caret|divide|shadow|decoration";
const NON_TOKEN_PALETTE = new RegExp(`\\b(?:${PALETTE_PREFIXES})-(?:(?:${PALETTE_NAMES})-\\d{2,3}|black|white)\\b`);

function findNonTokenPalette(files: Map<string, string>): string[] {
  const offenders: string[] = [];
  for (const [name, text] of files) if (NON_TOKEN_PALETTE.test(text)) offenders.push(name);
  return offenders.sort();
}

describe("guard: no non-token Tailwind palette class", () => {
  it("self-test: the real detector fires on a scaled palette class and on bare black/white paint, not on a Quincy role, a CSS custom-property value, or a comment naming the trap", () => {
    const planted = new Map([
      ["fixture-slate.tsx", stripComments('className="bg-slate-500"')],
      ["fixture-gray.tsx", stripComments('className="text-gray-400"')],
      ["fixture-black.tsx", stripComments('className="bg-black/40"')],
      ["fixture-white.tsx", stripComments('className="text-white"')],
      ["fixture-clean.tsx", stripComments('className="bg-background text-foreground border-border"\n// not bg-slate-500, that is just a comment')],
      ["fixture-var.tsx", stripComments('value: "var(--color-blue-500)"')],
    ]);
    expect(findNonTokenPalette(planted)).toEqual(
      ["fixture-black.tsx", "fixture-gray.tsx", "fixture-slate.tsx", "fixture-white.tsx"].sort()
    );
  });

  it("has no non-token palette class in the thirteen vendored files", () => {
    const offenders = findNonTokenPalette(readVendoredFiles());
    expect(offenders, [
      "A Tailwind core-palette class (or a bare black/white paint utility) survives instead of a",
      "semantic token. The brand is monochrome (styles/tokens/colors.css) — replace it with the",
      "Quincy role that already covers this ground (bg-background, text-foreground, bg-muted,",
      "border-border, ring-ring, the inline --ec-event-color, …). Found in:",
      ...offenders.map((name) => `  ${name}`),
    ].join("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Detector 4a — EVENT_CALENDAR_COLORS has no consumer
// ---------------------------------------------------------------------------
/**
 * `EVENT_CALENDAR_COLORS` was ten chromatic `var(--color-<hue>-500)` presets — the registry's
 * default palette, and not Quincy's monochrome brand. It was DELETED from `event-calendar-
 * event.tsx` in #219 PR B stage 4 rather than merely left unconsumed, for the same reason the
 * Gantt guard's `GANTT_COLORS` detector exists: it is invisible to Detector 4 above (a CSS
 * custom-property VALUE, not a Tailwind class name), so a re-vendor bringing the const back would
 * sail past every other detector in this file undetected. This scans every non-test `.ts`/`.tsx`
 * file under `src/` for the identifier `EVENT_CALENDAR_COLORS` and fails on ANY hit. If this goes
 * red, the fix is real Quincy tokens for whatever consumer appeared — never a widened detector.
 */
const EVENT_CALENDAR_COLORS_REFERENCE = /\bEVENT_CALENDAR_COLORS\b/;

function findEventCalendarColorsConsumers(files: Map<string, string>): string[] {
  const offenders: string[] = [];
  for (const [name, text] of files) if (EVENT_CALENDAR_COLORS_REFERENCE.test(text)) offenders.push(name);
  return offenders.sort();
}

/** Every non-test `.ts`/`.tsx` file under `src/`. */
function allNonTestSourceFiles(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || entry.name.includes(".test.")) continue;
      out.set(relSrc(full), stripComments(readFileSync(full, "utf8")));
    }
  };
  walk(srcDir);
  return out;
}

describe("guard: EVENT_CALENDAR_COLORS has no consumer", () => {
  it("self-test: the real detector fires on a planted import, not on an unrelated identifier or a comment naming it", () => {
    const planted = new Map([
      [
        "fixture-consumer.tsx",
        stripComments('import { EVENT_CALENDAR_COLORS } from "@/components/reui/event-calendar/event-calendar-event";'),
      ],
      [
        "fixture-clean.tsx",
        stripComments(
          '// EVENT_CALENDAR_COLORS mentioned only in a comment\nimport { EventCalendarEvent } from "@/components/reui/event-calendar/event-calendar-event";'
        ),
      ],
      ["fixture-unrelated.tsx", stripComments('const EVENT_CALENDAR_COLOR = "var(--ec-event-color)";')],
    ]);
    expect(findEventCalendarColorsConsumers(planted)).toEqual(["fixture-consumer.tsx"]);
  });

  it("has no consumer anywhere under src/", () => {
    const offenders = findEventCalendarColorsConsumers(allNonTestSourceFiles());
    expect(offenders, [
      "EVENT_CALENDAR_COLORS now has a consumer. It was deleted in #219 PR B stage 4 because it was",
      "ten chromatic Tailwind hues in a monochrome-brand app, invisible to Detector 4 above because",
      "it is a var(--color-…) VALUE, not a class name. Wire the new consumer to real Quincy tokens",
      "(styles/tokens/colors.css) — do not widen this detector. Found in:",
      ...offenders.map((name) => `  ${name}`),
    ].join("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Detector 5 — `outline-none` paired with a `focus-visible:ring-*` class
// ---------------------------------------------------------------------------
// Ported as-is from the Gantt guard's Detector 5 — same trap, same fix
// (`styles/tokens/base.css`'s unlayered `:focus-visible { outline }` already beats
// `@layer utilities`, so the pair ADDS a second indicator instead of replacing the global one).
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

  it("has no `outline-none` / `focus-visible:ring-*` pairing in the thirteen vendored files", () => {
    const offenders = findOutlineRingPairs(readVendoredFiles());
    expect(offenders, [
      "outline-none paired with focus-visible:ring-* adds a SECOND focus indicator instead of",
      "replacing the global one - styles/tokens/base.css's unlayered `:focus-visible { outline }`",
      "already beats @layer utilities. Drop both classes and let the global outline stand, as",
      "components/reui/button.tsx does. Found in:",
      ...offenders.map((name) => `  ${name}`),
    ].join("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Detector 7 — a `destructive` token inside EventCalendarNowIndicator's function body
// ---------------------------------------------------------------------------
/**
 * RESCOPED relative to the Gantt guard's own Detector 7 (its own attribute-matching form would be
 * vacuously green here — see this file's header). `event-calendar-time-grid.tsx`'s
 * `EventCalendarNowIndicator` renders a bare `data-slot="event-calendar-now-indicator"` wrapper
 * `<div>` with no classes of its own; its three fills (the cross-column hairline, today's
 * segment, the leading dot) are anonymous CHILD `<div>`s. There is no attribute to anchor a
 * per-element regex on, so this scopes to the FUNCTION BODY instead: everything from
 * `function EventCalendarNowIndicator` up to the next top-level `function`/`export` declaration.
 * `destructive` is legitimate everywhere else in this file (the drag-create slot draft's own
 * invalid-state styling) and in `event-calendar-dnd.tsx` (the cursor-following refusal hint), so a
 * file-wide "no destructive" rule would be wrong on real, correct code — this is why the negative
 * fixture below plants `destructive` in a NEIGHBOURING function and asserts it does NOT fire.
 */
const DESTRUCTIVE_TOKEN = /\bdestructive\b/;

/**
 * Slices `text` from the first `function <fnName>` declaration to (but not including) the next
 * top-level `function ` or `export ` declaration that starts at the beginning of a line — i.e. the
 * next sibling declaration, not anything nested inside `fnName`'s own body (this file's real
 * function bodies never declare a nested `function` themselves). Returns `null` if `fnName` is not
 * declared in `text` at all.
 */
function extractFunctionBody(text: string, fnName: string): string | null {
  const marker = `function ${fnName}`;
  const start = text.indexOf(marker);
  if (start === -1) return null;
  const searchFrom = start + marker.length;
  const nextDecl = /\n(?:function |export )/.exec(text.slice(searchFrom));
  const end = nextDecl ? searchFrom + nextDecl.index : text.length;
  return text.slice(start, end);
}

function findDestructiveInNowIndicator(files: Map<string, string>): string[] {
  const offenders: string[] = [];
  for (const [name, text] of files) {
    const body = extractFunctionBody(text, "EventCalendarNowIndicator");
    if (body && DESTRUCTIVE_TOKEN.test(body)) offenders.push(name);
  }
  return offenders.sort();
}

describe("guard: no `destructive` token inside EventCalendarNowIndicator's body", () => {
  it("self-test: fires when EventCalendarNowIndicator's OWN body carries a destructive class; not when a NEIGHBOURING function's body does (destructive is legitimate there), and not on a comment naming the trap", () => {
    const planted = new Map([
      [
        "fixture-planted.tsx",
        stripComments(
          "function EventCalendarDayColumn() {\n" +
            '  return <div className="bg-border-strong" />\n' +
            "}\n\n" +
            "function EventCalendarNowIndicator({ days }) {\n" +
            '  return <div className="bg-destructive absolute inset-x-0" />\n' +
            "}\n\n" +
            "function EventCalendarWeekView() {\n" +
            "  return null\n" +
            "}\n"
        ),
      ],
      [
        "fixture-neighbour-before-clean.tsx",
        stripComments(
          "function EventCalendarDayColumn() {\n" +
            "  // the slot-draft's own invalid state legitimately uses destructive here\n" +
            '  return <div className="border-destructive" />\n' +
            "}\n\n" +
            "function EventCalendarNowIndicator({ days }) {\n" +
            '  return <div className="bg-border-strong" />\n' +
            "}\n"
        ),
      ],
      [
        "fixture-neighbour-after-clean.tsx",
        stripComments(
          "function EventCalendarNowIndicator({ days }) {\n" +
            '  return <div className="bg-border-strong" />\n' +
            "}\n\n" +
            "function EventCalendarWeekView() {\n" +
            '  return <div className="border-destructive" />\n' +
            "}\n"
        ),
      ],
      [
        "fixture-clean-comment.tsx",
        stripComments(
          "// EventCalendarNowIndicator used to be bg-destructive here, fixed\n" +
            "function EventCalendarNowIndicator({ days }) {\n" +
            '  return <div className="bg-border-strong" />\n' +
            "}\n"
        ),
      ],
    ]);
    expect(findDestructiveInNowIndicator(planted)).toEqual(["fixture-planted.tsx"]);
  });

  it("has no `destructive` token in EventCalendarNowIndicator's body in the real file", () => {
    const offenders = findDestructiveInNowIndicator(readVendoredFiles());
    expect(offenders, [
      "EventCalendarNowIndicator's body must not borrow --signal-critical (destructive) - red",
      "already means overdue/critical elsewhere in this app, and the now-line has no causal link",
      "to an overdue event. Use border-strong instead. Found in:",
      ...offenders.map((name) => `  ${name}`),
    ].join("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Detector 8 — square surfaces: no `rounded-lg`/`rounded-xl`/`rounded-2xl` or larger
// ---------------------------------------------------------------------------
/**
 * Ported from the Gantt guard's Detector 8. `styles/tokens/spacing.css` declares the brand
 * "square-ish" and `--radius-card: var(--radius-none)`. This flags `rounded-lg`/`rounded-xl`/
 * `rounded-2xl` and any larger named step, bare or side/corner-scoped.
 *
 * The threshold must NOT be lowered to `md`: Quincy's own `components/reui/calendar.tsx` sets
 * `--cell-radius: var(--radius-md)`, so `rounded-md` is a legitimate Quincy step, not a defect —
 * an `md`-threshold detector here would be wrong, not merely strict. `rounded-sm`/`rounded-xs`/
 * `rounded-none`/`rounded-full` are likewise not flagged (`rounded-full` covers this tree's pills
 * and dots, which are a different shape entirely, not a "square surface" this rule is about).
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

  it("has no rounded-lg/rounded-xl/rounded-2xl (or larger) class in the thirteen vendored files", () => {
    const found = findLargeRadii(readVendoredFiles());
    const offenders = Object.entries(found).map(([name, hits]) => `  ${name}: ${hits.join(", ")}`);
    expect(offenders, [
      "A rounded-lg/rounded-xl/rounded-2xl (or larger) class survives in the vendored event-",
      "calendar tree. The brand is square-ish (styles/tokens/spacing.css) and cards are square by",
      "default (--radius-card: var(--radius-none)). rounded-md is a legitimate Quincy step",
      "(components/reui/calendar.tsx's --cell-radius) and rounded-full on pills/dots is a different",
      "shape entirely - neither is what this flags. Found in:",
      ...offenders,
    ].join("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Detector 9 — `data-ec-*` confinement to this directory
// ---------------------------------------------------------------------------
/**
 * Pins an architectural decision, not a class name. The external-drop adapter's whole
 * justification (`event-calendar-dnd.tsx`'s own banner comment, ~line 1028) is that the vendor's
 * `data-ec-day` / `-bounds-start` / `-bounds-end` / `-resource` attribute contract is read ONLY
 * from inside this directory — a consumer outside it reading those attributes directly would
 * bypass the adapter and couple itself to vendor internals a re-vendor is free to rename. This
 * scans every non-test `.ts`/`.tsx` file under `src/` OUTSIDE
 * `components/reui/event-calendar/` for the string `data-ec-` and fails on any hit.
 *
 * Checked, not assumed: `src/harness/reui-scheduling/external-drop-policy.ts` mentions `data-ec-
 * resource` once, but only inside a `//` comment describing the contract — `stripComments` removes
 * it before this runs, and the rest of `src/harness/reui-scheduling/` has no `data-ec-` at all. The
 * `.dom.test.tsx` files inside this directory that stub `[data-ec-day]` DOM nodes for test geometry
 * are already outside this detector's scan (they live INSIDE `components/reui/event-calendar/`,
 * which this detector deliberately excludes), so no additional test-file exclusion is needed here.
 */
const DATA_EC_ATTRIBUTE = /data-ec-/;
const eventCalendarDirRelPrefix = relSrc(eventCalendarDir) + "/";

function findDataEcOutsideDirectory(files: Map<string, string>): string[] {
  const offenders: string[] = [];
  for (const [name, text] of files) {
    if (name.startsWith(eventCalendarDirRelPrefix)) continue;
    if (DATA_EC_ATTRIBUTE.test(text)) offenders.push(name);
  }
  return offenders.sort();
}

describe("guard: `data-ec-*` attributes stay confined to components/reui/event-calendar/", () => {
  it("self-test: the real detector fires on a planted `data-ec-` usage outside the directory, not on a comment naming the trap or on an in-directory file", () => {
    const planted = new Map([
      ["src/harness/reui-scheduling/fixture-consumer.tsx", stripComments('el.getAttribute("data-ec-day")')],
      [
        "src/harness/reui-scheduling/fixture-clean.tsx",
        stripComments('// this file used to read data-ec-day directly, fixed\nel.getAttribute("data-something-else")'),
      ],
      [
        `${eventCalendarDirRelPrefix}fixture-in-directory.tsx`,
        stripComments('<div data-ec-day={dayStart.getTime()} />'),
      ],
    ]);
    expect(findDataEcOutsideDirectory(planted)).toEqual(["src/harness/reui-scheduling/fixture-consumer.tsx"]);
  });

  it("has no `data-ec-` usage anywhere under src/ outside this directory", () => {
    const offenders = findDataEcOutsideDirectory(allNonTestSourceFiles());
    expect(offenders, [
      "data-ec-* is the vendored event-calendar's own DOM attribute contract, meant to be read",
      "only from inside components/reui/event-calendar/ (see event-calendar-dnd.tsx's external-",
      "drop adapter banner comment). A consumer outside this directory reading it directly bypasses",
      "the adapter and couples itself to vendor internals a re-vendor is free to rename. Found in:",
      ...offenders.map((name) => `  ${name}`),
    ].join("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Detector 10 — no bare `.focus()` (every call must pass `{ preventScroll: true }`)
// ---------------------------------------------------------------------------
/**
 * `docs/lessons.md` records this trap: a bare `.focus()` call lets the browser's default focus-
 * follows-scroll yank the viewport to wherever the newly focused element sits, even when the user
 * was reading somewhere else on the page. There is exactly one `.focus()` call site in this tree
 * (`event-calendar-month-view.tsx`, fixed in #219 PR B stage 3), and it must keep passing
 * `{ preventScroll: true }`. This scans for every `.focus(...)` call (balanced-paren aware, so it
 * is not fooled by parentheses nested inside the argument) and fails if the argument does not
 * contain `preventScroll: true` — this also catches a `{ preventScroll: false }` regression, not
 * only a fully bare `.focus()`.
 */
function findFocusCallArguments(text: string): string[] {
  const args: string[] = [];
  const callSites = /\.focus\(/g;
  let match: RegExpExecArray | null;
  while ((match = callSites.exec(text))) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      i++;
    }
    args.push(text.slice(start, i - 1));
  }
  return args;
}

const PREVENT_SCROLL_TRUE = /preventScroll\s*:\s*true/;

function findBareFocusCalls(files: Map<string, string>): Record<string, number> {
  const found: Record<string, number> = {};
  for (const [name, text] of files) {
    const bare = findFocusCallArguments(text).filter((arg) => !PREVENT_SCROLL_TRUE.test(arg));
    if (bare.length > 0) found[name] = bare.length;
  }
  return found;
}

describe("guard: no bare `.focus()` — every call must pass `{ preventScroll: true }`", () => {
  it("self-test: fires on a fully bare `.focus()` and on `{ preventScroll: false }`; not on `{ preventScroll: true }` or a comment naming the trap", () => {
    const planted = new Map([
      ["fixture-bare.tsx", stripComments("chip.focus()")],
      ["fixture-false.tsx", stripComments("chip.focus({ preventScroll: false })")],
      ["fixture-other-options.tsx", stripComments("chip.focus({ preventScroll: true, foo: bar() })")],
      ["fixture-clean.tsx", stripComments("chip.focus({ preventScroll: true })")],
      [
        "fixture-clean-comment.tsx",
        stripComments("// a bare chip.focus() used to be here, fixed\nchip.focus({ preventScroll: true })"),
      ],
    ]);
    expect(findBareFocusCalls(planted)).toEqual({ "fixture-bare.tsx": 1, "fixture-false.tsx": 1 });
  });

  it("has no bare `.focus()` call in the thirteen vendored files", () => {
    const found = findBareFocusCalls(readVendoredFiles());
    const offenders = Object.entries(found).map(([name, count]) => `  ${name}: ${count}`);
    expect(offenders, [
      "A .focus() call survives without { preventScroll: true }. docs/lessons.md records this trap:",
      "the browser's default focus-follows-scroll yanks the viewport out from under whatever the",
      "user was reading. Found in:",
      ...offenders,
    ].join("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sanity — the scan itself reads the real vendored files, not an empty set
// ---------------------------------------------------------------------------
describe("the file scan itself", () => {
  it("reads all thirteen vendored files with real content", () => {
    const files = readVendoredFiles();
    expect(files.size).toBe(13);
    for (const [name, text] of files) expect(text.length, `${name} read as empty`).toBeGreaterThan(500);
  });
});
