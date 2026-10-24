/**
 * Guards the guest/staff boundary of the Review-link page (#741 12b) and the public Client Delivery page (#787 slice 9).
 *
 * `/d/review` and `/d/<address>` are served by the same SPA entry as the staff app but must never reach the staff app's session, API, router or query cache: a guest has no staff session, so a stray
 * `/api` request is an unauthenticated probe of the staff surface, and a router that canonicalises the URL would undo the fragment scrub. Each tree (`src/guest/`, `src/delivery/`) is held to:
 *
 * - no import of `lib/auth`, `lib/api`, `lib/router`, `lib/app-router`, `lib/query-client`, `InternalLink` or `@tanstack/*` (one exception, below), directly or through anything it
 *   imports. "Through anything it imports" counts packages too: every import in every project file the tree reaches (relative, `@/` or dynamic `import()`) is held to the same list,
 *   so a shared component that imports `@tanstack/react-query` breaches the rule as surely as a guest file that imports it itself;
 * - no `locationStore(` call;
 * - `history.` is used only as `history.replaceState`, and only in the one file the tree allows (guest: `link-fragment.ts`, the fragment scrub; delivery: none, there is no fragment);
 * - `fetch(` is called only in the tree's one API file (`guest/guest-api.ts`, `delivery/delivery-api.ts`), and no string literal starts a staff `/api/` path;
 * - the Delivery page's own `/d/api/pages` address is written only in `delivery/delivery-api.ts`, in either tree.
 *
 * The one allowed package is `@tanstack/react-table`, by name (owner decision, #933, 2026-10-23: "keep data-grid for guest/delivery Video rows, lazy-load them there"). The Video row
 * list (`components/quincy/VideoRows.tsx`) is the ReUI data-grid, which is TanStack Table: a headless, in-memory table model with no URL, history, network or cache of its own, so it
 * cannot canonicalise the URL or reach the staff session. The real TanStack hazards stay banned: `@tanstack/react-router` (and `@tanstack/history`, its URL owner) would undo the
 * fragment scrub, and `@tanstack/react-query` is the staff cache. The guest and Delivery pages load the rows lazily, so a visitor who keeps tiles never downloads the table.
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

/** The staff modules a guest file must not reach. Matched on the resolved path (transitive) and on the specifier (direct and transitive). */
const BANNED_MODULE = /^(?:lib\/(?:auth|api|router|app-router|query-client|staff-history|location-store)|components\/InternalLink)(?:\.tsx?)?$/;
const BANNED_STAFF_SPECIFIER = /(?:^|\/)(?:lib\/(?:auth|api|router|app-router|query-client|staff-history)|InternalLink)(?:\.tsx?)?$/;
/** Every TanStack package (`@tanstack/react-router`, `@tanstack/history` and `@tanstack/react-query` above all) except those `ALLOWED_PACKAGES` names. */
const BANNED_PACKAGE = /^@tanstack\//;
/** Allowed by exact package name, with the reason (see the header). */
const ALLOWED_PACKAGES: ReadonlyMap<string, string> = new Map([
  ["@tanstack/react-table", "The Video row list's data-grid (#933, owner 2026-10-23): a headless table model with no URL, history, network or cache; loaded lazily on guest and delivery."],
]);
/** `@scope/name/sub/path` -> `@scope/name`; `name/sub` -> `name`. */
const packageOf = (specifier: string) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
export function isBannedSpecifier(specifier: string): boolean {
  if (BANNED_STAFF_SPECIFIER.test(specifier)) return true;
  return BANNED_PACKAGE.test(specifier) && !ALLOWED_PACKAGES.has(packageOf(specifier));
}

/** Blanks comments so prose in a header cannot trip (or hide) a detector. */
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

export function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const match of strip(source).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.mock\s*\(\s*)["']([^"']+)["']/g)) out.push(match[1]!);
  return out;
}

