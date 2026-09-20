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

/** Every `from "..."` / `from '...'` import specifier in the given source text. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /\bfrom\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier) specifiers.push(specifier);
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
