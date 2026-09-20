/**
 * Node test for the #219 stage 3 external-drop POLICY (`external-drop-policy.ts`). No DOM, no
 * React — pure assertions on `unscheduledItemToEvent` / `canDropUnscheduled`, mirroring
 * `fixtures.test.ts`'s own style and TZDate discipline (never `new Date("...")`).
 */
import { describe, expect, it } from "vitest";
import { TZDate } from "@date-fns/tz";
import type { EventCalendarExternalDropTarget } from "@/components/reui/event-calendar/event-calendar-dnd";
import { canDropUnscheduled, unscheduledItemToEvent } from "./external-drop-policy";
import { SYDNEY_TZ, type UnscheduledItem } from "./fixtures";

function sydney(y: number, m: number, d: number, h = 0, min = 0): TZDate {
  return new TZDate(y, m - 1, d, h, min, 0, 0, SYDNEY_TZ);
}

const ITEM: UnscheduledItem = {
  id: "unsched-scout",
  title: "Location scout",
  durationMinutes: 90,
  color: "var(--greige-400)",
};

describe("unscheduledItemToEvent", () => {
  it("a timed target keeps its exact minutes — no re-snap", () => {
    const target: EventCalendarExternalDropTarget = {
      start: sydney(2026, 3, 10, 9, 17),
      end: sydney(2026, 3, 10, 10, 47),
      allDay: false,
      view: "week",
      dayGranular: false,
      resourceId: "shoot-auckland",
    };
    const event = unscheduledItemToEvent(target, ITEM);
    expect(event.start).toBe(target.start);
    expect(event.end).toBe(target.end);
    expect(event.start.getTime()).toBe(sydney(2026, 3, 10, 9, 17).getTime());
    expect(event.end.getTime()).toBe(sydney(2026, 3, 10, 10, 47).getTime());
  });

  it("an all-day target spans exactly one civil day", () => {
    const target: EventCalendarExternalDropTarget = {
      start: sydney(2026, 3, 10),
      end: sydney(2026, 3, 11),
      allDay: true,
      view: "month",
      dayGranular: true,
    };
    const event = unscheduledItemToEvent(target, ITEM);
    expect(event.allDay).toBe(true);
    expect(event.start.getTime()).toBe(sydney(2026, 3, 10).getTime());
    expect(event.end.getTime()).toBe(sydney(2026, 3, 11).getTime());
  });

  it("produces a deterministic id — a re-drop of the same item replaces, not duplicates", () => {
    const target: EventCalendarExternalDropTarget = {
      start: sydney(2026, 3, 10, 9, 0),
      end: sydney(2026, 3, 10, 10, 30),
      allDay: false,
      view: "week",
      dayGranular: false,
    };
    const first = unscheduledItemToEvent(target, ITEM);
    const second = unscheduledItemToEvent(
      {
        ...target,
        start: sydney(2026, 3, 11, 14, 0),
        end: sydney(2026, 3, 11, 15, 30),
      },
      ITEM,
    );
    expect(first.id).toBe(`scheduled-${ITEM.id}`);
    expect(second.id).toBe(first.id);
  });

  it("carries title, color, resourceId and the fromUnscheduled marker", () => {
    const target: EventCalendarExternalDropTarget = {
      start: sydney(2026, 3, 10, 9, 0),
      end: sydney(2026, 3, 10, 10, 30),
      allDay: false,
      view: "resource",
      dayGranular: false,
      resourceId: "shoot-wellington",
    };
    const event = unscheduledItemToEvent(target, ITEM);
    expect(event.title).toBe(ITEM.title);
    expect(event.color).toBe(ITEM.color);
    expect(event.resourceId).toBe("shoot-wellington");
    expect(event.data).toEqual({ done: false, fromUnscheduled: true });
  });

  it("omits resourceId when the target has none", () => {
    const target: EventCalendarExternalDropTarget = {
      start: sydney(2026, 3, 10, 9, 0),
      end: sydney(2026, 3, 10, 10, 30),
      allDay: false,
      view: "week",
      dayGranular: false,
    };
    const event = unscheduledItemToEvent(target, ITEM);
    expect("resourceId" in event).toBe(false);
  });
});

describe("canDropUnscheduled", () => {
  it("accepts an ordinary timed target within a single civil day", () => {
    const target: EventCalendarExternalDropTarget = {
      start: sydney(2026, 3, 10, 14, 0),
      end: sydney(2026, 3, 10, 15, 30),
      allDay: false,
      view: "week",
      dayGranular: false,
      resourceId: "shoot-auckland",
    };
    expect(canDropUnscheduled(target, ITEM)).toBe(true);
  });

  it("accepts an all-day target even though it spans into the next civil day", () => {
    const target: EventCalendarExternalDropTarget = {
      start: sydney(2026, 3, 10),
      end: sydney(2026, 3, 11),
      allDay: true,
      view: "month",
      dayGranular: true,
    };
    expect(canDropUnscheduled(target, ITEM)).toBe(true);
  });

  it("refuses a resource-view column target with no resourceId", () => {
    const target: EventCalendarExternalDropTarget = {
      start: sydney(2026, 3, 10, 9, 0),
      end: sydney(2026, 3, 10, 10, 30),
      allDay: false,
      view: "resource",
      dayGranular: false,
      // resourceId intentionally omitted — an untagged resource column
    };
    expect(canDropUnscheduled(target, ITEM)).toBe(false);
  });

  it("accepts a resource-view target that IS day-granular even with no resourceId (a whole-day cell, not a lost column)", () => {
    const target: EventCalendarExternalDropTarget = {
      start: sydney(2026, 3, 10),
      end: sydney(2026, 3, 10, 1, 30),
      allDay: false,
      view: "resource",
      dayGranular: true,
    };
    expect(canDropUnscheduled(target, ITEM)).toBe(true);
  });

  it("refuses a 90-minute item dropped at 23:00 — crosses midnight and is not all-day", () => {
    const item: UnscheduledItem = { ...ITEM, durationMinutes: 90 };
    const target: EventCalendarExternalDropTarget = {
      start: sydney(2026, 3, 10, 23, 0),
      end: sydney(2026, 3, 11, 0, 30),
      allDay: false,
      view: "week",
      dayGranular: false,
      resourceId: "shoot-auckland",
    };
    expect(canDropUnscheduled(target, item)).toBe(false);
  });
});
