import { describe, expect, it } from "vitest";
import {
  mapChecklistStartResizeToCommand,
  PRODUCTION_CALENDAR_ZONE,
  type ChecklistCalendarEventDto,
} from "../src/production-calendar";

const EDITOR_STAGE = "editing" as const;
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PERSON_ID = "22222222-2222-4222-8222-222222222222";

const person = { id: PERSON_ID, name: "Editor", roleLabel: "Editor", isExternal: false, active: true };
const project = () => ({
  id: PROJECT_ID,
  street: "1 Example Street",
  stageKey: EDITOR_STAGE,
  checklist: { completed: 1, total: 3 },
  delivered: false,
});
const dateEndpoint = (localCivil: string) => ({ kind: "date" as const, localCivil, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const });
const timedEndpoint = (localCivil: string, instant: string, fold: 0 | 1 = 0) => ({ kind: "timed" as const, localCivil, instant, utcOffsetMinutes: fold === 1 ? 600 : 660, fold, resolution: "stored" as const });
const dueSchedule = (end: ReturnType<typeof dateEndpoint> | ReturnType<typeof timedEndpoint>, version = 4) => ({ state: "due_only" as const, version, zone: PRODUCTION_CALENDAR_ZONE, start: null, end, due: end.localCivil });
const rangeSchedule = (start: ReturnType<typeof dateEndpoint> | ReturnType<typeof timedEndpoint>, end: ReturnType<typeof dateEndpoint> | ReturnType<typeof timedEndpoint>, version = 4) => ({ state: "range" as const, version, zone: PRODUCTION_CALENDAR_ZONE, start, end, due: end.localCivil });

function checklistEvent(schedule: ReturnType<typeof dueSchedule> | ReturnType<typeof rangeSchedule>): ChecklistCalendarEventDto<typeof EDITOR_STAGE> {
  const timing = schedule.state === "range"
    ? schedule.start.kind === "date"
      ? { allDay: true as const, start: schedule.start.localCivil, end: "2026-08-29" }
      : { allDay: false as const, start: schedule.start.instant!, end: schedule.end.instant }
    : schedule.end.kind === "date"
      ? { allDay: true as const, start: schedule.end.localCivil, end: null }
      : { allDay: false as const, start: schedule.end.instant!, end: null };
  return schedule.state === "range"
    ? { id: `checklist:${PERSON_ID}`, kind: "checklist", title: "Select hero images", project: project(), assignee: person, timing, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, schedule, permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canScheduleRange: true } }
    : { id: `checklist:${PERSON_ID}`, kind: "checklist", title: "Select hero images", project: project(), assignee: person, timing, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, schedule, permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true } };
}

