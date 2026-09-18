import { describe, expect, it } from "vitest";
import {
  checklistScheduleToDto,
  mapChecklistEndResizeToCommand,
  mapChecklistMoveToCommand,
  mapChecklistStartResizeToCommand,
  mapProjectDeadlineMoveToCommand,
  mapUnscheduledChecklistDropToCommand,
  mapUnscheduledProjectDropToCommand,
  normalizeChecklistSchedule,
  resolveSydneyCivilMinute,
  PRODUCTION_CALENDAR_ZONE,
  type CalendarMappingResult,
  type ChecklistCalendarEventDto,
  type ChecklistCalendarUnscheduledEntryDto,
  type InitialChecklistScheduleInput,
  type ProjectCalendarUnscheduledEntryDto,
  type ProjectDeadlineCalendarEventDto,
  type SaveChecklistScheduleRequest,
  type SaveProjectDeadlineRequest,
} from "@quincy/shared";
import { checkScheduleBounds, planSchedulingProposal, timingFromChecklistSchedule, type SchedulingProposal } from "./scheduling-policy";

/** Independently recomputes the timing a checklist plan should carry, from the SAME public
 * helpers `planSchedulingProposal` itself uses — so the assertion below is not tautological. */
function expectedChecklistTiming(direct: Extract<CalendarMappingResult<SaveChecklistScheduleRequest>, { ok: true }>) {
  const normalized = normalizeChecklistSchedule(direct.value.schedule, direct.value.expectedVersion);
  if (!normalized.ok) throw new Error("fixture schedule failed to normalize");
  return timingFromChecklistSchedule(checklistScheduleToDto(normalized.value));
}

/** Same, for a deadline plan — independently resolves the civil minute the mapper produced. */
function expectedDeadlineTiming(direct: Extract<CalendarMappingResult<SaveProjectDeadlineRequest>, { ok: true }>) {
  if (direct.value.deadline === null) throw new Error("expected a scheduled deadline");
  const resolved = resolveSydneyCivilMinute(direct.value.deadline.localCivil, direct.value.deadline.disambiguation);
  if (!resolved.ok) throw new Error("fixture deadline failed to resolve");
  return { allDay: false as const, start: resolved.value.instant, end: null };
}

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
const rangeSchedule = (start: ReturnType<typeof dateEndpoint> | ReturnType<typeof timedEndpoint>, end: ReturnType<typeof dateEndpoint> | ReturnType<typeof timedEndpoint>, version = 4) => ({ state: "range" as const, version, zone: PRODUCTION_CALENDAR_ZONE, start, end, due: end.localCivil });
const unscheduledSchedule = (version = 4) => ({ state: "unscheduled" as const, version, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: null, due: null });

function checklistEvent(schedule: ReturnType<typeof rangeSchedule>): ChecklistCalendarEventDto<typeof EDITOR_STAGE> {
  const timing = schedule.start.kind === "date"
    ? { allDay: true as const, start: schedule.start.localCivil, end: "2026-08-29" }
    : { allDay: false as const, start: schedule.start.instant!, end: schedule.end.instant };
  return { id: `checklist:${PERSON_ID}`, kind: "checklist", title: "Select hero images", project: project(), assignee: person, timing, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, schedule, permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canScheduleRange: true } };
}

function checklistUnscheduledEntry(): ChecklistCalendarUnscheduledEntryDto<typeof EDITOR_STAGE> {
  return { id: `checklist:${PERSON_ID}`, kind: "checklist", reason: "unscheduled", title: "Select hero images", project: project(), assignee: person, schedule: unscheduledSchedule(), permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true } };
}

function projectEvent(deadlineLocalCivil = "2026-08-27T09:00"): ProjectDeadlineCalendarEventDto<typeof EDITOR_STAGE> {
  return {
    id: `project-deadline:${PROJECT_ID}`,
    kind: "project_deadline",
    title: "Deadline",
    project: project(),
    timing: { allDay: false, start: "2026-08-26T23:00:00.000Z", end: null },
    status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false },
    permissions: { canDrag: true, canResize: false },
    deadlineLocalCivil,
    deadlineVersion: 8,
    reminderOffsetsMinutes: [1440, 60],
  };
}

function projectUnscheduledEntry(): ProjectCalendarUnscheduledEntryDto<typeof EDITOR_STAGE> {
  return { id: `project-deadline:${PROJECT_ID}`, kind: "project_deadline", reason: "unscheduled", title: "Deadline", project: project(), permissions: { canDrag: true, canResize: false }, deadlineVersion: 8, reminderOffsetsMinutes: [] };
}

