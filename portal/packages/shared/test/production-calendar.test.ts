import { z } from "zod";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  adminProductionCalendarRangeResponseSchema,
  calendarEventSchemaFor,
  calendarUnscheduledEntrySchemaFor,
  deriveProductionCalendarWindow,
  editorProductionCalendarRangeResponseSchema,
  externalCalendarRangeSchema,
  mapChecklistEndResizeToCommand,
  mapChecklistMoveToCommand,
  mapProjectDeadlineMoveToCommand,
  mapUnscheduledChecklistDropToCommand,
  mapUnscheduledProjectDropToCommand,
  previewProjectDeadlineReminderConsequences,
  productionCalendarFiltersSchema,
  PRODUCTION_CALENDAR_MAX_RANGE_DAYS,
  productionCalendarRangeQuerySchema,
  PRODUCTION_CALENDAR_ZONE,
  shiftSydneyCalendarDate,
  shiftSydneyCivilPreservingWallTime,
  type CalendarEventDto,
  type CalendarUnscheduledEntryDto,
  type ChecklistCalendarEventDto,
  type DueOnlyChecklistScheduleDto,
  type InvalidChecklistScheduleDto,
  type LegacyUnresolvedChecklistScheduleDto,
  type RangeChecklistScheduleDto,
  type UnscheduledChecklistScheduleDto,
} from "../src/production-calendar";
import { STAGE_KEYS, STAGE_PRESENTATION_KEYS } from "../src/stage-move";

const ADMIN_STAGE = "editing_autohdr" as const;
const EDITOR_STAGE = "editing" as const;
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PERSON_ID = "22222222-2222-4222-8222-222222222222";

const person = { id: PERSON_ID, name: "Editor", roleLabel: "Editor", isExternal: false, active: true };
const project = (stageKey: typeof ADMIN_STAGE | typeof EDITOR_STAGE) => ({
  id: PROJECT_ID,
  street: "1 Example Street",
  stageKey,
  checklist: { completed: 1, total: 3 },
  delivered: false,
});
const dateEndpoint = (localCivil: string) => ({ kind: "date" as const, localCivil, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const });
const timedEndpoint = (localCivil: string, instant: string, fold: 0 | 1 = 0) => ({ kind: "timed" as const, localCivil, instant, utcOffsetMinutes: fold === 1 ? 600 : 660, fold, resolution: "stored" as const });
const dueSchedule = (end: ReturnType<typeof dateEndpoint> | ReturnType<typeof timedEndpoint>, version = 4) => ({ state: "due_only" as const, version, zone: PRODUCTION_CALENDAR_ZONE, start: null, end, due: end.localCivil });
const rangeSchedule = (start: ReturnType<typeof dateEndpoint> | ReturnType<typeof timedEndpoint>, end: ReturnType<typeof dateEndpoint> | ReturnType<typeof timedEndpoint>, version = 4) => ({ state: "range" as const, version, zone: PRODUCTION_CALENDAR_ZONE, start, end, due: end.localCivil });
const unscheduledSchedule = (version = 4) => ({ state: "unscheduled" as const, version, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: null, due: null });
const legacySchedule: LegacyUnresolvedChecklistScheduleDto = { state: "legacy_unresolved", version: 0, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: null, due: "2026-10-04T02:30", error: { code: "subtask_schedule_legacy_unresolved", reason: "nonexistent_local_time" } };
const invalidSchedule: InvalidChecklistScheduleDto = { state: "invalid", version: 2, zone: null, start: null, end: null, due: "bad", error: { code: "subtask_schedule_storage_invalid", reason: "shape_mismatch" } };

function projectEvent(stageKey: typeof ADMIN_STAGE | typeof EDITOR_STAGE, deadlineLocalCivil = "2026-08-27T09:00"): CalendarEventDto<typeof stageKey> {
  return {
    id: `project-deadline:${PROJECT_ID}`,
    kind: "project_deadline",
    title: "Deadline",
    project: project(stageKey),
    timing: { allDay: false, start: "2026-08-26T23:00:00.000Z", end: null },
    status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false },
    permissions: { canDrag: true, canResize: false },
    deadlineLocalCivil,
    deadlineVersion: 8,
    reminderOffsetsMinutes: [1440, 60],
  };
}

