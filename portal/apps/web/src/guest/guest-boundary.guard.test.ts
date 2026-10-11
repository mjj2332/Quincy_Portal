/**
 * Guards the guest/staff boundary of the Review-link page (#741 12b).
 *
 * `/d/review` is served by the same SPA entry as the staff app but must never reach the staff app's session, API, router or query cache: a guest has no staff session, so a stray
 * `/api` request is an unauthenticated probe of the staff surface, and a router that canonicalises the URL would undo the fragment scrub. Everything under `src/guest/` is held to:
 *
 * - no import of `lib/auth`, `lib/api`, `lib/router`, `lib/app-router`, `lib/query-client`, `InternalLink` or `@tanstack/*`, directly or through anything it imports;
 * - no `locationStore(` call;
 * - `history.` is used only as `history.replaceState`, and only in `link-fragment.ts` (the fragment scrub);
 * - `fetch(` is called only in `guest-api.ts`, and no string literal starts a staff `/api/` path.
 *
 * Per docs/lessons.md ("a grep gate that cannot fail is not a gate") every detector is a pure function over injected input and is falsified with planted fixtures beside the real scan.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const guestDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(guestDir, "..");
const rel = (file: string) => relative(srcDir, file).split("\\").join("/");

type Source = { path: string; source: string };

/** The staff modules a guest file must not reach. Matched on the resolved path (transitive) and on the specifier (direct). */
const BANNED_MODULE = /^(?:lib\/(?:auth|api|router|app-router|query-client|staff-history|location-store)|components\/InternalLink)(?:\.tsx?)?$/;
const BANNED_SPECIFIER = /(?:^|\/)(?:lib\/(?:auth|api|router|app-router|query-client|staff-history)|InternalLink)(?:\.tsx?)?$|^@tanstack\//;

/** Blanks comments so prose in a header cannot trip (or hide) a detector. */
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

export function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const match of strip(source).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.mock\s*\(\s*)["']([^"']+)["']/g)) out.push(match[1]!);
  return out;
}

/** Direct: files importing a banned staff module or TanStack. */
export function findBannedImports(files: Source[]): string[] {
  return files.filter(({ source }) => importSpecifiers(source).some((specifier) => BANNED_SPECIFIER.test(specifier))).map(({ path }) => path).sort();
}
export function findLocationStoreCalls(files: Source[]): string[] {
  return files.filter(({ source }) => /\blocationStore\s*\(/.test(strip(source))).map(({ path }) => path).sort();
}
/** `history.<anything but replaceState or the read-only state>`, and `replaceState` anywhere but the allowed file. */
export function findHistoryMisuse(files: Source[], allowedFile: string): string[] {
  return files.filter(({ path, source }) => {
    const text = strip(source);
    if (/\bhistory\s*\.\s*(?!replaceState\b|state\b)\w+/.test(text) || /\bhistory\s*\[/.test(text)) return true;
    return path !== allowedFile && /\breplaceState\b/.test(text);
  }).map(({ path }) => path).sort();
}
export function findStrayFetch(files: Source[], allowedFile: string): string[] {
  return files.filter(({ path, source }) => path !== allowedFile && /\bfetch\s*\(|\bXMLHttpRequest\b|\bsendBeacon\b|\bEventSource\b|\bWebSocket\b/.test(strip(source))).map(({ path }) => path).sort();
}
export function findStaffApiLiterals(files: Source[]): string[] {
  return files.filter(({ source }) => /["'`]\/api(?:\/|["'`])/.test(strip(source))).map(({ path }) => path).sort();
}

/** Resolves a specifier written in `from` (a path relative to `src/`) to a source file in `files`, or null for a package or a file not in the map. */
function resolve(from: string, specifier: string, known: ReadonlySet<string>): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = specifier.slice(2);
  else if (specifier.startsWith(".")) base = join(dirname(from), specifier).split("\\").join("/");
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (known.has(candidate)) return candidate;
  return null;
}

/**
 * Transitive: every project file reachable from `roots` through relative or `@/` imports, as a path. A guest file that imports a harmless module which imports `lib/api` is the same
 * breach as importing it directly, so the closure is checked against the staff modules.
 */
export function reachableFrom(roots: string[], project: Source[]): Map<string, string> {
  const byPath = new Map(project.map((file) => [file.path, file.source]));
  const known = new Set(byPath.keys());
  const via = new Map<string, string>();
  const queue = [...roots];
  for (const root of roots) via.set(root, root);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const specifier of importSpecifiers(byPath.get(current) ?? "")) {
      const next = resolve(current, specifier, known);
      if (next !== null && !via.has(next)) { via.set(next, current); queue.push(next); }
    }
  }
  return via;
}
export function findReachableStaffModules(roots: string[], project: Source[]): string[] {
  const reached = reachableFrom(roots, project);
  return [...reached.keys()].filter((path) => BANNED_MODULE.test(path)).map((path) => {
    const chain = [path]; let at = path;
    while (reached.get(at) !== at && chain.length < 12) { at = reached.get(at)!; chain.push(at); }
    return chain.reverse().join(" -> ");
  }).sort();
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "node_modules" && entry.name !== "dist") out.push(...walk(full)); }
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}
const isTest = (path: string) => /\.(?:dom\.)?test\.tsx?$/.test(path);
const read = (files: string[]): Source[] => files.map((file) => ({ path: rel(file), source: readFileSync(file, "utf8") })).sort((a, b) => (a.path < b.path ? -1 : 1));

