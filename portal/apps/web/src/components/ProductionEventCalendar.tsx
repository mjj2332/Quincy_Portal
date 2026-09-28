/**
 * #222 — the Production Calendar on the vendored ReUI event calendar, the Dashboard's default
 * Calendar renderer since #223. A browser can opt back to the FullCalendar renderer
 * (`ProductionCalendar.tsx`) via `DASHBOARD_CALENDAR_RENDERER_KEY` (`screens/dashboard-helpers.ts`)
 * until #224 deletes it.
 *
 * The ONLY app file that imports `components/reui/event-calendar/` — pinned by
 * `harness-reachability.guard.test.ts` (`ALLOWED_VENDOR_SCHEDULING_CONSUMERS`, an exact-file entry
 * scoped to that one tree) and `ProductionEventCalendar.import-boundary.guard.test.ts`. The rail,
 * facets, unscheduled list and dialogs are presentational siblings that never import the tree.
 *
 * Writes (round 3): the shared scheduling controller (`useSchedulingController`,
 * `lib/use-scheduling-commands.tsx`) owns every write, exactly as `ProductionGantt.tsx` composes it —
 * over the Calendar's own port (`useCalendarSchedulingPort`) plus this surface's `confirmDeadline`
 * (the `ProductionGanttDeadlineDialog`, `preview: null`) and `boundsFor` (`calendarScheduleBounds`
 * of the `bounds=1` response's `projectBounds`; the controller runs the same out-of-range rule as the
 * Gantt, `schedule-bounds.ts` — out-of-range checklist writes WARN, never block).
 * No DST / settle / reconcile / lock rule is copied here. #291: the controller is composed through
 * `useSchedulingControllerWithUndoToast` (`lib/use-scheduling-undo-toast.ts`), the Gantt's wrapper —
 * each saved checklist schedule or Deadline raises one live Undo toast.
 *
 * - `onEventUpdate`: `eventCalendarUpdateToProposal` → `commands.submitProposal(proposal,
 *   { revertable })` → `"deferred"`: the vendor neither mutates nor announces; the controller owns
 *   what happens next. An invalid or no-op proposal returns `false` and the vendor snaps the chip
 *   back. A local `pending` range holds the dropped chip where it landed until the controller's
 *   overlay replaces it or the command settles / cancels (a Deadline has no overlay before its
 *   confirmation, so `pending` is what holds it; Cancel's revert restores the original position).
 * - Unscheduled rows are external drag sources (`useEventCalendarExternalDrop`, called inside the
 *   provider) → a `place` proposal. `canDrop` refuses only while blocked / settling or without
 *   permission — never on bounds.
 * - "Reschedule…": the vendor chip is itself a `<button>`, so the action cannot live inside it. A
 *   chip click (`onEventClick`) selects the event; the selection strip under the nav carries the
 *   `data-focus-key="calendar-move:<id>"` action that opens the move dialog (Deadline) or the
 *   schedule editor sheet (checklist).
 *
 * The grid draws from the controller's ACCEPTED response (falling back to the live query only while
 * no interaction holds the gate), and once anything has loaded it stays mounted across a new range
 * key — `loading` on the vendor, no events — instead of unmounting to the skeleton on every
 * prev / next / view / filter change. The skeleton is first-load only.
 *
 * Never passed to `<EventCalendar>`: `onEventsChange` (the vendor would commit a range the server may
 * refuse), `canDropEvent` / `enforceCanDrop` (production warns, never blocks).
 *
 * Layout: rail beside the grid; below `RAIL_SHEET_QUERY` (a JS media query — no shell breakpoint
 * literal, no `lg:`) the rail moves into a `reui/sheet` opened from a button beside the nav. The rail
 * renders INSIDE `<EventCalendar>` in both places (the sheet portals the DOM, not the React tree), so
 * the external-drop hook has its provider.
 *
 * Phone gate: a coarse pointer at ≤720px turns drag and resize (and so keyboard Adjust) off in
 * week / day / days, and the unscheduled rows fall back to their Schedule actions.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from "react";
import {
  CHECKLIST_SCHEDULE_RANGES_ENABLED,
  deriveProductionCalendarWindow,
  formatSydneyCivilMinute,
  type CalendarEventDto,
  type CalendarUnscheduledEntryDto,
  type ChecklistCalendarUnscheduledEntryDto,
  type DashboardCalendarState,
  type ProductionCalendarFilters,
  type ProductionCalendarRangeResponse,
  type ProjectCalendarUnscheduledEntryDto,
} from "@quincy/shared";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import { applyOptimisticOverlay, type CalendarSettleState } from "../lib/production-calendar-interaction";
import { effectiveCalendarEventPermissions } from "../lib/production-calendar-permissions";
import { productionCalendarFiltersFor, useProductionCalendarRange } from "../lib/production-calendar-query";
import { unscheduledChecklistDraggable, unscheduledProjectDraggable } from "../lib/production-calendar-unscheduled";
import {
  calendarViewToSubview,
  PRODUCTION_EVENT_CALENDAR_VIEW_SETTINGS,
  productionEventCalendarAnchor,
  productionEventCalendarEventClassName,
  subviewToCalendarView,
  toProductionEventCalendarEvents,
  type ProductionEventCalendarData,
} from "../lib/production-event-calendar-adapter";
import { eventCalendarDropToProposal, eventCalendarUpdateToProposal, type EventCalendarDropTargetLike, type EventCalendarUpdateLike } from "../lib/production-event-calendar-scheduling";
import { calendarScheduleBounds, type ScheduleBounds } from "../lib/schedule-bounds";
import { useCalendarSchedulingPort, type SchedulingDeadlineConfirmInput } from "../lib/use-scheduling-commands";
import { useSchedulingControllerWithUndoToast } from "../lib/use-scheduling-undo-toast";
import { useMediaQuery } from "../lib/use-media-query";
import { productionCalendarZoneLabel } from "../lib/sydney-time-labels";
import { cn } from "@/lib/utils";
import { EventCalendar } from "./reui/event-calendar/event-calendar";
import { EventCalendarNav } from "./reui/event-calendar/event-calendar-nav";
import { EventCalendarContent } from "./reui/event-calendar/event-calendar-content";
import { useEventCalendarExternalDrop } from "./reui/event-calendar/event-calendar-dnd";
import { Button } from "./reui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./reui/sheet";
import { Skeleton } from "./reui/skeleton";
import { EmptyState } from "./quincy/EmptyState";
import { Eyebrow } from "./quincy/Eyebrow";
import { InitialsAvatar } from "./quincy/InitialsAvatar";
import { Notice } from "./quincy/Notice";
import { ProjectCalendarAnchor } from "./ProductionCalendarEvent";
import { checklistScheduleEditorButtonLabel } from "./ProductionCalendarScheduleEditor";
import { ProductionEventCalendarDialogs, type ProductionEventCalendarDeadlineConfirm } from "./ProductionEventCalendarDialogs";
import { ProductionEventCalendarFacets } from "./ProductionEventCalendarFacets";
import { ProductionEventCalendarRail, type ProductionEventCalendarUpNext } from "./ProductionEventCalendarRail";
import { ProductionEventCalendarUnscheduledList, type ProductionEventCalendarUnscheduledListProps } from "./ProductionEventCalendarUnscheduledList";

export type ProductionEventCalendarProps = {
  identity: DashboardIdentity;
  calendar: DashboardCalendarState;
  onNavigate: (next: DashboardCalendarState) => void;
  onAppliedFilters?: (filters: ProductionCalendarFilters) => void;
  onAcceptGateChange?: (blocked: boolean) => void;
  onSettleStateChange?: (state: CalendarSettleState) => void;
  onAccessLoss?: () => void;
  projectHrefFor?: (projectId: string) => string | undefined;
  onOpenProject?: (projectId: string) => void;
};

/** Below this width the rail leaves the grid's side and moves into a sheet. */
const RAIL_SHEET_QUERY = "(max-width: 1100px)";
const PHONE_QUERY = "(max-width: 720px)";
const COARSE_QUERY = "(pointer: coarse)";
const CALENDAR_VIEWS = ["month", "week", "day", "days", "agenda"] as const;
const TIME_GRID_SUBVIEWS = new Set(["week", "day", "days"]);
const EMPTY_FACETS = { project: { matched: 0, returned: 0, truncated: false }, checklist: { matched: 0, returned: 0, truncated: false } };
/** An unscheduled item dropped on a minute column lands as a one-hour block. */
const EXTERNAL_DROP_MINUTES = 60;
const NEEDS_ATTENTION = "Schedule data needs attention. Repair is unavailable in Calendar.";
const OVERLAP = "Overlaps another task";

