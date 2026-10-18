import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "date-fns";
import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";
import {
  DEADLINE_AGENDA_DOT,
  DEADLINE_AGENDA_HOVER,
  PRODUCTION_EVENT_CALENDAR_DISPLAY_MINUTES,
  PRODUCTION_EVENT_CALENDAR_I18N,
  PRODUCTION_EVENT_CALENDAR_VIEW_SETTINGS,
  calendarViewToSubview,
  productionEventCalendarEventClassName,
  subviewToCalendarView,
  toProductionEventCalendarEvent,
  toProductionEventCalendarEvents,
} from "./production-event-calendar-adapter";
import type { CalendarEventDto } from "@quincy/shared";
import { stageTone, subtaskPeopleTone } from "./dashboard-appearance";
import { deadlineEvent, instantOf, rangeEvent, timed } from "../testing/production-calendar-fixtures";

const at = (localCivil: string) => new Date(instantOf(localCivil));
/** Before every fixture below, so nothing here is late unless a test says so. */
const NOW = at("2026-08-20T12:00");

describe("production event-calendar adapter: DTO → vendor event (#222)", () => {
  it("keeps the Calendar entity id and title, and carries the DTO on data", () => {
    const dto = rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00"));
    const event = toProductionEventCalendarEvent(dto, NOW)!;
    expect(event.id).toBe(dto.id);
    expect(event.title).toBe(dto.title);
    expect(event.data.dto).toBe(dto);
    expect(event.data.shape).toBe("range");
  });

  it("maps a timed range to its own instants", () => {
    const event = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00")), NOW)!;
    expect(event.allDay).toBe(false);
    expect(event.start).toEqual(at("2026-08-26T09:00"));
    expect(event.end).toEqual(at("2026-08-26T11:00"));
    expect(event.data.syntheticEnd).toBe(false);
  });

  it("maps a multi-day range to its two instants, never an all-day event", () => {
    const event = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-28T17:00")), NOW)!;
    expect(event.allDay).toBe(false);
    expect(event.start).toEqual(at("2026-08-26T09:00"));
    expect(event.end).toEqual(at("2026-08-28T17:00"));
  });

  it("keeps a range across both 2026 DST transition days at its real duration", () => {
    const fallBack = toProductionEventCalendarEvent(rangeEvent(timed("2026-04-04T12:00"), timed("2026-04-05T12:00")), NOW)!;
    expect(fallBack.end.getTime() - fallBack.start.getTime()).toBe(25 * 3_600_000);
    const springForward = toProductionEventCalendarEvent(rangeEvent(timed("2026-10-03T12:00"), timed("2026-10-04T12:00")), NOW)!;
    expect(springForward.end.getTime() - springForward.start.getTime()).toBe(23 * 3_600_000);
  });

  it("gives a timed Deadline a synthetic display end", () => {
    const event = toProductionEventCalendarEvent(deadlineEvent("2026-08-27T09:00"), NOW)!;
    expect(event.start).toEqual(at("2026-08-27T09:00"));
    expect(event.end.getTime() - event.start.getTime()).toBe(PRODUCTION_EVENT_CALENDAR_DISPLAY_MINUTES * 60_000);
    expect(event.data).toMatchObject({ shape: "deadline", syntheticEnd: true });
  });

  it("per-kind drag/resize flags: range edges follow canResize, a Deadline never resizes", () => {
    const range = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00")), NOW)!;
    expect(range).toMatchObject({ draggable: true, resizable: true, resizableEdges: { start: true, end: true } });
    const lockedRange = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00"), { canDrag: false, canResize: false }), NOW)!;
    expect(lockedRange).toMatchObject({ draggable: false, resizable: false, resizableEdges: { start: false, end: false } });
    const deadline = toProductionEventCalendarEvent(deadlineEvent("2026-08-27T09:00"), NOW)!;
    expect(deadline).toMatchObject({ draggable: true, resizable: false });
    expect(deadline.resizableEdges).toBeUndefined();
    expect(toProductionEventCalendarEvent(deadlineEvent("2026-08-27T09:00", { canDrag: false }), NOW)!.draggable).toBe(false);
    // never readOnly: the Reschedule affordance must stay reachable on a locked event
    expect(lockedRange.readOnly).toBeUndefined();
  });

  it("colour and class: Deadlines solid ink, ranges in their Stage tone, done dimmed", () => {
    const deadline = toProductionEventCalendarEvent(deadlineEvent("2026-08-27T09:00"), NOW)!;
    expect(deadline.color).toBe("var(--bg-inverse)");
    expect(productionEventCalendarEventClassName(deadline.data)).toContain("bg-(--ec-event-color)");
    const range = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00")), NOW)!;
    expect(range.color).toBe("var(--stage-editing)");
    expect(productionEventCalendarEventClassName(range.data)).toContain("bg-[color-mix(in_srgb,var(--ec-event-color)_var(--stage-wash-mix),var(--bg-surface))]");
    expect(range.data.done).toBe(false);
    const done = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00"), { completed: true }), NOW)!;
    expect(done.data.done).toBe(true);
    expect(productionEventCalendarEventClassName(done.data)).toContain("text-foreground-secondary");
  });

  it("carries the assignee list and hidden count for checklist items and none for Deadlines (#370)", () => {
    const grace = { id: "g", name: "Grace Hopper", roleLabel: "Editor", isExternal: false, active: true };
    const one = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00")), NOW)!.data;
    expect(one.assignees.map((person) => person.name)).toEqual(["Ada Lovelace"]);
    expect(one.otherAssigneeCount).toBe(0);
    const many = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00"), { assignees: [grace, grace], otherAssigneeCount: 2 }), NOW)!.data;
    expect(many.assignees).toHaveLength(2);
    expect(many.otherAssigneeCount).toBe(2);
    const none = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00"), { assigneeNull: true }), NOW)!.data;
    expect(none.assignees).toEqual([]);
    const deadline = toProductionEventCalendarEvent(deadlineEvent("2026-08-27T09:00"), NOW)!.data;
    expect(deadline.assignees).toEqual([]);
    expect(deadline.otherAssigneeCount).toBe(0);
  });

  it("drops an event whose timing cannot be placed instead of throwing", () => {
    const broken = { ...deadlineEvent("2026-08-27T09:00"), timing: { allDay: false as const, start: "not-an-instant", end: null } };
    expect(toProductionEventCalendarEvent(broken, NOW)).toBeNull();
    expect(toProductionEventCalendarEvents([broken, deadlineEvent("2026-08-27T09:00")], NOW)).toHaveLength(1);
  });

  it("maps every Production subview to the same-named vendor view and back; resource has no subview", () => {
    for (const subview of ["month", "week", "day", "days", "agenda"] as const) {
      expect(calendarViewToSubview(subviewToCalendarView(subview))).toBe(subview);
    }
    expect(calendarViewToSubview("resource")).toBeNull();
  });

  it("offers only the 3-day preset, matching the 3-day `days` view", () => {
    expect(PRODUCTION_EVENT_CALENDAR_VIEW_SETTINGS.dayCount).toBe(3);
    expect(PRODUCTION_EVENT_CALENDAR_VIEW_SETTINGS.dayCountPresets).toEqual([3]);
  });

  it("opens the time-grid views (week, day, 3-day) scrolled to 8 AM, not midnight", () => {
    // The vendor's `scrollToHour` is an hour number (vendor default 7); it only affects time grids.
    expect(PRODUCTION_EVENT_CALENDAR_VIEW_SETTINGS.scrollToHour).toBe(8);
  });

  it("frame 3d: a range is the Stage wash of its tone edged 1.5px in the full tone; selected deepens the wash inside a 2px tone ring", () => {
    const range = productionEventCalendarEventClassName(toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00")), NOW)!.data)!;
    expect(range.split(" ")).toEqual(expect.arrayContaining([
      "bg-[color-mix(in_srgb,var(--ec-event-color)_var(--stage-wash-mix),var(--bg-surface))]", "hover:bg-(--ec-event-color)/20", "inset-ring-(length:--border-width-mid)", "inset-ring-(--ec-event-color)", "text-foreground",
      "data-selected:bg-(--ec-event-color)/24", "data-selected:hover:bg-(--ec-event-color)/28", "data-selected:inset-ring-2", "data-selected:inset-ring-(--ec-event-color)",
    ]));
  });

  it("an Awaiting RAW range is hollow: paper with a dashed tone edge, as the Timeline draws it", () => {
    const awaiting = { ...rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00")) };
    awaiting.project = { ...awaiting.project, stageKey: "awaiting_raw" } as typeof awaiting.project;
    const classes = productionEventCalendarEventClassName(toProductionEventCalendarEvent(awaiting, NOW)!.data)!.split(" ");
    expect(classes).toEqual(expect.arrayContaining(["bg-card", "border-(length:--border-width-mid)", "border-dashed", "border-(--ec-event-color)", "inset-ring-0", "data-selected:bg-(--ec-event-color)/14"]));
    expect(classes).not.toContain("bg-[color-mix(in_srgb,var(--ec-event-color)_var(--stage-wash-mix),var(--bg-surface))]");
  });

  it("a late range keeps its wash and swaps its edge for a 2px late ring, selected or not", () => {
    const classes = productionEventCalendarEventClassName(toProductionEventCalendarEvent(rangeEvent(timed("2026-08-17T09:00"), timed("2026-08-18T17:00")), NOW)!.data)!.split(" ");
    expect(classes).toEqual(expect.arrayContaining(["bg-[color-mix(in_srgb,var(--ec-event-color)_var(--stage-wash-mix),var(--bg-surface))]", "inset-ring-(length:--border-width-bold)", "inset-ring-late", "data-selected:inset-ring-late"]));
    expect(classes).not.toContain("inset-ring-(length:--border-width-mid)");
    expect(classes).not.toContain("inset-ring-(--ec-event-color)");
  });

  it("a done range rests on the raised paper with a --text-muted edge and secondary text; selected takes a light ink wash", () => {
    const classes = productionEventCalendarEventClassName(toProductionEventCalendarEvent(rangeEvent(timed("2026-08-17T09:00"), timed("2026-08-18T17:00"), { completed: true }), NOW)!.data)!.split(" ");
    expect(classes).toEqual(expect.arrayContaining(["bg-muted", "hover:bg-surface-sunken", "inset-ring-(--text-muted)", "text-foreground-secondary", "data-selected:bg-foreground/10", "data-selected:inset-ring-foreground"]));
    expect(classes.some((token) => token.includes("late"))).toBe(false);
  });

  it("a Deadline fills with --ec-event-color (ink, late or Delivered) and holds it inside a double keyline when selected", () => {
    const deadline = productionEventCalendarEventClassName(toProductionEventCalendarEvent(deadlineEvent("2026-08-27T09:00"), NOW)!.data)!;
    expect(deadline).toBe(
      "bg-(--ec-event-color) hover:bg-(--ec-event-color)/85 text-on-tone inset-ring-(--ec-event-color) " +
        "data-selected:bg-(--ec-event-color) data-selected:hover:bg-(--ec-event-color)/85 data-selected:inset-ring-4 data-selected:inset-ring-on-tone " +
        "data-selected:inset-shadow-[0_0_0_2px_var(--ec-event-color)] data-[view=agenda]:hover:bg-(--ec-event-color)/85 " +
        "[--muted-foreground:var(--greige-300)] [&_[data-slot=event-calendar-agenda-dot]]:invisible [--focus-ring:var(--text-on-tone)] focus-visible:bg-(--ec-event-color)/85 " +
        "focus-visible:![outline-offset:calc(-1*var(--border-width-bold))]",
    );
    // greige-300 is under 4.5:1 on oxblood and olive, so a late or delivered Deadline's muted text is paper.
    const late = productionEventCalendarEventClassName(toProductionEventCalendarEvent(deadlineEvent("2026-08-19T09:00"), NOW)!.data)!;
    expect(late).toContain("[--muted-foreground:var(--text-on-tone)]");
    expect(late).not.toContain("[--muted-foreground:var(--greige-300)]");
  });

  // Mirrors the vendor's grid-chip tint in components/reui/event-calendar/event-calendar-event.tsx
  // (~L603-607). A copy, so it can drift; ProductionEventCalendar-real.dom.test.tsx checks the real one.
  const VENDOR_GRID =
    "bg-(--ec-event-color)/15 hover:bg-(--ec-event-color)/25 inset-ring inset-ring-(--ec-event-color)/15 " +
    "data-selected:bg-(--ec-event-color)/30 data-selected:inset-ring-(--ec-event-color)/40";

  it("every branch that sets a fill also owns its selected fill and ring, so no vendor --ec-event-color tint survives the merge", () => {
    const branches = {
      deadline: toProductionEventCalendarEvent(deadlineEvent("2026-08-27T09:00"), NOW)!,
      "active checklist range": toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00")), NOW)!,
      done: toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00"), { completed: true }), NOW)!,
      "late range": toProductionEventCalendarEvent(rangeEvent(timed("2026-08-17T09:00"), timed("2026-08-18T17:00")), NOW)!,
      "late deadline": toProductionEventCalendarEvent(deadlineEvent("2026-08-19T09:00"), NOW)!,
    };
    for (const [branch, event] of Object.entries(branches)) {
      const consumer = productionEventCalendarEventClassName(event.data)!;
      const tokens = consumer.split(/\s+/);
      if (!tokens.some((token) => token.startsWith("bg-"))) continue;
      expect(tokens.some((token) => token.startsWith("data-selected:bg-")), `${branch}: no data-selected:bg-`).toBe(true);
      expect(tokens.some((token) => token.startsWith("data-selected:inset-ring-")), `${branch}: no data-selected:inset-ring-`).toBe(true);
      // #922: the consumer paints with --ec-event-color too (the tone), so a survivor is a VENDOR token, exactly.
      const vendorTints = new Set(VENDOR_GRID.split(/\s+/).filter((token) => token.includes("--ec-event-color")));
      const survivors = cn(VENDOR_GRID, consumer)
        .split(/\s+/)
        .filter((token) => vendorTints.has(token));
      expect(survivors, `${branch}: vendor tint survives the merge`).toEqual([]);
    }
  });

  // The Deadline class reaches into the vendored agenda row through two vendor attributes: the
  // dot's `data-slot` (DEADLINE_AGENDA_DOT) and the chip's `data-view` (DEADLINE_AGENDA_HOVER). If a
  // re-vendor renames either, those selectors silently stop matching and every rendered test still
  // passes; this reads the vendored source, as event-calendar-skin.guard.test.ts does, and notices.

  /**
   * Strip JS/TSX comments so markup quoted in prose cannot satisfy — or break — any assertion.
   * Block comments (which cover JSX `{/* … }` comments too) and `// …` line comments; a quoted
   * string or template literal is copied through untouched, so a `//` inside one (a URL) is not a
   * comment.
   */
  function stripTsComments(source: string): string {
    let out = "";
    let i = 0;
    while (i < source.length) {
      const char = source[i]!;
      const next = source[i + 1];
      if (char === "/" && next === "*") {
        const close = source.indexOf("*/", i + 2);
        i = close === -1 ? source.length : close + 2;
      } else if (char === "/" && next === "/") {
        const newline = source.indexOf("\n", i + 2);
        i = newline === -1 ? source.length : newline;
      } else if (char === '"' || char === "'" || char === "`") {
        let j = i + 1;
        while (j < source.length && source[j] !== char) j += source[j] === "\\" ? 2 : 1;
        out += source.slice(i, j + 1);
        i = j + 1;
      } else {
        out += char;
        i += 1;
      }
    }
    return out;
  }

  /** Every way `source` (comments stripped) no longer carries what the Deadline class targets. */
  function vendoredPinFailures(source: string): string[] {
    const code = stripTsComments(source);
    const failures: string[] = [];
    const slot = /\[data-slot=([\w-]+)\]/.exec(DEADLINE_AGENDA_DOT)?.[1];
    if (!slot) return ["DEADLINE_AGENDA_DOT names no data-slot"];
    const dot = new RegExp(`data-slot="${slot}"[^>]*?className="([^"]*)"`).exec(code);
    if (!dot) failures.push(`the vendored chip no longer authors data-slot="${slot}"`);
    else if (!dot[1]!.split(/\s+/).includes("bg-(--ec-event-color)")) failures.push("the vendored agenda dot no longer paints --ec-event-color");
    const [, attribute, value] = /^data-\[([\w-]+)=([\w-]+)\]:/.exec(DEADLINE_AGENDA_HOVER) ?? [];
    if (!attribute) return [...failures, "DEADLINE_AGENDA_HOVER names no data-* attribute"];
    if (!new RegExp(`"data-${attribute}":\\s*view,`).test(code)) failures.push(`the vendored chip no longer sets "data-${attribute}": view`);
    if (!code.includes(`view === "${value}"`)) failures.push(`the vendored chip no longer has a "${value}" view`);
    return failures;
  }

  it("the vendored chip still authors the agenda dot and data-view the Deadline class targets", () => {
    const vendored = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../components/reui/event-calendar/event-calendar-event.tsx"), "utf8");
    const failures = vendoredPinFailures(vendored);
    expect(failures, failures.join("\n")).toEqual([]);
    // Every QUINCY note in that file is a comment, so none survives a stripper that stayed in step
    // with the file's strings from start to end.
    expect(stripTsComments(vendored)).not.toContain("QUINCY");
  });

  it("the vendored-source pin ignores markup that survives only in comments", () => {
    const fixture = [
      'const url = "https://example.test/a//b"; // a URL string is not a comment',
      "const agendaDefaultContent = (",
      "  <>",
      '    {/* <span aria-hidden data-slot="event-calendar-agenda-dot" className="size-2 shrink-0 rounded-full bg-(--ec-event-color)" /> */}',
      '    <span aria-hidden data-slot="event-calendar-agenda-badge" className="size-2 shrink-0 rounded-full bg-(--ec-event-color)" />',
      "  </>",
      ")",
      "const defaultProps = {",
      '  // "data-view": view,',
      '  "data-kind": view,',
      "}",
      'const agenda = view === "agenda"',
    ].join("\n");
    const failures = vendoredPinFailures(fixture);
    expect(failures).toContain('the vendored chip no longer authors data-slot="event-calendar-agenda-dot"');
    expect(failures).toContain('the vendored chip no longer sets "data-view": view');
    expect(stripTsComments(fixture)).toContain('"https://example.test/a//b"');
  });

  it("#464: a landed highlight appends one outline and leaves the base class untouched", () => {
    const deadline = toProductionEventCalendarEvent(deadlineEvent("2026-08-27T09:00"), NOW)!;
    const base = productionEventCalendarEventClassName(deadline.data)!;
    expect(productionEventCalendarEventClassName(deadline.data, false)).toBe(base);
    expect(productionEventCalendarEventClassName(deadline.data, true)).toBe(`${base} outline-2 outline-offset-1 outline-(--ink-900)`);
  });
});

describe("production event-calendar adapter: focus ring and day headers (#602)", () => {
  it("insets every chip's focus ring: the cell and the agenda scroller clip an outward outline", () => {
    const ring = "focus-visible:![outline-offset:calc(-1*var(--border-width-bold))]";
    const deadline = toProductionEventCalendarEvent(deadlineEvent("2026-08-27T09:00"), NOW)!;
    const range = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00")), NOW)!;
    const done = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00"), { completed: true }), NOW)!;
    for (const event of [deadline, range, done]) {
      expect(productionEventCalendarEventClassName(event.data)).toContain(ring);
      expect(productionEventCalendarEventClassName(event.data, true)).toContain(ring);
    }
  });

  it("a Deadline chip's focus ring is paper, since --focus-ring and its ink fill are the same colour; light chips keep the default", () => {
    const override = "[--focus-ring:var(--text-on-tone)]";
    const deadline = productionEventCalendarEventClassName(toProductionEventCalendarEvent(deadlineEvent("2026-08-27T09:00"), NOW)!.data)!;
    expect(deadline).toContain(override);
    // Keyboard focus lifts the fill to the hover ink, so it reads apart from the selected state (#602).
    expect(deadline).toContain("focus-visible:bg-(--ec-event-color)/85");
    expect(productionEventCalendarEventClassName(toProductionEventCalendarEvent(deadlineEvent("2026-08-27T09:00"), NOW)!.data, true)).toContain(override);
    const range = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00")), NOW)!;
    const done = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00"), { completed: true }), NOW)!;
    expect(productionEventCalendarEventClassName(range.data)).not.toContain("--focus-ring");
    expect(productionEventCalendarEventClassName(range.data)).not.toContain("focus-visible:bg-");
    expect(productionEventCalendarEventClassName(done.data)).not.toContain("--focus-ring");
  });

  it("names the +N more day the way the rest of the Portal does", () => {
    expect(format(new Date(2026, 10, 18), PRODUCTION_EVENT_CALENDAR_I18N.formats.moreDayHeader)).toBe("Wed 18 Nov");
  });

  it("heads the agenda day the same short way (#614)", () => {
    const f = PRODUCTION_EVENT_CALENDAR_I18N.formats;
    expect(f.agendaDayWeekday).toBe("EEE");
    expect(f.agendaDayDate).toBe("d MMM yyyy");
    expect(format(new Date(2026, 9, 7), f.agendaDayWeekday)).toBe("Wed");
    expect(format(new Date(2026, 9, 7), f.agendaDayDate)).toBe("7 Oct 2026");
  });
});

describe("production event-calendar adapter: range titles (#643)", () => {
  const f = PRODUCTION_EVENT_CALENDAR_I18N.functions;
  const range = (startIso: string, endIso: string) => ({ start: new Date(startIso), end: new Date(endIso) });
  const base = () => "BASE";
  const ctx = (activeRange: { start: Date; end: Date }, date = activeRange.start) => ({ date, activeRange, visibleRange: activeRange });

  it("titles a Monday week with the Portal's day-first range, the end read as exclusive", () => {
    // 28 Sep 00:00 AEST to 5 Oct 00:00 AEDT (exclusive).
    expect(f.formatTitle("week", ctx(range("2026-09-27T14:00:00.000Z", "2026-10-04T13:00:00.000Z")), base)).toBe("28 Sep \u2013 4 Oct 2026");
  });

  it("titles the 3-day and agenda ranges the same way", () => {
    expect(f.formatTitle("days", ctx(range("2026-10-06T13:00:00.000Z", "2026-10-09T13:00:00.000Z")), base)).toBe("7\u20139 Oct 2026");
    expect(f.formatTitle("agenda", ctx(range("2026-10-06T13:00:00.000Z", "2026-10-20T13:00:00.000Z")), base)).toBe("7\u201320 Oct 2026");
  });

  it("leaves the month title to the merged base", () => {
    expect(f.formatTitle("month", ctx(range("2026-09-30T14:00:00.000Z", "2026-11-10T13:00:00.000Z")), (view) => (view === "month" ? "October 2026" : "x"))).toBe("October 2026");
  });

  it("titles the day view 'Wed 7 Oct 2026' through the dayTitle format", () => {
    expect(PRODUCTION_EVENT_CALENDAR_I18N.formats.dayTitle).toBe("EEE d MMM yyyy");
    expect(format(new Date(2026, 9, 7), PRODUCTION_EVENT_CALENDAR_I18N.formats.dayTitle)).toBe("Wed 7 Oct 2026");
  });

  it("names a day range for the agenda aria-label and drag drafts", () => {
    expect(f.formatDayRange(range("2026-10-06T13:00:00.000Z", "2026-10-20T13:00:00.000Z"))).toBe("7\u201320 Oct 2026");
  });

  it("stacks the agenda row on phones through the vendor's classNames.agendaItem hook (#648)", () => {
    expect(PRODUCTION_EVENT_CALENDAR_VIEW_SETTINGS.classNames.agendaItem).toBe("max-[721px]:flex-wrap max-[721px]:gap-y-0.5");
  });

});

describe("production event-calendar adapter: appearance from the dashboard appearance module (#922)", () => {
  type Stage = "awaiting_raw" | "raw_review" | "editing" | "editing_autohdr" | "edited_review" | "delivered";
  const inStage = <T extends CalendarEventDto>(dto: T, stageKey: Stage, extra: { archived?: boolean } = {}): T =>
    ({ ...dto, project: { ...dto.project, stageKey, delivered: stageKey === "delivered", archived: extra.archived ?? false } }) as T;
  const withOverdue = <T extends CalendarEventDto>(dto: T, overdue: boolean): T => ({ ...dto, status: { ...dto.status, overdue } }) as T;

  it("a range carries its Project's Stage tone, its lateness and its people, and paints in the tone", () => {
    const expected: Record<Stage, string> = {
      awaiting_raw: "var(--stage-awaiting-raw)",
      raw_review: "var(--stage-raw-review)",
      editing: "var(--stage-editing)",
      editing_autohdr: "var(--stage-editing)",
      edited_review: "var(--stage-edited-review)",
      delivered: "var(--stage-delivered)",
    };
    for (const [stage, color] of Object.entries(expected) as [Stage, string][]) {
      const event = toProductionEventCalendarEvent(inStage(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00")), stage), NOW)!;
      expect(event.color, stage).toBe(color);
      expect(event.data.appearance, stage).toEqual({
        kind: "range",
        tone: stageTone(stage),
        lateness: { late: false },
        lateLabel: null,
        people: subtaskPeopleTone({ assignees: event.data.assignees, otherAssigneeCount: 0 }),
        done: false,
      });
    }
    expect(toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00")), NOW)!.data.appearance).toMatchObject({
      people: { kind: "person", initials: "AL" },
    });
  });

  it("a range is late by civil days once its real end has passed, and never once it is complete", () => {
    const due = rangeEvent(timed("2026-08-17T09:00"), timed("2026-08-18T17:00"));
    expect(toProductionEventCalendarEvent(due, NOW)!.data.appearance).toMatchObject({ lateness: { late: true, daysLate: 2 }, lateLabel: "2 days late" });
    expect(toProductionEventCalendarEvent(due, at("2026-08-18T17:30"))!.data.appearance).toMatchObject({ lateness: { late: true, daysLate: 0 }, lateLabel: "Late today" });
    expect(toProductionEventCalendarEvent(due, at("2026-08-18T16:59"))!.data.appearance).toMatchObject({ lateness: { late: false }, lateLabel: null });
    const done = rangeEvent(timed("2026-08-17T09:00"), timed("2026-08-18T17:00"), { completed: true });
    expect(toProductionEventCalendarEvent(done, NOW)!.data.appearance).toMatchObject({ lateness: { late: false }, done: true });
  });

  it("a Deadline is late from its own instant, not from the synthetic display end; ink, --late or --stage-delivered", () => {
    const deadline = deadlineEvent("2026-08-19T09:00");
    const quarterPast = toProductionEventCalendarEvent(deadline, at("2026-08-19T09:15"))!;
    expect(quarterPast.data.appearance).toEqual({ kind: "deadline", fill: "late", color: "var(--late)", lateness: { late: true, daysLate: 0 }, lateLabel: "Late today" });
    expect(quarterPast.color).toBe("var(--late)");
    const dayLate = toProductionEventCalendarEvent(deadline, NOW)!;
    expect(dayLate.data.appearance).toMatchObject({ fill: "late", lateLabel: "1 day late" });
    const onTime = toProductionEventCalendarEvent(deadline, at("2026-08-19T08:59"))!;
    expect(onTime.data.appearance).toEqual({ kind: "deadline", fill: "ink", color: "var(--bg-inverse)", lateness: { late: false }, lateLabel: null });
    expect(onTime.color).toBe("var(--bg-inverse)");
    const delivered = toProductionEventCalendarEvent(inStage(deadline, "delivered"), NOW)!;
    expect(delivered.data.appearance).toEqual({ kind: "deadline", fill: "delivered", color: "var(--stage-delivered)", lateness: { late: false }, lateLabel: null });
    expect(delivered.color).toBe("var(--stage-delivered)");
  });

  it("agrees with the server's status.overdue, which it never reads; an archived Project is the one documented difference", () => {
    // `status.overdue` as production-calendar.ts sets it at NOW (2026-08-20 12:00 Sydney): the fixture
    // values are the server's answers, written out, so the adapter is checked against an independent rule.
    const cases: Array<[string, CalendarEventDto]> = [
      ["deadline passed", withOverdue(deadlineEvent("2026-08-19T09:00"), true)],
      ["deadline ahead", withOverdue(deadlineEvent("2026-08-21T09:00"), false)],
      ["deadline passed, delivered", withOverdue(inStage(deadlineEvent("2026-08-19T09:00"), "delivered"), false)],
      ["range ended", withOverdue(rangeEvent(timed("2026-08-17T09:00"), timed("2026-08-18T17:00")), true)],
      ["range running", withOverdue(rangeEvent(timed("2026-08-19T09:00"), timed("2026-08-21T17:00")), false)],
      ["range ended, complete", withOverdue(rangeEvent(timed("2026-08-17T09:00"), timed("2026-08-18T17:00"), { completed: true }), false)],
    ];
    for (const [name, dto] of cases) {
      expect(toProductionEventCalendarEvent(dto, NOW)!.data.appearance.lateness.late, name).toBe(dto.status.overdue);
    }
    // The server marks an archived Project's passed Deadline overdue; the appearance module never calls an
    // archived Project late (`projectLateness`), and the Calendar draws from the module.
    const archived = withOverdue(inStage(deadlineEvent("2026-08-19T09:00"), "editing", { archived: true }), true);
    expect(toProductionEventCalendarEvent(archived, NOW)!.data.appearance).toMatchObject({ fill: "ink", lateness: { late: false } });
  });

  it("reads no appearance from status.overdue: a stale flag changes nothing", () => {
    const stale = withOverdue(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00")), true);
    expect(toProductionEventCalendarEvent(stale, NOW)!.data.appearance.lateness).toEqual({ late: false });
  });
});
