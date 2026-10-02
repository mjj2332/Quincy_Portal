/**
 * #461: the Dashboard's filter is a tree (or a flat filter the tree helpers can read), so the surfaces
 * that draw from it must ask the shared tree helpers (`dashboardFilterStageScope`,
 * `dashboardFilterHasNonStageLeaf`, `dashboardFilterArchivedMode`, `isEmptyDashboardFilterTree`, ...) and
 * never read a flat field straight off a filter: a flat read answers "nothing" for a tree and silently
 * ignores its rules. `production-gantt-filters.ts` is guarded too: the route <-> facet transport lives in
 * `production-gantt-facet.ts`, so what remains there (the Delivered pair, pairing notice, empty-state
 * recovery) is semantic and must read the filter through the tree helpers.
 *
 * Per `docs/lessons.md` ("a grep gate that cannot fail is not a gate") the detector is a pure function
 * proven against planted fixtures, beside the real scan.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUARDED = ["screens/Dashboard.tsx", "screens/DashboardFilter.tsx", "components/ProductionEventCalendar.tsx", "components/ProductionGantt.tsx", "lib/production-gantt-filters.ts"];

const FLAT_READ = /\.(?:stageKeys|priorities|editorIds|includeUnassigned|shootRange|deadlineRange|overdueOnly|myTasks)\b|\b(?:filter|filters|calendar|calendarState)\.archived\b/u;

/** Source lines (comments stripped) that read a flat filter field. */
function flatFilterReads(source: string): string[] {
  return source.split("\n").map((line) => line.replace(/\/\/.*$/u, "")).filter((line) => !/^\s*(?:\/?\*)/u.test(line) && FLAT_READ.test(line));
}

describe("dashboard filter access guard (#461)", () => {
  it("detects a flat read (planted fixtures)", () => {
    expect(flatFilterReads("const n = filter.stageKeys.length;")).toHaveLength(1);
    expect(flatFilterReads("if (calendarState.archived === 'only') {}")).toHaveLength(1);
    expect(flatFilterReads("const q = calendar.myTasks;")).toHaveLength(1);
    expect(flatFilterReads("// filter.stageKeys is the old way\nconst a = dashboardFilterStageScope(tree);")).toHaveLength(0);
  });

  it.each(GUARDED)("%s reads the filter through the tree helpers only", (file) => {
    expect(flatFilterReads(readFileSync(join(srcDir, file), "utf8")), `${file} reads a flat filter field`).toEqual([]);
  });
});
