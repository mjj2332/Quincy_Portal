import type {
  ChecklistCalendarUnscheduledEntryDto,
  ProductionCalendarSubview,
  ProjectCalendarUnscheduledEntryDto,
} from "@quincy/shared";
import { useEffect, useRef, type ReactNode } from "react";
import { Draggable } from "@fullcalendar/react/interaction";

type UnscheduledFacet = { matched: number; returned: number; truncated: boolean };

export type ProductionCalendarUnscheduledPanelProps = {
  projectEntries: ProjectCalendarUnscheduledEntryDto[];
  checklistEntries: ChecklistCalendarUnscheduledEntryDto[];
  facets: { project: UnscheduledFacet; checklist: UnscheduledFacet };
  subview: ProductionCalendarSubview;
  rangesEnabled: boolean;
  onScheduleProject: (entry: ProjectCalendarUnscheduledEntryDto) => void;
  onScheduleChecklist: (entry: ChecklistCalendarUnscheduledEntryDto) => void;
  disabled?: boolean;
  dragSuppressed?: boolean;
};

const STAGE_LABELS: Record<string, string> = {
  awaiting_raw: "Awaiting RAW",
  raw_review: "RAW review",
  editing_autohdr: "Editing · autoHDR",
  editing: "Editing",
  edited_review: "Edited review",
  delivered: "Delivered",
};

function stageLabel(stageKey: string): string {
  return STAGE_LABELS[stageKey] ?? stageKey;
}

function Pill({ children, tone }: { children: string; tone: "delivered" }) {
  return <span className={`qc-cal-pill qc-cal-pill--${tone}`}>{children}</span>;
}

function CountLine({ facet }: { facet: UnscheduledFacet }) {
  return <div className="qc-calendar-unscheduled__count">
    <span>Showing {facet.returned} of {facet.matched}</span>
    {facet.truncated && <span>{facet.matched - facet.returned} more — refine filters or search</span>}
  </div>;
}

function ProjectContent({ entry }: { entry: ProjectCalendarUnscheduledEntryDto }) {
  return <>
    <div className="qc-calendar-unscheduled__meta"><span>Deadline</span><span>Unscheduled</span></div>
    <h3 title={entry.project.street}>{entry.project.street}</h3>
    <p title={entry.title}>{entry.title}</p>
    <div className="qc-calendar-unscheduled__facts">
      <span>Stage: {stageLabel(entry.project.stageKey)}</span>
      {entry.project.delivered && <Pill tone="delivered">Delivered</Pill>}
    </div>
  </>;
}

function ChecklistContent({ entry }: { entry: ChecklistCalendarUnscheduledEntryDto }) {
  return <>
    <div className="qc-calendar-unscheduled__meta"><span>Checklist</span><span>{entry.reason === "schedule_needs_attention" ? "Needs attention" : "Unscheduled"}</span></div>
    <h3 title={entry.title}>{entry.title}</h3>
    <p title={entry.project.street}>{entry.project.street}</p>
    <div className="qc-calendar-unscheduled__facts">
      <span>Assignee: {entry.assignee?.name ?? "Unassigned"}</span>
      <span>Stage: {stageLabel(entry.project.stageKey)}</span>
    </div>
  </>;
}

function externalEventData(title: string, id: string, kind: "project" | "checklist"): string {
  return JSON.stringify({ title, extendedProps: { unscheduledId: id, unscheduledKind: kind } });
}

export function unscheduledProjectDraggable(entry: ProjectCalendarUnscheduledEntryDto): boolean {
  return !entry.project.delivered && entry.permissions.canDrag;
}

export function unscheduledChecklistDraggable(entry: ChecklistCalendarUnscheduledEntryDto, rangesEnabled: boolean): boolean {
  return rangesEnabled && entry.reason === "unscheduled" && entry.permissions.canDrag && entry.permissions.canScheduleRange;
}

function projectCanDrag(entry: ProjectCalendarUnscheduledEntryDto, disabled: boolean): boolean {
  return !disabled && unscheduledProjectDraggable(entry);
}

function checklistCanDrag(entry: ChecklistCalendarUnscheduledEntryDto, rangesEnabled: boolean, disabled: boolean): boolean {
  return !disabled && unscheduledChecklistDraggable(entry, rangesEnabled);
}

