/**
 * #240 — the keyboard Adjust session, driven through the REAL views. Quincy-authored, not a ReUI
 * vendored file (ADR 0009). The pure movement model has its own file
 * (`event-calendar-keyboard.test.ts`); this one pins what only a mounted calendar can show: that
 * Space on a focused chip opens a session, that the session previews through the SAME
 * `state.drag` the pointer path does (so every view's ghost is reused, not rebuilt), that Enter
 * commits through the one `onEventUpdate` funnel with `source: "keyboard"`, that the view follows
 * a move out of range and comes back on Escape, and that the live region says what happened.
 *
 * Seams: chips are found by their visible title, the live region by `aria-live` — never by a
 * vendor-authored `data-slot` (guard F, issue #92).
 */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TZDate } from "@date-fns/tz";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { EventCalendar, useEventCalendar, type EventCalendarInstance } from "./event-calendar";
import { EventCalendarContent } from "./event-calendar-content";
import type { CalendarEvent, CalendarView, EventCalendarProposedUpdate } from "./event-calendar-types";

// happy-dom has no `Element#getAnimations`; base-ui's ScrollArea calls it on a timer.
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

const TZ = "Australia/Sydney";
const wall = (y: number, m: number, d: number, h = 0, min = 0) => new TZDate(y, m - 1, d, h, min, 0, 0, TZ);
const utc = (d: Date) => new Date(d.getTime()).toISOString();

// Week of Sun 2026-09-20 .. Sat 2026-09-26, an ordinary week.
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

interface Options {
  view?: CalendarView;
  date?: Date;
  events?: CalendarEvent[];
  onEventUpdate?: (update: EventCalendarProposedUpdate) => boolean | void;
  canDropEvent?: (update: EventCalendarProposedUpdate) => boolean;
  resources?: { id: string; title: string }[];
  maxEventsPerCell?: number;
}

