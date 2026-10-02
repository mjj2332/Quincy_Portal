/**
 * Filters re-skin guard (#255). A PORT of `gantt/gantt-skin.guard.test.ts` (and its sibling
 * `event-calendar/event-calendar-skin.guard.test.ts`), scoped to the two directories
 * `@reui/filters` landed in: `components/reui/filters/` (13 files) and `components/reui/cascader/`
 * (9 files). Same idiom: every file is read as TEXT, comments are stripped first so a comment naming
 * a trap is never mistaken for an instance of it, and every detector is a pure function over
 * injected text, self-tested against a planted fixture that PLANTS the violation it looks for
 * (`docs/lessons.md`: "a grep gate that cannot fail is not a gate").
 *
 * PORTED, with the Gantt guard's exact matchers: Detector 1 (`dark:` variant), 2 (`shadow-(xs|sm|
 * md|lg|xl)` outside an empty allowlist), 3 (hex / `rgb()` literal, the widened bracketed form),
 * 4 (non-token Tailwind palette class, bare black/white paint included), 5 (`outline-none` paired
 * with `focus-visible:ring-*`) and 8 (no `rounded-lg`/`rounded-xl`/`rounded-2xl` or larger).
 *
 * ADDED (#255 browser pass F): Detector 9, no `bg-accent` without `text-accent-foreground` in the
 * same class string (Quincy's `--accent` is `--ink-900`, so the pair's text vanishes otherwise).
 *
 * NOT PORTED, and why: Detector 4a (`GANTT_COLORS` has no consumer) and Detector 7 (no
 * `destructive` on the now-line) name Gantt-only constructs; this tree has neither a colour-preset
 * constant nor a now-line, so a port would be vacuously green. The bare-`border` detector stays
 * deleted for the reason the Gantt guard's header gives (`styles/tokens/base.css`'s layered
 * border-colour compat rule).
 *
 * What the re-skin stripped to turn this guard green on the fresh install — ONE category of class
 * edit, not all of them: every other edit to the vendored tree (the browser-pass re-skins and Quincy
 * classes, the behavioural additions) is recorded in the header of the file it touches, which is
 * the one place to look. The strips: six `dark:bg-input/30` in `filters-chip.tsx`; three `dark:` classes
 * in `cascader.tsx`'s chip-input class; `shadow-md` + `rounded-lg` from the popup classes in
 * `cascader.tsx` and `cascader-footer.tsx`, `rounded-lg` from `cascader.tsx`'s chip-input class,
 * and `hover:shadow-xs` from `cascader-item.tsx`'s hover class. Semantic classes (`bg-background`,
 * `ring-1 ring-foreground/10`, …) were kept; nothing was re-sized.
 *
 * KNOWN, NOT MECHANISED (reported rather than silently widened): the cascader pairs
 * `outline-hidden` (not `outline-none`) with `focus-visible:ring-*` in `cascader.tsx` and
 * `cascader-nav.tsx`. Detector 5 matches `outline-none` only, exactly as the Gantt guard does, so
 * those pairs pass. Whether `outline-hidden` + ring double-draws against `styles/tokens/base.css`'s
 * unlayered `:focus-visible` outline is a browser-pass question.
 *
 * This guard scans ONLY the 22 files below. It says nothing about the Quincy primitives the bar
 * renders through (`reui/popover.tsx`, `reui/dropdown-menu.tsx`, `reui/tooltip.tsx`, …), which
 * still carry their own `shadow-md`/`rounded-lg` — see the Gantt guard's header for that list.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const filtersDir = dirname(fileURLToPath(import.meta.url));
const cascaderDir = join(filtersDir, "..", "cascader");

/** The 13 vendored filters files — no test siblings. `filters-date.tsx` was left out on install. */
const FILTERS_FILES = [
  "filters.tsx",
  "filters-advanced.tsx",
  "filters-builder.tsx",
  "filters-chip.tsx",
  "filters-context.tsx",
  "filters-dnd.tsx",
  "filters-draft.tsx",
  "filters-editors.tsx",
  "filters-i18n.tsx",
  "filters-lib.tsx",
  "filters-operators.tsx",
  "filters-query.tsx",
  "filters-types.tsx",
];

/** The 9 vendored cascader files. `cascader-virtual.tsx`/`cascader-columns.tsx` were left out. */
const CASCADER_FILES = [
  "cascader.tsx",
  "cascader-async.tsx",
  "cascader-context.tsx",
  "cascader-footer.tsx",
  "cascader-i18n.tsx",
  "cascader-item.tsx",
  "cascader-lib.tsx",
  "cascader-nav.tsx",
  "cascader-types.tsx",
];

