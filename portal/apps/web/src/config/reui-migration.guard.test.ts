/**
 * ReUI migration guards — keep the `components/ui/` → `components/reui/` migration honest while
 * it is in flight (issue #49). Both guards are **temporary**: #56 deletes this whole file once
 * `src/components/ui/` is empty, at which point "the legacy directory is empty" is the same fact
 * these guards exist to police, and a guard that can only ever pass is not a guard. That is also
 * why this lives in its own file instead of the permanent `styles/design-system-guards.test.ts` —
 * it should be easy to delete in one piece.
 *
 * `docs/lessons.md` states the doctrine this file follows: "a grep gate that cannot fail is not a
 * gate." Both real-world scans below pass vacuously today — nothing has migrated to
 * `components/reui/` yet, and no legacy primitive is orphaned yet — so a scan that never fires is
 * not evidence the detector works. Every detector is therefore factored as a pure function over an
 * injected graph structure (not something that reads the filesystem itself), and is exercised with
 * a synthetic fixture, below the real scan, that manufactures the violation and asserts the
 * detector reports it. That is what makes "the guard actually fails when violated" a checked fact
 * instead of an aspiration.
 *
 * ## Guard A — screen purity
 *
 * A "root" (`main.tsx`, `App.tsx`, each `screens/*.tsx`) is "migrated" once its transitive
 * local-import closure contains a ReUI module (`components/reui/*`). A migrated root must not
 * *also* have a legacy primitive (`components/ui/*`) anywhere in that closure — that would mean
 * the same screen is rendering both the old and the new design system at once, which is exactly
 * the kind of half-migrated state that is easy to ship by accident and hard to notice by eye.
 *
 * The rule is deliberately **asymmetric**: an *unmigrated* root that still imports a legacy
 * primitive is not flagged. `ui/button` (for example) has many importers shared across screens, so
 * the first screen to migrate necessarily pulls in shared components that screens which have not
 * migrated yet still depend on. Flagging every root that touches a legacy primitive would make the
 * rule unsatisfiable the moment the first screen migrates — it would fail on every other,
 * untouched screen simply for existing. Only a root that has *itself* started migrating is held to
 * the "no legacy primitive left in your own closure" standard.
 *
 * The closure walk stops at another root: `App.tsx` imports all seven screens directly, so without
 * that rule `App.tsx`'s closure would swallow the entire application and the guard would degenerate
 * into "is anything, anywhere, both migrated and unmigrated" — true forever, meaningless. A root
 * encountered while walking another root's closure is recorded as a leaf (it was really imported)
 * but its own imports are not expanded.
 *
 * ## Guard B — orphan primitive
 *
 * A legacy primitive with zero importers among non-test source files is dead weight that should
 * have been deleted in the same slice that removed its last consumer. Test files do **not** count
 * as importers: the primitive's own colocated `*.dom.test.tsx` imports it forever, so if tests
 * counted, a primitive could never be reported orphaned while its own test file exists and the
 * guard would be dead by construction. Intra-`ui/` importers **do** count — `ui/label.tsx` is
 * imported only by `ui/field.tsx` today, and excluding intra-directory edges would flag `label` as
 * orphaned on day one, forcing a baseline entry for a primitive that is not actually dead.
 *
 * If this guard fires: delete the primitive and its colocated test together, in the same slice
 * that removes its last consumer. Do not delete only the test to silence the guard.
 *
 * ## Baselines
 *
 * `SCREEN_PURITY_BASELINE` and `ORPHAN_PRIMITIVE_BASELINE` exist so either guard could be switched
 * on mid-migration without demanding an instant, atomic fix. As of this writing every one of the
 * 14 legacy primitives has at least one non-test importer and `components/reui/` does not exist
 * yet, so both baselines are `{}` and both scans pass for real, not vacuously by baseline padding.
 * **Baselines shrink; they never grow.** Adding an entry to make a build pass defeats the guard
 * this file exists to be.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const configDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(configDir, "..");

const rel = (file: string) => relative(srcDir, file);

// ---------------------------------------------------------------------------
// Filesystem helpers — duplicated from `styles/design-system-guards.test.ts` on purpose (that file
// is not imported from here so this guard file can be deleted as a unit by #56 without touching
// the permanent guards).
// ---------------------------------------------------------------------------

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every `.ts`/`.tsx` file under `src/`, tests included. */
function allFiles(): string[] {
  return walkTsFiles(srcDir).sort();
}