describe("TB5C mapChecklistStartResizeToCommand", () => {
  it("maps an all-day start resize to the inclusive target date", () => {
    const allDay = checklistEvent(rangeSchedule(dateEndpoint("2026-08-27"), dateEndpoint("2026-08-29")));
    const resized = mapChecklistStartResizeToCommand({ event: allDay, target: { subview: "month", targetDate: "2026-08-26" } });
    expect(resized).toMatchObject({ ok: true, value: { schedule: { start: { localCivil: "2026-08-26" }, end: { localCivil: "2026-08-29" } } } });
  });

  it("keeps the end endpoint verbatim", () => {
    const timed = checklistEvent(rangeSchedule(timedEndpoint("2026-08-27T09:00", "2026-08-26T23:00:00.000Z"), timedEndpoint("2026-08-27T11:00", "2026-08-27T01:00:00.000Z")));
    const resized = mapChecklistStartResizeToCommand({ event: timed, target: { subview: "week", targetDate: "2026-08-27", targetCivilMinute: "2026-08-27T08:00" } });
    expect(resized).toMatchObject({ ok: true, value: { schedule: { end: { localCivil: "2026-08-27T11:00" } } } });
  });

  it("floors a timed start to the 15-minute slot", () => {
    const timed = checklistEvent(rangeSchedule(timedEndpoint("2026-08-27T09:00", "2026-08-26T23:00:00.000Z"), timedEndpoint("2026-08-27T11:00", "2026-08-27T01:00:00.000Z")));
    const resized = mapChecklistStartResizeToCommand({ event: timed, target: { subview: "week", targetDate: "2026-08-27", targetCivilMinute: "2026-08-27T08:07" } });
    expect(resized).toMatchObject({ ok: true, value: { schedule: { start: { localCivil: "2026-08-27T08:00" } } } });
  });

  it("rejects agenda with unsupported_subview", () => {
    const allDay = checklistEvent(rangeSchedule(dateEndpoint("2026-08-27"), dateEndpoint("2026-08-29")));
    const resized = mapChecklistStartResizeToCommand({ event: allDay, target: { subview: "agenda", targetDate: "2026-08-26" } });
    expect(resized).toMatchObject({ ok: false, error: { code: "unsupported_subview" } });
  });

  it("rejects the end edge", () => {
    const allDay = checklistEvent(rangeSchedule(dateEndpoint("2026-08-27"), dateEndpoint("2026-08-29")));
    const resized = mapChecklistStartResizeToCommand({ event: allDay, target: { subview: "month", targetDate: "2026-08-26", edge: "end" } });
    expect(resized).toMatchObject({ ok: false, error: { code: "end_resize_not_this_mapper" } });
  });

  it("rejects a due_only schedule with unsupported_schedule_state", () => {
    const due = checklistEvent(dueSchedule(dateEndpoint("2026-08-27")));
    const resized = mapChecklistStartResizeToCommand({ event: due, target: { subview: "month", targetDate: "2026-08-26" } });
    expect(resized).toMatchObject({ ok: false, error: { code: "unsupported_schedule_state" } });
  });

  it("returns subtask_schedule_invalid_order when the new start is at or after the end", () => {
    const allDay = checklistEvent(rangeSchedule(dateEndpoint("2026-08-27"), dateEndpoint("2026-08-29")));
    const resized = mapChecklistStartResizeToCommand({ event: allDay, target: { subview: "month", targetDate: "2026-08-30" } });
    expect(resized).toMatchObject({ ok: false, error: { code: "subtask_schedule_invalid_order" } });
  });

  it("surfaces a DST-gap start as subtask_schedule_nonexistent_local_time (2026-10-04T02:30)", () => {
    const timed = checklistEvent(rangeSchedule(timedEndpoint("2026-10-03T01:30", "2026-10-02T15:30:00.000Z"), timedEndpoint("2026-10-04T03:30", "2026-10-03T17:30:00.000Z")));
    const resized = mapChecklistStartResizeToCommand({ event: timed, target: { subview: "week", targetDate: "2026-10-04", targetCivilMinute: "2026-10-04T02:30" } });
    expect(resized).toMatchObject({ ok: false, error: { code: "subtask_schedule_nonexistent_local_time", endpoint: "start" } });
  });

  it("surfaces a DST-fold start as subtask_schedule_repeated_local_time with endpoint start and two choices (2026-04-05T02:30)", () => {
    const timed = checklistEvent(rangeSchedule(timedEndpoint("2026-04-04T01:30", "2026-04-03T14:30:00.000Z"), timedEndpoint("2026-04-05T09:30", "2026-04-04T23:30:00.000Z")));
    const resized = mapChecklistStartResizeToCommand({ event: timed, target: { subview: "week", targetDate: "2026-04-05", targetCivilMinute: "2026-04-05T02:30" } });
    expect(resized).toMatchObject({ ok: false, error: { code: "subtask_schedule_repeated_local_time", endpoint: "start", choices: [{ disambiguation: "earlier" }, { disambiguation: "later" }] } });
  });

  it("passes the start disambiguation through", () => {
    const timed = checklistEvent(rangeSchedule(timedEndpoint("2026-04-04T01:30", "2026-04-03T14:30:00.000Z"), timedEndpoint("2026-04-05T09:30", "2026-04-04T23:30:00.000Z")));
    const resized = mapChecklistStartResizeToCommand({ event: timed, target: { subview: "week", targetDate: "2026-04-05", targetCivilMinute: "2026-04-05T02:30" }, disambiguation: "later" });
    expect(resized).toMatchObject({ ok: true, value: { schedule: { start: { localCivil: "2026-04-05T02:30", disambiguation: "later" } } } });
  });
});
