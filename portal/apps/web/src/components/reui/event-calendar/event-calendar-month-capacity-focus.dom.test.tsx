/**
 * #614 PR B review finding — focus after a keyboard move that HIDES the bar. Under autoFit at a
 * measured cap of 1, a lane-0 bar moved onto a day holding a timed event folds into that day's
 * "+N more" and unmounts, so the gesture's refocus finds no chip and focus used to fall to
 * <body>. Quincy-authored (ADR 0009). Chips are found by title, the trigger by its "+N more"
 * text — never by class or vendor `data-slot`.
 *
 * happy-dom has no layout, so the measured cap is mocked: the slot probe reports a 30px lane and
 * every element a 30px client height, which `measureCap` reads as exactly one lane.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TZDate } from "@date-fns/tz";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { EventCalendar } from "./event-calendar";
import { EventCalendarContent } from "./event-calendar-content";
import type { CalendarEvent } from "./event-calendar-types";

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

const TZ = "Australia/Sydney";
const wall = (y: number, m: number, d: number, h = 0, min = 0) => new TZDate(y, m - 1, d, h, min, 0, 0, TZ);

const realRect = Element.prototype.getBoundingClientRect;
const realClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight");
const realRO = globalThis.ResizeObserver;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  Element.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 100, 30);
  Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get: () => 30 });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Element.prototype.getBoundingClientRect = realRect;
  if (realClientHeight) Object.defineProperty(Element.prototype, "clientHeight", realClientHeight);
  globalThis.ResizeObserver = realRO;
});

const events: CalendarEvent[] = [
  { id: "bar", title: "Bar event", start: wall(2026, 9, 21), end: wall(2026, 9, 22), allDay: true },
  { id: "timed", title: "Timed event", start: wall(2026, 9, 22, 9), end: wall(2026, 9, 22, 10) },
];

function button(text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) => el.getAttribute("aria-hidden") !== "true" && el.textContent?.includes(text)
  );
}

async function press(key: string) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

describe("keyboard move that hides the moved bar (#614 PR B)", () => {
  it("lands focus on the destination day's +N more trigger, not <body>", async () => {
    await act(async () => {
      root.render(
        <EventCalendar defaultEvents={events} defaultView="month" defaultDate={wall(2026, 9, 21, 12)} timeZone={TZ} maxEventsPerCell="auto">
          <EventCalendarContent />
        </EventCalendar>
      );
      await Promise.resolve();
    });
    const bar = button("Bar event");
    expect(bar, "the bar is drawn on its own empty day").toBeDefined();
    act(() => bar!.focus());
    await press(" ");
    await press("ArrowRight"); // Mon 21 -> Tue 22, a day with a timed event
    await press("Enter");
    // let the bounded refocus wait run its frames
    await act(async () => {
      for (let i = 0; i < 15; i++) await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    expect(button("Bar event"), "the bar folded into +N more").toBeUndefined();
    const more = [...host.querySelectorAll<HTMLElement>("button")].find((el) => /\+\s*\d+\s*more|\d+\s*more/i.test(el.textContent ?? ""));
    expect(more).toBeDefined();
    expect(document.activeElement).toBe(more);
  });

  it("lands focus on a rendered covered day's +N more when the hidden bar starts before the grid (Sol r2)", async () => {
    // Sept 2026 grid: the bar (20 - 31 Aug) shows only on the leading days; extending its end
    // through 1 Sep adds a column that already holds a timed event, so the bar folds away.
    const spanning: CalendarEvent[] = [
      { id: "long", title: "Long bar", start: wall(2026, 8, 20), end: wall(2026, 9, 1), allDay: true, draggable: false, resizable: true },
      { id: "timed", title: "Timed event", start: wall(2026, 9, 1, 9), end: wall(2026, 9, 1, 10) },
    ];
    await act(async () => {
      root.render(
        <EventCalendar defaultEvents={spanning} defaultView="month" defaultDate={wall(2026, 9, 15, 12)} timeZone={TZ} maxEventsPerCell="auto">
          <EventCalendarContent />
        </EventCalendar>
      );
      await Promise.resolve();
    });
    const bar = button("Long bar");
    expect(bar, "the bar is drawn on the leading days of the grid").toBeDefined();
    act(() => bar!.focus());
    await press(" "); // not draggable, so the session opens on the end edge and the Sept grid stays
    await press("ArrowRight"); // end 1 Sep -> 2 Sep: now covers 1 Sep
    await press("Enter");
    await act(async () => {
      for (let i = 0; i < 15; i++) await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    expect(button("Long bar"), "the bar folded into +N more").toBeUndefined();
    // the adjusted edge (1 Sep, "+2 more": the bar and the timed event) - not the leading days
    const more = [...host.querySelectorAll<HTMLElement>("button")].find((el) => /2\s*more/i.test(el.textContent ?? ""));
    expect(more).toBeDefined();
    expect(document.activeElement).toBe(more);
  });
});
