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
 * That safety rests on three separate facts, each pinned by a describe block below:
 *
 * (i)   No non-test source file outside `src/harness/` imports anything under `src/harness/`.
 *       The harness is a leaf the app tree never reaches back into.
 * (ii)  No non-test source file outside `src/harness/` and outside `components/reui/gantt/` /
 *       `components/reui/event-calendar/` imports from either of those two vendored trees. This
 *       is what "no production consumer" means for #219 stage 1 — the vendored Gantt files land
 *       in this stage with nothing wired to them. #220 and #222 relax this deliberately, one path
 *       at a time, with a comment recording why (see the ALLOWED list below).
 * (iii) `vite.config.ts` never lists the harness HTML as a build input, so `vite build`'s only
 *       input stays `index.html` and no harness chunk or URL reaches production.
 *
 * Modelled on `lib/routing-transport.guard.test.ts`: every detector is a pure function over
 * injected input, exercised here with a synthetic fixture that PLANTS the violation it looks for
 * and asserts the detector reports it — per `docs/lessons.md`, "a grep gate that cannot fail is
 * not a gate." Import resolution (aliased `@/…` and relative specifiers, both static and dynamic
 * `import(...)`) is duplicated from `components/quincy/orphan.guard.test.ts` on purpose — that
 * file is not imported from here, so this guard has no dependency on it.
 *
 * This file is `.test.ts`, so it runs in the NODE suite (`vitest.config.ts`), not the happy-dom
 * one. It reads sources as text; it renders nothing.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const harnessDir = dirname(fileURLToPath(import.meta.url)); // .../src/harness
const srcDir = join(harnessDir, ".."); // .../src
const webDir = join(srcDir, ".."); // .../apps/web

const rel = (file: string) => relative(srcDir, file).split(sep).join("/");

// ---------------------------------------------------------------------------
// Filesystem walk + import resolution — duplicated from
// components/quincy/orphan.guard.test.ts, deliberately not imported from it.
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

const isTestFile = (file: string) => /\.test\.tsx?$/.test(file);

/**
 * Blanks out comment bodies, preserving offsets and newlines, without touching string or
 * template literals. Hand-rolled for the same reason `orphan.guard.test.ts` hand-rolls its own
 * copy: no parser dependency is worth pulling in to serve one guard.
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
    out += char;
    if (char === "\\") { const escaped = source[i + 1]; if (escaped !== undefined) { out += escaped; i += 1; } continue; }
    if (char === state) state = "code";
  }
  return out;
}

/** Every import/re-export/dynamic-import specifier in `text`, comments stripped first. */
function importSpecifiers(text: string): string[] {
  const source = stripComments(text);
  const specifiers: string[] = [];
  for (const match of source.matchAll(/\bimport\s*((?:(?!\bfrom\b)[^;])*?)\bfrom\s*["']([^"']+)["']/g)) {
    specifiers.push(match[2] as string);
  }
  for (const match of source.matchAll(/\bexport\s*((?:(?!\bfrom\b)[^;])*?)\bfrom\s*["']([^"']+)["']/g)) {
    specifiers.push(match[2] as string);
  }
  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) {
    specifiers.push(match[1] as string);
  }
  for (const match of source.matchAll(/\bimport\s*["']([^"']+)["']/g)) {
    specifiers.push(match[1] as string);
  }
  return specifiers;
}

/**
 * Resolves a relative or `@/`-alias specifier to an absolute `.ts`/`.tsx` file. Bare package
 * specifiers and anything that does not resolve to a `.ts`/`.tsx` file are skipped silently —
 * they are not part of this graph.
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

/** Resolved import targets of `file`, as srcDir-relative forward-slash paths. */
function resolvedImportTargets(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const targets = new Set<string>();
  for (const specifier of importSpecifiers(text)) {
    const target = resolveSpecifier(file, specifier);
    if (target) targets.add(rel(target));
  }
  return [...targets];
}

