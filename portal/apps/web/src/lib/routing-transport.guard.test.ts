/**
 * Guards the routing transport (#52).
 *
 * `staff-history.ts` gives TanStack Router a **read-only** history: the router observes the URL
 * and never writes it, because `@tanstack/react-router`'s `Transitioner` canonicalises the URL on
 * mount with no opt-out, which rewrote `/%61dmin` to `/admin` and mounted the real Admin screen
 * from a location the parser rejects.
 *
 * That design is safe only while nothing navigates through TanStack. A `useNavigate()`,
 * a `<Link>`, or a `router.navigate(...)` anywhere in the application would silently do nothing —
 * the worst kind of failure, because it looks like working code. These guards make that a build
 * failure instead of a bug report.
 *
 * They also pin the two structural facts the migration rests on: `@quincy/shared` stays
 * runtime-agnostic for the Workers that import it, and file-based route generation stays out.
 *
 * Per `docs/lessons.md` — "a grep gate that cannot fail is not a gate" — every assertion below was
 * falsified while being written by planting the thing it looks for and confirming it fails. The
 * detectors are pure functions over injected input, each with a synthetic fixture beside the real
 * scan, so a scan that passes vacuously today still proves the detector works.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const libDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(libDir, "..");
const webDir = join(srcDir, "..");
const portalDir = join(webDir, "..", "..");

const rel = (file: string) => relative(srcDir, file).split("\\").join("/");

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const isTestFile = (file: string) => /\.test\.tsx?$/.test(file);

/** The one module allowed to import TanStack Router, plus the transport it is built on. */
const ROUTER_OWNED = new Set(["lib/app-router.tsx", "lib/staff-history.ts"]);

/**
 * Pure detector: which files import from `@tanstack/react-router` or `@tanstack/history` while
 * not being one of the modules that owns the router.
 */
export function findUnownedRouterImporters(
  files: Array<{ path: string; source: string }>,
  owned: ReadonlySet<string>,
): string[] {
  return files
    .filter(({ path, source }) => !owned.has(path) && /@tanstack\/(react-router|history|router-core)/.test(source))
    .map(({ path }) => path)
    .sort();
}

