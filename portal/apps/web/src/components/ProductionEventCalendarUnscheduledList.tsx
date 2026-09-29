/**
 * #222 — the event-calendar rail's unscheduled work: projects without a Deadline and checklist
 * items without a schedule (or needing repair). Presentational; never imports
 * `components/reui/event-calendar/`.
 *
 * Drag source: a permitted row calls `beginDrag(pointerEvent, entry)` on a primary pointer press.
 * The surface supplies it from the vendored `useEventCalendarExternalDrop`, whose hook must be
 * called INSIDE `<EventCalendar>` — which is why this component takes the callback rather than
 * calling the hook. No `beginDrag` (not wired, or the rail is in the narrow sheet), Agenda, a phone
 * gate (`dragSuppressed`) or a blocked calendar (`disabled`) all put the list in action mode:
 * Schedule buttons, no drag affordance. Same eligibility rules as the retired FullCalendar panel
 * (`lib/production-calendar-unscheduled.ts`).
 *
 * Reuse: rows are `reui/item` (`ItemGroup` > `Item variant="outline" size="xs"` > `ItemContent`
 * `ItemTitle`/`ItemDescription` + `ItemActions`, the c-item status-list composition the Deadline
 * confirm already uses); actions `reui/button` `variant="link"`; the project link
 * `ProjectCalendarAnchor` (InternalLink under the hood). The rail supplies the `reui/scroll-area`.
 * Section headings are `<h3>` around the installed `quincy/Eyebrow`; row rule colours match the
 * retired FullCalendar panel's.
 */
import type { JSX, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type {
  CalendarUnscheduledEntryDto,
  ChecklistCalendarUnscheduledEntryDto,
  ProductionCalendarSubview,
  ProjectCalendarUnscheduledEntryDto,
} from "@quincy/shared";
import { cn } from "@/lib/utils";
import { unscheduledChecklistDraggable, unscheduledProjectDraggable, unscheduledStageLabel } from "../lib/production-calendar-unscheduled";
import { ProjectCalendarAnchor } from "./ProjectCalendarAnchor";
import { Eyebrow } from "./quincy/Eyebrow";
import { Button } from "./reui/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "./reui/item";

type UnscheduledFacet = { matched: number; returned: number; truncated: boolean };

export type ProductionEventCalendarBeginDrag = (event: ReactPointerEvent<HTMLElement>, entry: CalendarUnscheduledEntryDto) => void;

export type ProductionEventCalendarUnscheduledListProps = {
  projectEntries: ProjectCalendarUnscheduledEntryDto[];
  checklistEntries: ChecklistCalendarUnscheduledEntryDto[];
  facets: { project: UnscheduledFacet; checklist: UnscheduledFacet };
  subview: ProductionCalendarSubview;
  onScheduleProject: (entry: ProjectCalendarUnscheduledEntryDto) => void;
  onScheduleChecklist: (entry: ChecklistCalendarUnscheduledEntryDto) => void;
  beginDrag?: ProductionEventCalendarBeginDrag;
  disabled?: boolean;
  dragSuppressed?: boolean;
  projectHrefFor?: (projectId: string) => string | undefined;
  onOpenProject?: (projectId: string) => void;
};

const SECTION = "grid gap-[var(--space-2)] min-w-0";
const SECTION_HEAD = "grid gap-[var(--space-1)]";
const SECTION_HEADING = "m-0";
const COUNT = "flex flex-wrap gap-x-[var(--space-2)] text-muted-foreground text-[length:var(--text-2xs)]";
const ROW = "min-w-0 rounded-[var(--radius-card)] border-l-[length:var(--border-width-rule)] bg-background";
const ROW_DRAG = "cursor-grab active:cursor-grabbing touch-none select-none";
// Rule colour by kind and the needs-attention override (colour only: ROW carries the width).
const UNSCHEDULED_ROW_KIND: Record<"project" | "checklist", string> = {
  project: "border-l-signal-positive",
  checklist: "border-l-signal-info",
};
const UNSCHEDULED_ROW_ATTENTION =
  "border-l-signal-critical bg-[color-mix(in_srgb,var(--signal-critical)_5%,var(--bg-canvas))]";
const META = "text-foreground-secondary text-[length:var(--text-2xs)]";
const ATTENTION_TEXT = "m-0 text-signal-critical text-[length:var(--text-2xs)]";
const ACTION = "h-auto px-0 max-[721px]:min-h-[44px]";
const ACTION_LINE = "basis-full";

function CountLine({ facet }: { facet: UnscheduledFacet }) {
  return (
    <div className={COUNT}>
      <span>Showing {facet.returned} of {facet.matched}</span>
      {facet.truncated && <span className="text-signal-caution-text">{facet.matched - facet.returned} more — refine filters or search</span>}
    </div>
  );
}

function projectLink(entry: { project: { id: string; street: string } }, projectHrefFor?: (projectId: string) => string | undefined, onOpenProject?: (projectId: string) => void): ReactNode {
  const href = projectHrefFor?.(entry.project.id);
  return href ? <ProjectCalendarAnchor href={href} onOpenProject={() => onOpenProject?.(entry.project.id)}>{entry.project.street}</ProjectCalendarAnchor> : entry.project.street;
}

function dragHandlers(canDrag: boolean, entry: CalendarUnscheduledEntryDto, beginDrag?: ProductionEventCalendarBeginDrag) {
  if (!canDrag || !beginDrag) return {};
  return {
    "data-drag-source": "true",
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      // A press on the project link is navigation, not a drag.
      if ((event.target as HTMLElement).closest("a")) return;
      beginDrag(event, entry);
    },
  };
}

