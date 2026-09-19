import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deriveProductionCalendarWindow,
  formatSydneyCivilMinute,
  STAGE_PRESENTATION_KEYS,
  CHECKLIST_SCHEDULE_RANGES_ENABLED,
  type CalendarEventDto,
  type CalendarManipulationTarget,
  type CalendarUnscheduledEntryDto,
  type ChecklistCalendarEventDto,
  type ChecklistCalendarUnscheduledEntryDto,
  type DashboardCalendarState,
  type ProjectDeadlineCalendarEventDto,
  type ProjectCalendarUnscheduledEntryDto,
  type ProductionCalendarFilters,
  type ProductionCalendarSubview,
} from "@quincy/shared";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import { ApiError } from "../lib/api";
import { productionCalendarFiltersFor, useProductionCalendarRange } from "../lib/production-calendar-query";
import { fullCalendarCallbackToSydneyCivil } from "../lib/production-calendar-fullcalendar";
import { checklistCurrentCivil, projectDeadlinePlaceholder, proposedCivilForAllDay } from "../lib/scheduling-policy";
import type { CalendarDropInfo, CalendarResizeInfo } from "../lib/scheduling-types";
import {
  applyOptimisticOverlay,
  type CalendarAcceptedSnapshot,
  type CalendarOptimisticOverlay,
  type CalendarSettleState,
} from "../lib/production-calendar-interaction";
import { mapCalendarEventsToFullCalendar } from "../lib/production-calendar-event-input";
import {
  useSchedulingCommands,
  type ChecklistSnapshot,
  type ChecklistFoldState,
  type MoveDialogState,
  type ScheduleEditorState,
} from "../lib/use-scheduling-commands";
import { ProductionCalendarSurface } from "./ProductionCalendarSurface";
import { ProductionCalendarToolbar } from "./ProductionCalendarToolbar";
import { ProductionCalendarEvent } from "./ProductionCalendarEvent";
import { ProductionCalendarFilters as ProductionCalendarFiltersPanel } from "./ProductionCalendarFilters";
import { ProductionCalendarMoveDialog } from "./ProductionCalendarMoveDialog";
import { ProductionCalendarFoldChoice } from "./ProductionCalendarFoldChoice";
import { ProductionCalendarScheduleEditor } from "./ProductionCalendarScheduleEditor";
import { ProductionCalendarUnscheduledPanel, unscheduledChecklistDraggable, unscheduledProjectDraggable } from "./ProductionCalendarUnscheduledPanel";
import { CALENDAR_STATE_BOX, COARSE_TAP_TARGET } from "./production-calendar-classes";
import { cn } from "@/lib/utils";
import { presentationStages, useStages } from "../lib/stages";
import { useCapabilities } from "../lib/capabilities";
import { useMediaQuery, usePrefersReducedMotion } from "../lib/use-media-query";
import { buttonClasses } from "./quincy/Button";

