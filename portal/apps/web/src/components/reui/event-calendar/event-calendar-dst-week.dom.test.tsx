/**
 * #241 — the week view paints every day column on ONE wall-clock axis, so the shared hour gutter
 * is right for all seven columns of a week that contains a DST transition day. Quincy-authored,
 * not a ReUI vendored file; it lives here so a re-vendor trips over it (ADR 0009).
 *
 * Before: the transition column was 23 or 25 hour-heights tall beside six 24-hour columns, and
 * the gutter's labels were formatted from `days[0]` — so Sydney's autumn week (whose first day IS
 * the 25-hour Sunday) labelled all seven columns "1 AM, 2 AM, 2 AM, 3 AM". Measured numbers are
 * in the issue and in `qa-evidence/219b/dst-pass-1-pre-skin.md`.
 *
 * happy-dom does no layout, so this asserts the inline `calc(var(--ec-hour-height) * N)` the grid
 * authors — N is the quantity the defect was in. happy-dom (20.x) also DISCARDS any `calc()` that
 * contains a `var()` when it is assigned through `el.style`, which is how React's client renderer
 * writes styles, so a live render shows no height or top at all. The geometry cases therefore
 * render with `renderToStaticMarkup` and read the raw `style` attribute, which no CSS parser has
 * touched. The pointer cases need real handlers, so they render live and stub one column's rect
 * at 1px = 1 wall-clock minute, the same convention `event-calendar-external-drop.dom.test`
 * uses. Columns are found by `[data-ec-day]`, the attribute `event-calendar-dnd.tsx` itself reads,
 * not by a vendor-authored `data-slot` (guard F, issue #92).
 */
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TZDate } from "@date-fns/tz";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { EventCalendar } from "./event-calendar";
import { EventCalendarContent } from "./event-calendar-content";
import { useEventCalendarExternalDrop, type EventCalendarExternalDropOptions } from "./event-calendar-dnd";
import type { CalendarEvent } from "./event-calendar-types";

// happy-dom has no `Element#getAnimations`; base-ui's ScrollArea viewport calls it on a timer once
// a live week view scrolls. Same polyfill the Gantt's dom tests carry (`gantt-now-line-fade`).
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

const TZ = "Australia/Sydney";
/** Sydney civil wall-clock instant (month 1-based). */
const wall = (y: number, m: number, d: number, h: number, min = 0) =>
  new TZDate(y, m - 1, d, h, min, 0, 0, TZ);

// Both transition days are Sundays, so with the default Sunday week start each is column 0.
const AUTUMN_SUNDAY = wall(2026, 4, 5, 12); // 25-hour day: 02:00-03:00 happens twice
const SPRING_SUNDAY = wall(2026, 10, 4, 12); // 23-hour day: 02:00-03:00 never happens

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const week = (
  date: Date,
  events: CalendarEvent[],
  onSlotClick?: (slot: { date: Date }) => void,
  extra?: ReactNode,
  view: "week" | "day" = "week"
) => (
  <EventCalendar events={events} view={view} date={date} timeZone={TZ} onSlotClick={onSlotClick}>
    <EventCalendarContent />
    {extra}
  </EventCalendar>
);

/** Static markup: `style` attributes arrive verbatim. For geometry assertions. */
function renderWeek(date: Date, events: CalendarEvent[]) {
  host.innerHTML = renderToStaticMarkup(week(date, events));
}

/** Live render, with handlers. For pointer assertions. */
function renderLiveWeek(date: Date, onSlotClick: (slot: { date: Date }) => void) {
  act(() => root.render(week(date, [], onSlotClick)));
}

const timeColumns = () => [...host.querySelectorAll<HTMLElement>("[data-ec-day][data-ec-bounds-start]")];

/** N from an inline `<prop>: calc(var(--ec-hour-height) * N)`. */
function hourHeights(el: HTMLElement, prop: "height" | "top"): number {
  const match = new RegExp(`(?:^|;)\\s*${prop}:\\s*calc\\(var\\(--ec-hour-height\\) \\* ([\\d.]+)\\)`).exec(
    el.getAttribute("style") ?? ""
  );
  if (!match) throw new Error(`no hour-height ${prop} on <${el.tagName}> style="${el.getAttribute("style")}"`);
  return Number(match[1]);
}

/** The positioned block (the column's direct child) holding the chip with this title. */
function blockFor(title: string): HTMLElement {
  for (const column of timeColumns()) {
    const block = [...column.children].find((child) => child.textContent?.includes(title));
    if (block) return block as HTMLElement;
  }
  throw new Error(`no block rendered for "${title}"`);
}

const event = (id: string, start: Date, end: Date): CalendarEvent => ({ id, title: id, start, end });

type Begin = (e: React.PointerEvent, options: EventCalendarExternalDropOptions<string>) => void;

/** A tray stand-in: hands the gesture's `begin` out, and is the pointerdown origin. */
function Tray({ beginRef }: { beginRef: { current: Begin | null } }) {
  const { begin } = useEventCalendarExternalDrop<unknown, string>();
  useEffect(() => {
    beginRef.current = begin;
  });
  return <div data-testid="tray-origin" />;
}

