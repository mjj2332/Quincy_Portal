import type { CalendarEventDto, ProductionCalendarSubview, Role } from "@quincy/shared";

/**
 * #222 — the Calendar's EFFECTIVE event permissions: the server's per-event permissions narrowed by
 * the surface's live state. Lifted verbatim from `ProductionCalendar.tsx`'s `renderEvents` so the
 * FullCalendar build and the ReUI event-calendar build apply one rule set; no behaviour change.
 * It only ever NARROWS a server permission, and returns the SAME object when nothing narrows (the
 * render memo relies on that identity).
 */
export type CalendarPermissionContext = {
  subview: ProductionCalendarSubview;
  role: Role;
  interactionBlocked: boolean;
  settlePending: boolean;
  checklistNeedsAttention: ReadonlySet<string>;
  /** `CHECKLIST_SCHEDULE_RANGES_ENABLED && !checklistRangeSchedulingDisabled`. */
  rangesEnabled: boolean;
  deadlineMovementDisabled: boolean;
};

export function effectiveCalendarEventPermissions(event: CalendarEventDto, ctx: CalendarPermissionContext): CalendarEventDto {
  if (event.kind === "checklist") {
    const attention = ctx.checklistNeedsAttention.has(event.id);
    const interactionAllowed = ctx.subview !== "agenda" && !ctx.interactionBlocked && !ctx.settlePending && !attention;
    const rangeAllowed = event.schedule.state !== "range" || (ctx.rangesEnabled && event.permissions.canScheduleRange);
    const canDrag = event.permissions.canDrag && interactionAllowed && rangeAllowed;
    const canResize = event.permissions.canResize && interactionAllowed && ctx.rangesEnabled && event.permissions.canScheduleRange;
    const canOpenScheduleEditor = event.permissions.canOpenScheduleEditor && !ctx.interactionBlocked && !ctx.settlePending && !attention;
    if (canDrag === event.permissions.canDrag && canResize === event.permissions.canResize && canOpenScheduleEditor === event.permissions.canOpenScheduleEditor) return event;
    return { ...event, permissions: { ...event.permissions, canDrag, canResize, canOpenScheduleEditor } } as CalendarEventDto;
  }
  const canDrag = ctx.role === "admin"
    && event.permissions.canDrag
    && !ctx.deadlineMovementDisabled
    && !ctx.interactionBlocked
    && !ctx.settlePending;
  return canDrag === event.permissions.canDrag ? event : { ...event, permissions: { ...event.permissions, canDrag } } as CalendarEventDto;
}
