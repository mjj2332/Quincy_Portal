/**
 * #288 — the ONE out-of-range schedule warning rule, pinned through BOTH surface paths. Every row
 * runs:
 *   - the Gantt path: a `GanttProjectRowDto` → `ganttScheduleBounds` → `scheduleWindowWarnings` →
 *     `scheduleWarningText`, and
 *   - the Calendar path: a `ProductionCalendarProjectBounds` parsed through the shared admin
 *     range-response schema (`rangeResponse`) → `calendarScheduleBounds` → the same rule → text,
 * and asserts both warning arrays and both texts equal each other AND the expected value.
 *
 * DST fixtures are real Sydney transitions: Sunday 5 April 2026 is the AEDT→AEST fall-back (02:00–
 * 02:59 repeats); Sunday 4 October 2026 is the AEST→AEDT spring-forward (02:00–02:59 never occurs).
 * The rule compares civil strings, never instants, so neither needs resolution here.
 */
import { describe, expect, it } from "vitest";
import type { GanttProjectRowDto, RangeChecklistScheduleInput, ProductionCalendarProjectBounds } from "@quincy/shared";
import { ganttScheduleBounds } from "./production-gantt-scheduling";
import {
  beforeLowerBound,
  calendarScheduleBounds,
  endsAfterDeadline,
  scheduleBoundsFrom,
  scheduleWarningText,
  scheduleWindowWarnings,
  type SchedulingWarning,
} from "./schedule-bounds";
import { PROJECT_ID, rangeResponse } from "../testing/production-calendar-fixtures";

const SHOOT = "2026-05-01";
const CREATED = "2026-01-01T00:00:00.000Z";
const DEADLINE = "2026-06-01T15:00";

type Bounds = { shoot: string | null; createdAt: string; deadline: string | null };

function ganttProject(bounds: Bounds): GanttProjectRowDto {
  return {
    id: PROJECT_ID,
    street: "1 Test St",
    suburb: null,
    agencyName: null,
    agentName: null,
    stageKey: "awaiting_raw",
    delivered: false,
    archived: false,
    shootDate: bounds.shoot,
    shootDateCivil: bounds.shoot,
    createdAt: bounds.createdAt,
    barStartDate: bounds.shoot ?? bounds.createdAt.slice(0, 10),
    // Only `localCivil` feeds the rule; `at` is not read.
    deadline: bounds.deadline ? { at: "2026-06-01T05:00:00.000Z", localCivil: bounds.deadline, version: 3, reminderOffsetsMinutes: [], overdue: false } : null,
    deadlineVersion: 3,
    editors: [],
    checklist: { completed: 0, total: 1 },
    permissions: { canEditDeadline: true, canEditChildren: true },
    children: { rows: [], total: 0, returned: 0, truncated: false, nextCursor: null },
  };
}

/** The Calendar's bounds DTO, round-tripped through the strict shared response schema. */
function calendarBounds(bounds: Bounds): ProductionCalendarProjectBounds {
  const raw: ProductionCalendarProjectBounds = { projectId: PROJECT_ID, shootDate: bounds.shoot, createdAt: bounds.createdAt, deadlineLocalCivil: bounds.deadline, deadlineFold: bounds.deadline ? 0 : null };
  const parsed = rangeResponse({ projectBounds: [raw] }).projectBounds?.[0];
  if (!parsed) throw new Error("expected parsed projectBounds");
  return parsed;
}

function bothPaths(bounds: Bounds, schedule: RangeChecklistScheduleInput) {
  const ganttWarnings = scheduleWindowWarnings(schedule, ganttScheduleBounds(ganttProject(bounds)));
  const calendarWarnings = scheduleWindowWarnings(schedule, calendarScheduleBounds(calendarBounds(bounds)));
  return { ganttWarnings, calendarWarnings, ganttText: scheduleWarningText(ganttWarnings), calendarText: scheduleWarningText(calendarWarnings) };
}

