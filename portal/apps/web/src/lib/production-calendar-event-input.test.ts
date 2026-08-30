import { describe, expect, it } from "vitest";
import { PRODUCTION_CALENDAR_ZONE, type CalendarEventDto } from "@quincy/shared";
import { mapCalendarEventToFullCalendar, mapCalendarEventsToFullCalendar } from "./production-calendar-event-input";

const project = {
  id: "11111111-1111-4111-8111-111111111111",
  street: "11 Calendar Street",
  stageKey: "editing_autohdr" as const,
  checklist: { completed: 2, total: 4 },
  delivered: false,
};

type ProjectDeadlineEvent = Extract<CalendarEventDto, { kind: "project_deadline" }>;

const deadline = (overrides: Partial<ProjectDeadlineEvent> = {}): CalendarEventDto => ({
  id: "project-deadline:11111111-1111-4111-8111-111111111111",
  kind: "project_deadline",
  title: "Deadline",
  project,
  timing: { allDay: false, start: "2026-08-11T23:00:00.000Z", end: null },
  status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false },
  permissions: { canDrag: true, canResize: false },
  deadlineLocalCivil: "2026-08-12T09:00",
  deadlineVersion: 2,
  reminderOffsetsMinutes: [],
  ...overrides,
});

const checklist: CalendarEventDto = {
  id: "checklist:22222222-2222-4222-8222-222222222222",
  kind: "checklist",
  title: "Select hero images",
  project,
  assignee: { id: "33333333-3333-4333-8333-333333333333", name: "Maya Editor", roleLabel: "Editor", isExternal: false, active: true },
  timing: { allDay: true, start: "2026-08-12", end: "2026-08-14" },
  status: { overdue: false, delivered: false, completed: true, sameAssigneeOverlap: true },
  schedule: { state: "range", version: 2, zone: PRODUCTION_CALENDAR_ZONE, start: { kind: "date", localCivil: "2026-08-12", instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" }, end: { kind: "date", localCivil: "2026-08-13", instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" }, due: "2026-08-13" },
  permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canScheduleRange: true },
};

const dueOnlyChecklist: CalendarEventDto = {
  ...checklist,
  id: "checklist:due-only",
  timing: { allDay: true, start: "2026-08-12", end: null },
  schedule: { state: "due_only", version: 2, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: { kind: "date", localCivil: "2026-08-12", instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" }, due: "2026-08-12" },
  permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true },
};

describe("production calendar FullCalendar event mapping", () => {
  it("keeps timed instants verbatim and omits milestone ends", () => {
    const mapped = mapCalendarEventToFullCalendar(deadline());
    expect(mapped).toMatchObject({ id: deadline().id, title: "Deadline", start: "2026-08-11T23:00:00.000Z", allDay: false, editable: true, startEditable: true, durationEditable: false });
    expect(mapped).not.toHaveProperty("end");
    expect(mapped.extendedProps).toEqual({ dto: deadline() });
  });

  it("preserves all-day exclusive ends and carries the complete DTO", () => {
    const mapped = mapCalendarEventToFullCalendar(checklist);
    expect(mapped).toMatchObject({ start: "2026-08-12", end: "2026-08-14", allDay: true, extendedProps: { dto: checklist } });
    expect(mapped.editable).toBe(true);
    expect(mapped.startEditable).toBe(true);
    expect(mapped.durationEditable).toBe(true);
    expect(mapped.resourceEditable).toBe(false);
  });

  it("maps checklist drag and resize flags from server permissions", () => {
    expect(mapCalendarEventToFullCalendar(dueOnlyChecklist)).toMatchObject({ editable: true, startEditable: true, durationEditable: false, resourceEditable: false });
    expect(mapCalendarEventToFullCalendar({ ...checklist, permissions: { ...checklist.permissions, canResize: false } })).toMatchObject({ editable: true, startEditable: true, durationEditable: false });
    expect(mapCalendarEventToFullCalendar({ ...checklist, permissions: { ...checklist.permissions, canDrag: false } })).toMatchObject({ editable: false, startEditable: false, durationEditable: true });
  });

  it("derives Quincy-scoped kind and status classes", () => {
    expect(mapCalendarEventToFullCalendar(deadline({ status: { overdue: true, delivered: true, completed: false, sameAssigneeOverlap: false } })).classNames).toEqual(expect.arrayContaining(["qc-event--project", "is-overdue", "is-delivered"]));
    expect(mapCalendarEventToFullCalendar(checklist).classNames).toEqual(expect.arrayContaining(["qc-event--checklist", "is-completed", "is-overlap"]));
  });

  it("maps the response order without spreading storage fields", () => {
    const mapped = mapCalendarEventsToFullCalendar([deadline(), checklist]);
    expect(mapped).toHaveLength(2);
    expect(mapped[0]).not.toHaveProperty("project");
    expect(mapped[0]?.extendedProps?.dto).toEqual(deadline());
  });
});
