/**
 * No-cookie guard — #112, AC3.
 *
 * The rail's collapse preference persists to `localStorage` under `quincy:shell:rail`
 * (`lib/shell-rail.ts`), never a cookie. The registry's own `sidebar.tsx` primitive persists its
 * collapse cookie because it is built for server rendering; this app renders only in the browser
 * and keeps every preference under the `quincy:` namespace in `localStorage` instead. Adopting the
 * cookie would import a constraint this app does not have — see the "Collapse" section of the
 * `#112` issue body (`112-issue.md` in the P1 build's scratchpad).
 *
 * This scans non-test application source for `document.cookie` or `cookieStore` — the two ways a
 * browser script reads or writes a cookie — with comments stripped first, so a file that merely
 * *describes* the vendor's cookie approach (as `components/reui/sidebar.tsx`'s header comment
 * does) is not itself flagged as introducing one.
 *
 * Per `docs/lessons.md` — "a grep gate that cannot fail is not a gate" — the detector is a pure
 * function over injected text, proven against both a planted positive (a real cookie write) and a
 * planted negative (the same text, but inside a comment) fixture below, alongside a floor on how
 * many real files the scan actually reads.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const configDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(configDir, "..");

/** Strips `/* *\/` and `//` comments, mirroring `stripComments` in the sidebar token bridge guard. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Pure detector: does this source access `document.cookie` or `cookieStore` outside a comment? */
export function usesCookieAccess(source: string): boolean {
  const stripped = stripComments(source);
  return /\bdocument\.cookie\b/.test(stripped) || /\bcookieStore\b/.test(stripped);
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

describe("guard: no document.cookie or cookieStore access is introduced anywhere (#112 AC3)", () => {
  it("scans real, non-test application source", () => {
    // A floor, not a fixed count — if the scan ever narrowed to an empty or near-empty directory,
    // every assertion below would pass vacuously.
    const files = appFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files.map((file) => file.path)).toContain("lib/shell-rail.ts");
    expect(files.every((file) => !isTestFile(file.path))).toBe(true);
  });

  it("finds no cookie access in the real scan", () => {
    const offenders = appFiles()
      .filter((file) => usesCookieAccess(file.source))
      .map((file) => file.path);
    expect(
      offenders,
      [
        "These files read or write a cookie. This app persists every preference to localStorage",
        "under the `quincy:` namespace instead (see lib/shell-rail.ts and the \"Collapse\" section",
        "of issue #112) — a cookie imports a server-rendering constraint this app does not have.",
        ...offenders.map((path) => `  ${path}`),
      ].join("\n"),
    ).toEqual([]);
  });

  it("does not flag a comment that merely describes a cookie, as components/reui/sidebar.tsx's header does", () => {
    // The real negative fixture: sidebar.tsx's header comment names `document.cookie` in prose,
    // describing why the vendor's SidebarProvider was discarded. It must not trip this guard.
    const sidebarSource = readFileSync(join(srcDir, "components", "reui", "sidebar.tsx"), "utf8");
    expect(sidebarSource).toContain("document.cookie");
    expect(usesCookieAccess(sidebarSource)).toBe(false);
  });
});

describe("guard self-test: the detector fires on a planted cookie access", () => {
  it("catches a direct document.cookie write", () => {
    expect(usesCookieAccess('document.cookie = "quincy:shell:rail=collapsed";')).toBe(true);
  });

  it("catches a direct document.cookie read", () => {
    expect(usesCookieAccess("const raw = document.cookie;")).toBe(true);
  });

  it("catches the cookieStore API", () => {
    expect(usesCookieAccess('await cookieStore.set("quincy:shell:rail", "collapsed");')).toBe(true);
  });

  it("ignores the same text inside a block comment", () => {
    expect(usesCookieAccess("/* document.cookie is what the vendor primitive uses */")).toBe(false);
  });

  it("ignores the same text inside a line comment", () => {
    expect(usesCookieAccess("// cookieStore is the modern replacement for document.cookie")).toBe(false);
  });

  it("still catches a real access on the line right after a comment mentioning it", () => {
    const source = "// do not use document.cookie\nconst leaked = document.cookie;";
    expect(usesCookieAccess(source)).toBe(true);
  });
});