type PendingRange = { eventId: string; start: Date; end: Date; allDay: boolean };

function errorDetail(error: unknown, key: "code" | "refinement"): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const details = "details" in error ? (error as { details?: unknown }).details : undefined;
  if (!details || typeof details !== "object") return undefined;
  const value = key in details ? (details as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? value : undefined;
}

function sameFilters(left: ProductionCalendarFilters, right: ProductionCalendarFilters): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sydneyCivilDate(instant: Date): string {
  return formatSydneyCivilMinute(instant.getTime()).slice(0, 10);
}

function eventCivilDate(event: CalendarEventDto): string {
  return event.timing.allDay ? event.timing.start.slice(0, 10) : formatSydneyCivilMinute(event.timing.start).slice(0, 10);
}

/** The old calendar's reset key: any route or filter change starts a fresh controller generation. */
function calendarResetKey(calendar: DashboardCalendarState): string {
  return `${calendar.date}|${calendar.subview}|${calendar.layers.join(",")}|${calendar.editorIds.join(",")}|${calendar.includeUnassigned}|${calendar.stageKeys.join(",")}|${calendar.showCompletedChecklist}|${calendar.showDeliveredProjects}|${calendar.overdueOnly}|${calendar.search}|${calendar.myTasks}`;
}

function canDragUnscheduledEntry(entry: CalendarUnscheduledEntryDto, rangesEnabled: boolean): boolean {
  return entry.kind === "project_deadline" ? unscheduledProjectDraggable(entry) : unscheduledChecklistDraggable(entry, rangesEnabled);
}

