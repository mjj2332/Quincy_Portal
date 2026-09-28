/**
 * #222 step 9 — the coarse-phone gate, ported from `ProductionCalendar-phone.dom.test.tsx` (4) and
 * extended from Week to the new time-grid views, Day and 3-day. A coarse pointer at ≤720px turns
 * pointer drag and resize (and so keyboard Adjust) OFF in week / day / days; the unscheduled rows
 * fall back to their Schedule actions; Reschedule… stays. A phone is also below the rail
 * breakpoint, so the rail (and its unscheduled list) sits in the sheet.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_CALENDAR_ZONE, type ChecklistCalendarEventDto, type ChecklistCalendarUnscheduledEntryDto, type ProjectCalendarUnscheduledEntryDto } from "@quincy/shared";
import { eventCalendarFake } from "../testing/event-calendar-fake";
import { ASSIGNEE, checklistMutationBody, deadlineEvent, dueSchedule, instantOf, PROJECT_ID, rangeResponse, timed, dueEvent } from "../testing/production-calendar-fixtures";
import {
  calendarState,
  clickTestId,
  createHarness,
  flush,
  json,
  liveRegion,
  openReschedule,
  proposeUpdate,
  stubCalendarFetch,
  stubMedia,
  type Harness,
} from "../testing/production-event-calendar-harness";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));
vi.mock("./reui/event-calendar/event-calendar", async () => (await import("../testing/event-calendar-fake")).eventCalendarModule);
vi.mock("./reui/event-calendar/event-calendar-nav", async () => (await import("../testing/event-calendar-fake")).eventCalendarNavModule);
vi.mock("./reui/event-calendar/event-calendar-content", async () => (await import("../testing/event-calendar-fake")).eventCalendarContentModule);
vi.mock("./reui/event-calendar/event-calendar-dnd", async () => (await import("../testing/event-calendar-fake")).eventCalendarDndModule);

const PHONE = ["(pointer: coarse)", "(max-width: 720px)", "(max-width: 1100px)"];
const DEADLINE_ID = `project-deadline:${PROJECT_ID}`;
const TIME_GRID = ["week", "day", "days"] as const;

const overlappingDue = (): ChecklistCalendarEventDto => {
  const event = dueEvent(timed("2026-08-12T10:00"));
  return { ...event, status: { ...event.status, sameAssigneeOverlap: true } } as ChecklistCalendarEventDto;
};
const project = { id: PROJECT_ID, street: "12 Harbour Street", stageKey: "editing_autohdr" as const, checklist: { completed: 1, total: 2 }, delivered: false };
const unscheduledProject: ProjectCalendarUnscheduledEntryDto = { id: `project-deadline:${PROJECT_ID}`, kind: "project_deadline", reason: "unscheduled", title: "Project handoff", project, permissions: { canDrag: true, canResize: false }, deadlineVersion: 0, reminderOffsetsMinutes: [] };
const unscheduledChecklist: ChecklistCalendarUnscheduledEntryDto = { id: "checklist:66666666-6666-4666-8666-666666666666", kind: "checklist", reason: "unscheduled", title: "Prepare delivery", project, assignee: ASSIGNEE, schedule: { state: "unscheduled", version: 0, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: null, due: null }, permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true } };

let h: Harness;
beforeEach(() => { h = createHarness(); stubMedia(PHONE); });
afterEach(() => { h.teardown(); });

async function mount(subview: "month" | "week" | "day" | "days" | "agenda", options: { unscheduled?: boolean } = {}) {
  const checklist = overlappingDue();
  const fetch = stubCalendarFetch({
    range: rangeResponse({ subview, events: options.unscheduled ? [] : [deadlineEvent("2026-08-12T09:00"), checklist], unscheduled: options.unscheduled ? [unscheduledProject, unscheduledChecklist] : [] }),
    put: () => json({ changed: true, current: { version: 5, deadline: { localCivil: "2026-08-13T10:00", instant: instantOf("2026-08-13T10:00") }, reminderOffsetsMinutes: [] }, eventIntent: null, publicationIds: [] }),
    patch: () => json(checklistMutationBody(options.unscheduled ? { ...checklist, id: unscheduledChecklist.id } : checklist, dueSchedule(timed("2026-08-12T10:00"), 3))),
  });
  await h.render(calendarState(subview));
  return fetch;
}

async function openRail() {
  await act(async () => { h.host.querySelector<HTMLButtonElement>('[data-testid="event-calendar-rail-toggle"]')!.click(); await Promise.resolve(); });
  await flush(5);
}

describe("ProductionEventCalendar coarse-phone time-grid gate", () => {
  it.each(TIME_GRID)("turns off %s pointer drag and resize while keeping Reschedule… actions live", async (subview) => {
    const fetch = await mount(subview);
    expect(eventCalendarFake.lastProps?.interactions).toEqual({ drag: false, resize: false, selectSlot: false });
    const checklistId = overlappingDue().id;
    expect(await proposeUpdate(checklistId, { start: new Date(instantOf("2026-08-13T10:00")), allDay: false, granularity: "minute" })).toBe(false);
    expect(await proposeUpdate(DEADLINE_ID, { start: new Date(instantOf("2026-08-13T10:00")), allDay: false, granularity: "minute" })).toBe(false);
    expect(fetch.puts()).toHaveLength(0);
    expect(fetch.patches()).toHaveLength(0);

    await openReschedule(DEADLINE_ID);
    expect(document.querySelector('[data-testid="event-calendar-move-dialog"]')).not.toBeNull();
    await clickTestId("event-calendar-move-cancel");
    await flush(5);

    await openReschedule(checklistId);
    expect(liveRegion()).toContain("This item overlaps another task for the same assignee.");
    expect(document.querySelector('[data-testid="event-calendar-schedule-editor"]')).not.toBeNull();
    await clickTestId("event-calendar-schedule-submit");
    await flush(5);
    expect(fetch.patches()).toHaveLength(1);
  });

  it.each(TIME_GRID)("suppresses unscheduled drag in %s while keeping the Schedule actions live", async (subview) => {
    const fetch = await mount(subview, { unscheduled: true });
    await openRail();
    expect(document.querySelectorAll("[data-unscheduled-id][data-drag-source]")).toHaveLength(0);
    const actions = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="event-calendar-unscheduled-action"]')];
    const checklistAction = actions.find((button) => button.textContent === "Schedule");
    const projectAction = actions.find((button) => button.textContent === "Schedule Deadline");
    expect(checklistAction?.disabled).toBe(false);
    expect(projectAction?.disabled).toBe(false);
    await act(async () => { checklistAction!.click(); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="event-calendar-schedule-editor"]')).not.toBeNull();
    // The editor holds the gate: both actions disable, and the project row keeps its action.
    expect(document.querySelector<HTMLButtonElement>(`[data-unscheduled-id="${unscheduledChecklist.id}"] [data-testid="event-calendar-unscheduled-action"]`)?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>(`[data-unscheduled-id="${unscheduledProject.id}"] [data-testid="event-calendar-unscheduled-action"]`)?.disabled).toBe(true);
    await clickTestId("event-calendar-schedule-submit");
    await flush(5);
    expect(fetch.patches()).toHaveLength(1);
  });

  it("keeps time-grid drag on for a fine pointer or a wide viewport", async () => {
    stubMedia(["(max-width: 720px)", "(max-width: 1100px)"]);
    await mount("week");
    expect(eventCalendarFake.lastProps?.interactions).toMatchObject({ drag: true, resize: true });
    h.teardown();
    h = createHarness();
    stubMedia(["(pointer: coarse)"]);
    await mount("day");
    expect(eventCalendarFake.lastProps?.interactions).toMatchObject({ drag: true, resize: true });
  });

  it("leaves Month and Agenda behaviour unchanged on a coarse phone", async () => {
    await mount("month");
    expect(eventCalendarFake.lastProps?.interactions).toMatchObject({ drag: true, resize: true });
    h.teardown();
    h = createHarness();
    stubMedia(PHONE);
    await mount("agenda");
    expect(eventCalendarFake.lastProps?.interactions).toMatchObject({ drag: true, resize: true });
  });
});
