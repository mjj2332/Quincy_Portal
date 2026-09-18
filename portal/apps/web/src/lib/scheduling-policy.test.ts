import { describe, expect, it } from "vitest";
import {
  mapChecklistEndResizeToCommand,
  mapChecklistMoveToCommand,
  mapChecklistStartResizeToCommand,
  mapProjectDeadlineMoveToCommand,
  mapUnscheduledChecklistDropToCommand,
  mapUnscheduledProjectDropToCommand,
  PRODUCTION_CALENDAR_ZONE,
  type ChecklistCalendarEventDto,
  type ChecklistCalendarUnscheduledEntryDto,
  type ProjectCalendarUnscheduledEntryDto,
  type ProjectDeadlineCalendarEventDto,
} from "@quincy/shared";
import { checkScheduleBounds, planSchedulingProposal, type SchedulingProposal } from "./scheduling-policy";

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
    expect(plan.ok).toBe(true);
    expect(direct.ok).toBe(true);
    if (plan.ok && plan.value.kind === "checklist" && direct.ok) expect(plan.value.request).toEqual(direct.value);
  });

  it("end-resizes a checklist range exactly as mapChecklistEndResizeToCommand", () => {
    const source = checklistEvent(rangeSchedule(dateEndpoint("2026-08-27"), dateEndpoint("2026-08-27")));
    const target = { subview: "month" as const, targetDate: "2026-08-29" };
    const proposal: SchedulingProposal = { kind: "resize", entity: "checklist", source, edge: "end", target };
    const plan = planSchedulingProposal(proposal);
    const direct = mapChecklistEndResizeToCommand({ event: source, target });
    expect(plan.ok).toBe(true);
    expect(direct.ok).toBe(true);
    if (plan.ok && plan.value.kind === "checklist" && direct.ok) expect(plan.value.request).toEqual(direct.value);
  });

  it("start-resizes a checklist range exactly as mapChecklistStartResizeToCommand", () => {
    const source = checklistEvent(rangeSchedule(dateEndpoint("2026-08-27"), dateEndpoint("2026-08-29")));
    const target = { subview: "month" as const, targetDate: "2026-08-26" };
    const proposal: SchedulingProposal = { kind: "resize", entity: "checklist", source, edge: "start", target };
    const plan = planSchedulingProposal(proposal);
    const direct = mapChecklistStartResizeToCommand({ event: source, target });
    expect(plan.ok).toBe(true);
    expect(direct.ok).toBe(true);
    if (plan.ok && plan.value.kind === "checklist" && direct.ok) expect(plan.value.request).toEqual(direct.value);
  });

  it("places an unscheduled checklist entry exactly as mapUnscheduledChecklistDropToCommand", () => {
    const entry = checklistUnscheduledEntry();
    const target = { subview: "month" as const, targetDate: "2026-08-29" };
    const proposal: SchedulingProposal = { kind: "place", entity: "checklist", entry, target };
    const plan = planSchedulingProposal(proposal);
    const direct = mapUnscheduledChecklistDropToCommand({ event: entry, target });
    expect(plan.ok).toBe(true);
    expect(direct.ok).toBe(true);
    if (plan.ok && plan.value.kind === "checklist" && direct.ok) expect(plan.value.request).toEqual(direct.value);
  });

  it("places an unscheduled project deadline exactly as mapUnscheduledProjectDropToCommand", () => {
    const entry = projectUnscheduledEntry();
    const target = { subview: "month" as const, targetDate: "2026-08-29" };
    const proposal: SchedulingProposal = { kind: "place", entity: "project_deadline", entry, target };
    const plan = planSchedulingProposal(proposal);
    const direct = mapUnscheduledProjectDropToCommand({ event: entry, target });
    expect(plan.ok).toBe(true);
    expect(direct.ok).toBe(true);
    if (plan.ok && plan.value.kind === "deadline" && direct.ok) expect(plan.value.request).toEqual(direct.value);
  });

  it("moves a project deadline exactly as mapProjectDeadlineMoveToCommand", () => {
    const event = projectEvent();
    const target = { subview: "month" as const, targetDate: "2026-08-29" };
    const proposal: SchedulingProposal = { kind: "deadline", entity: "project_deadline", event, target };
    const plan = planSchedulingProposal(proposal);
    const direct = mapProjectDeadlineMoveToCommand({ event, target });
    expect(plan.ok).toBe(true);
    expect(direct.ok).toBe(true);
    if (plan.ok && plan.value.kind === "deadline" && direct.ok) expect(plan.value.request).toEqual(direct.value);
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
});
