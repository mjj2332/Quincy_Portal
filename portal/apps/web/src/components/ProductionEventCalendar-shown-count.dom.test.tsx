/**
 * #260 — the Calendar reports how many projects its range draws under its filters (the projects its
 * `projectBounds` name — those its events reference; the Unscheduled list is gone, ADR 0011), so the Dashboard search chip can say "N shown" beside the search count.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECT_ID, rangeResponse } from "../testing/production-calendar-fixtures";
import { calendarState, createHarness, stubCalendarFetch, type Harness } from "../testing/production-event-calendar-harness";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));
vi.mock("./reui/event-calendar/event-calendar", async () => (await import("../testing/event-calendar-fake")).eventCalendarModule);
vi.mock("./reui/event-calendar/event-calendar-nav", async () => (await import("../testing/event-calendar-fake")).eventCalendarNavModule);
vi.mock("./reui/event-calendar/event-calendar-content", async () => (await import("../testing/event-calendar-fake")).eventCalendarContentModule);

const bound = { projectId: PROJECT_ID, shootDate: null, createdAt: "2026-07-01T00:00:00.000Z", deadlineLocalCivil: null, deadlineFold: null };

let h: Harness;
beforeEach(() => { h = createHarness(); });
afterEach(() => { h.teardown(); });

describe("ProductionEventCalendar shown-project count (#260)", () => {
  it("reports the projects the range references, and null on unmount", async () => {
    stubCalendarFetch({ range: rangeResponse({ projectBounds: [bound] }) });
    const shown = vi.fn<(count: number | null) => void>();
    await h.render(calendarState("month"), { onShownProjectsChange: shown });
    expect(shown).toHaveBeenLastCalledWith(1);
    await h.unmount();
    expect(shown).toHaveBeenLastCalledWith(null);
  });

  it("reports null while the response carries no projectBounds (the count is not known)", async () => {
    stubCalendarFetch({ range: rangeResponse() });
    const shown = vi.fn<(count: number | null) => void>();
    await h.render(calendarState("month"), { onShownProjectsChange: shown });
    expect(shown).not.toHaveBeenCalledWith(1);
    expect(shown).toHaveBeenLastCalledWith(null);
  });

  it("counts only the projects the range's events name: a deadline-less Project with nothing in range is not drawn (ADR 0011)", async () => {
    stubCalendarFetch({ range: rangeResponse({ projectBounds: [] }) });
    const shown = vi.fn<(count: number | null) => void>();
    await h.render(calendarState("month"), { onShownProjectsChange: shown });
    expect(shown).toHaveBeenLastCalledWith(0);
  });
});
