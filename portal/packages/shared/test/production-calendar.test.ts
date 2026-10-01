import { z } from "zod";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  adminProductionCalendarRangeResponseSchema,
  calendarChecklistEntityId,
  calendarEventSchemaFor,
  CALENDAR_CHECKLIST_ID_PREFIX,
  deriveProductionCalendarWindow,
  editorProductionCalendarRangeResponseSchema,
  externalCalendarRangeSchema,
  mapChecklistEndResizeToCommand,
  mapChecklistMoveToCommand,
  mapProjectDeadlineMoveToCommand,
  mapUnscheduledProjectDropToCommand,
  previewProjectDeadlineReminderConsequences,
  productionCalendarFiltersSchema,
  PRODUCTION_CALENDAR_MAX_RANGE_DAYS,
  PRODUCTION_CALENDAR_SUBVIEWS,
  productionCalendarRangeQuerySchema,
  PRODUCTION_CALENDAR_ZONE,
  shiftSydneyCalendarDate,
  shiftSydneyCivilPreservingWallTime,
  subtaskIdFromCalendarEntityId,
  type CalendarEventDto,
  type ChecklistCalendarEventDto,
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
  archived: false,
});
const dateEndpoint = (localCivil: string) => ({ kind: "date" as const, localCivil, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const });
const timedEndpoint = (localCivil: string, instant: string, fold: 0 | 1 = 0) => ({ kind: "timed" as const, localCivil, instant, utcOffsetMinutes: fold === 1 ? 600 : 660, fold, resolution: "stored" as const });
const rangeSchedule = (start: ReturnType<typeof dateEndpoint> | ReturnType<typeof timedEndpoint>, end: ReturnType<typeof dateEndpoint> | ReturnType<typeof timedEndpoint>, version = 4) => ({ state: "range" as const, version, zone: PRODUCTION_CALENDAR_ZONE, start, end, due: end.localCivil });

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

function checklistEvent(stageKey: typeof ADMIN_STAGE | typeof EDITOR_STAGE, schedule: ReturnType<typeof rangeSchedule>): ChecklistCalendarEventDto<typeof stageKey> {
  const timing = schedule.start.kind === "date"
    ? { allDay: true as const, start: schedule.start.localCivil, end: "2026-08-29" }
    : { allDay: false as const, start: schedule.start.instant!, end: schedule.end.instant };
  return { id: `checklist:${PERSON_ID}`, kind: "checklist", title: "Select hero images", project: project(stageKey), assignees: [person], otherAssigneeCount: 0, timing, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, schedule, permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true } };
}

function response(stageKey: typeof ADMIN_STAGE | typeof EDITOR_STAGE) {
  return {
    range: {
      start: "2026-08-24", end: "2026-09-05", date: "2026-08-27", subview: "month" as const, zone: PRODUCTION_CALENDAR_ZONE,
      appliedFilters: { layers: ["project", "checklist"] as ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], priorities: [], archived: "hide", showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false },
    },
    events: [projectEvent(stageKey), checklistEvent(stageKey, rangeSchedule(dateEndpoint("2026-08-27"), dateEndpoint("2026-08-27")))],
    filterFacets: { projects: [{ id: PROJECT_ID, street: "1 Example Street" }], people: [person], myTasksUserId: PERSON_ID },
  };
}

