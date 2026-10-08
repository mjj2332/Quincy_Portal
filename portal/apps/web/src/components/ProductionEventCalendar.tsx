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
 * - The item menu (#463): the vendor chip is itself a `<button>`, so no action can live inside it. A
 *   chip click, Enter or right-click opens a menu anchored to the chip (`scheduling-item-menu.tsx`,
 *   shared with the Timeline): Open project (`onOpenProject`, the Dashboard's existing sheet path),
 *   and Reschedule… (a Deadline: the move dialog) or Edit schedule… (a checklist item: the chip's own date/time picker, #583: an inline
 *   `inlineTarget: "item"` session drawn by `SchedulingItemSchedulePicker`, the Gantt's host, with no sheet at any width),
 *   with the strip's exact gates. A drag never opens it; Space still starts keyboard Adjust (ADR 0009).
 *   This retired the selection strip that carried the same actions. `onEventClick` calls
 *   `e.preventDefault()` to opt out of the vendor's own selection; the `selectedId` state below is
 *   kept, unwritten here, as the seam a Project landing (#464) selects through.
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
  canonicalizeDashboardFilterTree,
  deriveProductionCalendarWindow,
  formatDashboardFilterTree,
  formatSydneyCivilMinute,
  type CalendarEventDto,
  type DashboardCalendarState,
  type ProductionCalendarFilters,
  type ProductionCalendarRangeResponse,
  subtaskIdFromCalendarEntityId,
} from "@quincy/shared";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import { applyOptimisticOverlay, type CalendarSettleState } from "../lib/production-calendar-interaction";
import { effectiveCalendarEventPermissions } from "../lib/production-calendar-permissions";
import { productionCalendarFiltersFor, useProductionCalendarRange } from "../lib/production-calendar-query";
import {
  calendarViewToSubview,
  PRODUCTION_EVENT_CALENDAR_VIEW_SETTINGS,
  PRODUCTION_EVENT_CALENDAR_I18N,
  productionEventCalendarAnchor,
  productionEventCalendarEventClassName,
  subviewToCalendarView,
  toProductionEventCalendarEvents,
  type ProductionEventCalendarData,
} from "../lib/production-event-calendar-adapter";
import { eventCalendarUpdateToProposal, type EventCalendarUpdateLike } from "../lib/production-event-calendar-scheduling";
import { projectDefaultFromFacts } from "../lib/date-time-range";
import { useNow } from "../lib/use-now";
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
import { Button as QuincyButton } from "./quincy/Button";
import { CalendarIcon } from "lucide-react";
import { ganttShowDeliveredRecovery } from "../lib/production-gantt-filters";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./reui/sheet";
import { Skeleton } from "./reui/skeleton";
import { EmptyState } from "./quincy/EmptyState";
import { Eyebrow } from "./quincy/Eyebrow";
import { SheetCloseButton, SHEET_CLOSE_CLEARANCE } from "./quincy/SheetCloseButton";
import { AvatarStack } from "./quincy/AvatarStack";
import { Notice } from "./quincy/Notice";
import { focusLanding } from "../lib/landing-focus";
import { findMoreFor } from "../lib/calendar-more-anchor";
import { schedulingItemActions, type SchedulingItemActionId } from "../lib/scheduling-item-actions";
import { useSchedulingItemMenu, type SchedulingMenuContent } from "./scheduling-item-menu";
import { ProductionEventCalendarDialogs, type ProductionEventCalendarDeadlineConfirm } from "./ProductionEventCalendarDialogs";
import { SchedulingItemSchedulePicker, useScheduleConflictStash, type ScheduleItemSummary } from "./scheduling-item-schedule-picker";
import { ProductionEventCalendarRail, type ProductionEventCalendarUpNext } from "./ProductionEventCalendarRail";

/** #464: the Project Show in Calendar asks the Calendar to land on. `token` is the Dashboard's one-shot request id. */
export type ProductionEventCalendarFocus = { projectId: string; token: number };

/** #464: what became of a focus request. Reported once per token through `onFocusSettled`. */
export type ProductionEventCalendarFocusOutcome =
  | {
      kind: "found";
      target: "deadline" | "task";
      /** "Deadline", or the task's title. */
      label: string;
      street: string;
      /** The target's Sydney civil date. */
      civilDate: string;
      /** The chip is folded under a day's "+N more": focus is on that control, not the chip. */
      folded: boolean;
    }
  /** The Project has no event in the range these filters draw. */
  | { kind: "hidden" }
  /** The user navigated before the landing could happen. */
  | { kind: "cancelled" }
  | { kind: "error" };

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
  /** #430: the empty state's "Show delivered Projects" (Stage = Delivered with delivered Projects hidden). */
  onShowDeliveredProjects?: () => void;
  /** #464: land on this Project (select and ring its events, focus its chip) and report the outcome. */
  focus?: ProductionEventCalendarFocus | null;
  onFocusSettled?: (token: number, outcome: ProductionEventCalendarFocusOutcome) => void;
};

/** Below this width the rail leaves the grid's side and moves into a sheet. */
const RAIL_SHEET_QUERY = "(max-width: 1100px)";
const PHONE_QUERY = "(max-width: 720px)";
const COARSE_QUERY = "(pointer: coarse)";
/** #643: below this the Calendar side-panel toggle is icon-only, so Today / view / arrows fit one row at 375px. */
const ICON_TOGGLE_QUERY = "(max-width: 399px)";
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

/** By value. #461: the filter tree compares by its canonical spelling, not by key order, so a server echo of the tree is never read as a change (which would `replace` the URL on every response). */
function sameFilters(left: ProductionCalendarFilters, right: ProductionCalendarFilters): boolean {
  const key = (filters: ProductionCalendarFilters) => JSON.stringify({ ...filters, tree: undefined }) + (filters.tree ? formatDashboardFilterTree(canonicalizeDashboardFilterTree(filters.tree)) : "");
  return key(left) === key(right);
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

/**
 * The chip for an event, wherever it is drawn (a grid cell or the "+N more" popover): the vendor tags the
 * chip CONTENT with `data-event-id` (`ChipContent`), and the focusable element is the `<button>` around it.
 * The agenda's rows render the vendor's own content, which carries no such tag, so the vendor tags the chip
 * BUTTON itself with the same `data-event-id` (a re-keyed row is a new element; this is how it is found again).
 */
function findChip(id: string): HTMLElement | null {
  const tagged = [...document.querySelectorAll<HTMLElement>("[data-event-id]")].filter((element) => element.getAttribute("data-event-id") === id);
  const content = tagged.find((element) => !element.closest("[data-preview]")) ?? tagged[0];
  if (!content) return null;
  return content.matches("button, [tabindex]") ? content : content.closest<HTMLElement>("button") ?? content;
}

/**
 * Where focus goes when a chip inside the month "+N more" popover is gone: a pick closes the popover and
 * unmounts its chips, so the day's open "+N more" button (still `aria-expanded` when the menu opens) stands in.
 */
function findOverflowTrigger(chip: HTMLElement): HTMLElement | null {
  if (!chip.closest('[data-slot="event-calendar-more-popover"]')) return null;
  return document.querySelector<HTMLElement>('[data-slot="event-calendar-more"][aria-expanded="true"]');
}

const MORE_SELECTOR = '[data-slot="event-calendar-more"]';

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

export function ProductionEventCalendar({ identity, calendar, onNavigate, onAppliedFilters, onAcceptGateChange, onSettleStateChange, onAccessLoss, projectHrefFor, onOpenProject, onShownProjectsChange, onShowDeliveredProjects, focus = null, onFocusSettled }: ProductionEventCalendarProps): JSX.Element {
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
  const iconToggle = useMediaQuery(ICON_TOGGLE_QUERY);
  const phone = phoneViewport && coarsePointer;
  const [railOpen, setRailOpen] = useState(false);
  // #652: the sheet opens on Close calendar, not Previous month (the first tabbable, since the rail precedes the close).
  const railCloseRef = useRef<HTMLButtonElement>(null);
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
  const defaultNow = useNow(60_000);
  const projectDefaults = useMemo(() => new Map((source?.projectBounds ?? query.data?.projectBounds ?? []).map((bound) => [bound.projectId, projectDefaultFromFacts({ shootDate: bound.shootDate, createdAt: bound.createdAt, deadline: bound.deadlineLocalCivil ? { localCivil: bound.deadlineLocalCivil, fold: bound.deadlineFold ?? 0 } : null }, defaultNow)])), [source?.projectBounds, query.data?.projectBounds, defaultNow]);
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

  // #464: the request lives in refs that survive `resetKey` (the Dashboard's filter-reconcile write
  // must not cancel it); only the user's own navigation ends it.
  const focusRequestRef = useRef<ProductionEventCalendarFocus | null>(null);
  const focusArmedTokenRef = useRef<number | null>(null);
  const onFocusSettledRef = useRef(onFocusSettled);
  onFocusSettledRef.current = onFocusSettled;
  const [focusTick, setFocusTick] = useState(0);
  const [landedProjectId, setLandedProjectId] = useState<string | null>(null);
  const focusToken = focus?.token ?? null;
  useEffect(() => {
    if (!focus || focusArmedTokenRef.current === focus.token) return;
    focusArmedTokenRef.current = focus.token;
    focusRequestRef.current = focus;
    setLandedProjectId(null);
    setFocusTick((tick) => tick + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- armed once per token
  }, [focusToken]);

  const navigate = useCallback((changes: Partial<DashboardCalendarState>) => {
    if (commands.interactionBlocked) return;
    // The user is moving on: a landing still waiting for its data is withdrawn, and the ring goes.
    const withdrawn = focusRequestRef.current;
    if (withdrawn) {
      focusRequestRef.current = null;
      onFocusSettledRef.current?.(withdrawn.token, { kind: "cancelled" });
    }
    setLandedProjectId(null);
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
  // The item menu (#463) — and the selection seam it left behind.
  // ---------------------------------------------------------------------------------------------

  // Nothing here writes `selectedId` since the strip was retired (a chip click opens the menu, and
  // `onEventClick` opts out of the vendor's selection). It stays, with its reset, as the seam #464's
  // Project landing selects a chip through.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => { setSelectedId(null); }, [resetKey, identity.principalId, identity.role, identity.authorizationEpoch]);
  const selected = selectedId ? dtoById.get(selectedId) ?? null : null;

  // What the menu shows for an item, live: the strip's old context line and caution, and the strip's
  // exact gates (the EFFECTIVE permissions, which already narrow while the surface is not live).
  const describeItem = (key: string): SchedulingMenuContent | null => {
    const dto = dtoById.get(key);
    if (!dto) return null;
    const isDeadline = dto.kind === "project_deadline";
    return {
      label: `${isDeadline ? "Deadline" : dto.title} · ${dto.project.street}`,
      caution: dto.kind === "checklist" && dto.status.sameAssigneeOverlap === true ? OVERLAP : null,
      actions: schedulingItemActions({
        kind: isDeadline ? "deadline" : "checklist",
        canOpenProject: onOpenProject !== undefined,
        canReschedule: isDeadline && dto.permissions.canDrag,
        canEditSchedule: dto.kind === "checklist" && dto.permissions.canOpenScheduleEditor,
        live,
      }),
    };
  };
  const runItemAction = (id: SchedulingItemActionId, key: string) => {
    const dto = dtoById.get(key);
    if (!dto) return;
    if (id === "open-project") onOpenProject?.(dto.project.id);
    else if (id === "reschedule" && dto.kind === "project_deadline") commands.openMoveDialog(dto);
    else if (id === "edit-schedule" && dto.kind === "checklist") {
      // #583: the picker (not the sheet), anchored to the chip. The menu has handed focus to the chip or, for a chip folded under "+N more",
      // to that day's button: keep that element and the day, because the chip can be re-keyed or absent while the picker is open.
      const active = document.activeElement;
      handoffRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
      const trigger = handoffRef.current?.matches(MORE_SELECTOR) ? handoffRef.current : handoffRef.current ? findOverflowTrigger(handoffRef.current) : null;
      moreDayRef.current = trigger?.querySelector("[data-more-day]")?.getAttribute("data-more-day") ?? null;
      commands.openChecklistScheduleEditor(dto, undefined, { inline: true, inlineTarget: "item" });
    }
  };
  // #583: the item menu's "Edit schedule…" is an inline `inlineTarget: "item"` session drawn by `SchedulingItemSchedulePicker`, the Gantt's host.
  // The draft and a dismissed conflict's notice (#585) are held here, above the vendor tree, and reset with the controller (`resetKey`).
  const handoffRef = useRef<HTMLElement | null>(null);
  const moreDayRef = useRef<string | null>(null);
  const itemEditor = commands.scheduleEditor?.inline && commands.scheduleEditor.inlineTarget === "item" ? commands.scheduleEditor : null;
  const itemKey = itemEditor?.source.id ?? null;
  const { retainedFor: retainedScheduleFor, clear: clearScheduleStash, dismiss: dismissScheduleEditor, stashErrorFor } = useScheduleConflictStash({ generationKey: resetKey, scheduleEditor: commands.scheduleEditor, cancelScheduleEditor: commands.cancelScheduleEditor });
  // The item left the drawn data (never judged while no baseline exists): a true discard, not a dismissal.
  const itemGone = itemKey !== null && source !== null && !dtoById.has(itemKey);
  useEffect(() => {
    if (!itemEditor || !itemGone) return;
    const id = subtaskIdFromCalendarEntityId(itemEditor.source.id);
    if (id) clearScheduleStash(id);
    commands.cancelScheduleEditor();
  }, [itemEditor, itemGone, clearScheduleStash, commands]);
  const lookupItem = (key: string): ScheduleItemSummary | null => {
    const dto = dtoById.get(key);
    if (!dto || dto.kind !== "checklist") return null;
    // A malformed entity id is a mapping defect the controller answers with "invalid" on Apply; the picker still shows so the session is never invisible.
    const id = subtaskIdFromCalendarEntityId(dto.id) ?? dto.id;
    return { id, title: dto.title, done: dto.status.completed, street: dto.project.street, schedule: dto.schedule, assignees: dto.assignees, otherAssigneeCount: dto.otherAssigneeCount, reminders: dto.reminders, projectDefault: projectDefaults.get(dto.project.id) ?? null };
  };
  /** The picker's anchor, best first: the live chip, the element the menu handed focus to, the originating day's "+N more", else the picker's last rect. */
  const findScheduleAnchor = (key: string): HTMLElement | null => {
    const live = findChip(key);
    if (live) return live;
    const handoff = handoffRef.current;
    if (handoff?.isConnected) return handoff;
    return findMoreFor(key, moreDayRef.current);
  };
  const findScheduleFocusTarget = (key: string): HTMLElement | null => findChip(key) ?? findMoreFor(key, moreDayRef.current) ?? document.querySelector<HTMLElement>('[data-focus-key="calendar-safe-fallback"]');
  const itemMenu = useSchedulingItemMenu({
    describe: describeItem,
    resolveElement: findChip,
    fallbackFor: findOverflowTrigger,
    onAction: runItemAction,
    followOnOpen: commands.moveDialog !== null || commands.scheduleEditor !== null,
    closeKey: `${resetKey}|${identity.principalId}|${identity.role}|${identity.authorizationEpoch}|${commands.accessLost}`,
  });
  const { isOpenFor } = itemMenu;
  const eventPopup = useMemo(() => ({ isOpen: (occurrence: { event: { id: string | number } }) => isOpenFor(String(occurrence.event.id)) }), [isOpenFor]);

  // ---------------------------------------------------------------------------------------------
  // #464: landing on a Project (Show in Calendar).
  // ---------------------------------------------------------------------------------------------

  // The drawn window covers the target date: the query key is the window, so a same-window Show in is served from cache with the old anchor `range.date`.
  const landingReady = everLoaded && !commands.accessLost && source !== null && !blocked && !settling && !query.isFetching && query.data !== undefined && query.data.range.start <= calendar.date && calendar.date <= query.data.range.end;
  const landingErrored = Boolean(query.error) && !query.data && !query.isFetching;
  useEffect(() => {
    const request = focusRequestRef.current;
    if (!request) return;
    const settle = (outcome: ProductionEventCalendarFocusOutcome) => {
      focusRequestRef.current = null;
      onFocusSettledRef.current?.(request.token, outcome);
    };
    if (landingErrored) { settle({ kind: "error" }); return; }
    if (!landingReady) return;
    const own = displayEvents.filter((event) => event.project.id === request.projectId);
    if (own.length === 0) { settle({ kind: "hidden" }); return; }
    const byStart = (a: CalendarEventDto, b: CalendarEventDto) => (a.timing.start < b.timing.start ? -1 : a.timing.start > b.timing.start ? 1 : a.id < b.id ? -1 : 1);
    const target = own.find((event) => event.kind === "project_deadline")
      ?? own.filter((event) => eventCivilDate(event) === calendar.date).sort(byStart)[0]
      ?? own.slice().sort(byStart)[0]!;
    setLandedProjectId(request.projectId);
    setSelectedId(target.id);
    // `focusVisible`: a landing that follows a pointer click still shows the focus ring (programmatic focus alone would not).
    // Same chip lookup as the scheduling controller's focus return: the vendor tags the chip CONTENT;
    // the focusable element is the `<button>` around it. A chip folded under "+N more" has no element,
    // so focus goes to that day's control instead.
    const lookup = () => {
      const content = [...document.querySelectorAll<HTMLElement>("[data-event-id]")].find((element) => element.getAttribute("data-event-id") === target.id);
      const chip = content ? (content.matches("button, [tabindex]") ? content : content.closest<HTMLElement>("button") ?? content) : null;
      const more = chip ? null : [...document.querySelectorAll<HTMLElement>("[data-more-event-ids]")].find((element) => (element.getAttribute("data-more-event-ids") ?? "").split(" ").includes(target.id))?.closest<HTMLElement>("button") ?? null;
      return { chip, element: chip ?? more ?? document.querySelector<HTMLElement>('[data-focus-key="calendar-safe-fallback"]') };
    };
    const folded = lookup().chip === null;
    focusLanding(() => lookup().element);
    settle({
      kind: "found",
      target: target.kind === "project_deadline" ? "deadline" : "task",
      label: target.kind === "project_deadline" ? "Deadline" : target.title,
      street: target.project.street,
      civilDate: eventCivilDate(target),
      folded,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-checked whenever the drawn data or the arming changes
  }, [focusTick, landingReady, landingErrored, displayEvents, calendar.date]);

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
  // #430: the Timeline's recovery, same rule: Stage = Delivered while delivered Projects are hidden draws nothing for a known reason.
  const showDeliveredRecovery = empty && onShowDeliveredProjects && ganttShowDeliveredRecovery({ ...calendar, delivered: calendar.showDeliveredProjects }) !== null;
  const showDeliveredButton = showDeliveredRecovery ? (
    <QuincyButton variant="text" type="button" data-testid="event-calendar-show-delivered" onClick={() => {
      onShowDeliveredProjects?.();
      // The button unmounts with the empty state, so focus goes to the Display trigger, as the Timeline's does.
      document.querySelector<HTMLElement>('[data-testid="dashboard-display-trigger"]')?.focus({ preventScroll: true });
    }}>
      Show delivered Projects
    </QuincyButton>
  ) : null;
  // The FullCalendar toolbar's "Sydney time · AEST/AEDT", for the window the server is asked for.
  const zoneLabel = useMemo(() => productionCalendarZoneLabel(deriveProductionCalendarWindow(calendar.date, calendar.subview)), [calendar.date, calendar.subview]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Production Calendar" tabIndex={-1} data-focus-key="calendar-safe-fallback" data-testid="event-calendar-screen" {...itemMenu.wrapperProps}>
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
          i18n={PRODUCTION_EVENT_CALENDAR_I18N}
          loading={!source}
          interactions={interactions}
          onEventUpdate={handleEventUpdate}
          onEventClick={(occurrence, e) => {
            // Opt out of the vendor's own selection: the chip opens the menu instead.
            e.preventDefault();
            itemMenu.openFromClick(e, String(occurrence.event.id));
          }}
          onEventContextMenu={(occurrence, e) => itemMenu.openFromContextMenu(e, String(occurrence.event.id))}
          eventPopup={eventPopup}
          onDateChange={(next) => { const civil = sydneyCivilDate(next); if (civil !== calendar.date) navigate({ date: civil }); }}
          onViewChange={(view) => { const subview = calendarViewToSubview(view); if (subview && subview !== calendar.subview) navigate({ subview }); }}
          onSlotClick={(slot) => { if (slot.view === "month") navigate({ subview: "day", date: sydneyCivilDate(slot.date) }); }}
          eventClassName={(occurrence) => productionEventCalendarEventClassName(occurrence.event.data, landedProjectId !== null && occurrence.event.data?.dto.project.id === landedProjectId)}
          renderMoreIndicator={({ day, count, segments }) => <span data-more-event-ids={segments.map((segment) => String(segment.occurrence.event.id)).join(" ")} data-more-day={sydneyCivilDate(day)}>{`+${count} more`}</span>}
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
                      {showDeliveredButton}
                    </div>
                    <div className="flex min-w-0 basis-full flex-wrap items-center gap-[var(--space-1)]" data-testid="event-calendar-controls">
                      {iconToggle ? (
                        <Button type="button" variant="outline" size="icon" className="min-h-[44px] min-w-[44px]" data-testid="event-calendar-rail-toggle" aria-label="Calendar" aria-expanded={railOpen} onClick={() => setRailOpen(true)}>
                          <CalendarIcon className="size-4" aria-hidden="true" />
                        </Button>
                      ) : (
                        <Button type="button" variant="outline" size="sm" className="min-h-[44px]" data-testid="event-calendar-rail-toggle" aria-expanded={railOpen} onClick={() => setRailOpen(true)}>
                          Calendar
                        </Button>
                      )}
                      <EventCalendarNavToday className="min-h-[44px]" />
                      <EventCalendarViewSwitcher className="min-h-[44px]" />
                      {/* One shrink-0 pair: a wrapped row never strands Next on its own line. */}
                      <div className="ml-auto flex shrink-0 items-center">
                        <EventCalendarNavPrev className="min-h-[44px] min-w-[44px]" />
                        <EventCalendarNavNext className="min-h-[44px] min-w-[44px]" />
                      </div>
                    </div>
                  </TooltipProvider>
                </EventCalendarNav>
              ) : (
              <div className="flex min-w-0 flex-wrap items-center gap-[var(--space-2)]">
                {narrow && (
                  <Button type="button" variant="outline" size="sm" className="ms-[var(--space-2)] max-[721px]:min-h-[44px]" data-testid="event-calendar-rail-toggle" aria-expanded={railOpen} onClick={() => setRailOpen(true)}>
                    Calendar
                  </Button>
                )}
                <EventCalendarNav showViewSwitcher className="min-w-0 flex-1" />
                <Eyebrow className="shrink-0 whitespace-nowrap last:me-[var(--space-2)] text-muted-foreground" data-testid="event-calendar-zone">{zoneLabel}</Eyebrow>
                {empty && !showDeliveredButton && (
                  // Quiet, in the toolbar row: an empty range never pushes the grid down.
                  <p className="m-0 me-[var(--space-2)] min-w-0 shrink truncate text-[length:var(--text-xs)] text-muted-foreground" role="status" data-testid="event-calendar-empty">No scheduled work in this range.</p>
                )}
                {showDeliveredButton && (
                  // #430: with the recovery action the message takes its own line under the toolbar; in the
                  // row, the button squeezed the nav until Today / view / arrows / title stacked.
                  <div className="flex min-w-0 basis-full flex-wrap items-center gap-x-[var(--space-2)] px-[var(--space-2)]" data-testid="event-calendar-empty-recovery">
                    <p className="m-0 min-w-0 text-[length:var(--text-xs)] text-muted-foreground" role="status" data-testid="event-calendar-empty">No scheduled work in this range.</p>
                    {showDeliveredButton}
                  </div>
                )}
              </div>
              )}
              <EventCalendarContent className="min-h-0 flex-1" />
            </div>
          </div>
          {narrow && (
            <Sheet open={railOpen} onOpenChange={setRailOpen}>
              <SheetContent
                side="left"
                showCloseButton={false}
                initialFocus={() => railCloseRef.current ?? true}
                className="z-[var(--z-dialog)] data-[side=left]:w-[320px] data-[side=left]:max-w-[90vw] gap-0 p-0"
                data-testid="event-calendar-rail-sheet"
                overlayProps={{
                  "data-testid": "event-calendar-rail-sheet-scrim",
                  // Every page sits inside RailedShell's Sheet Root, so this Sheet is nested and Base
                  // UI skips its Backdrop without `forceRender` — the schedule editor sheet's pattern.
                  forceRender: true,
                  className: "z-[var(--z-dialog)] bg-[var(--scrim-overlay)] backdrop-blur-[3px]",
                }}
              >
                <SheetHeader className={cn("border-b border-border max-[721px]:py-[var(--space-3)]", SHEET_CLOSE_CLEARANCE)} data-testid="event-calendar-rail-header">
                  {/* 44px touch target: the phone header is 12 + 44 + 12 around the close, and the title centres on it. */}
                  <SheetTitle className="max-[721px]:flex max-[721px]:min-h-[44px] max-[721px]:items-center">Calendar</SheetTitle>
                  <SheetDescription className="sr-only">Mini month and up next.</SheetDescription>
                </SheetHeader>
                {rail}
                <SheetCloseButton label="Close calendar" data-testid="event-calendar-rail-sheet-close" buttonRef={railCloseRef} />
              </SheetContent>
            </Sheet>
          )}
        </EventCalendar>
      )}

      <div className="sr-only" data-testid="dashboard-live-region" aria-live="polite" aria-atomic="true">{commands.announcement}</div>
      <SchedulingItemSchedulePicker editor={itemEditor} itemKey={itemKey} lookup={lookupItem} findAnchor={findScheduleAnchor} findFocusTarget={findScheduleFocusTarget} retainedFor={retainedScheduleFor} busy={!itemEditor && !live} onSubmit={commands.submitScheduleEditor} onCancel={commands.cancelScheduleEditor} onDismiss={dismissScheduleEditor} stashErrorFor={stashErrorFor} onClear={clearScheduleStash} />
      <ProductionEventCalendarDialogs commands={commands} deadlineConfirm={deadlineConfirm} scheduleEditorPresentation="inline" projectDefaultFor={(projectId) => projectDefaults.get(projectId) ?? null} />
      {itemMenu.menu}
    </section>
  );
}