function ProjectRow({ entry, actionMode, disabled, beginDrag, onSchedule, projectHrefFor, onOpenProject }: {
  entry: ProjectCalendarUnscheduledEntryDto;
  actionMode: boolean;
  disabled: boolean;
  beginDrag?: ProductionEventCalendarBeginDrag;
  onSchedule: (entry: ProjectCalendarUnscheduledEntryDto) => void;
  projectHrefFor?: (projectId: string) => string | undefined;
  onOpenProject?: (projectId: string) => void;
}) {
  // Eligibility is permanent (not delivered, has the capability); `disabled` is transient and only
  // disables the action — it never demotes an eligible entry to the read-only row.
  const eligible = unscheduledProjectDraggable(entry);
  const canDrag = eligible && !actionMode;
  return (
    <Item
      role="listitem"
      variant="outline"
      size="xs"
      className={cn(ROW, UNSCHEDULED_ROW_KIND.project, canDrag && ROW_DRAG)}
      data-unscheduled-id={entry.id}
      data-unscheduled-kind="project"
      aria-disabled={!eligible || undefined}
      {...dragHandlers(canDrag, entry, beginDrag)}
    >
      <ItemContent>
        <ItemDescription className={META}>Deadline · Unscheduled</ItemDescription>
        <ItemTitle className="[overflow-wrap:anywhere]">{eligible ? projectLink(entry, projectHrefFor, onOpenProject) : entry.project.street}</ItemTitle>
        <ItemDescription className={META}>Stage: {unscheduledStageLabel(entry.project.stageKey)}{entry.project.delivered ? " · Delivered" : ""}</ItemDescription>
        {!eligible && <ItemDescription className={META}>Deadline is read-only</ItemDescription>}
      </ItemContent>
      {eligible && !canDrag && (
        // Own full-width line under the meta lines: inline, the action took ~40% of the row and
        // wrapped the title to three lines.
        <ItemActions className={ACTION_LINE}>
          <Button type="button" variant="link" size="sm" className={ACTION} disabled={disabled} data-testid="event-calendar-unscheduled-action" onClick={() => onSchedule(entry)}>Schedule Deadline</Button>
        </ItemActions>
      )}
    </Item>
  );
}