function checklistEvent(stageKey: typeof ADMIN_STAGE | typeof EDITOR_STAGE, schedule: ReturnType<typeof dueSchedule> | ReturnType<typeof rangeSchedule>): ChecklistCalendarEventDto<typeof stageKey> {
  const timing = schedule.state === "range"
    ? schedule.start.kind === "date"
      ? { allDay: true as const, start: schedule.start.localCivil, end: "2026-08-29" }
      : { allDay: false as const, start: schedule.start.instant!, end: schedule.end.instant }
    : schedule.end.kind === "date"
      ? { allDay: true as const, start: schedule.end.localCivil, end: null }
      : { allDay: false as const, start: schedule.end.instant!, end: null };
  return schedule.state === "range"
    ? { id: `checklist:${PERSON_ID}`, kind: "checklist", title: "Select hero images", project: project(stageKey), assignee: person, timing, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, schedule, permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canScheduleRange: true } }
    : { id: `checklist:${PERSON_ID}`, kind: "checklist", title: "Select hero images", project: project(stageKey), assignee: person, timing, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, schedule, permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true } };
}

function response(stageKey: typeof ADMIN_STAGE | typeof EDITOR_STAGE) {
  return {
    range: {
      start: "2026-08-24", end: "2026-09-05", date: "2026-08-27", subview: "month" as const, zone: PRODUCTION_CALENDAR_ZONE,
      appliedFilters: { layers: ["project", "checklist"] as ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false },
    },
    events: [projectEvent(stageKey), checklistEvent(stageKey, dueSchedule(dateEndpoint("2026-08-27")))],
    unscheduled: [
      { id: `project-deadline:${PROJECT_ID}`, kind: "project_deadline" as const, reason: "unscheduled" as const, title: "Deadline", project: project(stageKey), permissions: { canDrag: true, canResize: false as const }, deadlineVersion: 8, reminderOffsetsMinutes: [] as [] },
      { id: `checklist:${PERSON_ID}`, kind: "checklist" as const, reason: "unscheduled" as const, title: "Select hero images", project: project(stageKey), assignee: person, schedule: unscheduledSchedule(), permissions: { canDrag: true, canResize: false as const, canOpenScheduleEditor: true, canScheduleRange: true } },
    ],
    filterFacets: { projects: [{ id: PROJECT_ID, street: "1 Example Street" }], people: [person], myTasksUserId: PERSON_ID, unscheduled: { project: { matched: 1, returned: 1, truncated: false }, checklist: { matched: 1, returned: 1, truncated: false } } },
  };
}

