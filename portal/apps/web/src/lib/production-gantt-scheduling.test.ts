/**
 * #221 PR B1 — the pure Gantt → scheduling-controller bridge. Node test, no DOM.
 *
 * DST fixtures are real Sydney transitions: Sunday 5 April 2026 is the AEDT→AEST fall-back (25h
 * day); Sunday 4 October 2026 is the AEST→AEDT spring-forward (23h day). AEST is UTC+10, AEDT
 * UTC+11.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  ChecklistCalendarEventDto,
  ChecklistCalendarUnscheduledEntryDto,
  ChecklistScheduleDto,
  ChecklistScheduleEndpointDto,
  GanttChecklistRowDto,
  GanttProjectDeadlineDto,
  GanttProjectRowDto,
  ProjectDeadlineCalendarEventDto,
} from "@quincy/shared";
import { buildProductionGanttModel } from "./production-gantt-adapter";
import { planSchedulingProposal } from "./scheduling-policy";
import {
  applyGanttOptimisticOverlay,
  ganttChecklistSource,
  ganttDeadlineEditToProposal,
  ganttDeadlineEntry,
  ganttDeadlineEvent,
  ganttDropWarningText,
  ganttEditToProposal,
  ganttPlacementToProposal,
  ganttDeadlineDropWarning,
  ganttScheduleBounds,
  previewDeadlineEffects,
  scheduleWindowWarnings,
  type GanttEdit,
} from "./production-gantt-scheduling";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = "11111111-1111-4111-8111-000000000001";
const TASK_ID = "22222222-2222-4222-8222-000000000001";
const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date("2026-06-15T00:00:00.000Z");

function makeDeadline(overrides: Partial<NonNullable<GanttProjectDeadlineDto>> = {}): GanttProjectDeadlineDto {
  return { at: "2026-06-01T05:00:00.000Z", localCivil: "2026-06-01T15:00", version: 3, reminderOffsetsMinutes: [60, 1440], overdue: false, ...overrides };
}

function dateEndpoint(localCivil: string): ChecklistScheduleEndpointDto {
  return { kind: "date", localCivil, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" };
}

function timedEndpoint(localCivil: string, instant: string, utcOffsetMinutes: number, fold: 0 | 1 = 0): ChecklistScheduleEndpointDto {
  return { kind: "timed", localCivil, instant, utcOffsetMinutes, fold, resolution: "stored" };
}

function unscheduledSchedule(): ChecklistScheduleDto {
  return { state: "unscheduled", version: 4, zone: "Australia/Sydney", start: null, end: null, due: null };
}

function dueOnlySchedule(end: ChecklistScheduleEndpointDto): ChecklistScheduleDto {
  return { state: "due_only", version: 4, zone: "Australia/Sydney", start: null, end, due: end.instant ?? end.localCivil };
}

function rangeSchedule(start: ChecklistScheduleEndpointDto, end: ChecklistScheduleEndpointDto): ChecklistScheduleDto {
  return { state: "range", version: 4, zone: "Australia/Sydney", start, end, due: end.instant ?? end.localCivil };
}

function makeTask(overrides: Partial<GanttChecklistRowDto> = {}): GanttChecklistRowDto {
  return {
    id: TASK_ID,
    projectId: PROJECT_ID,
    title: "Edit photos",
    done: false,
    position: 1,
    assignee: { id: "33333333-3333-4333-8333-000000000001", name: "Ed", roleLabel: "Editor", isExternal: false, active: true },
    schedule: unscheduledSchedule(),
    permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canScheduleRange: true },
    ...overrides,
  };
}

function makeProject(overrides: Partial<GanttProjectRowDto> = {}): GanttProjectRowDto {
  return {
    id: PROJECT_ID,
    street: "1 Test St",
    suburb: null,
    agencyName: null,
    agentName: null,
    stageKey: "awaiting_raw",
    delivered: false,
    shootDate: "2026-05-01",
    shootDateCivil: "2026-05-01",
    createdAt: "2026-01-01T00:00:00.000Z",
    barStartDate: "2026-05-01",
    deadline: makeDeadline(),
    deadlineVersion: 3,
    editors: [],
    checklist: { completed: 1, total: 4 },
    permissions: { canEditDeadline: true, canEditChildren: true },
    children: { rows: [], total: 0, returned: 0, truncated: false, nextCursor: null },
    ...overrides,
  };
}

function eventSource(row: GanttChecklistRowDto, project = makeProject()): ChecklistCalendarEventDto {
  const source = ganttChecklistSource(project, row);
  if (!source || !("timing" in source)) throw new Error("expected a scheduled checklist event");
  return source;
}

function edit(overrides: Partial<GanttEdit> & Pick<GanttEdit, "kind" | "eventStart" | "eventEnd">): GanttEdit {
  return { proposedStart: overrides.eventStart, proposedEnd: overrides.eventEnd, scale: "week", ...overrides };
}

// Sydney 2026-06-10 is AEST (+10).
const JUNE_TIMED_RANGE = rangeSchedule(
  timedEndpoint("2026-06-10T09:00", "2026-06-09T23:00:00.000Z", 600),
  timedEndpoint("2026-06-10T11:00", "2026-06-10T01:00:00.000Z", 600),
);
const JUNE_DATE_RANGE = rangeSchedule(dateEndpoint("2026-06-10"), dateEndpoint("2026-06-12"));

// ---------------------------------------------------------------------------
// ganttChecklistSource
// ---------------------------------------------------------------------------

describe("ganttChecklistSource", () => {
  it("maps a range row to a ChecklistCalendarEventDto with the Calendar entity id and project context", () => {
    const project = makeProject({ delivered: true });
    const row = makeTask({ schedule: JUNE_TIMED_RANGE, done: true, permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: false } });
    const source = ganttChecklistSource(project, row);
    expect(source).toEqual({
      id: `checklist:${TASK_ID}`,
      kind: "checklist",
      title: "Edit photos",
      project: { id: PROJECT_ID, street: "1 Test St", stageKey: "awaiting_raw", checklist: { completed: 1, total: 4 }, delivered: true },
      assignee: row.assignee,
      timing: { allDay: false, start: "2026-06-09T23:00:00.000Z", end: "2026-06-10T01:00:00.000Z" },
      status: { overdue: false, delivered: true, completed: true, sameAssigneeOverlap: false },
      schedule: row.schedule,
      permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: false },
    });
    expect(source!.project.checklist).not.toBe(project.checklist);
  });

  it("forces canResize false on a due_only row", () => {
    const row = makeTask({ schedule: dueOnlySchedule(dateEndpoint("2026-06-10")) });
    const source = eventSource(row);
    expect(source.timing).toEqual({ allDay: true, start: "2026-06-10", end: null });
    expect(source.permissions).toEqual({ canDrag: true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true });
  });

  it("maps an all-day range to an exclusive-end timing", () => {
    expect(eventSource(makeTask({ schedule: JUNE_DATE_RANGE })).timing).toEqual({ allDay: true, start: "2026-06-10", end: "2026-06-13" });
  });

  it("maps an unscheduled row to an unscheduled entry with canResize false", () => {
    const source = ganttChecklistSource(makeProject(), makeTask());
    expect(source).toEqual({
      id: `checklist:${TASK_ID}`,
      kind: "checklist",
      reason: "unscheduled",
      title: "Edit photos",
      project: { id: PROJECT_ID, street: "1 Test St", stageKey: "awaiting_raw", checklist: { completed: 1, total: 4 }, delivered: false },
      assignee: makeTask().assignee,
      schedule: unscheduledSchedule(),
      permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true },
    });
  });

  it("returns null for legacy_unresolved and invalid rows", () => {
    const legacy: ChecklistScheduleDto = { state: "legacy_unresolved", version: 0, zone: "Australia/Sydney", start: null, end: null, due: "2026-04-05T02:30", error: { code: "subtask_schedule_legacy_unresolved", reason: "repeated_local_time" } };
    const invalid: ChecklistScheduleDto = { state: "invalid", version: 1, zone: null, start: null, end: null, due: null, error: { code: "subtask_schedule_storage_invalid", reason: "shape_mismatch" } };
    expect(ganttChecklistSource(makeProject(), makeTask({ schedule: legacy }))).toBeNull();
    expect(ganttChecklistSource(makeProject(), makeTask({ schedule: invalid }))).toBeNull();
  });

  it("returns null for a due_only row with no end endpoint (timing unresolvable)", () => {
    const broken = dueOnlySchedule({ kind: "timed", localCivil: "2026-06-10T09:00", instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" });
    expect(ganttChecklistSource(makeProject(), makeTask({ schedule: { ...broken, end: null } as ChecklistScheduleDto }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Deadline event / entry
// ---------------------------------------------------------------------------

describe("ganttDeadlineEvent / ganttDeadlineEntry", () => {
  it("maps a project with a deadline to a ProjectDeadlineCalendarEventDto", () => {
    const project = makeProject({ deadline: makeDeadline({ overdue: true }), permissions: { canEditDeadline: false, canEditChildren: true } });
    const event = ganttDeadlineEvent(project);
    expect(event).toEqual({
      id: `project-deadline:${PROJECT_ID}`,
      kind: "project_deadline",
      title: "1 Test St",
      project: { id: PROJECT_ID, street: "1 Test St", stageKey: "awaiting_raw", checklist: { completed: 1, total: 4 }, delivered: false },
      timing: { allDay: false, start: "2026-06-01T05:00:00.000Z", end: null },
      status: { overdue: true, delivered: false, completed: false, sameAssigneeOverlap: false },
      permissions: { canDrag: false, canResize: false },
      deadlineLocalCivil: "2026-06-01T15:00",
      deadlineVersion: 3,
      reminderOffsetsMinutes: [60, 1440],
    });
    expect(event!.reminderOffsetsMinutes).not.toBe(project.deadline!.reminderOffsetsMinutes);
  });

  it("returns null for a project with no deadline", () => {
    expect(ganttDeadlineEvent(makeProject({ deadline: null }))).toBeNull();
  });

  it("maps a no-deadline project to an unscheduled entry carrying deadlineVersion", () => {
    expect(ganttDeadlineEntry(makeProject({ deadline: null, deadlineVersion: 7 }))).toEqual({
      id: `project-deadline:${PROJECT_ID}`,
      kind: "project_deadline",
      reason: "unscheduled",
      title: "1 Test St",
      project: { id: PROJECT_ID, street: "1 Test St", stageKey: "awaiting_raw", checklist: { completed: 1, total: 4 }, delivered: false },
      permissions: { canDrag: true, canResize: false },
      deadlineVersion: 7,
      reminderOffsetsMinutes: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Bounds + warnings
// ---------------------------------------------------------------------------

describe("ganttScheduleBounds", () => {
  it("prefers the shoot date as the lower bound", () => {
    expect(ganttScheduleBounds(makeProject())).toEqual({ lower: { civilDate: "2026-05-01", kind: "shoot" }, deadlineLocalCivil: "2026-06-01T15:00" });
  });

  it("falls back to the Sydney civil date of createdAt (not the UTC date)", () => {
    // 2026-01-01T14:00Z is 2026-01-02T01:00 in Sydney (AEDT, +11).
    const bounds = ganttScheduleBounds(makeProject({ shootDateCivil: null, createdAt: "2026-01-01T14:00:00.000Z" }));
    expect(bounds.lower).toEqual({ civilDate: "2026-01-02", kind: "created" });
  });

  it("has a null lower bound when createdAt is unparseable, and a null deadline when there is none", () => {
    expect(ganttScheduleBounds(makeProject({ shootDateCivil: null, createdAt: "garbage", deadline: null }))).toEqual({ lower: null, deadlineLocalCivil: null });
  });
});

describe("scheduleWindowWarnings", () => {
  const shoot = { lower: { civilDate: "2026-05-01", kind: "shoot" as const }, deadlineLocalCivil: "2026-06-01T15:00" };
  const created = { lower: { civilDate: "2026-05-01", kind: "created" as const }, deadlineLocalCivil: null };

  it("warns on a range that starts before the shoot date", () => {
    expect(scheduleWindowWarnings({ state: "range", start: { kind: "date", localCivil: "2026-04-30" }, end: { kind: "date", localCivil: "2026-05-02" } }, shoot)).toEqual([
      { code: "subtask_before_project_shoot", message: "Starts before the shoot date.", endpoint: "start" },
    ]);
  });

  it("compares the lower bound by date only (same day, earlier time is fine)", () => {
    expect(scheduleWindowWarnings({ state: "range", start: { kind: "timed", localCivil: "2026-05-01T00:15" }, end: { kind: "timed", localCivil: "2026-05-01T02:00" } }, shoot)).toEqual([]);
  });

  it("warns on a due_only before the shoot date at the end endpoint", () => {
    expect(scheduleWindowWarnings({ state: "due_only", end: { kind: "timed", localCivil: "2026-04-30T23:59" } }, shoot)).toEqual([
      { code: "subtask_before_project_shoot", message: "Due before the shoot date.", endpoint: "end" },
    ]);
  });

  it("uses the created-date wording and code for a created lower bound", () => {
    expect(scheduleWindowWarnings({ state: "range", start: { kind: "date", localCivil: "2026-04-01" }, end: { kind: "date", localCivil: "2026-04-02" } }, created)).toEqual([
      { code: "subtask_before_project_created", message: "Starts before the project was created.", endpoint: "start" },
    ]);
    expect(scheduleWindowWarnings({ state: "due_only", end: { kind: "date", localCivil: "2026-04-01" } }, created)).toEqual([
      { code: "subtask_before_project_created", message: "Due before the project was created.", endpoint: "end" },
    ]);
  });

  it("timed end strictly after the deadline minute warns; equal is fine", () => {
    expect(scheduleWindowWarnings({ state: "range", start: { kind: "timed", localCivil: "2026-05-10T09:00" }, end: { kind: "timed", localCivil: "2026-06-01T15:00" } }, shoot)).toEqual([]);
    expect(scheduleWindowWarnings({ state: "range", start: { kind: "timed", localCivil: "2026-05-10T09:00" }, end: { kind: "timed", localCivil: "2026-06-01T15:15" } }, shoot)).toEqual([
      { code: "subtask_after_project_deadline", message: "Ends after the project deadline.", endpoint: "end" },
    ]);
    expect(scheduleWindowWarnings({ state: "due_only", end: { kind: "timed", localCivil: "2026-06-01T15:01" } }, shoot)).toEqual([
      { code: "subtask_after_project_deadline", message: "Due after the project deadline.", endpoint: "end" },
    ]);
  });

  it("date-kind end compares by date: the deadline's own day is fine, the next day warns", () => {
    expect(scheduleWindowWarnings({ state: "due_only", end: { kind: "date", localCivil: "2026-06-01" } }, shoot)).toEqual([]);
    expect(scheduleWindowWarnings({ state: "range", start: { kind: "date", localCivil: "2026-05-10" }, end: { kind: "date", localCivil: "2026-06-02" } }, shoot)).toEqual([
      { code: "subtask_after_project_deadline", message: "Ends after the project deadline.", endpoint: "end" },
    ]);
  });

  it("no deadline → no upper warning; no lower bound → no lower warning; unscheduled → nothing", () => {
    expect(scheduleWindowWarnings({ state: "due_only", end: { kind: "date", localCivil: "2030-01-01" } }, created)).toEqual([]);
    expect(scheduleWindowWarnings({ state: "due_only", end: { kind: "date", localCivil: "2000-01-01" } }, { lower: null, deadlineLocalCivil: null })).toEqual([]);
    expect(scheduleWindowWarnings({ state: "unscheduled" }, shoot)).toEqual([]);
  });

  it("can warn on both ends at once", () => {
    const warnings = scheduleWindowWarnings({ state: "range", start: { kind: "date", localCivil: "2026-04-01" }, end: { kind: "date", localCivil: "2026-07-01" } }, shoot);
    expect(warnings.map((warning) => warning.endpoint)).toEqual(["start", "end"]);
  });
});

describe("ganttDropWarningText", () => {
  it("joins messages with a space, or returns null for none", () => {
    expect(ganttDropWarningText([])).toBeNull();
    expect(ganttDropWarningText([
      { code: "subtask_before_project_shoot", message: "Starts before the shoot date.", endpoint: "start" },
      { code: "subtask_after_project_deadline", message: "Ends after the project deadline.", endpoint: "end" },
    ])).toBe("Starts before the shoot date. Ends after the project deadline.");
  });
});

// ---------------------------------------------------------------------------
// ganttEditToProposal
// ---------------------------------------------------------------------------

describe("ganttEditToProposal — day scale, timed endpoints", () => {
  const source = eventSource(makeTask({ schedule: JUNE_TIMED_RANGE }));
  const eventStart = new Date("2026-06-09T23:00:00.000Z");
  const eventEnd = new Date("2026-06-10T01:00:00.000Z");

  it("move → week target at the Sydney civil minute of proposedStart", () => {
    const proposal = ganttEditToProposal(source, edit({ kind: "move", eventStart, eventEnd, proposedStart: new Date(eventStart.getTime() + 90 * 60_000), proposedEnd: new Date(eventEnd.getTime() + 90 * 60_000), scale: "day" }));
    expect(proposal).toEqual({ kind: "move", entity: "checklist", source, target: { subview: "week", targetDate: "2026-06-10", targetCivilMinute: "2026-06-10T10:30" } });
    const plan = planSchedulingProposal(proposal!);
    expect(plan.ok && plan.value.kind === "checklist" && plan.value.schedule).toEqual({ state: "range", start: { kind: "timed", localCivil: "2026-06-10T10:30" }, end: { kind: "timed", localCivil: "2026-06-10T12:30" } });
  });

  it("resize-start → week target with edge start", () => {
    const proposal = ganttEditToProposal(source, edit({ kind: "resize-start", eventStart, eventEnd, proposedStart: new Date(eventStart.getTime() - HOUR), scale: "day" }));
    expect(proposal).toEqual({ kind: "resize", entity: "checklist", source, edge: "start", target: { subview: "week", targetDate: "2026-06-10", targetCivilMinute: "2026-06-10T08:00", edge: "start" } });
  });

  it("resize-end → week target at proposedEnd with edge end", () => {
    const proposal = ganttEditToProposal(source, edit({ kind: "resize-end", eventStart, eventEnd, proposedEnd: new Date(eventEnd.getTime() + 2 * HOUR), scale: "day" }));
    expect(proposal).toEqual({ kind: "resize", entity: "checklist", source, edge: "end", target: { subview: "week", targetDate: "2026-06-10", targetCivilMinute: "2026-06-10T13:00", edge: "end" } });
  });

  it("day scale with no change still produces a proposal (the controller dedupes)", () => {
    expect(ganttEditToProposal(source, edit({ kind: "move", eventStart, eventEnd, scale: "day" }))).not.toBeNull();
  });

  it("across the October gap: a day-scale drop lands on the AEDT civil minute", () => {
    const octSource = eventSource(makeTask({ schedule: rangeSchedule(
      timedEndpoint("2026-10-03T09:00", "2026-10-02T23:00:00.000Z", 600),
      timedEndpoint("2026-10-03T10:00", "2026-10-03T00:00:00.000Z", 600),
    ) }));
    // 2026-10-03T23:00Z is 2026-10-04T10:00 AEDT.
    const proposal = ganttEditToProposal(octSource, edit({ kind: "move", eventStart: new Date("2026-10-02T23:00:00.000Z"), eventEnd: new Date("2026-10-03T00:00:00.000Z"), proposedStart: new Date("2026-10-03T23:00:00.000Z"), proposedEnd: new Date("2026-10-04T00:00:00.000Z"), scale: "day" }));
    expect(proposal!.target).toEqual({ subview: "week", targetDate: "2026-10-04", targetCivilMinute: "2026-10-04T10:00" });
  });
});

describe("ganttEditToProposal — coarse scale / date endpoints", () => {
  it("timed range moved +1 day across the October gap (23h day) keeps 09:00 wall time", () => {
    const octSource = eventSource(makeTask({ schedule: rangeSchedule(
      timedEndpoint("2026-10-03T09:00", "2026-10-02T23:00:00.000Z", 600),
      timedEndpoint("2026-10-03T10:00", "2026-10-03T00:00:00.000Z", 600),
    ) }));
    const eventStart = new Date("2026-10-02T23:00:00.000Z");
    const eventEnd = new Date("2026-10-03T00:00:00.000Z");
    // The Gantt proposes the next civil day's 09:00 (23h later in real time).
    const proposal = ganttEditToProposal(octSource, edit({ kind: "move", eventStart, eventEnd, proposedStart: new Date(eventStart.getTime() + 23 * HOUR), proposedEnd: new Date(eventEnd.getTime() + 23 * HOUR), scale: "week" }));
    expect(proposal).toEqual({ kind: "move", entity: "checklist", source: octSource, target: { subview: "month", targetDate: "2026-10-04" } });
    const plan = planSchedulingProposal(proposal!);
    expect(plan.ok && plan.value.timing).toEqual({ allDay: false, start: "2026-10-03T22:00:00.000Z", end: "2026-10-03T23:00:00.000Z" });
  });

  it("timed range moved +1 day across the April fold (25h day) keeps 09:00 wall time", () => {
    const aprSource = eventSource(makeTask({ schedule: rangeSchedule(
      timedEndpoint("2026-04-04T09:00", "2026-04-03T22:00:00.000Z", 660),
      timedEndpoint("2026-04-04T10:00", "2026-04-03T23:00:00.000Z", 660),
    ) }));
    const eventStart = new Date("2026-04-03T22:00:00.000Z");
    const eventEnd = new Date("2026-04-03T23:00:00.000Z");
    const proposal = ganttEditToProposal(aprSource, edit({ kind: "move", eventStart, eventEnd, proposedStart: new Date(eventStart.getTime() + 25 * HOUR), proposedEnd: new Date(eventEnd.getTime() + 25 * HOUR), scale: "month" }));
    expect(proposal!.target).toEqual({ subview: "month", targetDate: "2026-04-05" });
    const plan = planSchedulingProposal(proposal!);
    expect(plan.ok && plan.value.timing).toEqual({ allDay: false, start: "2026-04-04T23:00:00.000Z", end: "2026-04-05T00:00:00.000Z" });
  });

  it("timed resize-start at week scale keeps the wall time on the shifted date", () => {
    const source = eventSource(makeTask({ schedule: JUNE_TIMED_RANGE }));
    const eventStart = new Date("2026-06-09T23:00:00.000Z");
    const proposal = ganttEditToProposal(source, edit({ kind: "resize-start", eventStart, eventEnd: new Date("2026-06-10T01:00:00.000Z"), proposedStart: new Date(eventStart.getTime() - 2 * DAY), scale: "week" }));
    expect(proposal).toEqual({ kind: "resize", entity: "checklist", source, edge: "start", target: { subview: "week", targetDate: "2026-06-08", targetCivilMinute: "2026-06-08T09:00", edge: "start" } });
  });

  it("timed resize-end at week scale keeps the wall time on the shifted date", () => {
    const source = eventSource(makeTask({ schedule: JUNE_TIMED_RANGE }));
    const eventEnd = new Date("2026-06-10T01:00:00.000Z");
    const proposal = ganttEditToProposal(source, edit({ kind: "resize-end", eventStart: new Date("2026-06-09T23:00:00.000Z"), eventEnd, proposedEnd: new Date(eventEnd.getTime() + 3 * DAY), scale: "quarter" }));
    expect(proposal).toEqual({ kind: "resize", entity: "checklist", source, edge: "end", target: { subview: "week", targetDate: "2026-06-13", targetCivilMinute: "2026-06-13T11:00", edge: "end" } });
    const plan = planSchedulingProposal(proposal!);
    expect(plan.ok && plan.value.kind === "checklist" && plan.value.schedule.state === "range" && plan.value.schedule.end.localCivil).toBe("2026-06-13T11:00");
  });

  it("all-day range move at day scale still uses the date path", () => {
    const source = eventSource(makeTask({ schedule: JUNE_DATE_RANGE }));
    const model = buildProductionGanttModel([makeProject({ children: { rows: [makeTask({ schedule: JUNE_DATE_RANGE })], total: 1, returned: 1, truncated: false, nextCursor: null } })], { now: NOW });
    const bar = model.events.find((event) => event.id === `task:${TASK_ID}`)!;
    const proposal = ganttEditToProposal(source, edit({ kind: "move", eventStart: bar.start, eventEnd: bar.end, proposedStart: new Date(bar.start.getTime() + 2 * DAY), proposedEnd: new Date(bar.end.getTime() + 2 * DAY), scale: "day" }));
    expect(proposal!.target).toEqual({ subview: "month", targetDate: "2026-06-12" });
  });

  it("all-day resize-start shifts the start date", () => {
    const source = eventSource(makeTask({ schedule: JUNE_DATE_RANGE }));
    const start = new Date("2026-06-09T14:00:00.000Z"); // 2026-06-10 00:00 AEST
    const proposal = ganttEditToProposal(source, edit({ kind: "resize-start", eventStart: start, eventEnd: new Date("2026-06-12T14:00:00.000Z"), proposedStart: new Date(start.getTime() - DAY), scale: "week" }));
    expect(proposal).toEqual({ kind: "resize", entity: "checklist", source, edge: "start", target: { subview: "month", targetDate: "2026-06-09", edge: "start" } });
  });

  it("all-day resize-end: target.end is the EXCLUSIVE end, and the plan's inclusive end moves by delta", () => {
    const source = eventSource(makeTask({ schedule: JUNE_DATE_RANGE }));
    const exclusiveEnd = new Date("2026-06-12T14:00:00.000Z"); // 2026-06-13 00:00 AEST — exclusive end of 06-12
    const proposal = ganttEditToProposal(source, edit({ kind: "resize-end", eventStart: new Date("2026-06-09T14:00:00.000Z"), eventEnd: exclusiveEnd, proposedEnd: new Date(exclusiveEnd.getTime() + 2 * DAY), scale: "week" }));
    expect(proposal).toEqual({ kind: "resize", entity: "checklist", source, edge: "end", target: { subview: "month", targetDate: "2026-06-15", end: "2026-06-15", edge: "end" } });
    const plan = planSchedulingProposal(proposal!);
    expect(plan.ok && plan.value.kind === "checklist" && plan.value.schedule).toEqual({ state: "range", start: { kind: "date", localCivil: "2026-06-10" }, end: { kind: "date", localCivil: "2026-06-14" } });
    expect(plan.ok && plan.value.timing).toEqual({ allDay: true, start: "2026-06-10", end: "2026-06-15" });
  });

  it("due_only date move → month target of the shifted due date", () => {
    const source = eventSource(makeTask({ schedule: dueOnlySchedule(dateEndpoint("2026-06-10")) }));
    const at = new Date("2026-06-09T14:00:00.000Z");
    const proposal = ganttEditToProposal(source, edit({ kind: "move", eventStart: at, eventEnd: at, proposedStart: new Date(at.getTime() + 5 * DAY), proposedEnd: new Date(at.getTime() + 5 * DAY), scale: "day" }));
    expect(proposal).toEqual({ kind: "move", entity: "checklist", source, target: { subview: "month", targetDate: "2026-06-15" } });
  });

  it("due_only timed move at day scale → week target", () => {
    const source = eventSource(makeTask({ schedule: dueOnlySchedule(timedEndpoint("2026-06-10T09:00", "2026-06-09T23:00:00.000Z", 600)) }));
    const at = new Date("2026-06-09T23:00:00.000Z");
    const proposal = ganttEditToProposal(source, edit({ kind: "move", eventStart: at, eventEnd: at, proposedStart: new Date(at.getTime() + HOUR), proposedEnd: new Date(at.getTime() + HOUR), scale: "day" }));
    expect(proposal!.target).toEqual({ subview: "week", targetDate: "2026-06-10", targetCivilMinute: "2026-06-10T10:00" });
  });

  it("due_only resize-* → null", () => {
    const source = eventSource(makeTask({ schedule: dueOnlySchedule(dateEndpoint("2026-06-10")) }));
    const at = new Date("2026-06-09T14:00:00.000Z");
    expect(ganttEditToProposal(source, edit({ kind: "resize-end", eventStart: at, eventEnd: at, proposedEnd: new Date(at.getTime() + DAY) }))).toBeNull();
    expect(ganttEditToProposal(source, edit({ kind: "resize-start", eventStart: at, eventEnd: at, proposedStart: new Date(at.getTime() - DAY) }))).toBeNull();
  });

  it("delta 0 at a coarse scale → null", () => {
    const source = eventSource(makeTask({ schedule: JUNE_TIMED_RANGE }));
    const eventStart = new Date("2026-06-09T23:00:00.000Z");
    const eventEnd = new Date("2026-06-10T01:00:00.000Z");
    expect(ganttEditToProposal(source, edit({ kind: "move", eventStart, eventEnd, proposedStart: new Date(eventStart.getTime() + 5 * HOUR), proposedEnd: new Date(eventEnd.getTime() + 5 * HOUR), scale: "week" }))).toBeNull();
    expect(ganttEditToProposal(source, edit({ kind: "resize-end", eventStart, eventEnd, scale: "year" }))).toBeNull();
  });
});

describe("ganttPlacementToProposal", () => {
  const entry = ganttChecklistSource(makeProject(), makeTask()) as ChecklistCalendarUnscheduledEntryDto;

  it("day scale timed slot → week target (mapper makes a 1h range)", () => {
    const proposal = ganttPlacementToProposal(entry, { start: new Date("2026-06-10T04:00:00.000Z"), allDay: false }, "day");
    expect(proposal).toEqual({ kind: "place", entity: "checklist", entry, target: { subview: "week", targetDate: "2026-06-10", targetCivilMinute: "2026-06-10T14:00" } });
    const plan = planSchedulingProposal(proposal!);
    expect(plan.ok && plan.value.kind === "checklist" && plan.value.schedule).toEqual({ state: "range", start: { kind: "timed", localCivil: "2026-06-10T14:00" }, end: { kind: "timed", localCivil: "2026-06-10T15:00" } });
  });

  it("coarser scale or all-day slot → month target (due_only date)", () => {
    expect(ganttPlacementToProposal(entry, { start: new Date("2026-06-10T04:00:00.000Z"), allDay: false }, "week")!.target).toEqual({ subview: "month", targetDate: "2026-06-10" });
    expect(ganttPlacementToProposal(entry, { start: new Date("2026-06-09T14:00:00.000Z"), allDay: true }, "day")!.target).toEqual({ subview: "month", targetDate: "2026-06-10" });
  });

  it("only a plain unscheduled entry can be placed", () => {
    const attention = { ...entry, reason: "schedule_needs_attention", attentionReason: "legacy_unresolved" } as unknown as ChecklistCalendarUnscheduledEntryDto;
    expect(ganttPlacementToProposal(attention, { start: new Date("2026-06-10T04:00:00.000Z"), allDay: false }, "day")).toBeNull();
  });
});

describe("ganttDeadlineEditToProposal", () => {
  const event = ganttDeadlineEvent(makeProject()) as ProjectDeadlineCalendarEventDto;
  const originalEnd = new Date("2026-06-01T05:00:00.000Z");

  it("day scale → week target at the proposed civil minute", () => {
    const proposal = ganttDeadlineEditToProposal(event, new Date(originalEnd.getTime() + 2 * HOUR), originalEnd, "day");
    expect(proposal).toEqual({ kind: "deadline", entity: "project_deadline", event, target: { subview: "week", targetDate: "2026-06-01", targetCivilMinute: "2026-06-01T17:00" } });
  });

  it("coarse scale → month target on the shifted date; the mapper keeps 15:00 wall time", () => {
    const proposal = ganttDeadlineEditToProposal(event, new Date(originalEnd.getTime() + 3 * DAY + 2 * HOUR), originalEnd, "week");
    expect(proposal).toEqual({ kind: "deadline", entity: "project_deadline", event, target: { subview: "month", targetDate: "2026-06-04" } });
    const plan = planSchedulingProposal(proposal!);
    expect(plan.ok && plan.value.kind === "deadline" && plan.value.localCivil).toBe("2026-06-04T15:00");
  });

  it("coarse scale across the October gap keeps the wall time", () => {
    const octEvent = ganttDeadlineEvent(makeProject({ deadline: makeDeadline({ at: "2026-10-03T07:00:00.000Z", localCivil: "2026-10-03T17:00" }) })) as ProjectDeadlineCalendarEventDto;
    const at = new Date("2026-10-03T07:00:00.000Z");
    const proposal = ganttDeadlineEditToProposal(octEvent, new Date(at.getTime() + 23 * HOUR), at, "month");
    const plan = planSchedulingProposal(proposal!);
    expect(plan.ok && plan.value.timing).toEqual({ allDay: false, start: "2026-10-04T06:00:00.000Z", end: null });
  });

  it("delta 0 at a coarse scale → null", () => {
    expect(ganttDeadlineEditToProposal(event, new Date(originalEnd.getTime() + 4 * HOUR), originalEnd, "quarter")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Optimistic overlay
// ---------------------------------------------------------------------------

describe("applyGanttOptimisticOverlay", () => {
  const SECOND_TASK = "22222222-2222-4222-8222-000000000002";
  function model() {
    const rows = [
      makeTask({ schedule: JUNE_TIMED_RANGE }),
      makeTask({ id: SECOND_TASK, title: "Floor plan", position: 2, schedule: unscheduledSchedule() }),
    ];
    return buildProductionGanttModel([makeProject({ children: { rows, total: 2, returned: 2, truncated: false, nextCursor: null } })], { now: NOW });
  }

  it("null overlay and no pending deadline returns the same model", () => {
    const base = model();
    expect(applyGanttOptimisticOverlay(base, null)).toBe(base);
  });

  it("moves a checklist event to timed instants without mutating the input", () => {
    const base = model();
    const before = base.events.find((event) => event.id === `task:${TASK_ID}`)!;
    const next = applyGanttOptimisticOverlay(base, { eventId: `checklist:${TASK_ID}`, timing: { allDay: false, start: "2026-06-11T00:00:00.000Z", end: "2026-06-11T02:00:00.000Z" } });
    const moved = next.events.find((event) => event.id === `task:${TASK_ID}`)!;
    expect(next).not.toBe(base);
    expect(moved.start.toISOString()).toBe("2026-06-11T00:00:00.000Z");
    expect(moved.end.toISOString()).toBe("2026-06-11T02:00:00.000Z");
    expect(moved.allDay).toBe(false);
    expect(before.start.toISOString()).toBe("2026-06-09T23:00:00.000Z");
    expect(moved.data).toBe(before.data);
  });

  it("an all-day timing resolves to Sydney civil midnights; a null end is a milestone", () => {
    const base = model();
    const ranged = applyGanttOptimisticOverlay(base, { eventId: `checklist:${TASK_ID}`, timing: { allDay: true, start: "2026-06-10", end: "2026-06-13" } });
    const bar = ranged.events.find((event) => event.id === `task:${TASK_ID}`)!;
    expect([bar.start.toISOString(), bar.end.toISOString(), bar.allDay]).toEqual(["2026-06-09T14:00:00.000Z", "2026-06-12T14:00:00.000Z", true]);
    const milestone = applyGanttOptimisticOverlay(base, { eventId: `checklist:${TASK_ID}`, timing: { allDay: true, start: "2026-06-10", end: null } }).events.find((event) => event.id === `task:${TASK_ID}`)!;
    expect(milestone.end.getTime()).toBe(milestone.start.getTime());
    const timedMilestone = applyGanttOptimisticOverlay(base, { eventId: `checklist:${TASK_ID}`, timing: { allDay: false, start: "2026-06-11T00:00:00.000Z", end: null } }).events.find((event) => event.id === `task:${TASK_ID}`)!;
    expect(timedMilestone.end.getTime()).toBe(timedMilestone.start.getTime());
  });

  it("reschedule-unscheduled adds an event for the task resource and drops its attention entry", () => {
    const base = model();
    const asEvent = eventSource(makeTask({ id: SECOND_TASK, title: "Floor plan", schedule: dueOnlySchedule(dateEndpoint("2026-06-20")) }));
    const next = applyGanttOptimisticOverlay(base, { kind: "reschedule-unscheduled", entryId: `checklist:${SECOND_TASK}`, timing: { allDay: true, start: "2026-06-20", end: null }, asEvent });
    const added = next.events.find((event) => event.id === `task:${SECOND_TASK}`)!;
    expect(added).toMatchObject({ title: "Floor plan", resourceId: `task:${SECOND_TASK}`, allDay: true, readOnly: true });
    expect(added.start.toISOString()).toBe("2026-06-19T14:00:00.000Z");
    expect(added.data).toMatchObject({ kind: "task", dto: { id: SECOND_TASK } });
    expect(added.color).toBe(base.resources[0]!.children!.find((child) => child.id === `task:${SECOND_TASK}`)!.color);
    expect(next.attention.some((entry) => entry.resourceId === `task:${SECOND_TASK}`)).toBe(false);
    expect(base.attention.some((entry) => entry.resourceId === `task:${SECOND_TASK}`)).toBe(true);
  });

  it("a project-deadline overlay moves the project bar's end", () => {
    const base = model();
    const next = applyGanttOptimisticOverlay(base, { eventId: `project-deadline:${PROJECT_ID}`, timing: { allDay: false, start: "2026-06-05T07:00:00.000Z", end: null } });
    expect(next.events.find((event) => event.id === `project-bar:${PROJECT_ID}`)!.end.toISOString()).toBe("2026-06-05T07:00:00.000Z");
    expect(base.events.find((event) => event.id === `project-bar:${PROJECT_ID}`)!.end.toISOString()).toBe("2026-06-01T05:00:00.000Z");
  });

  it("pendingDeadline moves the project bar's end while the confirm dialog is open", () => {
    const next = applyGanttOptimisticOverlay(model(), null, { projectId: PROJECT_ID, end: new Date("2026-06-06T07:00:00.000Z") });
    expect(next.events.find((event) => event.id === `project-bar:${PROJECT_ID}`)!.end.toISOString()).toBe("2026-06-06T07:00:00.000Z");
  });

  it("an overlay naming an event not in the model leaves the model unchanged", () => {
    const base = model();
    expect(applyGanttOptimisticOverlay(base, { eventId: "checklist:nope", timing: { allDay: false, start: "2026-06-11T00:00:00.000Z", end: null } }).events).toEqual(base.events);
  });
});

// ---------------------------------------------------------------------------
// previewDeadlineEffects (#221 PR C)
// ---------------------------------------------------------------------------

describe("previewDeadlineEffects", () => {
  const ROW = (id: string, title: string, schedule: ChecklistScheduleDto, position = 1) => makeTask({ id, title, schedule, position });
  // Deadline 2026-06-01T15:00 (makeDeadline). Rows end on 2026-05-30 (on time), 2026-06-01 date
  // (on time — same day, by date), 2026-06-03 (after).
  const onTime = ROW("r-on", "On time", dueOnlySchedule(dateEndpoint("2026-05-30")));
  const sameDay = ROW("r-same", "Same day", rangeSchedule(dateEndpoint("2026-05-20"), dateEndpoint("2026-06-01")));
  const late = ROW("r-late", "Late", dueOnlySchedule(dateEndpoint("2026-06-03")));
  const timed = ROW("r-timed", "Timed", dueOnlySchedule(timedEndpoint("2026-05-31T12:00", "2026-05-31T02:00:00.000Z", 600)));
  const unscheduled = ROW("r-unsched", "Unscheduled", unscheduledSchedule());
  const invalid = ROW("r-invalid", "Invalid", { ...unscheduledSchedule(), state: "invalid" } as unknown as ChecklistScheduleDto);
  const project = makeProject({ children: { rows: [onTime, sameDay, late, timed, unscheduled, invalid], total: 6, returned: 6, truncated: false, nextCursor: null } });

  it("lists rows that flip on-time → after, with a subtask clash for each", () => {
    const preview = previewDeadlineEffects(project, { localCivil: "2026-05-31T09:00", instant: "2026-05-30T23:00:00.000Z" });
    expect(preview.affected).toEqual([
      { id: "r-same", title: "Same day", before: "on-time", after: "after" },
      { id: "r-timed", title: "Timed", before: "on-time", after: "after" },
    ]);
    expect(preview.clashes).toEqual([
      { kind: "subtask-after-deadline", id: "r-same", title: "Same day" },
      { kind: "subtask-after-deadline", id: "r-timed", title: "Timed" },
    ]);
  });

  it("lists rows that flip after → on-time, with no clash", () => {
    const preview = previewDeadlineEffects(project, { localCivil: "2026-06-05T15:00", instant: "2026-06-05T05:00:00.000Z" });
    expect(preview.affected).toEqual([{ id: "r-late", title: "Late", before: "after", after: "on-time" }]);
    expect(preview.clashes).toEqual([]);
  });

  it("never lists an unchanged row, an unscheduled row or an invalid row", () => {
    const preview = previewDeadlineEffects(project, { localCivil: "2026-06-02T15:00", instant: "2026-06-02T05:00:00.000Z" });
    expect(preview.affected).toEqual([]);
    expect(preview.clashes).toEqual([]);
  });

  it("treats a project with no deadline yet as every row on time before", () => {
    const preview = previewDeadlineEffects(makeProject({ deadline: null, children: project.children }), { localCivil: "2026-06-02T15:00", instant: "2026-06-02T05:00:00.000Z" });
    expect(preview.affected).toEqual([{ id: "r-late", title: "Late", before: "on-time", after: "after" }]);
    expect(preview.clashes).toEqual([{ kind: "subtask-after-deadline", id: "r-late", title: "Late" }]);
  });

  it("reports a deadline before the shoot date", () => {
    const preview = previewDeadlineEffects(makeProject(), { localCivil: "2026-04-30T15:00", instant: "2026-04-30T05:00:00.000Z" });
    expect(preview.clashes).toEqual([{ kind: "deadline-before-start", boundKind: "shoot" }]);
    // The shoot day itself is not before the shoot.
    expect(previewDeadlineEffects(makeProject(), { localCivil: "2026-05-01T09:00", instant: "2026-04-30T23:00:00.000Z" }).clashes).toEqual([]);
  });

  it("reports a deadline before the project was created when there is no shoot date", () => {
    const noShoot = makeProject({ shootDate: null, shootDateCivil: null, createdAt: "2026-03-10T00:00:00.000Z" });
    expect(previewDeadlineEffects(noShoot, { localCivil: "2026-03-09T15:00", instant: "2026-03-09T04:00:00.000Z" }).clashes).toEqual([{ kind: "deadline-before-start", boundKind: "created" }]);
    expect(previewDeadlineEffects(noShoot, { localCivil: "2026-03-10T15:00", instant: "2026-03-10T04:00:00.000Z" }).clashes).toEqual([]);
  });

  it("reports loaded / total / truncated from the project's children", () => {
    const truncated = makeProject({ children: { rows: [onTime, late], total: 9, returned: 2, truncated: true, nextCursor: "c2" } });
    const preview = previewDeadlineEffects(truncated, { localCivil: "2026-06-05T15:00", instant: "2026-06-05T05:00:00.000Z" });
    expect(preview).toMatchObject({ loaded: 2, total: 9, truncated: true });
    expect(previewDeadlineEffects(project, { localCivil: "2026-06-05T15:00", instant: "2026-06-05T05:00:00.000Z" })).toMatchObject({ loaded: 6, total: 6, truncated: false });
  });
});

describe("ganttDeadlineDropWarning", () => {
  const originalEnd = new Date("2026-06-01T05:00:00.000Z");

  it("warns when the proposed deadline lands before the shoot date", () => {
    expect(ganttDeadlineDropWarning(makeProject(), new Date(originalEnd.getTime() - 32 * DAY), originalEnd, "month")).toBe("Deadline before the shoot date.");
  });

  it("warns when it lands before the creation date of a project with no shoot date", () => {
    const noShoot = makeProject({ shootDate: null, shootDateCivil: null, createdAt: "2026-05-20T00:00:00.000Z" });
    expect(ganttDeadlineDropWarning(noShoot, new Date(originalEnd.getTime() - 20 * DAY), originalEnd, "week")).toBe("Deadline before the project was created.");
  });

  it("is null inside the window, for a zero-day delta and for a project with no deadline", () => {
    expect(ganttDeadlineDropWarning(makeProject(), new Date(originalEnd.getTime() + 2 * DAY), originalEnd, "month")).toBeNull();
    expect(ganttDeadlineDropWarning(makeProject(), originalEnd, originalEnd, "month")).toBeNull();
    expect(ganttDeadlineDropWarning(makeProject({ deadline: null }), new Date(originalEnd.getTime() - 40 * DAY), originalEnd, "month")).toBeNull();
  });

  it("uses the pointer's Sydney civil minute at day scale", () => {
    expect(ganttDeadlineDropWarning(makeProject(), new Date("2026-04-30T13:00:00.000Z"), originalEnd, "day")).toBe("Deadline before the shoot date.");
    expect(ganttDeadlineDropWarning(makeProject(), new Date("2026-04-30T14:00:00.000Z"), originalEnd, "day")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Import boundary
// ---------------------------------------------------------------------------

describe("import boundary", () => {
  it("never imports the vendored gantt, not even as a type", () => {
    const source = readFileSync(fileURLToPath(new URL("./production-gantt-scheduling.ts", import.meta.url)), "utf8");
    const specifiers = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((specifier) => /reui\/gantt/.test(specifier!))).toEqual([]);
  });
});
