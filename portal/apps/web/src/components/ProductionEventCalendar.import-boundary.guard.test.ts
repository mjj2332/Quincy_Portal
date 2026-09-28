/**
 * #222 — the import and write boundary of `ProductionEventCalendar.tsx`, the twin of
 * `ProductionGantt.import-boundary.guard.test.ts`.
 *
 * (a) `ProductionEventCalendar.tsx` is the ONLY non-test app file outside the vendored tree (and the
 *     dev-only harness) whose source names `components/reui/event-calendar/` in an import. The rail,
 *     facets, unscheduled list, dialogs and `lib/production-event-calendar-*.ts` stay presentational
 *     or pure; a type import counts too (`harness-reachability.guard.test.ts` treats one as a
 *     consumer). That guard's detector (ii) polices the same thing from its import graph; this one
 *     reads source text so it fails with a message naming this surface.
 * (b) `onEventsChange` is never passed to `<EventCalendar>`: every write is `"deferred"` to the
 *     scheduling controller, whose authoritative refetch is the only thing that moves a chip.
 * (c) `canDropEvent` / `enforceCanDrop` are never passed: production warns, it never blocks a drop.
 *
 * Names are matched in CODE only (comments stripped — the file's header names them in prose). Per
 * `docs/lessons.md`'s "a grep gate that cannot fail is not a gate", each detector is exercised
 * against planted fixture text as well as the real files.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

const componentsDir = fileURLToPath(new URL(".", import.meta.url));
const srcDir = join(componentsDir, "..");
const SURFACE = "components/ProductionEventCalendar.tsx";

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => "\n".repeat((match.match(/\n/g) ?? []).length))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Whether the code imports (statically, dynamically or as a type) from the vendored event-calendar tree. */
export function importsEventCalendarTree(source: string): boolean {
  const code = stripComments(source);
  return /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'`][^"'`]*reui\/event-calendar\//.test(code);
}

const FORBIDDEN_PROPS = ["canDropEvent", "enforceCanDrop", "onEventsChange"] as const;

export function findForbiddenEventCalendarProps(source: string): string[] {
  const code = stripComments(source);
  return FORBIDDEN_PROPS.filter((name) => new RegExp(`\\b${name}\\b`).test(code));
}

function isTestFile(path: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(path) || path.startsWith("testing/");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...sourceFiles(abs));
    else if (/\.tsx?$/.test(name)) out.push(abs);
  }
  return out;
}

function eventCalendarImportersOutsideSurface(): string[] {
  return sourceFiles(srcDir)
    .map((abs) => relative(srcDir, abs).split(sep).join("/"))
    .filter((path) => !isTestFile(path))
    .filter((path) => !path.startsWith("components/reui/event-calendar/") && !path.startsWith("harness/"))
    .filter((path) => path !== SURFACE)
    .filter((path) => importsEventCalendarTree(readFileSync(join(srcDir, path), "utf8")))
    .sort();
}

describe("guard: ProductionEventCalendar.tsx is the event-calendar tree's only app consumer", () => {
  it("self-test: detects static, type-only, re-export and dynamic imports of the tree", () => {
    expect(importsEventCalendarTree('import { EventCalendar } from "./reui/event-calendar/event-calendar";')).toBe(true);
    expect(importsEventCalendarTree('import type { CalendarEvent } from "@/components/reui/event-calendar/event-calendar-types";')).toBe(true);
    expect(importsEventCalendarTree('export { EventCalendarNav } from "../components/reui/event-calendar/event-calendar-nav";')).toBe(true);
    expect(importsEventCalendarTree('const C = lazy(() => import("./reui/event-calendar/event-calendar"));')).toBe(true);
    expect(importsEventCalendarTree('import "./reui/event-calendar/event-calendar";')).toBe(true);
  });

  it("self-test: ignores comments and unrelated imports", () => {
    expect(importsEventCalendarTree('// import { EventCalendar } from "./reui/event-calendar/event-calendar";\nimport { Gantt } from "./reui/gantt/gantt";')).toBe(false);
    expect(importsEventCalendarTree('/** never imports `components/reui/event-calendar/` */\nimport { Calendar } from "./reui/calendar";')).toBe(false);
  });

  it("the surface itself does import the tree (so the scan below has something to exclude)", () => {
    expect(importsEventCalendarTree(readFileSync(join(srcDir, SURFACE), "utf8"))).toBe(true);
  });

  it("no other non-test app file imports components/reui/event-calendar/", () => {
    const offenders = eventCalendarImportersOutsideSurface();
    expect(offenders, [
      "Only components/ProductionEventCalendar.tsx may import components/reui/event-calendar/ (#222).",
      "Pass what a sibling needs as props or children instead; keep lib/ adapters on local structural types.",
      ...offenders.map((path) => `  ${path}`),
    ].join("\n")).toEqual([]);
  });
});

describe("guard: ProductionEventCalendar.tsx keeps the deferred write boundary", () => {
  it("self-test: fires on each forbidden prop as JSX, spread or props variable", () => {
    expect(findForbiddenEventCalendarProps("<EventCalendar onEventsChange={setEvents} />")).toEqual(["onEventsChange"]);
    expect(findForbiddenEventCalendarProps("<EventCalendar canDropEvent={(u) => ok(u)} enforceCanDrop />")).toEqual(["canDropEvent", "enforceCanDrop"]);
    expect(findForbiddenEventCalendarProps("<EventCalendar {...{ onEventsChange }} />")).toEqual(["onEventsChange"]);
  });

  it("self-test: ignores the names in comments and the allowed props", () => {
    expect(findForbiddenEventCalendarProps("/** `onEventsChange` is never passed. */\n<EventCalendar onEventUpdate={() => \"deferred\"} />")).toEqual([]);
    expect(findForbiddenEventCalendarProps("// canDropEvent / enforceCanDrop are never passed\n<EventCalendar />")).toEqual([]);
  });

  it("ProductionEventCalendar.tsx passes onEventUpdate (it is the surface this guard means)", () => {
    expect(stripComments(readFileSync(join(srcDir, SURFACE), "utf8"))).toMatch(/\bonEventUpdate=\{/);
  });

  it("ProductionEventCalendar.tsx never passes onEventsChange, canDropEvent or enforceCanDrop", () => {
    const offenders = findForbiddenEventCalendarProps(readFileSync(join(srcDir, SURFACE), "utf8"));
    expect(offenders, [
      "ProductionEventCalendar.tsx mentions an <EventCalendar> setting the #222 write boundary forbids:",
      "  - onEventsChange would let the vendor commit a range the server may refuse; writes are \"deferred\".",
      "  - canDropEvent / enforceCanDrop would block drops; production only warns.",
      ...offenders.map((name) => `  ${name}`),
    ].join("\n")).toEqual([]);
  });
});
