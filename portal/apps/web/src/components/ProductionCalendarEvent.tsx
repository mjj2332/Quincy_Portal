import type { CalendarEventDto, ProductionCalendarSubview } from "@quincy/shared";

function StageBadge({ stageKey }: { stageKey: string }) {
  return <span className="qc-cal-stage" title={`Stage: ${stageKey}`}>Stage: {stageKey}</span>;
}

function Pill({ children, tone }: { children: string; tone: "overdue" | "delivered" | "completed" }) {
  return <span className={`qc-cal-pill qc-cal-pill--${tone}`}>{children}</span>;
}

export type ProductionCalendarEventProps = {
  event: CalendarEventDto;
  subview: ProductionCalendarSubview;
  compact?: boolean;
  onMoveReschedule?: (event: Extract<CalendarEventDto, { kind: "project_deadline" }>) => void;
};

export function ProductionCalendarEvent({ event, subview, compact = false, onMoveReschedule }: ProductionCalendarEventProps) {
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
      </div>
    </article>
  );
}
