import { describe, expect, it } from "vitest";
import {
  PRODUCTION_CALENDAR_ZONE,
  resolveSydneyCivilMinute,
  type ChecklistCalendarEventDto,
  type ChecklistCalendarUnscheduledEntryDto,
  type InitialChecklistScheduleInput,
  type ProjectCalendarUnscheduledEntryDto,
  type ProjectDeadlineCalendarEventDto,
} from "@quincy/shared";
import { checkScheduleBounds, planSchedulingProposal, type SchedulingProposal } from "./scheduling-policy";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const project = { id: PROJECT_ID, street: "1 Example Street", stageKey: "editing" as const, checklist: { completed: 0, total: 1 }, delivered: false };
const person = { id: "22222222-2222-4222-8222-222222222222", name: "Editor", roleLabel: "Editor", isExternal: false, active: true };

function timedEndpoint(localCivil: string, disambiguation?: "earlier" | "later") {
  const resolved = resolveSydneyCivilMinute(localCivil, disambiguation);
  if (!resolved.ok) throw new Error(`Fixture time did not resolve: ${localCivil}`);
  return { kind: "timed" as const, localCivil, instant: resolved.value.instant, utcOffsetMinutes: resolved.value.utcOffsetMinutes, fold: resolved.value.fold, resolution: "stored" as const };
}

function rangeEvent(start: string, end: string): ChecklistCalendarEventDto {
  const startEndpoint = timedEndpoint(start, start === "2026-04-05T02:30" ? "earlier" : undefined);
  const endEndpoint = timedEndpoint(end);
  return {
    id: "checklist:one",
    kind: "checklist",
    title: "Select hero images",
    project,
    assignee: person,
    timing: { allDay: false, start: startEndpoint.instant, end: endEndpoint.instant },
    status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false },
    schedule: { state: "range", version: 4, zone: PRODUCTION_CALENDAR_ZONE, start: startEndpoint, end: endEndpoint, due: end },
    permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canScheduleRange: true },
  };
}

function unscheduledChecklist(): ChecklistCalendarUnscheduledEntryDto {
  return {
    id: "checklist:one",
    kind: "checklist",
    reason: "unscheduled",
    title: "Select hero images",
    project,
    assignee: person,
    schedule: { state: "unscheduled", version: 4, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: null, due: null },
    permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true },
  };
}

function unscheduledDeadline(): ProjectCalendarUnscheduledEntryDto {
  return { id: `project-deadline:${PROJECT_ID}`, kind: "project_deadline", reason: "unscheduled", title: "Deadline", project, permissions: { canDrag: true, canResize: false }, deadlineVersion: 8, reminderOffsetsMinutes: [] };
}

function deadlineEvent(localCivil: string): ProjectDeadlineCalendarEventDto {
  const resolved = timedEndpoint(localCivil, localCivil === "2026-04-05T02:30" ? "earlier" : undefined);
  return {
    id: `project-deadline:${PROJECT_ID}`,
    kind: "project_deadline",
    title: "Deadline",
    project,
    timing: { allDay: false, start: resolved.instant, end: null },
    status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false },
    permissions: { canDrag: true, canResize: false },
    deadlineLocalCivil: localCivil,
    deadlineVersion: 8,
    reminderOffsetsMinutes: [60],
  };
}