// Every end is a moment (ADR 0016): a bare day stands for its preset moment, 09:00 as a start and 17:00 as an end.
const date = (day: string) => ({ localCivil: day, bare: true as const });
const timed = (localCivil: string) => ({ localCivil, bare: false as const });
type Moment = ReturnType<typeof date> | ReturnType<typeof timed>;
const range = (start: Moment, end: Moment): RangeChecklistScheduleInput => ({
  state: "range",
  start: { localCivil: start.bare ? `${start.localCivil}T09:00` : start.localCivil },
  end: { localCivil: end.bare ? `${end.localCivil}T17:00` : end.localCivil },
});

const W = {
  startsBeforeShoot: { code: "subtask_before_project_shoot", message: "Starts before the shoot date.", endpoint: "start" },
  startsBeforeCreated: { code: "subtask_before_project_created", message: "Starts before the project was created.", endpoint: "start" },
  endsAfterDeadline: { code: "subtask_after_project_deadline", message: "Ends after the project deadline.", endpoint: "end" },
} satisfies Record<string, SchedulingWarning>;

type Row = { name: string; bounds: Partial<Bounds>; schedule: RangeChecklistScheduleInput; expected: SchedulingWarning[]; text: string | null };

const ROWS: Row[] = [
  // Lower bound: the shoot date.
  { name: "range starting 1 day before the shoot", bounds: {}, schedule: range(date("2026-04-30"), date("2026-05-02")), expected: [W.startsBeforeShoot], text: "Starts before the shoot date." },
  { name: "date start ON the shoot date", bounds: {}, schedule: range(date(SHOOT), date("2026-05-03")), expected: [], text: null },
  { name: "timed start 00:01 on the shoot day (date compare, never the time)", bounds: {}, schedule: range(timed("2026-05-01T00:01"), timed("2026-05-01T02:00")), expected: [], text: null },
  // Lower bound: no shoot date → the Sydney civil creation date.
  { name: "range, no shoot date, starting before the created date", bounds: { shoot: null, createdAt: "2026-05-01T00:00:00.000Z" }, schedule: range(date("2026-04-30"), date("2026-05-02")), expected: [W.startsBeforeCreated], text: "Starts before the project was created." },
  { name: "created date is SYDNEY civil, not UTC (2026-01-01T14:00Z is Sydney 2026-01-02)", bounds: { shoot: null, createdAt: "2026-01-01T14:00:00.000Z" }, schedule: range(date("2026-01-01"), date("2026-01-03")), expected: [W.startsBeforeCreated], text: "Starts before the project was created." },
  { name: "on the Sydney created date itself", bounds: { shoot: null, createdAt: "2026-01-01T14:00:00.000Z" }, schedule: range(date("2026-01-02"), date("2026-01-03")), expected: [], text: null },
  // Upper bound: the deadline.
  { name: "timed end == the deadline minute", bounds: { deadline: DEADLINE }, schedule: range(timed("2026-05-10T09:00"), timed("2026-06-01T15:00")), expected: [], text: null },
  { name: "timed end 1 minute after the deadline", bounds: { deadline: DEADLINE }, schedule: range(timed("2026-05-10T09:00"), timed("2026-06-01T15:01")), expected: [W.endsAfterDeadline], text: "Ends after the project deadline." },
  { name: "timed end 1 minute after the deadline (starting the same day)", bounds: { deadline: DEADLINE }, schedule: range(timed("2026-06-01T09:00"), timed("2026-06-01T15:01")), expected: [W.endsAfterDeadline], text: "Ends after the project deadline." },
  { name: "end on the deadline day, at the deadline minute", bounds: { deadline: DEADLINE }, schedule: range(date("2026-05-31"), timed("2026-06-01T15:00")), expected: [], text: null },
  { name: "date end the day after the deadline (one-day range)", bounds: { deadline: DEADLINE }, schedule: range(date("2026-06-01"), date("2026-06-02")), expected: [W.endsAfterDeadline], text: "Ends after the project deadline." },
  { name: "date end the day after the deadline (range)", bounds: { deadline: DEADLINE }, schedule: range(date("2026-05-10"), date("2026-06-02")), expected: [W.endsAfterDeadline], text: "Ends after the project deadline." },
  { name: "date-only deadline (no T) vs a timed end at 23:00 the same day", bounds: { deadline: "2026-06-01" }, schedule: range(timed("2026-06-01T09:00"), timed("2026-06-01T23:00")), expected: [], text: null },
  { name: "date-only deadline vs a timed end the next day", bounds: { deadline: "2026-06-01" }, schedule: range(timed("2026-06-01T09:00"), timed("2026-06-02T00:00")), expected: [W.endsAfterDeadline], text: "Ends after the project deadline." },
  // DST: civil-string comparisons across the fold and the gap.
  { name: "DST fold 2026-04-05: end 02:30 vs deadline 02:30", bounds: { shoot: "2026-04-01", deadline: "2026-04-05T02:30" }, schedule: range(timed("2026-04-05T01:00"), timed("2026-04-05T02:30")), expected: [], text: null },
  { name: "DST fold 2026-04-05: end 02:31 vs deadline 02:30", bounds: { shoot: "2026-04-01", deadline: "2026-04-05T02:30" }, schedule: range(timed("2026-04-05T01:00"), timed("2026-04-05T02:31")), expected: [W.endsAfterDeadline], text: "Ends after the project deadline." },
  { name: "DST fold 2026-04-05: date end vs timed deadline, next day warns", bounds: { shoot: "2026-04-01", deadline: "2026-04-05T02:30" }, schedule: range(date("2026-04-05"), date("2026-04-06")), expected: [W.endsAfterDeadline], text: "Ends after the project deadline." },
  { name: "DST gap 2026-10-04: end 02:29 vs deadline 02:30", bounds: { shoot: "2026-10-01", deadline: "2026-10-04T02:30" }, schedule: range(timed("2026-10-04T01:00"), timed("2026-10-04T02:29")), expected: [], text: null },
  { name: "DST gap 2026-10-04: end 03:00 vs deadline 03:00", bounds: { shoot: "2026-10-01", deadline: "2026-10-04T03:00" }, schedule: range(timed("2026-10-04T01:00"), timed("2026-10-04T03:00")), expected: [], text: null },
  { name: "DST gap 2026-10-04: end 03:01 vs deadline 03:00", bounds: { shoot: "2026-10-01", deadline: "2026-10-04T03:00" }, schedule: range(timed("2026-10-04T01:00"), timed("2026-10-04T03:01")), expected: [W.endsAfterDeadline], text: "Ends after the project deadline." },
  // Both at once: start warning first, then end; text joined by one space.
  { name: "before the shoot AND after the deadline", bounds: { deadline: DEADLINE }, schedule: range(date("2026-04-01"), date("2026-07-01")), expected: [W.startsBeforeShoot, W.endsAfterDeadline], text: "Starts before the shoot date. Ends after the project deadline." },
  // Nothing to check.
  { name: "no deadline → no upper warning", bounds: {}, schedule: range(date("2030-01-01"), date("2030-01-02")), expected: [], text: null },
];

