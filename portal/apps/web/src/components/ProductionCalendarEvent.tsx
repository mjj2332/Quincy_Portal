import { useRef, type ReactNode } from "react";
import type { CalendarEventDto, CalendarUnscheduledEntryDto, ChecklistCalendarEventDto, ChecklistCalendarUnscheduledEntryDto, ProductionCalendarSubview, ProjectDeadlineCalendarEventDto } from "@quincy/shared";
import { cn } from "@/lib/utils";
import { checklistScheduleEditorButtonLabel } from "./ProductionCalendarScheduleEditor";
import { buttonClasses } from "./quincy/Button";
import { StatusPill, type StatusTone } from "./quincy/StatusPill";
import { CAL_PILL, CARD_ACTION, CARD_ATTENTION, CARD_HEADING, CARD_META, CARD_SUBTITLE } from "./production-calendar-classes";

const EVENT_CARD = "min-w-0 px-[8px] py-[7px] border-l-[3px] [border-left-style:solid] text-foreground overflow-hidden";
const EVENT_CARD_KIND: Record<"project_deadline" | "checklist", string> = {
  project_deadline: "border-l-signal-positive",
  checklist: "border-l-signal-info",
};
const EVENT_CARD_COMPACT =
  "px-[8px] py-[6px] border border-solid border-border border-l-[3px] bg-background";
const EVENT_CARD_STAGE = "max-w-[55%] overflow-hidden text-ellipsis whitespace-nowrap text-foreground-secondary";
const EVENT_CARD_LINK = "text-inherit no-underline hover:underline hover:underline-offset-2 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-current focus-visible:outline-offset-2";
const EVENT_CARD_DETAILS = "grid gap-[2px] mt-[5px] mb-0 text-[11px]";
const EVENT_CARD_DETAILS_ROW = "flex gap-[4px]";
const EVENT_CARD_PILLS = "flex flex-wrap gap-[4px] mt-[6px]";
const EVENT_CARD_ATTENTION = cn("mt-[8px]", CARD_ATTENTION);
// `.qc-cal-event-card__move` + its coarse-block padding/44px floor. `buttonClasses("text")`
// already carries `max-[721px]:min-h-[44px]` and `px-0`.
const EVENT_CARD_MOVE = cn("mt-[8px]", CARD_ACTION);

/**
 * Compact cards carry `border-border` from EVENT_CARD_COMPACT, which tailwind-merge treats as
 * conflicting with `border-l-signal-*` (border-color vs border-color-l). The kind colour must
 * therefore come LAST or it is silently dropped — no error, and every test stays green.
 * `ProductionCalendarUnscheduledPanel.tsx` already orders it this way.
 */
export function eventCardClassName(kind: "project_deadline" | "checklist", compact = false): string {
  return cn("qc-cal-event-card", EVENT_CARD, compact && EVENT_CARD_COMPACT, EVENT_CARD_KIND[kind]);
}

export type ProjectCalendarAnchorProps = {
  href: string;
  onOpenProject?: () => void;
  children: ReactNode;
};

/**
 * A real project anchor that can live inside FullCalendar's draggable event
 * content. Native modified clicks keep their browser behavior; an ordinary
 * click or keyboard activation is enhanced by the Calendar route owner. The
 * small movement threshold prevents FullCalendar's pointer drag from turning
 * its terminating click into a sheet open.
 */