describe("TB5C shared query/filter contract", () => {
  it("normalizes filters while retaining distinct input and output types", () => {
    const parsed = productionCalendarFiltersSchema.parse({
      layers: ["checklist", "project", "checklist"],
      editorIds: ["33333333-3333-4333-8333-333333333333", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"],
      stageKeys: ["delivered", "editing", "awaiting_raw", "editing"],
      priorities: [],
      archived: "hide",
      search: "  smith\t  street  ",
    });
    expect(parsed).toEqual({ layers: ["project", "checklist"], editorIds: [PERSON_ID, "33333333-3333-4333-8333-333333333333"], includeUnassigned: false, stageKeys: ["awaiting_raw", "editing", "delivered"], priorities: [], archived: "hide", showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "smith street", myTasks: false });
    expect(productionCalendarFiltersSchema.safeParse({ layers: [], search: "ok" }).success).toBe(false);
    expect(productionCalendarFiltersSchema.safeParse({ layers: ["project"], stageKeys: ["editing_autohdr"] }).success).toBe(false);
    expect(productionCalendarFiltersSchema.safeParse({ layers: ["project"], editorIds: ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"] }).success).toBe(false);
    expectTypeOf<z.input<typeof productionCalendarFiltersSchema>>().not.toEqualTypeOf<z.output<typeof productionCalendarFiltersSchema>>();
  });

  it("#428: canonicalises the shared Filter's priorities and keeps the archived mode, rejecting unknown values", () => {
    expect(productionCalendarFiltersSchema.parse({ priorities: ["none", "1", "5", "1"], archived: "include" })).toMatchObject({ priorities: ["5", "1", "none"], archived: "include" });
    expect(productionCalendarFiltersSchema.safeParse({ priorities: ["6"] }).success).toBe(false);
    expect(productionCalendarFiltersSchema.safeParse({ archived: "1" }).success).toBe(false);
  });

  it("uses exact defaults and validates component ranges without date-only parsing", () => {
    expect(productionCalendarFiltersSchema.parse({})).toEqual({ layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], priorities: [], archived: "hide", showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false });
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

  it("#222: day is the focused date alone and days is the focused date plus the next two", () => {
    expect(deriveProductionCalendarWindow("2026-08-12", "day")).toEqual({ start: "2026-08-12", end: "2026-08-13" });
    expect(deriveProductionCalendarWindow("2026-08-12", "days")).toEqual({ start: "2026-08-12", end: "2026-08-15" });
    // month and year boundaries stay in civil-date space
    expect(deriveProductionCalendarWindow("2026-08-31", "day")).toEqual({ start: "2026-08-31", end: "2026-09-01" });
    expect(deriveProductionCalendarWindow("2026-12-30", "days")).toEqual({ start: "2026-12-30", end: "2027-01-02" });
  });

  it("#222: day and days windows across both 2026 Sydney DST transitions stay whole civil days", () => {
    // 2026-04-05: clocks fall back (25-hour day). 2026-10-04: clocks spring forward (23-hour day).
    expect(deriveProductionCalendarWindow("2026-04-05", "day")).toEqual({ start: "2026-04-05", end: "2026-04-06" });
    expect(deriveProductionCalendarWindow("2026-10-04", "day")).toEqual({ start: "2026-10-04", end: "2026-10-05" });
    expect(deriveProductionCalendarWindow("2026-04-04", "days")).toEqual({ start: "2026-04-04", end: "2026-04-07" });
    expect(deriveProductionCalendarWindow("2026-10-03", "days")).toEqual({ start: "2026-10-03", end: "2026-10-06" });
    // the DST weeks themselves, Monday-anchored, for the views that already existed
    expect(deriveProductionCalendarWindow("2026-04-05", "week")).toEqual({ start: "2026-03-30", end: "2026-04-06" });
    expect(deriveProductionCalendarWindow("2026-10-04", "week")).toEqual({ start: "2026-09-28", end: "2026-10-05" });
  });

  it("#222: the subview list is additive — the original three keep their order", () => {
    expect(PRODUCTION_CALENDAR_SUBVIEWS).toEqual(["month", "week", "day", "days", "agenda"]);
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

  it("#222: accepts OPTIONAL strict projectBounds on every role's response", () => {
    const projectId = "123e4567-e89b-42d3-a456-426614174000";
    const bounds = [
      { projectId, shootDate: "2026-08-20", createdAt: "2026-07-01T00:00:00.000Z", deadlineLocalCivil: "2026-08-27T09:00" },
      { projectId: "223e4567-e89b-42d3-a456-426614174000", shootDate: null, createdAt: "2026-07-02T03:04:05.678Z", deadlineLocalCivil: null },
    ];
    for (const [schema, stage] of [[adminProductionCalendarRangeResponseSchema, ADMIN_STAGE], [editorProductionCalendarRangeResponseSchema, EDITOR_STAGE], [externalCalendarRangeSchema, EDITOR_STAGE]] as const) {
      // absent (what every request without bounds=1 receives) and present both parse
      expect(schema.safeParse(response(stage)).success).toBe(true);
      const parsed = schema.parse({ ...response(stage), projectBounds: bounds });
      expect(parsed.projectBounds).toEqual(bounds);
      expect("projectBounds" in schema.parse(response(stage))).toBe(false);
      // strict entries: no extra fields, canonical dates only, lowercase-uuid project ids
      expect(schema.safeParse({ ...response(stage), projectBounds: [{ ...bounds[0], street: "private" }] }).success).toBe(false);
      expect(schema.safeParse({ ...response(stage), projectBounds: [{ ...bounds[0], shootDate: "Tuesday" }] }).success).toBe(false);
      expect(schema.safeParse({ ...response(stage), projectBounds: [{ ...bounds[0], projectId: "not-a-uuid" }] }).success).toBe(false);
      expect(schema.safeParse({ ...response(stage), projectBounds: null }).success).toBe(false);
      // #288: createdAt is REQUIRED (the created-at lower-bound fallback) — missing, null or malformed rejected
      const { createdAt: _createdAt, ...withoutCreatedAt } = bounds[0]!;
      expect(schema.safeParse({ ...response(stage), projectBounds: [withoutCreatedAt] }).success).toBe(false);
      expect(schema.safeParse({ ...response(stage), projectBounds: [{ ...bounds[0], createdAt: null }] }).success).toBe(false);
      expect(schema.safeParse({ ...response(stage), projectBounds: [{ ...bounds[0], createdAt: "" }] }).success).toBe(false);
      expect(schema.safeParse({ ...response(stage), projectBounds: [{ ...bounds[0], createdAt: 1_780_000_000_000 }] }).success).toBe(false);
      expect(schema.safeParse({ ...response(stage), projectBounds: [{ ...bounds[0], createdAt: "garbage" }] }).success).toBe(false);
      expect(schema.safeParse({ ...response(stage), projectBounds: [{ ...bounds[0], createdAt: "2026-07-01" }] }).success).toBe(false);
    }
  });

  it("accepts only range checklist schedules in the event schema (ADR 0011)", () => {
    const stage = z.enum(STAGE_PRESENTATION_KEYS);
    const eventSchema = calendarEventSchemaFor(stage);
    const oneDay = checklistEvent(EDITOR_STAGE, rangeSchedule(dateEndpoint("2026-08-27"), dateEndpoint("2026-08-27")));
    const range = checklistEvent(EDITOR_STAGE, rangeSchedule(dateEndpoint("2026-08-27"), dateEndpoint("2026-08-28")));
    expect(eventSchema.safeParse(oneDay).success).toBe(true);
    expect(eventSchema.safeParse(range).success).toBe(true);
    expect(eventSchema.safeParse({ ...range, schedule: { ...range.schedule, state: "due_only", start: null } }).success).toBe(false);
    expect(eventSchema.safeParse({ ...range, schedule: { state: "unscheduled", version: 4, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: null, due: null } }).success).toBe(false);
    expect(eventSchema.safeParse({ ...range, schedule: { ...range.schedule, state: "legacy_unresolved" } }).success).toBe(false);
    expect(eventSchema.safeParse({ ...range, schedule: { ...range.schedule, start: null } }).success).toBe(false);
    expect(eventSchema.safeParse({ ...range, schedule: { ...range.schedule, due: null } }).success).toBe(false);
    expect(eventSchema.safeParse({ ...range, schedule: { ...range.schedule, end: { ...range.schedule.end, resolution: "derived_unambiguous" } } }).success).toBe(false);
    expect(eventSchema.safeParse({ ...range, permissions: { ...range.permissions, canScheduleRange: true } }).success).toBe(false);
    // A stored version is at least 1: the serializer throws on 0, so the schema refuses it too.
    expect(eventSchema.safeParse({ ...range, schedule: { ...range.schedule, version: 0 } }).success).toBe(false);
  });

  it("has no unscheduled array and no unscheduled facets in any role's response", () => {
    for (const [schema, stage] of [[adminProductionCalendarRangeResponseSchema, ADMIN_STAGE], [editorProductionCalendarRangeResponseSchema, EDITOR_STAGE], [externalCalendarRangeSchema, EDITOR_STAGE]] as const) {
      const body = response(stage);
      expect(schema.safeParse(body).success).toBe(true);
      expect(schema.safeParse({ ...body, unscheduled: [] }).success).toBe(false);
      expect(schema.safeParse({ ...body, filterFacets: { ...body.filterFacets, unscheduled: { project: { matched: 0, returned: 0, truncated: false }, checklist: { matched: 0, returned: 0, truncated: false } } } }).success).toBe(false);
    }
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
    expect(unscheduledMonth).toEqual({ ok: true, value: { expectedVersion: 3, deadline: { localCivil: "2026-08-29T17:00" }, reminderOffsetsMinutes: [] } });
    const snapped = mapUnscheduledProjectDropToCommand({ event: { id: "project-deadline:unscheduled", kind: "project_deadline", reason: "unscheduled", title: "Deadline", project: project(ADMIN_STAGE), permissions: { canDrag: true, canResize: false }, deadlineVersion: 3, reminderOffsetsMinutes: [] }, target: { subview: "week", targetDate: "2026-08-29", targetCivilMinute: "2026-08-29T10:07" } });
    expect(snapped).toEqual({ ok: true, value: { expectedVersion: 3, deadline: { localCivil: "2026-08-29T10:00" }, reminderOffsetsMinutes: [] } });
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

  it("does not label a plain time change (no DST crossing) as a wall-clock shift", () => {
    // 14:00 -> 16:00 same day, both AEST. Every reminder shifts by exactly the
    // 2 hours the Deadline moved — that is expected, not a daylight-saving surprise.
    const oldDeadline = { localCivil: "2026-09-03T14:00", instant: "2026-09-03T04:00:00.000Z" };
    const newDeadline = { localCivil: "2026-09-03T16:00", instant: "2026-09-03T06:00:00.000Z" };
    const preview = previewProjectDeadlineReminderConsequences({ oldDeadline, newDeadline, reminderOffsetsMinutes: [1440, 120], now: Date.parse("2026-09-01T00:00:00.000Z") });
    expect(preview.map((item) => item.label)).toEqual(["future", "future"]);
  });
});

describe("Calendar checklist entity id vs bare subtask id (#226)", () => {
  it("round-trips a subtask id through the entity id mint/parse pair", () => {
    const subtaskId = "b1f2c3d4-0000-4000-8000-000000000001";
    expect(calendarChecklistEntityId(subtaskId)).toBe(`${CALENDAR_CHECKLIST_ID_PREFIX}${subtaskId}`);
    expect(subtaskIdFromCalendarEntityId(calendarChecklistEntityId(subtaskId))).toBe(subtaskId);
  });

  it("returns null for a bare uuid (not prefixed)", () => {
    expect(subtaskIdFromCalendarEntityId("b1f2c3d4-0000-4000-8000-000000000001")).toBeNull();
  });

  it("returns null for a project-deadline entity id", () => {
    expect(subtaskIdFromCalendarEntityId("project-deadline:b1f2c3d4-0000-4000-8000-000000000001")).toBeNull();
  });

  it("returns null for the bare prefix with no remainder", () => {
    expect(subtaskIdFromCalendarEntityId("checklist:")).toBeNull();
  });
});