describe("scheduleWindowWarnings — one rule, both surfaces", () => {
  it.each(ROWS)("$name", ({ bounds, schedule, expected, text }) => {
    const full: Bounds = { shoot: SHOOT, createdAt: CREATED, deadline: null, ...bounds };
    const result = bothPaths(full, schedule);
    expect(result.ganttWarnings).toEqual(result.calendarWarnings);
    expect(result.ganttText).toBe(result.calendarText);
    expect(result.ganttWarnings).toEqual(expected);
    expect(result.ganttText).toBe(text);
  });

  it("null bounds → [] and no text", () => {
    const warnings = scheduleWindowWarnings(range(date("2000-01-01"), date("2099-01-01")), null);
    expect(warnings).toEqual([]);
    expect(scheduleWarningText(warnings)).toBeNull();
  });

  it("no lower bound and no deadline → []", () => {
    expect(scheduleWindowWarnings(range(date("2000-01-01"), date("2000-01-02")), { lower: null, deadlineLocalCivil: null })).toEqual([]);
  });
});

describe("scheduleBoundsFrom", () => {
  it("prefers the shoot date as the lower bound", () => {
    expect(scheduleBoundsFrom({ shootDateCivil: SHOOT, createdAt: CREATED, deadlineLocalCivil: DEADLINE })).toEqual({ lower: { civilDate: SHOOT, kind: "shoot" }, deadlineLocalCivil: DEADLINE });
  });

  it("falls back to the Sydney civil date of createdAt (not the UTC date)", () => {
    // 2026-01-01T14:00Z is 2026-01-02T01:00 in Sydney (AEDT, +11).
    expect(scheduleBoundsFrom({ shootDateCivil: null, createdAt: "2026-01-01T14:00:00.000Z", deadlineLocalCivil: null }).lower).toEqual({ civilDate: "2026-01-02", kind: "created" });
  });

  it("has a null lower bound when createdAt is unparseable or absent, and a null deadline when there is none", () => {
    expect(scheduleBoundsFrom({ shootDateCivil: null, createdAt: "garbage", deadlineLocalCivil: null })).toEqual({ lower: null, deadlineLocalCivil: null });
    expect(scheduleBoundsFrom({ shootDateCivil: null, createdAt: null, deadlineLocalCivil: null })).toEqual({ lower: null, deadlineLocalCivil: null });
  });

  it("ganttScheduleBounds and calendarScheduleBounds agree for the same project", () => {
    const bounds: Bounds = { shoot: null, createdAt: "2026-01-01T14:00:00.000Z", deadline: DEADLINE };
    expect(ganttScheduleBounds(ganttProject(bounds))).toEqual(calendarScheduleBounds(calendarBounds(bounds)));
    expect(ganttScheduleBounds(ganttProject(bounds))).toEqual({ lower: { civilDate: "2026-01-02", kind: "created" }, deadlineLocalCivil: DEADLINE });
  });
});

