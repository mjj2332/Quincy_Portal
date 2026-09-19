/**
 * Guards the #217 design this codebase settled on after seven review rounds: the URL is the ONLY
 * committed Dashboard search. The store (`dashboard-search-store.ts`) keeps a `draft` and nothing
 * else that is also in the URL; `Dashboard.tsx` derives the committed value at render, straight
 * from the currently governing route (`@quincy/shared`'s `dashboardSearchOf`), never from a store
 * copy. Three bugs this class of design produced, each with its own review round, are what this
 * guard exists to keep from coming back:
 *
 *   1. the store re-grew a `query` field mirroring the URL (the seam every one of the seven
 *      rounds found a fresh bug in);
 *   2. a call site reintroduces `adoptDashboardSearchFromUrl`, `effectiveQuery` or
 *      `adoptedLocationRef` -- all three deleted render-side adoption paths this design replaces
 *      with the ONE stateless sync rule (`syncDashboardSearchDraftFromLocation`, called once, in
 *      `ShellRoute`);
 *   3. `Dashboard.tsx` itself reads a search query back off the store instead of the route
 *      accessor it is supposed to derive `committedQuery` from.
 *
 * Per `docs/lessons.md` -- "a grep gate that cannot fail is not a gate" -- every detector below is
 * a pure function over injected input, each proven against a planted fixture that makes it fail,
 * beside the real scan. Test files are excluded from the real scan (mirrors
 * `lib/routing-transport.guard.test.ts`'s own `appFiles()`): several already carry these exact
 * identifiers as HISTORICAL prose (docblocks explaining what #217 build step 4/5 deleted and why),
 * which would make the self-tests fire on this very guard suite's neighbours were they included.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const libDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(libDir, "..");

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

/**
 * Non-test application source. Test files are excluded deliberately: several already reference
 * `adoptDashboardSearchFromUrl`/`effectiveQuery`/`adoptedLocationRef`/`.query` as PLANTED fixtures
 * (this file's own self-tests, below) or as historical prose in docblocks explaining what #217
 * build steps 4/5 deleted -- including both would make the detectors fire on this suite itself.
 */
function appFiles(): Array<{ path: string; source: string }> {
  return walkTsFiles(srcDir)
    .filter((file) => !isTestFile(file))
    .map((file) => ({ path: rel(file), source: readFileSync(file, "utf8") }))
    .sort((left, right) => (left.path < right.path ? -1 : 1));
}

/**
 * Pure detector 1: does `dashboard-search-store.ts`'s own source still export or hold a committed
 * `query` copy? Two shapes checked, since that is the two ways it existed before #217 build step 5:
 * a `query` field on the exported `DashboardSearchSnapshot` type, or a module-level `query`
 * variable the store's own functions read/write.
 */
export function findCommittedQueryInStoreSource(source: string): string[] {
  const offenses: string[] = [];
  const typeMatch = source.match(/export type DashboardSearchSnapshot\s*=\s*\{([^}]*)\}/);
  if (typeMatch && /\bquery\b/.test(typeMatch[1]!)) {
    offenses.push("DashboardSearchSnapshot still carries a `query` field");
  }
  if (/^\s*(?:let|const)\s+query\b/m.test(source)) {
    offenses.push("a module-level `query` variable still exists");
  }
  return offenses;
}

/** Self-test fixtures for detector 1 -- proven to fail before proving the real file passes. */
const PLANTED_SNAPSHOT_QUERY_FIELD = 'export type DashboardSearchSnapshot = { draft: string; query: string; principalId: string };';
const PLANTED_MODULE_QUERY_VARIABLE = 'let draft = "";\nlet query = "";\nlet principalId = "";';

/**
 * Pure detector 2: which files (excluding this guard suite's own planted fixtures, handled by
 * `appFiles()`'s test-file exclusion) still reference one of the three deleted render-side
 * adoption paths #217 build steps 4/5 replaced with the ONE stateless sync rule.
 */
const FORBIDDEN_IDENTIFIERS = ["adoptDashboardSearch", "effectiveQuery", "adoptedLocationRef"] as const;

export function findForbiddenIdentifierReferences(
  files: Array<{ path: string; source: string }>,
): Array<{ path: string; identifier: string }> {
  const offenders: Array<{ path: string; identifier: string }> = [];
  for (const { path, source } of files) {
    for (const identifier of FORBIDDEN_IDENTIFIERS) {
      if (source.includes(identifier)) offenders.push({ path, identifier });
    }
  }
  return offenders;
}

/**
 * Pure detector 3: does `screens/Dashboard.tsx`'s own source derive its committed search from the
 * route accessor (`dashboardSearchOf`), never read one back off the store? A call site reading
 * `.query` off either snapshot getter is the specific shape every pre-#217-build regression took.
 */
