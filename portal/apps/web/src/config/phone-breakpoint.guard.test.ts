import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * #692: the phone spelling is `max-[721px]:` (compiles to width < 721, i.e. <= 720, the same set as
 * `(max-width: 720px)`); its desktop counterpart is `min-[721px]:`. `max-[720px]:` leaves 720 in neither
 * variant, `min-[722px]:` leaves 721. Source-text guard; happy-dom resolves no media queries.
 */
const OFF_BY_ONE = /\b(?:max|min)-\[(?:719|720|722)px\]/g;

export function offByOneBreakpoints(source: string): string[] {
  const hits: string[] = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    hits.push(...(line.match(OFF_BY_ONE) ?? []));
  }
  return hits;
}

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionFiles(full));
    else if (/\.(?:ts|tsx|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("offByOneBreakpoints", () => {
  it("flags max-[720px] and min-[722px]", () => {
    expect(offByOneBreakpoints('const a = "max-[720px]:min-h-[44px] min-[722px]:pe-12";')).toEqual(["max-[720px]", "min-[722px]"]);
  });
  it("accepts the 721 spelling", () => {
    expect(offByOneBreakpoints('const a = "max-[721px]:flex min-[721px]:hidden";')).toEqual([]);
  });
  it("skips comment lines", () => {
    expect(offByOneBreakpoints("// `max-[720px]:` alone is wrong\n * min-[722px]: too\n/* max-[719px]: */")).toEqual([]);
  });
  it("ignores unrelated breakpoints", () => {
    expect(offByOneBreakpoints('"max-[730px]:flex min-[1024px]:grid"')).toEqual([]);
  });
});

describe("phone breakpoint spelling (#692)", () => {
  const files = productionFiles(srcRoot);

  it("scans production sources", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no production file uses an off-by-one phone breakpoint", () => {
    const offenders = files.flatMap((f) => offByOneBreakpoints(readFileSync(f, "utf8")).map((hit) => `${relative(srcRoot, f)}: ${hit}`));
    expect(offenders).toEqual([]);
  });
});
