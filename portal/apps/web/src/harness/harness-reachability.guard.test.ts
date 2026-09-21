/**
 * Harness reachability guard (#219, stage 1 of PR A — Gantt).
 *
 * `src/harness/reui-scheduling/` is a dev-only Vite HTML entry
 * (`harness/reui-scheduling/index.html` + `src/harness/reui-scheduling/main.tsx`) that exists so
 * the vendored ReUI scheduling primitives (`components/reui/gantt/`, later
 * `components/reui/event-calendar/`) can be exercised with local fixture data before anything in
 * the production app imports them. It is deliberately NOT a TanStack route, NOT a feature flag,
 * and NOT a branch in `src/main.tsx` — it is a second Vite HTML entry, reachable only because
 * `vite dev` serves any HTML file under the project root at its own path, and unreachable in
 * production because `vite.config.ts` never lists it in `build.rollupOptions.input`, which
 * defaults to `index.html` alone.
 *
 * That safety rests on four separate facts, each pinned by a describe block below:
 *
 * (i)   No non-test source file outside `src/harness/` imports anything under `src/harness/`,
 *       including via an `import.meta.glob` whose pattern could reach that tree.
 * (ii)  No non-test source file outside `src/harness/`, outside `components/reui/gantt/` /
 *       `components/reui/event-calendar/`, and outside `ALLOWED_VENDOR_SCHEDULING_CONSUMERS`
 *       imports from either of those two vendored trees, same glob-reach rule. #219 stage 1 landed
 *       both vendored trees with nothing wired to them at all. #220 relaxed this deliberately for
 *       Gantt — `components/ProductionGantt.tsx` is now that tree's real production consumer, an
 *       exact-file-path entry on the allow list below, reached from `screens/Dashboard.tsx` only
 *       through a literal `lazy(() => import(...))` that never itself imports the vendored tree.
 *       #222 has not yet done the same for `event-calendar/`; when it does, it adds its own
 *       consumer to the same list with its own comment, the same way, rather than widening the
 *       prefix match.
 * (iii) No non-test production source file hides a NEW non-literal `import()` call that could,
 *       at runtime, resolve to the harness or the vendored trees. A fixed, exact baseline
 *       (file + count) whitelists what is already on `main`; anything beyond that baseline fails.
 * (iv)  `vite.config.ts`'s `build.rollupOptions.input` is absent or resolves — by AST, not
 *       substring match — only to `index.html`, so `vite build`'s only input stays `index.html`
 *       and no harness chunk or URL reaches production; and `vite.config.ts` registers the
 *       `forbid-dev-only-modules` build plugin (`src/build/forbid-dev-only-modules.ts`) as a
 *       direct, unconditional element of `plugins`, so the module graph itself is the backstop
 *       when this file's own import-form enumeration misses one (#219 PR A round 2 BLOCKER — see
 *       below). That plugin's own tests live beside it, not here: this file only asserts it is
 *       actually wired in.
 *
 * ## Round 2 fixes (#219 PR A, Sol's re-review)
 * `scratchpad/sol-219a-r2-report.md`'s BLOCKER found this guard itself bypassable three ways:
 * valid Vite `/src/...` absolute specifiers and `?raw`/`?worker`-suffixed specifiers were not
 * resolved at all, `new Worker(new URL(..., import.meta.url))` (and bare `new URL(...)`) were not
 * extracted, and `defineConfig({ ...cfg })`-style spreads on the config/`build`/`rollupOptions`
 * objects were read as "no build option present" instead of failing closed. All four are fixed
 * below (see `stripQueryAndHash`, `resolveSpecifier`'s `/`-prefix branch, `extractSpecifiers`' new
 * `NewExpression` case, and `objectExpressionHasSpread`). The dist/-content detector this guard
 * used to carry as a fourth backstop is gone — Sol's review called it "meaningless after
 * minification, stale outside CI": Tailwind's content scanner and minification both erase the
 * filename-shaped needles it relied on, and a stale `dist/` between builds silently skips it
 * outside CI. The bundler's own module graph (the new `forbid-dev-only-modules` Vite plugin, (iv)
 * above) replaces it as the authoritative backstop; this guard only proves that plugin is wired.
 *
 * ## Round 3 fixes (#219 PR A, Sol's round-3 review)
 * `scratchpad/sol-219a-r3-report.md`'s BLOCKER found the round 2 backstop still had two holes:
 * (1) `forbid-dev-only-modules.ts` was registered only in the top-level `plugins` array — Vite 8's
 * worker sub-builds (`new Worker(new URL(...))`) run an entirely separate Rolldown bundling pass
 * with their own plugin pipeline, so a restricted module reachable only through a worker evaded it.
 * Fixed by ALSO registering a fresh instance via `worker.plugins` in `vite.config.ts` — see the
 * "registers forbid-dev-only-modules ... via worker.plugins too" block below, and
 * `vite.config.ts`'s own comment. (2) an asset (`.css`/`.svg`/`.png`/`.json`/`.wasm`/…) referenced
 * only via a Vite asset URL or a CSS `url(...)` can be emitted with no module id shape either scan
 * is guaranteed to see. Orchestrator decision: rather than build an asset-origin scanner, the hole
 * is made impossible — see the "may contain only scanned source" guard below, which fails on any
 * non-source file anywhere under `src/harness/` or `src/components/reui/gantt/` (except a literal
 * `.html`/`.md` directly inside the harness's own HTML entry dir).
 *
 * ## Parser decision (#219 PR A round 2)
 * `typescript` (7.0.2, native) has no public `createSourceFile` in this toolchain, so this guard
 * parses with `@babel/parser`, pinned as an exact `apps/web` devDependency
 * (`portal/apps/web/package.json`) at the version already resolved transitively by `shadcn` in the
 * root lockfile (7.29.8) — `npm install -D -E @babel/parser@7.29.8 -w @quincy/web` added exactly
 * one lockfile line, no new package resolutions. Plugins: `["typescript", "jsx", "importMeta"]`
 * for `.tsx`/`.jsx`/`.js`/`.mjs`/`.cjs`; `["typescript", "importMeta"]` (no `jsx`) for
 * `.ts`/`.mts`/`.cts`, where a leading `<T>(x: T) =>` generic arrow is otherwise ambiguous with a
 * JSX opening tag. Verified: every one of the 364 real files under `src/` parses cleanly under
 * this plugin split (see the commit that introduced this file for the one-off verification
 * script; it is not checked in). A file that fails to parse FAILS this guard — see the "no file
 * fails to parse" assertion below — rather than being silently skipped. The AST is walked by hand
 * (a small recursive walk over each node's own enumerable fields, skipping `loc`/`start`/`end`/
 * `range`/`extra`/`*Comments`), not with `@babel/traverse` — this guard has exactly one pass to
 * make per file and does not need a visitor framework for it.
 *
 * Modelled on `lib/routing-transport.guard.test.ts`: every detector is a pure function over
 * injected input, exercised here with a synthetic fixture that PLANTS the violation it looks for
 * and asserts the detector reports it — per `docs/lessons.md`, "a grep gate that cannot fail is
 * not a gate." Import resolution (aliased `@/…` and relative specifiers) is duplicated from
 * `components/quincy/orphan.guard.test.ts` on purpose — that file is not imported from here, so
 * this guard has no dependency on it. Unlike that file, this one also resolves `.js/.jsx/.mts/
 * .cts/.mjs/.cjs` (Vite's full set of source extensions) and extracts specifiers with a real
 * parser instead of regex, because stage 1's own planted fixtures proved regex-on-comment-stripped
 * text misses valid Vite forms (`import(\`literal\`)`, `import.meta.glob`, `require()`) — see
 * `scratchpad/sol-219a-s2-report.md` BLOCKER.
 *
 * This file is `.test.ts`, so it runs in the NODE suite (`vitest.config.ts`), not the happy-dom
 * one. It reads sources as text; it renders nothing.
 */
import { describe, expect, it } from "vitest";
import { parse } from "@babel/parser";
import type { ParserPlugin } from "@babel/parser";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, relative, sep } from "node:path";

const harnessDir = dirname(fileURLToPath(import.meta.url)); // .../src/harness
const srcDir = join(harnessDir, ".."); // .../src
const webDir = join(srcDir, ".."); // .../apps/web

const rel = (file: string) => relative(srcDir, file).split(sep).join("/");

// ---------------------------------------------------------------------------
// Filesystem walk
// ---------------------------------------------------------------------------

/** Every Vite-supported JS/TS source extension. */
const VITE_SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];

function isViteSourceFile(filename: string): boolean {
  return VITE_SOURCE_EXTENSIONS.includes(extname(filename));
}

function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSourceFiles(full));
    else if (isViteSourceFile(entry.name)) out.push(full);
  }
  return out;
}

const isTestFile = (file: string) => /\.test\.tsx?$/.test(file);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const NO_JSX_EXTENSIONS = new Set([".ts", ".mts", ".cts"]);
const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

function pluginsForExtension(ext: string): ParserPlugin[] {
  const plugins: ParserPlugin[] = ["importMeta"];
  if (TYPESCRIPT_EXTENSIONS.has(ext)) plugins.push("typescript");
  if (!NO_JSX_EXTENSIONS.has(ext)) plugins.push("jsx");
  return plugins;
}

interface ParseResult {
  ok: true;
  ast: ReturnType<typeof parse>;
}
interface ParseFailure {
  ok: false;
  error: string;
}

