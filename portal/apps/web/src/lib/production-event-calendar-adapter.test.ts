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
import { dated, deadlineEvent, dueEvent, instantOf, rangeEvent, timed } from "../testing/production-calendar-fixtures";

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

  it("maps an all-day range to Sydney zoned midnights with an EXCLUSIVE end", () => {
    const event = toProductionEventCalendarEvent(rangeEvent(dated("2026-08-26"), dated("2026-08-28")))!;
    expect(event.allDay).toBe(true);
    expect(event.start).toEqual(at("2026-08-26T00:00"));
    expect(event.end).toEqual(at("2026-08-29T00:00"));
  });

  it("uses the zone's midnight on both 2026 DST transition days, not UTC midnight", () => {
    const fallBack = toProductionEventCalendarEvent(rangeEvent(dated("2026-04-05"), dated("2026-04-05")))!;
    expect(fallBack.start.toISOString()).toBe("2026-04-04T13:00:00.000Z"); // AEDT midnight
    expect(fallBack.end.toISOString()).toBe("2026-04-05T14:00:00.000Z"); // AEST midnight: a 25h day
    const springForward = toProductionEventCalendarEvent(rangeEvent(dated("2026-10-04"), dated("2026-10-04")))!;
    expect(springForward.start.toISOString()).toBe("2026-10-03T14:00:00.000Z");
    expect(springForward.end.toISOString()).toBe("2026-10-04T13:00:00.000Z"); // a 23h day
  });

  it("gives a timed Deadline a synthetic display end", () => {
    const event = toProductionEventCalendarEvent(deadlineEvent("2026-08-27T09:00"))!;
    expect(event.start).toEqual(at("2026-08-27T09:00"));
    expect(event.end.getTime() - event.start.getTime()).toBe(PRODUCTION_EVENT_CALENDAR_DISPLAY_MINUTES * 60_000);
    expect(event.data).toMatchObject({ shape: "deadline", syntheticEnd: true });
  });

  it("gives a due-only item a display end: +display minutes when timed, the next midnight when dated", () => {
    const timedDue = toProductionEventCalendarEvent(dueEvent(timed("2026-08-27T16:00")))!;
    expect(timedDue.allDay).toBe(false);
    expect(timedDue.end.getTime() - timedDue.start.getTime()).toBe(PRODUCTION_EVENT_CALENDAR_DISPLAY_MINUTES * 60_000);
    expect(timedDue.data).toMatchObject({ shape: "due", syntheticEnd: true });
    const datedDue = toProductionEventCalendarEvent(dueEvent(dated("2026-08-27")))!;
    expect(datedDue.allDay).toBe(true);
    expect(datedDue.start).toEqual(at("2026-08-27T00:00"));
    expect(datedDue.end).toEqual(at("2026-08-28T00:00"));
    expect(datedDue.data.syntheticEnd).toBe(true);
  });

  it("per-kind drag/resize flags: range edges follow canResize, Deadline and due-only never resize", () => {
    const range = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00")))!;
    expect(range).toMatchObject({ draggable: true, resizable: true, resizableEdges: { start: true, end: true } });
    const lockedRange = toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00"), { canDrag: false, canResize: false }))!;
    expect(lockedRange).toMatchObject({ draggable: false, resizable: false, resizableEdges: { start: false, end: false } });
    const deadline = toProductionEventCalendarEvent(deadlineEvent("2026-08-27T09:00"))!;
    expect(deadline).toMatchObject({ draggable: true, resizable: false });
    expect(deadline.resizableEdges).toBeUndefined();
    expect(toProductionEventCalendarEvent(deadlineEvent("2026-08-27T09:00", { canDrag: false }))!.draggable).toBe(false);
    const due = toProductionEventCalendarEvent(dueEvent(dated("2026-08-27")))!;
    expect(due).toMatchObject({ draggable: true, resizable: false });
    expect(due.resizableEdges).toBeUndefined();
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

  it("carries assignee initials for checklist items and none for Deadlines", () => {
    expect(toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00")))!.data.initials).toBe("AL");
    expect(toProductionEventCalendarEvent(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00"), { assigneeNull: true }))!.data.initials).toBeNull();
    expect(toProductionEventCalendarEvent(deadlineEvent("2026-08-27T09:00"))!.data.initials).toBeNull();
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
      "active due": toProductionEventCalendarEvent(dueEvent(dated("2026-08-27")))!,
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
  it("the vendored chip still authors the agenda dot and data-view the Deadline class targets", () => {
    const vendored = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../components/reui/event-calendar/event-calendar-event.tsx"), "utf8");
    const slot = /\[data-slot=([\w-]+)\]/.exec(DEADLINE_AGENDA_DOT)?.[1];
    expect(slot, "DEADLINE_AGENDA_DOT names no data-slot").toBeDefined();
    const dot = new RegExp(`data-slot="${slot}"[^>]*?className="([^"]*)"`).exec(vendored);
    expect(dot, `the vendored chip no longer authors data-slot="${slot}"`).not.toBeNull();
    expect(dot![1]!.split(/\s+/), "the vendored agenda dot no longer paints --ec-event-color").toContain("bg-(--ec-event-color)");
    const [, attribute, value] = /^data-\[([\w-]+)=([\w-]+)\]:/.exec(DEADLINE_AGENDA_HOVER) ?? [];
    expect(attribute, "DEADLINE_AGENDA_HOVER names no data-* attribute").toBeDefined();
    expect(vendored, `the vendored chip no longer sets "data-${attribute}": view`).toMatch(new RegExp(`"data-${attribute}":\\s*view,`));
    expect(vendored, `the vendored chip no longer has a "${value}" view`).toContain(`view === "${value}"`);
  });
});