describe("beforeLowerBound / endsAfterDeadline", () => {
  it("beforeLowerBound compares civil DATES; no lower bound is never before", () => {
    expect(beforeLowerBound("2026-04-30T23:59", { civilDate: SHOOT, kind: "shoot" })).toBe(true);
    expect(beforeLowerBound("2026-05-01T00:00", { civilDate: SHOOT, kind: "shoot" })).toBe(false);
    expect(beforeLowerBound("2000-01-01", null)).toBe(false);
  });

  it("endsAfterDeadline goes by minute, and by date only for a legacy date-only Deadline", () => {
    expect(endsAfterDeadline(timed("2026-06-01T15:01"), DEADLINE)).toBe(true);
    expect(endsAfterDeadline(timed("2026-06-01T15:00"), DEADLINE)).toBe(false);
    expect(endsAfterDeadline(timed("2026-06-01T17:00"), DEADLINE)).toBe(true);
    expect(endsAfterDeadline(timed("2026-06-01T23:00"), "2026-06-01")).toBe(false);
    expect(endsAfterDeadline(timed("2026-06-02T00:00"), "2026-06-01")).toBe(true);
    expect(endsAfterDeadline(timed("2099-01-01T17:00"), null)).toBe(false);
  });
});

describe("scheduleWarningText", () => {
  it("joins messages with one space, or returns null for none", () => {
    expect(scheduleWarningText([])).toBeNull();
    expect(scheduleWarningText([W.startsBeforeShoot, W.endsAfterDeadline])).toBe("Starts before the shoot date. Ends after the project deadline.");
  });
});