/**
 * Drags a 60-minute tray item onto column 0 of the REAL week view and releases at `clientY`,
 * with every column stubbed 100px wide and 1440px tall (1px = 1 wall-clock minute). This is the
 * gesture engine's pointer path (`pointerMinutes` in event-calendar-dnd.tsx), shared by move,
 * resize and drag-create; `onSlotClick` above is the column's own, separate one.
 */
async function dropOnFirstColumn(date: Date, clientY: number): Promise<Date> {
  const beginRef: { current: Begin | null } = { current: null };
  act(() => root.render(week(date, [], undefined, <Tray beginRef={beginRef} />)));
  timeColumns().forEach((column, i) => {
    column.getBoundingClientRect = () => new DOMRect(i * 100, 0, 100, 1440);
  });
  const onDrop = vi.fn();
  const origin = host.querySelector<HTMLElement>('[data-testid="tray-origin"]')!;
  await act(async () => {
    beginRef.current!(
      { button: 0, pointerType: "mouse", clientX: 50, clientY: clientY - 20, currentTarget: origin } as unknown as React.PointerEvent,
      { payload: "tray-item", durationMinutes: 60, onDrop }
    );
  });
  for (const type of ["pointermove", "pointerup"]) {
    await act(async () => {
      window.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: 50, clientY }));
      await Promise.resolve();
    });
  }
  expect(onDrop).toHaveBeenCalledTimes(1);
  return new Date((onDrop.mock.calls[0]![0] as { start: Date }).start.getTime());
}

describe("week view across a DST transition (#241)", () => {
  it("draws all seven columns 24 hour-heights tall on the 25-hour week", () => {
    renderWeek(AUTUMN_SUNDAY, []);
    expect(timeColumns().map((c) => hourHeights(c, "height"))).toEqual([24, 24, 24, 24, 24, 24, 24]);
  });

  it("draws all seven columns 24 hour-heights tall on the 23-hour week", () => {
    renderWeek(SPRING_SUNDAY, []);
    expect(timeColumns().map((c) => hourHeights(c, "height"))).toEqual([24, 24, 24, 24, 24, 24, 24]);
  });

  it("labels the gutter with 23 distinct hours even when the first day repeats one", () => {
    renderWeek(AUTUMN_SUNDAY, []);
    const labels = [...host.querySelectorAll("span")]
      .map((el) => el.textContent?.trim() ?? "")
      .filter((text) => /^\d{1,2} (AM|PM)$/.test(text));
    // Midnight's own label is suppressed at the day-start edge; 1 AM .. 11 PM remain.
    expect(labels).toHaveLength(23);
    expect(new Set(labels).size).toBe(23);
    expect(labels.slice(0, 4)).toEqual(["1 AM", "2 AM", "3 AM", "4 AM"]);
  });

  it("puts a 23:15 event beside the 23:15 label on the transition day AND on its neighbour", () => {
    renderWeek(AUTUMN_SUNDAY, [
      event("late-sunday", wall(2026, 4, 5, 23, 15), wall(2026, 4, 5, 23, 45)),
      event("late-monday", wall(2026, 4, 6, 23, 15), wall(2026, 4, 6, 23, 45)),
    ]);
    expect(hourHeights(blockFor("late-sunday"), "top")).toBe(23.25);
    expect(hourHeights(blockFor("late-monday"), "top")).toBe(23.25);
    expect(hourHeights(blockFor("late-sunday"), "height")).toBe(0.5);
  });

  it("puts a 04:00 event beside the 4 AM label on the 23-hour day, leaving 02:00 empty", () => {
    renderWeek(SPRING_SUNDAY, [event("early", wall(2026, 10, 4, 4, 0), wall(2026, 10, 4, 5, 0))]);
    expect(hourHeights(blockFor("early"), "top")).toBe(4);
    expect(hourHeights(blockFor("early"), "height")).toBe(1);
  });

  it("packs the repeated hour's two passes side by side, since they share one slot", () => {
    // First 02:00-03:00 is +11:00, the second +10:00: back to back in time, identical on the axis.
    renderWeek(AUTUMN_SUNDAY, [
      event("first-pass", new Date("2026-04-04T15:00:00.000Z"), new Date("2026-04-04T16:00:00.000Z")),
      event("second-pass", new Date("2026-04-04T16:00:00.000Z"), new Date("2026-04-04T17:00:00.000Z")),
    ]);
    const first = blockFor("first-pass");
    const second = blockFor("second-pass");
    expect(hourHeights(first, "top")).toBe(2);
    expect(hourHeights(second, "top")).toBe(2);
    const left = (el: HTMLElement) => /left:\s*([^;]+)/.exec(el.getAttribute("style") ?? "")?.[1];
    expect(left(first)).toBeDefined();
    expect(left(first)).not.toBe(left(second));
  });

  it("reads a click at the noon mark of the 25-hour day as noon", () => {
    const onSlotClick = vi.fn();
    renderLiveWeek(AUTUMN_SUNDAY, onSlotClick);
    const column = timeColumns()[0]!;
    // 1px = 1 wall-clock minute: the column is 24 hour-heights tall whatever the day's length.
    column.getBoundingClientRect = () => new DOMRect(0, 0, 100, 1440);
    act(() => {
      column.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 720 }));
    });
    expect(onSlotClick).toHaveBeenCalledTimes(1);
    // Noon +10:00. A column scaled to its 25 elapsed hours would read this pixel as 12:30 elapsed,
    // which is 11:30 on the clock.
    expect(new Date((onSlotClick.mock.calls[0]![0] as { date: Date }).date.getTime()).toISOString()).toBe(
      "2026-04-05T02:00:00.000Z"
    );
  });

  it("reads a click inside the skipped hour as the instant the gap closes", () => {
    const onSlotClick = vi.fn();
    renderLiveWeek(SPRING_SUNDAY, onSlotClick);
    const column = timeColumns()[0]!;
    column.getBoundingClientRect = () => new DOMRect(0, 0, 100, 1440);
    act(() => {
      column.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 150 }));
    });
    // 02:30 does not exist on 2026-10-04; 03:00 +11:00 is 16:00Z the day before.
    expect(new Date((onSlotClick.mock.calls[0]![0] as { date: Date }).date.getTime()).toISOString()).toBe(
      "2026-10-03T16:00:00.000Z"
    );
  });

  it("reads a drop at the noon mark of the 25-hour day as noon", async () => {
    expect((await dropOnFirstColumn(AUTUMN_SUNDAY, 720)).toISOString()).toBe("2026-04-05T02:00:00.000Z");
  });

  it("reads a drop at the noon mark of the 23-hour day as noon", async () => {
    // Noon +11:00. Scaled to 23 elapsed hours this pixel would be 11:30 elapsed = 12:30.
    expect((await dropOnFirstColumn(SPRING_SUNDAY, 720)).toISOString()).toBe("2026-10-04T01:00:00.000Z");
  });
});