describe("planSchedulingProposal", () => {
  it("moves a checklist range exactly as mapChecklistMoveToCommand", () => {
    const source = checklistEvent(rangeSchedule(timedEndpoint("2026-10-03T01:30", "2026-10-02T15:30:00.000Z"), timedEndpoint("2026-10-03T03:30", "2026-10-02T17:30:00.000Z")));
    const target = { subview: "month" as const, targetDate: "2026-10-04" };
    const proposal: SchedulingProposal = { kind: "move", entity: "checklist", source, target };
    const plan = planSchedulingProposal(proposal);
    const direct = mapChecklistMoveToCommand({ event: source, target });
    if (!direct.ok) throw new Error("expected mapChecklistMoveToCommand to succeed");
    if (!plan.ok) throw new Error("expected planSchedulingProposal to succeed");
    if (plan.value.kind !== "checklist") throw new Error(`expected a checklist plan, got ${plan.value.kind}`);
    expect(plan.value).toEqual({ kind: "checklist", request: direct.value, schedule: direct.value.schedule, timing: expectedChecklistTiming(direct), warnings: [] });
  });

  it("end-resizes a checklist range exactly as mapChecklistEndResizeToCommand", () => {
    const source = checklistEvent(rangeSchedule(dateEndpoint("2026-08-27"), dateEndpoint("2026-08-27")));
    const target = { subview: "month" as const, targetDate: "2026-08-29" };
    const proposal: SchedulingProposal = { kind: "resize", entity: "checklist", source, edge: "end", target };
    const plan = planSchedulingProposal(proposal);
    const direct = mapChecklistEndResizeToCommand({ event: source, target });
    if (!direct.ok) throw new Error("expected mapChecklistEndResizeToCommand to succeed");
    if (!plan.ok) throw new Error("expected planSchedulingProposal to succeed");
    if (plan.value.kind !== "checklist") throw new Error(`expected a checklist plan, got ${plan.value.kind}`);
    expect(plan.value).toEqual({ kind: "checklist", request: direct.value, schedule: direct.value.schedule, timing: expectedChecklistTiming(direct), warnings: [] });
  });

  it("start-resizes a checklist range exactly as mapChecklistStartResizeToCommand", () => {
    const source = checklistEvent(rangeSchedule(dateEndpoint("2026-08-27"), dateEndpoint("2026-08-29")));
    const target = { subview: "month" as const, targetDate: "2026-08-26" };
    const proposal: SchedulingProposal = { kind: "resize", entity: "checklist", source, edge: "start", target };
    const plan = planSchedulingProposal(proposal);
    const direct = mapChecklistStartResizeToCommand({ event: source, target });
    if (!direct.ok) throw new Error("expected mapChecklistStartResizeToCommand to succeed");
    if (!plan.ok) throw new Error("expected planSchedulingProposal to succeed");
    if (plan.value.kind !== "checklist") throw new Error(`expected a checklist plan, got ${plan.value.kind}`);
    expect(plan.value).toEqual({ kind: "checklist", request: direct.value, schedule: direct.value.schedule, timing: expectedChecklistTiming(direct), warnings: [] });
  });

  it("places an unscheduled checklist entry exactly as mapUnscheduledChecklistDropToCommand", () => {
    const entry = checklistUnscheduledEntry();
    const target = { subview: "month" as const, targetDate: "2026-08-29" };
    const proposal: SchedulingProposal = { kind: "place", entity: "checklist", entry, target };
    const plan = planSchedulingProposal(proposal);
    const direct = mapUnscheduledChecklistDropToCommand({ event: entry, target });
    if (!direct.ok) throw new Error("expected mapUnscheduledChecklistDropToCommand to succeed");
    if (!plan.ok) throw new Error("expected planSchedulingProposal to succeed");
    if (plan.value.kind !== "checklist") throw new Error(`expected a checklist plan, got ${plan.value.kind}`);
    expect(plan.value).toEqual({ kind: "checklist", request: direct.value, schedule: direct.value.schedule, timing: expectedChecklistTiming(direct), warnings: [] });
  });

  it("places an unscheduled project deadline exactly as mapUnscheduledProjectDropToCommand", () => {
    const entry = projectUnscheduledEntry();
    const target = { subview: "month" as const, targetDate: "2026-08-29" };
    const proposal: SchedulingProposal = { kind: "place", entity: "project_deadline", entry, target };
    const plan = planSchedulingProposal(proposal);
    const direct = mapUnscheduledProjectDropToCommand({ event: entry, target });
    if (!direct.ok) throw new Error("expected mapUnscheduledProjectDropToCommand to succeed");
    if (!plan.ok) throw new Error("expected planSchedulingProposal to succeed");
    if (plan.value.kind !== "deadline") throw new Error(`expected a deadline plan, got ${plan.value.kind}`);
    if (direct.value.deadline === null) throw new Error("expected a scheduled deadline");
    expect(plan.value).toEqual({ kind: "deadline", request: direct.value, localCivil: direct.value.deadline.localCivil, timing: expectedDeadlineTiming(direct), warnings: [] });
  });

  it("moves a project deadline exactly as mapProjectDeadlineMoveToCommand", () => {
    const event = projectEvent();
    const target = { subview: "month" as const, targetDate: "2026-08-29" };
    const proposal: SchedulingProposal = { kind: "deadline", entity: "project_deadline", event, target };
    const plan = planSchedulingProposal(proposal);
    const direct = mapProjectDeadlineMoveToCommand({ event, target });
    if (!direct.ok) throw new Error("expected mapProjectDeadlineMoveToCommand to succeed");
    if (!plan.ok) throw new Error("expected planSchedulingProposal to succeed");
    if (plan.value.kind !== "deadline") throw new Error(`expected a deadline plan, got ${plan.value.kind}`);
    if (direct.value.deadline === null) throw new Error("expected a scheduled deadline");
    expect(plan.value).toEqual({ kind: "deadline", request: direct.value, localCivil: direct.value.deadline.localCivil, timing: expectedDeadlineTiming(direct), warnings: [] });
  });

  it("propagates mapper errors unchanged", () => {
    const source = checklistEvent(rangeSchedule(dateEndpoint("2026-08-27"), dateEndpoint("2026-08-29")));
    const target = { subview: "agenda" as const, targetDate: "2026-08-29" };
    const proposal: SchedulingProposal = { kind: "move", entity: "checklist", source, target };
    const plan = planSchedulingProposal(proposal);
    const direct = mapChecklistMoveToCommand({ event: source, target });
    expect(plan).toEqual(direct);
  });

  it("returns no warnings when bounds are null", () => {
    const source = checklistEvent(rangeSchedule(timedEndpoint("2026-08-26T09:00", "2026-08-25T23:00:00.000Z"), timedEndpoint("2026-08-26T11:00", "2026-08-26T01:00:00.000Z")));
    const target = { subview: "week" as const, targetDate: "2026-08-26", targetCivilMinute: "2026-08-26T08:00" };
    const proposal: SchedulingProposal = { kind: "move", entity: "checklist", source, target };
    const plan = planSchedulingProposal(proposal, { bounds: null });
    expect(plan.ok).toBe(true);
    if (plan.ok && plan.value.kind === "checklist") expect(plan.value.warnings).toEqual([]);
  });

  it("warns after the project deadline", () => {
    const source = checklistEvent(rangeSchedule(dateEndpoint("2026-08-27"), dateEndpoint("2026-08-29")));
    const target = { subview: "month" as const, targetDate: "2026-08-27" };
    const proposal: SchedulingProposal = { kind: "move", entity: "checklist", source, target };
    const plan = planSchedulingProposal(proposal, { bounds: { shootDate: null, deadlineLocalCivil: "2026-08-28T17:00" } });
    expect(plan.ok).toBe(true);
    if (plan.ok && plan.value.kind === "checklist") expect(plan.value.warnings).toEqual([{ code: "subtask_after_project_deadline", message: "This subtask ends after the project deadline.", endpoint: "end" }]);
  });

  it("never warns before the shoot when shootDate is null", () => {
    const source = checklistEvent(rangeSchedule(dateEndpoint("2026-08-27"), dateEndpoint("2026-08-29")));
    const target = { subview: "month" as const, targetDate: "2026-08-01" };
    const proposal: SchedulingProposal = { kind: "move", entity: "checklist", source, target };
    const plan = planSchedulingProposal(proposal, { bounds: { shootDate: null, deadlineLocalCivil: null } });
    expect(plan.ok).toBe(true);
    if (plan.ok && plan.value.kind === "checklist") expect(plan.value.warnings).toEqual([]);
  });

  it("warns before the shoot date when present", () => {
    const source = checklistEvent(rangeSchedule(dateEndpoint("2026-08-27"), dateEndpoint("2026-08-29")));
    const target = { subview: "month" as const, targetDate: "2026-08-01" };
    const proposal: SchedulingProposal = { kind: "move", entity: "checklist", source, target };
    const plan = planSchedulingProposal(proposal, { bounds: { shootDate: "2026-08-10", deadlineLocalCivil: null } });
    expect(plan.ok).toBe(true);
    if (plan.ok && plan.value.kind === "checklist") expect(plan.value.warnings).toEqual([{ code: "subtask_before_project_shoot", message: "This subtask starts before the shoot date.", endpoint: "start" }]);
  });

  it("a warning is never a rejection (ok stays true)", () => {
    const source = checklistEvent(rangeSchedule(dateEndpoint("2026-08-27"), dateEndpoint("2026-08-29")));
    const target = { subview: "month" as const, targetDate: "2026-08-01" };
    const proposal: SchedulingProposal = { kind: "move", entity: "checklist", source, target };
    const plan = planSchedulingProposal(proposal, { bounds: { shootDate: "2026-08-10", deadlineLocalCivil: "2026-08-15T09:00" } });
    expect(plan.ok).toBe(true);
  });
});