function ChecklistRow({ entry, actionMode, disabled, beginDrag, onSchedule, projectHrefFor, onOpenProject }: {
  entry: ChecklistCalendarUnscheduledEntryDto;
  actionMode: boolean;
  disabled: boolean;
  beginDrag?: ProductionEventCalendarBeginDrag;
  onSchedule: (entry: ChecklistCalendarUnscheduledEntryDto) => void;
  projectHrefFor?: (projectId: string) => string | undefined;
  onOpenProject?: (projectId: string) => void;
}) {
  const attention = entry.reason === "schedule_needs_attention";
  const legacy = attention && entry.attentionReason === "legacy_unresolved";
  const invalid = attention && entry.attentionReason === "invalid";
  const canDrag = !actionMode && unscheduledChecklistDraggable(entry);
  const showAction = entry.permissions.canOpenScheduleEditor && !canDrag;
  return (
    <Item
      role="listitem"
      variant="outline"
      size="xs"
      className={cn(ROW, UNSCHEDULED_ROW_KIND.checklist, attention && UNSCHEDULED_ROW_ATTENTION, canDrag && ROW_DRAG)}
      data-unscheduled-id={entry.id}
      data-unscheduled-kind="checklist"
      data-attention={attention ? "true" : undefined}
      {...dragHandlers(canDrag, entry, beginDrag)}
    >
      <ItemContent>
        {/* No per-row "Checklist · Unscheduled": the section heading already says it. Only a row
            that needs attention carries an eyebrow. */}
        {attention && <ItemDescription className={META}>Needs attention</ItemDescription>}
        <ItemTitle className="[overflow-wrap:anywhere]">{entry.title}</ItemTitle>
        <ItemDescription className={META}>{projectLink(entry, projectHrefFor, onOpenProject)}</ItemDescription>
        <ItemDescription className={META}>Assignee: {entry.assignee?.name ?? "Unassigned"} · Stage: {unscheduledStageLabel(entry.project.stageKey)}</ItemDescription>
        {invalid && <p className={ATTENTION_TEXT} role="status">This checklist schedule needs repair. Repair is unavailable in Calendar.</p>}
      </ItemContent>
      {!invalid && showAction && (
        <ItemActions className={ACTION_LINE}>
          <Button type="button" variant="link" size="sm" className={ACTION} disabled={disabled} data-testid="event-calendar-unscheduled-action" onClick={() => onSchedule(entry)}>{legacy ? "Repair schedule" : "Schedule"}</Button>
        </ItemActions>
      )}
    </Item>
  );
}

function Section({ label, facet, empty, children }: { label: string; facet: UnscheduledFacet; empty: boolean; children: ReactNode }) {
  return (
    <section className={SECTION} aria-label={label}>
      <header className={SECTION_HEAD}>
        <h3 className={SECTION_HEADING}><Eyebrow>{label}</Eyebrow></h3>
        <CountLine facet={facet} />
      </header>
      {empty
        ? <p className="m-0 text-muted-foreground text-[length:var(--text-xs)]" data-testid="event-calendar-unscheduled-empty">Nothing unscheduled</p>
        : <ItemGroup role="list" className="gap-[var(--space-1)]">{children}</ItemGroup>}
    </section>
  );
}

export function ProductionEventCalendarUnscheduledList({ projectEntries, checklistEntries, facets, subview, onScheduleProject, onScheduleChecklist, beginDrag, disabled = false, dragSuppressed = false, projectHrefFor, onOpenProject }: ProductionEventCalendarUnscheduledListProps): JSX.Element {
  const actionMode = !beginDrag || disabled || dragSuppressed || subview === "agenda";
  return (
    <div className={cn("grid gap-[var(--space-4)] min-w-0", disabled && "opacity-[.62]")} aria-label="Unscheduled work" role="group" aria-disabled={disabled || undefined}>
      <Section label="Unscheduled projects" facet={facets.project} empty={projectEntries.length === 0}>
        {projectEntries.map((entry) => <ProjectRow key={entry.id} entry={entry} actionMode={actionMode} disabled={disabled} beginDrag={beginDrag} onSchedule={onScheduleProject} projectHrefFor={projectHrefFor} onOpenProject={onOpenProject} />)}
      </Section>
      <Section label="Unscheduled checklist items" facet={facets.checklist} empty={checklistEntries.length === 0}>
        {checklistEntries.map((entry) => <ChecklistRow key={entry.id} entry={entry} actionMode={actionMode} disabled={disabled} beginDrag={beginDrag} onSchedule={onScheduleChecklist} projectHrefFor={projectHrefFor} onOpenProject={onOpenProject} />)}
      </Section>
    </div>
  );
}
