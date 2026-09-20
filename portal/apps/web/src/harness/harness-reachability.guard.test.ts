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
 * (ii)  No non-test source file outside `src/harness/` and outside `components/reui/gantt/` /
 *       `components/reui/event-calendar/` imports from either of those two vendored trees, same
 *       glob-reach rule. This is what "no production consumer" means for #219 stage 1 — the
 *       vendored Gantt files land in this stage with nothing wired to them. #220 and #222 relax
 *       this deliberately, one path at a time, with a comment recording why (see the ALLOWED list
 *       below).
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
 * Paths allowed to import the vendored scheduling trees. #220 (Gantt consumer) and #222
 * (event-calendar consumer) each relax this deliberately, one prefix at a time — when that
 * happens, add the new consumer's path here with a comment naming the issue, do not widen the
 * prefix match below it.
 */
const VENDOR_SCHEDULING_PREFIXES = ["components/reui/gantt/", "components/reui/event-calendar/"];
const ALLOWED_VENDOR_SCHEDULING_CONSUMERS = ["harness/", ...VENDOR_SCHEDULING_PREFIXES];

function findVendorSchedulingImportersOutsideAllowed(files: FileNode[]): string[] {
  return files
    .filter((file) => !file.isTest && !ALLOWED_VENDOR_SCHEDULING_CONSUMERS.some((prefix) => file.path.startsWith(prefix)))
    .filter((file) => file.importTargets.some((target) => VENDOR_SCHEDULING_PREFIXES.some((prefix) => target.startsWith(prefix))))
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

  it("finds no real production consumer today", () => {
    const offenders = findVendorSchedulingImportersOutsideAllowed(scanAllSourceFiles());
    expect(offenders, [
      "A non-test source file outside src/harness/ (and outside the vendored tree itself) imports",
      "from components/reui/gantt or components/reui/event-calendar. #219 stage 1 lands these",
      "vendored files with NO production consumer — #220/#222 relax this deliberately, one path at",
      "a time, with a comment recording why. Add the new consumer to",
      "ALLOWED_VENDOR_SCHEDULING_CONSUMERS instead of widening the prefix match.",
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