function ChipContent({ id, data, title, needsAttention }: { id: string; data: ProductionEventCalendarData | undefined; title: string; needsAttention: boolean }): JSX.Element {
  const dto = data?.dto;
  const label = dto?.kind === "project_deadline" ? dto.project.street : title;
  const assignee = dto?.kind === "checklist" ? dto.assignee : null;
  const overlap = dto?.kind === "checklist" && dto.status.sameAssigneeOverlap === true;
  return (
    // `data-event-id` is the controller's focus-return hook (it focuses the vendor chip button around it).
    <span className="flex w-full min-w-0 items-center gap-[var(--space-1)]" data-testid="event-calendar-chip" data-event-id={id}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {overlap && <span className="sr-only">{OVERLAP}</span>}
      {needsAttention && <span className="sr-only">{NEEDS_ATTENTION}</span>}
      {assignee && <InitialsAvatar name={assignee.name} className="size-4 shrink-0 [&_[data-slot=avatar-fallback]]:text-[length:var(--text-2xs)]" />}
    </span>
  );
}

/**
 * The unscheduled list as an external drag source. Its own component so the vendor hook is called
 * INSIDE `<EventCalendar>` (the hook reads the calendar's context).
 */
function UnscheduledDragSource({ dragEnabled, canDrop, onDrop, ...list }: Omit<ProductionEventCalendarUnscheduledListProps, "beginDrag"> & {
  dragEnabled: boolean;
  canDrop: (entry: CalendarUnscheduledEntryDto) => boolean;
  onDrop: (entry: CalendarUnscheduledEntryDto, target: EventCalendarDropTargetLike) => void;
}): JSX.Element {
  const { begin } = useEventCalendarExternalDrop<ProductionEventCalendarData, CalendarUnscheduledEntryDto>();
  // A drag outlives the render that started it: read the CURRENT gate at every hover and at drop,
  // never the one captured at pointer-down (a command started mid-drag must refuse the drop).
  const latest = useRef({ canDrop, onDrop });
  latest.current = { canDrop, onDrop };
  const beginDrag = useCallback((event: ReactPointerEvent<HTMLElement>, entry: CalendarUnscheduledEntryDto) => {
    begin(event, {
      payload: entry,
      durationMinutes: EXTERNAL_DROP_MINUTES,
      preferAllDay: true,
      canDrop: (_target, payload) => latest.current.canDrop(payload),
      onDrop: (target, payload) => latest.current.onDrop(payload, target),
    });
  }, [begin]);
  return <ProductionEventCalendarUnscheduledList {...list} beginDrag={dragEnabled ? beginDrag : undefined} />;
}

