import { describe, expect, it } from "vitest";
import { PRODUCTION_CALENDAR_ZONE, type ChecklistCalendarUnscheduledEntryDto, type ProjectCalendarUnscheduledEntryDto } from "@quincy/shared";
import { buildChecklistUndoTicket, buildDeadlineUndoTicket } from "./scheduling-undo";

const project = { id: "11111111-1111-4111-8111-111111111111", street: "1 Example Street", stageKey: "editing" as const, checklist: { completed: 0, total: 1 }, delivered: false };
const entry: ChecklistCalendarUnscheduledEntryDto = {
  id: "checklist:one", kind: "checklist", reason: "unscheduled", title: "Select hero images", project, assignee: null,
  schedule: { state: "unscheduled", version: 4, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: null, due: null },
  permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true },
};
const deadlineEntry: ProjectCalendarUnscheduledEntryDto = {
  id: "project-deadline:one", kind: "project_deadline", reason: "unscheduled", title: "Deadline", project,
  permissions: { canDrag: true, canResize: false }, deadlineVersion: 8, reminderOffsetsMinutes: [],
};

describe("scheduling undo adversarial cases", () => {
  it("restores a checklist place to the unscheduled state, not a synthetic due date", () => {
    const ticket = buildChecklistUndoTicket(entry, {
      id: entry.id, title: entry.title, done: false, assignee: null, position: 0,
      schedule: { state: "due_only", version: 5, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: { kind: "date", localCivil: "2026-08-27", instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" }, due: "2026-08-27" },
      scheduleVersion: 5,
    });
    expect(ticket).toMatchObject({ kind: "checklist", expectedVersion: 5, request: { schedule: { state: "unscheduled" } } });
  });

  it("restores a project deadline place to deadline:null", () => {
    const placeholder = {
      id: deadlineEntry.id, kind: "project_deadline" as const, title: deadlineEntry.title, project,
      timing: { allDay: false as const, start: "1970-01-01T00:00:00.000Z", end: null },
      status: { overdue: false, delivered: false, completed: false as const, sameAssigneeOverlap: false as const },
      permissions: { canDrag: true, canResize: false as const }, deadlineLocalCivil: "Not scheduled", deadlineVersion: deadlineEntry.deadlineVersion, reminderOffsetsMinutes: [],
    };
    const ticket = buildDeadlineUndoTicket(placeholder, { version: 9, deadline: { localCivil: "2026-08-27T09:00", instant: "2026-08-26T23:00:00.000Z" }, reminderOffsetsMinutes: [] });
    expect(ticket).toMatchObject({ kind: "deadline", expectedVersion: 9, request: { expectedVersion: 9, deadline: null } });
  });
});
