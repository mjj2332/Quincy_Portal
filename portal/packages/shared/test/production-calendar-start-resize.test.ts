import { describe, expect, it } from "vitest";
import { resolveSydneyCivilMinute } from "../src/sydney-civil-time";
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
const momentEndpoint = (localCivil: string, fold: 0 | 1 = 0) => {
  const resolved = resolveSydneyCivilMinute(localCivil, fold === 1 ? "later" : "earlier");
  if (!resolved.ok) throw new Error(`fixture endpoint ${localCivil} does not resolve`);
  return { localCivil, instant: resolved.value.instant, utcOffsetMinutes: resolved.value.utcOffsetMinutes, fold: resolved.value.fold, resolution: "stored" as const };
};
const presetStart = (date: string) => momentEndpoint(`${date}T09:00`);
const presetEnd = (date: string) => momentEndpoint(`${date}T17:00`);
const timedEndpoint = (localCivil: string, _instant?: string, fold: 0 | 1 = 0) => momentEndpoint(localCivil, fold);
const rangeSchedule = (start: ReturnType<typeof momentEndpoint>, end: ReturnType<typeof momentEndpoint>, version = 4) => ({ state: "range" as const, version, zone: PRODUCTION_CALENDAR_ZONE, start, end, due: end.localCivil });

function checklistEvent(schedule: ReturnType<typeof rangeSchedule>): ChecklistCalendarEventDto<typeof EDITOR_STAGE> {
  const timing = { allDay: false as const, start: schedule.start.instant, end: schedule.end.instant };
  return { id: `checklist:${PERSON_ID}`, kind: "checklist", title: "Select hero images", project: project(), assignees: [person], otherAssigneeCount: 0, timing, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, schedule, permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true } };
}

describe("TB5C mapChecklistStartResizeToCommand", () => {
  it("maps a day-granularity start resize to the target day at the start's own wall time", () => {
    const allDay = checklistEvent(rangeSchedule(presetStart("2026-08-27"), presetEnd("2026-08-29")));
    const resized = mapChecklistStartResizeToCommand({ event: allDay, target: { subview: "month", targetDate: "2026-08-26", targetCivilMinute: "2026-08-26T09:00" } });
    expect(resized).toMatchObject({ ok: true, value: { schedule: { start: { localCivil: "2026-08-26T09:00" }, end: { localCivil: "2026-08-29T17:00" } } } });
  });

  it("keeps the end endpoint verbatim", () => {
    const timed = checklistEvent(rangeSchedule(timedEndpoint("2026-08-27T09:00", "2026-08-26T23:00:00.000Z"), timedEndpoint("2026-08-27T11:00", "2026-08-27T01:00:00.000Z")));
    const resized = mapChecklistStartResizeToCommand({ event: timed, target: { subview: "week", targetDate: "2026-08-27", targetCivilMinute: "2026-08-27T08:00" } });
    // Full endpoint, not just localCivil — endpointToInput (:660-663) carries fold through as a
    // disambiguation on the *preserved* end, which a partial match would let silently drop.
    expect(resized).toMatchObject({ ok: true, value: { schedule: { end: { localCivil: "2026-08-27T11:00", disambiguation: "earlier" } } } });
  });

  it("keeps the end endpoint's later-fold disambiguation verbatim too", () => {
    const timed = checklistEvent(rangeSchedule(timedEndpoint("2026-04-05T01:00"), timedEndpoint("2026-04-05T02:30", undefined, 1)));
    const resized = mapChecklistStartResizeToCommand({ event: timed, target: { subview: "week", targetDate: "2026-04-05", targetCivilMinute: "2026-04-05T01:30" } });
    expect(resized).toMatchObject({ ok: true, value: { schedule: { end: { localCivil: "2026-04-05T02:30", disambiguation: "later" } } } });
  });

  it("floors a timed start to the 15-minute slot", () => {
    const timed = checklistEvent(rangeSchedule(timedEndpoint("2026-08-27T09:00", "2026-08-26T23:00:00.000Z"), timedEndpoint("2026-08-27T11:00", "2026-08-27T01:00:00.000Z")));
    const resized = mapChecklistStartResizeToCommand({ event: timed, target: { subview: "week", targetDate: "2026-08-27", targetCivilMinute: "2026-08-27T08:07" } });
    expect(resized).toMatchObject({ ok: true, value: { schedule: { start: { localCivil: "2026-08-27T08:00" } } } });
  });

  it("rejects agenda with unsupported_subview", () => {
    const allDay = checklistEvent(rangeSchedule(presetStart("2026-08-27"), presetEnd("2026-08-29")));
    const resized = mapChecklistStartResizeToCommand({ event: allDay, target: { subview: "agenda", targetDate: "2026-08-26" } });
    expect(resized).toMatchObject({ ok: false, error: { code: "unsupported_subview" } });
  });

  it("rejects the end edge via target.edge", () => {
    const allDay = checklistEvent(rangeSchedule(presetStart("2026-08-27"), presetEnd("2026-08-29")));
    const resized = mapChecklistStartResizeToCommand({ event: allDay, target: { subview: "month", targetDate: "2026-08-26", edge: "end" } });
    expect(resized).toMatchObject({ ok: false, error: { code: "end_resize_not_this_mapper" } });
  });

  it("rejects the end edge via input.edge, independent of target.edge", () => {
    const allDay = checklistEvent(rangeSchedule(presetStart("2026-08-27"), presetEnd("2026-08-29")));
    const resized = mapChecklistStartResizeToCommand({ event: allDay, edge: "end", target: { subview: "month", targetDate: "2026-08-26" } });
    expect(resized).toMatchObject({ ok: false, error: { code: "end_resize_not_this_mapper" } });
  });

  it("returns subtask_schedule_invalid_order when the new start is at or after the end", () => {
    const allDay = checklistEvent(rangeSchedule(presetStart("2026-08-27"), presetEnd("2026-08-29")));
    const resized = mapChecklistStartResizeToCommand({ event: allDay, target: { subview: "month", targetDate: "2026-08-30", targetCivilMinute: "2026-08-30T09:00" } });
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