export type ProductionCalendarProps = {
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

// FullCalendar info shapes: the FC handlers below translate these into a SchedulingProposal
// and call the hook. `CalendarDropInfo`/`CalendarRevertable`/`CalendarResizeInfo` moved to
// `lib/scheduling-types.ts` (§216 fix round 5 item 2) since `use-scheduling-commands.tsx` types
// its own moved state (MoveDialogState.drop, ChecklistOperationInfo.drop/resize) against them,
// and a hook in `lib/` importing a type from a component contradicted the rule that file states.
export type CalendarExternalDropInfo = {
  date: Date;
  dateStr: string;
  allDay: boolean;
  draggedEl: HTMLElement;
};

export type CalendarExternalReceiveInfo = {
  event: { extendedProps?: { unscheduledId?: unknown; unscheduledKind?: unknown } };
  revert: () => void;
};

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const details = "details" in error ? (error as { details?: unknown }).details : undefined;
  if (!details || typeof details !== "object") return undefined;
  const code = "code" in details ? (details as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

function errorRefinement(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const details = "details" in error ? (error as { details?: unknown }).details : undefined;
  if (!details || typeof details !== "object") return undefined;
  const refinement = "refinement" in details ? (details as { refinement?: unknown }).refinement : undefined;
  return typeof refinement === "string" ? refinement : undefined;
}

function sameFilters(left: ProductionCalendarFilters, right: ProductionCalendarFilters): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function eventCivilDate(event: CalendarEventDto): string {
  return event.timing.allDay ? event.timing.start : formatSydneyCivilMinute(event.timing.start).slice(0, 10);
}

function viewForSubview(subview: ProductionCalendarSubview): "dayGridMonth" | "timeGridWeek" | "list" {
  if (subview === "month") return "dayGridMonth";
  if (subview === "week") return "timeGridWeek";
  return "list";
}

function canDragUnscheduledEntry(entry: CalendarUnscheduledEntryDto, rangesEnabled: boolean): boolean {
  return entry.kind === "project_deadline"
    ? unscheduledProjectDraggable(entry)
    : unscheduledChecklistDraggable(entry, rangesEnabled);
}

function durationNonZero(value: CalendarResizeInfo["startDelta"]): boolean {
  if (!value) return false;
  return (value.milliseconds ?? 0) !== 0 || (value.days ?? 0) !== 0 || (value.months ?? 0) !== 0;
}

/**
 * An identity token for a retained dialog's re-mount `key` (§6.0 retention). Bumps once per
 * null→non-null (`isOpen`) transition, using React's own documented "adjust state while
 * rendering" pattern — conditional `setState` calls made during render, not a ref mutated during
 * render (react.dev/reference/react/useState#storing-information-from-previous-renders).
 *
 * This matters specifically under React 19's concurrent rendering: React may start a render,
 * abandon it before it commits (an interruption, a discarded speculative render), and retry.
 * A ref mutated unconditionally during render carries that abandoned attempt's write forward —
 * the retry then sees an "already open" ref that was never actually committed, and can skip a
 * token bump it should make. `setState` calls made *during* render are a first-class operation
 * React itself owns: calling it re-runs the component synchronously with the updated state
 * *before* anything commits, so an abandoned render's state update can never leak into a later,
 * genuinely different render's decision the way a raw ref write can. It still updates the
 * SAME render's `key=` read (the whole reason the original `useEffect`-based version was wrong,
 * per round 1) — React re-invokes the function body immediately, not on a later tick.
 */
function useOpenToken(isOpen: boolean): number {
  const [token, setToken] = useState(0);
  const [wasOpen, setWasOpen] = useState(false);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setToken((current) => current + 1);
  }
  return token;
}

export function ProductionCalendar({ identity, calendar, onNavigate, onAppliedFilters, onAcceptGateChange, onSettleStateChange, onAccessLoss, projectHrefFor, onOpenProject }: ProductionCalendarProps) {
  const range = useMemo(() => deriveProductionCalendarWindow(calendar.date, calendar.subview), [calendar.date, calendar.subview]);
  const query = useProductionCalendarRange({ identity, calendar, enabled: true });
  const { stages } = useStages();
  const { can } = useCapabilities();
  const prefersReducedMotion = usePrefersReducedMotion();
  const coarsePointer = useMediaQuery("(pointer: coarse)");
  const phoneViewport = useMediaQuery("(max-width: 720px)");
  const actionOnlyWeek = coarsePointer && phoneViewport && calendar.subview === "week";
  const canAdminBackend = can("adminBackend");
  const stageOptions = useMemo(() => {
    const presented = presentationStages(stages, canAdminBackend);
    return STAGE_PRESENTATION_KEYS.flatMap((key) => {
      const stage = presented.find((candidate) => candidate.key === key)
        ?? (key === "editing" && canAdminBackend ? presented.find((candidate) => candidate.key === "editing_autohdr") : undefined);
      return stage && stage.active ? [{ key, label: stage.label }] : [];
    });
  }, [canAdminBackend, stages]);

  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const calendarResetKey = `${calendar.date}|${calendar.subview}|${calendar.layers.join(",")}|${calendar.editorIds.join(",")}|${calendar.includeUnassigned}|${calendar.stageKeys.join(",")}|${calendar.showCompletedChecklist}|${calendar.showDeliveredProjects}|${calendar.overdueOnly}|${calendar.search}|${calendar.myTasks}`;

  const commands = useSchedulingCommands({ identity, calendar, resetKey: calendarResetKey, query, onAcceptGateChange, onSettleStateChange, onAccessLoss });
  const {
    acceptedResponse,
    interactionBlocked: calendarInteractionBlocked,
    optimisticOverlay,
    settle: calendarSettle,
    announcement,
    accessLost: calendarAccessLost,
    checklistNeedsAttention,
    deadlineMovementDisabled,
    checklistRangeSchedulingDisabled,
    moveDialog,
    scheduleEditor,
    checklistFold,
    submitDeadlineProposal,
    submitChecklistProposal: mapChecklistCommand,
    openMoveDialog,
    openUnscheduledProjectDialog,
    openChecklistScheduleEditor,
    openUnscheduledChecklistScheduleEditor,
    submitMoveDialog: handleMoveDialogSubmit,
    cancelMoveDialog: handleMoveDialogCancel,
    submitScheduleEditor: handleScheduleEditorSubmit,
    cancelScheduleEditor: handleScheduleEditorCancel,
    submitChecklistFold: handleChecklistFoldSubmit,
    cancelChecklistFold: handleChecklistFoldCancel,
    acceptForInteraction,
    canStartCommand,
    findUnscheduledEntry,
    refreshRecovery,
    clearSettleOnNavigation,
    announceLifecycle,
    announceChecklistLifecycle,
    focusDescriptor,
  } = commands;

  // §216 step 4 / coordinator split: `selectedDay` is month-view presentation state, so it stays
  // here rather than moving into the hook. Same trigger set as the hook's own reset effect, minus
  // the stable setters — React batches state updates from effects in the same commit, so the
  // rendered result matches the pre-split single-effect version.
  useEffect(() => { setSelectedDay(null); }, [calendarResetKey, identity.principalId, identity.role, identity.authorizationEpoch]);
  useEffect(() => { if (!query.data) setSelectedDay(null); }, [query.data]);

  // §6.0 retention: each of `Modal`'s three Calendar consumers now renders unconditionally (its
  // own `open` prop, not a mount guard) so it can animate closed. The parent must therefore keep
  // supplying the dialog's props for the 120ms the exit transition holds it mounted — retain the
  // whole state object (not just one field of it), and read the retained value in both the props
  // and the `key`, never the live (possibly-null) state.
  const moveDialogRetained = useRef<MoveDialogState | null>(null);
  if (moveDialog) moveDialogRetained.current = moveDialog;
  // Re-mount key: an open-token (`useOpenToken`, above), not a data value. Bumped once per
  // null→non-null transition only, so a fold retry on the *same* open dialog (which sets a new
  // `initialCivil`/`foldChoices` without closing) does not remount and re-seed it — matching
  // today's no-remount behavior — while a fresh open (or a reopen after close) does.
  const moveDialogToken = useOpenToken(moveDialog !== null);
  const scheduleEditorRetained = useRef<ScheduleEditorState | null>(null);
  if (scheduleEditor) scheduleEditorRetained.current = scheduleEditor;
  // Same open-token as `moveDialogToken` — this one composes with the retained composite key
  // below rather than standing alone as the whole `key`; see that call site's comment.
  const scheduleEditorToken = useOpenToken(scheduleEditor !== null);
  const checklistFoldRetained = useRef<ChecklistFoldState | null>(null);
  if (checklistFold) checklistFoldRetained.current = checklistFold;
  const checklistFoldToken = useOpenToken(checklistFold !== null);

  useEffect(() => {
    const applied = query.data?.range.appliedFilters;
    if (!applied || sameFilters(applied, productionCalendarFiltersFor(calendar))) return;
    onAppliedFilters?.(applied);
  }, [calendar, onAppliedFilters, query.data?.range.appliedFilters]);

  const sourceEvents = acceptedResponse?.events ?? (!calendarInteractionBlocked ? query.data?.events ?? [] : []);
  const rangesEnabled = CHECKLIST_SCHEDULE_RANGES_ENABLED && !checklistRangeSchedulingDisabled;
  const renderEvents = useMemo<CalendarEventDto[]>(() => sourceEvents.map((event): CalendarEventDto => {
    if (event.kind === "checklist") {
      const attention = checklistNeedsAttention.has(event.id);
      const interactionAllowed = calendar.subview !== "agenda" && !calendarInteractionBlocked && !calendarSettle.pending && !attention;
      const rangeAllowed = event.schedule.state !== "range" || (rangesEnabled && event.permissions.canScheduleRange);
      const canDrag = event.permissions.canDrag && interactionAllowed && rangeAllowed;
      const canResize = event.permissions.canResize && interactionAllowed && rangesEnabled && event.permissions.canScheduleRange;
      const canOpenScheduleEditor = event.permissions.canOpenScheduleEditor && !calendarInteractionBlocked && !calendarSettle.pending && !attention;
      if (canDrag === event.permissions.canDrag && canResize === event.permissions.canResize && canOpenScheduleEditor === event.permissions.canOpenScheduleEditor) return event;
      return { ...event, permissions: { ...event.permissions, canDrag, canResize, canOpenScheduleEditor } } as CalendarEventDto;
    }
    const canDrag = identity.role === "admin"
      && event.permissions.canDrag
      && !deadlineMovementDisabled
      && !calendarInteractionBlocked
      && !calendarSettle.pending;
    return canDrag === event.permissions.canDrag ? event : { ...event, permissions: { ...event.permissions, canDrag } } as CalendarEventDto;
  }), [calendar.subview, calendarInteractionBlocked, calendarSettle.pending, checklistNeedsAttention, deadlineMovementDisabled, identity.role, rangesEnabled, sourceEvents]);
  const displayEvents = useMemo(() => applyOptimisticOverlay(renderEvents, optimisticOverlay), [optimisticOverlay, renderEvents]);
  const mappedEvents = useMemo(() => mapCalendarEventsToFullCalendar(displayEvents, { actionOnly: actionOnlyWeek }), [actionOnlyWeek, displayEvents]);
  const sourceUnscheduled = acceptedResponse?.unscheduled ?? (!calendarInteractionBlocked ? query.data?.unscheduled ?? [] : []);
  const renderUnscheduled = useMemo(() => optimisticOverlay && "kind" in optimisticOverlay && optimisticOverlay.kind === "reschedule-unscheduled"
    ? sourceUnscheduled.filter((entry) => entry.id !== optimisticOverlay.entryId)
    : sourceUnscheduled, [optimisticOverlay, sourceUnscheduled]);
  const unscheduledFacets = useMemo(() => {
    const facets = acceptedResponse?.filterFacets.unscheduled ?? {
      project: { matched: 0, returned: 0, truncated: false },
      checklist: { matched: 0, returned: 0, truncated: false },
    };
    if (!optimisticOverlay || !("kind" in optimisticOverlay) || optimisticOverlay.kind !== "reschedule-unscheduled") return facets;
    const sourceEntry = sourceUnscheduled.find((entry) => entry.id === optimisticOverlay.entryId);
    // Checklist mutation adoption can remove the source entry before the
    // authoritative settle refetch completes; the optimistic event preserves
    // its section in that short window.
    const facetKey = (sourceEntry?.kind ?? optimisticOverlay.asEvent.kind) === "project_deadline" ? "project" : "checklist";
    const facet = facets[facetKey];
    return {
      ...facets,
      [facetKey]: {
        matched: Math.max(0, facet.matched - 1),
        returned: Math.max(0, facet.returned - 1),
        truncated: facet.truncated,
      },
    };
  }, [optimisticOverlay, sourceUnscheduled, acceptedResponse]);
  const projectUnscheduledEntries = useMemo(() => renderUnscheduled.filter((entry): entry is ProjectCalendarUnscheduledEntryDto => entry.kind === "project_deadline"), [renderUnscheduled]);
  const checklistUnscheduledEntries = useMemo(() => renderUnscheduled.filter((entry): entry is ChecklistCalendarUnscheduledEntryDto => entry.kind === "checklist"), [renderUnscheduled]);
  const panelHasDraggableEntry = renderUnscheduled.some((entry) => canDragUnscheduledEntry(entry, rangesEnabled));
  const selectedEvents = selectedDay === null ? [] : displayEvents.filter((event) => eventCivilDate(event) === selectedDay);
  const dense = errorCode(query.error) === "calendar_range_too_dense";
  const refinement = errorRefinement(query.error) ?? "Refine the date range, Stage, Editor, layer, or search filters.";

  const handleDeadlineDrop = useCallback((info: CalendarDropInfo) => {
    if (actionOnlyWeek) { info.revert(); return; }
    if (calendar.subview === "agenda") { info.revert(); return; }
    const dto = info.event.extendedProps.dto;
    if (!dto || typeof dto !== "object" || (dto as { kind?: unknown }).kind !== "project_deadline") { info.revert(); return; }
    const event = dto as ProjectDeadlineCalendarEventDto;
    if (!event.permissions.canDrag || identity.role !== "admin" || deadlineMovementDisabled || !canStartCommand()) { info.revert(); return; }
    let civil;
    try {
      civil = fullCalendarCallbackToSydneyCivil({ allDay: info.event.allDay, date: info.event.start!, dateStr: info.event.startStr });
    } catch {
      info.revert();
      announceLifecycle("invalid", { entity: "deadline" });
      return;
    }
    const localCivil = civil.allDay ? proposedCivilForAllDay(event, civil.date) : civil.localCivil;
    const subview = calendar.subview === "month" ? "month" : "week";
    const snapshot = acceptForInteraction(event, { eventId: event.id, control: "event" });
    if (!snapshot) { info.revert(); return; }
    announceLifecycle("picked-up", { entity: "deadline", street: event.project.street, oldCivil: event.deadlineLocalCivil });
    submitDeadlineProposal({ kind: "drop", snapshot, event, localCivil, subview, drop: info });
  }, [acceptForInteraction, actionOnlyWeek, announceLifecycle, calendar.subview, canStartCommand, deadlineMovementDisabled, identity.role, submitDeadlineProposal]);

  const handleChecklistDrop = useCallback((info: CalendarDropInfo) => {
    if (actionOnlyWeek) { info.revert(); return; }
    const dto = info.event.extendedProps.dto;
    if (!dto || typeof dto !== "object" || (dto as { kind?: unknown }).kind !== "checklist") { info.revert(); return; }
    const event = dto as ChecklistCalendarEventDto;
    if (!event.permissions.canDrag || (event.schedule.state === "range" && (!rangesEnabled || !event.permissions.canScheduleRange)) || calendar.subview === "agenda" || !canStartCommand()) { info.revert(); return; }
    let civil;
    try {
      civil = fullCalendarCallbackToSydneyCivil({ allDay: info.event.allDay, date: info.event.start!, dateStr: info.event.startStr });
    } catch {
      info.revert();
      announceChecklistLifecycle("invalid", {});
      focusDescriptor({ eventId: event.id, control: "event" });
      return;
    }
    const subview = calendar.subview === "month" ? "month" : "week";
    let target: CalendarManipulationTarget;
    const targetDate = civil.allDay ? civil.date : civil.localCivil.slice(0, 10);
    if (subview === "month") {
      target = { subview, targetDate, ...(event.schedule.state === "range" ? { end: info.event.endStr, exclusiveEnd: info.event.endStr } : {}) };
    } else {
      if (civil.allDay) { info.revert(); announceChecklistLifecycle("invalid", {}); focusDescriptor({ eventId: event.id, control: "event" }); return; }
      target = { subview, targetDate, targetCivilMinute: civil.localCivil };
    }
    const snapshot = acceptForInteraction(event, { eventId: event.id, control: "event" });
    if (!snapshot) { info.revert(); return; }
    announceChecklistLifecycle("picked-up", { street: event.project.street, oldCivil: checklistCurrentCivil(event), overlap: event.status.sameAssigneeOverlap === true, assignee: event.assignee?.name });
    mapChecklistCommand(snapshot, event, target, { drop: info });
  }, [acceptForInteraction, actionOnlyWeek, announceChecklistLifecycle, calendar.subview, canStartCommand, focusDescriptor, mapChecklistCommand, rangesEnabled]);

  const handleChecklistResize = useCallback((info: CalendarResizeInfo) => {
    if (actionOnlyWeek) { info.revert(); return; }
    const dto = info.event.extendedProps.dto;
    if (!dto || typeof dto !== "object" || (dto as { kind?: unknown }).kind !== "checklist") { info.revert(); return; }
    const event = dto as ChecklistCalendarEventDto;
    if (event.schedule.state !== "range" || !event.permissions.canResize || !event.permissions.canScheduleRange || !rangesEnabled || calendar.subview === "agenda" || !canStartCommand()) { info.revert(); return; }
    const startMoved = durationNonZero(info.startDelta)
      || (info.event.allDay ? info.event.startStr !== event.timing.start : Boolean(info.event.start && event.timing.start && info.event.start.getTime() !== new Date(event.timing.start).getTime()));
    if (startMoved) { info.revert(); return; }
    const subview = calendar.subview === "month" ? "month" : "week";
    let target: CalendarManipulationTarget;
    try {
      if (subview === "month") {
        if (!info.event.endStr) { info.revert(); return; }
        // FullCalendar's all-day end is exclusive. The shared mapper performs
        // the single-day reduction to TB4D's inclusive end.
        target = { subview, targetDate: event.timing.start, end: info.event.endStr, exclusiveEnd: info.event.endStr, edge: "end" };
      } else {
        const civil = fullCalendarCallbackToSydneyCivil({ allDay: false, date: info.event.end!, dateStr: info.event.endStr });
        if (civil.allDay) { info.revert(); return; }
        target = { subview, targetDate: civil.localCivil.slice(0, 10), targetCivilMinute: civil.localCivil, edge: "end" };
      }
    } catch {
      info.revert();
      announceChecklistLifecycle("invalid", {});
      focusDescriptor({ eventId: event.id, control: "event" });
      return;
    }
    const snapshot = acceptForInteraction(event, { eventId: event.id, control: "event" });
    if (!snapshot) { info.revert(); return; }
    announceChecklistLifecycle("picked-up", { street: event.project.street, oldCivil: checklistCurrentCivil(event), overlap: event.status.sameAssigneeOverlap === true, assignee: event.assignee?.name });
    mapChecklistCommand(snapshot, event, target, { resize: info }, undefined, "end");
  }, [acceptForInteraction, actionOnlyWeek, announceChecklistLifecycle, calendar.subview, canStartCommand, focusDescriptor, mapChecklistCommand, rangesEnabled]);

  const handleUnscheduledDrop = useCallback((info: CalendarExternalDropInfo) => {
    if (calendar.subview === "agenda" || actionOnlyWeek || calendarInteractionBlocked || !canStartCommand()) {
      return;
    }
    const unscheduledId = info.draggedEl.dataset.unscheduledId;
    const unscheduledKind = info.draggedEl.dataset.unscheduledKind;
    const entry = findUnscheduledEntry(unscheduledId, unscheduledKind);
    if (!entry || !canDragUnscheduledEntry(entry, rangesEnabled)) {
      return;
    }

    let civil;
    try {
      civil = fullCalendarCallbackToSydneyCivil({ allDay: info.allDay, date: info.date, dateStr: info.dateStr });
    } catch {
      announceLifecycle("invalid", { entity: entry.kind === "checklist" ? "checklist" : "deadline" });
      return;
    }
    const subview = calendar.subview === "month" ? "month" : "week";
    const targetDate = civil.allDay ? civil.date : civil.localCivil.slice(0, 10);
    let target: CalendarManipulationTarget;
    if (subview === "month") {
      target = { subview, targetDate };
    } else {
      if (civil.allDay) {
        announceLifecycle("invalid", { entity: entry.kind === "checklist" ? "checklist" : "deadline" });
        return;
      }
      target = { subview, targetDate, targetCivilMinute: civil.localCivil };
    }

    const snapshot = acceptForInteraction(entry, { eventId: entry.id, control: "event" });
    if (!snapshot) {
      return;
    }
    if (entry.kind === "project_deadline") {
      const event = projectDeadlinePlaceholder(entry);
      const deadlineSnapshot = { ...snapshot, event } as CalendarAcceptedSnapshot<ProjectDeadlineCalendarEventDto>;
      const localCivil = subview === "month" ? `${targetDate}T17:00` : target.targetCivilMinute!;
      announceLifecycle("picked-up", { entity: "deadline", street: entry.project.street, oldCivil: "Not scheduled" });
      submitDeadlineProposal({ kind: "place", snapshot: deadlineSnapshot, entry, event, localCivil, target });
      return;
    }
    mapChecklistCommand(snapshot as ChecklistSnapshot, entry, target, { external: true });
  }, [acceptForInteraction, actionOnlyWeek, announceChecklistLifecycle, announceLifecycle, calendar.subview, calendarInteractionBlocked, canStartCommand, findUnscheduledEntry, mapChecklistCommand, rangesEnabled, submitDeadlineProposal]);

  const handleUnscheduledReceive = useCallback((info: CalendarExternalReceiveInfo) => {
    info.revert();
  }, []);

  const handleCalendarDrop = useCallback((info: CalendarDropInfo) => {
    const dto = info.event.extendedProps.dto;
    if (dto && typeof dto === "object" && (dto as { kind?: unknown }).kind === "checklist") handleChecklistDrop(info);
    else handleDeadlineDrop(info);
  }, [handleChecklistDrop, handleDeadlineDrop]);

  return (
    <section className="qc-calendar-screen min-w-0" aria-label="Production Calendar" tabIndex={-1} data-focus-key="calendar-safe-fallback" data-reduced-motion={prefersReducedMotion ? "true" : undefined}>
      <ProductionCalendarToolbar calendar={calendar} range={range} onNavigate={(next) => { if (!calendarInteractionBlocked) { clearSettleOnNavigation(); onNavigate(next); } }} />
      <ProductionCalendarFiltersPanel
        filters={productionCalendarFiltersFor(calendar)}
        facetPeople={query.data?.filterFacets.people ?? []}
        stages={stageOptions}
        disabled={calendarInteractionBlocked || (query.isPending && !query.data)}
        onChange={(next) => { if (!calendarInteractionBlocked) { clearSettleOnNavigation(); onNavigate({ ...calendar, ...next, view: "calendar" }); } }}
      />

      {calendarSettle.recoveryReason && <div className="notice flex items-center justify-between gap-[16px] mb-[16px]" data-testid="calendar-recovery-notice" role="alert"><span>{calendarSettle.recoveryReason}</span><button className={buttonClasses("secondary", { className: COARSE_TAP_TARGET })} type="button" data-focus-key="calendar-recovery" onClick={() => void refreshRecovery()}>Refresh</button></div>}
      {query.isPending && !query.data && <div className={cn("empty", CALENDAR_STATE_BOX)} role="status">Loading calendar…</div>}

      {!query.isPending && query.error && !query.data && (
        <div className={cn("empty", CALENDAR_STATE_BOX)} role="alert">
          <span className="serif">Calendar unavailable.</span>
          {dense ? <><p>That range is too dense — narrow the filters.</p><p>{refinement}</p></> : <p>Calendar could not be loaded. Try again.</p>}
          {!dense && <div style={{ marginTop: 16 }}><button className={buttonClasses("secondary")} type="button" onClick={() => void query.refetch()}>Try again</button></div>}
        </div>
      )}

      {acceptedResponse && !calendarAccessLost && <div className="grid grid-cols-[minmax(0,1fr)_minmax(250px,320px)] items-start gap-[20px] max-[721px]:grid-cols-1">
        <div className="min-w-0">
          {acceptedResponse.events.length === 0 && <div className={cn("empty", CALENDAR_STATE_BOX)} role="status">No scheduled work in this range.</div>}
          <ProductionCalendarSurface
            key={`${calendar.subview}:${calendar.date}`}
            initialView={viewForSubview(calendar.subview)}
            initialDate={calendar.date}
            visibleRange={range}
            headerToolbar={false}
            events={mappedEvents}
            editable={!actionOnlyWeek && mappedEvents.some((event) => event.editable === true)}
            eventStartEditable={!actionOnlyWeek}
            eventDurationEditable={!actionOnlyWeek}
            eventResizableFromStart={false}
            dragScroll={!actionOnlyWeek}
            droppable={!actionOnlyWeek && panelHasDraggableEntry && calendar.subview !== "agenda" && !calendarInteractionBlocked && !calendarSettle.pending}
            selectable={false}
            reducedMotion={prefersReducedMotion}
            weekends
            firstDay={1}
            slotMinTime="00:00:00"
            slotMaxTime="24:00:00"
            expandRows={calendar.subview === "week"}
            views={{ list: { type: "list", duration: { days: 14 } } }}
            eventDrop={(info) => handleCalendarDrop(info as unknown as CalendarDropInfo)}
            eventResize={(info) => handleChecklistResize(info as unknown as CalendarResizeInfo)}
            drop={(info) => handleUnscheduledDrop(info as unknown as CalendarExternalDropInfo)}
            eventReceive={(info) => handleUnscheduledReceive(info as unknown as CalendarExternalReceiveInfo)}
            dateClick={(info) => {
              if (calendar.subview === "month" && info.allDay) setSelectedDay(info.dateStr);
            }}
            eventContent={(info) => {
              const dto = info.event.extendedProps.dto;
              return dto ? <ProductionCalendarEvent event={dto} subview={calendar.subview} needsAttention={checklistNeedsAttention.has(dto.id)} projectHref={projectHrefFor?.(dto.project.id)} onOpenProject={() => onOpenProject?.(dto.project.id)} onMoveReschedule={calendarSettle.pending || calendarInteractionBlocked ? undefined : openMoveDialog} onChecklistSchedule={calendarSettle.pending || calendarInteractionBlocked ? undefined : openChecklistScheduleEditor} /> : null;
            }}
          />

          {calendar.subview === "month" && selectedDay !== null && (
            <section className="mt-[18px] p-[16px] border border-solid border-border bg-card" aria-label="Selected day">
              <div className="ey">Selected day · {selectedDay}</div>
              {selectedEvents.length === 0 ? <p className="muted">No scheduled work on this day.</p> : <div className="grid gap-[8px] mt-[12px]">{selectedEvents.map((event) => <ProductionCalendarEvent key={event.id} event={event} subview={calendar.subview} compact needsAttention={checklistNeedsAttention.has(event.id)} projectHref={projectHrefFor?.(event.project.id)} onOpenProject={() => onOpenProject?.(event.project.id)} onMoveReschedule={calendarSettle.pending || calendarInteractionBlocked ? undefined : openMoveDialog} />)}</div>}
            </section>
          )}
        </div>
        <ProductionCalendarUnscheduledPanel
          projectEntries={projectUnscheduledEntries}
          checklistEntries={checklistUnscheduledEntries}
          facets={unscheduledFacets}
          subview={calendar.subview}
          rangesEnabled={rangesEnabled}
          onScheduleProject={(entry) => { if (canDragUnscheduledEntry(entry, rangesEnabled)) openUnscheduledProjectDialog(entry); }}
          onScheduleChecklist={openUnscheduledChecklistScheduleEditor}
          disabled={calendarInteractionBlocked || calendarSettle.pending}
          dragSuppressed={actionOnlyWeek}
          projectHrefFor={projectHrefFor}
          onOpenProject={onOpenProject}
        />
      </div>}
      <div className="sr-only" data-testid="dashboard-live-region" aria-live="polite" aria-atomic="true">{announcement}</div>
      {moveDialogRetained.current && <ProductionCalendarMoveDialog key={moveDialogToken} open={!!moveDialog} event={moveDialogRetained.current.event} initialCivil={moveDialogRetained.current.initialCivil} foldChoices={moveDialogRetained.current.foldChoices} onSubmit={handleMoveDialogSubmit} onCancel={handleMoveDialogCancel} />}
      {/* The key composes the open-token with the composite (source id + initialSchedule) parts
          the original design required verbatim — the two parts cover two different remount
          triggers that must both work: the token changes on a null→non-null transition (reopen
          after close, which must reseed the form fresh — round-2's bug: this dialog had no token
          at all, so reopening the same item preserved the prior instance's stale draft/error
          state); the composite JSON changes when a validation retry sets a new `initialSchedule`
          on the *same still-open* session (`scheduleEditor` never passes through null, so the
          token does not bump — matching the original no-close-looking-remount requirement — but
          the JSON half still changes and forces the remount that re-seeds from the new
          `initialSchedule`, which is the whole point of that key surviving unchanged). */}
      {scheduleEditorRetained.current && <ProductionCalendarScheduleEditor key={`${scheduleEditorToken}:${scheduleEditorRetained.current.source.id}:${JSON.stringify(scheduleEditorRetained.current.initialSchedule ?? null)}`} open={!!scheduleEditor} event={scheduleEditorRetained.current.source} rangesEnabled={rangesEnabled && scheduleEditorRetained.current.source.permissions.canScheduleRange} initialSchedule={scheduleEditorRetained.current.initialSchedule} validationError={scheduleEditorRetained.current.validationError} onSubmit={handleScheduleEditorSubmit} onCancel={handleScheduleEditorCancel} />}
      {checklistFoldRetained.current && <ProductionCalendarFoldChoice key={checklistFoldToken} open={!!checklistFold} endpoint={checklistFoldRetained.current.endpoint} choices={checklistFoldRetained.current.choices} eyebrow={checklistFoldRetained.current.proposal.source.project.street} onSubmit={handleChecklistFoldSubmit} onCancel={handleChecklistFoldCancel} />}
    </section>
  );
}
