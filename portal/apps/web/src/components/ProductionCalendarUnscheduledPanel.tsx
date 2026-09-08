import type {
  ChecklistCalendarUnscheduledEntryDto,
  ProductionCalendarSubview,
  ProjectCalendarUnscheduledEntryDto,
} from "@quincy/shared";
import { useEffect, useRef, type ReactNode } from "react";
import { Draggable } from "@fullcalendar/react/interaction";
import { cn } from "@/lib/utils";
import { ProjectCalendarAnchor } from "./ProductionCalendarEvent";
import { buttonClasses } from "./quincy/Button";
import { StatusPill, type StatusTone } from "./quincy/StatusPill";

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
  projectHrefFor?: (projectId: string) => string | undefined;
  onOpenProject?: (projectId: string) => void;
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

const PANEL = "grid gap-[16px] min-w-0";
const PANEL_SECTION = "min-w-0 p-[14px] border border-solid border-border bg-card";
const PANEL_SECTION_HEAD = "grid gap-[6px] mb-[12px] pb-[10px] border-b border-solid border-border";
const PANEL_SECTION_H2 = "m-0 [font:var(--type-h3)] tracking-[-.02em]";
const PANEL_COUNT = "flex flex-wrap gap-x-[10px] gap-y-[4px] text-muted-foreground [font:400_10px/1.35_var(--font-sans)]";
const PANEL_ROWS = "grid gap-[8px]";
const PANEL_ROW =
  "min-w-0 p-[10px] border border-solid border-border border-l-[3px] bg-background text-foreground text-left";
const PANEL_ROW_KIND: Record<"project" | "checklist", string> = {
  project: "border-l-signal-positive",
  checklist: "border-l-signal-info",
};
const PANEL_ROW_ATTENTION =
  "border-l-signal-critical bg-[color-mix(in_srgb,var(--signal-critical)_5%,var(--bg-canvas))]";
const PANEL_ROW_H3 = "mt-[3px] mb-0 overflow-hidden text-ellipsis whitespace-nowrap [font:600_13px/1.25_var(--font-sans)]";
const PANEL_ROW_P = "mt-[3px] mb-0 overflow-hidden text-ellipsis whitespace-nowrap text-foreground-secondary text-[11px]";
const PANEL_META =
  "flex items-center justify-between gap-[8px] min-w-0 text-muted-foreground text-[10px] tracking-[.08em] uppercase";
const PANEL_FACTS =
  "flex flex-wrap items-center gap-x-[9px] gap-y-[5px] mt-[7px] text-foreground-secondary [font:400_10px/1.35_var(--font-sans)]";
const PANEL_READONLY = "block mt-[9px] text-muted-foreground text-[10px]";
const PANEL_ATTENTION_TEXT = "mt-[3px] mb-0 text-signal-critical [font:400_11px/1.35_var(--font-sans)] whitespace-normal";
const PANEL_EMPTY = "m-0 text-muted-foreground text-[12px]";
// `.qc-calendar-unscheduled__action` + its coarse-block padding/44px floor. `buttonClasses("text")`
// already carries `max-[721px]:min-h-[44px]` and `px-0`.
const PANEL_ACTION =
  "mt-[9px] p-0 text-[11px] " +
  "pointer-coarse:min-w-[44px] pointer-coarse:min-h-[44px] pointer-coarse:px-[4px] pointer-coarse:py-[8px] " +
  "max-[721px]:min-w-[44px] max-[721px]:px-[4px] max-[721px]:py-[8px]";

const CAL_PILL = "max-w-full px-[6px] py-[2px] [font:600_9px/1.2_var(--font-sans)] tracking-[.05em] uppercase";

const TONE: Record<"delivered", StatusTone> = {
  delivered: "positive",
};

function Pill({ children, tone }: { children: string; tone: "delivered" }) {
  return <StatusPill tone={TONE[tone]} className={CAL_PILL}>{children}</StatusPill>;
}

function CountLine({ facet }: { facet: UnscheduledFacet }) {
  return <div className={PANEL_COUNT}>
    <span>Showing {facet.returned} of {facet.matched}</span>
    {facet.truncated && <span className="text-signal-caution-text">{facet.matched - facet.returned} more — refine filters or search</span>}
  </div>;
}

