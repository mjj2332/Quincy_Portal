/**
 * #222 — two additive vendor seams the production Calendar needs, driven through the REAL tree.
 * Quincy-authored, not a ReUI vendored file (ADR 0009).
 *
 * 1. `onEventUpdate` may answer `"deferred"` (accept-and-defer, the Gantt's #221 PR A contract):
 *    the consumer took the proposal and owns what happens next (a confirmation dialog, a server
 *    round-trip), so the calendar neither mutates `events` nor announces anything — on the pointer
 *    path AND the keyboard Adjust path. Distinct from `false` (reject), which announces "rejected".
 * 2. `EventCalendarProposedUpdate.granularity` says whether the proposal came from a day cell
 *    (`"day"`) or a minute column (`"minute"`), on both the pointer and the keyboard path, so a
 *    consumer can route it without re-deriving the view's geometry.
 *
 * Seams: chips are found by their visible title, the live region by `aria-live`, grips by their
 * Quincy `data-testid` — never by a vendor-authored `data-slot` (guard F, issue #92).
 */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TZDate } from "@date-fns/tz";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import {
  EventCalendar,
  EventCalendarViewContext,
  useEventCalendar,
  type EventCalendarInstance,
} from "./event-calendar";
import { EventCalendarContent } from "./event-calendar-content";
import { EventCalendarEvent } from "./event-calendar-event";
import type {
  CalendarEvent,
  CalendarView,
  EventCalendarOccurrence,
  EventCalendarProposedUpdate,
  EventCalendarSegment,
  EventCalendarUpdateResult,
} from "./event-calendar-types";

// happy-dom has no `Element#getAnimations`; base-ui's ScrollArea calls it on a timer.
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

const TZ = "Australia/Sydney";
const wall = (y: number, m: number, d: number, h = 0, min = 0) => new TZDate(y, m - 1, d, h, min, 0, 0, TZ);
const utc = (d: Date) => new Date(d.getTime()).toISOString();

const MONDAY_NOON = wall(2026, 9, 21, 12);
const shoot = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "shoot",
  title: "Shoot day",
  start: wall(2026, 9, 21, 9),
  end: wall(2026, 9, 21, 10),
  ...over,
});

let host: HTMLDivElement;
let root: Root;
let instance: EventCalendarInstance | null;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  instance = null;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function Probe() {
  const calendar = useEventCalendar();
  useEffect(() => {
    instance = calendar;
  });
  return null;
}

async function mount({
  view = "week",
  events = [shoot()],
  onEventUpdate,
}: {
  view?: CalendarView;
  events?: CalendarEvent[];
  onEventUpdate?: (update: EventCalendarProposedUpdate) => EventCalendarUpdateResult;
}) {
  await act(async () => {
    root.render(
      <EventCalendar
        defaultEvents={events}
        defaultView={view}
        defaultDate={MONDAY_NOON}
        timeZone={TZ}
        onEventUpdate={onEventUpdate}
      >
        <EventCalendarContent />
        <Probe />
      </EventCalendar>
    );
    await Promise.resolve();
  });
}

function chip(title: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) => el.getAttribute("aria-hidden") !== "true" && el.textContent?.includes(title)
  );
  if (!found) throw new Error(`no chip titled "${title}"`);
  return found;
}

async function press(key: string) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

async function enterAdjust(title: string) {
  act(() => chip(title).focus());
  await press(" ");
}

const announced = () => host.querySelector('[aria-live="polite"]')?.textContent ?? "";

describe('keyboard Adjust — onEventUpdate answering "deferred" (#222)', () => {
  it("a deferred commit announces nothing, mutates nothing, and ends the session", async () => {
    const onEventUpdate = vi.fn((): EventCalendarUpdateResult => "deferred");
    await mount({ onEventUpdate });
    await enterAdjust("Shoot day");
    await press("ArrowDown");
    const before = announced();
    expect(before).not.toBe("");

    await press("Enter");
    expect(onEventUpdate).toHaveBeenCalledTimes(1);
    expect(instance!.getState().drag).toBeNull();
    // the live region still holds the session's last step — nothing new was said
    expect(announced()).toBe(before);
    expect(announced()).not.toMatch(/rejected/i);
    // the calendar did not apply the proposal itself
    expect(utc(instance!.api.getEvent("shoot")!.start)).toBe("2026-09-20T23:00:00.000Z");
  });

  it("false (reject) still announces, so deferred is a distinct answer", async () => {
    await mount({ onEventUpdate: () => false });
    await enterAdjust("Shoot day");
    await press("ArrowDown");
    const before = announced();
    await press("Enter");
    expect(announced()).not.toBe(before);
  });
});

describe("granularity on keyboard proposals (#222)", () => {
  it('a week-view (minute column) keyboard proposal carries granularity "minute"', async () => {
    const onEventUpdate = vi.fn();
    await mount({ onEventUpdate });
    await enterAdjust("Shoot day");
    await press("ArrowDown");
    await press("Enter");
    const update = onEventUpdate.mock.calls[0]![0] as EventCalendarProposedUpdate;
    expect(update.source).toBe("keyboard");
    expect(update.granularity).toBe("minute");
  });

  it('a month-view (day cell) keyboard proposal carries granularity "day"', async () => {
    const onEventUpdate = vi.fn();
    await mount({ view: "month", onEventUpdate });
    await enterAdjust("Shoot day");
    await press("ArrowRight");
    await press("Enter");
    const update = onEventUpdate.mock.calls[0]![0] as EventCalendarProposedUpdate;
    expect(update.source).toBe("keyboard");
    expect(update.granularity).toBe("day");
  });
});