// The issue noted the day view was "not affected in the same way": its labels came from the day
// itself, so they showed the skip or repeat. One model for every view means it no longer does —
// a transition day reads like any other, with an empty or a shared slot.
describe("day view of a DST transition day (#241)", () => {
  const renderDay = (date: Date, events: CalendarEvent[]) => {
    host.innerHTML = renderToStaticMarkup(week(date, events, undefined, undefined, "day"));
  };
  const gutterLabels = () =>
    [...host.querySelectorAll("span")]
      .map((el) => el.textContent?.trim() ?? "")
      .filter((text) => /^\d{1,2} (AM|PM)$/.test(text));

  it("is 24 hour-heights tall with 23 distinct labels on the 25-hour day", () => {
    renderDay(AUTUMN_SUNDAY, [event("late", wall(2026, 4, 5, 23, 15), wall(2026, 4, 5, 23, 45))]);
    expect(timeColumns().map((c) => hourHeights(c, "height"))).toEqual([24]);
    expect(new Set(gutterLabels()).size).toBe(23);
    expect(hourHeights(blockFor("late"), "top")).toBe(23.25);
  });

  it("keeps a 2 AM label on the 23-hour day, above an empty slot", () => {
    renderDay(SPRING_SUNDAY, [event("early", wall(2026, 10, 4, 4, 0), wall(2026, 10, 4, 5, 0))]);
    expect(timeColumns().map((c) => hourHeights(c, "height"))).toEqual([24]);
    expect(gutterLabels().slice(0, 3)).toEqual(["1 AM", "2 AM", "3 AM"]);
    expect(hourHeights(blockFor("early"), "top")).toBe(4);
  });
});

// The resource view is the time grid's twin: its own copy of the day column beside the SAME shared
// gutter component, so it carried the same disagreement and takes the same fix.
describe("resource view on a DST transition day (#241)", () => {
  const RESOURCES = [
    { id: "cam-a", title: "Camera A" },
    { id: "cam-b", title: "Camera B" },
  ];
  const renderResources = (date: Date, events: CalendarEvent[]) => {
    host.innerHTML = renderToStaticMarkup(
      <EventCalendar events={events} resources={RESOURCES} view="resource" date={date} timeZone={TZ}>
        <EventCalendarContent />
      </EventCalendar>
    );
  };

  it("draws every resource column 24 hour-heights tall on the 25-hour day", () => {
    renderResources(AUTUMN_SUNDAY, []);
    expect(timeColumns().map((c) => hourHeights(c, "height"))).toEqual([24, 24]);
  });

  it("puts a 23:15 booking beside the 23:15 label on the 25-hour day", () => {
    renderResources(AUTUMN_SUNDAY, [
      { ...event("late-booking", wall(2026, 4, 5, 23, 15), wall(2026, 4, 5, 23, 45)), resourceId: "cam-a" },
    ]);
    expect(hourHeights(blockFor("late-booking"), "top")).toBe(23.25);
  });
});