const ALLOWED_HISTORY = "guest/link-fragment.ts";
const ALLOWED_FETCH = "guest/guest-api.ts";
const guestFiles = () => read(walk(guestDir)).filter(({ path }) => !isTest(path));
const projectFiles = () => read(walk(srcDir)).filter(({ path }) => !isTest(path));

describe("guard: the guest tree stays out of the staff app", () => {
  it("has files to scan, including the fragment scrub and the API wrapper", () => {
    const paths = guestFiles().map((file) => file.path);
    expect(paths).toContain(ALLOWED_HISTORY);
    expect(paths).toContain(ALLOWED_FETCH);
    expect(existsSync(join(guestDir, "GuestApp.tsx"))).toBe(true);
  });

  it("imports no staff module, router or TanStack directly", () => {
    expect(findBannedImports(guestFiles())).toEqual([]);
  });

  it("reaches no staff module through anything it imports", () => {
    const roots = guestFiles().map((file) => file.path);
    expect(findReachableStaffModules(roots, projectFiles())).toEqual([]);
  });

  it("never calls locationStore", () => {
    expect(findLocationStoreCalls(guestFiles())).toEqual([]);
  });

  it("uses history only as replaceState, only in link-fragment.ts", () => {
    expect(findHistoryMisuse(guestFiles(), ALLOWED_HISTORY)).toEqual([]);
  });

  it("makes network calls only from guest-api.ts, and never to a staff /api path", () => {
    expect(findStrayFetch(guestFiles(), ALLOWED_FETCH)).toEqual([]);
    expect(findStaffApiLiterals(guestFiles())).toEqual([]);
  });
});

describe("self-test: each detector fires on planted fixtures and spares the clean form", () => {
  it("banned imports", () => {
    const planted: Source[] = [
      { path: "guest/a.tsx", source: 'import { apiGet } from "../lib/api";' },
      { path: "guest/b.tsx", source: 'import { useSession } from "../lib/auth";' },
      { path: "guest/c.tsx", source: 'import { Link } from "@tanstack/react-router";' },
      { path: "guest/d.tsx", source: 'import { InternalLink } from "../components/InternalLink";' },
      { path: "guest/e.tsx", source: 'const m = await import("../lib/query-client");' },
      { path: "guest/f.tsx", source: 'import { x } from "@/lib/app-router";' },
      { path: "guest/ok.tsx", source: 'import { readStoredMarkup } from "../lib/read-stored-markup";\n// import { apiGet } from "../lib/api";' },
    ];
    expect(findBannedImports(planted)).toEqual(["guest/a.tsx", "guest/b.tsx", "guest/c.tsx", "guest/d.tsx", "guest/e.tsx", "guest/f.tsx"]);
  });

  it("transitive staff reach", () => {
    const project: Source[] = [
      { path: "guest/G.tsx", source: 'import { helper } from "../components/Helper";' },
      { path: "components/Helper.tsx", source: 'import { deep } from "../lib/deep";' },
      { path: "lib/deep.ts", source: 'import { apiGet } from "./api";' },
      { path: "lib/api.ts", source: "export const apiGet = 1;" },
      { path: "lib/clean.ts", source: "export const x = 1;" },
    ];
    expect(findReachableStaffModules(["guest/G.tsx"], project)).toEqual(["guest/G.tsx -> components/Helper.tsx -> lib/deep.ts -> lib/api.ts"]);
    expect(findReachableStaffModules(["lib/clean.ts"], project)).toEqual([]);
  });

  it("locationStore", () => {
    expect(findLocationStoreCalls([{ path: "a.ts", source: "locationStore().push('/x');" }, { path: "b.ts", source: "// locationStore() is banned" }])).toEqual(["a.ts"]);
  });

  it("history", () => {
    const planted: Source[] = [
      { path: "guest/link-fragment.ts", source: "window.history.replaceState(null, '', '/d/review');" },
      { path: "guest/a.ts", source: "window.history.pushState(null, '', '/x');" },
      { path: "guest/b.ts", source: "history.back();" },
      { path: "guest/c.ts", source: "history.replaceState(null, '', '/x');" },
      { path: "guest/d.ts", source: "window.history['pushState'](null, '', '/x');" },
      { path: "guest/e.ts", source: "// history.pushState is not used" },
      { path: "guest/link-fragment.ts", source: "window.history.replaceState(window.history.state, '', '/x');" },
    ];
    expect(findHistoryMisuse(planted, "guest/link-fragment.ts")).toEqual(["guest/a.ts", "guest/b.ts", "guest/c.ts", "guest/d.ts"]);
  });

  it("fetch and staff /api literals", () => {
    const planted: Source[] = [
      { path: "guest/guest-api.ts", source: "await fetch(`${base}/session`);" },
      { path: "guest/a.ts", source: "await fetch('/d/api/links/x/videos');" },
      { path: "guest/b.ts", source: "new WebSocket('wss://x');" },
      { path: "guest/c.ts", source: "const url = '/api/projects';" },
      { path: "guest/d.ts", source: "const url = `/d/api/links/${id}`;" },
    ];
    expect(findStrayFetch(planted, "guest/guest-api.ts")).toEqual(["guest/a.ts", "guest/b.ts"]);
    expect(findStaffApiLiterals(planted)).toEqual(["guest/c.ts"]);
  });
});