function isTestFile(file: string): boolean {
  return /\.test\.tsx?$/.test(file);
}

/** Non-test `.ts`/`.tsx` files, matching the shape of the sibling guard file's `sourceFiles()`. */
function sourceFiles(): string[] {
  return allFiles().filter((file) => !isTestFile(file));
}

// ---------------------------------------------------------------------------
// Import extraction and resolution — relative and `@/`-alias imports only, static forms only.
// ---------------------------------------------------------------------------

interface ImportEdge {
  specifier: string;
  /**
   * True for `import type {...}` and for a clause whose named bindings are ALL `type`-only.
   * Such an edge disappears at runtime, so it cannot make a screen impure — but it still
   * pins the module at compile time, so it DOES count as an importer for the orphan guard.
   */
  typeOnly: boolean;
}

/**
 * Blanks out comment bodies, preserving offsets and newlines, without touching string or
 * template literals (a `//` inside a URL string must survive). Deliberately hand-rolled: the
 * installed `typescript` package is the native port, which ships a binary and no JS compiler
 * API, and pulling in a parser dependency to serve one guard is not a trade worth making.
 */
function stripComments(source: string): string {
  let out = "";
  let state: "code" | "line" | "block" | "'" | '"' | "`" = "code";
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] as string;
    const next = source[i + 1];
    if (state === "code") {
      if (char === "/" && next === "/") { state = "line"; out += "  "; i += 1; continue; }
      if (char === "/" && next === "*") { state = "block"; out += "  "; i += 1; continue; }
      if (char === "'" || char === '"' || char === "`") state = char;
      out += char;
      continue;
    }
    if (state === "line") {
      if (char === "\n") { state = "code"; out += char; } else out += " ";
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") { state = "code"; out += "  "; i += 1; } else out += char === "\n" ? char : " ";
      continue;
    }
    // Inside a string/template: copy verbatim, honour escapes, close on the matching quote.
    out += char;
    if (char === "\\") { const escaped = source[i + 1]; if (escaped !== undefined) { out += escaped; i += 1; } continue; }
    if (char === state) state = "code";
  }
  return out;
}

/**
 * Extracts import edges from comment-stripped source.
 *
 * The earlier version regexed raw source. It counted commented-out imports, could not see
 * `import{X}from"y"` without spaces, treated `import type` as a runtime edge, and — worst —
 * ignored dynamic `import()` entirely. That last one was not hypothetical: Dashboard.tsx
 * lazy-loads ProductionCalendar, which imports ui/button, so Dashboard could have passed the
 * purity guard while rendering legacy UI through its calendar view. Every one of those cases
 * is pinned by a test in this file.
 */
function importEdges(_file: string, text: string): ImportEdge[] {
  const source = stripComments(text);
  const edges: ImportEdge[] = [];

  // `import <clause> from "spec"` — clause cannot cross a `;` or another `from`.
  for (const match of source.matchAll(/\bimport\s*((?:(?!\bfrom\b)[^;])*?)\bfrom\s*["']([^"']+)["']/g)) {
    const clause = (match[1] ?? "").trim();
    const named = /^\{([\s\S]*)\}$/.exec(clause)?.[1];
    const allNamedAreTypeOnly =
      named !== undefined &&
      named.trim().length > 0 &&
      named.split(",").every((part) => part.trim().length === 0 || /^type\s+/.test(part.trim()));
    edges.push({
      specifier: match[2] as string,
      typeOnly: /^type\b/.test(clause) || allNamedAreTypeOnly,
    });
  }
  // `export ... from "spec"` (re-export).
  for (const match of source.matchAll(/\bexport\s*((?:(?!\bfrom\b)[^;])*?)\bfrom\s*["']([^"']+)["']/g)) {
    edges.push({ specifier: match[2] as string, typeOnly: /^type\b/.test((match[1] ?? "").trim()) });
  }
  // Dynamic `import("spec")`. A non-literal argument is unresolvable and skipped.
  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) {
    edges.push({ specifier: match[1] as string, typeOnly: false });
  }
  // Side-effect `import "spec"` — no clause, no parenthesis.
  for (const match of source.matchAll(/\bimport\s*["']([^"']+)["']/g)) {
    edges.push({ specifier: match[1] as string, typeOnly: false });
  }
  return edges;
}

/**
 * Resolves a relative or `@/`-alias specifier to an absolute `.ts`/`.tsx` file, trying extensions
 * in order (exact, `.ts`, `.tsx`, `/index.ts`, `/index.tsx`). Bare package specifiers
 * (`react`, `@quincy/shared`, …) and anything that does not resolve to a `.ts`/`.tsx` file
 * (CSS, JSON, type-only, third-party) are skipped silently — they are not part of this graph.
 */
