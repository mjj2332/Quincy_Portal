// Happy-dom proves Calendar markup and callback wiring only; it cannot prove
// sensor activation, geometry, scroll, browser focus timing, or AT delivery.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRODUCTION_CALENDAR_ZONE, type CalendarEventDto } from "@quincy/shared";
import { ProductionCalendarEvent } from "./ProductionCalendarEvent";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = {
  id: "11111111-1111-4111-8111-111111111111",
  street: "12 Harbour Street",
  stageKey: "editing_autohdr" as const,
  checklist: { completed: 1, total: 2 },
  delivered: false,
};
const assignee = { id: "22222222-2222-4222-8222-222222222222", name: "Maya Editor", roleLabel: "Editor", isExternal: false, active: true };

function checklist(sameAssigneeOverlap: boolean): CalendarEventDto {
  return {
    id: "checklist:item",
    kind: "checklist",
    title: "Select hero images",
    project,
    assignee,
    timing: { allDay: true, start: "2026-08-12", end: null },
    status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap },
    schedule: { state: "due_only", version: 1, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: { kind: "date", localCivil: "2026-08-12", instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" }, due: "2026-08-12" },
    permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true },
  };
}

describe("ProductionCalendarEvent overlap state", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("renders overlap text only for overlapping checklist events", () => {
    act(() => root.render(<ProductionCalendarEvent event={checklist(true)} subview="week" onChecklistSchedule={() => undefined} />));
    expect(host.textContent).toContain("Overlaps another task");

    act(() => root.render(<ProductionCalendarEvent event={checklist(false)} subview="week" onChecklistSchedule={() => undefined} />));
    expect(host.textContent).not.toContain("Overlaps another task");
  });

  it("does not expose an overlap pill for a project Deadline", () => {
    const deadline = {
      id: "project-deadline:project",
      kind: "project_deadline" as const,
      title: "Project handoff",
      project,
      timing: { allDay: false as const, start: "2026-08-12T00:00:00.000Z", end: null },
      status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: true },
      permissions: { canDrag: true, canResize: false },
      deadlineLocalCivil: "2026-08-12T10:00",
      deadlineVersion: 1,
      reminderOffsetsMinutes: [],
    } as unknown as CalendarEventDto;
    act(() => root.render(<ProductionCalendarEvent event={deadline} subview="week" onMoveReschedule={() => undefined} />));
    expect(host.textContent).not.toContain("Overlaps another task");
    expect(host.querySelector("a")).toBeNull();
    expect(host.querySelector<HTMLElement>("article")?.tabIndex).toBe(-1);
    expect(host.querySelectorAll("button")).toHaveLength(1);
  });

  it("keeps current Calendar events action-only with no project anchor", () => {
    act(() => root.render(<ProductionCalendarEvent event={checklist(false)} subview="week" onChecklistSchedule={() => undefined} />));
    const event = host.querySelector<HTMLElement>("article.qc-cal-event-card")!;
    expect(event.tabIndex).toBe(-1);
    expect(event.querySelector("a")).toBeNull();
    expect(event.querySelectorAll("button")).toHaveLength(1);
    expect(event.querySelector("button")?.textContent).toBe("Reschedule");
  });
});
