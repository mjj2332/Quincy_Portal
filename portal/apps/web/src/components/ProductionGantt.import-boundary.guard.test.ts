/**
 * #220 pass B, build spec S6 point 4 — the read-only boundary's fourth enforcement leg.
 *
 * `ProductionGantt.tsx` renders the production schedule strictly read-only: no drag, no resize, no
 * slot selection, every event `readOnly: true` from the adapter. That is a design property, not a
 * type-checked one — nothing stops a future edit from quietly wiring in a mutation path unless
 * something fails the build when it happens. This guard is that something: it reads
 * `ProductionGantt.tsx` as source text (the same technique `ProductionCalendarChrome.guard.test.ts`
 * and `harness-reachability.guard.test.ts` both use for their own source-text checks) and fails if
 * it imports from any of the three modules that exist specifically to MUTATE a schedule —
 * `lib/use-scheduling-commands`, `lib/scheduling-policy*`, `lib/scheduling-undo`. #221 (the
 * drag-to-place affordance the build spec explicitly defers) is expected to delete one or more of
 * these assertions on purpose when it wires real mutation in; until then, an import here is a sign
 * the boundary has been crossed by accident.
 *
 * Per `docs/lessons.md`'s "a grep gate that cannot fail is not a gate", the detector is exercised
 * against planted fixture text below, not just against the real file.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const componentsDir = fileURLToPath(new URL(".", import.meta.url));
const sourcePath = join(componentsDir, "ProductionGantt.tsx");

function productionGanttSource(): string {
  return readFileSync(sourcePath, "utf8");
}

/**
 * Every module-loading specifier in the given source text, across every form Vite/TypeScript
 * actually resolve a module through: a static `import ... from "..."` / `export ... from "..."`
 * (the original `\bfrom\s+["']...["']` pattern — an `export`/`export type` form already contains
 * the literal text `from "..."`, so that ONE pattern already covered it), a bare SIDE-EFFECT import
 * with no binding (`import "...";` — no `from` keyword at all), a dynamic `import(...)`, a CommonJS
 * `require(...)` (fix-220-sol1 #6: the guard's own finding was that only the `from` form was
 * recognised), `import.meta.glob(...)` / `import.meta.globEager(...)`, and `new URL("...",
 * import.meta.url)` (fix-220-sol2 #7: round 2's report claimed all three of THESE were added with
 * "5 self-tests, one per new form" in the pass that landed fix-220-sol1 #6 — they were not; that
 * pass added exactly the four forms above it, and neither `import.meta.glob`/`globEager` nor `new
 * URL(..., import.meta.url)` had a matching pattern here at all until THIS fix, verified against
 * this file's own git history before writing it). Each pattern is independent and every match is
 * collected, rather than reusing a single AST walk (`harness-reachability.guard.test.ts`'s own
 * `extractSpecifiers`) — that walker is NOT exported from its file (this repo's own house pattern,
 * per THIS file's original header, is to duplicate the small amount of matching logic a guard needs
 * rather than import between sibling guard test files), and this guard scans exactly one known,
 * small, hand-authored source file rather than the whole tree, where a full parser's extra
 * correctness has far less to buy. Every one of the six forms below is locked in by its own
 * self-test (`import.meta.glob`'s single-literal and array-of-literals shapes, and `globEager`,
 * share one pattern and are each exercised by their own test below it).
 */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    // `import ... from "..."`, `export ... from "..."`, `export * from "..."` — every one of these
    // contains the literal text `from "..."` somewhere in the statement.
    /\bfrom\s+["']([^"']+)["']/g,
    // A bare side-effect import: `import "...";` — no binding, so no `from` keyword at all.
    /\bimport\s+["']([^"']+)["']/g,
    // A dynamic `import(...)`, literal or no-substitution-template argument.
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    // A CommonJS `require(...)`, literal or no-substitution-template argument.
    /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    // fix-220-sol2 #7: `new URL("...", import.meta.url)` — Vite's special-cased asset/worker URL
    // form (`new Worker(new URL(...))` included, since this pattern matches the inner `new URL(...)`
    // regardless of what wraps it). A `import.meta.glob` reaching a restricted module isn't the only
    // way around a text-based guard like this one; this form is the other one this repo's own
    // `harness-reachability.guard.test.ts` already treats as a real module-loading path.
    /\bnew\s+URL\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\s*\.\s*meta\s*\.\s*url\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) specifiers.push(specifier);
    }
  }
  // fix-220-sol2 #7: `import.meta.glob(...)` / `import.meta.globEager(...)` — the call's own
  // argument can be a single string literal OR an array of them (`import.meta.glob(["a", "b"])`),
  // so unlike every pattern above (which captures exactly one specifier per match), every quoted
  // literal found INSIDE the call's own parens is pulled out, not just the first.
  const globCallPattern = /\bimport\s*\.\s*meta\s*\.\s*glob(?:Eager)?\s*\(([^)]*)\)/g;
  for (const call of source.matchAll(globCallPattern)) {
    const args = call[1] ?? "";
    for (const literal of args.matchAll(/["'`]([^"'`]+)["'`]/g)) {
      if (literal[1]) specifiers.push(literal[1]);
    }
  }
  return specifiers;
}

/** Forbidden module-path fragments — matched as a substring of the resolved specifier, so both a
 * `../lib/...` relative form and a future `@/lib/...` alias form are caught the same way. */
const FORBIDDEN_MODULE_FRAGMENTS = ["lib/use-scheduling-commands", "lib/scheduling-policy", "lib/scheduling-undo"];

/** Which (if any) forbidden fragment each specifier in `specifiers` matches, sorted for a stable assertion message. */
export function findForbiddenSchedulingImports(specifiers: string[]): string[] {
  return specifiers.filter((specifier) => FORBIDDEN_MODULE_FRAGMENTS.some((fragment) => specifier.includes(fragment))).sort();
}

describe("guard: ProductionGantt.tsx never imports a scheduling-mutation module", () => {
  it("self-test: fires on a planted import of each forbidden module, and not on a benign one", () => {
    expect(findForbiddenSchedulingImports(['../lib/use-scheduling-commands'])).toEqual(["../lib/use-scheduling-commands"]);
    expect(findForbiddenSchedulingImports(["../lib/scheduling-policy"])).toEqual(["../lib/scheduling-policy"]);
    expect(findForbiddenSchedulingImports(["../lib/scheduling-undo"])).toEqual(["../lib/scheduling-undo"]);
    // The "scheduling-policy*" prefix in the build spec: a differently-suffixed module under the
    // same family must still be caught.
    expect(findForbiddenSchedulingImports(["../lib/scheduling-policy-extra"])).toEqual(["../lib/scheduling-policy-extra"]);
    expect(findForbiddenSchedulingImports(["../lib/production-gantt-adapter", "react"])).toEqual([]);
  });

  it("extracts import specifiers from real import/type-import syntax", () => {
    const source = [
      'import { useState } from "react";',
      'import type { DashboardIdentity } from "../lib/dashboard-projects";',
      "import { Gantt } from '@/components/reui/gantt/gantt';",
    ].join("\n");
    expect(importSpecifiers(source)).toEqual(["react", "../lib/dashboard-projects", "@/components/reui/gantt/gantt"]);
  });

  // fix-220-sol1 #6: the extractor used to recognise only the `from "..."` form — a bespoke regex
  // whose comment promised nothing more. These four self-tests plant each of the OTHER real
  // module-loading forms this guard must not blind itself to, per `docs/lessons.md`'s "a grep gate
  // that cannot fail is not a gate": each one is a forbidden-fragment specifier, reachable only
  // through that one form, and each assertion would fail (return `[]`, missing the offender) against
  // the pre-fix extractor.
  it("extracts a side-effect import with no binding (no `from` keyword at all)", () => {
    expect(importSpecifiers('import "../lib/scheduling-undo";')).toEqual(["../lib/scheduling-undo"]);
  });

  it("extracts a dynamic import(), literal and no-substitution-template forms", () => {
    expect(importSpecifiers('void import("../lib/scheduling-policy");')).toEqual(["../lib/scheduling-policy"]);
    expect(importSpecifiers("void import(`../lib/scheduling-policy`);")).toEqual(["../lib/scheduling-policy"]);
  });

  it("extracts a CommonJS require(), literal and no-substitution-template forms", () => {
    expect(importSpecifiers('const x = require("../lib/use-scheduling-commands");')).toEqual(["../lib/use-scheduling-commands"]);
    expect(importSpecifiers("const x = require(`../lib/use-scheduling-commands`);")).toEqual(["../lib/use-scheduling-commands"]);
  });

  it("extracts an export ... from / export * from re-export form", () => {
    expect(importSpecifiers('export { doThing } from "../lib/scheduling-policy";')).toEqual(["../lib/scheduling-policy"]);
    expect(importSpecifiers('export * from "../lib/scheduling-undo";')).toEqual(["../lib/scheduling-undo"]);
  });

  // fix-220-sol2 #7: round 2's report claimed these three forms were already added, with "5
  // self-tests, one per new form" — they were not (see `importSpecifiers`' own docblock). These
  // self-tests plant each one for real, the same way the fix-220-sol1 #6 block above does for its
  // own four forms: each assertion would fail (return `[]`, missing the offender) against the
  // pre-fix extractor.
  it("extracts import.meta.glob with a single string-literal pattern", () => {
    expect(importSpecifiers('const modules = import.meta.glob("../lib/scheduling-policy*");')).toEqual(["../lib/scheduling-policy*"]);
  });

  it("extracts import.meta.glob with an array of string-literal patterns", () => {
    expect(importSpecifiers('const modules = import.meta.glob(["../lib/scheduling-policy", "../lib/scheduling-undo"]);')).toEqual([
      "../lib/scheduling-policy",
      "../lib/scheduling-undo",
    ]);
  });

  it("extracts import.meta.globEager with a single string-literal pattern", () => {
    expect(importSpecifiers('const modules = import.meta.globEager("../lib/scheduling-undo");')).toEqual(["../lib/scheduling-undo"]);
  });

  it("extracts new URL(\"...\", import.meta.url), bare and wrapped in new Worker(...)", () => {
    expect(importSpecifiers('const url = new URL("../lib/scheduling-policy", import.meta.url);')).toEqual(["../lib/scheduling-policy"]);
    expect(importSpecifiers('const w = new Worker(new URL("../lib/scheduling-undo", import.meta.url));')).toEqual(["../lib/scheduling-undo"]);
  });

  it("every one of the four forms above is caught by the forbidden-import check end to end, not just by the extractor in isolation", () => {
    expect(findForbiddenSchedulingImports(importSpecifiers('import "../lib/scheduling-undo";'))).toEqual(["../lib/scheduling-undo"]);
    expect(findForbiddenSchedulingImports(importSpecifiers('void import("../lib/scheduling-policy");'))).toEqual(["../lib/scheduling-policy"]);
    expect(findForbiddenSchedulingImports(importSpecifiers('const x = require("../lib/use-scheduling-commands");'))).toEqual(["../lib/use-scheduling-commands"]);
    expect(findForbiddenSchedulingImports(importSpecifiers('export { doThing } from "../lib/scheduling-policy";'))).toEqual(["../lib/scheduling-policy"]);
  });

  it("every one of the three fix-220-sol2 #7 forms above is caught by the forbidden-import check end to end too", () => {
    expect(findForbiddenSchedulingImports(importSpecifiers('const modules = import.meta.glob("../lib/scheduling-policy*");'))).toEqual([
      "../lib/scheduling-policy*",
    ]);
    expect(findForbiddenSchedulingImports(importSpecifiers('const modules = import.meta.globEager("../lib/scheduling-undo");'))).toEqual([
      "../lib/scheduling-undo",
    ]);
    expect(findForbiddenSchedulingImports(importSpecifiers('const url = new URL("../lib/use-scheduling-commands", import.meta.url);'))).toEqual([
      "../lib/use-scheduling-commands",
    ]);
  });

  it("ProductionGantt.tsx imports nothing from lib/use-scheduling-commands, lib/scheduling-policy*, or lib/scheduling-undo", () => {
    const offenders = findForbiddenSchedulingImports(importSpecifiers(productionGanttSource()));
    expect(
      offenders,
      [
        "ProductionGantt.tsx imports from a scheduling-MUTATION module. This surface is read-only by",
        "design (build spec #220 S6) — a real drag/resize/create affordance is #221's job, and #221",
        "is expected to delete this guard's relevant assertion on purpose when it lands. Until then,",
        "an import here means the read-only boundary was crossed by accident.",
        ...offenders.map((specifier) => `  ${specifier}`),
      ].join("\n"),
    ).toEqual([]);
  });
});