/*
 * Pointer path. Same geometry-mocking technique as `event-calendar-resize-edges.dom.test.tsx`:
 * one synthetic `[data-ec-day]` minute column (1px = 1 minute) so `computeProposal` has real
 * geometry, and the chip rendered directly in the raw view context it reads.
 */
const DAY = wall(2026, 3, 10);
const START = wall(2026, 3, 10, 9);
const END = wall(2026, 3, 10, 10);

function makeSegment(event: CalendarEvent): EventCalendarSegment {
  const occurrence: EventCalendarOccurrence = {
    key: `${event.id}::${event.start.toISOString()}`,
    eventId: event.id,
    event,
    start: event.start,
    end: event.end,
    allDay: false,
    isRecurring: false,
  };
  return {
    occurrence,
    day: DAY,
    isStart: true,
    isEnd: true,
    continuesBefore: false,
    continuesAfter: false,
    startMin: 9 * 60,
    endMin: 10 * 60,
  };
}

function GeometryHost({ event }: { event: CalendarEvent }) {
  const calendar = useEventCalendar();
  useEffect(() => {
    instance = calendar;
  });
  const columnRef = (el: HTMLDivElement | null) => {
    if (!el) return;
    el.getBoundingClientRect = () =>
      ({ left: 0, right: 100, top: 0, bottom: 1440, width: 100, height: 1440, x: 0, y: 0, toJSON() {} }) as DOMRect;
  };
  return (
    <EventCalendarViewContext.Provider value={{ view: "week" }}>
      <div ref={columnRef} data-ec-day={DAY.getTime()} data-ec-bounds-start={0} data-ec-bounds-end={1440} />
      <EventCalendarEvent segment={makeSegment(event)} />
    </EventCalendarViewContext.Provider>
  );
}

async function pointer(target: EventTarget, type: string, init: PointerEventInit) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init }));
    await Promise.resolve();
  });
}

describe("pointer resize — deferred and granularity (#222)", () => {
  it('a deferred pointer resize announces nothing, mutates nothing, and carries granularity "minute"', async () => {
    const event: CalendarEvent = { id: "p1", title: "Pointer", start: START, end: END };
    const onEventUpdate = vi.fn((_u: EventCalendarProposedUpdate): EventCalendarUpdateResult => "deferred");
    const canDropEvent = vi.fn((_u: EventCalendarProposedUpdate) => true);
    await act(async () => {
      root.render(
        <EventCalendar defaultEvents={[event]} timeZone={TZ} onEventUpdate={onEventUpdate} canDropEvent={canDropEvent}>
          <GeometryHost event={event} />
        </EventCalendar>
      );
      await Promise.resolve();
    });
    const grip = host.querySelector<HTMLElement>('[data-testid="event-calendar-resize-handle-end"]');
    expect(grip).not.toBeNull();
    const before = announced();

    await pointer(grip!, "pointerdown", { pointerId: 1, button: 0, clientX: 50, clientY: 10 * 60 });
    await pointer(window, "pointermove", { pointerId: 1, clientX: 50, clientY: 11 * 60 });
    expect(instance!.getState().drag?.kind).toBe("resize-end");
    // the preview proposal handed to canDropEvent carries it too
    expect(canDropEvent.mock.calls.at(-1)![0].granularity).toBe("minute");
    await pointer(window, "pointerup", { pointerId: 1, clientX: 50, clientY: 11 * 60 });

    expect(onEventUpdate).toHaveBeenCalledTimes(1);
    const update = onEventUpdate.mock.calls[0]![0];
    expect(update.source).toBe("resize-end");
    expect(update.granularity).toBe("minute");
    expect(utc(update.end)).toBe(utc(wall(2026, 3, 10, 11)));
    expect(instance!.getState().drag).toBeNull();
    expect(utc(instance!.api.getEvent("p1")!.end)).toBe(utc(END));
    expect(announced()).toBe(before);
  });

  it("an accepted pointer resize still announces (deferred is opt-in)", async () => {
    const event: CalendarEvent = { id: "p2", title: "Pointer", start: START, end: END };
    await act(async () => {
      root.render(
        <EventCalendar defaultEvents={[event]} timeZone={TZ} onEventUpdate={() => true}>
          <GeometryHost event={event} />
        </EventCalendar>
      );
      await Promise.resolve();
    });
    const grip = host.querySelector<HTMLElement>('[data-testid="event-calendar-resize-handle-end"]')!;
    await pointer(grip, "pointerdown", { pointerId: 1, button: 0, clientX: 50, clientY: 10 * 60 });
    await pointer(window, "pointermove", { pointerId: 1, clientX: 50, clientY: 11 * 60 });
    await pointer(window, "pointerup", { pointerId: 1, clientX: 50, clientY: 11 * 60 });
    expect(announced()).toContain("Pointer");
    expect(utc(instance!.api.getEvent("p2")!.end)).toBe(utc(wall(2026, 3, 10, 11)));
  });
});
