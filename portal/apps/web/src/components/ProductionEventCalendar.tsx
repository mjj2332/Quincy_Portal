/**
 * #222 — the Production Calendar on the vendored ReUI event calendar, the Dashboard's default
 * Calendar renderer since #223, and the only one since #224 deleted the FullCalendar renderer and
 * its per-browser opt-out.
 *
 * The ONLY app file that imports `components/reui/event-calendar/` — pinned by
 * `harness-reachability.guard.test.ts` (`ALLOWED_VENDOR_SCHEDULING_CONSUMERS`, an exact-file entry
 * scoped to that one tree) and `ProductionEventCalendar.import-boundary.guard.test.ts`. The rail,
 * dialogs are presentational siblings that never import the tree.
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
 * renders INSIDE `<EventCalendar>` in both places (the sheet portals the DOM, not the React tree).
 *
 * Phone gate: a coarse pointer at ≤720px turns drag and resize (and so keyboard Adjust) off in
 * week / day / days.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import {
  deriveProductionCalendarWindow,
  formatSydneyCivilMinute,
  type CalendarEventDto,
  type DashboardCalendarState,
  type ProductionCalendarFilters,
  type ProductionCalendarRangeResponse,
} from "@quincy/shared";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import { applyOptimisticOverlay, type CalendarSettleState } from "../lib/production-calendar-interaction";
import { effectiveCalendarEventPermissions } from "../lib/production-calendar-permissions";
import { productionCalendarFiltersFor, useProductionCalendarRange } from "../lib/production-calendar-query";
import {
  calendarViewToSubview,
  PRODUCTION_EVENT_CALENDAR_VIEW_SETTINGS,
  productionEventCalendarAnchor,
  productionEventCalendarEventClassName,
  subviewToCalendarView,
  toProductionEventCalendarEvents,
  type ProductionEventCalendarData,
} from "../lib/production-event-calendar-adapter";
import { eventCalendarUpdateToProposal, type EventCalendarUpdateLike } from "../lib/production-event-calendar-scheduling";
import { staffPathFor } from "../lib/router";
import { calendarScheduleBounds, type ScheduleBounds } from "../lib/schedule-bounds";
import { useCalendarSchedulingPort, type SchedulingDeadlineConfirmInput } from "../lib/use-scheduling-commands";
import { useSchedulingControllerWithUndoToast } from "../lib/use-scheduling-undo-toast";
import { useMediaQuery } from "../lib/use-media-query";
import { productionCalendarZoneLabel } from "../lib/sydney-time-labels";
import { cn } from "@/lib/utils";
import { EventCalendar } from "./reui/event-calendar/event-calendar";
import {
  EventCalendarNav,
  EventCalendarNavNext,
  EventCalendarNavPrev,
  EventCalendarNavToday,
  EventCalendarTitle,
  EventCalendarViewSwitcher,
} from "./reui/event-calendar/event-calendar-nav";
import { TooltipProvider } from "./reui/tooltip";
import { EventCalendarContent } from "./reui/event-calendar/event-calendar-content";
import { Button } from "./reui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./reui/sheet";
import { Skeleton } from "./reui/skeleton";
import { EmptyState } from "./quincy/EmptyState";
import { Eyebrow } from "./quincy/Eyebrow";
import { AvatarStack } from "./quincy/AvatarStack";
import { Notice } from "./quincy/Notice";
import { checklistScheduleEditorButtonLabel } from "./ProductionCalendarScheduleEditorFields";
import { ProjectCalendarAnchor } from "./ProjectCalendarAnchor";
import { ProductionEventCalendarDialogs, type ProductionEventCalendarDeadlineConfirm } from "./ProductionEventCalendarDialogs";
import { ProductionEventCalendarRail, type ProductionEventCalendarUpNext } from "./ProductionEventCalendarRail";

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
  /**
   * #260: how many projects this range draws under the Calendar's filters (the projects its events
   * reference), for the Dashboard search chip. `null` while no response has
   * landed and on unmount.
   */
  onShownProjectsChange?: (count: number | null) => void;
};