async function mount({ view = "week", date = MONDAY_NOON, events = [shoot()], ...rest }: Options = {}) {
  await act(async () => {
    root.render(
      <EventCalendar defaultEvents={events} defaultView={view} defaultDate={date} timeZone={TZ} {...rest}>
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

/** Keys go to whatever holds focus — after the view follows, that may no longer be the chip. */
async function press(key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

async function enterAdjust(title: string) {
  act(() => chip(title).focus());
  await press(" ");
}

const drag = () => instance!.getState().drag;
const announced = () => host.querySelector('[aria-live="polite"]')?.textContent ?? "";

describe("keyboard Adjust session (#240)", () => {
  it("Space on a focused chip opens a session that previews through state.drag", async () => {
    await mount();
    expect(drag()).toBeNull();
    await enterAdjust("Shoot day");
    expect(drag()).toMatchObject({ kind: "move", valid: true, proposedDayGranular: false });
    expect(utc(drag()!.proposedStart)).toBe("2026-09-20T23:00:00.000Z");
    expect(announced()).toContain("Shoot day");
  });

  it("ArrowDown steps one snap and Enter commits through onEventUpdate as source: keyboard", async () => {
    const onEventUpdate = vi.fn();
    await mount({ onEventUpdate });
    await enterAdjust("Shoot day");
    await press("ArrowDown");
    expect(utc(drag()!.proposedStart)).toBe("2026-09-20T23:15:00.000Z"); // 09:15
    expect(onEventUpdate).not.toHaveBeenCalled();

    await press("Enter");
    expect(drag()).toBeNull();
    expect(onEventUpdate).toHaveBeenCalledTimes(1);
    const update = onEventUpdate.mock.calls[0]![0] as EventCalendarProposedUpdate;
    expect(update.source).toBe("keyboard");
    expect(utc(update.start)).toBe("2026-09-20T23:15:00.000Z");
    expect(utc(update.end)).toBe("2026-09-21T00:15:00.000Z");
    expect(utc(instance!.api.getEvent("shoot")!.start)).toBe("2026-09-20T23:15:00.000Z");
  });

  it("holding Space down does not enter Adjust and then commit it in the same breath", async () => {
    await mount();
    await enterAdjust("Shoot day");
    await press(" ", { repeat: true });
    await press(" ", { repeat: true });
    expect(drag()).not.toBeNull();
    expect(announced()).toMatch(/adjusting/i);
  });

  it("returns focus to the event's chip after a commit re-renders it somewhere else", async () => {
    await mount();
    await enterAdjust("Shoot day");
    await press("ArrowRight"); // Monday -> Tuesday: a different column, so a different element
    await press("Enter");
    expect(document.activeElement).toBe(chip("Shoot day"));
  });

  it("Escape cancels: nothing is committed, the preview clears, and it says so", async () => {
    const onEventUpdate = vi.fn();
    await mount({ onEventUpdate });
    await enterAdjust("Shoot day");
    await press("ArrowDown");
    await press("Escape");
    expect(drag()).toBeNull();
    expect(onEventUpdate).not.toHaveBeenCalled();
    expect(utc(instance!.api.getEvent("shoot")!.start)).toBe("2026-09-20T23:00:00.000Z");
    expect(announced()).toMatch(/cancel/i);
    expect(document.activeElement).toBe(chip("Shoot day"));
  });

  it("the view follows a move out of the visible range, and Escape brings it back", async () => {
    // Sat 2026-09-26 is the week's last column; one step right is Sun 2026-09-27, next week.
    await mount({ events: [shoot({ start: wall(2026, 9, 26, 9), end: wall(2026, 9, 26, 10) })] });
    const before = instance!.getState().visibleRange.start.getTime();
    await enterAdjust("Shoot day");
    await press("ArrowRight");
    expect(utc(drag()!.proposedStart)).toBe("2026-09-26T23:00:00.000Z"); // Sun 27th 09:00 +10
    expect(instance!.getState().visibleRange.start.getTime()).toBeGreaterThan(before);
    // the step that turned the page says so, and names the range now on screen
    expect(announced()).toMatch(/Sunday, September 27th.*Now showing Sep 27 - Oct 3, 2026/);

    // a step that stays on the page does not repeat it
    await press("ArrowRight");
    expect(announced()).not.toMatch(/showing/i);

    await press("Escape");
    expect(instance!.getState().visibleRange.start.getTime()).toBe(before);
    expect(drag()).toBeNull();
  });

  it("Escape after a followed view refocuses the chip even when its week paints a frame late", async () => {
    // Measured in the harness (Chromium, 3 runs): the origin week's chip is back in the DOM
    // 24-33 ms after the cancel — more than one 16.7 ms frame — so a single-frame refocus can
    // find no chip and leave focus on <body>.
    await mount({ events: [shoot({ start: wall(2026, 9, 26, 9), end: wall(2026, 9, 26, 10) })] });
    await enterAdjust("Shoot day");
    await press("ArrowRight");
    expect(document.activeElement).toBe(document.body);

    const realRaf = globalThis.requestAnimationFrame;
    let early = true;
    // the first frame after the cancel runs BEFORE React has put the origin week back
    globalThis.requestAnimationFrame = (cb) => {
      if (!early) return realRaf(cb);
      early = false;
      cb(0);
      return 0;
    };
    try {
      await press("Escape");
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await new Promise((resolve) => realRaf(() => resolve(null)));
        });
      }
    } finally {
      globalThis.requestAnimationFrame = realRaf;
    }
    expect(document.activeElement).toBe(chip("Shoot day"));
  });

  it("month view: ArrowDown is a week, and the preview is day-granular", async () => {
    await mount({ view: "month" });
    await enterAdjust("Shoot day");
    await press("ArrowDown");
    expect(drag()).toMatchObject({ kind: "move", proposedDayGranular: true });
    expect(utc(drag()!.proposedStart)).toBe("2026-09-27T23:00:00.000Z"); // Mon 28th 09:00 +10
  });

  it("resource view: ArrowRight proposes the neighbouring resource, not another day", async () => {
    await mount({
      view: "resource",
      resources: [
        { id: "cam-a", title: "Camera A" },
        { id: "cam-b", title: "Camera B" },
      ],
      events: [shoot({ resourceId: "cam-a" })],
    });
    await enterAdjust("Shoot day");
    await press("ArrowRight");
    expect(drag()!.proposedResourceId).toBe("cam-b");
    expect(utc(drag()!.proposedStart)).toBe("2026-09-20T23:00:00.000Z");
    expect(announced()).toContain("Camera B");
  });

  it("a read-only event never opens a session", async () => {
    await mount({ events: [shoot({ readOnly: true })] });
    await enterAdjust("Shoot day");
    expect(drag()).toBeNull();
  });

  it("the agenda opts out: its rows are read-only by design", async () => {
    await mount({ view: "agenda" });
    await enterAdjust("Shoot day");
    expect(drag()).toBeNull();
  });

  it("S on an event whose start edge is locked is refused and announced; the target stays", async () => {
    await mount({ events: [shoot({ resizableEdges: { start: false } })] });
    await enterAdjust("Shoot day");
    const before = announced();
    await press("s");
    expect(drag()!.kind).toBe("move");
    expect(announced()).not.toBe(before);
    await press("e");
    expect(drag()!.kind).toBe("resize-end");
  });

  it("a key that means nothing here is refused aloud, and the preview does not move", async () => {
    await mount();
    await enterAdjust("Shoot day");
    await press("e");
    const before = announced();
    await press("ArrowRight"); // an edge resizes vertically only in a time grid
    expect(utc(drag()!.proposedEnd)).toBe("2026-09-21T00:00:00.000Z");
    expect(announced()).not.toBe(before);
  });

  it("Enter on a proposal canDropEvent rejects does not commit and does not end the session", async () => {
    const onEventUpdate = vi.fn();
    await mount({ onEventUpdate, canDropEvent: (u) => u.start.getTime() === wall(2026, 9, 21, 9).getTime() });
    await enterAdjust("Shoot day");
    await press("ArrowDown");
    expect(drag()!.valid).toBe(false);
    await press("Enter");
    expect(onEventUpdate).not.toHaveBeenCalled();
    expect(drag()).not.toBeNull();
  });

  it("a session dies with its event", async () => {
    await mount();
    await enterAdjust("Shoot day");
    await act(async () => instance!.api.removeEvent("shoot"));
    expect(drag()).toBeNull();
  });

  it("the move preview shows the event itself: a keyboard move has no cursor-following carry", async () => {
    // The pointer path draws an EMPTY dashed placeholder for a move, because a clone of the chip
    // travels with the cursor. There is no cursor here, so the placeholder must carry the content.
    await mount();
    const previews = () =>
      [...host.querySelectorAll('button[aria-hidden="true"]')].filter((el) => el.textContent?.includes("Shoot day"));
    expect(previews()).toHaveLength(0);
    await enterAdjust("Shoot day");
    expect(previews()).toHaveLength(1);
  });

  it("a session dies with its calendar: no listener is left to commit a stale proposal", async () => {
    const onEventUpdate = vi.fn();
    await mount({ onEventUpdate });
    await enterAdjust("Shoot day");
    await press("ArrowDown");
    act(() => root.unmount());
    root = createRoot(host);
    await press("Enter");
    expect(onEventUpdate).not.toHaveBeenCalled();
  });

  describe("inside the month view's +N more popover", () => {
    // The popover is portalled out of the calendar's root, so its chips are found document-wide.
    const anywhere = (title: string) => {
      const found = [...document.querySelectorAll<HTMLButtonElement>("button")].filter(
        (el) => el.getAttribute("aria-hidden") !== "true" && el.textContent?.includes(title)
      );
      return found[found.length - 1];
    };
    const moreTrigger = () =>
      [...host.querySelectorAll<HTMLButtonElement>("button")].find((el) => /more/i.test(el.textContent ?? ""))!;

    async function openOverflow() {
      await mount({
        view: "month",
        maxEventsPerCell: 1,
        events: [
          shoot(),
          shoot({ id: "second", title: "Second unit", start: wall(2026, 9, 21, 11), end: wall(2026, 9, 21, 12) }),
        ],
      });
      await act(async () => {
        moreTrigger().click();
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      });
      act(() => anywhere("Second unit")!.focus());
      await press(" ");
    }

    it("a keyboard session keeps the popover open: its chip is the thing being adjusted", async () => {
      await openOverflow();
      expect(drag()).not.toBeNull();
      expect(anywhere("Second unit")?.isConnected).toBe(true);
      expect(moreTrigger().getAttribute("aria-expanded")).toBe("true");
    });

    it("Escape cancels the session first and leaves the popover, focus back on its chip", async () => {
      await openOverflow();
      await press("ArrowRight");
      await press("Escape");
      expect(drag()).toBeNull();
      expect(moreTrigger().getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(anywhere("Second unit"));
    });

    it("after a commit moves the event out of the list, focus follows the event, as everywhere", async () => {
      await openOverflow();
      await press("ArrowRight");
      await press("Enter");
      expect(utc(instance!.api.getEvent("second")!.start)).toBe("2026-09-22T01:00:00.000Z");
      expect(document.activeElement?.textContent).toContain("Second unit");
      expect(document.activeElement?.isConnected).toBe(true);
    });
  });

  it("names the pass when a step lands in the repeated hour's second pass", async () => {
    // Sun 2026-04-05, first-pass 02:45-03:00 (+11:00). One step down is the SECOND 02:00.
    await mount({
      date: wall(2026, 4, 5, 12),
      events: [shoot({ start: new Date("2026-04-04T15:45:00.000Z"), end: new Date("2026-04-04T16:00:00.000Z") })],
    });
    await enterAdjust("Shoot day");
    const firstPass = announced();
    await press("ArrowDown");
    expect(utc(drag()!.proposedStart)).toBe("2026-04-04T16:00:00.000Z");
    expect(announced()).toMatch(/AM, second pass/i);
    // Its exclusive end IS the second 02:00, so only the end is named — never the start.
    expect(firstPass).toMatch(/2:45 AM - 2:00 AM, ends in the second pass/i);
    expect(firstPass).not.toMatch(/AM, second pass/i);
  });

  it("says which end is in the second pass when a range straddles both passes", async () => {
    // First-pass 02:45 (+11:00) to second-pass 02:15 (+10:00): the clock alone reads
    // "2:45 AM - 2:15 AM", an end before its start.
    await mount({
      date: wall(2026, 4, 5, 12),
      events: [shoot({ start: new Date("2026-04-04T15:45:00.000Z"), end: new Date("2026-04-04T16:15:00.000Z") })],
    });
    await enterAdjust("Shoot day");
    expect(announced()).toMatch(/ends in the second pass/i);
    // Once the start crosses too, the whole range is in the second pass — one label, not two.
    await press("ArrowDown");
    expect(announced()).toMatch(/second pass of the repeated hour/i);
    expect(announced()).not.toMatch(/ends in/i);
  });
});