function ProjectRow({ entry, subview, onSchedule, disabled, dragSuppressed }: {
  entry: ProjectCalendarUnscheduledEntryDto;
  subview: ProductionCalendarSubview;
  onSchedule: (entry: ProjectCalendarUnscheduledEntryDto) => void;
  disabled: boolean;
  dragSuppressed: boolean;
}) {
  // Eligibility is a permanent property of the entry (not delivered, has the
  // capability). Transient `disabled` (interaction blocked / settling) only
  // disables the action button — it must never demote an eligible entry to the
  // "Deadline is read-only" row, which is reserved for genuine ineligibility.
  const eligible = unscheduledProjectDraggable(entry);
  const actionMode = subview === "agenda" || dragSuppressed || disabled;
  const content = <ProjectContent entry={entry} />;

  if (!eligible) {
    return <button type="button" className="qc-calendar-unscheduled__row qc-calendar-unscheduled__row--project is-disabled" disabled aria-label={`${entry.project.street}: Deadline is read-only`} data-unscheduled-id={entry.id}>
      {content}
      <span className="qc-calendar-unscheduled__readonly">Deadline is read-only</span>
    </button>;
  }

  if (actionMode) {
    return <article className="qc-calendar-unscheduled__row qc-calendar-unscheduled__row--project" data-unscheduled-id={entry.id}>
      {content}
      <button className="button button--text qc-calendar-unscheduled__action" type="button" disabled={disabled} onClick={() => onSchedule(entry)}>Schedule Deadline</button>
    </article>;
  }

  // FullCalendar's Draggable (registered on the panel) drives the external drag
  // via the data-event attribute — no HTML5 `draggable` attribute (that adds a
  // second native drag ghost and fights FC's pointer dragging).
  return <article
    className="qc-calendar-unscheduled__row qc-calendar-unscheduled__row--project is-draggable"
    data-unscheduled-id={entry.id}
    data-unscheduled-kind="project"
    data-event={externalEventData(entry.title, entry.id, "project")}
  >{content}</article>;
}

function ChecklistRow({ entry, subview, rangesEnabled, onSchedule, disabled, dragSuppressed }: {
  entry: ChecklistCalendarUnscheduledEntryDto;
  subview: ProductionCalendarSubview;
  rangesEnabled: boolean;
  onSchedule: (entry: ChecklistCalendarUnscheduledEntryDto) => void;
  disabled: boolean;
  dragSuppressed: boolean;
}) {
  const attention = entry.reason === "schedule_needs_attention";
  const legacy = attention && entry.attentionReason === "legacy_unresolved";
  const invalid = attention && entry.attentionReason === "invalid";
  const actionMode = subview === "agenda" || dragSuppressed;
  const canDrag = !actionMode && checklistCanDrag(entry, rangesEnabled, disabled);
  const showAction = entry.permissions.canOpenScheduleEditor && (actionMode || !canDrag);
  const content = <ChecklistContent entry={entry} />;

  if (canDrag) {
    return <article
      className="qc-calendar-unscheduled__row qc-calendar-unscheduled__row--checklist is-draggable"
      data-unscheduled-id={entry.id}
      data-unscheduled-kind="checklist"
      data-event={externalEventData(entry.title, entry.id, "checklist")}
    >
      {content}
    </article>;
  }

  return <article className={`qc-calendar-unscheduled__row qc-calendar-unscheduled__row--checklist${attention ? " is-attention" : ""}`} data-unscheduled-id={entry.id}>
    {content}
    {invalid ? <p className="qc-calendar-unscheduled__attention" role="status">This checklist schedule needs repair. Repair is unavailable in Calendar.</p> : showAction && <button className="button button--text qc-calendar-unscheduled__action" type="button" disabled={disabled} onClick={() => onSchedule(entry)}>{legacy ? "Repair schedule" : "Schedule"}</button>}
  </article>;
}

function Section<T>({ label, facet, entries, children }: { label: string; facet: UnscheduledFacet; entries: T[]; children: ReactNode }) {
  return <section className="qc-calendar-unscheduled__section" aria-label={label}>
    <header className="qc-calendar-unscheduled__section-head"><h2>{label}</h2><CountLine facet={facet} /></header>
    {entries.length === 0 ? <p className="qc-calendar-unscheduled__empty">Nothing unscheduled</p> : <div className="qc-calendar-unscheduled__rows">{children}</div>}
  </section>;
}

export function ProductionCalendarUnscheduledPanel({ projectEntries, checklistEntries, facets, subview, rangesEnabled, onScheduleProject, onScheduleChecklist, disabled = false, dragSuppressed = false }: ProductionCalendarUnscheduledPanelProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const hasExternalDraggable = !disabled && !dragSuppressed && subview !== "agenda" && (
    projectEntries.some((entry) => projectCanDrag(entry, disabled))
    || checklistEntries.some((entry) => checklistCanDrag(entry, rangesEnabled, disabled))
  );

  useEffect(() => {
    if (!hasExternalDraggable || !panelRef.current) return;
    const draggable = new Draggable(panelRef.current, { itemSelector: "[data-event]" });
    return () => draggable.destroy();
  }, [hasExternalDraggable]);

  return <aside ref={panelRef} className={`qc-calendar-unscheduled${disabled ? " is-disabled" : ""}`} aria-label="Unscheduled work">
    <Section label="Unscheduled projects" facet={facets.project} entries={projectEntries}>
      {projectEntries.map((entry) => <ProjectRow key={entry.id} entry={entry} subview={subview} onSchedule={onScheduleProject} disabled={disabled} dragSuppressed={dragSuppressed} />)}
    </Section>
    <Section label="Unscheduled checklist items" facet={facets.checklist} entries={checklistEntries}>
      {checklistEntries.map((entry) => <ChecklistRow key={entry.id} entry={entry} subview={subview} rangesEnabled={rangesEnabled} onSchedule={onScheduleChecklist} disabled={disabled} dragSuppressed={dragSuppressed} />)}
    </Section>
  </aside>;
}