/** Below this width the rail leaves the grid's side and moves into a sheet. */
const RAIL_SHEET_QUERY = "(max-width: 1100px)";
const PHONE_QUERY = "(max-width: 720px)";
const COARSE_QUERY = "(pointer: coarse)";
const CALENDAR_VIEWS = ["month", "week", "day", "days", "agenda"] as const;
const TIME_GRID_SUBVIEWS = new Set(["week", "day", "days"]);
const OVERLAP = "Overlaps another task";
// A denser AvatarStack for the chip: 16px avatars (the size the single initials avatar had), 2xs initials and `+N`.
const CHIP_AVATAR = "size-4 data-[size=sm]:size-4 group-has-data-[size=sm]/avatar-group:size-4 [&_[data-slot=avatar-fallback]]:text-[length:var(--text-2xs)] text-[length:var(--text-2xs)] ring-1 ring-[var(--bg-surface)]";
// Chip density: 2px overlap, 1px ring in the chip's surface colour (the group default is a 2px page-cream ring).
const CHIP_STACK = "shrink-0 -space-x-0.5 *:data-[slot=avatar]:ring-1 *:data-[slot=avatar]:ring-[var(--bg-surface)]";

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

/**
 * The controller's reset key: any route or filter change starts a fresh controller generation. It is the
 * canonical Calendar URL (`staffPathFor`), so a facet added to the route (#428's Priority and Archived)
 * resets the controller without anyone remembering to list it here.
 */
function calendarResetKey(calendar: DashboardCalendarState): string {
  return staffPathFor({ kind: "dashboard", calendar });
}

function ChipContent({ id, data, title }: { id: string; data: ProductionEventCalendarData | undefined; title: string }): JSX.Element {
  const dto = data?.dto;
  const label = dto?.kind === "project_deadline" ? dto.project.street : title;
  const assignees = dto?.kind === "checklist" ? dto.assignees : [];
  const otherAssigneeCount = dto?.kind === "checklist" ? dto.otherAssigneeCount : 0;
  const overlap = dto?.kind === "checklist" && dto.status.sameAssigneeOverlap === true;
  return (
    // `data-event-id` is the controller's focus-return hook (it focuses the vendor chip button around it).
    <span className="flex w-full min-w-0 items-center gap-[var(--space-1)] pe-[var(--space-1)]" data-testid="event-calendar-chip" data-event-id={id}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {overlap && <span className="sr-only">{OVERLAP}</span>}
      {assignees.length + otherAssigneeCount > 0 && (
        <AvatarStack
          people={assignees}
          hiddenCount={otherAssigneeCount}
          limit={3}
          personNoun="Assignee"
          emptyLabel="No assignee"
          className={CHIP_STACK}
          avatarClassName={CHIP_AVATAR}
          singleInitial
        />
      )}
    </span>
  );
}

