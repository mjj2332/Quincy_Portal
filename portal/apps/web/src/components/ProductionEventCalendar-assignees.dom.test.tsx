/**
 * #370 — a Subtask with several assignees is one Calendar event with an avatar stack, not one event per
 * person. Same harness and event-calendar fake as the chip suite.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEventDto, CalendarPerson } from "@quincy/shared";
import { dated, oneDayEvent, rangeResponse } from "../testing/production-calendar-fixtures";
import { calendarState, createHarness, stubCalendarFetch, type Harness } from "../testing/production-event-calendar-harness";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));
vi.mock("./reui/event-calendar/event-calendar", async () => (await import("../testing/event-calendar-fake")).eventCalendarModule);
vi.mock("./reui/event-calendar/event-calendar-nav", async () => (await import("../testing/event-calendar-fake")).eventCalendarNavModule);
vi.mock("./reui/event-calendar/event-calendar-content", async () => (await import("../testing/event-calendar-fake")).eventCalendarContentModule);

let seq = 0;
const person = (name: string): CalendarPerson => ({ id: `44444444-4444-4444-8444-${String(++seq).padStart(12, "0")}`, name, roleLabel: "Editor", isExternal: false, active: true });

let h: Harness;
beforeEach(() => { h = createHarness(); });
afterEach(() => { h.teardown(); });

async function mount(events: CalendarEventDto[], role: "admin" | "external_editor" = "admin") {
  stubCalendarFetch({ range: rangeResponse({ events, subview: "week", role }) });
  await h.render(calendarState("week"), { role });
}

const chips = () => [...h.host.querySelectorAll<HTMLElement>('[data-testid="event-calendar-chip"]')];
const avatars = (chip: HTMLElement) => [...chip.querySelectorAll<HTMLElement>('[role="img"]')];

describe("ProductionEventCalendar assignee stack", () => {
  it("draws one event for a four-person Subtask: two avatars and a +2", async () => {
    const event = oneDayEvent(dated("2026-08-12"), { assignees: ["Ada", "Bo", "Cy", "Di"].map(person) });
    await mount([event]);
    expect(chips()).toHaveLength(1);
    const labels = avatars(chips()[0]!).map((node) => node.getAttribute("aria-label"));
    expect(labels).toEqual(["Ada", "Bo", "2 more Assignees"]);
    expect(chips()[0]!.textContent).toContain("+2");
  });

  it("counts assignees an External Editor cannot see as +N", async () => {
    const admin = oneDayEvent(dated("2026-08-12"), { assignees: [person("Ada")], otherAssigneeCount: 2 });
    // The External wire uses the External stage vocabulary.
    const event = { ...admin, project: { ...admin.project, stageKey: "editing" } } as CalendarEventDto;
    await mount([event], "external_editor");
    expect(chips()).toHaveLength(1);
    expect(avatars(chips()[0]!).map((node) => node.getAttribute("aria-label"))).toEqual(["Ada", "2 others not shown"]);
    expect(chips()[0]!.textContent).toContain("+2 others");
  });

  it("draws no avatar, and no empty glyph, when nobody is assigned", async () => {
    await mount([oneDayEvent(dated("2026-08-12"), { assigneeNull: true })]);
    expect(chips()).toHaveLength(1);
    expect(avatars(chips()[0]!)).toHaveLength(0);
  });
  it("keeps every avatar's initials in the DOM and folds overflow and hidden people into one labelled count", async () => {
    // Density (2px overlap, 1px ring, 2xs text) is class-level and verified in the browser pass, not asserted here.
    const admin = oneDayEvent(dated("2026-08-12"), { assignees: ["Ada Lovelace", "Bo Peep", "Cy Twombly", "Di Prince"].map(person), otherAssigneeCount: 1 });
    const event = { ...admin, project: { ...admin.project, stageKey: "editing" } } as CalendarEventDto;
    await mount([event], "external_editor");
    const nodes = avatars(chips()[0]!);
    expect(nodes.map((node) => node.getAttribute("aria-label"))).toEqual(["Ada Lovelace", "Bo Peep", "2 more Assignees and 1 other not shown"]);
    expect(nodes[0]!.textContent).toBe("AL");
    expect(nodes[1]!.textContent).toBe("BP");
    expect(nodes[2]!.textContent).toBe("+3 others");
  });
});