describe("scheduling policy adversarial boundaries", () => {
  it("warns only strictly past timed minutes and date-only dates at both DST edges", () => {
    const cases: Array<[InitialChecklistScheduleInput, string, boolean]> = [
      [{ state: "due_only", end: { kind: "timed", localCivil: "2026-04-05T02:30" } }, "2026-04-05T02:30", false],
      [{ state: "due_only", end: { kind: "timed", localCivil: "2026-04-05T02:31" } }, "2026-04-05T02:30", true],
      [{ state: "due_only", end: { kind: "timed", localCivil: "2026-10-04T03:00" } }, "2026-10-04T03:00", false],
      [{ state: "due_only", end: { kind: "timed", localCivil: "2026-10-04T03:01" } }, "2026-10-04T03:00", true],
      [{ state: "due_only", end: { kind: "date", localCivil: "2026-04-05" } }, "2026-04-05T02:30", false],
      [{ state: "due_only", end: { kind: "date", localCivil: "2026-04-06" } }, "2026-04-05T02:30", true],
    ];
    for (const [schedule, deadlineLocalCivil, shouldWarn] of cases) {
      const warnings = checkScheduleBounds(schedule, { shootDate: null, deadlineLocalCivil });
      expect(warnings.some((warning) => warning.code === "subtask_after_project_deadline"), `${JSON.stringify(schedule)} against ${deadlineLocalCivil}`).toBe(shouldWarn);
    }
  });

  it("preserves the mapper's end-resize fold error and endpoint", () => {
    const proposal: SchedulingProposal = {
      kind: "resize",
      entity: "checklist",
      source: rangeEvent("2026-04-05T01:00", "2026-04-05T04:00"),
      edge: "end",
      target: { subview: "week", targetDate: "2026-04-05", targetCivilMinute: "2026-04-05T02:30" },
    };
    expect(planSchedulingProposal(proposal)).toMatchObject({ ok: false, error: { code: "subtask_schedule_repeated_local_time", endpoint: "end", choices: [{ disambiguation: "earlier" }, { disambiguation: "later" }] } });
  });

  it("accepts a start-resize fold choice and carries it into the request and timing", () => {
    const source = rangeEvent("2026-04-05T01:00", "2026-04-05T04:00");
    const proposal: SchedulingProposal = {
      kind: "resize",
      entity: "checklist",
      source,
      edge: "start",
      target: { subview: "week", targetDate: "2026-04-05", targetCivilMinute: "2026-04-05T02:30" },
      disambiguation: "later",
    };
    const plan = planSchedulingProposal(proposal);
    expect(plan).toMatchObject({ ok: true, value: { kind: "checklist", request: { schedule: { start: { kind: "timed", localCivil: "2026-04-05T02:30", disambiguation: "later" } } } } });
    if (plan.ok && plan.value.kind === "checklist") expect(plan.value.timing).toEqual({ allDay: false, start: "2026-04-04T16:30:00.000Z", end: "2026-04-04T18:00:00.000Z" });
  });

  it("propagates a fold choice independently for both endpoints when placing a checklist", () => {
    const proposal: SchedulingProposal = {
      kind: "place",
      entity: "checklist",
      entry: unscheduledChecklist(),
      target: { subview: "week", targetDate: "2026-04-05", targetCivilMinute: "2026-04-05T02:30" },
      disambiguation: { start: "later" },
    };
    const plan = planSchedulingProposal(proposal);
    expect(plan).toMatchObject({ ok: true, value: { kind: "checklist", request: { schedule: { state: "range", start: { disambiguation: "later" }, end: { localCivil: "2026-04-05T03:30" } } } } });
  });

  it("reports a deadline placement fold before confirmation and succeeds with the chosen occurrence", () => {
    const base = { kind: "place" as const, entity: "project_deadline" as const, entry: unscheduledDeadline(), target: { subview: "week" as const, targetDate: "2026-04-05", targetCivilMinute: "2026-04-05T02:30" } };
    expect(planSchedulingProposal(base)).toMatchObject({ ok: false, error: { code: "repeated_local_time", choices: [{ disambiguation: "earlier" }, { disambiguation: "later" }] } });
    const chosen = planSchedulingProposal({ ...base, disambiguation: "later" });
    expect(chosen).toMatchObject({ ok: true, value: { kind: "deadline", localCivil: "2026-04-05T02:30", request: { deadline: { disambiguation: "later" } }, timing: { allDay: false, start: "2026-04-04T16:30:00.000Z" } } });
  });

  it("reports a checklist move's fold error at the start endpoint instead of treating it as a generic failure", () => {
    const proposal: SchedulingProposal = {
      kind: "move",
      entity: "checklist",
      source: rangeEvent("2026-04-04T01:00", "2026-04-04T02:00"),
      target: { subview: "week", targetDate: "2026-04-05", targetCivilMinute: "2026-04-05T02:30" },
    };
    expect(planSchedulingProposal(proposal)).toMatchObject({ ok: false, error: { code: "subtask_schedule_repeated_local_time", endpoint: "start" } });
  });
});
