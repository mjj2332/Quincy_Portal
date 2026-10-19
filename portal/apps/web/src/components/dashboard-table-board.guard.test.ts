/**
 * Guard (#923): the Dashboard Table and Board on the appearance module. Frames 4b–4h set meta at 12px (`text-xs`)
 * and labels at 14px (`text-sm`), and every Stage and lateness look comes from `lib/dashboard-appearance.ts`
 * through `lib/dashboard-project-appearance.ts`. So nothing in the Table's or the Board's own files may:
 *
 * - name a size below `text-xs` (no `text-[<12px]`, no `text-2xs`, no sub-0.75rem rem literal);
 * - draw the Board's retired hatch (`STAGE_HATCH_CLASS`, `stagePatternFor`);
 * - draw a Stage with `StatusBadge` or `stageColorFor` (the pre-#916 palette, which still paints Edited review ochre);
 * - say "overdue" to the viewer: lateness reads "N late", "N days late" and "Late today" (`lateLabel`). Only quoted
 *   strings and JSX text count, so `ProjectDeadlineCell`'s `overdue` field and `overdueInName` prop, which the
 *   Table passes through, are not copy.
 *
 * Cloned from `timeline-type-floor.guard.test.ts`. Comments are stripped first, so a comment that names a removed
 * class in words does not count (lesson "A comment spelling a removed class keeps it in the CSS").
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const componentsDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(componentsDir, "..");

function tableBoardFiles(): string[] {
  const boardDir = join(componentsDir, "board");
  const board = readdirSync(boardDir).filter((name) => /\.tsx?$/.test(name) && !/test/.test(name)).map((name) => join(boardDir, name));
  const table = ["DashboardTable.tsx", "DashboardTableParts.tsx", "TablePhoneList.tsx"].map((name) => join(componentsDir, name));
  const parts = ["LateChip.tsx", "StageLabel.tsx", "DoneProgress.tsx"].map((name) => join(componentsDir, "quincy", name));
  const lib = ["dashboard-project-appearance.ts", "dashboard-table-model.ts", "board-collapse-store.ts"].map((name) => join(srcDir, "lib", name));
  return [...board, ...table, ...parts, ...lib];
}

/** Block and line comments out, string contents kept (a class lives in a string). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const BELOW_FLOOR: readonly RegExp[] = [
  /(?<![\w-])text-2xs(?![\w-])/,
  /(?<![\w-])text-\[(?:[0-9]|1[01])(?:\.\d+)?px\]/,
  /(?<![\w-])text-\[0?\.(?:[0-6]\d*|7[0-4]\d*)rem\]/,
  /(?<![\w-])text-\[length:var\(--text-2xs\)\]/,
];
const RETIRED: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /\b(?:STAGE_HATCH_CLASS|stagePatternFor)\b/, what: "Board hatch" },
  { pattern: /\bStatusBadge\b/, what: "StatusBadge" },
  { pattern: /\bstageColorFor\b/, what: "stageColorFor" },
];
/** "overdue" inside a quoted string, or as JSX text (after a `>` that is not an arrow's). */
const OVERDUE_COPY = /(?:["'`]|(?<!=)>)[^"'`<>\n]*\boverdue\b/i;

function violations(source: string): string[] {
  const code = stripComments(source);
  const hits: string[] = [];
  for (const pattern of BELOW_FLOOR) {
    const match = pattern.exec(code);
    if (match) hits.push(`below the 12px floor: ${match[0]}`);
  }
  for (const { pattern, what } of RETIRED) {
    const match = pattern.exec(code);
    if (match) hits.push(`${what}: ${match[0]}`);
  }
  const overdue = OVERDUE_COPY.exec(code);
  if (overdue) hits.push(`"overdue" copy: ${overdue[0].trim()}`);
  return hits;
}

describe("the Dashboard Table's and Board's type floor and appearance (#923)", () => {
  it("scans the real files", () => {
    const files = tableBoardFiles();
    expect(files.length).toBeGreaterThanOrEqual(15);
    for (const file of files) expect(readFileSync(file, "utf8").length, relative(srcDir, file)).toBeGreaterThan(200);
    // Anchors: the files that draw lateness and the Stage really are in the scan.
    for (const name of ["components/board/board.tsx", "components/board/card.tsx", "components/DashboardTableParts.tsx", "components/quincy/LateChip.tsx"]) {
      expect(files.map((file) => relative(srcDir, file))).toContain(name);
    }
  });

  it("no Table or Board file names a size below text-xs, draws a retired Stage look, or says overdue", () => {
    const failing = tableBoardFiles().flatMap((file) => violations(readFileSync(file, "utf8")).map((hit) => `${relative(srcDir, file)}: ${hit}`));
    expect(failing).toEqual([]);
  });

  it("catches each planted violation, and ignores one in a comment or an identifier", () => {
    expect(violations('const a = "text-2xs";')).toHaveLength(1);
    expect(violations('const a = "text-[10px] font-medium";')).toHaveLength(1);
    expect(violations('const a = "text-[11.5px]";')).toHaveLength(1);
    expect(violations('const a = "text-[0.6875rem]";')).toHaveLength(1);
    expect(violations('import { STAGE_HATCH_CLASS } from "../lib/stage-colors";')).toHaveLength(1);
    expect(violations("const p = stagePatternFor(key);")).toHaveLength(1);
    expect(violations('import { StatusBadge } from "../StatusBadge";')).toHaveLength(1);
    expect(violations("const c = stageColorFor(stage);")).toHaveLength(1);
    expect(violations('const label = "3 overdue";')).toHaveLength(1);
    expect(violations("const label = `${count} Overdue`;")).toHaveLength(1);
    expect(violations("<span>Overdue</span>")).toHaveLength(1);
    expect(violations('const a = "text-xs text-sm text-[12px] text-[0.75rem]";')).toEqual([]);
    expect(violations("const view = { overdue: appearance.lateness.late, overdueInName: true };")).toEqual([]);
    expect(violations("const f = (x) => overdue(x);")).toEqual([]);
    expect(violations('// the old `text-[10px]`, StatusBadge and "Overdue"\nconst a = "text-xs";')).toEqual([]);
  });
});