export function ProductionEventCalendar({ identity, calendar, onNavigate, onAppliedFilters, onAcceptGateChange, onSettleStateChange, onAccessLoss, projectHrefFor, onOpenProject, onShownProjectsChange }: ProductionEventCalendarProps): JSX.Element {
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
  // #295: a save's `producer: "calendar"` skips every in-tab `production-calendar` query, and the
  // settle refetch covers only the main range (and is skipped if the user navigates mid-save), so
  // the rail refreshes at commit. Not awaited: the rail sits outside any gate.
  const refreshUpNext = () => { void upNextQuery.refetch(); };
  const commands = useSchedulingControllerWithUndoToast<ProductionCalendarRangeResponse>({ identity, resetKey: calendarResetKey(calendar), port, onAcceptGateChange, onSettleStateChange, onAccessLoss, onCommitted: refreshUpNext, onUndone: refreshUpNext });
  const blocked = commands.interactionBlocked;
  const settling = commands.settle.pending;
  const live = !blocked && !settling && !commands.accessLost;

  // Draw from the accepted baseline; the live query only while nothing holds the gate.
  const source: ProductionCalendarRangeResponse | null = commands.acceptedResponse ?? (!blocked ? query.data ?? null : null);
  boundsRef.current = useMemo(() => new Map((source?.projectBounds ?? query.data?.projectBounds ?? []).map((bound) => [bound.projectId, calendarScheduleBounds(bound)])), [source?.projectBounds, query.data?.projectBounds]);

  const shownProjects = query.data?.projectBounds ? query.data.projectBounds.length : null;
  useEffect(() => { onShownProjectsChange?.(shownProjects); }, [onShownProjectsChange, shownProjects]);
  useEffect(() => () => onShownProjectsChange?.(null), [onShownProjectsChange]);

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

  const gated = phone && TIME_GRID_SUBVIEWS.has(calendar.subview);
  const renderEvents = useMemo<CalendarEventDto[]>(() => (source?.events ?? []).map((event) => effectiveCalendarEventPermissions(event, {
    subview: calendar.subview,
    role: identity.role,
    interactionBlocked: blocked,
    settlePending: settling,
    deadlineMovementDisabled: commands.deadlineMovementDisabled,
  })), [source?.events, calendar.subview, identity.role, blocked, settling, commands.deadlineMovementDisabled]);
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
  const selectedHref = selected ? projectHrefFor?.(selected.project.id) : undefined;
  const selectedAction = (() => {
    if (!selected || !live) return null;
    if (selected.kind === "project_deadline") return selected.permissions.canDrag ? { label: "Reschedule…", run: () => commands.openMoveDialog(selected) } : null;
    if (!selected.permissions.canOpenScheduleEditor) return null;
    return { label: `${checklistScheduleEditorButtonLabel()}…`, run: () => commands.openChecklistScheduleEditor(selected) };
  })();

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
    />
  );

  const dense = errorDetail(query.error, "code") === "calendar_range_too_dense";
  const refinement = errorDetail(query.error, "refinement") ?? "Refine the date range, Stage, Editor, layer, or search filters.";
  const showGrid = everLoaded && !commands.accessLost && !(query.error && !source && !query.isFetching);
  const empty = source !== null && source.events.length === 0;
  // The FullCalendar toolbar's "Sydney time · AEST/AEDT", for the window the server is asked for.
  const zoneLabel = useMemo(() => productionCalendarZoneLabel(deriveProductionCalendarWindow(calendar.date, calendar.subview)), [calendar.date, calendar.subview]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Production Calendar" tabIndex={-1} data-focus-key="calendar-safe-fallback" data-testid="event-calendar-screen">
      {commands.settle.recoveryReason && (
        <Notice tone="caution" role="alert" className="mb-[var(--space-4)] flex shrink-0 items-center justify-between gap-[var(--space-4)]" data-testid="calendar-recovery-notice">
          <span>{commands.settle.recoveryReason}</span>
          <Button type="button" variant="outline" className="max-[721px]:min-h-[44px]" data-focus-key="calendar-recovery" onClick={() => void commands.refreshRecovery()}>Refresh</Button>
        </Notice>
      )}

      {loading && !everLoaded && (
        <div className="flex min-h-0 flex-1 flex-col gap-[var(--space-3)] pt-[var(--space-4)]" role="status" data-testid="event-calendar-loading">
          <span className="sr-only">Loading calendar…</span>
          <Skeleton className="h-8 w-1/3 shrink-0" />
          <Skeleton className="min-h-0 w-full flex-1" />
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
          className="min-h-0 flex-1"
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
          renderEvent={({ occurrence }) => <ChipContent id={String(occurrence.event.id)} data={occurrence.event.data} title={occurrence.event.title} />}
        >
          {/* The body is a flexed item of a definite-height column (#363), so its `minmax(0,1fr)` row is
              bounded by the page, not a viewport offset. An `auto` row would grow to the rail's content
              (a long Up next list becomes thousands of px) and stretch the month rows. Bounded, the rail
              scrolls inside its column and the content fills the rest. */}
          <div className={cn("grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] items-stretch", narrow ? "grid-cols-1" : "grid-cols-[minmax(240px,280px)_minmax(0,1fr)]")} data-testid="event-calendar-body">
            {!narrow && rail}
            <div className="flex min-h-0 min-w-0 flex-col">
              {phoneViewport ? (
                // #385: at phone width the title gets its own row (full period, wrapping rather than
                // truncating) with the zone label, and the controls sit on a second row. Composed from
                // the vendored nav's children API and exported parts; no vendored file is edited. The
                // default nav composes Today / switcher / arrows / title itself, so a part the vendor
                // adds there will not appear on phones until it is added here.
                <EventCalendarNav className="min-w-0 shrink-0 gap-y-[var(--space-1)] px-0">
                  {/* The default nav's shared provider, which custom children bypass: first tooltip
                      waits, moving between buttons is instant (the vendor's 600 / 0 / 300 ms). */}
                  <TooltipProvider delay={600} closeDelay={0} timeout={300}>
                    <div className="flex min-w-0 basis-full flex-wrap items-baseline gap-x-[var(--space-2)] gap-y-[var(--space-1)]" data-testid="event-calendar-period">
                      <EventCalendarTitle className="overflow-visible whitespace-normal text-clip" />
                      <Eyebrow className="shrink-0 whitespace-nowrap text-muted-foreground" data-testid="event-calendar-zone">{zoneLabel}</Eyebrow>
                      {empty && (
                        <p className="m-0 min-w-0 text-[length:var(--text-xs)] text-muted-foreground" role="status" data-testid="event-calendar-empty">No scheduled work in this range.</p>
                      )}
                    </div>
                    <div className="flex min-w-0 basis-full flex-wrap items-center gap-[var(--space-1)]" data-testid="event-calendar-controls">
                      <Button type="button" variant="outline" size="sm" className="min-h-[44px]" data-testid="event-calendar-rail-toggle" aria-expanded={railOpen} onClick={() => setRailOpen(true)}>
                        Filters
                      </Button>
                      <EventCalendarNavToday className="min-h-[44px]" />
                      <EventCalendarViewSwitcher className="min-h-[44px]" />
                      <EventCalendarNavPrev className="min-h-[44px] min-w-[44px]" />
                      <EventCalendarNavNext className="min-h-[44px] min-w-[44px]" />
                    </div>
                  </TooltipProvider>
                </EventCalendarNav>
              ) : (
              <div className="flex min-w-0 flex-wrap items-center gap-[var(--space-2)]">
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
              )}
              {selected && (
                <div className="flex min-w-0 flex-wrap items-center gap-[var(--space-2)] border-b border-border px-[var(--space-2)] py-[var(--space-2)] text-[length:var(--text-xs)]" data-testid="event-calendar-selected">
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {selected.kind === "project_deadline" ? "Deadline" : selected.title}
                    {" · "}
                    {selectedHref ? <ProjectCalendarAnchor href={selectedHref} onOpenProject={() => onOpenProject?.(selected.project.id)}>{selected.project.street}</ProjectCalendarAnchor> : selected.project.street}
                  </span>
                  {selected.kind === "checklist" && selected.status.sameAssigneeOverlap === true && <span className="text-signal-caution-text">{OVERLAP}</span>}
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
                  <SheetDescription className="sr-only">Mini month, up next and filters.</SheetDescription>
                </SheetHeader>
                {rail}
              </SheetContent>
            </Sheet>
          )}
        </EventCalendar>
      )}

      <div className="sr-only" data-testid="dashboard-live-region" aria-live="polite" aria-atomic="true">{commands.announcement}</div>
      <ProductionEventCalendarDialogs commands={commands} deadlineConfirm={deadlineConfirm} />
    </section>
  );
}
