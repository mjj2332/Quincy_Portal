/**
 * #463 — the two additive consumer seams the Calendar's item menu needs, driven through the REAL
 * chip. Quincy-authored, not a ReUI vendored file (ADR 0009's precedent).
 *
 * - `onEventContextMenu(occurrence, e)`: a right-click on a chip tells the consumer. The vendor never
 *   prevents the native menu itself; that is the consumer's call. It stays quiet for an inert preview
 *   chip, during a live drag (a keyboard Adjust session is one) and right after a drag ended, and does
 *   nothing at all when the setting is unset.
 * - `eventPopup` (view config): a chip whose consumer opens a menu from it says so
 *   (`aria-haspopup="menu"`, `aria-expanded`) instead of announcing itself as a pressed toggle.
 *   Unset, the chip keeps `aria-pressed`.
 * - The Enter that commits a keyboard Adjust session fires no `onEventClick` (it is the consumer's
 *   menu-open path, so a commit must never open it).
 *
 * Seams: chips are found by their visible title, never by a vendor-authored `data-slot` (guard F).
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TZDate } from "@date-fns/tz";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { EventCalendar, EventCalendarViewContext } from "./event-calendar";
import { EventCalendarContent } from "./event-calendar-content";
import { EventCalendarEvent } from "./event-calendar-event";
import type { CalendarEvent, EventCalendarOccurrence, EventCalendarSegment } from "./event-calendar-types";

// happy-dom has no `Element#getAnimations`; base-ui's ScrollArea calls it on a timer.
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

const TZ = "Australia/Sydney";
const wall = (y: number, m: number, d: number, h = 0, min = 0) => new TZDate(y, m - 1, d, h, min, 0, 0, TZ);
const MONDAY_NOON = wall(2026, 9, 21, 12);
const shoot = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({ id: "shoot", title: "Shoot day", start: wall(2026, 9, 21, 9), end: wall(2026, 9, 21, 10), ...over });

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

async function mount(props: Record<string, unknown> = {}, events: CalendarEvent[] = [shoot()], view = "week") {
  await act(async () => {
    root.render(
      <EventCalendar defaultEvents={events} view={view as "week"} date={MONDAY_NOON} timeZone={TZ} {...props}>
        <EventCalendarContent />
      </EventCalendar>,
    );
    await Promise.resolve();
  });
}

function chip(title = "Shoot day"): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.getAttribute("aria-hidden") !== "true" && el.textContent?.includes(title));
  if (!found) throw new Error(`no chip titled "${title}"`);
  return found;
}

async function contextmenu(target: HTMLElement): Promise<MouseEvent> {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 12, clientY: 8 });
  await act(async () => { target.dispatchEvent(event); await Promise.resolve(); });
  return event;
}

async function press(key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

async function pointer(target: EventTarget, type: string, init: PointerEventInit) {
  await act(async () => { target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init })); await Promise.resolve(); });
}

describe("onEventContextMenu (#463)", () => {
  it("reports the right-clicked occurrence and leaves the native menu to the consumer", async () => {
    const onEventContextMenu = vi.fn();
    await mount({ onEventContextMenu });
    const event = await contextmenu(chip());
    expect(onEventContextMenu).toHaveBeenCalledTimes(1);
    const [occurrence, received] = onEventContextMenu.mock.calls[0] as [EventCalendarOccurrence, React.MouseEvent];
    expect(occurrence.event.id).toBe("shoot");
    expect(received.clientX).toBe(12);
    expect(event.defaultPrevented).toBe(false);
  });

  it("does nothing when the setting is unset", async () => {
    await mount();
    const event = await contextmenu(chip());
    expect(event.defaultPrevented).toBe(false);
  });

  it("reports from an agenda row too", async () => {
    const onEventContextMenu = vi.fn();
    await mount({ onEventContextMenu }, [shoot()], "agenda");
    await contextmenu(chip());
    expect(onEventContextMenu).toHaveBeenCalledTimes(1);
  });

  it("does not report during a live keyboard Adjust session", async () => {
    const onEventContextMenu = vi.fn();
    await mount({ onEventContextMenu });
    act(() => chip().focus());
    await press(" ");
    expect(chip().getAttribute("data-adjusting")).toBe("true");
    await contextmenu(chip());
    expect(onEventContextMenu).not.toHaveBeenCalled();
  });

  it("does not report right after a refused drag ended", async () => {
    const onEventContextMenu = vi.fn();
    await mount({ onEventContextMenu }, [shoot({ readOnly: true })]);
    const target = chip();
    await pointer(target, "pointerdown", { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    await pointer(window, "pointermove", { pointerId: 1, clientX: 60, clientY: 80 });
    await pointer(window, "pointerup", { pointerId: 1, clientX: 60, clientY: 80 });
    await contextmenu(target);
    expect(onEventContextMenu).not.toHaveBeenCalled();
  });

  it("does not report on an inert preview chip", async () => {
    const onEventContextMenu = vi.fn();
    const event = shoot();
    const occurrence: EventCalendarOccurrence = { key: `${event.id}::${event.start.toISOString()}`, eventId: event.id, event, start: event.start, end: event.end, allDay: false, isRecurring: false };
    const segment: EventCalendarSegment = { occurrence, day: wall(2026, 9, 21), isStart: true, isEnd: true, continuesBefore: false, continuesAfter: false, startMin: 9 * 60, endMin: 10 * 60 };
    await act(async () => {
      root.render(
        <EventCalendar events={[event]} timeZone={TZ} onEventContextMenu={onEventContextMenu}>
          <EventCalendarViewContext.Provider value={{ view: "week" }}>
            <EventCalendarEvent segment={segment} preview />
          </EventCalendarViewContext.Provider>
        </EventCalendar>,
      );
      await Promise.resolve();
    });
    const preview = host.querySelector<HTMLButtonElement>("button");
    expect(preview).not.toBeNull();
    await contextmenu(preview!);
    expect(onEventContextMenu).not.toHaveBeenCalled();
  });
});

describe("eventPopup (#463)", () => {
  it("swaps the pressed toggle for a menu popup state that follows the consumer's open item", async () => {
    let open = false;
    const eventPopup = { isOpen: () => open };
    await mount({ eventPopup });
    expect(chip().getAttribute("aria-haspopup")).toBe("menu");
    expect(chip().getAttribute("aria-expanded")).toBe("false");
    expect(chip().hasAttribute("aria-pressed")).toBe(false);
    open = true;
    await mount({ eventPopup: { isOpen: () => open } });
    expect(chip().getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the pressed toggle when the setting is unset", async () => {
    await mount();
    expect(chip().getAttribute("aria-pressed")).toBe("false");
    expect(chip().hasAttribute("aria-haspopup")).toBe(false);
    expect(chip().hasAttribute("aria-expanded")).toBe(false);
  });

  it("exposes no popup on an agenda row when the setting is unset", async () => {
    await mount({}, [shoot()], "agenda");
    expect(chip().hasAttribute("aria-haspopup")).toBe(false);
  });
});

describe("selection (#463)", () => {
  // The Production Calendar opts out of the vendor's selection now (its click opens a menu), so this
  // vendor rule — the agenda is read-only and never draws a row selected — lost its only surface-level pin.
  it("a chip selected in a grid view is not drawn selected once the view switches to the read-only agenda", async () => {
    // The vendor ignores a click within 250ms of a drag ending (a module flag an earlier test here sets).
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    await mount();
    await act(async () => { chip().click(); await Promise.resolve(); });
    expect(chip().hasAttribute("data-selected"), "the grid click did not select the chip").toBe(true);
    await mount({}, [shoot()], "agenda");
    expect(chip().hasAttribute("data-selected"), "an agenda row carries data-selected").toBe(false);
  });
});

describe("the Adjust commit (#463)", () => {
  it("an Enter that commits a keyboard Adjust session fires no onEventClick", async () => {
    const onEventClick = vi.fn();
    const onEventUpdate = vi.fn();
    await mount({ onEventClick, onEventUpdate });
    act(() => chip().focus());
    await press(" ");
    await press("ArrowDown");
    await press("Enter");
    expect(onEventUpdate).toHaveBeenCalledTimes(1);
    // A real browser clicks a focused <button> on Enter's keydown default; the commit prevents it.
    expect(onEventClick).not.toHaveBeenCalled();
  });
});
