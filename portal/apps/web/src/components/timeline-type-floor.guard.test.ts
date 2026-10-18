/**
 * Guard (#916 / #919): the Dashboard Timeline's type floor. Frame 3a sets meta at 12px (`text-xs`) and
 * labels at 14px (`text-sm`); the shipped Timeline drew attention and retry labels at 10px and the
 * vendor's event time at 11px. Nothing in the Timeline's own files may name a size below `text-xs`:
 * no `text-[<12px]`, no `text-2xs` (11px), no `text-[0.6875rem]`, no sub-0.75rem rem literal.
 *
 * The same files draw a Stage from the appearance module's tone (owner decision D3), never the Board's
 * hatch: none may import `STAGE_HATCH_CLASS` or `stagePatternFor`. Comments are stripped first, so a
 * comment that names a removed class in words does not count (lesson "A comment spelling a removed
 * class keeps it in the CSS").
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const componentsDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(componentsDir, "..");

function timelineFiles(): string[] {
  const own = readdirSync(componentsDir).filter((name) => /^ProductionGantt.*\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)).map((name) => join(componentsDir, name));
  const ganttDir = join(componentsDir, "reui", "gantt");
  const vendored = readdirSync(ganttDir).filter((name) => name.endsWith(".tsx") && !/\.test\.tsx$/.test(name)).map((name) => join(ganttDir, name));
  return [...own, ...vendored, join(componentsDir, "quincy", "StageKeyRow.tsx"), join(srcDir, "lib", "production-gantt-appearance-classes.ts"), join(srcDir, "lib", "production-gantt-adapter.ts")];
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
const HATCH = /\b(?:STAGE_HATCH_CLASS|stagePatternFor)\b/;

function violations(source: string): string[] {
  const code = stripComments(source);
  const hits: string[] = [];
  for (const pattern of BELOW_FLOOR) {
    const match = pattern.exec(code);
    if (match) hits.push(`below the 12px floor: ${match[0]}`);
  }
  const hatch = HATCH.exec(code);
  if (hatch) hits.push(`Board hatch: ${hatch[0]}`);
  return hits;
}

describe("the Dashboard Timeline's type floor and Stage look (#919)", () => {
  it("scans the real files", () => {
    const files = timelineFiles();
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) expect(readFileSync(file, "utf8").length, relative(srcDir, file)).toBeGreaterThan(200);
  });

  it("no Timeline file names a size below text-xs or draws the Board's hatch", () => {
    const failing = timelineFiles().flatMap((file) => violations(readFileSync(file, "utf8")).map((hit) => `${relative(srcDir, file)}: ${hit}`));
    expect(failing).toEqual([]);
  });

  it("catches each planted violation, and ignores one in a comment", () => {
    expect(violations('const a = "text-2xs";')).toHaveLength(1);
    expect(violations('const a = "text-[10px] font-medium";')).toHaveLength(1);
    expect(violations('const a = "text-[11.5px]";')).toHaveLength(1);
    expect(violations('const a = "text-[0.6875rem]";')).toHaveLength(1);
    expect(violations('import { STAGE_HATCH_CLASS } from "../lib/stage-colors";')).toHaveLength(1);
    expect(violations("const p = stagePatternFor(key);")).toHaveLength(1);
    expect(violations('const a = "text-xs text-sm text-[12px] text-[0.75rem]";')).toEqual([]);
    expect(violations('// the old `text-[10px]` and STAGE_HATCH_CLASS\nconst a = "text-xs";')).toEqual([]);
  });
});

/**
 * #922: the Calendar under the same floor (frame 3d sets meta at 12px, labels at 14px): its own files, its
 * vendored tree and its adapter. One vendor default is exempt: the slot-draft range readout
 * (`EVENT_CALENDAR_SLOT_DRAFT.label`, 11px), which only a drag-to-create draws, and the Production
 * calendar turns that off (`selectSlot: false`), so the exemption holds only while it stays off.
 */
const calendarDir = join(componentsDir, "reui", "event-calendar");
const SLOT_DRAFT_LABEL = /label:\s*"text-primary truncate px-1 py-0\.5 text-\[0\.6875rem\] leading-none font-medium",/;

function calendarFiles(): string[] {
  const own = readdirSync(componentsDir).filter((name) => /^ProductionEventCalendar.*\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)).map((name) => join(componentsDir, name));
  const vendored = readdirSync(calendarDir).filter((name) => name.endsWith(".tsx") && !/\.test\.tsx$/.test(name)).map((name) => join(calendarDir, name));
  return [...own, ...vendored, join(srcDir, "lib", "production-event-calendar-adapter.ts")];
}

function calendarSource(file: string): string {
  const source = readFileSync(file, "utf8");
  return file === join(calendarDir, "event-calendar-event.tsx") ? source.replace(SLOT_DRAFT_LABEL, "") : source;
}

describe("the Dashboard Calendar's type floor and Stage look (#922)", () => {
  it("scans the real files, and the slot-draft exemption still names a live vendor line", () => {
    const files = calendarFiles();
    expect(files.length).toBeGreaterThan(15);
    for (const file of files) expect(readFileSync(file, "utf8").length, relative(srcDir, file)).toBeGreaterThan(200);
    expect(readFileSync(join(calendarDir, "event-calendar-event.tsx"), "utf8")).toMatch(SLOT_DRAFT_LABEL);
  });

  it("the Production calendar never draws the exempt slot draft", () => {
    expect(readFileSync(join(componentsDir, "ProductionEventCalendar.tsx"), "utf8")).toMatch(/selectSlot: false/);
  });

  it("no Calendar file names a size below text-xs or draws the Board's hatch", () => {
    const failing = calendarFiles().flatMap((file) => violations(calendarSource(file)).map((hit) => `${relative(srcDir, file)}: ${hit}`));
    expect(failing).toEqual([]);
  });
});
