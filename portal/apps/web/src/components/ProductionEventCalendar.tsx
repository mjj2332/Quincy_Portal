/**
 * #222 — the Production Calendar on the vendored ReUI event calendar, behind the per-browser
 * renderer flag (`screens/dashboard-helpers.ts`, `DASHBOARD_CALENDAR_RENDERER_KEY`). The FullCalendar
 * renderer (`ProductionCalendar.tsx`) stays the default until #223.
 *
 * The ONLY app file that imports `components/reui/event-calendar/` — pinned by
 * `harness-reachability.guard.test.ts` (`ALLOWED_VENDOR_SCHEDULING_CONSUMERS`, an exact-file entry
 * scoped to that one tree) and `ProductionEventCalendar.import-boundary.guard.test.ts`. The rail,
 * facets, unscheduled list and dialogs are presentational siblings that never import the tree.
 *
 * Round 2 (this file): READ-ONLY. Events, view and date are controlled from the Dashboard's
 * `DashboardCalendarState` (the URL) through the pure adapter; `onEventUpdate` returns `"deferred"`
 * and does nothing else, so a drag or resize settles back where the server put it. Round 3 wires the
 * scheduling controller (`useSchedulingController`), the dialogs, the external drop and the
 * accept/settle gate props (`onAcceptGateChange`, `onSettleStateChange`, `onAccessLoss`, accepted
 * here for signature parity with `ProductionCalendar` and not yet used).
 *
 * Never passed to `<EventCalendar>`: `onEventsChange` (the vendor would commit a range the server may
 * refuse), `canDropEvent` / `enforceCanDrop` (production warns, never blocks).
 *
 * Layout: rail beside the grid; below `RAIL_SHEET_QUERY` (a JS media query — no shell breakpoint
 * literal, no `lg:`) the rail moves into a `reui/sheet` opened from a button beside the nav. The rail
 * renders INSIDE `<EventCalendar>` in both places (the sheet portals the DOM, not the React tree), so
 * round 3's external-drop hook has its provider.
 *
 * Phone gate: a coarse pointer at ≤720px turns drag and resize off in week / day / days (the old
 * renderer's action-only week, extended to the two new time-grid views).
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import {
  CHECKLIST_SCHEDULE_RANGES_ENABLED,
  formatSydneyCivilMinute,
  resolveSydneyCivilMinute,
  type CalendarEventDto,
  type ChecklistCalendarUnscheduledEntryDto,
  type DashboardCalendarState,
  type ProductionCalendarFilters,
  type ProjectCalendarUnscheduledEntryDto,
} from "@quincy/shared";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import type { CalendarSettleState } from "../lib/production-calendar-interaction";
import { productionCalendarFiltersFor, useProductionCalendarRange } from "../lib/production-calendar-query";
import {
  calendarViewToSubview,
  productionEventCalendarEventClassName,
  subviewToCalendarView,
  toProductionEventCalendarEvents,
  type ProductionEventCalendarData,
} from "../lib/production-event-calendar-adapter";
import { useMediaQuery } from "../lib/use-media-query";
import { cn } from "@/lib/utils";
import { EventCalendar } from "./reui/event-calendar/event-calendar";
import { EventCalendarNav } from "./reui/event-calendar/event-calendar-nav";
import { EventCalendarContent } from "./reui/event-calendar/event-calendar-content";
import { Button } from "./reui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./reui/sheet";
import { Skeleton } from "./reui/skeleton";
import { EmptyState } from "./quincy/EmptyState";
import { InitialsAvatar } from "./quincy/InitialsAvatar";
import { ProductionEventCalendarFacets } from "./ProductionEventCalendarFacets";
import { ProductionEventCalendarRail, type ProductionEventCalendarUpNext } from "./ProductionEventCalendarRail";
import { ProductionEventCalendarUnscheduledList } from "./ProductionEventCalendarUnscheduledList";

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

/** The controlled `date`: Sydney noon of the civil date, clear of any midnight edge. */
function sydneyNoon(civilDate: string): Date {
  const resolved = resolveSydneyCivilMinute(`${civilDate}T12:00`, "earlier");
  return resolved.ok ? new Date(resolved.value.instant) : new Date(`${civilDate}T02:00:00.000Z`);
}