export function ProductionEventCalendar({ identity, calendar, onNavigate, onAppliedFilters, onAcceptGateChange, onSettleStateChange, onAccessLoss, projectHrefFor, onOpenProject }: ProductionEventCalendarProps): JSX.Element {
  const query = useProductionCalendarRange({ identity, calendar, enabled: true, bounds: true });

  // Up next: a second, read-only agenda range from today (Sydney), same filters, outside any gate.
  const [nowCivil] = useState(() => formatSydneyCivilMinute(Date.now()));
  const upNextCalendar = useMemo<DashboardCalendarState>(() => ({ ...calendar, subview: "agenda", date: nowCivil.slice(0, 10) }), [calendar, nowCivil]);
  const upNextQuery = useProductionCalendarRange({ identity, calendar: upNextCalendar, enabled: true });
  const upNext = useMemo<ProductionEventCalendarUpNext>(() => {
    if (upNextQuery.data) return { status: "ready", events: upNextQuery.data.events };
    return { status: upNextQuery.error ? "error" : "pending", events: [] };
  }, [upNextQuery.data, upNextQuery.error]);

  const narrow = useMediaQuery(RAIL_SHEET_QUERY);
  const phoneViewport = useMediaQuery(PHONE_QUERY);
  const coarsePointer = useMediaQuery(COARSE_QUERY);
  const phone = phoneViewport && coarsePointer;
  const [railOpen, setRailOpen] = useState(false);
  useEffect(() => { if (!narrow) setRailOpen(false); }, [narrow]);

  // ---------------------------------------------------------------------------------------------
  // The scheduling controller, composed as `ProductionGantt.tsx` does.
  // ---------------------------------------------------------------------------------------------

  // Project bounds by id from the latest bounds=1 response; refreshed every render below, read by
  // the port's `boundsFor` at call time.
  const boundsRef = useRef<Map<string, ScheduleBounds>>(new Map());

  // The Deadline confirmation the controller is awaiting (`SchedulingPort.confirmDeadline`).
  // `resolve` settles the controller's promise exactly once, and closes the dialog.
  const [deadlineConfirm, setDeadlineConfirm] = useState<ProductionEventCalendarDeadlineConfirm | null>(null);
  const openDeadlineConfirm = useCallback((input: SchedulingDeadlineConfirmInput) => new Promise<boolean>((resolve) => {
    if (input.signal.aborted) {
      resolve(false);
      return;
    }
    const { proposal } = input;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", onAbort);
      setDeadlineConfirm(null);
      resolve(ok);
    };
    // Unmount, reset or access loss: the controller withdraws the confirmation through `signal`.
    const onAbort = () => finish(false);
    input.signal.addEventListener("abort", onAbort, { once: true });
    setDeadlineConfirm({
      state: { street: proposal.street, oldCivil: proposal.oldCivil, newCivil: proposal.newCivil, scheduling: proposal.scheduling, consequences: input.consequences, preview: null },
      resolve: finish,
    });
  }), []);

  const calendarPort = useCalendarSchedulingPort(calendar, query, identity.principalId);
  const port = {
    ...calendarPort,
    confirmDeadline: openDeadlineConfirm,
    boundsFor: (projectId: string) => boundsRef.current.get(projectId) ?? null,
  };
  const commands = useSchedulingControllerWithUndoToast<ProductionCalendarRangeResponse>({ identity, resetKey: calendarResetKey(calendar), port, onAcceptGateChange, onSettleStateChange, onAccessLoss });
  const blocked = commands.interactionBlocked;
  const settling = commands.settle.pending;
  const live = !blocked && !settling && !commands.accessLost;

  // Draw from the accepted baseline; the live query only while nothing holds the gate.
  const source: ProductionCalendarRangeResponse | null = commands.acceptedResponse ?? (!blocked ? query.data ?? null : null);
  boundsRef.current = useMemo(() => new Map((source?.projectBounds ?? query.data?.projectBounds ?? []).map((bound) => [bound.projectId, calendarScheduleBounds(bound)])), [source?.projectBounds, query.data?.projectBounds]);

  // First-load skeleton only: once a range has drawn, a new range key keeps the grid mounted.
  const [everLoaded, setEverLoaded] = useState(false);
  useEffect(() => { if (source && !everLoaded) setEverLoaded(true); }, [source, everLoaded]);

  useEffect(() => {
    const applied = query.data?.range.appliedFilters;
    if (!applied || sameFilters(applied, productionCalendarFiltersFor(calendar))) return;
    onAppliedFilters?.(applied);
  }, [calendar, onAppliedFilters, query.data?.range.appliedFilters]);

  const navigate = useCallback((changes: Partial<DashboardCalendarState>) => {
    if (commands.interactionBlocked) return;
    commands.clearSettleOnNavigation();
    onNavigate({ ...calendar, ...changes, view: "calendar" });
  }, [calendar, commands, onNavigate]);

  // ---------------------------------------------------------------------------------------------
  // Events: effective permissions → optimistic overlay → local pending range → vendor events.
  // ---------------------------------------------------------------------------------------------

  const rangesEnabled = CHECKLIST_SCHEDULE_RANGES_ENABLED && !commands.checklistRangeSchedulingDisabled;
  const gated = phone && TIME_GRID_SUBVIEWS.has(calendar.subview);
  const renderEvents = useMemo<CalendarEventDto[]>(() => (source?.events ?? []).map((event) => effectiveCalendarEventPermissions(event, {
    subview: calendar.subview,
    role: identity.role,
    interactionBlocked: blocked,
    settlePending: settling,
    checklistNeedsAttention: commands.checklistNeedsAttention,
    rangesEnabled,
    deadlineMovementDisabled: commands.deadlineMovementDisabled,
  })), [source?.events, calendar.subview, identity.role, blocked, settling, commands.checklistNeedsAttention, rangesEnabled, commands.deadlineMovementDisabled]);
  const displayEvents = useMemo(() => applyOptimisticOverlay(renderEvents, commands.optimisticOverlay), [renderEvents, commands.optimisticOverlay]);
  const dtoById = useMemo(() => new Map(displayEvents.map((event) => [event.id, event])), [displayEvents]);

  const [pending, setPending] = useState<PendingRange | null>(null);
  // The chip never snaps back between release and the controller's overlay: `pending` covers that
  // gap and yields to the overlay the moment it exists.
  const effectivePending = commands.optimisticOverlay ? null : pending;
  useEffect(() => { if (commands.optimisticOverlay) setPending(null); }, [commands.optimisticOverlay]);
  useEffect(() => { if (!blocked && !settling) setPending(null); }, [blocked, settling]);
  const resetKey = calendarResetKey(calendar);
  useEffect(() => { setPending(null); }, [resetKey]);

  const events = useMemo(() => {
    const mapped = toProductionEventCalendarEvents(displayEvents);
    if (!effectivePending) return mapped;
    return mapped.map((event) => event.id === effectivePending.eventId ? { ...event, start: effectivePending.start, end: effectivePending.end, allDay: effectivePending.allDay } : event);
  }, [displayEvents, effectivePending]);

  const handleEventUpdate = useCallback((update: EventCalendarUpdateLike & { event: { id: string | number; start: Date; end: Date } }) => {
    const dto = dtoById.get(String(update.event.id));
    if (!dto || calendar.subview === "agenda" || gated) return false;
    const planned = eventCalendarUpdateToProposal(dto, update);
    // Invalid or no-op: the vendor snaps the chip back; nothing else is announced.
    if (planned.kind !== "proposal") return false;
    const allowed = planned.proposal.kind === "resize" ? dto.permissions.canResize : dto.permissions.canDrag;
    if (!allowed) return false;
    setPending({ eventId: dto.id, start: update.start, end: update.end, allDay: update.allDay });
    const outcome = commands.submitProposal(planned.proposal, { revertable: { revert: () => setPending(null) } });
    if (!outcome.ok) setPending(null);
    return "deferred" as const;
  }, [calendar.subview, commands, dtoById, gated]);

  // ---------------------------------------------------------------------------------------------
  // Selection → "Reschedule…".
  // ---------------------------------------------------------------------------------------------

  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => { setSelectedId(null); }, [resetKey, identity.principalId, identity.role, identity.authorizationEpoch]);
  const selected = selectedId ? dtoById.get(selectedId) ?? null : null;
  const selectedNeedsAttention = selected ? commands.checklistNeedsAttention.has(selected.id) : false;
  const selectedHref = selected ? projectHrefFor?.(selected.project.id) : undefined;
  const selectedAction = (() => {
    if (!selected || !live) return null;
    if (selected.kind === "project_deadline") return selected.permissions.canDrag ? { label: "Reschedule…", run: () => commands.openMoveDialog(selected) } : null;
    if (selectedNeedsAttention || !selected.permissions.canOpenScheduleEditor) return null;
    return { label: `${checklistScheduleEditorButtonLabel(selected)}…`, run: () => commands.openChecklistScheduleEditor(selected) };
  })();

  // ---------------------------------------------------------------------------------------------
  // Unscheduled.
  // ---------------------------------------------------------------------------------------------

  const overlay = commands.optimisticOverlay;
  const sourceUnscheduled = useMemo(() => source?.unscheduled ?? [], [source?.unscheduled]);
  const renderUnscheduled = useMemo(() => overlay && "kind" in overlay && overlay.kind === "reschedule-unscheduled"
    ? sourceUnscheduled.filter((entry) => entry.id !== overlay.entryId)
    : sourceUnscheduled, [overlay, sourceUnscheduled]);
  const unscheduledFacets = useMemo(() => {
    const facets = source?.filterFacets.unscheduled ?? EMPTY_FACETS;
    if (!overlay || !("kind" in overlay) || overlay.kind !== "reschedule-unscheduled") return facets;
    const sourceEntry = sourceUnscheduled.find((entry) => entry.id === overlay.entryId);
    const facetKey = (sourceEntry?.kind ?? overlay.asEvent.kind) === "project_deadline" ? "project" : "checklist";
    const facet = facets[facetKey];
    return { ...facets, [facetKey]: { matched: Math.max(0, facet.matched - 1), returned: Math.max(0, facet.returned - 1), truncated: facet.truncated } };
  }, [overlay, source?.filterFacets.unscheduled, sourceUnscheduled]);
  const projectEntries = useMemo(() => renderUnscheduled.filter((entry): entry is ProjectCalendarUnscheduledEntryDto => entry.kind === "project_deadline"), [renderUnscheduled]);
  const checklistEntries = useMemo(() => renderUnscheduled.filter((entry): entry is ChecklistCalendarUnscheduledEntryDto => entry.kind === "checklist"), [renderUnscheduled]);

  const canDropEntry = useCallback((entry: CalendarUnscheduledEntryDto) => live && calendar.subview !== "agenda" && !gated && canDragUnscheduledEntry(entry, rangesEnabled), [calendar.subview, gated, live, rangesEnabled]);
  const dropEntry = useCallback((entry: CalendarUnscheduledEntryDto, target: EventCalendarDropTargetLike) => {
    if (!canDropEntry(entry)) return;
    const planned = eventCalendarDropToProposal(entry as ChecklistCalendarUnscheduledEntryDto | ProjectCalendarUnscheduledEntryDto, target);
    if (planned.kind !== "proposal") {
      commands.announceLifecycle("invalid", { entity: entry.kind === "checklist" ? "checklist" : "deadline" });
      return;
    }
    commands.submitProposal(planned.proposal);
  }, [canDropEntry, commands]);

  // ---------------------------------------------------------------------------------------------
  // Render.
  // ---------------------------------------------------------------------------------------------

  const date = useMemo(() => productionEventCalendarAnchor(calendar.date), [calendar.date]);
  // Always a defined object: toggling between an object and `undefined` would flip the vendor
  // between controlled and uncontrolled interactions.
  const interactions = useMemo(() => ({ drag: !gated, resize: !gated, selectSlot: false }), [gated]);
  const filters = productionCalendarFiltersFor(calendar);
  const loading = query.isPending && !query.data;

  const rail = (
    <ProductionEventCalendarRail
      date={calendar.date}
      onDateChange={(civil) => { if (civil !== calendar.date) navigate({ date: civil }); }}
      events={source?.events ?? []}
      nowCivil={nowCivil}
      upNext={upNext}
      onOpenUpNext={(event) => { const civil = eventCivilDate(event); if (civil !== calendar.date) navigate({ date: civil }); setRailOpen(false); }}
      className={narrow ? "min-h-0 flex-1" : "min-h-0 border-r border-border"}
      facets={<ProductionEventCalendarFacets filters={filters} facetPeople={query.data?.filterFacets.people ?? []} disabled={loading || blocked} onChange={(next) => navigate(next)} />}
      unscheduled={(
        <UnscheduledDragSource
          projectEntries={projectEntries}
          checklistEntries={checklistEntries}
          facets={unscheduledFacets}
          subview={calendar.subview}
          rangesEnabled={rangesEnabled}
          onScheduleProject={(entry) => { if (canDragUnscheduledEntry(entry, rangesEnabled)) commands.openUnscheduledProjectDialog(entry); }}
          onScheduleChecklist={commands.openUnscheduledChecklistScheduleEditor}
          disabled={blocked || settling}
          dragSuppressed={gated}
          dragEnabled={!commands.accessLost}
          canDrop={canDropEntry}
          onDrop={dropEntry}
          projectHrefFor={projectHrefFor}
          onOpenProject={onOpenProject}
        />
      )}
    />
  );

  const dense = errorDetail(query.error, "code") === "calendar_range_too_dense";
  const refinement = errorDetail(query.error, "refinement") ?? "Refine the date range, Stage, Editor, layer, or search filters.";
  const showGrid = everLoaded && !commands.accessLost && !(query.error && !source && !query.isFetching);
  const empty = source !== null && source.events.length === 0;
  // The FullCalendar toolbar's "Sydney time · AEST/AEDT", for the window the server is asked for.
  const zoneLabel = useMemo(() => productionCalendarZoneLabel(deriveProductionCalendarWindow(calendar.date, calendar.subview)), [calendar.date, calendar.subview]);

  return (
    <section className="min-w-0" aria-label="Production Calendar" tabIndex={-1} data-focus-key="calendar-safe-fallback" data-testid="event-calendar-screen">
      {commands.settle.recoveryReason && (
        <Notice tone="caution" role="alert" className="mb-[var(--space-4)] flex items-center justify-between gap-[var(--space-4)]" data-testid="calendar-recovery-notice">
          <span>{commands.settle.recoveryReason}</span>
          <Button type="button" variant="outline" className="max-[721px]:min-h-[44px]" data-focus-key="calendar-recovery" onClick={() => void commands.refreshRecovery()}>Refresh</Button>
        </Notice>
      )}

      {loading && !everLoaded && (
        <div className="grid gap-[var(--space-3)] py-[var(--space-4)]" role="status" data-testid="event-calendar-loading">
          <span className="sr-only">Loading calendar…</span>
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-[480px] w-full" />
        </div>
      )}

      {!query.isPending && query.error && !query.data && !source && (
        <EmptyState tone="error" title="Calendar unavailable." role="alert" data-testid="event-calendar-error">
          {dense ? <><p className="m-0">That range is too dense — narrow the filters.</p><p className="m-0">{refinement}</p></> : <p className="m-0">Calendar could not be loaded. Try again.</p>}
          {!dense && <Button type="button" variant="outline" className="mt-[var(--space-4)]" onClick={() => void query.refetch()}>Try again</Button>}
        </EmptyState>
      )}

      {showGrid && (
        <EventCalendar<ProductionEventCalendarData>
          className="min-h-0"
          events={events}
          view={subviewToCalendarView(calendar.subview)}
          date={date}
          views={[...CALENDAR_VIEWS]}
          {...PRODUCTION_EVENT_CALENDAR_VIEW_SETTINGS}
          loading={!source}
          interactions={interactions}
          onEventUpdate={handleEventUpdate}
          onEventClick={(occurrence) => setSelectedId(String(occurrence.event.id))}
          onDateChange={(next) => { const civil = sydneyCivilDate(next); if (civil !== calendar.date) navigate({ date: civil }); }}
          onViewChange={(view) => { const subview = calendarViewToSubview(view); if (subview && subview !== calendar.subview) navigate({ subview }); }}
          onSlotClick={(slot) => { if (slot.view === "month") navigate({ subview: "day", date: sydneyCivilDate(slot.date) }); }}
          eventClassName={(occurrence) => productionEventCalendarEventClassName(occurrence.event.data)}
          renderEvent={({ occurrence }) => <ChipContent id={String(occurrence.event.id)} data={occurrence.event.data} title={occurrence.event.title} needsAttention={commands.checklistNeedsAttention.has(String(occurrence.event.id))} />}
        >
          {/* One definite height for rail + grid, and a `minmax(0,1fr)` row: an `auto` row grows to
              the rail's content (52 unscheduled rows → 5.6k px), which stretched the month rows and
              kept the rail's ScrollArea from ever scrolling. Bounded, the rail scrolls inside its
              column and the content fills the rest of the column. */}
          <div className={cn("grid h-[min(760px,calc(100svh-220px))] min-h-[480px] grid-rows-[minmax(0,1fr)] items-stretch", narrow ? "grid-cols-1" : "grid-cols-[minmax(240px,280px)_minmax(0,1fr)]")} data-testid="event-calendar-body">
            {!narrow && rail}
            <div className="flex min-h-0 min-w-0 flex-col">
              <div className="flex min-w-0 items-center gap-[var(--space-2)]">
                {narrow && (
                  <Button type="button" variant="outline" size="sm" className="ms-[var(--space-2)] max-[721px]:min-h-[44px]" data-testid="event-calendar-rail-toggle" aria-expanded={railOpen} onClick={() => setRailOpen(true)}>
                    Filters
                  </Button>
                )}
                <EventCalendarNav showViewSwitcher className="min-w-0 flex-1" />
                <Eyebrow className="shrink-0 whitespace-nowrap last:me-[var(--space-2)] text-muted-foreground" data-testid="event-calendar-zone">{zoneLabel}</Eyebrow>
                {empty && (
                  // Quiet, in the toolbar row: an empty range never pushes the grid down.
                  <p className="m-0 me-[var(--space-2)] min-w-0 shrink truncate text-[length:var(--text-xs)] text-muted-foreground" role="status" data-testid="event-calendar-empty">No scheduled work in this range.</p>
                )}
              </div>
              {selected && (
                <div className="flex min-w-0 flex-wrap items-center gap-[var(--space-2)] border-b border-border px-[var(--space-2)] py-[var(--space-2)] text-[length:var(--text-xs)]" data-testid="event-calendar-selected">
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {selected.kind === "project_deadline" ? "Deadline" : selected.title}
                    {" · "}
                    {selectedHref ? <ProjectCalendarAnchor href={selectedHref} onOpenProject={() => onOpenProject?.(selected.project.id)}>{selected.project.street}</ProjectCalendarAnchor> : selected.project.street}
                  </span>
                  {selected.kind === "checklist" && selected.status.sameAssigneeOverlap === true && <span className="text-signal-caution-text">{OVERLAP}</span>}
                  {selectedNeedsAttention && <span className="text-signal-critical" role="status">{NEEDS_ATTENTION}</span>}
                  {selectedAction && (
                    <Button type="button" variant="outline" size="sm" className="max-[721px]:min-h-[44px]" data-focus-key={`calendar-move:${selected.id}`} onClick={selectedAction.run}>
                      {selectedAction.label}
                    </Button>
                  )}
                  <Button type="button" variant="ghost" size="sm" className="max-[721px]:min-h-[44px]" data-testid="event-calendar-selected-clear" onClick={() => setSelectedId(null)}>Close</Button>
                </div>
              )}
              <EventCalendarContent className="min-h-0 flex-1" />
            </div>
          </div>
          {narrow && (
            <Sheet open={railOpen} onOpenChange={setRailOpen}>
              <SheetContent
                side="left"
                className="z-[var(--z-dialog)] w-[320px] max-w-[90vw] gap-0 p-0"
                data-testid="event-calendar-rail-sheet"
                overlayProps={{
                  "data-testid": "event-calendar-rail-sheet-scrim",
                  // Every page sits inside RailedShell's Sheet Root, so this Sheet is nested and Base
                  // UI skips its Backdrop without `forceRender` — the schedule editor sheet's pattern.
                  forceRender: true,
                  className: "z-[var(--z-dialog)] bg-[var(--scrim-overlay)] backdrop-blur-[3px]",
                }}
              >
                <SheetHeader className="border-b border-border">
                  <SheetTitle>Calendar</SheetTitle>
                  <SheetDescription className="sr-only">Mini month, up next, filters and unscheduled work.</SheetDescription>
                </SheetHeader>
                {rail}
              </SheetContent>
            </Sheet>
          )}
        </EventCalendar>
      )}

      <div className="sr-only" data-testid="dashboard-live-region" aria-live="polite" aria-atomic="true">{commands.announcement}</div>
      <ProductionEventCalendarDialogs commands={commands} rangesEnabled={rangesEnabled} deadlineConfirm={deadlineConfirm} />
    </section>
  );
}