function ProjectContent({ entry, projectHrefFor, onOpenProject }: {
  entry: ProjectCalendarUnscheduledEntryDto;
  projectHrefFor?: (projectId: string) => string | undefined;
  onOpenProject?: (projectId: string) => void;
}) {
  const href = projectHrefFor?.(entry.project.id);
  return <>
    <div className={PANEL_META}><span>Deadline</span><span>Unscheduled</span></div>
    <h3 className={PANEL_ROW_H3} title={entry.project.street}>{href ? <ProjectCalendarAnchor href={href} onOpenProject={() => onOpenProject?.(entry.project.id)}>{entry.project.street}</ProjectCalendarAnchor> : entry.project.street}</h3>
    <p className={PANEL_ROW_P} title={entry.title}>{entry.title}</p>
    <div className={PANEL_FACTS}>
      <span>Stage: {stageLabel(entry.project.stageKey)}</span>
      {entry.project.delivered && <Pill tone="delivered">Delivered</Pill>}
    </div>
  </>;
}

function ChecklistContent({ entry, projectHrefFor, onOpenProject }: {
  entry: ChecklistCalendarUnscheduledEntryDto;
  projectHrefFor?: (projectId: string) => string | undefined;
  onOpenProject?: (projectId: string) => void;
}) {
  const href = projectHrefFor?.(entry.project.id);
  return <>
    <div className={PANEL_META}><span>Checklist</span><span>{entry.reason === "schedule_needs_attention" ? "Needs attention" : "Unscheduled"}</span></div>
    <h3 className={PANEL_ROW_H3} title={entry.title}>{entry.title}</h3>
    <p className={PANEL_ROW_P} title={entry.project.street}>{href ? <ProjectCalendarAnchor href={href} onOpenProject={() => onOpenProject?.(entry.project.id)}>{entry.project.street}</ProjectCalendarAnchor> : entry.project.street}</p>
    <div className={PANEL_FACTS}>
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

function ProjectRow({ entry, subview, onSchedule, disabled, dragSuppressed, projectHrefFor, onOpenProject }: {
  entry: ProjectCalendarUnscheduledEntryDto;
  subview: ProductionCalendarSubview;
  onSchedule: (entry: ProjectCalendarUnscheduledEntryDto) => void;
  disabled: boolean;
  dragSuppressed: boolean;
  projectHrefFor?: (projectId: string) => string | undefined;
  onOpenProject?: (projectId: string) => void;
}) {
  // Eligibility is a permanent property of the entry (not delivered, has the
  // capability). Transient `disabled` (interaction blocked / settling) only
  // disables the action button — it must never demote an eligible entry to the
  // "Deadline is read-only" row, which is reserved for genuine ineligibility.
  const eligible = unscheduledProjectDraggable(entry);
  const actionMode = subview === "agenda" || dragSuppressed || disabled;
  const content = <ProjectContent entry={entry} projectHrefFor={eligible ? projectHrefFor : undefined} onOpenProject={onOpenProject} />;

  if (!eligible) {
    return <button type="button" className={cn(PANEL_ROW, PANEL_ROW_KIND.project, "cursor-default")} disabled aria-label={`${entry.project.street}: Deadline is read-only`} data-unscheduled-id={entry.id} data-testid="calendar-unscheduled-readonly-row">
      {content}
      <span className={PANEL_READONLY}>Deadline is read-only</span>
    </button>;
  }

  if (actionMode) {
    return <article className={cn(PANEL_ROW, PANEL_ROW_KIND.project)} data-unscheduled-id={entry.id}>
      {content}
      <button className={buttonClasses("text", { className: PANEL_ACTION })} type="button" disabled={disabled} onClick={() => onSchedule(entry)} data-testid="calendar-unscheduled-action">Schedule Deadline</button>
    </article>;
  }

  // FullCalendar's Draggable (registered on the panel) drives the external drag
  // via the data-event attribute — no HTML5 `draggable` attribute (that adds a
  // second native drag ghost and fights FC's pointer dragging).
  return <article
    className={cn(PANEL_ROW, PANEL_ROW_KIND.project, "cursor-grab active:cursor-grabbing")}
    data-unscheduled-id={entry.id}
    data-unscheduled-kind="project"
    data-event={externalEventData(entry.title, entry.id, "project")}
  >{content}</article>;
}

function ChecklistRow({ entry, subview, rangesEnabled, onSchedule, disabled, dragSuppressed, projectHrefFor, onOpenProject }: {
  entry: ChecklistCalendarUnscheduledEntryDto;
  subview: ProductionCalendarSubview;
  rangesEnabled: boolean;
  onSchedule: (entry: ChecklistCalendarUnscheduledEntryDto) => void;
  disabled: boolean;
  dragSuppressed: boolean;
  projectHrefFor?: (projectId: string) => string | undefined;
  onOpenProject?: (projectId: string) => void;
}) {
  const attention = entry.reason === "schedule_needs_attention";
  const legacy = attention && entry.attentionReason === "legacy_unresolved";
  const invalid = attention && entry.attentionReason === "invalid";
  const actionMode = subview === "agenda" || dragSuppressed;
  const canDrag = !actionMode && checklistCanDrag(entry, rangesEnabled, disabled);
  const showAction = entry.permissions.canOpenScheduleEditor && (actionMode || !canDrag);
  const content = <ChecklistContent entry={entry} projectHrefFor={projectHrefFor} onOpenProject={onOpenProject} />;

  if (canDrag) {
    return <article
      className={cn(PANEL_ROW, PANEL_ROW_KIND.checklist, "cursor-grab active:cursor-grabbing")}
      data-unscheduled-id={entry.id}
      data-unscheduled-kind="checklist"
      data-event={externalEventData(entry.title, entry.id, "checklist")}
    >
      {content}
    </article>;
  }

  return <article className={cn(PANEL_ROW, PANEL_ROW_KIND.checklist, attention && PANEL_ROW_ATTENTION)} data-unscheduled-id={entry.id} data-attention={attention ? "true" : undefined}>
    {content}
    {invalid ? <p className={PANEL_ATTENTION_TEXT} role="status">This checklist schedule needs repair. Repair is unavailable in Calendar.</p> : showAction && <button className={buttonClasses("text", { className: PANEL_ACTION })} type="button" disabled={disabled} onClick={() => onSchedule(entry)} data-testid="calendar-unscheduled-action">{legacy ? "Repair schedule" : "Schedule"}</button>}
  </article>;
}

function Section<T>({ label, facet, entries, children }: { label: string; facet: UnscheduledFacet; entries: T[]; children: ReactNode }) {
  return <section className={PANEL_SECTION} aria-label={label}>
    <header className={PANEL_SECTION_HEAD}><h2 className={PANEL_SECTION_H2}>{label}</h2><CountLine facet={facet} /></header>
    {entries.length === 0 ? <p className={PANEL_EMPTY} data-testid="calendar-unscheduled-empty">Nothing unscheduled</p> : <div className={PANEL_ROWS}>{children}</div>}
  </section>;
}

export function ProductionCalendarUnscheduledPanel({ projectEntries, checklistEntries, facets, subview, rangesEnabled, onScheduleProject, onScheduleChecklist, disabled = false, dragSuppressed = false, projectHrefFor, onOpenProject }: ProductionCalendarUnscheduledPanelProps) {
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

  return <aside ref={panelRef} className={cn(PANEL, disabled && "opacity-[.62]")} aria-label="Unscheduled work">
    <Section label="Unscheduled projects" facet={facets.project} entries={projectEntries}>
      {projectEntries.map((entry) => <ProjectRow key={entry.id} entry={entry} subview={subview} onSchedule={onScheduleProject} disabled={disabled} dragSuppressed={dragSuppressed} projectHrefFor={projectHrefFor} onOpenProject={onOpenProject} />)}
    </Section>
    <Section label="Unscheduled checklist items" facet={facets.checklist} entries={checklistEntries}>
      {checklistEntries.map((entry) => <ChecklistRow key={entry.id} entry={entry} subview={subview} rangesEnabled={rangesEnabled} onSchedule={onScheduleChecklist} disabled={disabled} dragSuppressed={dragSuppressed} projectHrefFor={projectHrefFor} onOpenProject={onOpenProject} />)}
    </Section>
  </aside>;
}