/** Fail closed: a file that does not parse is reported as a failure, never silently skipped. */
function parseSource(text: string, ext: string): ParseResult | ParseFailure {
  try {
    const ast = parse(text, { sourceType: "module", plugins: pluginsForExtension(ext), errorRecovery: false });
    return { ok: true, ast };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Hand-rolled AST walk (no @babel/traverse)
// ---------------------------------------------------------------------------

type AstNode = { type: string; [key: string]: unknown };

const WALK_SKIP_KEYS = new Set(["loc", "start", "end", "range", "extra", "leadingComments", "trailingComments", "innerComments"]);

function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function walkAst(node: unknown, visit: (node: AstNode) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walkAst(item, visit);
    return;
  }
  if (!isAstNode(node)) return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || WALK_SKIP_KEYS.has(key)) continue;
    const value = (node as Record<string, unknown>)[key];
    if (Array.isArray(value)) walkAst(value, visit);
    else if (isAstNode(value)) walkAst(value, visit);
  }
}

// ---------------------------------------------------------------------------
// Specifier extraction
// ---------------------------------------------------------------------------

function isNoSubstitutionTemplate(node: AstNode): boolean {
  return node.type === "TemplateLiteral" && Array.isArray(node.expressions) && node.expressions.length === 0;
}

function templateLiteralValue(node: AstNode): string | undefined {
  const quasis = node.quasis as Array<{ value: { cooked: string | null } }> | undefined;
  if (!quasis || quasis.length !== 1) return undefined;
  return quasis[0]?.value.cooked ?? undefined;
}

function literalStringValue(node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "StringLiteral") return node.value as string;
  if (isNoSubstitutionTemplate(node)) return templateLiteralValue(node);
  return undefined;
}

/** import.meta.glob / import.meta.globEager, called as a MemberExpression on `import.meta`. */
function isImportMetaGlobCallee(callee: AstNode): boolean {
  if (callee.type !== "MemberExpression") return false;
  const object = callee.object as AstNode;
  const property = callee.property as AstNode & { name?: string };
  if (object.type !== "MetaProperty") return false;
  const meta = object.meta as AstNode & { name?: string };
  const objProp = object.property as AstNode & { name?: string };
  if (meta.name !== "import" || objProp.name !== "meta") return false;
  return property.name === "glob" || property.name === "globEager";
}

/**
 * `import.meta.url`, read as a MemberExpression on `import.meta` — the second argument Vite
 * requires for its special-cased `new URL("...", import.meta.url)` asset/worker form (round 2 fix,
 * Sol BLOCKER: this form, and `new Worker(new URL(...))` built from it, were not extracted at all).
 */
function isImportMetaUrl(node: AstNode | undefined): boolean {
  if (!node || node.type !== "MemberExpression") return false;
  const object = node.object as AstNode;
  const property = node.property as AstNode & { name?: string };
  if (object.type !== "MetaProperty") return false;
  const meta = object.meta as AstNode & { name?: string };
  const objProp = object.property as AstNode & { name?: string };
  if (meta.name !== "import" || objProp.name !== "meta") return false;
  return property.name === "url";
}

/**
 * #220 S8 decision record: this walk (and `extractSpecifiers` below) never reads Babel's
 * `importKind` — a whole-declaration `import type { X } from "..."`, or a per-specifier
 * `import { type X } from "..."`, is captured as a `literalSpecifiers` entry exactly like a value
 * import. That is a deliberate, tested choice, not an oversight: see the "whole-scanner fixtures"
 * describe block below (`import type { X } from vendored gantt is STILL caught...`) for the
 * self-tests that lock it in, and their own comment for the full reasoning (short version: a
 * type-only import is elided under this project's `isolatedModules: true` and so can never reach
 * `forbid-dev-only-modules.ts`'s real, build-time module-graph backstop regardless of what this
 * static guard does; importKind-aware parsing has a real correctness cost — whole-declaration,
 * per-specifier, and `export type` forms each need distinct handling and their own tests — for a
 * benefit that is purely cosmetic). `lib/production-gantt-adapter.ts`'s own header records the
 * same finding from the consuming side, and keeps its `ProductionGanttResource`/
 * `ProductionGanttEvent<TData>` as local structural types rather than `import type`-ing the real
 * vendored ones, for exactly this reason.
 */
interface ExtractionResult {
  /** Literal specifiers from static import / export-from / literal or template import() / literal require(). */
  literalSpecifiers: string[];
  /** Literal string arguments (or array elements) of import.meta.glob / globEager calls. */
  globPatterns: string[];
  /** Count of `import(...)` calls whose argument is neither a string literal nor a no-substitution template. */
  nonLiteralDynamicImportCount: number;
}

function extractSpecifiers(text: string, ext: string): ExtractionResult | { parseError: string } {
  const parsed = parseSource(text, ext);
  if (!parsed.ok) return { parseError: parsed.error };

  const literalSpecifiers: string[] = [];
  const globPatterns: string[] = [];
  let nonLiteralDynamicImportCount = 0;

  walkAst(parsed.ast.program, (node) => {
    if (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") {
      const source = node.source as AstNode | null | undefined;
      if (source && source.type === "StringLiteral") literalSpecifiers.push(source.value as string);
      return;
    }
    if (node.type === "CallExpression") {
      const callee = node.callee as AstNode;
      const args = node.arguments as AstNode[];
      if (callee.type === "Import") {
        const value = literalStringValue(args[0]);
        if (value !== undefined) literalSpecifiers.push(value);
        else nonLiteralDynamicImportCount += 1;
        return;
      }
      if (callee.type === "Identifier" && (callee as { name?: string }).name === "require") {
        const value = literalStringValue(args[0]);
        if (value !== undefined) literalSpecifiers.push(value);
        return;
      }
      if (isImportMetaGlobCallee(callee)) {
        const arg = args[0];
        if (arg?.type === "ArrayExpression") {
          for (const element of (arg.elements as (AstNode | null)[]) ?? []) {
            const value = literalStringValue(element ?? undefined);
            if (value !== undefined) globPatterns.push(value);
          }
        } else {
          const value = literalStringValue(arg);
          if (value !== undefined) globPatterns.push(value);
        }
      }
      return;
    }
    // `new URL("...", import.meta.url)` — Vite's special-cased asset/worker URL form. Catching it
    // here (rather than only inside a `new Worker(...)` wrapper) is enough for both: the walk
    // visits every node, so a bare `new URL(...)` and one nested inside `new Worker(new URL(...))`
    // are both reached the same way.
    if (node.type === "NewExpression") {
      const callee = node.callee as AstNode & { name?: string };
      const args = node.arguments as AstNode[];
      if (callee.type === "Identifier" && callee.name === "URL" && isImportMetaUrl(args[1])) {
        const value = literalStringValue(args[0]);
        if (value !== undefined) literalSpecifiers.push(value);
      }
    }
  });

  return { literalSpecifiers, globPatterns, nonLiteralDynamicImportCount };
}

// ---------------------------------------------------------------------------
// Import resolution — same alias/relative rules as
// components/quincy/orphan.guard.test.ts, deliberately not imported from it, extended to all
// Vite source extensions (that file only needed .ts/.tsx).
// ---------------------------------------------------------------------------

const RESOLVE_EXTENSION_CANDIDATES = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Strips a trailing `?query` and/or `#hash` from a specifier before path resolution. Round 2 fix
 * (Sol BLOCKER): Vite import forms like `?raw`, `?worker`, `?url`, and a fragment on a
 * `new URL(...)` target are not part of the on-disk path and used to make `resolveSpecifier` fail
 * to resolve an otherwise-valid Vite specifier.
 */
function stripQueryAndHash(specifier: string): string {
  const hashIndex = specifier.indexOf("#");
  const withoutHash = hashIndex === -1 ? specifier : specifier.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf("?");
  return queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
}

/**
 * Resolves a relative, `@/`-alias, or project-root-absolute (`/src/...`) specifier to an absolute
 * source file. Bare package specifiers and anything that does not resolve to a Vite source file are
 * skipped silently — they are not part of this graph. Round 2 fix (Sol BLOCKER): the `/`-prefix
 * branch (Vite resolves a leading `/` against the project root, the same rule
 * `globBaseDir` below already applied to glob patterns) was previously entirely missing, so a valid
 * `import(...)` of `/src/components/reui/gantt/gantt.tsx` resolved to nothing.
 */
