/**
 * Retired-rail-collapse guard — #426 (ADR 0015).
 *
 * The shell's rail is always the icon column. Its collapse control, ⌘B shortcut and stored
 * preference are RETIRED — not ported — so nothing in non-test application source may name the
 * pieces that implemented them: the `quincy:shell:rail` storage key, `isRailShortcut`,
 * `RailPreference`, or the `rail-toggle` test id. A reappearance means someone restored a retired
 * behaviour (likely by re-running the shadcn CLI over `components/reui/sidebar.tsx` and keeping the
 * vendor's keyboard handler, or by reviving the preference), and ADR 0015 is what to read before
 * doing that on purpose.
 *
 * Same shape as `no-document-cookie.guard.test.ts`: comments are stripped first, so prose that
 * *describes* the retirement does not trip it; the detector is a pure function over injected text,
 * proven against planted positives and a planted negative, alongside a floor on how many real files
 * the scan reads (per `docs/lessons.md` — "a grep gate that cannot fail is not a gate").
 *
 * `rail-toggle` is matched as a whole test-id token: `event-calendar-rail-toggle` (the Production
 * Event Calendar's own, unrelated control) must not trip it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const configDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(configDir, "..");

/** Strips `/* *\/` and `//` comments, mirroring the other source guards. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const RETIRED = [
  { name: "the quincy:shell:rail storage key", pattern: /quincy:shell:rail/ },
  { name: "isRailShortcut", pattern: /\bisRailShortcut\b/ },
  { name: "RailPreference", pattern: /\bRailPreference\b/ },
  { name: "the rail-toggle test id", pattern: /(?<![\w-])rail-toggle(?![\w-])/ },
] as const;

/** Pure detector: which retired names does this source use outside a comment? */
export function retiredRailNamesIn(source: string): string[] {
  const stripped = stripComments(source);
  return RETIRED.filter(({ pattern }) => pattern.test(stripped)).map(({ name }) => name);
}

function isTestFile(file: string): boolean {
  return /\.test\.tsx?$/.test(file);
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function appFiles(): Array<{ path: string; source: string }> {
  return walkTsFiles(srcDir)
    .filter((file) => !isTestFile(file))
    .map((file) => ({ path: relative(srcDir, file).split("\\").join("/"), source: readFileSync(file, "utf8") }));
}

describe("guard: the retired rail-collapse pieces stay retired (#426, ADR 0015)", () => {
  it("scans real, non-test application source", () => {
    const files = appFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files.map((file) => file.path)).toEqual(
      expect.arrayContaining(["components/quincy/NavigationRail.tsx", "components/quincy/RailedShell.tsx", "components/reui/sidebar.tsx", "lib/shell-rail.ts"]),
    );
    expect(files.every((file) => !isTestFile(file.path))).toBe(true);
  });

  it("finds no retired name in the real scan", () => {
    const offenders = appFiles()
      .map((file) => ({ path: file.path, names: retiredRailNamesIn(file.source) }))
      .filter((file) => file.names.length > 0)
      .map((file) => `  ${file.path}: ${file.names.join(", ")}`);
    expect(
      offenders,
      [
        "The rail has no collapse control, ⌘B shortcut or stored preference (ADR 0015). These files",
        "name a piece of that retired behaviour:",
        ...offenders,
      ].join("\n"),
    ).toEqual([]);
  });

  it("does not flag the real sidebar primitive, whose header describes the retired ⌘B patch in prose", () => {
    const sidebarSource = readFileSync(join(srcDir, "components", "reui", "sidebar.tsx"), "utf8");
    expect(retiredRailNamesIn(sidebarSource)).toEqual([]);
  });
});

describe("guard self-test: the detector fires on planted retired names", () => {
  it("catches the storage key", () => {
    expect(retiredRailNamesIn('window.localStorage.getItem("quincy:shell:rail");')).toContain("the quincy:shell:rail storage key");
  });

  it("catches isRailShortcut", () => {
    expect(retiredRailNamesIn('import { isRailShortcut } from "@/lib/shell-rail";')).toContain("isRailShortcut");
  });

  it("catches RailPreference", () => {
    expect(retiredRailNamesIn('type Stored = RailPreference;')).toContain("RailPreference");
  });

  it("catches the rail-toggle test id", () => {
    expect(retiredRailNamesIn('<SidebarTrigger data-testid="rail-toggle" />')).toContain("the rail-toggle test id");
  });

  it("ignores the same names inside comments", () => {
    expect(retiredRailNamesIn("/* isRailShortcut and quincy:shell:rail were retired */\n// RailPreference rail-toggle")).toEqual([]);
  });

  it("does not mistake the Production Event Calendar's own, unrelated rail-toggle for the retired one", () => {
    expect(retiredRailNamesIn('data-testid="event-calendar-rail-toggle"')).toEqual([]);
  });

  it("still catches a real use on the line right after a comment mentioning it", () => {
    expect(retiredRailNamesIn("// do not use isRailShortcut\nconst leaked = isRailShortcut;")).toContain("isRailShortcut");
  });
});