describe("checkScheduleBounds", () => {
  it("returns [] for null bounds", () => {
    expect(checkScheduleBounds({ state: "unscheduled" }, null)).toEqual([]);
  });

  const afterDeadlineWarning = { code: "subtask_after_project_deadline" as const, message: "This subtask ends after the project deadline.", endpoint: "end" as const };
  const beforeShootWarning = { code: "subtask_before_project_shoot" as const, message: "This subtask starts before the shoot date.", endpoint: "start" as const };

  it("a timed end exactly at the deadline minute does not warn", () => {
    const schedule: InitialChecklistScheduleInput = { state: "due_only", end: { kind: "timed", localCivil: "2026-08-28T17:00" } };
    expect(checkScheduleBounds(schedule, { shootDate: null, deadlineLocalCivil: "2026-08-28T17:00" })).toEqual([]);
  });

  it("a timed end one minute after the deadline warns", () => {
    const schedule: InitialChecklistScheduleInput = { state: "due_only", end: { kind: "timed", localCivil: "2026-08-28T17:01" } };
    expect(checkScheduleBounds(schedule, { shootDate: null, deadlineLocalCivil: "2026-08-28T17:00" })).toEqual([afterDeadlineWarning]);
  });

  it("a date-only end on the deadline's own date does not warn", () => {
    const schedule: InitialChecklistScheduleInput = { state: "due_only", end: { kind: "date", localCivil: "2026-08-28" } };
    expect(checkScheduleBounds(schedule, { shootDate: null, deadlineLocalCivil: "2026-08-28T17:00" })).toEqual([]);
  });

  it("a date-only end the day after the deadline's date warns", () => {
    const schedule: InitialChecklistScheduleInput = { state: "due_only", end: { kind: "date", localCivil: "2026-08-29" } };
    expect(checkScheduleBounds(schedule, { shootDate: null, deadlineLocalCivil: "2026-08-28T17:00" })).toEqual([afterDeadlineWarning]);
  });

  it("a date-only start on the shoot date does not warn (shootDate is date-only — no timed-exact case applies)", () => {
    const schedule: InitialChecklistScheduleInput = { state: "range", start: { kind: "date", localCivil: "2026-08-10" }, end: { kind: "date", localCivil: "2026-08-12" } };
    expect(checkScheduleBounds(schedule, { shootDate: "2026-08-10", deadlineLocalCivil: null })).toEqual([]);
  });

  it("a timed start on the shoot date does not warn (compares dates only, never the time)", () => {
    const schedule: InitialChecklistScheduleInput = { state: "range", start: { kind: "timed", localCivil: "2026-08-10T00:01" }, end: { kind: "timed", localCivil: "2026-08-10T01:00" } };
    expect(checkScheduleBounds(schedule, { shootDate: "2026-08-10", deadlineLocalCivil: null })).toEqual([]);
  });

  it("a start the day before the shoot date warns", () => {
    const schedule: InitialChecklistScheduleInput = { state: "range", start: { kind: "date", localCivil: "2026-08-09" }, end: { kind: "date", localCivil: "2026-08-12" } };
    expect(checkScheduleBounds(schedule, { shootDate: "2026-08-10", deadlineLocalCivil: null })).toEqual([beforeShootWarning]);
  });

  it("compares lexicographically across the April Sydney DST fold, not chronologically (2026-04-05T02:30)", () => {
    // Lexicographic string comparison, per the function's own contract — it never resolves the
    // civil string to an instant, so an ambiguous (repeated) Sydney civil time is handled exactly
    // like any other string, with no fold/gap resolution involved.
    const schedule: InitialChecklistScheduleInput = { state: "due_only", end: { kind: "timed", localCivil: "2026-04-05T02:31" } };
    expect(checkScheduleBounds(schedule, { shootDate: null, deadlineLocalCivil: "2026-04-05T02:30" })).toEqual([afterDeadlineWarning]);
  });

  it("compares lexicographically across the October Sydney DST gap, not chronologically (2026-10-04T02:30)", () => {
    // 2026-10-04T02:30 never occurs on a real Sydney clock (the gap), but the bounds check works
    // on the plain civil string, so a nonexistent local time is still valid input here.
    const schedule: InitialChecklistScheduleInput = { state: "due_only", end: { kind: "timed", localCivil: "2026-10-04T02:29" } };
    expect(checkScheduleBounds(schedule, { shootDate: null, deadlineLocalCivil: "2026-10-04T02:30" })).toEqual([]);
  });
});