/** Pure detector: files calling a TanStack navigation API, which a read-only history ignores. */
export function findTanstackNavigationCalls(
  files: Array<{ path: string; source: string }>,
  owned: ReadonlySet<string>,
): string[] {
  const forbidden = /\buseNavigate\s*\(|\brouter\.navigate\s*\(|\buseRouter\s*\(|\bredirect\s*\(\s*\{/;
  return files
    .filter(({ path, source }) => !owned.has(path) && forbidden.test(source))
    .map(({ path }) => path)
    .sort();
}

function appFiles(): Array<{ path: string; source: string }> {
  return walkTsFiles(srcDir)
    .filter((file) => !isTestFile(file))
    .map((file) => ({ path: rel(file), source: readFileSync(file, "utf8") }))
    .sort((left, right) => (left.path < right.path ? -1 : 1));
}

describe("guard: only the router modules may import TanStack Router", () => {
  it("finds no unowned importer", () => {
    const unowned = findUnownedRouterImporters(appFiles(), ROUTER_OWNED);
    expect(unowned, [
      "A module outside the routing transport imports TanStack Router. The router is given a",
      "read-only history (see lib/staff-history.ts), so navigating through it silently does",
      "nothing. Navigate through locationStore() instead, where safeStaffDestination runs.",
      ...unowned.map((path) => `  ${path}`),
    ].join("\n")).toEqual([]);
  });

  it("self-test: the detector fires on a planted import", () => {
    const planted = [
      { path: "components/Rogue.tsx", source: 'import { Link } from "@tanstack/react-router";' },
      { path: "lib/app-router.tsx", source: 'import { createRouter } from "@tanstack/react-router";' },
    ];
    expect(findUnownedRouterImporters(planted, ROUTER_OWNED)).toEqual(["components/Rogue.tsx"]);
  });
});

describe("guard: nothing navigates through TanStack", () => {
  it("finds no TanStack navigation call", () => {
    const callers = findTanstackNavigationCalls(appFiles(), ROUTER_OWNED);
    expect(callers, [
      "A module calls a TanStack navigation API. The router's history is read-only, so this",
      "does nothing at all. Use locationStore().push/replace, or InternalLink.",
      ...callers.map((path) => `  ${path}`),
    ].join("\n")).toEqual([]);
  });

  it("self-test: the detector fires on each planted call shape", () => {
    const planted = [
      { path: "a.tsx", source: "const navigate = useNavigate();" },
      { path: "b.tsx", source: "router.navigate({ to: '/admin' });" },
      { path: "c.tsx", source: "const r = useRouter();" },
      { path: "d.tsx", source: "throw redirect({ to: '/' });" },
      { path: "e.tsx", source: "locationStore().push('/admin');" },
    ];
    expect(findTanstackNavigationCalls(planted, new Set())).toEqual(["a.tsx", "b.tsx", "c.tsx", "d.tsx"]);
  });
});

describe("guard: @quincy/shared stays runtime-agnostic", () => {
  // workers/app and workers/background import staff-routes.ts and run on Cloudflare Workers.
  const sharedSrc = join(portalDir, "packages", "shared", "src");

  it("has no TanStack import anywhere in the shared package", () => {
    const offenders = walkTsFiles(sharedSrc)
      .filter((file) => /@tanstack\//.test(readFileSync(file, "utf8")))
      .map((file) => relative(sharedSrc, file));
    expect(offenders, "A Workers-side package must not depend on a browser router.").toEqual([]);
  });

  it("self-test: that scan reads real files and would see one", () => {
    // Proves the scan is pointed at a populated directory rather than passing on an empty list.
    const scanned = walkTsFiles(sharedSrc);
    expect(scanned.length).toBeGreaterThan(5);
    expect(scanned.some((file) => file.endsWith("staff-routes.ts"))).toBe(true);
  });
});

describe("guard: file-based route generation is not introduced", () => {
  it("has no generated route tree and no router plugin", () => {
    expect(existsSync(join(srcDir, "routeTree.gen.ts"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(portalDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
    };
    const declared = { ...manifest.dependencies, ...manifest.devDependencies };
    expect(Object.keys(declared)).not.toContain("@tanstack/router-plugin");
    expect(Object.keys(declared)).not.toContain("@tanstack/router-cli");
    // The dependency that IS expected, pinned exactly.
    expect(manifest.dependencies?.["@tanstack/react-router"]).toBe("1.170.33");
  });
});

describe("guard: the legacy history adapter is still the application's only writer", () => {
  it("keeps createHistoryAdapter and shouldInterceptInternalLink exported from lib/router", () => {
    // router.test.ts and dashboard-routing.test.ts import these by name and may not be edited.
    const source = readFileSync(join(libDir, "router.ts"), "utf8");
    expect(source).toMatch(/export function createHistoryAdapter\b/);
    expect(source).toMatch(/export function shouldInterceptInternalLink\b/);
    expect(source).toMatch(/export function locationStore\b/);
  });

  it("keeps the router's own history free of browser writes", () => {
    // The no-op pushState/replaceState are the fix for the Transitioner canonicalisation. If they
    // ever reach the adapter again, /%61dmin starts rewriting itself to /admin.
    const source = readFileSync(join(libDir, "staff-history.ts"), "utf8");
    const body = source.slice(source.indexOf("createHistory({"), source.indexOf("const unsubscribe"));
    expect(body).toMatch(/pushState:\s*\(\)\s*=>\s*\{\}/);
    expect(body).toMatch(/replaceState:\s*\(\)\s*=>\s*\{\}/);
    expect(body).not.toMatch(/adapter\.(push|replace)\s*\(/);
  });
});

describe("the file scan itself", () => {
  it("reads the real application source", () => {
    const files = appFiles();
    expect(files.length).toBeGreaterThan(50);
    expect(files.map((file) => file.path)).toContain("lib/app-router.tsx");
    expect(files.every((file) => !isTestFile(file.path))).toBe(true);
    expect(statSync(join(libDir, "staff-history.ts")).isFile()).toBe(true);
  });
});
