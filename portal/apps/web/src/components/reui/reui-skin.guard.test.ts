/**
 * ReUI re-skin guard, the whole vendored tree (#239).
 *
 * The Gantt, Filters/Cascader and Event Calendar trees each have their own skin guard, but the
 * primitives beside them (`badge`, `button`, `select`, `dialog`, …) were adopted without one, and
 * carried 72 `dark:` variants, 16 Tailwind drop shadows and two `bg-black/10` scrims. This guard
 * reads EVERY non-test `.tsx` under `components/reui/` as text, comments stripped (so a header
 * naming a trap is never mistaken for it), and fails on three things:
 *
 * 1. A `dark:` variant. `styles/tokens/reui.css` rebinds `dark` to a `.dark` class nothing sets, so
 *    each one is dead weight that tells the next reader a dark mode exists. It does not.
 * 2. A Tailwind shadow-scale utility (`shadow-sm`, `hover:shadow-xs`, …). Tailwind compiles those to
 *    its own default values, not Quincy's. The tokens (`styles/tokens/spacing.css`) keep shadows
 *    "whisper-quiet; used rarely, only for overlays": a popup carries its hairline ring instead, as
 *    the four earlier re-skins settled, and an overlay above a scrim names the token itself —
 *    `shadow-[var(--shadow-lg)]`. `shadow-none` and an arbitrary `shadow-[…]` pass.
 * 3. A `bg-black`/`bg-white` paint, e.g. a scrim. Overlays use `bg-[var(--scrim-overlay)]`, as
 *    `components/Modal.tsx` does.
 *
 * 4. A ring WIDTH under any focus variant (`focus:`, `focus-visible:`, `focus-within:`, `has-[…focus…]:`,
 *    `group-focus*`, `group-has-[…focus…]:`, `peer-focus*`) (#458). Quincy's one focus indicator is the
 *    `:focus-visible` outline in `styles/tokens/base.css`; a vendored ring is a second, differently
 *    shaped one painted beside it. A ring COLOUR (`ring-ring/50`) is not a width and passes. The
 *    files in `FOCUS_RING_EXCEPTIONS` predate this guard and are still to be reconciled; the list
 *    may only shrink (a stale entry fails).
 *
 * Each detector is a pure function over injected text and is self-tested against a planted fixture
 * (`docs/lessons.md`: "a grep gate that cannot fail is not a gate"). There is no allowlist; if a
 * surface genuinely needs an exception, add one here keyed by file, with the reason beside it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const reuiDir = dirname(fileURLToPath(import.meta.url));

/** Blanks `/* … *\/` and `// …` comment bodies so a comment naming a trap is never flagged. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function vendoredFiles(dir = reuiDir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return vendoredFiles(path);
    return name.endsWith(".tsx") && !name.includes(".test.") ? [path] : [];
  });
}

function readVendoredFiles(): Map<string, string> {
  return new Map(vendoredFiles().map((path) => [relative(reuiDir, path), stripComments(readFileSync(path, "utf8"))]));
}

const DARK_VARIANT = /(?<![\w-])dark:[^\s"'`]*/g;
const SHADOW_SCALE = /[^\s"'`]*(?<![\w-])shadow-(?:2xs|xs|sm|md|lg|xl|2xl)(?![\w-])/g;
const BLACK_WHITE_PAINT = /[^\s"'`]*(?<![\w-])bg-(?:black|white)(?![\w-])[^\s"'`]*/g;

/**
 * Ring-width utilities carried by a focus variant (#458). Class tokens are split on the `:` that
 * sits outside `[…]`, so `has-[>[data-slot=field]]:has-[:focus-visible]:ring-3` reads as variants
 * `has-[>[data-slot=field]]`, `has-[:focus-visible]` and utility `ring-3`. `ring-0`, a ring colour
 * and an unfocused ring are not findings.
 */
function focusRingWidths(files: Map<string, string>): string[] {
  const found: string[] = [];
  for (const [name, text] of files) {
    for (const token of text.match(/[^\s"'`]+/g) ?? []) {
      const parts: string[] = [];
      let depth = 0;
      let start = 0;
      for (let i = 0; i < token.length; i += 1) {
        const c = token[i];
        if (c === "[") depth += 1;
        else if (c === "]") depth -= 1;
        else if (c === ":" && depth === 0) { parts.push(token.slice(start, i)); start = i + 1; }
      }
      const utility = token.slice(start).replace(/^!/, "").replace(/!$/, "");
      // A `data-[focused=true]` attribute variant (the calendar's day cell) is app state, not keyboard focus.
      if (!parts.some((variant) => /focus/.test(variant.replace(/data-\[[^\]]*\]/g, "")))) continue;
      if (/^ring(?:-(?!0$)\d+)?$/.test(utility) || /^ring-\[(?:length:[^\]]+|[\d.]+(?:px|rem)?)\]$/.test(utility)) found.push(`${name}: ${token}`);
    }
  }
  return found.sort();
}

/** Files that still carry a focus ring width (#458). Shrink-only: reconcile a file, then delete its entry. */
const FOCUS_RING_EXCEPTIONS: ReadonlyMap<string, number> = new Map<string, number>([
  // Known latent double indicators (a vendored ring beside the base.css outline), not fixed here.
  ["cascader/cascader-nav.tsx", 2],
  ["cascader/cascader.tsx", 2],
  ["field.tsx", 1],
  ["item.tsx", 1], // known latent double indicator, not fixed here
  ["scroll-area.tsx", 1], // known latent double indicator, not fixed here
  ["switch.tsx", 1],
]);

/** Every match of `pattern`, as `file: class`, sorted. */
function offenders(files: Map<string, string>, pattern: RegExp): string[] {
  const found: string[] = [];
  for (const [name, text] of files) for (const match of text.matchAll(pattern)) found.push(`${name}: ${match[0]}`);
  return found.sort();
}

describe("detectors (planted fixtures)", () => {
  const fixture = new Map([
    ["planted.tsx", stripComments('cn("dark:bg-input/30 data-open:dark:ring-2", "shadow-md hover:shadow-xs", "bg-black/10 bg-white")')],
    ["clean.tsx", stripComments('cn("shadow-none shadow-[var(--shadow-lg)] ring-1 bg-[var(--scrim-overlay)] bg-background")\n// dark: shadow-md bg-black/10\n/* dark: shadow-md */')],
  ]);

  it("finds a dark: variant, including behind another variant", () => {
    expect(offenders(fixture, DARK_VARIANT)).toEqual(["planted.tsx: dark:bg-input/30", "planted.tsx: dark:ring-2"]);
  });

  it("finds a Tailwind shadow-scale utility, but not shadow-none or the token", () => {
    expect(offenders(fixture, SHADOW_SCALE)).toEqual(["planted.tsx: hover:shadow-xs", "planted.tsx: shadow-md"]);
  });

  it("finds a ring width under a focus variant, but not a colour, ring-0 or an unfocused ring", () => {
    const planted = new Map([
      ["planted.tsx", stripComments('cn("focus-within:ring-3 focus-visible:ring-2 has-[>[data-slot=field]]:has-[:focus-visible]:ring-3 group-focus:ring peer-focus-visible:ring-[3px] focus-visible:ring-3! focus:!ring-2 focus-visible:ring-[length:var(--border-width-bold)] focus:ring-[3px]!")')],
      ["clean.tsx", stripComments('cn("focus-visible:ring-[color:var(--ring)] focus-visible:ring-[var(--ring)] focus-visible:ring-ring/50! focus-visible:ring-0! group-data-[focused=true]/day:ring-[3px] data-[focused=true]:ring-2 ring-0 focus-visible:ring-0 focus-visible:ring-ring/50 aria-invalid:ring-3 has-aria-invalid:ring-3 ring-1 ring-foreground/10 focus-visible:border-ring")\n// focus-within:ring-3\n/* focus:ring-2 */')],
    ]);
    expect(focusRingWidths(planted)).toEqual([
      "planted.tsx: focus:!ring-2",
      "planted.tsx: focus-visible:ring-3!",
      "planted.tsx: focus-visible:ring-[length:var(--border-width-bold)]",
      "planted.tsx: focus:ring-[3px]!",
      "planted.tsx: focus-within:ring-3",
      "planted.tsx: focus-visible:ring-2",
      "planted.tsx: group-focus:ring",
      "planted.tsx: has-[>[data-slot=field]]:has-[:focus-visible]:ring-3",
      "planted.tsx: peer-focus-visible:ring-[3px]",
    ].sort());
  });

  it("finds a black or white paint, but not the scrim token", () => {
    expect(offenders(fixture, BLACK_WHITE_PAINT)).toEqual(["planted.tsx: bg-black/10", "planted.tsx: bg-white"]);
  });
});

describe("components/reui/ (#239)", () => {
  const files = readVendoredFiles();

  it("reads the whole tree, subdirectories included", () => {
    expect(files.has("badge.tsx")).toBe(true);
    expect(files.has("gantt/gantt-view.tsx")).toBe(true);
    expect([...files.keys()].some((name) => name.includes(".test."))).toBe(false);
  });

  it("carries no dark: variant", () => {
    expect(offenders(files, DARK_VARIANT)).toEqual([]);
  });

  it("carries no Tailwind shadow-scale utility", () => {
    expect(offenders(files, SHADOW_SCALE)).toEqual([]);
  });

  it("paints no black or white", () => {
    expect(offenders(files, BLACK_WHITE_PAINT)).toEqual([]);
  });

  it("paints no ring width under a focus variant, beyond the shrink-only exceptions (#458)", () => {
    const counts = new Map<string, number>();
    for (const entry of focusRingWidths(files)) {
      const file = entry.slice(0, entry.indexOf(": "));
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual(Object.fromEntries(FOCUS_RING_EXCEPTIONS));
  });

  it("keeps combobox.tsx free of any focus ring width, with no exception", () => {
    expect(focusRingWidths(new Map([["combobox.tsx", files.get("combobox.tsx")!]]))).toEqual([]);
    expect(FOCUS_RING_EXCEPTIONS.has("combobox.tsx")).toBe(false);
  });
});
