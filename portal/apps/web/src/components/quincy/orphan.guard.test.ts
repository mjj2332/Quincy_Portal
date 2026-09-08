/**
 * Orphan guard — every non-test `.ts`/`.tsx` file directly inside `components/quincy/` must have
 * at least one non-test importer. A module nobody imports anymore is dead weight that should have
 * been deleted in the same slice that removed its last consumer.
 *
 * ## Why `quincy/` and not `reui/`
 *
 * `components/quincy/` is code this repository owns: a module with zero remaining consumers here
 * is real rot, left behind by a rename or a refactor that forgot to clean up. `components/reui/`
 * is a vendored registry set — the shadcn CLI can re-add any component on demand, and the ordinary
 * workflow is to install a component in one commit and wire it up in the next. Watching `reui/`
 * would fail the build on that ordinary workflow, so it is out of scope here.
 *
 * ## Recorded limitation
 *
 * This guard counts incoming import edges, not reachability from an entry point. Two modules that
 * import only each other, and nothing else in the app, still pass: each has a non-zero importer
 * count. It detects orphans, not dead code, and must not be described as dead-code detection.
 *
 * ## Rules carried over from the retired guard
 *
 * Test files do **not** count as importers: a primitive's own colocated `*.dom.test.tsx` imports
 * it forever, so if tests counted, a primitive could never be reported orphaned while its test
 * file exists and the guard would be dead by construction. Intra-`quincy/` importers **do**
 * count — most primitives here are consumed by other primitives in the same directory before
 * anything outside it touches them, and excluding intra-directory edges would force baseline
 * entries for primitives that are not actually dead. Type-only edges also count as importers:
 * deleting a module something imports only a type from still breaks the build.
 *
 * If this guard fires: delete the module and its colocated test together, in the same slice that
 * removes its last consumer.
 *
 * `ORPHAN_BASELINE` exists so the guard could be switched on with an existing orphan without
 * demanding an instant fix. It is `{}` today — every module in `components/quincy/` has a real
 * non-test importer. **Baselines shrink; they never grow.** Adding an entry to make a build pass
 * defeats the guard this file exists to be.
 *
 * This file replaces guard B of the retired `config/reui-migration.guard.test.ts` (#56). Guard A
 * of that file (screen purity) is not replaced: it became unfalsifiable once `components/ui/`
 * emptied out, since nothing can be both migrated and legacy when no legacy primitive exists.
 *
 * `docs/lessons.md` states the doctrine this file follows: "a grep gate that cannot fail is not a
 * gate." The real-world scan below passes vacuously today — nothing in `components/quincy/` is
 * currently orphaned — so a scan that never fires is not evidence the detector works. The detector
 * is therefore factored as a pure function over an injected graph structure (not something that
 * reads the filesystem itself), and is exercised with a synthetic fixture, below the real scan,
 * that manufactures the violation and asserts the detector reports it.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const quincyDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(quincyDir, "..", "..");

const rel = (file: string) => relative(srcDir, file);

// ---------------------------------------------------------------------------
// Filesystem helpers — duplicated from `styles/design-system-guards.test.ts` on purpose (that file
// is not imported from here so this guard file has no dependency on the shared one).
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

// ---------------------------------------------------------------------------
// Import extraction and resolution — relative and `@/`-alias imports only, static forms only.
// ---------------------------------------------------------------------------

interface ImportEdge {
  specifier: string;
  /**
   * True for `import type {...}` and for a clause whose named bindings are ALL `type`-only. Such
   * an edge disappears at runtime, but it still pins the module at compile time, so it DOES count
   * as an importer for this guard.
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
 * lazy-loads ProductionCalendar, which imports a legacy primitive, so Dashboard could have passed
 * a purity-style guard while rendering it through a calendar view. Every one of those cases is
 * pinned by a test in this file.
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
 * Local import targets of `file`, resolved to absolute paths. Type-only edges are NOT dropped:
 * deleting a module that something imports a type from still breaks the build, so this guard
 * treats a type-only edge as a real importer.
 */
function localImportsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const resolved = new Set<string>();
  for (const edge of importEdges(file, text)) {
    const target = resolveSpecifier(file, edge.specifier);
    if (target) resolved.add(target);
  }
  return [...resolved];
}

// ---------------------------------------------------------------------------
// Pure detector — a `components/quincy/` module with zero non-test importers
// ---------------------------------------------------------------------------

interface FileNode {
  path: string;
  isTest: boolean;
  imports: string[];
}

