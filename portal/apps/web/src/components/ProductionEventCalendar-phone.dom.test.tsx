/**
 * #222 step 9 — the coarse-phone gate, ported from `ProductionCalendar-phone.dom.test.tsx` (4) and
 * extended from Week to the new time-grid views, Day and 3-day. A coarse pointer at ≤720px turns
 * pointer drag and resize (and so keyboard Adjust) OFF in week / day / days; Reschedule… stays.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChecklistCalendarEventDto } from "@quincy/shared";
import { eventCalendarFake } from "../testing/event-calendar-fake";
import { applyPopup, pickPopupDay } from "../testing/date-time-popup";
import { checklistMutationBody, deadlineEvent, oneDaySchedule, instantOf, PROJECT_ID, rangeResponse, timed, oneDayEvent } from "../testing/production-calendar-fixtures";
import {
  calendarState,
  clickTestId,
  createHarness,
  flush,
  json,
  liveRegion,
  openEditSchedule,
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

const PHONE = ["(pointer: coarse)", "(max-width: 720px)", "(max-width: 1100px)"];
const DEADLINE_ID = `project-deadline:${PROJECT_ID}`;
const TIME_GRID = ["week", "day", "days"] as const;

const overlappingDue = (): ChecklistCalendarEventDto => {
  const event = oneDayEvent(timed("2026-08-12T10:00"));
  return { ...event, status: { ...event.status, sameAssigneeOverlap: true } } as ChecklistCalendarEventDto;
};
const project = { id: PROJECT_ID, street: "12 Harbour Street", stageKey: "editing_autohdr" as const, checklist: { completed: 1, total: 2 }, delivered: false, archived: false };

let h: Harness;
beforeEach(() => { h = createHarness(); stubMedia(PHONE); });
afterEach(() => { h.teardown(); });

async function mount(subview: "month" | "week" | "day" | "days" | "agenda") {
  const checklist = overlappingDue();
  const fetch = stubCalendarFetch({
    range: rangeResponse({ subview, events: [deadlineEvent("2026-08-12T09:00"), checklist] }),
    put: () => json({ changed: true, current: { version: 5, deadline: { localCivil: "2026-08-13T10:00", instant: instantOf("2026-08-13T10:00") }, reminderOffsetsMinutes: [] }, eventIntent: null, publicationIds: [] }),
    patch: () => json(checklistMutationBody(checklist, oneDaySchedule(timed("2026-08-12T10:00"), 3))),
  });
  await h.render(calendarState(subview));
  return fetch;
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

    const popup = await openEditSchedule(checklistId);
    expect(liveRegion()).toContain("This item overlaps another task for the same assignee.");
    expect(document.querySelector('[data-testid="event-calendar-schedule-editor"]'), "the picker, not the sheet, even on a phone (#583)").toBeNull();
    // An untouched Apply is a no-op; the range is changed so the save is a PATCH.
    await pickPopupDay(popup, "2026-08-14");
    await applyPopup(popup);
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