/**
 * Allowlisted `shadow-*` classes, by file. Empty, and must stay empty — the Portal's elevation
 * convention is hairline borders (`styles/tokens/spacing.css`).
 */
const SHADOW_ALLOWLIST: Record<string, string[]> = {};

/** Blanks `/* … *\/` and `// …` comment bodies so a comment naming a trap is never flagged. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function readVendoredFiles(): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of FILTERS_FILES) out.set(`filters/${name}`, stripComments(readFileSync(join(filtersDir, name), "utf8")));
  for (const name of CASCADER_FILES) out.set(`cascader/${name}`, stripComments(readFileSync(join(cascaderDir, name), "utf8")));
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
  it("self-test: the real detector fires on a planted `dark:` class (the exact form this tree shipped), not on `backdrop:`, prose, or a comment naming the trap", () => {
    const planted = new Map([
      ["fixture-dark.tsx", stripComments('/* mentions dark: mode only in a comment */ className="bg-background dark:bg-input/30"')],
      ["fixture-dark-nested.tsx", stripComments('"has-aria-invalid:border-destructive dark:has-aria-invalid:border-destructive/50"')],
      ["fixture-clean.tsx", stripComments('className="backdrop:bg-black/50" // the dark stage in TB8-09')],
    ]);
    expect(findDarkVariants(planted)).toEqual(["fixture-dark-nested.tsx", "fixture-dark.tsx"]);
  });

  it("has no `dark:` variant in the 22 vendored files", () => {
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
  it("self-test: the real detector fires on a planted `shadow-md` and a variant-prefixed `hover:shadow-xs`, not on `shadow-none`, a `box-shadow` transition, or a comment naming the trap", () => {
    const planted = new Map([["fixture.tsx", stripComments('"ring-1 ring-foreground/10 shadow-md"\n"hover:bg-background hover:shadow-xs"\n// not shadow-xl, just this comment')]]);
    expect(findShadowClasses(planted)).toEqual({ "fixture.tsx": 2 });
    expect(findShadowClasses(new Map([["f.tsx", 'className="shadow-none transition-[background-color,box-shadow,color]"']]))).toEqual({});
    expect(findShadowClasses(new Map([["f.tsx", "// no box-shadow needed here"]]))).toEqual({});
  });

  it("has no shadow class beyond the (empty) allowlist", () => {
    const found = findShadowClasses(readVendoredFiles());
    const over = Object.entries(found)
      .filter(([name, count]) => count > (SHADOW_ALLOWLIST[name]?.length ?? 0))
      .map(([name, count]) => `  ${name}: ${count} (allowlist ${SHADOW_ALLOWLIST[name]?.length ?? 0})`);
    expect(over, [
      "A shadow-(xs|sm|md|lg|xl) class survives outside SHADOW_ALLOWLIST. The Portal's elevation",
      "convention is hairline borders, not drop shadow (styles/tokens/spacing.css). Remove the class",
      "in favour of the hairline the surface already carries (`ring-1 ring-foreground/10`, a border).",
      ...over,
    ].join("\n")).toEqual([]);
  });

  it("keeps the allowlist honest — it stays empty", () => {
    expect(SHADOW_ALLOWLIST, "SHADOW_ALLOWLIST grew. Shrink it back — see this file's header.").toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Detector 3 — a hex or rgb()/rgba() colour literal (the widened, bracketed-anywhere form)
// ---------------------------------------------------------------------------
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
  it("self-test: the real detector fires on a bracketed hex, a TYPED bracketed hex, a hex buried in a longer bracketed value, a quoted hex, and rgba(); not on an issue reference or a comment naming the trap", () => {
    const planted = new Map([
      ["fixture-hex-bracket.tsx", stripComments('className="bg-[#0a0a0a]"')],
      ["fixture-hex-typed.tsx", stripComments('className="bg-[color:#fff]"')],
      ["fixture-hex-buried.tsx", stripComments('"[mask-image:linear-gradient(to_right,#000_calc(100%-0.75rem),transparent)]"')],
      ["fixture-hex-quoted.tsx", stripComments('style.background = "#0a0a0a"')],
      ["fixture-rgb.tsx", stripComments("color-mix(in oklab, rgba(0,0,0,.4) 20%, transparent)")],
      ["fixture-clean.tsx", stripComments("// bg-[#0a0a0a] mentioned only in a comment, for #255\nconst issue = 255")],
    ]);
    expect(findColorLiterals(planted)).toEqual({
      "fixture-hex-bracket.tsx": ["hex"],
      "fixture-hex-typed.tsx": ["hex"],
      "fixture-hex-buried.tsx": ["hex"],
      "fixture-hex-quoted.tsx": ["hex"],
      "fixture-rgb.tsx": ["rgb()"],
    });
  });

  it("has no hex or rgb()/rgba() literal in the 22 vendored files", () => {
    const found = findColorLiterals(readVendoredFiles());
    const offenders = Object.entries(found).map(([name, hits]) => `  ${name}: ${hits.join(", ")}`);
    expect(offenders, [
      "A literal colour survives instead of a semantic token (styles/tokens/colors.css,",
      "tokens/tailwind.css). Found in:",
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
      ["fixture-clean.tsx", stripComments('className="bg-background text-foreground ring-foreground/10"\n// not bg-slate-500, that is just a comment')],
      ["fixture-var.tsx", stripComments('value: "var(--color-blue-500)"')],
    ]);
    expect(findNonTokenPalette(planted)).toEqual(
      ["fixture-black.tsx", "fixture-gray.tsx", "fixture-slate.tsx", "fixture-white.tsx"].sort()
    );
  });

  it("has no non-token palette class in the 22 vendored files", () => {
    const offenders = findNonTokenPalette(readVendoredFiles());
    expect(offenders, [
      "A Tailwind core-palette class (or a bare black/white paint utility) survives instead of a",
      "semantic token. The brand is monochrome (styles/tokens/colors.css). Found in:",
      ...offenders.map((name) => `  ${name}`),
    ].join("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Detector 5 — `outline-none` paired with a `focus-visible:ring-*` class
// ---------------------------------------------------------------------------
// `styles/tokens/base.css`'s UNLAYERED `:focus-visible { outline }` beats `@layer utilities`, so the
// pair ADDS a second focus indicator instead of replacing the global one. File-level detection, as
// in the Gantt guard: the two classes may sit in separate string arguments to one `cn()` call.
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
      ["fixture-same-string.tsx", stripComments('className="outline-none focus-visible:ring-2 focus-visible:ring-ring/50"')],
      ["fixture-separate-args.tsx", stripComments('cn("rounded-md outline-none", "focus-visible:ring-ring/50 focus-visible:ring-2")')],
      ["fixture-outline-only.tsx", stripComments('className="rounded-sm outline-none"')],
      ["fixture-ring-only.tsx", stripComments('className="focus-visible:ring-2 focus-visible:ring-ring/50"')],
      ["fixture-clean.tsx", stripComments('// outline-none and focus-visible:ring-2 mentioned only in this comment\nclassName="rounded-sm"')],
    ]);
    expect(findOutlineRingPairs(planted)).toEqual(["fixture-same-string.tsx", "fixture-separate-args.tsx"].sort());
  });

  it("has no `outline-none` / `focus-visible:ring-*` pairing in the 22 vendored files", () => {
    const offenders = findOutlineRingPairs(readVendoredFiles());
    expect(offenders, [
      "outline-none paired with focus-visible:ring-* adds a SECOND focus indicator instead of",
      "replacing the global one (styles/tokens/base.css's unlayered `:focus-visible { outline }`).",
      "Drop both classes and let the global outline stand. Found in:",
      ...offenders.map((name) => `  ${name}`),
    ].join("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Detector 8 — square surfaces: no `rounded-lg`/`rounded-xl`/`rounded-2xl` or larger
// ---------------------------------------------------------------------------
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
      ["fixture-lg.tsx", stripComments('"ring-1 ring-foreground/10 rounded-lg"')],
      ["fixture-xl.tsx", stripComments('className="rounded-xl"')],
      ["fixture-2xl.tsx", stripComments('className="rounded-2xl"')],
      ["fixture-corner.tsx", stripComments('className="rounded-tl-lg rounded-br-lg"')],
      ["fixture-side.tsx", stripComments('className="rounded-t-xl"')],
      ["fixture-clean.tsx", stripComments('className="rounded-sm rounded-xs rounded-md rounded-none rounded-full"\n// not rounded-lg, just this comment')],
    ]);
    expect(findLargeRadii(planted)).toEqual({
      "fixture-lg.tsx": ["rounded-lg"],
      "fixture-xl.tsx": ["rounded-xl"],
      "fixture-2xl.tsx": ["rounded-2xl"],
      "fixture-corner.tsx": ["rounded-tl-lg", "rounded-br-lg"],
      "fixture-side.tsx": ["rounded-t-xl"],
    });
  });

  it("has no rounded-lg/rounded-xl/rounded-2xl (or larger) class in the 22 vendored files", () => {
    const found = findLargeRadii(readVendoredFiles());
    const offenders = Object.entries(found).map(([name, hits]) => `  ${name}: ${hits.join(", ")}`);
    expect(offenders, [
      "A rounded-lg/rounded-xl/rounded-2xl (or larger) class survives in the vendored filters tree.",
      "The brand is square-ish (styles/tokens/spacing.css). Found in:",
      ...offenders,
    ].join("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Detector 9 — `bg-accent` without `text-accent-foreground` in the same class string
// ---------------------------------------------------------------------------
// Quincy's `--accent` is `--ink-900` (`styles/tokens/colors.css`), so a `bg-accent` fill that leaves
// the text at `foreground` paints ink on ink: browser pass F found the chip's operator and value
// labels vanishing under `hover:bg-accent`. Scoped per string literal (`"…"`, `'…'`, `` `…` ``),
// because the pair has to travel together, and paired by variant prefix: `<variants>:bg-accent` is
// satisfied only by `<same variants>:text-accent-foreground` (a bare fill by a bare foreground), so
// `hover:bg-accent focus:text-accent-foreground` still paints ink on ink on hover.
// `bg-accent-foreground` is a different class and does not count; an opacity suffix (`bg-accent/50`)
// and any variant prefix do.
const STRING_LITERAL = /"[^"\n]*"|'[^'\n]*'|`[^`]*`/g;
/** A class token: `<variants:>bg-accent`, optionally `/opacity` and a trailing `!`. Group 1 is the variant prefix. */
const BG_ACCENT_TOKEN = /^((?:\S*:)?)bg-accent(?:\/\S+)?!?$/;
/** `<variants:>text-accent-foreground`, optionally with a trailing `!`. Group 1 is the variant prefix. */
const TEXT_ACCENT_FOREGROUND_TOKEN = /^((?:\S*:)?)text-accent-foreground!?$/;

/** True when some `bg-accent` token in the literal has no `text-accent-foreground` under the same variants. */
function hasUnpairedAccentFill(literal: string): boolean {
  const tokens = literal.split(/\s+/).map((token) => token.replace(/^["'`]+|["'`]+$/g, ""));
  const fills = tokens.flatMap((token) => BG_ACCENT_TOKEN.exec(token)?.[1] ?? []);
  const foregrounds = new Set(tokens.flatMap((token) => TEXT_ACCENT_FOREGROUND_TOKEN.exec(token)?.[1] ?? []));
  return fills.some((variants) => !foregrounds.has(variants));
}

function findUnpairedAccentFills(files: Map<string, string>): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const [name, text] of files) {
    const hits = (text.match(STRING_LITERAL) ?? []).filter(hasUnpairedAccentFill);
    if (hits.length > 0) found[name] = hits;
  }
  return found;
}

describe("guard: no `bg-accent` without `text-accent-foreground` in the same class string", () => {
  it("self-test: the real detector fires on the two chip segments and the cascader retry as shipped, on an opacity suffix, and on a foreground under different variants; not on a paired fill, `bg-accent-foreground`, or a comment naming the trap", () => {
    const planted = new Map([
      ["fixture-chip.tsx", stripComments('cn(\n  "hover:bg-accent bg-background cursor-default",\n  incomplete ? "text-foreground" : "text-muted-foreground"\n)')],
      ["fixture-retry.tsx", stripComments('className="text-foreground hover:bg-accent focus-visible:ring-ring/50 rounded-md px-2 py-0.5"')],
      ["fixture-opacity.tsx", stripComments("const ROW = `data-highlighted:bg-accent/50 gap-2`")],
      ["fixture-other-variant.tsx", stripComments('"hover:bg-accent focus:text-accent-foreground"')],
      ["fixture-bare-text.tsx", stripComments('"hover:bg-accent text-accent-foreground"')],
      ["fixture-bare-fill.tsx", stripComments('"bg-accent hover:text-accent-foreground"')],
      [
        "fixture-clean.tsx",
        stripComments(
          [
            '"text-muted-foreground hover:bg-accent hover:text-accent-foreground"',
            '"data-highlighted:bg-accent data-highlighted:text-accent-foreground"',
            '"aria-expanded:bg-accent aria-expanded:text-accent-foreground"',
            "`hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground`",
            '"bg-accent-foreground"',
            '"bg-accent text-accent-foreground"',
            '"focus:bg-accent focus:text-accent-foreground"',
            '"dark:hover:bg-accent/50 dark:hover:text-accent-foreground"',
            "// not `hover:bg-accent` alone, just this comment",
          ].join("\n"),
        ),
      ],
    ]);
    expect(Object.keys(findUnpairedAccentFills(planted)).sort()).toEqual([
      "fixture-bare-fill.tsx",
      "fixture-bare-text.tsx",
      "fixture-chip.tsx",
      "fixture-opacity.tsx",
      "fixture-other-variant.tsx",
      "fixture-retry.tsx",
    ]);
    expect(findUnpairedAccentFills(planted)["fixture-chip.tsx"]).toEqual(['"hover:bg-accent bg-background cursor-default"']);
  });

  it("has no unpaired `bg-accent` in the 22 vendored files", () => {
    const found = findUnpairedAccentFills(readVendoredFiles());
    const offenders = Object.entries(found).map(([name, hits]) => `  ${name}: ${hits.join(" | ")}`);
    expect(offenders, [
      "A `bg-accent` fill without `text-accent-foreground` in the same class string. Quincy's",
      "`--accent` is `--ink-900`, so the text left at `foreground` disappears on it. Use `bg-muted`",
      "(the `.button--secondary:hover` surface) or pair the fill with its foreground. Found in:",
      ...offenders,
    ].join("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sanity — the scan reads the real vendored files, and no new file escapes the lists
// ---------------------------------------------------------------------------
/** A vendored source a re-vendor could add: any `.tsx`/`.ts`/`.jsx`/`.js` file that is not a test. */
function isVendoredSource(name: string): boolean {
  return /\.(?:tsx|ts|jsx|js)$/.test(name) && !name.includes(".test.");
}

describe("the file scan itself", () => {
  it("reads all 22 vendored files with real content", () => {
    const files = readVendoredFiles();
    expect(files.size).toBe(22);
    for (const [name, text] of files) expect(text.length, `${name} read as empty`).toBeGreaterThan(200);
  });

  it("self-test: discovery counts every non-test .tsx/.ts/.jsx/.js source, and nothing else", () => {
    const listing = ["a.tsx", "b.ts", "c.jsx", "d.js", "e.test.ts", "f.dom.test.tsx", "g.guard.test.js", "h.css", "i.json", "j.md"];
    expect(listing.filter(isVendoredSource)).toEqual(["a.tsx", "b.ts", "c.jsx", "d.js"]);
  });

  it("lists every non-test source file in filters/ and cascader/ — a re-vendor cannot add an unscanned file", () => {
    const onDisk = (dir: string) => readdirSync(dir).filter(isVendoredSource).sort();
    expect(onDisk(filtersDir)).toEqual([...FILTERS_FILES].sort());
    expect(onDisk(cascaderDir)).toEqual([...CASCADER_FILES].sort());
  });

  it("phone stacking (#461): the row bands wrap and the cells grow below the track breakpoint", () => {
    const text = readFileSync(join(filtersDir, "filters-advanced.tsx"), "utf8");
    expect(text).toContain('ROW_BAND_CLASS = "flex min-w-0 items-center gap-1.5 @max-[26rem]/track:flex-wrap"');
    expect(text).toContain("@max-[26rem]/track:order-last @max-[26rem]/track:basis-full");
    expect(text).toContain("@max-[26rem]/track:basis-full @max-[26rem]/track:flex-wrap");
    // Explicit halves, never basis-auto: the cells are size containers, so an auto basis collapses them (#461).
    expect(text).toContain('PHONE_LABEL_CELL_CLASS = "@max-[26rem]/track:basis-[calc(50%-0.1875rem)] @max-[26rem]/track:shrink-0"');
    expect(text).not.toContain("@max-[26rem]/track:basis-auto");
    expect(text).toMatch(/FIELD_CELL_CLASS = cn\(.*PHONE_LABEL_CELL_CLASS\)/);
    expect(text).toMatch(/OPERATOR_CELL_CLASS = cn\(.*PHONE_LABEL_CELL_CLASS\)/);
    expect(text).toContain('VALUE_CELL_CLASS = "basis-[var(--filter-value-width,12rem)] @max-[26rem]/track:basis-full"');
    expect(text).toContain("@max-[26rem]/track:justify-start");
    expect(text).toContain('"ps-2 pe-0 @max-[26rem]/track:pe-2"');
    expect(text).toContain("max-w-[calc(100vw-2*var(--space-4))]");
  });
});
