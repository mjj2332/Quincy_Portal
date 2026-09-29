/**
 * #260 — the Calendar reports how many projects its range draws under its filters (the projects its
 * `projectBounds` name), so the Dashboard search chip can say "N shown" beside the search count.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECT_ID, rangeResponse, unscheduledProject } from "../testing/production-calendar-fixtures";
import { calendarState, createHarness, stubCalendarFetch, type Harness } from "../testing/production-event-calendar-harness";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));
vi.mock("./reui/event-calendar/event-calendar", async () => (await import("../testing/event-calendar-fake")).eventCalendarModule);
vi.mock("./reui/event-calendar/event-calendar-nav", async () => (await import("../testing/event-calendar-fake")).eventCalendarNavModule);
vi.mock("./reui/event-calendar/event-calendar-content", async () => (await import("../testing/event-calendar-fake")).eventCalendarContentModule);
vi.mock("./reui/event-calendar/event-calendar-dnd", async () => (await import("../testing/event-calendar-fake")).eventCalendarDndModule);

const bound = { projectId: PROJECT_ID, shootDate: null, createdAt: "2026-07-01T00:00:00.000Z", deadlineLocalCivil: null };

let h: Harness;
beforeEach(() => { h = createHarness(); });
afterEach(() => { h.teardown(); });

describe("ProductionEventCalendar shown-project count (#260)", () => {
  it("reports the projects the range references, and null on unmount", async () => {
    stubCalendarFetch({ range: rangeResponse({ unscheduled: [unscheduledProject()], projectBounds: [bound] }) });
    const shown = vi.fn<(count: number | null) => void>();
    await h.render(calendarState("month"), { onShownProjectsChange: shown });
    expect(shown).toHaveBeenLastCalledWith(1);
    await h.unmount();
    expect(shown).toHaveBeenLastCalledWith(null);
  });

  it("reports null when a truncated unscheduled list means the count is not known", async () => {
    stubCalendarFetch({ range: rangeResponse({ unscheduled: [unscheduledProject()], projectBounds: [bound], facets: { project: { matched: 5, returned: 1, truncated: true } } }) });
    const shown = vi.fn<(count: number | null) => void>();
    await h.render(calendarState("month"), { onShownProjectsChange: shown });
    expect(shown).not.toHaveBeenCalledWith(1);
    expect(shown).toHaveBeenLastCalledWith(null);
  });
});