function resolveSpecifier(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return undefined;
  const base = specifier.startsWith("@/") ? join(srcDir, specifier.slice(2)) : join(dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  for (const candidate of candidates) {
    if (!/\.tsx?$/.test(candidate)) continue;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/**
 * Local import targets of `file`, resolved to absolute paths.
 *
 * `runtimeOnly` drops type-only edges. Screen purity uses it (a type-only import renders
 * nothing, so it cannot make a screen visually mixed); the orphan guard does not (deleting a
 * primitive that something imports a type from still breaks the build).
 */
function localImportsOf(file: string, runtimeOnly: boolean): string[] {
  const text = readFileSync(file, "utf8");
  const resolved = new Set<string>();
  for (const edge of importEdges(file, text)) {
    if (runtimeOnly && edge.typeOnly) continue;
    const target = resolveSpecifier(file, edge.specifier);
    if (target) resolved.add(target);
  }
  return [...resolved];
}

// ---------------------------------------------------------------------------
// Guard A — pure detector: a migrated root whose closure also contains a legacy primitive
// ---------------------------------------------------------------------------

type ImportGraph = Map<string, string[]>;

interface ImpureRoot {
  root: string;
  /** One import chain per offending legacy primitive found in the root's closure. */
  chains: string[][];
}

/** BFS closure of `root` over `graph`, stopping at (but including, as a leaf) any other root. */
function closureOf(graph: ImportGraph, root: string, roots: ReadonlySet<string>) {
  const visited = new Set<string>([root]);
  const parent = new Map<string, string>();
  const queue: string[] = [root];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    // A root reached through another root's closure is a leaf: it was really imported, but its
    // own imports are not expanded, or a migrated App.tsx would swallow every screen.
    if (current !== root && roots.has(current)) continue;
    for (const next of graph.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      parent.set(next, current);
      queue.push(next);
    }
  }
  return { visited, parent };
}

function chainTo(parent: Map<string, string>, root: string, target: string): string[] {
  const chain = [target];
  let current = target;
  while (current !== root) {
    const previous = parent.get(current);
    if (previous === undefined) break;
    chain.unshift(previous);
    current = previous;
  }
  return chain;
}

/**
 * Pure detector for guard A. `roots` are the entry points; `isReuiModule`/`isLegacyPrimitive`
 * classify a node in `graph`. Deliberately asymmetric: an unmigrated root's closure is never
 * inspected for legacy primitives at all — see the header comment for why.
 */
function findImpureRoots(
  graph: ImportGraph,
  roots: string[],
  isReuiModule: (path: string) => boolean,
  isLegacyPrimitive: (path: string) => boolean,
): ImpureRoot[] {
  const rootSet = new Set(roots);
  const results: ImpureRoot[] = [];

  for (const root of roots) {
    const { visited, parent } = closureOf(graph, root, rootSet);
    const migrated = [...visited].some(isReuiModule);
    if (!migrated) continue;

    const legacyHits = [...visited].filter((path) => path !== root && isLegacyPrimitive(path));
    if (legacyHits.length === 0) continue;

    results.push({ root, chains: legacyHits.map((hit) => chainTo(parent, root, hit)) });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Guard B — pure detector: a legacy primitive with zero non-test importers
// ---------------------------------------------------------------------------

interface FileNode {
  path: string;
  isTest: boolean;
  imports: string[];
}

/**
 * Pure detector for guard B. Test-file sources are excluded from the importer count — see the
 * header comment for why that exclusion is load-bearing rather than incidental.
 */
function findOrphanPrimitives(files: FileNode[], primitives: string[]): string[] {
  const importedBy = new Set<string>();
  for (const file of files) {
    if (file.isTest) continue;
    for (const target of file.imports) importedBy.add(target);
  }
  return primitives.filter((primitive) => !importedBy.has(primitive));
}

// ---------------------------------------------------------------------------
// Baselines — see header. Both must stay `{}` today; shrink, never grow.
// ---------------------------------------------------------------------------

const SCREEN_PURITY_BASELINE: Record<string, string> = {};
const ORPHAN_PRIMITIVE_BASELINE: Record<string, string> = {};

// ---------------------------------------------------------------------------
// Real-world scan setup, shared by both guards below.
// ---------------------------------------------------------------------------

/**
 * Roots are DISCOVERED, never listed. A hardcoded list silently omits the next screen someone
 * adds, and an omitted screen is one the purity guard never checks — the exact failure this
 * guard exists to prevent, reintroduced by maintenance drift.
 */
function roots(): string[] {
  const screensDir = join(srcDir, "screens");
  const screens = existsSync(screensDir)
    ? readdirSync(screensDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.tsx$/.test(entry.name) && !isTestFile(entry.name))
        .map((entry) => join(screensDir, entry.name))
    : [];
  const shells = ["main.tsx", "App.tsx"].map((name) => join(srcDir, name)).filter((path) => existsSync(path));
  return [...shells, ...screens].sort();
}

// `rel()` returns POSIX-style separators on this platform; normalize defensively so the regexes
// below never depend on OS.
const toPosix = (path: string) => path.split("\\").join("/");

const isReuiModule = (path: string) => toPosix(rel(path)).startsWith("components/reui/");
const isLegacyPrimitive = (path: string) => !isTestFile(path) && /^components\/ui\/[^/]+\.tsx?$/.test(toPosix(rel(path)));

function legacyPrimitives(): string[] {
  const dir = join(srcDir, "components", "ui");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !isTestFile(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort();
}

// ---------------------------------------------------------------------------
// Guard A — real scan
// ---------------------------------------------------------------------------

describe("guard: a migrated screen root does not also carry a legacy primitive", () => {
  const scan = () => {
    // Runtime edges only — a type-only import renders nothing and cannot mix two design systems.
    const graph: ImportGraph = new Map(sourceFiles().map((file) => [file, localImportsOf(file, true)]));
    return findImpureRoots(graph, roots(), isReuiModule, isLegacyPrimitive);
  };

  it("has no impure roots beyond the recorded baseline", () => {
    const impure = scan();
    const unexpected = impure.filter((result) => !(rel(result.root) in SCREEN_PURITY_BASELINE));

    expect(unexpected, [
      "A root has started migrating to ReUI (its closure contains a components/reui/ module) but",
      "still carries a legacy components/ui/ primitive somewhere in the same closure. Finish",
      "migrating everything that root pulls in before calling it migrated.",
      ...unexpected.flatMap((result) =>
        result.chains.map((chain) => `  ${rel(result.root)}: ${chain.map(rel).join(" \u2192 ")}`),
      ),
    ].join("\n")).toEqual([]);
  });

  it("keeps the baseline honest — every entry is still a real impure root", () => {
    const impureRoots = new Set(scan().map((result) => rel(result.root)));
    const fixed = Object.keys(SCREEN_PURITY_BASELINE).filter((root) => !impureRoots.has(root));
    expect(fixed, `Fixed — delete from SCREEN_PURITY_BASELINE: ${fixed.join(", ")}`).toEqual([]);
  });
});

describe("guard A self-test: the impure-root detector actually fires on a synthetic violation", () => {
  it("reports a root that imports both a ReUI module and a legacy primitive, naming both in the chain", () => {
    const graph: ImportGraph = new Map([
      ["screens/Fake.tsx", ["components/reui/x.tsx", "components/Shared.tsx"]],
      ["components/Shared.tsx", ["components/ui/button.tsx"]],
    ]);
    const results = findImpureRoots(
      graph,
      ["screens/Fake.tsx"],
      (path) => path.startsWith("components/reui/"),
      (path) => path.startsWith("components/ui/"),
    );

    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result?.root).toBe("screens/Fake.tsx");
    expect(result?.chains).toEqual([["screens/Fake.tsx", "components/Shared.tsx", "components/ui/button.tsx"]]);
  });

  it("does NOT report an unmigrated root that imports a legacy primitive (the asymmetry)", () => {
    const graph: ImportGraph = new Map([["screens/Fake.tsx", ["components/ui/button.tsx"]]]);
    const results = findImpureRoots(
      graph,
      ["screens/Fake.tsx"],
      (path) => path.startsWith("components/reui/"),
      (path) => path.startsWith("components/ui/"),
    );

    expect(results).toEqual([]);
  });
});

describe("the import parser itself — exercised directly, because the graph tests above inject their own", () => {
  const parse = (source: string, runtimeOnly: boolean) =>
    importEdges("probe.tsx", source)
      .filter((edge) => !(runtimeOnly && edge.typeOnly))
      .map((edge) => edge.specifier)
      .sort();

  it("sees a dynamic import(), the miss that let a lazy-loaded screen hide legacy UI", () => {
    // Dashboard.tsx's real shape: lazy(() => import("../components/ProductionCalendar")).
    expect(parse(`const C = lazy(() => import("./ProductionCalendar"));`, true)).toEqual(["./ProductionCalendar"]);
  });

  it("ignores a commented-out import", () => {
    expect(parse(`// import { Button } from "./ui/button";\nconst x = 1;`, true)).toEqual([]);
    expect(parse(`/* import { Button } from "./ui/button"; */\nconst x = 1;`, true)).toEqual([]);
  });

  it("sees compact syntax with no spaces", () => {
    expect(parse(`import{Button}from"./ui/button";`, true)).toEqual(["./ui/button"]);
  });

  it("treats `import type` as type-only, and a value import as runtime", () => {
    expect(parse(`import type { Props } from "./ui/button";`, true)).toEqual([]);
    expect(parse(`import type { Props } from "./ui/button";`, false)).toEqual(["./ui/button"]);
    expect(parse(`import { Button } from "./ui/button";`, true)).toEqual(["./ui/button"]);
  });

  it("treats an all-inline-type named clause as type-only, but a mixed one as runtime", () => {
    expect(parse(`import { type Props } from "./ui/button";`, true)).toEqual([]);
    expect(parse(`import { Button, type Props } from "./ui/button";`, true)).toEqual(["./ui/button"]);
  });

  it("sees side-effect and re-export forms", () => {
    expect(parse(`import "./styles.css";`, true)).toEqual(["./styles.css"]);
    expect(parse(`export { Button } from "./ui/button";`, true)).toEqual(["./ui/button"]);
  });
});

describe("root discovery", () => {
  it("finds every non-test screen plus the two shells, with nothing hardcoded", () => {
    const found = roots().map((path) => toPosix(rel(path)));
    expect(found).toContain("App.tsx");
    expect(found).toContain("main.tsx");
    expect(found.filter((path) => path.startsWith("screens/")).length).toBeGreaterThan(0);
    expect(found.every((path) => !isTestFile(path))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guard B — real scan
// ---------------------------------------------------------------------------

describe("guard: no legacy primitive has zero non-test importers", () => {
  const scan = () => {
    // Type-only edges DO count here: deleting a primitive something imports a type from
    // still breaks the build, so it is not orphaned.
    const files: FileNode[] = allFiles().map((file) => ({
      path: file,
      isTest: isTestFile(file),
      imports: localImportsOf(file, false),
    }));
    return findOrphanPrimitives(files, legacyPrimitives());
  };

  it("has no orphaned primitives beyond the recorded baseline", () => {
    const orphans = scan();
    const unexpected = orphans.filter((path) => !(rel(path) in ORPHAN_PRIMITIVE_BASELINE));

    expect(unexpected, [
      "A components/ui/ primitive has zero importers among non-test source files. Delete the",
      "primitive and its colocated test together, in the slice that removed its last consumer.",
      ...unexpected.map((path) => `  ${rel(path)}`),
    ].join("\n")).toEqual([]);
  });

  it("keeps the baseline honest — every entry is still a real orphan", () => {
    const orphans = new Set(scan().map((path) => rel(path)));
    const fixed = Object.keys(ORPHAN_PRIMITIVE_BASELINE).filter((path) => !orphans.has(path));
    expect(fixed, `Fixed — delete from ORPHAN_PRIMITIVE_BASELINE: ${fixed.join(", ")}`).toEqual([]);
  });
});

describe("guard B self-test: the orphan-primitive detector actually fires on a synthetic violation", () => {
  it("reports a primitive whose only importer is its own *.dom.test.tsx as orphaned", () => {
    const files: FileNode[] = [
      { path: "components/ui/fake.tsx", isTest: false, imports: [] },
      { path: "components/ui/fake.dom.test.tsx", isTest: true, imports: ["components/ui/fake.tsx"] },
    ];

    expect(findOrphanPrimitives(files, ["components/ui/fake.tsx"])).toEqual(["components/ui/fake.tsx"]);
  });

  it("does NOT report a primitive imported by another ui/ module (intra-directory edges count)", () => {
    const files: FileNode[] = [
      { path: "components/ui/fake.tsx", isTest: false, imports: [] },
      { path: "components/ui/other.tsx", isTest: false, imports: ["components/ui/fake.tsx"] },
    ];

    expect(findOrphanPrimitives(files, ["components/ui/fake.tsx"])).toEqual([]);
  });
});
