/**
 * #222 step 9 — event chips, ported from `ProductionCalendarEvent.dom.test.tsx` (4). The vendor chip
 * is itself a focusable `<button>`, so the chip content carries no nested control: no project
 * anchor, no Reschedule button. A chip click opens the item menu (#463), which carries Open project
 * (when the Dashboard supplies a way to open one) and the Reschedule… / Edit schedule… action.
 *
 * Not ported: the drag-ending-click suppression thresholds (FullCalendar's 5px
 * `eventDragMinDistance`) — the vendor owns click-vs-drag on its own chip, and the menu is
 * never opened by a drag.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEventDto, ChecklistCalendarEventDto } from "@quincy/shared";
import { eventCalendarFake } from "../testing/event-calendar-fake";
import { dated, deadlineEvent, oneDayEvent, PROJECT_ID, PROJECT_STREET, rangeResponse } from "../testing/production-calendar-fixtures";
import { calendarState, createHarness, flush, stubCalendarFetch, type Harness } from "../testing/production-event-calendar-harness";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));
vi.mock("./reui/event-calendar/event-calendar", async () => (await import("../testing/event-calendar-fake")).eventCalendarModule);
vi.mock("./reui/event-calendar/event-calendar-nav", async () => (await import("../testing/event-calendar-fake")).eventCalendarNavModule);
vi.mock("./reui/event-calendar/event-calendar-content", async () => (await import("../testing/event-calendar-fake")).eventCalendarContentModule);

const DEADLINE_ID = `project-deadline:${PROJECT_ID}`;
const overlapping = (value: boolean): ChecklistCalendarEventDto => {
  const event = oneDayEvent(dated("2026-08-12"));
  return { ...event, status: { ...event.status, sameAssigneeOverlap: value } } as ChecklistCalendarEventDto;
};

let h: Harness;
beforeEach(() => { h = createHarness(); });
afterEach(() => { h.teardown(); });

async function mount(events: CalendarEventDto[], props: { projectHrefFor?: (id: string) => string | undefined; onOpenProject?: (id: string) => void } = {}) {
  stubCalendarFetch({ range: rangeResponse({ events, subview: "week" }) });
  await h.render(calendarState("week"), props);
}

const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const menuLabels = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((node) => node.textContent);
const menuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent === label) ?? null;

function chip(id: string): HTMLElement {
  const element = h.host.querySelector<HTMLElement>(`[data-event-id="${id}"]`)?.closest<HTMLElement>("button") ?? null;
  if (!element) throw new Error(`no chip ${id}`);
  return element;
}

describe("ProductionEventCalendar chips", () => {
  it("carries overlap copy only for an overlapping checklist event", async () => {
    await mount([overlapping(true)]);
    expect(chip(overlapping(true).id).textContent).toContain("Overlaps another task");
    h.teardown();
    h = createHarness();
    await mount([overlapping(false)]);
    expect(chip(overlapping(false).id).textContent).not.toContain("Overlaps another task");
  });

  it("does not expose overlap copy, an anchor or a nested control on a project Deadline chip", async () => {
    const deadline = { ...deadlineEvent("2026-08-12T10:00"), status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false } } as CalendarEventDto;
    await mount([deadline]);
    const element = chip(DEADLINE_ID);
    expect(element.textContent).toContain(PROJECT_STREET);
    expect(element.textContent).not.toContain("Overlaps another task");
    expect(element.querySelector("a, button")).toBeNull();
  });

  it("keeps the chip action-free: Reschedule… and Edit schedule… live in its item menu, after a click", async () => {
    const event = overlapping(false);
    await mount([event]);
    expect(chip(event.id).querySelector("a, button")).toBeNull();
    expect(menu()).toBeNull();
    await act(async () => { chip(event.id).click(); await Promise.resolve(); await Promise.resolve(); });
    await flush(30);
    expect(menuLabels()).toContain("Edit schedule…");
    expect(h.host.querySelector('[data-testid="event-calendar-selected"]')).toBeNull();
  });

  it("opens the project from the item menu's Open project row", async () => {
    const onOpenProject = vi.fn();
    await mount([deadlineEvent("2026-08-12T10:00")], { projectHrefFor: (id) => `/projects/${id}`, onOpenProject });
    expect(chip(DEADLINE_ID).querySelector("a")).toBeNull();
    await act(async () => { eventCalendarFake.click(DEADLINE_ID); await Promise.resolve(); await Promise.resolve(); });
    await flush(30);
    await act(async () => { menuItem("Open project")!.click(); await Promise.resolve(); await Promise.resolve(); });
    await flush(60);
    expect(onOpenProject).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("shows the overlap copy in the item menu", async () => {
    const event = overlapping(true);
    await mount([event]);
    await act(async () => { eventCalendarFake.click(event.id); await Promise.resolve(); await Promise.resolve(); });
    await flush(30);
    expect(menu()?.textContent).toContain("Overlaps another task");
  });
});