/**
 * Pure detector. Test-file sources are excluded from the importer count — see the header comment
 * for why that exclusion is load-bearing rather than incidental.
 */
function findOrphans(files: FileNode[], watched: string[]): string[] {
  const importedBy = new Set<string>();
  for (const file of files) {
    if (file.isTest) continue;
    for (const target of file.imports) importedBy.add(target);
  }
  return watched.filter((path) => !importedBy.has(path));
}

// ---------------------------------------------------------------------------
// Baseline — see header. Must stay `{}` today; shrink, never grow.
// ---------------------------------------------------------------------------

const ORPHAN_BASELINE: Record<string, string> = {};

// ---------------------------------------------------------------------------
// Real-world scan setup
// ---------------------------------------------------------------------------

function watchedModules(): string[] {
  return readdirSync(quincyDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !isTestFile(entry.name))
    .map((entry) => join(quincyDir, entry.name))
    .sort();
}

describe("guard: no components/quincy/ module has zero non-test importers", () => {
  const scan = () => {
    // Type-only edges DO count here: deleting a module something imports a type from still
    // breaks the build, so it is not orphaned.
    const files: FileNode[] = allFiles().map((file) => ({
      path: file,
      isTest: isTestFile(file),
      imports: localImportsOf(file),
    }));
    return findOrphans(files, watchedModules());
  };

  it("has no orphaned modules beyond the recorded baseline", () => {
    const orphans = scan();
    const unexpected = orphans.filter((path) => !(rel(path) in ORPHAN_BASELINE));

    expect(unexpected, [
      "A components/quincy/ module has zero importers among non-test source files. Delete the",
      "module and its colocated test together, in the slice that removed its last consumer.",
      ...unexpected.map((path) => `  ${rel(path)}`),
    ].join("\n")).toEqual([]);
  });

  it("keeps the baseline honest — every entry is still a real orphan", () => {
    const orphans = new Set(scan().map((path) => rel(path)));
    const fixed = Object.keys(ORPHAN_BASELINE).filter((path) => !orphans.has(path));
    expect(fixed, `Fixed — delete from ORPHAN_BASELINE: ${fixed.join(", ")}`).toEqual([]);
  });
});

describe("guard self-test: the orphan detector actually fires on a synthetic violation", () => {
  it("reports a module whose only importer is its own *.dom.test.tsx as orphaned", () => {
    const files: FileNode[] = [
      { path: "components/quincy/fake.tsx", isTest: false, imports: [] },
      { path: "components/quincy/fake.dom.test.tsx", isTest: true, imports: ["components/quincy/fake.tsx"] },
    ];

    expect(findOrphans(files, ["components/quincy/fake.tsx"])).toEqual(["components/quincy/fake.tsx"]);
  });

  it("does NOT report a module imported by another quincy/ module (intra-directory edges count)", () => {
    const files: FileNode[] = [
      { path: "components/quincy/fake.tsx", isTest: false, imports: [] },
      { path: "components/quincy/other.tsx", isTest: false, imports: ["components/quincy/fake.tsx"] },
    ];

    expect(findOrphans(files, ["components/quincy/fake.tsx"])).toEqual([]);
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
    expect(parse(`// import { Button } from "./quincy/Button";\nconst x = 1;`, true)).toEqual([]);
    expect(parse(`/* import { Button } from "./quincy/Button"; */\nconst x = 1;`, true)).toEqual([]);
  });

  it("sees compact syntax with no spaces", () => {
    expect(parse(`import{Button}from"./quincy/Button";`, true)).toEqual(["./quincy/Button"]);
  });

  it("treats `import type` as type-only, and a value import as runtime", () => {
    expect(parse(`import type { Props } from "./quincy/Button";`, true)).toEqual([]);
    expect(parse(`import type { Props } from "./quincy/Button";`, false)).toEqual(["./quincy/Button"]);
    expect(parse(`import { Button } from "./quincy/Button";`, true)).toEqual(["./quincy/Button"]);
  });

  it("treats an all-inline-type named clause as type-only, but a mixed one as runtime", () => {
    expect(parse(`import { type Props } from "./quincy/Button";`, true)).toEqual([]);
    expect(parse(`import { Button, type Props } from "./quincy/Button";`, true)).toEqual(["./quincy/Button"]);
  });

  it("sees side-effect and re-export forms", () => {
    expect(parse(`import "./styles.css";`, true)).toEqual(["./styles.css"]);
    expect(parse(`export { Button } from "./quincy/Button";`, true)).toEqual(["./quincy/Button"]);
  });
});
