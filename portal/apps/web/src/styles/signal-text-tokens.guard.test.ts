/**
 * #431 review D1 -- `text-signal-critical-text` was used for the overdue Deadline, but the Tailwind
 * theme bridge (`tokens/tailwind.css`) declares only `--color-signal-critical`. A utility with no
 * matching `--color-*` emits no CSS, so the overdue Deadline never turned red and nothing failed.
 *
 * Guard: every `<prefix>-signal-<name>` colour utility used in non-test source must resolve to a
 * `--color-signal-<name>` declared in `tokens/tailwind.css`. The detector is a pure function over
 * injected text, proven against a planted negative ("a grep gate that cannot fail is not a gate").
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const COLOR_PREFIXES = "text|bg|border|ring|outline|fill|stroke|from|via|to|divide|decoration|accent|caret|shadow";
// A signal name is lowercase words joined by dashes; it ends at an opacity slash, a quote, a space,
// a bracket or the end of the string. `\b` before the prefix keeps `context-signal-` out.
const USAGE = new RegExp(`(?<![\\w-])(?:${COLOR_PREFIXES})-signal-([a-z]+(?:-[a-z]+)*)(?![\\w-])`, "g");

export function declaredSignalTokens(themeCss: string): Set<string> {
  return new Set([...themeCss.matchAll(/--color-signal-([a-z]+(?:-[a-z]+)*)\s*:/g)].map((match) => match[1]!));
}

export function undeclaredSignalUtilities(source: string, declared: ReadonlySet<string>): string[] {
  return [...source.matchAll(USAGE)].filter((match) => !declared.has(match[1]!)).map((match) => match[0]);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "node_modules" ? [] : sourceFiles(path);
    return /\.(tsx?|css)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

describe("signal colour utilities resolve to declared theme tokens (#431)", () => {
  const declared = declaredSignalTokens(readFileSync(join(srcDir, "styles/tokens/tailwind.css"), "utf8"));

  it("the theme declares the signal tokens the app relies on", () => {
    expect([...declared]).toEqual(expect.arrayContaining(["positive", "caution", "caution-text", "critical", "info"]));
  });

  it("planted negative: a utility with no declared token is reported, a declared one is not", () => {
    expect(undeclaredSignalUtilities('className="text-signal-critical-text"', declared)).toEqual(["text-signal-critical-text"]);
    expect(undeclaredSignalUtilities('className="bg-signal-bogus/10 border-signal-caution/35"', declared)).toEqual(["bg-signal-bogus"]);
    expect(undeclaredSignalUtilities('className="text-signal-critical text-signal-caution-text bg-signal-info/8"', declared)).toEqual([]);
  });

  it("every text-/bg-/border-signal-* utility in src has a declared --color-signal-* token", () => {
    const offences = sourceFiles(srcDir).flatMap((file) => undeclaredSignalUtilities(readFileSync(file, "utf8"), declared).map((utility) => `${relative(srcDir, file)}: ${utility}`));
    expect(offences).toEqual([]);
  });
});