function sydneyCivilDate(instant: Date): string {
  return formatSydneyCivilMinute(instant.getTime()).slice(0, 10);
}

function eventCivilDate(event: CalendarEventDto): string {
  return event.timing.allDay ? event.timing.start.slice(0, 10) : formatSydneyCivilMinute(event.timing.start).slice(0, 10);
}

function ChipContent({ data, title }: { data: ProductionEventCalendarData | undefined; title: string }): JSX.Element {
  const dto = data?.dto;
  const label = dto?.kind === "project_deadline" ? dto.project.street : title;
  const assignee = dto?.kind === "checklist" ? dto.assignee : null;
  return (
    <span className="flex w-full min-w-0 items-center gap-[var(--space-1)]" data-testid="event-calendar-chip">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {assignee && <InitialsAvatar name={assignee.name} className="size-4 shrink-0 [&_[data-slot=avatar-fallback]]:text-[length:var(--text-2xs)]" />}
    </span>
  );
}

export function ProductionEventCalendar({ identity, calendar, onNavigate, onAppliedFilters, projectHrefFor, onOpenProject }: ProductionEventCalendarProps): JSX.Element {
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

  useEffect(() => {
    const applied = query.data?.range.appliedFilters;
    if (!applied || sameFilters(applied, productionCalendarFiltersFor(calendar))) return;
    onAppliedFilters?.(applied);
  }, [calendar, onAppliedFilters, query.data?.range.appliedFilters]);

  const navigate = useCallback((changes: Partial<DashboardCalendarState>) => {
    onNavigate({ ...calendar, ...changes, view: "calendar" });
  }, [calendar, onNavigate]);

  const events = useMemo(() => toProductionEventCalendarEvents(query.data?.events ?? []), [query.data?.events]);
  const date = useMemo(() => sydneyNoon(calendar.date), [calendar.date]);
  const gated = phone && TIME_GRID_SUBVIEWS.has(calendar.subview);
  // Always a defined object: toggling between an object and `undefined` would flip the vendor
  // between controlled and uncontrolled interactions.
  const interactions = useMemo(() => ({ drag: !gated, resize: !gated, selectSlot: false }), [gated]);

  const unscheduled = query.data?.unscheduled ?? [];
  const projectEntries = useMemo(() => unscheduled.filter((entry): entry is ProjectCalendarUnscheduledEntryDto => entry.kind === "project_deadline"), [unscheduled]);
  const checklistEntries = useMemo(() => unscheduled.filter((entry): entry is ChecklistCalendarUnscheduledEntryDto => entry.kind === "checklist"), [unscheduled]);
  const filters = productionCalendarFiltersFor(calendar);
  const loading = query.isPending && !query.data;

  const rail = (
    <ProductionEventCalendarRail
      date={calendar.date}
      onDateChange={(civil) => { if (civil !== calendar.date) navigate({ date: civil }); }}
      events={query.data?.events ?? []}
      nowCivil={nowCivil}
      upNext={upNext}
      onOpenUpNext={(event) => { const civil = eventCivilDate(event); if (civil !== calendar.date) navigate({ date: civil }); setRailOpen(false); }}
      className={narrow ? "min-h-0 flex-1" : "min-h-0 border-r border-border"}
      facets={<ProductionEventCalendarFacets filters={filters} facetPeople={query.data?.filterFacets.people ?? []} disabled={loading} onChange={(next) => navigate(next)} />}
      unscheduled={(
        // Round 2 is read-only: rows render in action mode with their Schedule buttons disabled
        // until round 3 wires the dialogs and the external drop (`beginDrag`).
        <ProductionEventCalendarUnscheduledList
          projectEntries={projectEntries}
          checklistEntries={checklistEntries}
          facets={query.data?.filterFacets.unscheduled ?? EMPTY_FACETS}
          subview={calendar.subview}
          rangesEnabled={CHECKLIST_SCHEDULE_RANGES_ENABLED}
          onScheduleProject={() => undefined}
          onScheduleChecklist={() => undefined}
          disabled
          projectHrefFor={projectHrefFor}
          onOpenProject={onOpenProject}
        />
      )}
    />
  );

  const dense = errorDetail(query.error, "code") === "calendar_range_too_dense";
  const refinement = errorDetail(query.error, "refinement") ?? "Refine the date range, Stage, Editor, layer, or search filters.";

  return (
    <section className="min-w-0" aria-label="Production Calendar" tabIndex={-1} data-focus-key="calendar-safe-fallback" data-testid="event-calendar-screen">
      {loading && (
        <div className="grid gap-[var(--space-3)] py-[var(--space-4)]" role="status" data-testid="event-calendar-loading">
          <span className="sr-only">Loading calendar…</span>
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-[480px] w-full" />
        </div>
      )}

      {!query.isPending && query.error && !query.data && (
        <EmptyState tone="error" title="Calendar unavailable." role="alert" data-testid="event-calendar-error">
          {dense ? <><p className="m-0">That range is too dense — narrow the filters.</p><p className="m-0">{refinement}</p></> : <p className="m-0">Calendar could not be loaded. Try again.</p>}
          {!dense && <Button type="button" variant="outline" className="mt-[var(--space-4)]" onClick={() => void query.refetch()}>Try again</Button>}
        </EmptyState>
      )}

      {query.data && (
        <EventCalendar<ProductionEventCalendarData>
          className="min-h-0"
          events={events}
          view={subviewToCalendarView(calendar.subview)}
          date={date}
          views={[...CALENDAR_VIEWS]}
          timeZone="Australia/Sydney"
          weekStartsOn={1}
          fixedWeeks
          agendaDayCount={14}
          dayCount={3}
          interactions={interactions}
          onEventUpdate={() => "deferred"}
          onDateChange={(next) => { const civil = sydneyCivilDate(next); if (civil !== calendar.date) navigate({ date: civil }); }}
          onViewChange={(view) => { const subview = calendarViewToSubview(view); if (subview && subview !== calendar.subview) navigate({ subview }); }}
          onSlotClick={(slot) => { if (slot.view === "month") navigate({ subview: "day", date: sydneyCivilDate(slot.date) }); }}
          eventClassName={(occurrence) => productionEventCalendarEventClassName(occurrence.event.data)}
          renderEvent={({ occurrence }) => <ChipContent data={occurrence.event.data} title={occurrence.event.title} />}
        >
          <div className={cn("grid min-h-0 items-stretch", narrow ? "grid-cols-1" : "grid-cols-[minmax(240px,280px)_minmax(0,1fr)]")}>
            {!narrow && rail}
            <div className="flex min-h-0 min-w-0 flex-col">
              <div className="flex min-w-0 items-center gap-[var(--space-2)]">
                {narrow && (
                  <Button type="button" variant="outline" size="sm" className="ms-[var(--space-2)] max-[721px]:min-h-[44px]" data-testid="event-calendar-rail-toggle" aria-expanded={railOpen} onClick={() => setRailOpen(true)}>
                    Filters
                  </Button>
                )}
                <EventCalendarNav showViewSwitcher className="min-w-0 flex-1" />
              </div>
              {query.data.events.length === 0 && (
                <EmptyState title="No scheduled work in this range." role="status" className="py-[var(--space-4)]" data-testid="event-calendar-empty" />
              )}
              <EventCalendarContent className="h-[min(760px,calc(100svh-220px))] min-h-[480px]" />
            </div>
          </div>
          {narrow && (
            <Sheet open={railOpen} onOpenChange={setRailOpen}>
              <SheetContent side="left" className="w-[320px] max-w-[90vw] gap-0 p-0" data-testid="event-calendar-rail-sheet">
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

      <div className="sr-only" data-testid="dashboard-live-region" aria-live="polite" aria-atomic="true" />
    </section>
  );
}
