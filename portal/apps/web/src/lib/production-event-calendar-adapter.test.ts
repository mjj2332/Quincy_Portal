import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";
import {
  DEADLINE_AGENDA_DOT,
  DEADLINE_AGENDA_HOVER,
  PRODUCTION_EVENT_CALENDAR_DISPLAY_MINUTES,
  PRODUCTION_EVENT_CALENDAR_VIEW_SETTINGS,
  assigneeInitials,
  calendarViewToSubview,
  productionEventCalendarEventClassName,
  subviewToCalendarView,
  toProductionEventCalendarEvent,
  toProductionEventCalendarEvents,
} from "./production-event-calendar-adapter";
import { deadlineEvent, instantOf, rangeEvent, timed } from "../testing/production-calendar-fixtures";

const at = (localCivil: string) => new Date(instantOf(localCivil));

describe("production event-calendar adapter: DTO → vendor event (#222)", () => {
  it("keeps the Calendar entity id and title, and carries the DTO on data", () => {
    const dto = rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00"));
    const event = toProductionEventCalendarEvent(dto)!;
    expect(event.id).toBe(dto.id);
    expect(event.title).toBe(dto.title);
    expect(event.data.dto).toBe(dto);
    expect(event.data.shape).toBe("range");
  });

  it("maps a timed range to its own instants", () => {
    const event = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00")))!;
    expect(event.allDay).toBe(false);
    expect(event.start).toEqual(at("2026-08-26T09:00"));
    expect(event.end).toEqual(at("2026-08-26T11:00"));
    expect(event.data.syntheticEnd).toBe(false);
  });

  it("maps a multi-day range to its two instants, never an all-day event", () => {
    const event = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-28T17:00")))!;
    expect(event.allDay).toBe(false);
    expect(event.start).toEqual(at("2026-08-26T09:00"));
    expect(event.end).toEqual(at("2026-08-28T17:00"));
  });

  it("keeps a range across both 2026 DST transition days at its real duration", () => {
    const fallBack = toProductionEventCalendarEvent(rangeEvent(timed("2026-04-04T12:00"), timed("2026-04-05T12:00")))!;
    expect(fallBack.end.getTime() - fallBack.start.getTime()).toBe(25 * 3_600_000);
    const springForward = toProductionEventCalendarEvent(rangeEvent(timed("2026-10-03T12:00"), timed("2026-10-04T12:00")))!;
    expect(springForward.end.getTime() - springForward.start.getTime()).toBe(23 * 3_600_000);
  });

  it("gives a timed Deadline a synthetic display end", () => {
    const event = toProductionEventCalendarEvent(deadlineEvent("2026-08-27T09:00"))!;
    expect(event.start).toEqual(at("2026-08-27T09:00"));
    expect(event.end.getTime() - event.start.getTime()).toBe(PRODUCTION_EVENT_CALENDAR_DISPLAY_MINUTES * 60_000);
    expect(event.data).toMatchObject({ shape: "deadline", syntheticEnd: true });
  });

  it("per-kind drag/resize flags: range edges follow canResize, a Deadline never resizes", () => {
    const range = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00")))!;
    expect(range).toMatchObject({ draggable: true, resizable: true, resizableEdges: { start: true, end: true } });
    const lockedRange = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00"), { canDrag: false, canResize: false }))!;
    expect(lockedRange).toMatchObject({ draggable: false, resizable: false, resizableEdges: { start: false, end: false } });
    const deadline = toProductionEventCalendarEvent(deadlineEvent("2026-08-27T09:00"))!;
    expect(deadline).toMatchObject({ draggable: true, resizable: false });
    expect(deadline.resizableEdges).toBeUndefined();
    expect(toProductionEventCalendarEvent(deadlineEvent("2026-08-27T09:00", { canDrag: false }))!.draggable).toBe(false);
    // never readOnly: the Reschedule affordance must stay reachable on a locked event
    expect(lockedRange.readOnly).toBeUndefined();
  });

  it("colour and class: Deadlines solid ink, checklist paper, done dimmed", () => {
    const deadline = toProductionEventCalendarEvent(deadlineEvent("2026-08-27T09:00"))!;
    expect(deadline.color).toBe("var(--ink-900)");
    expect(productionEventCalendarEventClassName(deadline.data)).toContain("bg-(--ink-900)");
    const range = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00")))!;
    expect(range.color).toBe("var(--ink-700)");
    expect(productionEventCalendarEventClassName(range.data)).toContain("bg-(--paper-000)");
    expect(range.data.done).toBe(false);
    const done = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00"), { completed: true }))!;
    expect(done.data.done).toBe(true);
    expect(productionEventCalendarEventClassName(done.data)).toContain("text-foreground-secondary");
  });

  it("carries the assignee list and hidden count for checklist items and none for Deadlines (#370)", () => {
    const grace = { id: "g", name: "Grace Hopper", roleLabel: "Editor", isExternal: false, active: true };
    const one = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00")))!.data;
    expect(one.assignees.map((person) => person.name)).toEqual(["Ada Lovelace"]);
    expect(one.otherAssigneeCount).toBe(0);
    const many = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00"), { assignees: [grace, grace], otherAssigneeCount: 2 }))!.data;
    expect(many.assignees).toHaveLength(2);
    expect(many.otherAssigneeCount).toBe(2);
    const none = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00"), { assigneeNull: true }))!.data;
    expect(none.assignees).toEqual([]);
    const deadline = toProductionEventCalendarEvent(deadlineEvent("2026-08-27T09:00"))!.data;
    expect(deadline.assignees).toEqual([]);
    expect(deadline.otherAssigneeCount).toBe(0);
    expect(assigneeInitials("ada")).toBe("A");
    expect(assigneeInitials("  Grace  Brewster Hopper ")).toBe("GH");
    expect(assigneeInitials("")).toBeNull();
  });

  it("drops an event whose timing cannot be placed instead of throwing", () => {
    const broken = { ...deadlineEvent("2026-08-27T09:00"), timing: { allDay: false as const, start: "not-an-instant", end: null } };
    expect(toProductionEventCalendarEvent(broken)).toBeNull();
    expect(toProductionEventCalendarEvents([broken, deadlineEvent("2026-08-27T09:00")])).toHaveLength(1);
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

  it("a selected checklist chip keeps its paper fill with a light ink wash and one ink ring; a selected Deadline holds its ink inside a double keyline", () => {
    const range = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00")))!;
    const paper = productionEventCalendarEventClassName(range.data)!;
    expect(paper).toContain("data-selected:bg-(--ink-700)/10");
    expect(paper).toContain("data-selected:inset-ring-(--ink-700)");
    const done = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00"), { completed: true }))!;
    expect(productionEventCalendarEventClassName(done.data)).toContain("data-selected:bg-(--ink-700)/10");
    const deadline = productionEventCalendarEventClassName(toProductionEventCalendarEvent(deadlineEvent("2026-08-27T09:00"))!.data)!;
    expect(deadline).toBe(
      "bg-(--ink-900) hover:bg-(--ink-700) text-(--paper-050) inset-ring-(--ink-900) " +
        "data-selected:bg-(--ink-900) data-selected:hover:bg-(--ink-700) data-selected:inset-ring-4 data-selected:inset-ring-(--paper-050) " +
        "data-selected:inset-shadow-[0_0_0_2px_var(--ink-900)] data-[view=agenda]:hover:bg-(--ink-700) " +
        "[--muted-foreground:var(--greige-300)] [&_[data-slot=event-calendar-agenda-dot]]:invisible",
    );
  });

  // Mirrors the vendor's grid-chip tint in components/reui/event-calendar/event-calendar-event.tsx
  // (~L603-607). A copy, so it can drift; ProductionEventCalendar-real.dom.test.tsx checks the real one.
  const VENDOR_GRID =
    "bg-(--ec-event-color)/15 hover:bg-(--ec-event-color)/25 inset-ring inset-ring-(--ec-event-color)/15 " +
    "data-selected:bg-(--ec-event-color)/30 data-selected:inset-ring-(--ec-event-color)/40";

  it("every branch that sets a fill also owns its selected fill and ring, so no vendor --ec-event-color tint survives the merge", () => {
    const branches = {
      deadline: toProductionEventCalendarEvent(deadlineEvent("2026-08-27T09:00"))!,
      "active checklist range": toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00")))!,
      done: toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00"), { completed: true }))!,
    };
    for (const [branch, event] of Object.entries(branches)) {
      const consumer = productionEventCalendarEventClassName(event.data)!;
      const tokens = consumer.split(/\s+/);
      if (!tokens.some((token) => token.startsWith("bg-"))) continue;
      expect(tokens.some((token) => token.startsWith("data-selected:bg-")), `${branch}: no data-selected:bg-`).toBe(true);
      expect(tokens.some((token) => token.startsWith("data-selected:inset-ring-")), `${branch}: no data-selected:inset-ring-`).toBe(true);
      const survivors = cn(VENDOR_GRID, consumer)
        .split(/\s+/)
        .filter((token) => token.includes("--ec-event-color") && (/(^|:)(data-selected|hover):/.test(token) || token.startsWith("bg-(--ec-event-color)")));
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
    const deadline = toProductionEventCalendarEvent(deadlineEvent("2026-08-27T09:00"))!;
    const base = productionEventCalendarEventClassName(deadline.data)!;
    expect(productionEventCalendarEventClassName(deadline.data, false)).toBe(base);
    expect(productionEventCalendarEventClassName(deadline.data, true)).toBe(`${base} outline-2 outline-offset-1 outline-(--ink-900)`);
  });
});