interface FileNode {
  path: string; // srcDir-relative, forward slashes
  isTest: boolean;
  importTargets: string[]; // srcDir-relative, forward slashes
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
      { path: "screens/Dashboard.tsx", isTest: false, importTargets: ["harness/reui-scheduling/main.tsx"] },
      { path: "harness/reui-scheduling/main.tsx", isTest: false, importTargets: ["harness/reui-scheduling/fixtures.ts"] },
      { path: "App.tsx", isTest: false, importTargets: ["screens/Dashboard.tsx"] },
    ];
    expect(findHarnessImportersOutsideHarness(planted)).toEqual(["screens/Dashboard.tsx"]);
  });

  it("finds no real importer outside src/harness/", () => {
    const files: FileNode[] = walkTsFiles(srcDir).map((file) => ({
      path: rel(file),
      isTest: isTestFile(file),
      importTargets: resolvedImportTargets(file),
    }));
    const offenders = findHarnessImportersOutsideHarness(files);
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
      { path: "screens/Dashboard.tsx", isTest: false, importTargets: ["components/reui/gantt/gantt.tsx"] },
      { path: "harness/reui-scheduling/main.tsx", isTest: false, importTargets: ["components/reui/gantt/gantt.tsx"] },
      { path: "components/reui/gantt/gantt-header.tsx", isTest: false, importTargets: ["components/reui/gantt/gantt.tsx"] },
      { path: "screens/EventCalendarScreen.tsx", isTest: false, importTargets: ["components/reui/event-calendar/calendar.tsx"] },
    ];
    expect(findVendorSchedulingImportersOutsideAllowed(planted)).toEqual([
      "screens/Dashboard.tsx",
      "screens/EventCalendarScreen.tsx",
    ]);
  });

  it("finds no real production consumer today", () => {
    const files: FileNode[] = walkTsFiles(srcDir).map((file) => ({
      path: rel(file),
      isTest: isTestFile(file),
      importTargets: resolvedImportTargets(file),
    }));
    const offenders = findVendorSchedulingImportersOutsideAllowed(files);
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
// Detector (iii) — vite.config.ts never lists the harness HTML as a build input
// ---------------------------------------------------------------------------

const HARNESS_HTML_REL_PATH = "harness/reui-scheduling/index.html";

/**
 * True if `source` (vite.config.ts's text) references the harness HTML path anywhere. Whole-file
 * text, not just inside `rollupOptions.input`: a reference anywhere is enough to start wiring the
 * harness into the production build, which is exactly what must never happen silently.
 */
function referencesHarnessBuildInput(source: string): boolean {
  return source.includes(HARNESS_HTML_REL_PATH) || source.includes("reui-scheduling/index.html");
}

describe("guard: vite.config.ts does not list the harness HTML as a build input", () => {
  it("self-test: fires on a planted rollupOptions.input reference", () => {
    const planted = `
      export default defineConfig({
        build: { rollupOptions: { input: { harness: "harness/reui-scheduling/index.html" } } },
      });
    `;
    expect(referencesHarnessBuildInput(planted)).toBe(true);
  });

  it("does not fire on the real vite.config.ts", () => {
    const source = readFileSync(join(webDir, "vite.config.ts"), "utf8");
    expect(
      referencesHarnessBuildInput(source),
      "vite.config.ts references the harness HTML path. build.rollupOptions.input must stay " +
        "unset (defaulting to index.html alone) so the harness never reaches the production build.",
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sanity — the scan itself is pointed at real files, including the harness this guard exists for
// ---------------------------------------------------------------------------

describe("the file scan itself", () => {
  it("reads real application source, and sees the harness entry it is guarding", () => {
    const files = walkTsFiles(srcDir).map(rel);
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("harness/reui-scheduling/main.tsx");
    expect(existsSync(join(webDir, "harness", "reui-scheduling", "index.html"))).toBe(true);
  });

  it("import resolution sees a real aliased and a real relative edge", () => {
    // main.tsx imports the global stylesheet via a side-effect `@/`-alias import. Not a .ts/.tsx
    // target, so it resolves to nothing — proving the resolver does not silently claim a false
    // positive for every specifier it sees. The dynamic-import and directory-index-resolution
    // paths are exercised directly below.
    const specifiers = importSpecifiers(readFileSync(join(harnessDir, "reui-scheduling", "main.tsx"), "utf8"));
    expect(specifiers).toContain("@/styles/index.css");
    expect(resolveSpecifier(join(harnessDir, "reui-scheduling", "main.tsx"), "@/styles/index.css")).toBeUndefined();
  });

  it("resolves an aliased directory import to its index file, and sees dynamic import()", () => {
    expect(resolveSpecifier(join(srcDir, "probe.ts"), "@/components/reui/button")).toBe(
      join(srcDir, "components", "reui", "button.tsx"),
    );
    expect(importSpecifiers(`const C = lazy(() => import("@/components/reui/gantt/gantt"));`)).toEqual([
      "@/components/reui/gantt/gantt",
    ]);
  });
});
