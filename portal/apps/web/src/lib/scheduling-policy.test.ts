import { describe, expect, it } from "vitest";
import {
  checklistScheduleToDto,
  mapChecklistEndResizeToCommand,
  mapChecklistMoveToCommand,
  mapChecklistStartResizeToCommand,
  mapProjectDeadlineMoveToCommand,
  mapUnscheduledProjectDropToCommand,
  normalizeChecklistSchedule,
  resolveSydneyCivilMinute,
  PRODUCTION_CALENDAR_ZONE,
  type CalendarMappingResult,
  type ChecklistCalendarEventDto,
  type ProjectCalendarUnscheduledEntryDto,
  type ProjectDeadlineCalendarEventDto,
  type SaveChecklistScheduleRequest,
  type SaveProjectDeadlineRequest,
} from "@quincy/shared";
import { canonicalChecklistEvent, optimisticChecklistEvent, planSchedulingProposal, timingFromChecklistSchedule, type SchedulingProposal } from "./scheduling-policy";

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
function checklistEvent(schedule: ReturnType<typeof rangeSchedule>): ChecklistCalendarEventDto<typeof EDITOR_STAGE> {
  const timing = schedule.start.kind === "date"
    ? { allDay: true as const, start: schedule.start.localCivil, end: "2026-08-29" }
    : { allDay: false as const, start: schedule.start.instant!, end: schedule.end.instant };
  return { id: `checklist:${PERSON_ID}`, kind: "checklist", title: "Select hero images", project: project(), assignee: person, assignees: [person], otherAssigneeCount: 0, timing, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, schedule, permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true } };
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
    const plan = planSchedulingProposal(proposal, { bounds: { lower: null, deadlineLocalCivil: "2026-08-28T17:00" } });
    expect(plan.ok).toBe(true);
    if (plan.ok && plan.value.kind === "checklist") expect(plan.value.warnings).toEqual([{ code: "subtask_after_project_deadline", message: "Ends after the project deadline.", endpoint: "end" }]);
  });

  it("never warns before a lower bound when there is none", () => {
    const source = checklistEvent(rangeSchedule(dateEndpoint("2026-08-27"), dateEndpoint("2026-08-29")));
    const target = { subview: "month" as const, targetDate: "2026-08-01" };
    const proposal: SchedulingProposal = { kind: "move", entity: "checklist", source, target };
    const plan = planSchedulingProposal(proposal, { bounds: { lower: null, deadlineLocalCivil: null } });
    expect(plan.ok).toBe(true);
    if (plan.ok && plan.value.kind === "checklist") expect(plan.value.warnings).toEqual([]);
  });

  it("warns before the shoot date when present", () => {
    const source = checklistEvent(rangeSchedule(dateEndpoint("2026-08-27"), dateEndpoint("2026-08-29")));
    const target = { subview: "month" as const, targetDate: "2026-08-01" };
    const proposal: SchedulingProposal = { kind: "move", entity: "checklist", source, target };
    const plan = planSchedulingProposal(proposal, { bounds: { lower: { civilDate: "2026-08-10", kind: "shoot" }, deadlineLocalCivil: null } });
    expect(plan.ok).toBe(true);
    if (plan.ok && plan.value.kind === "checklist") expect(plan.value.warnings).toEqual([{ code: "subtask_before_project_shoot", message: "Starts before the shoot date.", endpoint: "start" }]);
  });

  it("a warning is never a rejection (ok stays true)", () => {
    const source = checklistEvent(rangeSchedule(dateEndpoint("2026-08-27"), dateEndpoint("2026-08-29")));
    const target = { subview: "month" as const, targetDate: "2026-08-01" };
    const proposal: SchedulingProposal = { kind: "move", entity: "checklist", source, target };
    const plan = planSchedulingProposal(proposal, { bounds: { lower: { civilDate: "2026-08-10", kind: "shoot" }, deadlineLocalCivil: "2026-08-15T09:00" } });
    expect(plan.ok).toBe(true);
  });
});

// The old planner-local bounds rule's cases now live in
// `schedule-bounds.test.ts` (#288), run through both the Gantt and the Calendar bounds paths.

describe("checklist assignees across a schedule edit (#370)", () => {
  const second = { id: "33333333-3333-4333-8333-333333333333", name: "Bo", roleLabel: "Editor", isExternal: false, active: true };
  const schedule = rangeSchedule(dateEndpoint("2026-08-27"), dateEndpoint("2026-08-28"), 5);
  const source = { ...checklistEvent(rangeSchedule(dateEndpoint("2026-08-27"), dateEndpoint("2026-08-28"), 4)), assignees: [person, second], otherAssigneeCount: 2 };
  const result = (assignees: typeof source.assignees | null) => ({ id: source.id, title: source.title, done: false, assignee: person, assignees, position: 1, schedule, scheduleVersion: 5 });

  it("keeps the source objects and the hidden count when the result names the same people", () => {
    const event = canonicalChecklistEvent(source, result([{ ...person }, { ...second }]))!;
    expect(event.assignees[0]).toBe(person);
    expect(event.assignees[1]).toBe(second);
    expect(event.otherAssigneeCount).toBe(2);
    expect(event.assignee).toBe(person);
  });

  it("takes the result's list when the people changed", () => {
    const changed = { ...second, id: "44444444-4444-4444-8444-444444444444", name: "Cy" };
    const event = canonicalChecklistEvent(source, result([person, changed]))!;
    expect(event.assignees.map((p) => p.name)).toEqual(["Editor", "Cy"]);
  });

  it("keeps the source list when the wire carries none and the first assignee is unchanged", () => {
    expect(canonicalChecklistEvent(source, result(null))!.assignees).toEqual([person, second]);
    const gone = canonicalChecklistEvent(source, { ...result(null), assignee: null })!;
    expect(gone.assignees).toEqual([]);
  });

  it("carries the list through an optimistic move", () => {
    const event = optimisticChecklistEvent(source, schedule)!;
    expect(event.assignees).toEqual([person, second]);
    expect(event.otherAssigneeCount).toBe(2);
  });
});