describe("TB5C shared query/filter contract", () => {
  it("normalizes filters while retaining distinct input and output types", () => {
    const parsed = productionCalendarFiltersSchema.parse({
      layers: ["checklist", "project", "checklist"],
      editorIds: ["33333333-3333-4333-8333-333333333333", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"],
      stageKeys: ["delivered", "editing", "awaiting_raw", "editing"],
      search: "  smith\t  street  ",
    });
    expect(parsed).toEqual({ layers: ["project", "checklist"], editorIds: [PERSON_ID, "33333333-3333-4333-8333-333333333333"], includeUnassigned: false, stageKeys: ["awaiting_raw", "editing", "delivered"], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "smith street", myTasks: false });
    expect(productionCalendarFiltersSchema.safeParse({ layers: [], search: "ok" }).success).toBe(false);
    expect(productionCalendarFiltersSchema.safeParse({ layers: ["project"], stageKeys: ["editing_autohdr"] }).success).toBe(false);
    expect(productionCalendarFiltersSchema.safeParse({ layers: ["project"], editorIds: ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"] }).success).toBe(false);
    expectTypeOf<z.input<typeof productionCalendarFiltersSchema>>().not.toEqualTypeOf<z.output<typeof productionCalendarFiltersSchema>>();
  });

  it("uses exact defaults and validates component ranges without date-only parsing", () => {
    expect(productionCalendarFiltersSchema.parse({})).toEqual({ layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false });
    expect(productionCalendarRangeQuerySchema.parse({ start: "2026-02-28", end: "2026-03-02", date: "2026-02-28", subview: "week", scope: "active" }).filters).toMatchObject({ layers: ["project", "checklist"] });
    expect(productionCalendarRangeQuerySchema.safeParse({ start: "2026-02-29", end: "2026-03-01", date: "2026-02-29", subview: "month", scope: "active" }).success).toBe(false);
    expect(productionCalendarRangeQuerySchema.safeParse({ start: "2026-01-01", end: "2026-02-13", date: "2026-01-01", subview: "month", scope: "active" }).success).toBe(false);
    expect(shiftSydneyCalendarDate("2024-02-29", 1)).toEqual({ ok: true, value: "2024-03-01" });
    expect(shiftSydneyCalendarDate("2026-03-01", -1)).toEqual({ ok: true, value: "2026-02-28" });
  });
});

describe("production Calendar civil windows", () => {
  it("renders a six-week month window with leading and trailing days", () => {
    expect(deriveProductionCalendarWindow("2026-08-12", "month")).toEqual({ start: "2026-07-27", end: "2026-09-07" });
  });

  it("does not add a leading day when the first is Monday and adds six for Sunday", () => {
    expect(deriveProductionCalendarWindow("2026-06-01", "month")).toEqual({ start: "2026-06-01", end: "2026-07-13" });
    expect(deriveProductionCalendarWindow("2026-02-01", "month")).toEqual({ start: "2026-01-26", end: "2026-03-09" });
  });

  it("anchors every weekday input to its Monday and following Monday", () => {
    const expected = { start: "2026-08-10", end: "2026-08-17" };
    for (const date of ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16"]) {
      expect(deriveProductionCalendarWindow(date, "week")).toEqual(expected);
    }
  });

  it("uses a bounded fourteen-day agenda window", () => {
    expect(deriveProductionCalendarWindow("2026-08-12", "agenda")).toEqual({ start: "2026-08-12", end: "2026-08-26" });
  });

  it("keeps the April fold and October gap in civil-date space", () => {
    expect(deriveProductionCalendarWindow("2026-04-05", "month")).toEqual({ start: "2026-03-30", end: "2026-05-11" });
    expect(deriveProductionCalendarWindow("2026-10-04", "month")).toEqual({ start: "2026-09-28", end: "2026-11-09" });
    for (const input of [["2026-04-05", "month"], ["2026-10-04", "month"], ["2026-04-05", "week"], ["2026-10-04", "agenda"]] as const) {
      const window = deriveProductionCalendarWindow(input[0], input[1]);
      let cursor = window.start;
      let difference = 0;
      while (cursor !== window.end && difference <= PRODUCTION_CALENDAR_MAX_RANGE_DAYS) {
        const next = shiftSydneyCalendarDate(cursor, 1);
        if (!next.ok) throw new Error("Test date shift failed.");
        cursor = next.value;
        difference += 1;
      }
      expect(cursor).toBe(window.end);
      expect(difference).toBeGreaterThan(0);
      expect(difference).toBeLessThanOrEqual(PRODUCTION_CALENDAR_MAX_RANGE_DAYS);
    }
  });

  it("rejects non-canonical focused dates", () => {
    expect(() => deriveProductionCalendarWindow("2026-2-01", "month")).toThrow(RangeError);
    expect(() => deriveProductionCalendarWindow("2026-02-29", "month")).toThrow(RangeError);
  });
});

describe("TB5C strict role-safe DTOs", () => {
  it("constructs concrete Admin, Editor, and External response schemas", () => {
    expect(adminProductionCalendarRangeResponseSchema.safeParse(response(ADMIN_STAGE)).success).toBe(true);
    expect(editorProductionCalendarRangeResponseSchema.safeParse(response(EDITOR_STAGE)).success).toBe(true);
    expect(externalCalendarRangeSchema.safeParse(response(EDITOR_STAGE)).success).toBe(true);
    expect(adminProductionCalendarRangeResponseSchema.safeParse(response(EDITOR_STAGE)).success).toBe(false);
    expect(editorProductionCalendarRangeResponseSchema.safeParse(response(ADMIN_STAGE)).success).toBe(false);
    expect(externalCalendarRangeSchema.safeParse({ ...response(EDITOR_STAGE), range: { ...response(EDITOR_STAGE).range, extra: true } }).success).toBe(false);
    expect(externalCalendarRangeSchema.safeParse({ ...response(EDITOR_STAGE), events: [{ ...response(EDITOR_STAGE).events[0], project: { ...response(EDITOR_STAGE).events[0]!.project, email: "private@example.com" } }] }).success).toBe(false);
    expect(externalCalendarRangeSchema.safeParse({ ...response(EDITOR_STAGE), events: [{ ...response(EDITOR_STAGE).events[0], provider: "raw-provider" }] }).success).toBe(false);
    expect(externalCalendarRangeSchema.safeParse({ ...response(EDITOR_STAGE), events: [{ ...response(EDITOR_STAGE).events[0], boardPosition: 1 }] }).success).toBe(false);
  });

  it("accepts every checklist source state only in its matching projection branch", () => {
    const stage = z.enum(STAGE_PRESENTATION_KEYS);
    const eventSchema = calendarEventSchemaFor(stage);
    const entrySchema = calendarUnscheduledEntrySchemaFor(stage);
    const due = checklistEvent(EDITOR_STAGE, dueSchedule(dateEndpoint("2026-08-27")));
    const range = checklistEvent(EDITOR_STAGE, rangeSchedule(dateEndpoint("2026-08-27"), dateEndpoint("2026-08-28")));
    const plain = { id: "checklist:plain", kind: "checklist" as const, reason: "unscheduled" as const, title: "Plain", project: project(EDITOR_STAGE), assignee: null, schedule: unscheduledSchedule(), permissions: { canDrag: true, canResize: false as const, canOpenScheduleEditor: true, canScheduleRange: true } };
    const legacy = { id: "checklist:legacy", kind: "checklist" as const, reason: "schedule_needs_attention" as const, attentionReason: "legacy_unresolved" as const, title: "Legacy", project: project(EDITOR_STAGE), assignee: null, schedule: legacySchedule, permissions: { canDrag: false as const, canResize: false as const, canOpenScheduleEditor: true, canScheduleRange: true } };
    const invalid = { id: "checklist:invalid", kind: "checklist" as const, reason: "schedule_needs_attention" as const, attentionReason: "invalid" as const, title: "Invalid", project: project(EDITOR_STAGE), assignee: null, schedule: invalidSchedule, permissions: { canDrag: false as const, canResize: false as const, canOpenScheduleEditor: false as const, canScheduleRange: false as const } };
    expect(eventSchema.safeParse(due).success).toBe(true);
    expect(eventSchema.safeParse(range).success).toBe(true);
    expect(entrySchema.safeParse(plain).success).toBe(true);
    expect(entrySchema.safeParse(legacy).success).toBe(true);
    expect(entrySchema.safeParse(invalid).success).toBe(true);
    expect(eventSchema.safeParse({ ...due, schedule: unscheduledSchedule() }).success).toBe(false);
    expect(entrySchema.safeParse({ ...plain, schedule: legacySchedule }).success).toBe(false);
    expect(entrySchema.safeParse({ ...legacy, attentionReason: "invalid", schedule: legacySchedule }).success).toBe(false);
    expect(entrySchema.safeParse({ ...invalid, permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: false, canScheduleRange: false } }).success).toBe(false);
    expect(entrySchema.safeParse({ ...invalid, permissions: { canDrag: false, canResize: false, canOpenScheduleEditor: true, canScheduleRange: false } }).success).toBe(false);
    expect(eventSchema.safeParse({ ...due, permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canScheduleRange: true } }).success).toBe(false);
    expectTypeOf<DueOnlyChecklistScheduleDto>().not.toBeNever();
    expectTypeOf<RangeChecklistScheduleDto>().not.toBeNever();
    expectTypeOf<UnscheduledChecklistScheduleDto>().not.toBeNever();
  });
});

describe("TB5C Sydney mapping contract", () => {
  it("shifts civil dates across DST gaps and folds without throwing", () => {
    expect(shiftSydneyCivilPreservingWallTime("2026-10-03T02:30", 1)).toMatchObject({ ok: false, error: { code: "nonexistent_local_time" } });
    const gapWeek = mapProjectDeadlineMoveToCommand({ event: projectEvent(ADMIN_STAGE, "2026-10-03T02:30"), target: { subview: "week", targetDate: "2026-10-04", targetCivilMinute: "2026-10-04T02:30" } });
    expect(gapWeek).toMatchObject({ ok: false, error: { code: "nonexistent_local_time" } });
    expect(shiftSydneyCivilPreservingWallTime("2026-04-04T02:30", 1)).toMatchObject({ ok: false, error: { code: "repeated_local_time", choices: [{ disambiguation: "earlier" }, { disambiguation: "later" }] } });
    const foldWeek = mapProjectDeadlineMoveToCommand({ event: projectEvent(ADMIN_STAGE, "2026-04-04T09:00"), target: { subview: "week", targetDate: "2026-04-05", targetCivilMinute: "2026-04-05T02:30" }, disambiguation: "later" });
    expect(foldWeek).toMatchObject({ ok: true, value: { deadline: { localCivil: "2026-04-05T02:30", disambiguation: "later" } } });
  });

  it("maps project deadlines with defaults and verbatim reminder offsets", () => {
    const month = mapProjectDeadlineMoveToCommand({ event: projectEvent(ADMIN_STAGE, "2026-08-27T09:00"), target: { subview: "month", targetDate: "2026-08-29" } });
    expect(month).toEqual({ ok: true, value: { expectedVersion: 8, deadline: { localCivil: "2026-08-29T09:00" }, reminderOffsetsMinutes: [1440, 60] } });
    const unscheduledMonth = mapUnscheduledProjectDropToCommand({ event: { id: "project-deadline:unscheduled", kind: "project_deadline", reason: "unscheduled", title: "Deadline", project: project(ADMIN_STAGE), permissions: { canDrag: true, canResize: false }, deadlineVersion: 3, reminderOffsetsMinutes: [] }, target: { subview: "month", targetDate: "2026-08-29" } });
    expect(unscheduledMonth).toMatchObject({ ok: true, value: { expectedVersion: 3, deadline: { localCivil: "2026-08-29T17:00" }, reminderOffsetsMinutes: [] } });
    const snapped = mapUnscheduledProjectDropToCommand({ event: { id: "project-deadline:unscheduled", kind: "project_deadline", reason: "unscheduled", title: "Deadline", project: project(ADMIN_STAGE), permissions: { canDrag: true, canResize: false }, deadlineVersion: 3, reminderOffsetsMinutes: [] }, target: { subview: "week", targetDate: "2026-08-29", targetCivilMinute: "2026-08-29T10:07" } });
    expect(snapped).toMatchObject({ ok: true, value: { deadline: { localCivil: "2026-08-29T10:00" } } });
  });

  it("moves checklist ranges by civil components, resolves endpoints independently, and subtracts exclusive all-day ends", () => {
    const timed = checklistEvent(EDITOR_STAGE, rangeSchedule(timedEndpoint("2026-10-03T01:30", "2026-10-02T15:30:00.000Z"), timedEndpoint("2026-10-03T03:30", "2026-10-02T17:30:00.000Z")));
    const moved = mapChecklistMoveToCommand({ event: timed, target: { subview: "month", targetDate: "2026-10-04" } });
    expect(moved).toMatchObject({ ok: true, value: { expectedVersion: 4, schedule: { state: "range", start: { localCivil: "2026-10-04T01:30" }, end: { localCivil: "2026-10-04T03:30" } } } });

    const independentFold = checklistEvent(EDITOR_STAGE, rangeSchedule(timedEndpoint("2026-04-04T02:30", "2026-04-03T16:30:00.000Z"), timedEndpoint("2026-04-04T02:45", "2026-04-03T16:45:00.000Z")));
    const fold = mapChecklistMoveToCommand({ event: independentFold, target: { subview: "month", targetDate: "2026-04-05" }, disambiguation: { start: "earlier", end: "later" } });
    expect(fold).toMatchObject({ ok: true, value: { schedule: { start: { disambiguation: "earlier" }, end: { disambiguation: "later" } } } });

    const allDay = checklistEvent(EDITOR_STAGE, rangeSchedule(dateEndpoint("2026-08-27"), dateEndpoint("2026-08-27")));
    const resized = mapChecklistEndResizeToCommand({ event: allDay, target: { subview: "month", targetDate: "2026-08-29" } });
    expect(resized).toMatchObject({ ok: true, value: { schedule: { start: { localCivil: "2026-08-27" }, end: { localCivil: "2026-08-28" } } } });
    expect(mapChecklistEndResizeToCommand({ event: allDay, target: { subview: "month", targetDate: "2026-08-29", edge: "start" } })).toMatchObject({ ok: false, error: { code: "start_resize_unsupported" } });
  });

  it("maps Unscheduled checklist Month/Week defaults and validates them before returning", () => {
    const event: CalendarUnscheduledEntryDto<typeof EDITOR_STAGE> = { id: "checklist:unscheduled", kind: "checklist", reason: "unscheduled", title: "Unscheduled", project: project(EDITOR_STAGE), assignee: null, schedule: unscheduledSchedule(6), permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true } };
    expect(mapUnscheduledChecklistDropToCommand({ event, target: { subview: "month", targetDate: "2026-08-29" } })).toMatchObject({ ok: true, value: { expectedVersion: 6, schedule: { state: "due_only", end: { kind: "date", localCivil: "2026-08-29" } } } });
    expect(mapUnscheduledChecklistDropToCommand({ event, target: { subview: "week", targetDate: "2026-10-03", targetCivilMinute: "2026-10-03T10:07" } })).toMatchObject({ ok: true, value: { schedule: { state: "range", start: { localCivil: "2026-10-03T10:00" }, end: { localCivil: "2026-10-03T11:00" } } } });
    expect(mapUnscheduledChecklistDropToCommand({ event, target: { subview: "agenda", targetDate: "2026-08-29" } })).toMatchObject({ ok: false, error: { code: "unsupported_subview" } });
  });
});

describe("TB5C reminder preview", () => {
  it("keeps offsets unchanged and classifies future, elapsed, and DST wall-clock consequences", () => {
    const oldDeadline = { localCivil: "2026-10-03T02:30", instant: "2026-10-02T16:30:00.000Z" };
    const newDeadline = { localCivil: "2026-10-05T02:30", instant: "2026-10-04T15:30:00.000Z" };
    const preview = previewProjectDeadlineReminderConsequences({ oldDeadline, newDeadline, reminderOffsetsMinutes: [1440, 60], now: Date.parse("2026-10-01T00:00:00.000Z") });
    expect(preview.map((item) => item.offsetMinutes)).toEqual([1440, 60]);
    expect(preview[0]).toMatchObject({ label: "shifted_wall_clock_hour" });
    expect(preview[1]).toMatchObject({ label: "future" });
    expect(previewProjectDeadlineReminderConsequences({ oldDeadline, newDeadline, reminderOffsetsMinutes: [1440], now: Date.parse("2026-10-05T00:00:00.000Z") })[0]).toMatchObject({ label: "elapsed_at_save" });
  });
});