export function readsSearchQueryFromStoreInsteadOfRoute(source: string): string[] {
  const offenses: string[] = [];
  if (!/\bdashboardSearchOf\s*\(/.test(source)) {
    offenses.push("no dashboardSearchOf( call -- the committed search must be derived from the route");
  }
  if (/getDashboardSearchSnapshotForPrincipal\([^)]*\)\s*\.\s*query\b/.test(source)) {
    offenses.push("reads .query off getDashboardSearchSnapshotForPrincipal(...)");
  }
  if (/__getDashboardSearchSnapshotForTest\(\)\s*\.\s*query\b/.test(source)) {
    offenses.push("reads .query off __getDashboardSearchSnapshotForTest()");
  }
  return offenses;
}

/** Self-test fixtures for detector 3. */
const PLANTED_DASHBOARD_NO_ROUTE_ACCESSOR = "const committedQuery = getDashboardSearchSnapshotForPrincipal(currentUserId).draft;";
const PLANTED_DASHBOARD_READS_QUERY = "const committedQuery = dashboardSearchOf(parsedRoute) ?? getDashboardSearchSnapshotForPrincipal(currentUserId).query;";

describe("guard: the store keeps no committed `query` copy (#217 build, step 5)", () => {
  it("the real store source carries none of the offending shapes", () => {
    const source = readFileSync(join(libDir, "dashboard-search-store.ts"), "utf8");
    expect(findCommittedQueryInStoreSource(source)).toEqual([]);
  });

  it("self-test: fires on a planted `query` field on the snapshot type", () => {
    expect(findCommittedQueryInStoreSource(PLANTED_SNAPSHOT_QUERY_FIELD)).toEqual([
      "DashboardSearchSnapshot still carries a `query` field",
    ]);
  });

  it("self-test: fires on a planted module-level `query` variable", () => {
    expect(findCommittedQueryInStoreSource(PLANTED_MODULE_QUERY_VARIABLE)).toEqual([
      "a module-level `query` variable still exists",
    ]);
  });
});

describe("guard: no file references a deleted render-side adoption path", () => {
  it("finds no reference to adoptDashboardSearch*, effectiveQuery or adoptedLocationRef in application source", () => {
    const offenders = findForbiddenIdentifierReferences(appFiles());
    expect(offenders, [
      "A file references a render-side adoption path #217 build steps 4/5 deleted. The committed",
      "Dashboard search is derived from the route at render (dashboardSearchOf) and synced into the",
      "draft through the ONE stateless rule (syncDashboardSearchDraftFromLocation, in ShellRoute) --",
      "see docs/lessons.md's #217 entry.",
      ...offenders.map(({ path, identifier }) => `  ${path}: ${identifier}`),
    ].join("\n")).toEqual([]);
  });

  it("self-test: the detector fires on each planted identifier", () => {
    const planted = [
      { path: "a.ts", source: "adoptDashboardSearchFromUrl(value, id);" },
      { path: "b.tsx", source: "const effectiveQuery = search.draft || route.q;" },
      { path: "c.tsx", source: "const adoptedLocationRef = useRef(location);" },
      { path: "d.ts", source: "const committedQuery = dashboardSearchOf(route) ?? \"\";" },
    ];
    expect(findForbiddenIdentifierReferences(planted).map((o) => o.path)).toEqual(["a.ts", "b.tsx", "c.tsx"]);
  });
});

describe("guard: Dashboard.tsx derives the committed search from the route, never a store copy", () => {
  it("the real Dashboard.tsx source carries none of the offending shapes", () => {
    const source = readFileSync(join(srcDir, "screens", "Dashboard.tsx"), "utf8");
    expect(readsSearchQueryFromStoreInsteadOfRoute(source)).toEqual([]);
  });

  it("self-test: fires when there is no dashboardSearchOf( call at all", () => {
    expect(readsSearchQueryFromStoreInsteadOfRoute(PLANTED_DASHBOARD_NO_ROUTE_ACCESSOR)).toEqual([
      "no dashboardSearchOf( call -- the committed search must be derived from the route",
    ]);
  });

  it("self-test: fires when the committed value falls back to a store .query read", () => {
    expect(readsSearchQueryFromStoreInsteadOfRoute(PLANTED_DASHBOARD_READS_QUERY)).toEqual([
      "reads .query off getDashboardSearchSnapshotForPrincipal(...)",
    ]);
  });
});

describe("the file scan itself", () => {
  it("reads the real application source", () => {
    const files = appFiles();
    expect(files.length).toBeGreaterThan(50);
    expect(files.map((file) => file.path)).toContain("screens/Dashboard.tsx");
    expect(files.every((file) => !isTestFile(file.path))).toBe(true);
  });
});