function resolveSpecifier(fromFile: string, rawSpecifier: string): string | undefined {
  const specifier = stripQueryAndHash(rawSpecifier);
  if (!specifier.startsWith(".") && !specifier.startsWith("@/") && !specifier.startsWith("/")) return undefined;
  const base = specifier.startsWith("@/")
    ? join(srcDir, specifier.slice(2))
    : specifier.startsWith("/")
      ? join(webDir, specifier.slice(1))
      : join(dirname(fromFile), specifier);
  const directCandidates = RESOLVE_EXTENSION_CANDIDATES.map((extension) => `${base}${extension}`);
  const indexCandidates = RESOLVE_EXTENSION_CANDIDATES.filter((extension) => extension !== "").map((extension) =>
    join(base, `index${extension}`),
  );
  for (const candidate of [...directCandidates, ...indexCandidates]) {
    if (!isViteSourceFile(candidate)) continue;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// import.meta.glob reach — does a literal glob pattern's base directory overlap a restricted dir?
// ---------------------------------------------------------------------------

const GLOB_MAGIC = /[*?{}[\]!]/;

/** The restricted directories, srcDir-relative with a trailing slash, that a glob must not reach. */
const RESTRICTED_GLOB_DIRS = ["harness/", "components/reui/gantt/", "components/reui/event-calendar/"];

function pathIsWithinOrEqual(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

/** The literal (non-glob) base directory a pattern resolves to, or undefined for a bare specifier. */
function globBaseDir(fromFile: string, pattern: string): string | undefined {
  let base: string;
  let rest: string;
  if (pattern.startsWith("@/")) {
    base = srcDir;
    rest = pattern.slice(2);
  } else if (pattern.startsWith("/")) {
    base = webDir;
    rest = pattern.slice(1);
  } else if (pattern.startsWith(".")) {
    base = dirname(fromFile);
    rest = pattern;
  } else {
    return undefined;
  }
  const chars = [...rest];
  const magicIndex = chars.findIndex((char) => GLOB_MAGIC.test(char));
  const literalPart = magicIndex === -1 ? rest : rest.slice(0, magicIndex);
  const lastSlash = literalPart.lastIndexOf("/");
  const dirSegment = lastSlash === -1 ? "" : literalPart.slice(0, lastSlash);
  return join(base, dirSegment);
}

/**
 * For each pattern, returns the restricted dirs (from `RESTRICTED_GLOB_DIRS`) it could reach:
 * either the pattern's base dir is inside the restricted dir, or the restricted dir is inside the
 * pattern's base dir (a glob rooted above it, e.g. `src/**`, can still walk into it).
 */
function globReachableRestrictedDirs(fromFile: string, patterns: string[]): string[] {
  const reached = new Set<string>();
  for (const pattern of patterns) {
    const base = globBaseDir(fromFile, pattern);
    if (!base) continue;
    for (const restricted of RESTRICTED_GLOB_DIRS) {
      const restrictedAbs = join(srcDir, restricted);
      if (pathIsWithinOrEqual(base, restrictedAbs) || pathIsWithinOrEqual(restrictedAbs, base)) {
        reached.add(restricted);
      }
    }
  }
  return [...reached];
}

// ---------------------------------------------------------------------------
// FileNode assembly — the whole scanner: source text -> extraction -> resolution
// ---------------------------------------------------------------------------

interface FileNode {
  path: string; // srcDir-relative, forward slashes
  isTest: boolean;
  importTargets: string[]; // srcDir-relative, forward slashes; includes glob-reach synthetic targets
  nonLiteralDynamicImportCount: number;
  parseError?: string;
}

/** Runs one file's source text through the whole scanner: parse -> extract -> resolve -> FileNode. */
function scanFile(absPath: string): FileNode {
  const path = rel(absPath);
  const isTest = isTestFile(absPath);
  const text = readFileSync(absPath, "utf8");
  const extraction = extractSpecifiers(text, extname(absPath));
  if ("parseError" in extraction) {
    return { path, isTest, importTargets: [], nonLiteralDynamicImportCount: 0, parseError: extraction.parseError };
  }
  const importTargets = new Set<string>();
  for (const specifier of extraction.literalSpecifiers) {
    const target = resolveSpecifier(absPath, specifier);
    if (target) importTargets.add(rel(target));
  }
  for (const restricted of globReachableRestrictedDirs(absPath, extraction.globPatterns)) {
    importTargets.add(restricted);
  }
  return {
    path,
    isTest,
    importTargets: [...importTargets],
    nonLiteralDynamicImportCount: extraction.nonLiteralDynamicImportCount,
  };
}

function scanAllSourceFiles(): FileNode[] {
  return walkSourceFiles(srcDir).map(scanFile);
}

// ---------------------------------------------------------------------------
// Detector (i) — nothing outside src/harness/ imports src/harness/
// ---------------------------------------------------------------------------

function findHarnessImportersOutsideHarness(files: FileNode[]): string[] {
  return files
    .filter((file) => !file.isTest && !file.path.startsWith("harness/"))
    .filter((file) => file.importTargets.some((target) => target.startsWith("harness/")))
    .map((file) => file.path)
    .sort();
}

describe("guard: nothing outside src/harness/ imports src/harness/", () => {
  it("self-test: fires on a planted importer, and not on the harness importing itself", () => {
    const planted: FileNode[] = [
      { path: "screens/Dashboard.tsx", isTest: false, importTargets: ["harness/reui-scheduling/main.tsx"], nonLiteralDynamicImportCount: 0 },
      { path: "harness/reui-scheduling/main.tsx", isTest: false, importTargets: ["harness/reui-scheduling/fixtures.ts"], nonLiteralDynamicImportCount: 0 },
      { path: "App.tsx", isTest: false, importTargets: ["screens/Dashboard.tsx"], nonLiteralDynamicImportCount: 0 },
    ];
    expect(findHarnessImportersOutsideHarness(planted)).toEqual(["screens/Dashboard.tsx"]);
  });

  it("self-test: fires on an import.meta.glob whose pattern could reach src/harness/", () => {
    const planted: FileNode[] = [
      { path: "screens/Dashboard.tsx", isTest: false, importTargets: ["harness/"], nonLiteralDynamicImportCount: 0 },
    ];
    expect(findHarnessImportersOutsideHarness(planted)).toEqual(["screens/Dashboard.tsx"]);
  });

  it("finds no real importer outside src/harness/", () => {
    const offenders = findHarnessImportersOutsideHarness(scanAllSourceFiles());
    expect(offenders, [
      "A non-test source file outside src/harness/ imports from the dev-only vendor harness.",
      "The harness is a leaf the app tree must never reach back into.",
      ...offenders.map((path) => `  ${path}`),
    ].join("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Detector (ii) — no production consumer of components/reui/gantt or
// components/reui/event-calendar outside the harness (or the vendored tree itself)
// ---------------------------------------------------------------------------

/**
 * Vendor scheduling tree prefixes, and — per consumer prefix — WHICH of those vendor prefixes that
 * consumer may import. `harness/` and each vendored tree's own self-reference are allowed BOTH
 * (the harness is the sandbox for exercising every vendored primitive; a file inside one vendored
 * tree importing a sibling inside the SAME tree is how that tree is built at all). A real
 * production consumer like `components/ProductionGantt.tsx` (#220) is scoped to ONLY the one tree
 * it was actually given — plain string-prefix matching on `file.path` (as a bare allow-list, with
 * no per-vendor scoping) would have licensed it to import `event-calendar/` too, simply by being on
 * the list at all; the mapping below is what stops that. #220 (Gantt consumer) and #222
 * (event-calendar consumer) each relax this deliberately, one prefix at a time — when that happens,
 * add the new consumer's path here, scoped to the ONE vendor prefix it actually needs, with a
 * comment naming the issue. Never widen `VENDOR_SCHEDULING_PREFIXES` itself, and never grant a real
 * consumer `ALL_VENDOR_SCHEDULING_PREFIXES` unless it genuinely imports from both trees.
 */
const VENDOR_SCHEDULING_PREFIXES = ["components/reui/gantt/", "components/reui/event-calendar/"];
const ALL_VENDOR_SCHEDULING_PREFIXES: readonly string[] = VENDOR_SCHEDULING_PREFIXES;

/**
 * `kind` is explicit, not inferred from the shape of `matchValue` (fix-220-sol1 #5): the comment
 * beside the `components/ProductionGantt.tsx` entry below has always PROMISED an exact-file
 * exemption, but until this fix every entry — exact or directory — was matched the same way,
 * `file.path.startsWith(consumer.matchValue)`. `startsWith` treats an exact file path as just
 * another prefix, so `components/ProductionGantt.tsx-helper.ts` (a real, if unlikely, sibling file
 * name) would ALSO have matched `"components/ProductionGantt.tsx"` and silently inherited its
 * `gantt/`-only grant — exactly the near-collision the comment claimed could not happen. `kind`
 * forces each entry to say which matching rule it actually gets, and `consumerMatches` below
 * enforces it: `"exact"` is `===`, `"prefix"` is `startsWith`, never blurred.
 */
type AllowedVendorSchedulingConsumer =
  | { kind: "prefix"; matchValue: string; allowedVendorPrefixes: readonly string[] }
  | { kind: "exact"; matchValue: string; allowedVendorPrefixes: readonly string[] };

function consumerMatches(consumer: AllowedVendorSchedulingConsumer, path: string): boolean {
  return consumer.kind === "exact" ? path === consumer.matchValue : path.startsWith(consumer.matchValue);
}

const ALLOWED_VENDOR_SCHEDULING_CONSUMERS: readonly AllowedVendorSchedulingConsumer[] = [
  { kind: "prefix", matchValue: "harness/", allowedVendorPrefixes: ALL_VENDOR_SCHEDULING_PREFIXES },
  { kind: "prefix", matchValue: "components/reui/gantt/", allowedVendorPrefixes: ALL_VENDOR_SCHEDULING_PREFIXES },
  { kind: "prefix", matchValue: "components/reui/event-calendar/", allowedVendorPrefixes: ALL_VENDOR_SCHEDULING_PREFIXES },
  // #220 — the production Gantt surface. An EXACT file path, not a directory prefix (`kind:
  // "exact"`, matched with `===`, never `startsWith` — fix-220-sol1 #5): this gates BOTH vendored
  // trees (see `VENDOR_SCHEDULING_PREFIXES` above), so a directory-style prefix match here would
  // silently license every future file whose PATH happens to start with this exact string —
  // including a near-collision like `components/ProductionGantt.tsx-helper.ts` — to import
  // `event-calendar/` too, not just this one Gantt consumer. Scoped to
  // `["components/reui/gantt/"]` alone, not `ALL_VENDOR_SCHEDULING_PREFIXES` — this file has no
  // legitimate reason to import `event-calendar/`, and a bare (unscoped) allow-list entry would
  // have missed exactly that: this guard's own "Done when" proof plants
  // `import "@/components/reui/event-calendar/…"` inside this file and requires it STILL fails.
  // `screens/Dashboard.tsx` itself is NOT on this list — it reaches this file only through a
  // literal `lazy(() => import("../components/ProductionGantt"))`, never a direct import of
  // `components/reui/gantt/`, so it stays outside detector (ii) entirely, same as it always has.
  { kind: "exact", matchValue: "components/ProductionGantt.tsx", allowedVendorPrefixes: ["components/reui/gantt/"] },
];

function findVendorSchedulingImportersOutsideAllowed(files: FileNode[]): string[] {
  return files
    .filter((file) => !file.isTest)
    .filter((file) => {
      const allowedVendorPrefixes = ALLOWED_VENDOR_SCHEDULING_CONSUMERS.find((consumer) => consumerMatches(consumer, file.path))?.allowedVendorPrefixes ?? [];
      return file.importTargets.some((target) => VENDOR_SCHEDULING_PREFIXES.some((vendorPrefix) => target.startsWith(vendorPrefix) && !allowedVendorPrefixes.includes(vendorPrefix)));
    })
    .map((file) => file.path)
    .sort();
}

describe("guard: no production consumer of components/reui/gantt or components/reui/event-calendar", () => {
  it("self-test: fires on a planted importer outside the harness and the vendored trees", () => {
    const planted: FileNode[] = [
      { path: "screens/Dashboard.tsx", isTest: false, importTargets: ["components/reui/gantt/gantt.tsx"], nonLiteralDynamicImportCount: 0 },
      { path: "harness/reui-scheduling/main.tsx", isTest: false, importTargets: ["components/reui/gantt/gantt.tsx"], nonLiteralDynamicImportCount: 0 },
      { path: "components/reui/gantt/gantt-header.tsx", isTest: false, importTargets: ["components/reui/gantt/gantt.tsx"], nonLiteralDynamicImportCount: 0 },
      { path: "screens/EventCalendarScreen.tsx", isTest: false, importTargets: ["components/reui/event-calendar/calendar.tsx"], nonLiteralDynamicImportCount: 0 },
    ];
    expect(findVendorSchedulingImportersOutsideAllowed(planted)).toEqual([
      "screens/Dashboard.tsx",
      "screens/EventCalendarScreen.tsx",
    ]);
  });

  it("self-test: fires on an import.meta.glob whose pattern could reach components/reui/gantt/", () => {
    const planted: FileNode[] = [
      { path: "screens/Dashboard.tsx", isTest: false, importTargets: ["components/reui/gantt/"], nonLiteralDynamicImportCount: 0 },
    ];
    expect(findVendorSchedulingImportersOutsideAllowed(planted)).toEqual(["screens/Dashboard.tsx"]);
  });

  it("allows components/ProductionGantt.tsx to import components/reui/gantt/, but STILL fires if it imports components/reui/event-calendar/ too (per-vendor-prefix scoping, not a bare path allow-list)", () => {
    const gantOnly: FileNode[] = [
      { path: "components/ProductionGantt.tsx", isTest: false, importTargets: ["components/reui/gantt/gantt.tsx"], nonLiteralDynamicImportCount: 0 },
    ];
    expect(findVendorSchedulingImportersOutsideAllowed(gantOnly)).toEqual([]);

    // The build spec's own "Done when" proof, exercised directly rather than only by hand-editing
    // the real file: a same file that ALSO reaches into the other vendored tree is still an
    // offender, even though its path is on ALLOWED_VENDOR_SCHEDULING_CONSUMERS — being allowed to
    // import ONE vendored tree must never silently license the other.
    const gantAndEventCalendar: FileNode[] = [
      { path: "components/ProductionGantt.tsx", isTest: false, importTargets: ["components/reui/gantt/gantt.tsx", "components/reui/event-calendar/event-calendar.tsx"], nonLiteralDynamicImportCount: 0 },
    ];
    expect(findVendorSchedulingImportersOutsideAllowed(gantAndEventCalendar)).toEqual(["components/ProductionGantt.tsx"]);
  });

  // fix-220-sol1 #5: the `components/ProductionGantt.tsx` allow-list entry promises an EXACT-file
  // exemption, not a directory prefix — before this fix it was matched with the same
  // `startsWith` rule as every directory entry, so a near-collision file whose path merely STARTS
  // WITH that exact string also matched and silently inherited its `gantt/`-only grant. A
  // plausible real name for such a file: a co-located helper module Vite/TypeScript would resolve
  // as its own file, not the component itself.
  it("a near-collision file whose path merely starts with the exact-file entry's string is NOT granted its allowance (fix-220-sol1 #5)", () => {
    const nearCollision: FileNode[] = [
      { path: "components/ProductionGantt.tsx-helper.ts", isTest: false, importTargets: ["components/reui/gantt/gantt.tsx"], nonLiteralDynamicImportCount: 0 },
    ];
    expect(findVendorSchedulingImportersOutsideAllowed(nearCollision)).toEqual(["components/ProductionGantt.tsx-helper.ts"]);

    // The real exact-file entry still matches itself precisely, unaffected by the stricter check.
    const exactFileItself: FileNode[] = [
      { path: "components/ProductionGantt.tsx", isTest: false, importTargets: ["components/reui/gantt/gantt.tsx"], nonLiteralDynamicImportCount: 0 },
    ];
    expect(findVendorSchedulingImportersOutsideAllowed(exactFileItself)).toEqual([]);
  });

  // #220: renamed from "finds no real production consumer today" — that was #219 stage 1's own
  // description, and it is no longer true: components/ProductionGantt.tsx is a REAL production
  // consumer of components/reui/gantt/ now, on the ALLOW-list rather than absent. What this test
  // actually proves has not changed — every importer of either vendored tree, outside the trees
  // themselves and outside src/harness/, is named on ALLOWED_VENDOR_SCHEDULING_CONSUMERS — but the
  // old wording claimed a fact (no consumer exists) this pass makes false, and a guard that keeps
  // asserting a stale fact is how a guard starts lying.
  it("every real importer of the vendored scheduling trees is on the allow-list, none outside it", () => {
    const offenders = findVendorSchedulingImportersOutsideAllowed(scanAllSourceFiles());
    expect(offenders, [
      "A non-test source file outside src/harness/, outside the vendored tree itself, and outside",
      "ALLOWED_VENDOR_SCHEDULING_CONSUMERS imports from components/reui/gantt or",
      "components/reui/event-calendar. #220 gave the Gantt tree its first real production consumer",
      "(components/ProductionGantt.tsx, added to the allow-list with its own comment); #222 has not",
      "yet done the same for event-calendar. Add any new consumer to",
      "ALLOWED_VENDOR_SCHEDULING_CONSUMERS with an exact file path and a comment naming the issue —",
      "never widen the prefix match.",
      ...offenders.map((path) => `  ${path}`),
    ].join("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Detector (iii) — no NEW non-literal dynamic import() beyond the exact baseline
// ---------------------------------------------------------------------------

/**
 * Exact baseline of non-test production files with a non-literal `import()` call, as of this
 * guard landing. Empty today — the repo's only dynamic imports are literal
 * (`Dashboard.tsx`'s `lazy(() => import("../components/ProductionCalendar"))`,
 * `harness/reui-scheduling/main.tsx`'s `lazy(() => import("./GanttPreview"))`). A new non-literal
 * `import()` anywhere not already listed here fails closed, because it could be the harness.
 */
const NON_LITERAL_DYNAMIC_IMPORT_BASELINE: Record<string, number> = {};

function findNewNonLiteralDynamicImporters(files: FileNode[]): string[] {
  return files
    .filter((file) => !file.isTest)
    .filter((file) => file.nonLiteralDynamicImportCount > (NON_LITERAL_DYNAMIC_IMPORT_BASELINE[file.path] ?? 0))
    .map((file) => file.path)
    .sort();
}

describe("guard: no new non-literal dynamic import() beyond the exact baseline", () => {
  it("self-test: fires on a planted file above its baseline, not on one at or under it", () => {
    const planted: FileNode[] = [
      { path: "lib/loader.ts", isTest: false, importTargets: [], nonLiteralDynamicImportCount: 1 },
      { path: "lib/known.ts", isTest: false, importTargets: [], nonLiteralDynamicImportCount: 2 },
    ];
    const baselineOverride: Record<string, number> = { "lib/known.ts": 2 };
    const offenders = planted
      .filter((file) => !file.isTest)
      .filter((file) => file.nonLiteralDynamicImportCount > (baselineOverride[file.path] ?? 0))
      .map((file) => file.path);
    expect(offenders).toEqual(["lib/loader.ts"]);
  });

  it("finds no file above the real (empty) baseline", () => {
    const offenders = findNewNonLiteralDynamicImporters(scanAllSourceFiles());
    expect(offenders, [
      "A non-test source file has a non-literal import() argument beyond the exact baseline for",
      "that file. This fails closed because a non-literal dynamic import could resolve to the",
      "harness or a vendored scheduling tree at runtime, where static analysis cannot see it.",
      "If this is genuinely unrelated, add the file to NON_LITERAL_DYNAMIC_IMPORT_BASELINE with a",
      "comment, do not remove the check.",
      ...offenders.map((path) => `  ${path}`),
    ].join("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Detector (iv) — the build never reaches the harness
// ---------------------------------------------------------------------------

function getObjectProperty(node: AstNode | undefined, key: string): AstNode | undefined {
  if (!node || node.type !== "ObjectExpression") return undefined;
  for (const prop of (node.properties as AstNode[]) ?? []) {
    if (prop.type !== "ObjectProperty") continue;
    const propKey = prop.key as AstNode & { name?: string; value?: string };
    const keyName = propKey.type === "Identifier" ? propKey.name : propKey.type === "StringLiteral" ? propKey.value : undefined;
    if (keyName === key) return prop.value as AstNode;
  }
  return undefined;
}

/** Fully-literal string(s) an input node resolves to, or undefined if any part is non-literal. */
function literalInputStrings(node: AstNode): string[] | undefined {
  if (node.type === "StringLiteral") return [node.value as string];
  if (node.type === "ArrayExpression") {
    const out: string[] = [];
    for (const element of (node.elements as (AstNode | null)[]) ?? []) {
      if (!element || element.type !== "StringLiteral") return undefined;
      out.push(element.value as string);
    }
    return out;
  }
  if (node.type === "ObjectExpression") {
    const out: string[] = [];
    for (const prop of (node.properties as AstNode[]) ?? []) {
      if (prop.type !== "ObjectProperty") return undefined;
      const value = prop.value as AstNode;
      if (value.type !== "StringLiteral") return undefined;
      out.push(value.value as string);
    }
    return out;
  }
  return undefined;
}

function findExportedConfigObject(programBody: AstNode[]): AstNode | undefined {
  const exportDefault = programBody.find((node) => node.type === "ExportDefaultDeclaration");
  if (!exportDefault) return undefined;
  let declaration = exportDefault.declaration as AstNode;
  if (declaration.type === "CallExpression") {
    const args = declaration.arguments as AstNode[];
    declaration = args[0] as AstNode;
  }
  return declaration?.type === "ObjectExpression" ? declaration : undefined;
}

/**
 * True if any of `node`'s own (non-nested) properties is a spread (`{ ...cfg }`) rather than a
 * literal `key: value` pair. Round 2 fix (Sol BLOCKER): `getObjectProperty` above silently skips
 * non-`ObjectProperty` entries, including spreads, when looking for a named key — so
 * `defineConfig({ ...cfg })` used to read as "no build option present" even though `cfg` could
 * carry one at runtime. Every object level `analyzeBuildInputSafety` inspects (the config object
 * itself, `build`, `rollupOptions`) is checked with this before trusting an absent key.
 */
function objectExpressionHasSpread(node: AstNode): boolean {
  if (node.type !== "ObjectExpression") return false;
  return ((node.properties as AstNode[]) ?? []).some((prop) => prop.type !== "ObjectProperty");
}

interface BuildInputVerdict {
  safe: boolean;
  reason: string;
}

/**
 * Parses `viteConfigSource` and asserts `build.rollupOptions.input` is absent, or resolves (by
 * AST, not substring match) only to the literal string `"index.html"`. Any computed/non-literal
 * input, or an input that resolves to anything other than exactly `"index.html"`, is unsafe. Fails
 * closed (round 2 fix, Sol BLOCKER) if the config object, `build`, or `rollupOptions` object
 * contains a non-literal spread that could carry a `build`/`rollupOptions`/`input` key this
 * function cannot see statically.
 */
function analyzeBuildInputSafety(viteConfigSource: string): BuildInputVerdict {
  const parsed = parseSource(viteConfigSource, ".ts");
  if (!parsed.ok) return { safe: false, reason: `vite.config.ts failed to parse: ${parsed.error}` };
  const configObject = findExportedConfigObject(parsed.ast.program.body as AstNode[]);
  if (!configObject) return { safe: false, reason: "could not statically find the exported Vite config object" };
  if (objectExpressionHasSpread(configObject)) {
    return { safe: false, reason: "the exported Vite config object contains a non-literal spread that could carry a build option" };
  }
  const buildProp = getObjectProperty(configObject, "build");
  if (!buildProp) return { safe: true, reason: "no build option present" };
  if (buildProp.type !== "ObjectExpression") return { safe: false, reason: "build option is not a plain object literal" };
  if (objectExpressionHasSpread(buildProp)) {
    return { safe: false, reason: "the build option contains a non-literal spread that could carry rollupOptions" };
  }
  const rollupOptions = getObjectProperty(buildProp, "rollupOptions");
  if (!rollupOptions) return { safe: true, reason: "no rollupOptions present" };
  if (rollupOptions.type !== "ObjectExpression") return { safe: false, reason: "rollupOptions is not a plain object literal" };
  if (objectExpressionHasSpread(rollupOptions)) {
    return { safe: false, reason: "rollupOptions contains a non-literal spread that could carry input" };
  }
  const input = getObjectProperty(rollupOptions, "input");
  if (!input) return { safe: true, reason: "no input present" };
  const literals = literalInputStrings(input);
  if (!literals) return { safe: false, reason: "build.rollupOptions.input is not a literal string/array/object of literals" };
  if (literals.length === 1 && literals[0] === "index.html") return { safe: true, reason: "input resolves only to index.html" };
  return { safe: false, reason: `build.rollupOptions.input resolves to ${JSON.stringify(literals)}` };
}

describe("guard: vite.config.ts's build input is absent or resolves only to index.html", () => {
  it("self-test: unsafe on a planted harness entry, a computed input, and a multi-entry input", () => {
    const plantedHarness = `
      export default defineConfig({
        build: { rollupOptions: { input: { harness: "harness/reui-scheduling/index.html" } } },
      });
    `;
    expect(analyzeBuildInputSafety(plantedHarness).safe).toBe(false);

    const plantedComputed = `
      const entry = computeEntry();
      export default defineConfig({ build: { rollupOptions: { input: entry } } });
    `;
    expect(analyzeBuildInputSafety(plantedComputed).safe).toBe(false);

    const plantedMulti = `
      export default defineConfig({
        build: { rollupOptions: { input: ["index.html", "extra.html"] } },
      });
    `;
    expect(analyzeBuildInputSafety(plantedMulti).safe).toBe(false);
  });

  it("self-test: fails closed on a spread at every object level that could carry a build option (round 2, Sol BLOCKER)", () => {
    const spreadOnConfig = `
      export default defineConfig({ ...sharedConfig, plugins: [] });
    `;
    expect(analyzeBuildInputSafety(spreadOnConfig)).toMatchObject({ safe: false });

    const spreadOnBuild = `
      export default defineConfig({ build: { ...sharedBuild } });
    `;
    expect(analyzeBuildInputSafety(spreadOnBuild)).toMatchObject({ safe: false });

    const spreadOnRollupOptions = `
      export default defineConfig({ build: { rollupOptions: { ...sharedRollupOptions } } });
    `;
    expect(analyzeBuildInputSafety(spreadOnRollupOptions)).toMatchObject({ safe: false });
  });

  it("self-test: safe when build is absent, and when input is literally index.html only", () => {
    expect(analyzeBuildInputSafety(`export default defineConfig({ plugins: [] });`).safe).toBe(true);
    expect(
      analyzeBuildInputSafety(`
        export default defineConfig({ build: { rollupOptions: { input: "index.html" } } });
      `).safe,
    ).toBe(true);
    expect(
      analyzeBuildInputSafety(`
        export default defineConfig({ build: { rollupOptions: { input: ["index.html"] } } });
      `).safe,
    ).toBe(true);
  });

  it("is safe on the real vite.config.ts", () => {
    const source = readFileSync(join(webDir, "vite.config.ts"), "utf8");
    const verdict = analyzeBuildInputSafety(source);
    expect(verdict.safe, `vite.config.ts's build input is unsafe: ${verdict.reason}`).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Detector (iv), part 2 — vite.config.ts registers the forbid-dev-only-modules build plugin
// ---------------------------------------------------------------------------
//
// Round 2 replacement (Sol BLOCKER) for the old dist/-content detector: Sol's review found it
// "meaningless after minification, stale outside CI" — minification strips the extension-bearing
// module-id needles it looked for, and a `dist/` left over from an earlier build silently skips
// the check outside CI, where a fresh build always precedes this test. The real backstop is now
// `src/build/forbid-dev-only-modules.ts`, a Vite `apply: "build"` plugin that walks the ACTUAL
// Rollup/Rolldown module graph at the end of a production build and fails it if anything under a
// restricted prefix is reachable — see that file's own tests for its behaviour. This detector only
// proves the plugin is actually wired into `vite.config.ts`, as a direct, unconditional element of
// `plugins` (not behind a ternary, `&&`, `.filter(Boolean)`, or similar — that would leave a way to
// build with the plugin silently absent).

/**
 * True if `pluginsArray` (an `ArrayExpression` AST node, or `undefined`) has `calleeName(...)` as
 * one of its own direct elements — i.e. `plugins: [..., calleeName(), ...]`. A call wrapped in a
 * condition (`cond && calleeName()`, a ternary, a spread of a conditionally-built array) is a
 * different node type at that array position and is deliberately NOT matched — the guard should
 * fail if the plugin's presence in the build depends on anything other than a literal array slot.
 */
function pluginsArrayHasDirectCall(pluginsArray: AstNode | undefined, calleeName: string): boolean {
  if (!pluginsArray || pluginsArray.type !== "ArrayExpression") return false;
  return ((pluginsArray.elements as (AstNode | null)[]) ?? []).some((element) => {
    if (!element || element.type !== "CallExpression") return false;
    const callee = element.callee as AstNode & { name?: string };
    return callee.type === "Identifier" && callee.name === calleeName;
  });
}

/** Parses a fixture Vite config source and returns its `plugins` property AST node, if any. */
function parseConfigPluginsArray(source: string): AstNode | undefined {
  const parsed = parseSource(source, ".ts");
  if (!parsed.ok) throw new Error(`fixture failed to parse: ${parsed.error}`);
  const configObject = findExportedConfigObject(parsed.ast.program.body as AstNode[]);
  return getObjectProperty(configObject, "plugins");
}

describe("guard: vite.config.ts registers the forbid-dev-only-modules build plugin", () => {
  const FORBID_PLUGIN_CALLEE = "forbidDevOnlyModules";

  it("self-test: fires when the plugin call is absent, wrapped in a condition, or plugins itself is missing/non-literal", () => {
    const absent = `export default defineConfig({ plugins: [react()] });`;
    expect(pluginsArrayHasDirectCall(parseConfigPluginsArray(absent), FORBID_PLUGIN_CALLEE)).toBe(false);

    const behindLogicalAnd = `export default defineConfig({ plugins: [react(), isProd && forbidDevOnlyModules(root)] });`;
    expect(pluginsArrayHasDirectCall(parseConfigPluginsArray(behindLogicalAnd), FORBID_PLUGIN_CALLEE)).toBe(false);

    const noPluginsArray = `export default defineConfig({});`;
    expect(pluginsArrayHasDirectCall(parseConfigPluginsArray(noPluginsArray), FORBID_PLUGIN_CALLEE)).toBe(false);

    const pluginsIsNotAnArray = `export default defineConfig({ plugins: getPlugins() });`;
    expect(pluginsArrayHasDirectCall(parseConfigPluginsArray(pluginsIsNotAnArray), FORBID_PLUGIN_CALLEE)).toBe(false);
  });

  it("self-test: fires on a direct call to a different plugin, not the one being checked for", () => {
    const source = `export default defineConfig({ plugins: [react(), tailwindcss()] });`;
    expect(pluginsArrayHasDirectCall(parseConfigPluginsArray(source), FORBID_PLUGIN_CALLEE)).toBe(false);
  });

  it("self-test: recognises a direct, unconditional call in the plugins array", () => {
    const source = `export default defineConfig({ plugins: [react(), forbidDevOnlyModules(root)] });`;
    expect(pluginsArrayHasDirectCall(parseConfigPluginsArray(source), FORBID_PLUGIN_CALLEE)).toBe(true);
  });

  it("is registered as a direct, unconditional element of plugins in the real vite.config.ts", () => {
    const source = readFileSync(join(webDir, "vite.config.ts"), "utf8");
    const parsed = parseSource(source, ".ts");
    if (!parsed.ok) throw new Error(`vite.config.ts failed to parse: ${parsed.error}`);
    const configObject = findExportedConfigObject(parsed.ast.program.body as AstNode[]);
    expect(configObject, "could not statically find the exported Vite config object").toBeDefined();
    const pluginsArray = getObjectProperty(configObject, "plugins");
    expect(
      pluginsArrayHasDirectCall(pluginsArray, FORBID_PLUGIN_CALLEE),
      "vite.config.ts's plugins array does not register forbidDevOnlyModules(...) as a direct, unconditional element",
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Detector (iv), part 3 — vite.config.ts ALSO registers forbid-dev-only-modules through
// worker.plugins, as a fresh instance per call (round 3, Sol BLOCKER 1a)
// ---------------------------------------------------------------------------
//
// Vite 8's worker sub-builds (`new Worker(new URL("./x.ts", import.meta.url))`) run an entirely
// separate Rolldown bundling pass with its OWN plugin pipeline — the top-level `plugins` array
// above is never consulted for it. A restricted module reachable ONLY through a worker entry
// therefore evaded `forbidDevOnlyModules` even after round 2's fix. Vite's own `worker.plugins`
// type is `() => PluginOption[]`, required to return a FRESH instance every call (one per worker
// bundle) — see `vite.config.ts`'s own comment beside the real registration.

/**
 * The `ArrayExpression` a `worker.plugins` factory function's body evaluates to — a concise-body
 * arrow (`() => [x()]`) or a block body whose single `return` statement returns an array literal.
 * Anything else (a non-function, a non-array return, more than one return statement) is NOT
 * resolved — fails closed the same way the rest of this file's static analysis does.
 */
function extractArrayFromPluginsFactory(node: AstNode | undefined): AstNode | undefined {
  if (!node) return undefined;
  if (node.type !== "ArrowFunctionExpression" && node.type !== "FunctionExpression") return undefined;
  const body = node.body as AstNode;
  if (body.type === "ArrayExpression") return body;
  if (body.type !== "BlockStatement") return undefined;
  const returns = ((body.body as AstNode[]) ?? []).filter((statement) => statement.type === "ReturnStatement");
  if (returns.length !== 1) return undefined;
  const argument = returns[0]!.argument as AstNode | null | undefined;
  return argument?.type === "ArrayExpression" ? argument : undefined;
}

/**
 * True if `configObject`'s `worker.plugins` is a function (concise-arrow or block-bodied, per
 * `extractArrayFromPluginsFactory`) whose returned array has `calleeName(...)` as one of its own
 * direct elements — mirrors `pluginsArrayHasDirectCall`'s own "direct array slot only" rule, and
 * fails closed on a spread anywhere in `worker`/on a `worker.plugins` that is not a function at
 * all (a shared array reused across worker bundles, which Vite's own contract forbids).
 */
function workerPluginsArrayHasDirectCall(configObject: AstNode | undefined, calleeName: string): boolean {
  const workerProp = getObjectProperty(configObject, "worker");
  if (!workerProp || workerProp.type !== "ObjectExpression") return false;
  if (objectExpressionHasSpread(workerProp)) return false;
  const pluginsFactory = getObjectProperty(workerProp, "plugins");
  const pluginsArray = extractArrayFromPluginsFactory(pluginsFactory);
  return pluginsArrayHasDirectCall(pluginsArray, calleeName);
}

describe("guard: vite.config.ts ALSO registers forbid-dev-only-modules via worker.plugins (round 3, Sol BLOCKER 1a)", () => {
  const FORBID_PLUGIN_CALLEE = "forbidDevOnlyModules";

  function parseConfigObject(source: string): AstNode | undefined {
    const parsed = parseSource(source, ".ts");
    if (!parsed.ok) throw new Error(`fixture failed to parse: ${parsed.error}`);
    return findExportedConfigObject(parsed.ast.program.body as AstNode[]);
  }

  it("self-test: fires when worker, worker.plugins, or the direct call itself is absent", () => {
    const noWorker = `export default defineConfig({ plugins: [react()] });`;
    expect(workerPluginsArrayHasDirectCall(parseConfigObject(noWorker), FORBID_PLUGIN_CALLEE)).toBe(false);

    const noPluginsKey = `export default defineConfig({ worker: { format: "es" } });`;
    expect(workerPluginsArrayHasDirectCall(parseConfigObject(noPluginsKey), FORBID_PLUGIN_CALLEE)).toBe(false);

    const wrongCallee = `export default defineConfig({ worker: { plugins: () => [tailwindcss()] } });`;
    expect(workerPluginsArrayHasDirectCall(parseConfigObject(wrongCallee), FORBID_PLUGIN_CALLEE)).toBe(false);
  });

  it("self-test: fires closed on a non-function plugins value, a shared/reused array, and a spread on worker", () => {
    const notAFunction = `export default defineConfig({ worker: { plugins: [forbidDevOnlyModules(root)] } });`;
    expect(workerPluginsArrayHasDirectCall(parseConfigObject(notAFunction), FORBID_PLUGIN_CALLEE)).toBe(false);

    // A factory returning a variable (not a fresh literal array) cannot be proven, statically, to
    // return a NEW instance every call - Vite's own contract requires exactly that, so this fails
    // closed rather than trusting it.
    const returnsVariable = `
      const shared = [forbidDevOnlyModules(root)];
      export default defineConfig({ worker: { plugins: () => shared } });
    `;
    expect(workerPluginsArrayHasDirectCall(parseConfigObject(returnsVariable), FORBID_PLUGIN_CALLEE)).toBe(false);

    const spreadOnWorker = `export default defineConfig({ worker: { ...sharedWorker, plugins: () => [forbidDevOnlyModules(root)] } });`;
    expect(workerPluginsArrayHasDirectCall(parseConfigObject(spreadOnWorker), FORBID_PLUGIN_CALLEE)).toBe(false);
  });

  it("self-test: recognises a concise-arrow factory returning a fresh array with a direct call", () => {
    const source = `export default defineConfig({ worker: { plugins: () => [forbidDevOnlyModules(root)] } });`;
    expect(workerPluginsArrayHasDirectCall(parseConfigObject(source), FORBID_PLUGIN_CALLEE)).toBe(true);
  });

  it("self-test: recognises a block-bodied factory whose single return statement returns a fresh array", () => {
    const source = `
      export default defineConfig({
        worker: {
          plugins: () => {
            return [forbidDevOnlyModules(root)];
          },
        },
      });
    `;
    expect(workerPluginsArrayHasDirectCall(parseConfigObject(source), FORBID_PLUGIN_CALLEE)).toBe(true);
  });

  it("is registered via worker.plugins as a fresh-instance factory in the real vite.config.ts", () => {
    const source = readFileSync(join(webDir, "vite.config.ts"), "utf8");
    const configObject = parseConfigObject(source);
    expect(configObject, "could not statically find the exported Vite config object").toBeDefined();
    expect(
      workerPluginsArrayHasDirectCall(configObject, FORBID_PLUGIN_CALLEE),
      "vite.config.ts's worker.plugins does not register a fresh forbidDevOnlyModules(...) instance - a worker sub-build can still reach a restricted module undetected",
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Whole-scanner planted fixtures — one per extraction form, run through
// parse -> extract -> resolve -> verdict (detector ii), not pre-resolved FileNodes.
// ---------------------------------------------------------------------------

describe("whole-scanner fixtures: every extraction form is caught end to end", () => {
  const plantedFromFile = join(srcDir, "screens", "__planted_reachability_fixture__.tsx");

  function scanText(text: string, ext = ".tsx"): FileNode {
    const extraction = extractSpecifiers(text, ext);
    if ("parseError" in extraction) throw new Error(`fixture failed to parse: ${extraction.parseError}`);
    const importTargets = new Set<string>();
    for (const specifier of extraction.literalSpecifiers) {
      const target = resolveSpecifier(plantedFromFile, specifier);
      if (target) importTargets.add(rel(target));
    }
    for (const restricted of globReachableRestrictedDirs(plantedFromFile, extraction.globPatterns)) {
      importTargets.add(restricted);
    }
    return {
      path: "screens/__planted_reachability_fixture__.tsx",
      isTest: false,
      importTargets: [...importTargets],
      nonLiteralDynamicImportCount: extraction.nonLiteralDynamicImportCount,
    };
  }

  const catchesVendorGantt = (text: string, ext = ".tsx") =>
    findVendorSchedulingImportersOutsideAllowed([scanText(text, ext)]);
  const catchesHarness = (text: string, ext = ".tsx") => findHarnessImportersOutsideHarness([scanText(text, ext)]);

  it("static import", () => {
    expect(catchesVendorGantt(`import { Gantt } from "@/components/reui/gantt/gantt";`)).toEqual([
      "screens/__planted_reachability_fixture__.tsx",
    ]);
  });

  it("export-from", () => {
    expect(catchesVendorGantt(`export { Gantt } from "@/components/reui/gantt/gantt";`)).toEqual([
      "screens/__planted_reachability_fixture__.tsx",
    ]);
  });

  it("export * from", () => {
    expect(catchesVendorGantt(`export * from "@/components/reui/gantt/gantt";`)).toEqual([
      "screens/__planted_reachability_fixture__.tsx",
    ]);
  });

  it("relative static import", () => {
    expect(catchesVendorGantt(`import { Gantt } from "../components/reui/gantt/gantt";`)).toEqual([
      "screens/__planted_reachability_fixture__.tsx",
    ]);
  });

  // #220 S8 decision record: `extractSpecifiers` deliberately does NOT read Babel's `importKind`
  // (whole-declaration `import type { X } from "..."`, or a per-specifier `import { type X } from
  // "..."`) — a type-only import is caught exactly the same as a value import, both here and for
  // `src/harness/` itself below. This is a documented choice, not an oversight left over from pass
  // A (`lib/production-gantt-adapter.ts`'s own header records the same finding from the OTHER
  // side): the guard stays intentionally conservative rather than growing importKind-aware parsing,
  // because (1) a type-only import carries no production-bundle weight at all — under this
  // project's `isolatedModules: true` (`tsconfig.base.json`), an `import type` is always elided by
  // the transpiler, so it can never become a module-graph edge for `forbid-dev-only-modules.ts`'s
  // REAL, build-time backstop to catch even if this static guard somehow missed it; (2) the cost of
  // getting importKind-aware parsing genuinely right is real — whole-declaration `import type`,
  // per-specifier `import { type X, Y }` (where `Y` is still a value import and must still be
  // caught), and `export type { X } from "..."` all need distinct handling and their own self-tests
  // (`docs/lessons.md`'s "a grep gate that cannot fail is not a gate") — for a benefit that is
  // purely cosmetic: letting a file import the vendored trees' TYPES without becoming a "vendor
  // consumer" on `ALLOWED_VENDOR_SCHEDULING_CONSUMERS`. Given that, over-inclusive (flagging a
  // type-only import as if it were a value one) is the safe failure direction, and this test locks
  // that behaviour in on purpose so a future Babel/parser change cannot silently narrow it.
  //
  // Consequence for `lib/production-gantt-adapter.ts`: its `ProductionGanttResource`/
  // `ProductionGanttEvent<TData>` stay LOCAL structural types, not replaced by
  // `import type { GanttResource, GanttEvent } from "@/components/reui/gantt/gantt-types"`, even
  // though that file is now on `ALLOWED_VENDOR_SCHEDULING_CONSUMERS`'s adjacent
  // `components/ProductionGantt.tsx` entry for VALUE imports. `production-gantt-adapter.ts` is not
  // itself on that list, and this test proves a type-only import from it would still be caught
  // exactly like a value one, so adding it there would need its own `#220` comment and its own
  // justification — deliberately left undone this pass, since the local types already work, are
  // unit-tested, and their own header records precisely where a future vendor-type change would
  // surface as a type error.
  it("import type { X } from vendored gantt is STILL caught, identically to a value import (S8 decision: importKind stays unread, on purpose)", () => {
    expect(catchesVendorGantt(`import type { GanttResource } from "@/components/reui/gantt/gantt-types";`)).toEqual([
      "screens/__planted_reachability_fixture__.tsx",
    ]);
  });

  it("a per-specifier `import { type X, Y }` from vendored gantt is STILL caught (same S8 decision — the mixed form is not special-cased either)", () => {
    expect(catchesVendorGantt(`import { type GanttResource, Gantt } from "@/components/reui/gantt/gantt-types";`)).toEqual([
      "screens/__planted_reachability_fixture__.tsx",
    ]);
  });

  it("dynamic import() with a string literal", () => {
    expect(catchesVendorGantt(`const load = () => import("@/components/reui/gantt/gantt");`)).toEqual([
      "screens/__planted_reachability_fixture__.tsx",
    ]);
  });

  it("dynamic import() with a no-substitution template literal", () => {
    expect(catchesVendorGantt("const load = () => import(`@/components/reui/gantt/gantt`);")).toEqual([
      "screens/__planted_reachability_fixture__.tsx",
    ]);
  });

  it("import.meta.glob with a string literal pattern", () => {
    expect(catchesVendorGantt(`const modules = import.meta.glob("@/components/reui/gantt/*.tsx");`)).toEqual([
      "screens/__planted_reachability_fixture__.tsx",
    ]);
  });

  it("import.meta.glob with an array of string literal patterns", () => {
    expect(
      catchesVendorGantt(`const modules = import.meta.glob(["@/components/reui/gantt/*.tsx", "@/lib/foo.ts"]);`),
    ).toEqual(["screens/__planted_reachability_fixture__.tsx"]);
  });

  it("import.meta.globEager with a string literal pattern", () => {
    expect(catchesVendorGantt(`const modules = import.meta.globEager("@/components/reui/gantt/*.tsx");`)).toEqual([
      "screens/__planted_reachability_fixture__.tsx",
    ]);
  });

  it("import.meta.glob rooted ABOVE the restricted dir still reaches it", () => {
    expect(catchesVendorGantt(`const modules = import.meta.glob("@/components/reui/**/*.tsx");`)).toEqual([
      "screens/__planted_reachability_fixture__.tsx",
    ]);
  });

  it("require()", () => {
    expect(catchesVendorGantt(`const Gantt = require("@/components/reui/gantt/gantt");`)).toEqual([
      "screens/__planted_reachability_fixture__.tsx",
    ]);
  });

  it("project-root-absolute /src/... specifier (round 2, Sol BLOCKER)", () => {
    expect(catchesVendorGantt(`import { Gantt } from "/src/components/reui/gantt/gantt";`)).toEqual([
      "screens/__planted_reachability_fixture__.tsx",
    ]);
  });

  it("a ?raw-suffixed specifier still resolves after stripping the query (round 2, Sol BLOCKER)", () => {
    expect(catchesVendorGantt(`import raw from "@/components/reui/gantt/gantt.tsx?raw";`)).toEqual([
      "screens/__planted_reachability_fixture__.tsx",
    ]);
  });

  it("a ?worker-suffixed specifier with no explicit extension still resolves (round 2, Sol BLOCKER)", () => {
    expect(catchesVendorGantt(`import worker from "@/components/reui/gantt/gantt?worker";`)).toEqual([
      "screens/__planted_reachability_fixture__.tsx",
    ]);
  });

  it("new URL(\"...\", import.meta.url) reaching the harness (round 2, Sol BLOCKER)", () => {
    expect(catchesHarness(`const url = new URL("../harness/reui-scheduling/fixtures.ts", import.meta.url);`)).toEqual([
      "screens/__planted_reachability_fixture__.tsx",
    ]);
  });

  it("new Worker(new URL(\"...\", import.meta.url)) reaching the vendored gantt tree (round 2, Sol BLOCKER)", () => {
    expect(
      catchesVendorGantt(`const w = new Worker(new URL("../components/reui/gantt/gantt.tsx", import.meta.url));`),
    ).toEqual(["screens/__planted_reachability_fixture__.tsx"]);
  });

  it("new URL(...) with a non-import.meta.url second argument is NOT treated as a module specifier", () => {
    expect(
      catchesHarness(`const url = new URL("../harness/reui-scheduling/fixtures.ts", "https://example.com");`),
    ).toEqual([]);
  });

  it("static import of the harness (detector i)", () => {
    expect(catchesHarness(`import Preview from "@/harness/reui-scheduling/GanttPreview";`)).toEqual([
      "screens/__planted_reachability_fixture__.tsx",
    ]);
  });

  it("non-literal dynamic import() beyond baseline (detector iii)", () => {
    const scanned = scanText(`const load = (which: string) => import(which);`, ".ts");
    expect(findNewNonLiteralDynamicImporters([scanned])).toEqual(["screens/__planted_reachability_fixture__.tsx"]);
  });

  it("a benign fixture (unrelated import) is not caught by any detector", () => {
    const scanned = scanText(`import { useState } from "react";`);
    expect(catchesVendorGantt(`import { useState } from "react";`)).toEqual([]);
    expect(findHarnessImportersOutsideHarness([scanned])).toEqual([]);
    expect(findNewNonLiteralDynamicImporters([scanned])).toEqual([]);
  });

  it("a file that fails to parse fails closed, not silently skipped", () => {
    const broken = extractSpecifiers("const x = ;;; this is not valid TS(((", ".ts");
    expect("parseError" in broken).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guard (round 3, Sol BLOCKER 1b) — the restricted trees may contain only scanned source
// ---------------------------------------------------------------------------
//
// Sol's round 3 report: an asset URL (`new URL("./x.png", import.meta.url)`) or a CSS-referenced
// asset (`url(...)` inside a stylesheet) can be emitted by a production build, or inlined, with NO
// module id shape this file's import-form scan OR `forbid-dev-only-modules.ts`'s module-graph scan
// is guaranteed to see (an emitted asset is a Rollup/Rolldown ASSET, not necessarily a MODULE id).
// Orchestrator decision (this fix): do not build an asset-origin scanner to close that gap — make
// the hole impossible instead. `src/harness/`, `src/components/reui/gantt/` and
// `src/components/reui/event-calendar/` may contain ONLY a
// Vite source file (`isViteSourceFile`, the same extension set the rest of this file scans), or a
// literal `.html`/`.md` directly inside `harness/reui-scheduling/` itself (the dev-only Vite HTML
// entry dir — `apps/web/harness/reui-scheduling/`, NOT under `src/`, which is where `index.html`
// and any future landing-page README have to live). Any other file (`.css`, `.svg`, `.png`,
// `.json`, `.wasm`, …) anywhere in any restricted tree fails this guard outright: extend
// `forbid-dev-only-modules.ts` (or move the asset elsewhere) rather than let one land silently.

/** The dev-only Vite HTML entry dir itself — `apps/web/harness/reui-scheduling/`, sibling to
 * `src/`, not inside it. Only place under any restricted tree a non-source file may exist. */
const HARNESS_ENTRY_DIR = join(webDir, "harness", "reui-scheduling");

const RESTRICTED_ASSET_SCAN_DIRS = [
  { label: "src/harness/", abs: join(srcDir, "harness") },
  // #220: kept here even though the ORIGINAL asset-hole rationale above (an emitted asset with no
  // module-id shape `forbid-dev-only-modules.ts` is guaranteed to see) has partly lapsed for this
  // one tree — `components/reui/gantt/` now has a real production consumer
  // (`components/ProductionGantt.tsx`), so a stray `.css`/`.svg`/etc. dropped in here could now
  // actually reach a production bundle through it, which is a STRONGER reason to keep scanning,
  // not a weaker one. This entry's job was never only "this tree is unreachable so an asset in it
  // is inert" — it is also "this tree stays pure vendored source, nothing else", a purity
  // `gantt-skin.guard.test.ts`'s own nine-file scan assumes without re-checking it itself.
  { label: "src/components/reui/gantt/", abs: join(srcDir, "components", "reui", "gantt") },
  // #219 PR B: the vendored event-calendar tree, on the same terms as the Gantt above. PR A
  // pre-wired this path into RESTRICTED_GLOB_DIRS and VENDOR_SCHEDULING_PREFIXES but not here,
  // so until PR B the calendar tree could have taken a `.css` or `.png` without this guard
  // noticing — the one of the three lists that is about EMITTED ASSETS rather than imports.
  {
    label: "src/components/reui/event-calendar/",
    abs: join(srcDir, "components", "reui", "event-calendar"),
  },
];

/**
 * Whether `file` (an absolute path) is allowed to exist under a restricted-tree asset scan: any
 * Vite source extension, anywhere in the tree, or a literal `.html`/`.md` sitting DIRECTLY inside
 * `HARNESS_ENTRY_DIR` (not a subdirectory of it — `dirname(file) === HARNESS_ENTRY_DIR`, an exact
 * match, not a prefix check).
 */
function isAllowedRestrictedTreeFile(file: string): boolean {
  if (isViteSourceFile(file)) return true;
  const ext = extname(file);
  return dirname(file) === HARNESS_ENTRY_DIR && (ext === ".html" || ext === ".md");
}

function walkAllFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkAllFiles(full));
    else out.push(full);
  }
  return out;
}

function findNonSourceRestrictedTreeAssets(dirs: { abs: string }[]): string[] {
  const offenders: string[] = [];
  for (const { abs } of dirs) {
    for (const file of walkAllFiles(abs)) {
      if (!isAllowedRestrictedTreeFile(file)) offenders.push(relative(webDir, file).split(sep).join("/"));
    }
  }
  return offenders.sort();
}

describe("guard: src/harness/ and src/components/reui/gantt/ may contain only scanned source (round 3, Sol BLOCKER 1b)", () => {
  it("self-test: allows every Vite source extension and the harness entry's own .html/.md, rejects everything else", () => {
    expect(isAllowedRestrictedTreeFile(join(srcDir, "harness", "reui-scheduling", "main.tsx"))).toBe(true);
    expect(isAllowedRestrictedTreeFile(join(srcDir, "components", "reui", "gantt", "gantt.tsx"))).toBe(true);
    expect(isAllowedRestrictedTreeFile(join(HARNESS_ENTRY_DIR, "index.html"))).toBe(true);
    expect(isAllowedRestrictedTreeFile(join(HARNESS_ENTRY_DIR, "README.md"))).toBe(true);

    expect(isAllowedRestrictedTreeFile(join(srcDir, "harness", "reui-scheduling", "fixture.svg"))).toBe(false);
    expect(isAllowedRestrictedTreeFile(join(srcDir, "components", "reui", "gantt", "icon.png"))).toBe(false);
    expect(isAllowedRestrictedTreeFile(join(srcDir, "harness", "styles.css"))).toBe(false);
    expect(isAllowedRestrictedTreeFile(join(srcDir, "components", "reui", "gantt", "data.json"))).toBe(false);
    expect(isAllowedRestrictedTreeFile(join(srcDir, "harness", "module.wasm"))).toBe(false);
    // .html/.md is allowed ONLY directly inside the harness entry dir, not one level up and not a
    // subdirectory of it - a prefix check here would let an asset hide one folder deeper.
    expect(isAllowedRestrictedTreeFile(join(srcDir, "harness", "index.html"))).toBe(false);
    expect(isAllowedRestrictedTreeFile(join(HARNESS_ENTRY_DIR, "nested", "index.html"))).toBe(false);
  });

  it("finds no non-source asset in the real restricted trees today", () => {
    const offenders = findNonSourceRestrictedTreeAssets(RESTRICTED_ASSET_SCAN_DIRS);
    expect(offenders, [
      "A non-source file survives under a restricted dev-only/vendored tree. Dev-only/vendored",
      "dirs may contain only scanned source; put assets elsewhere, or extend",
      "forbid-dev-only-modules.ts if the asset genuinely has to live here. Found:",
      ...offenders.map((path) => `  ${path}`),
    ].join("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sanity — the scan itself is pointed at real files, including the harness this guard exists for
// ---------------------------------------------------------------------------

describe("the file scan itself", () => {
  it("walks every Vite-supported source extension", () => {
    expect(isViteSourceFile("a.ts")).toBe(true);
    expect(isViteSourceFile("a.tsx")).toBe(true);
    expect(isViteSourceFile("a.js")).toBe(true);
    expect(isViteSourceFile("a.jsx")).toBe(true);
    expect(isViteSourceFile("a.mts")).toBe(true);
    expect(isViteSourceFile("a.cts")).toBe(true);
    expect(isViteSourceFile("a.mjs")).toBe(true);
    expect(isViteSourceFile("a.cjs")).toBe(true);
    expect(isViteSourceFile("a.css")).toBe(false);
    expect(isViteSourceFile("a.json")).toBe(false);
  });

  it("plugin selection: jsx enabled except for .ts/.mts/.cts, typescript enabled for TS extensions only", () => {
    expect(pluginsForExtension(".tsx")).toEqual(["importMeta", "typescript", "jsx"]);
    expect(pluginsForExtension(".jsx")).toEqual(["importMeta", "jsx"]);
    expect(pluginsForExtension(".js")).toEqual(["importMeta", "jsx"]);
    expect(pluginsForExtension(".mjs")).toEqual(["importMeta", "jsx"]);
    expect(pluginsForExtension(".cjs")).toEqual(["importMeta", "jsx"]);
    expect(pluginsForExtension(".ts")).toEqual(["importMeta", "typescript"]);
    expect(pluginsForExtension(".mts")).toEqual(["importMeta", "typescript"]);
    expect(pluginsForExtension(".cts")).toEqual(["importMeta", "typescript"]);
  });

  it("reads real application source, and sees the harness entry it is guarding", () => {
    const files = walkSourceFiles(srcDir).map(rel);
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("harness/reui-scheduling/main.tsx");
    expect(existsSync(join(webDir, "harness", "reui-scheduling", "index.html"))).toBe(true);
  });

  it("no real source file fails to parse (fail closed, not silently skipped)", () => {
    const failures = scanAllSourceFiles()
      .filter((file) => file.parseError !== undefined)
      .map((file) => `${file.path}: ${file.parseError}`);
    expect(failures, ["The following files failed to parse and would be silently skipped:", ...failures].join("\n")).toEqual(
      [],
    );
  });

  it("import resolution sees a real aliased and a real relative edge", () => {
    // main.tsx imports the global stylesheet via a side-effect `@/`-alias import. Not a Vite
    // source file, so it resolves to nothing — proving the resolver does not silently claim a
    // false positive for every specifier it sees. Directory-index-resolution and dynamic-import
    // paths are exercised directly below.
    const text = readFileSync(join(harnessDir, "reui-scheduling", "main.tsx"), "utf8");
    const extraction = extractSpecifiers(text, ".tsx");
    if ("parseError" in extraction) throw new Error(extraction.parseError);
    expect(extraction.literalSpecifiers).toContain("@/styles/index.css");
    expect(resolveSpecifier(join(harnessDir, "reui-scheduling", "main.tsx"), "@/styles/index.css")).toBeUndefined();
  });

  it("resolves an aliased directory import to its index file, and sees dynamic import()", () => {
    expect(resolveSpecifier(join(srcDir, "probe.ts"), "@/components/reui/button")).toBe(
      join(srcDir, "components", "reui", "button.tsx"),
    );
    const extraction = extractSpecifiers(`const C = lazy(() => import("@/components/reui/gantt/gantt"));`, ".tsx");
    if ("parseError" in extraction) throw new Error(extraction.parseError);
    expect(extraction.literalSpecifiers).toContain("@/components/reui/gantt/gantt");
  });
});
