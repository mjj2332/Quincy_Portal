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
});
