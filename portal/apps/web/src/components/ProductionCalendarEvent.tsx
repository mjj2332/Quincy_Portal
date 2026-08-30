import type { CalendarEventDto, CalendarUnscheduledEntryDto, ChecklistCalendarEventDto, ChecklistCalendarUnscheduledEntryDto, ProductionCalendarSubview, ProjectDeadlineCalendarEventDto } from "@quincy/shared";
import { checklistScheduleEditorButtonLabel } from "./ProductionCalendarScheduleEditor";

function StageBadge({ stageKey }: { stageKey: string }) {
  return <span className="qc-cal-stage" title={`Stage: ${stageKey}`}>Stage: {stageKey}</span>;
}

function Pill({ children, tone }: { children: string; tone: "overdue" | "delivered" | "completed" | "overlap" }) {
  return <span className={`qc-cal-pill qc-cal-pill--${tone}`}>{children}</span>;
}

export type ProductionCalendarEventProps = {
  event: CalendarEventDto;
  subview: ProductionCalendarSubview;
  compact?: boolean;
  onMoveReschedule?: (event: ProjectDeadlineCalendarEventDto) => void;
  onChecklistSchedule?: (event: ChecklistCalendarEventDto) => void;
  needsAttention?: boolean;
};

export function ProductionCalendarEvent({ event, subview, compact = false, onMoveReschedule, onChecklistSchedule, needsAttention = false }: ProductionCalendarEventProps) {
  const className = `qc-cal-event-card qc-cal-event-card--${event.kind}${compact ? " is-compact" : ""}`;
  if (event.kind === "project_deadline") {
    return (
      <article className={className} data-event-id={event.id} data-subview={subview} aria-readonly="true" tabIndex={-1}>
        <div className="qc-cal-event-card__meta"><span>Deadline</span><StageBadge stageKey={event.project.stageKey} /></div>
        <h4 title={event.project.street}>{event.project.street}</h4>
        <p className="qc-cal-event-card__title" title={event.title}>{event.title}</p>
        {!compact && <dl className="qc-cal-event-card__details"><div><dt>Checklist</dt><dd>{event.project.checklist.completed}/{event.project.checklist.total}</dd></div></dl>}
        <div className="qc-cal-event-card__pills">
          {event.status.overdue && <Pill tone="overdue">Overdue</Pill>}
          {event.status.delivered && <Pill tone="delivered">Delivered</Pill>}
        </div>
        {event.permissions.canDrag && onMoveReschedule && <button className="button button--text qc-cal-event-card__move" type="button" data-focus-key={`calendar-move:${event.id}`} onClick={() => onMoveReschedule(event)}>Move / Reschedule</button>}
      </article>
    );
  }

  return (
    <article className={className} data-event-id={event.id} data-subview={subview} aria-readonly="true" tabIndex={-1}>
      <div className="qc-cal-event-card__meta"><span>Checklist</span><StageBadge stageKey={event.project.stageKey} /></div>
      <h4 title={event.title}>{event.title}</h4>
      <p className="qc-cal-event-card__title" title={event.project.street}>{event.project.street}</p>
      <dl className="qc-cal-event-card__details"><div><dt>Assignee</dt><dd>{event.assignee?.name ?? "Unassigned"}</dd></div></dl>
      <div className="qc-cal-event-card__pills">
        {event.status.completed && <Pill tone="completed">✓ Completed</Pill>}
        {event.status.overdue && <Pill tone="overdue">Overdue</Pill>}
        {event.status.delivered && <Pill tone="delivered">Delivered</Pill>}
        {event.status.sameAssigneeOverlap === true && <Pill tone="overlap">Overlaps another task</Pill>}
      </div>
      {needsAttention ? <p className="qc-cal-event-card__attention" role="status">Schedule data needs attention. Repair is unavailable in Calendar.</p> : !compact && event.permissions.canOpenScheduleEditor && onChecklistSchedule && <button className="button button--text qc-cal-event-card__move" type="button" data-focus-key={`calendar-move:${event.id}`} onClick={() => onChecklistSchedule(event)}>{checklistScheduleEditorButtonLabel(event)}</button>}
    </article>
  );
}

export type ProductionCalendarUnscheduledEntryProps = {
  entry: ChecklistCalendarUnscheduledEntryDto;
  onChecklistSchedule?: (entry: ChecklistCalendarUnscheduledEntryDto) => void;
};

/** Action-only renderer for the future Unscheduled source; it does not make the panel draggable. */
export function ProductionCalendarUnscheduledEntry({ entry, onChecklistSchedule }: ProductionCalendarUnscheduledEntryProps) {
  const invalid = "attentionReason" in entry && entry.attentionReason === "invalid";
  const legacy = "attentionReason" in entry && entry.attentionReason === "legacy_unresolved";
  return <article className="qc-cal-event-card qc-cal-event-card--checklist qc-cal-event-card--unscheduled" data-event-id={entry.id} aria-readonly="true">
    <div className="qc-cal-event-card__meta"><span>Checklist</span><span>Unscheduled</span></div>
    <h4 title={entry.title}>{entry.title}</h4>
    <p className="qc-cal-event-card__title" title={entry.project.street}>{entry.project.street}</p>
    {invalid ? <p className="qc-cal-event-card__attention" role="status">Schedule data needs attention. Repair is unavailable in Calendar.</p> : onChecklistSchedule && entry.permissions.canOpenScheduleEditor && <button className="button button--text qc-cal-event-card__move" type="button" data-focus-key={`calendar-move:${entry.id}`} onClick={() => onChecklistSchedule(entry)}>{legacy ? "Repair schedule" : "Schedule"}</button>}
  </article>;
}

export type ProductionCalendarSourceRendererProps = {
  entry: CalendarUnscheduledEntryDto;
  onChecklistSchedule?: (entry: ChecklistCalendarUnscheduledEntryDto) => void;
};

export function ProductionCalendarUnscheduledSource({ entry, onChecklistSchedule }: ProductionCalendarSourceRendererProps) {
  if (entry.kind !== "checklist") return null;
  return <ProductionCalendarUnscheduledEntry entry={entry} onChecklistSchedule={onChecklistSchedule} />;
}
