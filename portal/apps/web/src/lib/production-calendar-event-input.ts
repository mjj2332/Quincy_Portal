import type { EventInput } from "@fullcalendar/react";
import type { CalendarEventDto } from "@quincy/shared";

function classNamesFor(event: CalendarEventDto): string[] {
  const classes = [event.kind === "project_deadline" ? "qc-event--project" : "qc-event--checklist"];
  if (event.status.overdue) classes.push("is-overdue");
  if (event.status.delivered) classes.push("is-delivered");
  if (event.status.completed) classes.push("is-completed");
  if (event.status.sameAssigneeOverlap) classes.push("is-overlap");
  return classes;
}

export function mapCalendarEventToFullCalendar(event: CalendarEventDto): EventInput {
  const timing = event.timing;
  return {
    id: event.id,
    title: event.title,
    start: timing.start,
    ...(timing.end === null ? {} : { end: timing.end }),
    allDay: timing.allDay,
    extendedProps: { dto: event },
    editable: false,
    startEditable: false,
    durationEditable: false,
    classNames: classNamesFor(event),
  };
}

export function mapCalendarEventsToFullCalendar(events: readonly CalendarEventDto[]): EventInput[] {
  return events.map(mapCalendarEventToFullCalendar);
}
