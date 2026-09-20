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
 * #217 fix round 8, Sol review, item 5(i). A char-by-char pass, not a full parser -- tracks
 * whether the cursor is inside a `//` line comment, a `/* ... *\/` block comment, or a string/
 * template literal, and blanks only the comment bodies (preserving line breaks, so downstream
 * line-based reasoning is unaffected). Without this, a PRODUCTION docblock explaining what #217
 * build steps 4/5 deleted -- prose like "do not restore `effectiveQuery`" -- trips the very same
 * raw-substring scan a real reintroduced reference would.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (two === "/*") {
      i += 2;
      while (i < n && source.slice(i, i + 2) !== "*/") {
        if (source[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    const ch = source[i]!;
    if (ch === "\"" || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch; i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < n) { out += source[i]! + source[i + 1]!; i += 2; continue; }
        out += source[i]; i++;
      }
      if (i < n) { out += source[i]; i++; }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Pure detector 2: which files (excluding this guard suite's own planted fixtures, handled by
 * `appFiles()`'s test-file exclusion) still reference one of the three deleted render-side
 * adoption paths #217 build steps 4/5 replaced with the ONE stateless sync rule. Comments are
 * stripped first (#217 fix round 8, item 5(i)) -- only a real, live reference in code offends.
 */
const FORBIDDEN_IDENTIFIERS = ["adoptDashboardSearch", "effectiveQuery", "adoptedLocationRef"] as const;

export function findForbiddenIdentifierReferences(
  files: Array<{ path: string; source: string }>,
): Array<{ path: string; identifier: string }> {
  const offenders: Array<{ path: string; identifier: string }> = [];
  for (const { path, source } of files) {
    const code = stripComments(source);
    for (const identifier of FORBIDDEN_IDENTIFIERS) {
      if (code.includes(identifier)) offenders.push({ path, identifier });
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

/**
 * Pure detector 4 (#217 fix round 8, Sol review, item 5(ii)). Detector 3 above only checks that
 * SOME `dashboardSearchOf(` call exists in the file and that `.query` is never read off a store
 * snapshot -- it would not catch a `committedQuery` that quietly reads the store instead (e.g.
 * `const committedQuery = search.draft;` sitting beside an unrelated `dashboardSearchOf(` call
 * elsewhere in the file), nor a second, shadowing `committedQuery` declared somewhere else. This
 * pins the invariant literally: exactly one `committedQuery` declaration, whose initializer is
 * exactly `dashboardSearchOf(parsedRoute) ?? ""`. Comments are stripped first (same reasoning as
 * detector 2) so a docblock mentioning `committedQuery` in prose does not offend.
 */
export function findCommittedQueryInvariantViolations(source: string): string[] {
  const code = stripComments(source);
  const declarations = [...code.matchAll(/\b(?:const|let)\s+committedQuery\s*=\s*([^;\n]+);/g)];
  if (declarations.length === 0) {
    return ["no `committedQuery` declaration found"];
  }
  if (declarations.length > 1) {
    return [`expected exactly one \`committedQuery\` declaration, found ${declarations.length}`];
  }
  const initializer = declarations[0]![1]!.trim();
  if (initializer !== 'dashboardSearchOf(parsedRoute) ?? ""') {
    return [`\`committedQuery\` initializer must be \`dashboardSearchOf(parsedRoute) ?? ""\`, found: \`${initializer}\``];
  }
  return [];
}

/** Self-test fixtures for detector 4. */
const PLANTED_COMMITTED_QUERY_READS_STORE = 'const committedQuery = search.draft;\nconst other = dashboardSearchOf(parsedRoute);';
const PLANTED_COMMITTED_QUERY_DUPLICATED =
  'const committedQuery = dashboardSearchOf(parsedRoute) ?? "";\nconst committedQuery = dashboardSearchOf(parsedRoute) ?? "";';
const PLANTED_COMMITTED_QUERY_COMMENT_ONLY =
  '// #217 build, step 4: committedQuery is derived from the route, never `const committedQuery = search.draft`.\nconst committedQuery = dashboardSearchOf(parsedRoute) ?? "";';

/**
 * Pure detector 5 (#217 fix round 8, Sol review, item 5(ii)). Detector 1 above only rules out a
 * field literally named `query` -- a renamed copy of the committed value (`committedSearch`,
 * `lastQuery`) would pass it outright since neither name is `query`. This treats the store's
 * module-level state as an ALLOWLIST instead: the real state this store's own docblock (above)
 * claims to hold is exactly `draft` (the draft text), `timer`/`timerOwner` (the debounce timer and
 * the principal it is armed for), and `principalId` (the owning principal) -- plus the
 * infrastructure every module-singleton store needs regardless of what state it holds (`writer`,
 * `snapshot`, `mismatchCache`, `listeners`). UPPER_SNAKE_CASE module constants
 * (`DASHBOARD_SEARCH_DEBOUNCE_MS`) are excluded -- they are not per-render state. Comments are
 * stripped first so a docblock mentioning a hypothetical field name in prose does not offend.
 */
const DASHBOARD_SEARCH_STORE_STATE_ALLOWLIST = new Set([
  "draft",
  "principalId",
  "timer",
  "timerOwner",
  "writer",
  "snapshot",
  "mismatchCache",
  "listeners",
]);

export function findNonAllowlistedStoreStateFields(source: string): string[] {
  const code = stripComments(source);
  const offenders: string[] = [];
  const pattern = /^(?:export\s+)?(?:let|const)\s+(\w+)\s*[:=]/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code))) {
    const name = match[1]!;
    if (/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    if (!DASHBOARD_SEARCH_STORE_STATE_ALLOWLIST.has(name)) offenders.push(name);
  }
  return offenders;
}

/** Self-test fixtures for detector 5. */
const PLANTED_STORE_RENAMED_COPY = 'let draft = "";\nlet committedSearch = "";\nlet principalId = "";';
const PLANTED_STORE_RENAMED_COPY_2 = 'let draft = "";\nlet lastQuery = "";\nlet principalId = "";';
const PLANTED_STORE_COMMENT_ONLY =
  '// this store used to also keep a `committedSearch`/`lastQuery` copy of the URL -- it no longer does\nlet draft = "";\nlet principalId = "";';

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

  // #217 fix round 8, Sol review, item 5(i)/5(iii). A comment-only mention -- exactly the shape a
  // docblock explaining what #217 build steps 4/5 deleted actually looks like -- must NOT offend.
  it("self-test: a comment-only mention of a forbidden identifier does not offend", () => {
    const planted = [
      { path: "e.ts", source: "// #217 build, step 4: do not restore effectiveQuery, adoptedLocationRef or adoptDashboardSearchFromUrl.\nconst committedQuery = dashboardSearchOf(route) ?? \"\";" },
      { path: "f.ts", source: "/**\n * adoptDashboardSearchFromUrl used to live here; effectiveQuery and adoptedLocationRef went\n * with it -- see docs/lessons.md.\n */\nexport const x = 1;" },
    ];
    expect(findForbiddenIdentifierReferences(planted)).toEqual([]);
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

describe("guard: Dashboard.tsx's committedQuery declaration is pinned literally (#217 fix round 8, item 5(ii))", () => {
  it("the real Dashboard.tsx source declares committedQuery exactly once, from dashboardSearchOf(parsedRoute) ?? \"\"", () => {
    const source = readFileSync(join(srcDir, "screens", "Dashboard.tsx"), "utf8");
    expect(findCommittedQueryInvariantViolations(source)).toEqual([]);
  });

  it("self-test: fires when committedQuery reads the store instead of the route", () => {
    expect(findCommittedQueryInvariantViolations(PLANTED_COMMITTED_QUERY_READS_STORE)).toEqual([
      '`committedQuery` initializer must be `dashboardSearchOf(parsedRoute) ?? ""`, found: `search.draft`',
    ]);
  });

  it("self-test: fires when committedQuery is declared more than once", () => {
    expect(findCommittedQueryInvariantViolations(PLANTED_COMMITTED_QUERY_DUPLICATED)).toEqual([
      "expected exactly one `committedQuery` declaration, found 2",
    ]);
  });

  // #217 fix round 8, Sol review, item 5(iii). A comment-only mention of `const committedQuery =
  // search.draft` -- exactly the shape a docblock warning against the old bug looks like -- must
  // NOT offend; only the real, live declaration is checked.
  it("self-test: a comment-only mention of the forbidden shape does not offend", () => {
    expect(findCommittedQueryInvariantViolations(PLANTED_COMMITTED_QUERY_COMMENT_ONLY)).toEqual([]);
  });
});

describe("guard: the store's module-level state is an allowlist (#217 fix round 8, item 5(ii))", () => {
  it("the real store source declares no state outside the allowlist", () => {
    const source = readFileSync(join(libDir, "dashboard-search-store.ts"), "utf8");
    expect(findNonAllowlistedStoreStateFields(source)).toEqual([]);
  });

  it("self-test: fires on a renamed committed-query copy (`committedSearch`)", () => {
    expect(findNonAllowlistedStoreStateFields(PLANTED_STORE_RENAMED_COPY)).toEqual(["committedSearch"]);
  });

  it("self-test: fires on a renamed committed-query copy (`lastQuery`)", () => {
    expect(findNonAllowlistedStoreStateFields(PLANTED_STORE_RENAMED_COPY_2)).toEqual(["lastQuery"]);
  });

  // #217 fix round 8, Sol review, item 5(iii). A comment-only mention of `committedSearch`/
  // `lastQuery` -- prose explaining the store no longer keeps such a copy -- must NOT offend.
  it("self-test: a comment-only mention of a renamed-copy name does not offend", () => {
    expect(findNonAllowlistedStoreStateFields(PLANTED_STORE_COMMENT_ONLY)).toEqual([]);
  });
});

/**
 * Pure detector 6 (#217 fix round 9, Sol review, item 3). Detector 5 above only walks MODULE-LEVEL
 * `let`/`const` declarations against an allowlist -- a renamed committed-query copy added as a
 * PROPERTY of the allowlisted `snapshot` variable itself (`{ draft, principalId, committedSearch }`)
 * never declares a new top-level binding, so it passes detector 5 outright. This pins the EXACT
 * property set of `DashboardSearchSnapshot` (the exported type) and of every `snapshot = { ... }`
 * object literal in the file (the initial declaration and `notify()`'s own reassignment) against
 * the same allowlist -- `draft` and `principalId`, the two fields the store's own docblock (top of
 * file) and `getDashboardSearchSnapshotForPrincipal`'s own return shape claim are all it holds.
 * Comments are stripped first (same reasoning as detector 2/4) so a docblock mentioning a
 * hypothetical extra field in prose does not offend.
 */
const DASHBOARD_SEARCH_SNAPSHOT_ALLOWED_PROPERTIES = new Set(["draft", "principalId"]);

function extractDelimitedNames(body: string, delimiter: string): string[] {
  return body
    .split(delimiter)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => part.split(":")[0]!.trim());
}

export function findSnapshotShapeViolations(source: string): string[] {
  const code = stripComments(source);
  const offenses: string[] = [];

  const typeMatch = code.match(/export type DashboardSearchSnapshot\s*=\s*\{([^}]*)\}/);
  if (!typeMatch) {
    offenses.push("no `export type DashboardSearchSnapshot = { ... }` declaration found");
  } else {
    const typeNames = extractDelimitedNames(typeMatch[1]!, ";");
    for (const name of typeNames) {
      if (!DASHBOARD_SEARCH_SNAPSHOT_ALLOWED_PROPERTIES.has(name)) {
        offenses.push(`DashboardSearchSnapshot carries a field outside the allowlist: \`${name}\``);
      }
    }
    // EXACT set, not a subset: dropping `principalId` would silently un-scope the draft.
    for (const required of DASHBOARD_SEARCH_SNAPSHOT_ALLOWED_PROPERTIES) {
      if (!typeNames.includes(required)) offenses.push(`DashboardSearchSnapshot is missing the required field \`${required}\``);
    }
  }

  // Every `snapshot = { ... }` object literal (the initial declaration, optionally typed, and
  // `notify()`'s own bare reassignment) -- NOT `mismatchCache`'s own `snapshot: { ... }` PROPERTY,
  // which this pattern deliberately does not match: no `=` follows that colon, only `{` does.
  const literalMatches = [...code.matchAll(/\bsnapshot\s*(?::\s*DashboardSearchSnapshot\s*)?=\s*\{([^}]*)\}/g)];
  if (literalMatches.length === 0) {
    offenses.push("no `snapshot = { ... }` object literal found");
  }
  for (const literal of literalMatches) {
    const literalNames = extractDelimitedNames(literal[1]!, ",");
    for (const name of literalNames) {
      if (!DASHBOARD_SEARCH_SNAPSHOT_ALLOWED_PROPERTIES.has(name)) {
        offenses.push(`a \`snapshot = { ... }\` object literal carries a property outside the allowlist: \`${name}\``);
      }
    }
    for (const required of DASHBOARD_SEARCH_SNAPSHOT_ALLOWED_PROPERTIES) {
      if (!literalNames.includes(required)) offenses.push(`a \`snapshot = { ... }\` object literal is missing the required property \`${required}\``);
    }
  }
  return offenses;
}

/** Self-test fixtures for detector 6. */
const PLANTED_SNAPSHOT_TYPE_EXTRA_FIELD =
  'export type DashboardSearchSnapshot = { draft: string; principalId: string; committedSearch: string };\n' +
  'let snapshot: DashboardSearchSnapshot = { draft, principalId, committedSearch };';
const PLANTED_SNAPSHOT_LITERAL_EXTRA_FIELD_ONLY =
  'export type DashboardSearchSnapshot = { draft: string; principalId: string };\n' +
  'let snapshot: DashboardSearchSnapshot = { draft, principalId, committedSearch };\n' +
  'function notify() {\n  snapshot = { draft, principalId, committedSearch };\n}';
const PLANTED_SNAPSHOT_COMMENT_ONLY =
  '// this store used to also keep a `committedSearch` field on the snapshot -- it no longer does\n' +
  'export type DashboardSearchSnapshot = { draft: string; principalId: string };\n' +
  'let snapshot: DashboardSearchSnapshot = { draft, principalId };';
const PLANTED_SNAPSHOT_MISSING_PRINCIPAL =
  'export type DashboardSearchSnapshot = { draft: string };\n' +
  'let snapshot: DashboardSearchSnapshot = { draft };';

describe("guard: the snapshot type and its object literals carry no field outside the allowlist (#217 fix round 9, item 3)", () => {
  it("the real store source's DashboardSearchSnapshot type and every `snapshot = { ... }` literal carry none of the offending shapes", () => {
    const source = readFileSync(join(libDir, "dashboard-search-store.ts"), "utf8");
    expect(findSnapshotShapeViolations(source)).toEqual([]);
  });

  it("self-test: fires when DashboardSearchSnapshot's own type gains a renamed committed-query field", () => {
    expect(findSnapshotShapeViolations(PLANTED_SNAPSHOT_TYPE_EXTRA_FIELD)).toEqual([
      "DashboardSearchSnapshot carries a field outside the allowlist: `committedSearch`",
      "a `snapshot = { ... }` object literal carries a property outside the allowlist: `committedSearch`",
    ]);
  });

  it("self-test: fires when a renamed committed-query copy is added INSIDE the allowlisted `snapshot` variable's own object literals, even with the type left alone", () => {
    expect(findSnapshotShapeViolations(PLANTED_SNAPSHOT_LITERAL_EXTRA_FIELD_ONLY)).toEqual([
      "a `snapshot = { ... }` object literal carries a property outside the allowlist: `committedSearch`",
      "a `snapshot = { ... }` object literal carries a property outside the allowlist: `committedSearch`",
    ]);
  });

  it("self-test: fires when a required field is REMOVED -- the set is exact, not a ceiling", () => {
    expect(findSnapshotShapeViolations(PLANTED_SNAPSHOT_MISSING_PRINCIPAL)).toEqual([
      "DashboardSearchSnapshot is missing the required field `principalId`",
      "a `snapshot = { ... }` object literal is missing the required property `principalId`",
    ]);
  });

  // #217 fix round 8, Sol review, item 5(iii)'s same reasoning: a comment-only mention of a
  // hypothetical extra field must not offend.
  it("self-test: a comment-only mention of an extra field does not offend", () => {
    expect(findSnapshotShapeViolations(PLANTED_SNAPSHOT_COMMENT_ONLY)).toEqual([]);
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
