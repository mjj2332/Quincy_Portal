/**
 * #222 step 9 — event chips, ported from `ProductionCalendarEvent.dom.test.tsx` (4). The vendor chip
 * is itself a focusable `<button>`, so the chip content carries no nested control: no project
 * anchor, no Reschedule button. A chip click selects the event; the selection strip carries the
 * project anchor (when the Dashboard supplies `projectHrefFor`) and the Reschedule… action.
 *
 * Not ported: the drag-ending-click suppression thresholds (FullCalendar's 5px
 * `eventDragMinDistance`) — the vendor owns click-vs-drag on its own chip, and the strip's anchor is
 * never a drag source.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEventDto, ChecklistCalendarEventDto } from "@quincy/shared";
import { eventCalendarFake } from "../testing/event-calendar-fake";
import { dated, deadlineEvent, dueEvent, PROJECT_ID, PROJECT_STREET, rangeResponse } from "../testing/production-calendar-fixtures";
import { calendarState, createHarness, stubCalendarFetch, type Harness } from "../testing/production-event-calendar-harness";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));
vi.mock("./reui/event-calendar/event-calendar", async () => (await import("../testing/event-calendar-fake")).eventCalendarModule);
vi.mock("./reui/event-calendar/event-calendar-nav", async () => (await import("../testing/event-calendar-fake")).eventCalendarNavModule);
vi.mock("./reui/event-calendar/event-calendar-content", async () => (await import("../testing/event-calendar-fake")).eventCalendarContentModule);
vi.mock("./reui/event-calendar/event-calendar-dnd", async () => (await import("../testing/event-calendar-fake")).eventCalendarDndModule);

const DEADLINE_ID = `project-deadline:${PROJECT_ID}`;
const overlapping = (value: boolean): ChecklistCalendarEventDto => {
  const event = dueEvent(dated("2026-08-12"));
  return { ...event, status: { ...event.status, sameAssigneeOverlap: value } } as ChecklistCalendarEventDto;
};

let h: Harness;
beforeEach(() => { h = createHarness(); });
afterEach(() => { h.teardown(); });

async function mount(events: CalendarEventDto[], props: { projectHrefFor?: (id: string) => string | undefined; onOpenProject?: (id: string) => void } = {}) {
  stubCalendarFetch({ range: rangeResponse({ events, subview: "week" }) });
  await h.render(calendarState("week"), props);
}

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

  it("keeps the chip action-free: Reschedule… lives in the selection strip, after a click", async () => {
    const event = overlapping(false);
    await mount([event]);
    expect(chip(event.id).querySelector("a, button")).toBeNull();
    expect(h.host.querySelector(`[data-focus-key="calendar-move:${event.id}"]`)).toBeNull();
    await act(async () => { chip(event.id).click(); await Promise.resolve(); });
    const action = h.host.querySelector<HTMLButtonElement>(`[data-focus-key="calendar-move:${event.id}"]`);
    expect(action?.textContent).toMatch(/…$/);
    expect(h.host.querySelector('[data-testid="event-calendar-selected"]')?.textContent).toContain(PROJECT_STREET);
    await act(async () => { h.host.querySelector<HTMLButtonElement>('[data-testid="event-calendar-selected-clear"]')!.click(); await Promise.resolve(); });
    expect(h.host.querySelector('[data-testid="event-calendar-selected"]')).toBeNull();
  });

  it("opens the project from the selection strip's anchor for a primary click and Enter", async () => {
    const onOpenProject = vi.fn();
    await mount([deadlineEvent("2026-08-12T10:00")], { projectHrefFor: (id) => `/projects/${id}`, onOpenProject });
    expect(chip(DEADLINE_ID).querySelector("a")).toBeNull();
    await act(async () => { eventCalendarFake.click(DEADLINE_ID); await Promise.resolve(); });
    const anchor = h.host.querySelector<HTMLAnchorElement>('[data-testid="event-calendar-selected"] a');
    expect(anchor?.textContent).toBe(PROJECT_STREET);
    await act(async () => { anchor!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 })); await Promise.resolve(); });
    expect(onOpenProject).toHaveBeenCalledWith(PROJECT_ID);
    await act(async () => { anchor!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await Promise.resolve(); });
    expect(onOpenProject).toHaveBeenCalledTimes(2);
  });

  it("shows the overlap copy visibly in the selection strip", async () => {
    const event = overlapping(true);
    await mount([event]);
    await act(async () => { eventCalendarFake.click(event.id); await Promise.resolve(); });
    expect(h.host.querySelector('[data-testid="event-calendar-selected"]')?.textContent).toContain("Overlaps another task");
  });
});