/** Direct: files importing a banned staff module or TanStack package. */
export function findBannedImports(files: Source[]): string[] {
  return files.filter(({ source }) => importSpecifiers(source).some(isBannedSpecifier)).map(({ path }) => path).sort();
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
/** The public Delivery page's API address, written as a literal anywhere but its one wrapper. */
export function findPagesApiLiterals(files: Source[], allowedFile: string): string[] {
  return files.filter(({ path, source }) => path !== allowedFile && /\/d\/api\/pages\b/.test(strip(source))).map(({ path }) => path).sort();
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
  return [...reached.keys()].filter((path) => BANNED_MODULE.test(path)).map((path) => chainTo(path, reached).join(" -> ")).sort();
}

/** The import chain from a root to `path`, root first. */
function chainTo(path: string, reached: Map<string, string>): string[] {
  const chain = [path]; let at = path;
  while (reached.get(at) !== at && chain.length < 12) { at = reached.get(at)!; chain.push(at); }
  return chain.reverse();
}

/**
 * Transitive specifiers: every banned specifier (a staff module, or a TanStack package not allowed by name) written in any project file reachable from `roots`, as
 * "root -> ... -> file -> specifier". Packages are not followed into `node_modules`: what counts is what the project's own files import.
 */
export function findReachableBannedSpecifiers(roots: string[], project: Source[]): string[] {
  const byPath = new Map(project.map((file) => [file.path, file.source]));
  const reached = reachableFrom(roots, project);
  return [...reached.keys()].flatMap((path) => importSpecifiers(byPath.get(path) ?? "").filter(isBannedSpecifier).map((specifier) => [...chainTo(path, reached), specifier].join(" -> "))).sort();
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

type Tree = { name: string; dir: string; allowedFetch: string; allowedHistory: string; mustContain: string[] };
const TREES: Tree[] = [
  { name: "guest", dir: "guest", allowedFetch: "guest/guest-api.ts", allowedHistory: "guest/link-fragment.ts", mustContain: ["guest/link-fragment.ts", "guest/guest-api.ts", "guest/GuestApp.tsx"] },
  // No history file: the Delivery page has no fragment to scrub, so `history.` is not used at all.
  { name: "delivery", dir: "delivery", allowedFetch: "delivery/delivery-api.ts", allowedHistory: "", mustContain: ["delivery/delivery-api.ts", "delivery/DeliveryApp.tsx", "delivery/DeliveryPage.tsx", "delivery/mount-delivery.tsx"] },
];
const PAGES_API_FILE = "delivery/delivery-api.ts";
const treeFiles = (tree: Tree) => read(walk(join(srcDir, tree.dir))).filter(({ path }) => !isTest(path));
const projectFiles = () => read(walk(srcDir)).filter(({ path }) => !isTest(path));

describe.each(TREES)("guard: the $name tree stays out of the staff app", (tree) => {
  it("has files to scan, including its API wrapper", () => {
    const paths = treeFiles(tree).map((file) => file.path);
    for (const path of tree.mustContain) expect(paths).toContain(path);
    expect(existsSync(join(srcDir, tree.allowedFetch))).toBe(true);
  });

  it("imports no staff module, router or banned TanStack package directly", () => {
    expect(findBannedImports(treeFiles(tree))).toEqual([]);
  });

  it("reaches no staff module through anything it imports", () => {
    const roots = treeFiles(tree).map((file) => file.path);
    expect(findReachableStaffModules(roots, projectFiles())).toEqual([]);
  });

  it("reaches no staff module or banned TanStack package through any import of any file it reaches", () => {
    const roots = treeFiles(tree).map((file) => file.path);
    expect(findReachableBannedSpecifiers(roots, projectFiles())).toEqual([]);
  });

  it("never calls locationStore", () => {
    expect(findLocationStoreCalls(treeFiles(tree))).toEqual([]);
  });

  it("uses history only as replaceState, and only where the tree allows it", () => {
    expect(findHistoryMisuse(treeFiles(tree), tree.allowedHistory)).toEqual([]);
  });

  it("makes network calls only from its API file, and never to a staff /api path", () => {
    expect(findStrayFetch(treeFiles(tree), tree.allowedFetch)).toEqual([]);
    expect(findStaffApiLiterals(treeFiles(tree))).toEqual([]);
  });

  it("writes the /d/api/pages address only in delivery-api.ts", () => {
    expect(findPagesApiLiterals(treeFiles(tree), PAGES_API_FILE)).toEqual([]);
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
      { path: "guest/g.tsx", source: 'import { useQuery } from "@tanstack/react-query";' },
      { path: "guest/table.tsx", source: 'import { useTable } from "@tanstack/react-table";' },
      { path: "guest/ok.tsx", source: 'import { readStoredMarkup } from "../lib/read-stored-markup";\n// import { apiGet } from "../lib/api";' },
    ];
    expect(findBannedImports(planted)).toEqual(["guest/a.tsx", "guest/b.tsx", "guest/c.tsx", "guest/d.tsx", "guest/e.tsx", "guest/f.tsx", "guest/g.tsx"]);
  });

  it("transitive package reach: a TanStack package other than react-table fires wherever it is imported (#933)", () => {
    const project: Source[] = [
      { path: "guest/G.tsx", source: 'const Rows = lazy(() => import("../components/Rows"));' },
      { path: "components/Rows.tsx", source: 'import { useTable } from "@tanstack/react-table";\nimport { cache } from "../lib/cache";' },
      { path: "lib/cache.ts", source: 'import { useQuery } from "@tanstack/react-query";\nimport { useRouter } from "@tanstack/react-router/ssr";\nexport const cache = 1;' },
      { path: "components/Clean.tsx", source: 'import { useTable, type ColumnDef } from "@tanstack/react-table";\nimport type { Row } from "@tanstack/react-table";\nimport { x } from "react";' },
      { path: "components/Lookalike.tsx", source: 'import { y } from "@tanstack/react-table-extra";\nconst h = await import("@tanstack/history");' },
      { path: "guest/H.tsx", source: 'import { Clean } from "../components/Clean";\n// import { useQuery } from "@tanstack/react-query";' },
    ];
    expect(findReachableBannedSpecifiers(["guest/G.tsx"], project)).toEqual([
      "guest/G.tsx -> components/Rows.tsx -> lib/cache.ts -> @tanstack/react-query",
      "guest/G.tsx -> components/Rows.tsx -> lib/cache.ts -> @tanstack/react-router/ssr",
    ]);
    // react-table is allowed by name, directly or through a project file, type-only or not; a package that only starts with its name is not.
    expect(findReachableBannedSpecifiers(["guest/H.tsx"], project)).toEqual([]);
    expect(findBannedImports([project[3]!])).toEqual([]);
    expect(findReachableBannedSpecifiers(["components/Lookalike.tsx"], project)).toEqual(["components/Lookalike.tsx -> @tanstack/history", "components/Lookalike.tsx -> @tanstack/react-table-extra"]);
    // The same specifier check holds for the staff modules, so a file the resolver cannot place (a bare path) is still caught by its name.
    expect(findReachableBannedSpecifiers(["guest/S.tsx"], [{ path: "guest/S.tsx", source: 'import { apiGet } from "../lib/api";' }])).toEqual(["guest/S.tsx -> ../lib/api"]);
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

  it("the Delivery page's /d/api/pages address", () => {
    const planted: Source[] = [
      { path: "delivery/delivery-api.ts", source: "const base = `/d/api/pages/${slug}`;" },
      { path: "delivery/a.tsx", source: "const url = `/d/api/pages/${slug}/items/${h}/media`;" },
      { path: "guest/b.ts", source: "fetch('/d/api/pages/x');" },
      { path: "delivery/c.tsx", source: "// the page reads /d/api/pages through delivery-api.ts\nconst ok = api.hrefs.media(handle);" },
      { path: "delivery/d.tsx", source: "const links = '/d/api/links/x';" },
    ];
    expect(findPagesApiLiterals(planted, "delivery/delivery-api.ts")).toEqual(["delivery/a.tsx", "guest/b.ts"]);
  });

  it("no allowed history file means replaceState is refused everywhere", () => {
    expect(findHistoryMisuse([{ path: "delivery/a.ts", source: "history.replaceState(null, '', '/x');" }], "")).toEqual(["delivery/a.ts"]);
    expect(findHistoryMisuse([{ path: "delivery/a.ts", source: "const s = window.history.state;" }], "")).toEqual([]);
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