export function ProjectCalendarAnchor({ href, onOpenProject, children }: ProjectCalendarAnchorProps) {
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const resetSuppression = () => {
    if (!suppressClickRef.current) return;
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
  };
  const startPointer = (x: number, y: number) => {
    originRef.current = { x, y };
    suppressClickRef.current = false;
  };
  const movePointer = (x: number, y: number) => {
    const origin = originRef.current;
    if (!origin) return;
    // FullCalendar's default eventDragMinDistance is 5px — suppress strictly
    // below that so a gesture FullCalendar recognizes as a drag can never
    // also open the sheet via this anchor's terminating click.
    if (Math.hypot(x - origin.x, y - origin.y) >= 4) suppressClickRef.current = true;
  };
  const endPointer = () => {
    originRef.current = null;
    resetSuppression();
  };
  return <a
    className={EVENT_CARD_LINK}
    data-testid="calendar-project-link"
    href={href}
    onMouseDown={(event) => startPointer(event.clientX, event.clientY)}
    onMouseMove={(event) => movePointer(event.clientX, event.clientY)}
    onMouseUp={endPointer}
    onTouchStart={(event) => { const point = event.touches[0]; if (point) startPointer(point.clientX, point.clientY); }}
    onTouchMove={(event) => { const point = event.touches[0]; if (point) movePointer(point.clientX, point.clientY); }}
    onTouchEnd={endPointer}
    onDragStart={(event) => event.preventDefault()}
    onKeyDown={(event) => {
      // Space deliberately keeps native anchor behavior (page scroll, no
      // activation) per the approved plan — only Enter is synthesized here.
      if (event.key !== "Enter" || event.repeat) return;
      event.preventDefault();
      event.currentTarget.click();
    }}
    onClick={(event) => {
      if (suppressClickRef.current) {
        event.preventDefault();
        event.stopPropagation();
        suppressClickRef.current = false;
        return;
      }
      if (!onOpenProject || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      onOpenProject();
    }}
  >{children}</a>;
}

function StageBadge({ stageKey }: { stageKey: string }) {
  return <span className={EVENT_CARD_STAGE} title={`Stage: ${stageKey}`}>Stage: {stageKey}</span>;
}

const TONE: Record<"overdue" | "delivered" | "completed" | "overlap", StatusTone> = {
  overdue: "critical",
  delivered: "positive",
  completed: "positive",
  overlap: "caution",
};

function Pill({ children, tone }: { children: string; tone: "overdue" | "delivered" | "completed" | "overlap" }) {
  return <StatusPill tone={TONE[tone]} className={CAL_PILL}>{children}</StatusPill>;
}

export type ProductionCalendarEventProps = {
  event: CalendarEventDto;
  subview: ProductionCalendarSubview;
  compact?: boolean;
  onMoveReschedule?: (event: ProjectDeadlineCalendarEventDto) => void;
  onChecklistSchedule?: (event: ChecklistCalendarEventDto) => void;
  needsAttention?: boolean;
  projectHref?: string;
  onOpenProject?: () => void;
};

export function ProductionCalendarEvent({ event, subview, compact = false, onMoveReschedule, onChecklistSchedule, needsAttention = false, projectHref, onOpenProject }: ProductionCalendarEventProps) {
  const className = eventCardClassName(event.kind, compact);
  if (event.kind === "project_deadline") {
    return (
      <article className={className} data-event-id={event.id} data-subview={subview} aria-readonly="true" tabIndex={-1} data-testid="calendar-event-card">
        <div className={CARD_META}><span>Deadline</span><StageBadge stageKey={event.project.stageKey} /></div>
        <h4 className={CARD_HEADING} title={event.project.street}>{projectHref ? <ProjectCalendarAnchor href={projectHref} onOpenProject={onOpenProject}>{event.project.street}</ProjectCalendarAnchor> : event.project.street}</h4>
        <p className={CARD_SUBTITLE} title={event.title}>{event.title}</p>
        {!compact && <dl className={EVENT_CARD_DETAILS}><div className={EVENT_CARD_DETAILS_ROW}><dt className="text-muted-foreground">Checklist</dt><dd className="m-0">{event.project.checklist.completed}/{event.project.checklist.total}</dd></div></dl>}
        <div className={EVENT_CARD_PILLS}>
          {event.status.overdue && <Pill tone="overdue">Overdue</Pill>}
          {event.status.delivered && <Pill tone="delivered">Delivered</Pill>}
        </div>
        {event.permissions.canDrag && onMoveReschedule && <button className={buttonClasses("text", { className: EVENT_CARD_MOVE })} type="button" data-focus-key={`calendar-move:${event.id}`} onClick={() => onMoveReschedule(event)}>Move / Reschedule</button>}
      </article>
    );
  }

  return (
    <article className={className} data-event-id={event.id} data-subview={subview} aria-readonly="true" tabIndex={-1} data-testid="calendar-event-card">
      <div className={CARD_META}><span>Checklist</span><StageBadge stageKey={event.project.stageKey} /></div>
      <h4 className={CARD_HEADING} title={event.title}>{event.title}</h4>
      <p className={CARD_SUBTITLE} title={event.project.street}>{projectHref ? <ProjectCalendarAnchor href={projectHref} onOpenProject={onOpenProject}>{event.project.street}</ProjectCalendarAnchor> : event.project.street}</p>
      <dl className={cn(EVENT_CARD_DETAILS, compact && "mt-[3px]")}><div className={EVENT_CARD_DETAILS_ROW}><dt className="text-muted-foreground">Assignee</dt><dd className="m-0">{event.assignee?.name ?? "Unassigned"}</dd></div></dl>
      <div className={EVENT_CARD_PILLS}>
        {event.status.completed && <Pill tone="completed">✓ Completed</Pill>}
        {event.status.overdue && <Pill tone="overdue">Overdue</Pill>}
        {event.status.delivered && <Pill tone="delivered">Delivered</Pill>}
        {event.status.sameAssigneeOverlap === true && <Pill tone="overlap">Overlaps another task</Pill>}
      </div>
      {needsAttention ? <p className={EVENT_CARD_ATTENTION} role="status">Schedule data needs attention. Repair is unavailable in Calendar.</p> : !compact && event.permissions.canOpenScheduleEditor && onChecklistSchedule && <button className={buttonClasses("text", { className: EVENT_CARD_MOVE })} type="button" data-focus-key={`calendar-move:${event.id}`} onClick={() => onChecklistSchedule(event)}>{checklistScheduleEditorButtonLabel(event)}</button>}
    </article>
  );
}

export type ProductionCalendarUnscheduledEntryProps = {
  entry: ChecklistCalendarUnscheduledEntryDto;
  onChecklistSchedule?: (entry: ChecklistCalendarUnscheduledEntryDto) => void;
  projectHref?: string;
  onOpenProject?: () => void;
};

/** Action-only renderer for the future Unscheduled source; it does not make the panel draggable. */
export function ProductionCalendarUnscheduledEntry({ entry, onChecklistSchedule, projectHref, onOpenProject }: ProductionCalendarUnscheduledEntryProps) {
  const invalid = "attentionReason" in entry && entry.attentionReason === "invalid";
  const legacy = "attentionReason" in entry && entry.attentionReason === "legacy_unresolved";
  return <article className={eventCardClassName("checklist")} data-event-id={entry.id} aria-readonly="true">
    <div className={CARD_META}><span>Checklist</span><span>Unscheduled</span></div>
    <h4 className={CARD_HEADING} title={entry.title}>{entry.title}</h4>
    <p className={CARD_SUBTITLE} title={entry.project.street}>{projectHref ? <ProjectCalendarAnchor href={projectHref} onOpenProject={onOpenProject}>{entry.project.street}</ProjectCalendarAnchor> : entry.project.street}</p>
    {invalid ? <p className={EVENT_CARD_ATTENTION} role="status">Schedule data needs attention. Repair is unavailable in Calendar.</p> : onChecklistSchedule && entry.permissions.canOpenScheduleEditor && <button className={buttonClasses("text", { className: EVENT_CARD_MOVE })} type="button" data-focus-key={`calendar-move:${entry.id}`} onClick={() => onChecklistSchedule(entry)}>{legacy ? "Repair schedule" : "Schedule"}</button>}
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
