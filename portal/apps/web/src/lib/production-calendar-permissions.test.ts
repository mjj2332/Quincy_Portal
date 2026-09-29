import { describe, expect, it } from "vitest";
import { effectiveCalendarEventPermissions, type CalendarPermissionContext } from "./production-calendar-permissions";
import { dated, deadlineEvent, dueEvent, rangeEvent, timed } from "../testing/production-calendar-fixtures";

const open: CalendarPermissionContext = {
  subview: "week",
  role: "admin",
  interactionBlocked: false,
  settlePending: false,
  checklistNeedsAttention: new Set<string>(),
  deadlineMovementDisabled: false,
};

const range = () => rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00"));

describe("effective Calendar event permissions (#222 lift of ProductionCalendar's renderEvents rules)", () => {
  it("returns the SAME object when nothing is narrowed", () => {
    const event = range();
    expect(effectiveCalendarEventPermissions(event, open)).toBe(event);
    const deadline = deadlineEvent("2026-08-27T09:00");
    expect(effectiveCalendarEventPermissions(deadline, open)).toBe(deadline);
  });

  it("agenda turns off checklist drag and resize but keeps the schedule editor", () => {
    const result = effectiveCalendarEventPermissions(range(), { ...open, subview: "agenda" });
    expect(result.permissions).toMatchObject({ canDrag: false, canResize: false, canOpenScheduleEditor: true });
  });

  it("day and days stay interactive, like month and week", () => {
    for (const subview of ["month", "week", "day", "days"] as const) {
      const event = range();
      expect(effectiveCalendarEventPermissions(event, { ...open, subview }), subview).toBe(event);
    }
  });

  it("a blocked or settling calendar disables every checklist affordance", () => {
    for (const ctx of [{ ...open, interactionBlocked: true }, { ...open, settlePending: true }]) {
      expect(effectiveCalendarEventPermissions(range(), ctx).permissions).toMatchObject({ canDrag: false, canResize: false, canOpenScheduleEditor: false });
    }
  });

  it("an attention item keeps nothing", () => {
    const event = range();
    const result = effectiveCalendarEventPermissions(event, { ...open, checklistNeedsAttention: new Set([event.id]) });
    expect(result.permissions).toMatchObject({ canDrag: false, canResize: false, canOpenScheduleEditor: false });
  });

  it("a range needs the server canScheduleRange permission to drag or resize; a due item does not", () => {
    expect(effectiveCalendarEventPermissions(rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00"), { canScheduleRange: false }), open).permissions).toMatchObject({ canDrag: false, canResize: false });
    const due = dueEvent(dated("2026-08-27"));
    expect(effectiveCalendarEventPermissions(due, open)).toBe(due);
  });

  it("never widens a server permission", () => {
    const event = rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00"), { canDrag: false, canResize: false, canOpenScheduleEditor: false });
    expect(effectiveCalendarEventPermissions(event, open)).toBe(event);
  });

  it("a Deadline drags only for an Admin, and not while moves are disabled, blocked or settling", () => {
    const deadline = deadlineEvent("2026-08-27T09:00");
    expect(effectiveCalendarEventPermissions(deadline, { ...open, role: "editor" }).permissions.canDrag).toBe(false);
    expect(effectiveCalendarEventPermissions(deadline, { ...open, deadlineMovementDisabled: true }).permissions.canDrag).toBe(false);
    expect(effectiveCalendarEventPermissions(deadline, { ...open, interactionBlocked: true }).permissions.canDrag).toBe(false);
    expect(effectiveCalendarEventPermissions(deadline, { ...open, settlePending: true }).permissions.canDrag).toBe(false);
    // agenda does not gate a Deadline here (the old surface refuses the drop itself)
    expect(effectiveCalendarEventPermissions(deadline, { ...open, subview: "agenda" })).toBe(deadline);
  });
});
