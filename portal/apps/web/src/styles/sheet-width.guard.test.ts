/**
 * Guard (#648): a consumer's `<SheetContent className>` must set its width only through a
 * `data-[side=…]` variant. `reui/sheet.tsx` carries `data-[side=left]:w-3/4` (and a right-side
 * equivalent); tailwind-merge does not merge across variants, so a plain `w-[320px]` survives the
 * merge but LOSES on specificity to the data-variant width. See docs/lessons.md § "A plain width on
 * a SheetContent loses to the sheet's data-side width".
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = fileURLToPath(new URL("..", import.meta.url));
const reuiDir = join(srcDir, "components", "reui") + sep;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [full] : [];
  });
}

/** Every `<SheetContent …>` opening tag's text (up to the tag's closing `>` at brace depth 0). */
function sheetContentTags(text: string): string[] {
  const tags: string[] = [];
  for (const match of text.matchAll(/<SheetContent\b/g)) {
    let depth = 0;
    let i = match.index!;
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      else if (ch === ">" && depth === 0 && text[i - 1] !== "=") break;
    }
    tags.push(text.slice(match.index!, i));
  }
  return tags;
}

const WIDTH_TOKEN = /^(?:max-)?(?:w|min-w)-/;

/** Plain (no variant prefix) width utilities in a tag's string literals. */
export function plainWidthTokens(tag: string): string[] {
  const literals = [...tag.matchAll(/"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2] ?? "");
  return literals
    .flatMap((literal) => literal.split(/\s+/))
    .filter((token) => WIDTH_TOKEN.test(token));
}

describe("SheetContent width goes through a data-side variant (#648)", () => {
  it("detector: flags a plain width, accepts a data-side one", () => {
    expect(plainWidthTokens('<SheetContent className="w-[320px] max-w-[90vw] gap-0"')).toEqual(["w-[320px]", "max-w-[90vw]"]);
    expect(plainWidthTokens('<SheetContent className="data-[side=left]:w-[320px] data-[side=left]:max-w-[90vw]"')).toEqual([]);
  });

  it("no consumer SheetContent outside components/reui/ sets a plain w-/max-w- utility", () => {
    const offenders: string[] = [];
    for (const file of walk(srcDir)) {
      if (file.startsWith(reuiDir)) continue;
      for (const tag of sheetContentTags(readFileSync(file, "utf8"))) {
        for (const token of plainWidthTokens(tag)) offenders.push(`${relative(srcDir, file).split(sep).join("/")}: ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
