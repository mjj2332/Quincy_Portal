/**
 * #222 step 9 — ported from `ProductionCalendar-unmount.dom.test.tsx` (#152). A route change
 * mid-drop must release the parent's accept gate and withdraw the confirmation this interaction
 * opened. The event-calendar renderer's confirmation is the port-owned
 * `ProductionGanttDeadlineDialog`, so "withdrawn" means the controller's `signal` aborted it and it
 * left the DOM — and the global `confirmStore` was never used.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmStore } from "../lib/confirm";
import { deadlineEvent, instantOf, PROJECT_ID, rangeResponse } from "../testing/production-calendar-fixtures";
import { calendarState, createHarness, flush, proposeUpdate, stubCalendarFetch, type Harness } from "../testing/production-event-calendar-harness";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));
vi.mock("./reui/event-calendar/event-calendar", async () => (await import("../testing/event-calendar-fake")).eventCalendarModule);
vi.mock("./reui/event-calendar/event-calendar-nav", async () => (await import("../testing/event-calendar-fake")).eventCalendarNavModule);
vi.mock("./reui/event-calendar/event-calendar-content", async () => (await import("../testing/event-calendar-fake")).eventCalendarContentModule);
vi.mock("./reui/event-calendar/event-calendar-dnd", async () => (await import("../testing/event-calendar-fake")).eventCalendarDndModule);

const ID = `project-deadline:${PROJECT_ID}`;

let h: Harness;
beforeEach(() => {
  h = createHarness();
  stubCalendarFetch({ range: rangeResponse({ events: [deadlineEvent("2026-08-12T09:00", { version: 3, offsets: [1440, 60] })] }), put: () => new Promise<Response>(() => undefined) });
});
afterEach(() => { h.teardown(); });

describe("ProductionEventCalendar releases its parent's gate and its own confirm on unmount (#152)", () => {
  it("unmounting mid-drop, with the confirm open, releases the gate and withdraws the confirm", async () => {
    const gate: boolean[] = [];
    await h.render(calendarState(), { onAcceptGateChange: (blocked) => gate.push(blocked) });
    await proposeUpdate(ID, { start: new Date(instantOf("2026-08-20T09:00")), allDay: false, granularity: "day" });
    expect(gate.at(-1)).toBe(true);
    expect(document.querySelector('[data-testid="gantt-deadline-confirm"]')).not.toBeNull();

    await h.unmount();
    await flush(5);

    expect(gate.at(-1)).toBe(false);
    expect(document.querySelector('[data-testid="gantt-deadline-confirm"]')).toBeNull();
    expect(confirmStore.getSnapshot()).toBeNull();
  });

  it("unmounting while idle adds no gate call beyond the pre-existing cleanup", async () => {
    const gate: boolean[] = [];
    await h.render(calendarState(), { onAcceptGateChange: (blocked) => gate.push(blocked) });
    const before = gate.length;
    expect(gate.at(-1) ?? false).toBe(false);
    await h.unmount();
    expect(gate.length).toBe(before);
  });
});
