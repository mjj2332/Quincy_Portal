import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deriveProductionCalendarWindow,
  formatSydneyCivilMinute,
  mapProjectDeadlineMoveToCommand,
  previewProjectDeadlineReminderConsequences,
  resolveSydneyCivilMinute,
  STAGE_PRESENTATION_KEYS,
  type CalendarEventDto,
  type CalendarEventTiming,
  type CalendarManipulationTarget,
  type DashboardCalendarState,
  type ProjectDeadlineCalendarEventDto,
  type ProjectDeadlineDisambiguation,
  type ProductionCalendarFilters,
  type ProductionCalendarRangeResponse,
  type ProductionCalendarSubview,
  type SaveProjectDeadlineRequest,
} from "@quincy/shared";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import { ApiError, apiPut } from "../lib/api";
import { confirm, confirmStore } from "../lib/confirm";
import { invalidateProjectResources, useOptionalProjectQueryClient } from "../lib/project-data";
import { createProductionCalendarInvalidatedMessage, getProjectQueryRuntime } from "../lib/project-query-sync";
import { productionCalendarFiltersFor, removeProductionCalendarQueries, useProductionCalendarRange } from "../lib/production-calendar-query";
import { fullCalendarCallbackToSydneyCivil } from "../lib/production-calendar-fullcalendar";
import {
  applyOptimisticOverlay,
  beginCalendarInteraction,
  canStartCalendarCommand,
  calendarAnnouncement,
  classifyDeadlineFailure,
  transitionCalendarSettle,
  type CalendarAcceptedSnapshot,
  type CalendarCommandLock,
  type CalendarFocusDescriptor,
  type CalendarOptimisticOverlay,
  type CalendarSettleEvent,
  type CalendarSettleState,
} from "../lib/production-calendar-interaction";
import { mapCalendarEventsToFullCalendar } from "../lib/production-calendar-event-input";
import { ProductionCalendarSurface } from "./ProductionCalendarSurface";
import { ProductionCalendarToolbar } from "./ProductionCalendarToolbar";
import { ProductionCalendarEvent } from "./ProductionCalendarEvent";
import { ProductionCalendarFilters as ProductionCalendarFiltersPanel } from "./ProductionCalendarFilters";
import { ProductionCalendarMoveConfirmation } from "./ProductionCalendarMoveConfirmation";
import { ProductionCalendarMoveDialog } from "./ProductionCalendarMoveDialog";
import { presentationStages, useStages } from "../lib/stages";
import { useCapabilities } from "../lib/capabilities";

export type ProductionCalendarProps = {
  identity: DashboardIdentity;
  calendar: DashboardCalendarState;
  onNavigate: (next: DashboardCalendarState) => void;
  onAppliedFilters?: (filters: ProductionCalendarFilters) => void;
  onAcceptGateChange?: (blocked: boolean) => void;
  onSettleStateChange?: (state: CalendarSettleState) => void;
  onAccessLoss?: () => void;
};

type CalendarDropInfo = {
  event: { allDay: boolean; start: Date | null; startStr: string; extendedProps: { dto?: unknown } };
  revert: () => void;
};

type MoveDialogState = {
  event: ProjectDeadlineCalendarEventDto;
  snapshot: CalendarAcceptedSnapshot;
  initialCivil: string;
  foldChoices?: Array<{ disambiguation: ProjectDeadlineDisambiguation; utcOffsetMinutes: number }>;
  drop?: CalendarDropInfo;
  subview?: "month" | "week";
};

type SaveResponse = {
  changed: boolean;
  current: {
    version: number;
    deadline: null | { localCivil: string; instant: string };
    reminderOffsetsMinutes: number[];
  };
  eventIntent: unknown;
  publicationIds: string[];
};

type DeadlineProposal = {
  snapshot: CalendarAcceptedSnapshot;
  event: ProjectDeadlineCalendarEventDto;
  localCivil: string;
  disambiguation?: ProjectDeadlineDisambiguation;
  request: SaveProjectDeadlineRequest;
  timing: CalendarEventTiming;
  drop?: CalendarDropInfo;
};

type DeadlineFoldChoice = { disambiguation: ProjectDeadlineDisambiguation; utcOffsetMinutes: number };

type DeadlineProposalResult =
  | { ok: true; proposal: DeadlineProposal }
  | { ok: false; reason: "fold"; choices: DeadlineFoldChoice[] }
  | { ok: false; reason: "gap" }
  | { ok: false; reason: "invalid" };

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

function cloneDeadline(event: ProjectDeadlineCalendarEventDto): ProjectDeadlineCalendarEventDto {
  return {
    ...event,
    project: { ...event.project, checklist: { ...event.project.checklist } },
    timing: { ...event.timing },
    status: { ...event.status },
    permissions: { ...event.permissions },
    reminderOffsetsMinutes: [...event.reminderOffsetsMinutes],
  };
}

function cloneFilters(filters: ProductionCalendarFilters): ProductionCalendarFilters {
  return { ...filters, layers: [...filters.layers], editorIds: [...filters.editorIds], stageKeys: [...filters.stageKeys] };
}

function cloneResponse(response: ProductionCalendarRangeResponse): ProductionCalendarRangeResponse {
  return {
    ...response,
    range: { ...response.range, appliedFilters: cloneFilters(response.range.appliedFilters) },
    events: response.events.map((event) => event.kind === "project_deadline" ? cloneDeadline(event) : event),
  };
}

function responseEvent(response: ProductionCalendarRangeResponse | null, eventId: string): ProjectDeadlineCalendarEventDto | undefined {
  const event = response?.events.find((candidate) => candidate.id === eventId);
  return event?.kind === "project_deadline" ? event : undefined;
}

function currentMatchesSource(event: ProjectDeadlineCalendarEventDto, current: SaveResponse["current"]): boolean {
  return current.version === event.deadlineVersion
    && current.deadline?.localCivil === event.deadlineLocalCivil
    // Project Deadlines are stored as timed instants; an all-day DTO is only a
    // defensive presentation shape, never a reason to skip the instant check.
    && current.deadline?.instant === event.timing.start
    && JSON.stringify(current.reminderOffsetsMinutes) === JSON.stringify(event.reminderOffsetsMinutes);
}

function canonicalEventFromSchedule(event: ProjectDeadlineCalendarEventDto, current: SaveResponse["current"]): ProjectDeadlineCalendarEventDto {
  const nextDeadline = current.deadline;
  return {
    ...cloneDeadline(event),
    deadlineLocalCivil: nextDeadline?.localCivil ?? event.deadlineLocalCivil,
    deadlineVersion: current.version,
    reminderOffsetsMinutes: [...current.reminderOffsetsMinutes],
    timing: nextDeadline ? { allDay: false, start: nextDeadline.instant, end: null } : event.timing,
  };
}

function proposedCivilForAllDay(source: ProjectDeadlineCalendarEventDto, date: string): string {
  return `${date}T${source.deadlineLocalCivil.slice(11, 16)}`;
}

function choicesFromError(error: unknown): Array<{ disambiguation: ProjectDeadlineDisambiguation; utcOffsetMinutes: number }> {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== "object") return [];
  const choices = (error.details as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return [];
  return choices.filter((choice): choice is { disambiguation: ProjectDeadlineDisambiguation; utcOffsetMinutes: number } => {
    if (!choice || typeof choice !== "object") return false;
    const value = choice as Record<string, unknown>;
    return (value.disambiguation === "earlier" || value.disambiguation === "later") && typeof value.utcOffsetMinutes === "number";
  });
}

export function ProductionCalendar({ identity, calendar, onNavigate, onAppliedFilters, onAcceptGateChange, onSettleStateChange, onAccessLoss }: ProductionCalendarProps) {
  const range = useMemo(() => deriveProductionCalendarWindow(calendar.date, calendar.subview), [calendar.date, calendar.subview]);
  const query = useProductionCalendarRange({ identity, calendar, enabled: true });
  const queryClient = useOptionalProjectQueryClient();
  const { stages } = useStages();
  const { can } = useCapabilities();
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
  const [acceptedResponse, setAcceptedResponse] = useState<ProductionCalendarRangeResponse | null>(null);
  const [calendarInteractionBlocked, setCalendarInteractionBlocked] = useState(false);
  const [optimisticOverlay, setOptimisticOverlay] = useState<CalendarOptimisticOverlay>(null);
  const [calendarSettle, setCalendarSettle] = useState<CalendarSettleState>({ pending: false, recoveryReason: null });
  const [moveDialog, setMoveDialog] = useState<MoveDialogState | null>(null);
  const [deadlineMovementDisabled, setDeadlineMovementDisabled] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const acceptedResponseRef = useRef<ProductionCalendarRangeResponse | null>(null);
  const snapshotRef = useRef<CalendarAcceptedSnapshot | null>(null);
  const acceptGateRef = useRef(false);
  const settleRef = useRef<CalendarSettleState>({ pending: false, recoveryReason: null });
  const operationTokenRef = useRef(0);
  const commandLockRef = useRef<CalendarCommandLock>({ active: false });
  const queuedRefetchRef = useRef(false);
  const accessLostRef = useRef(false);
  const settleRefetchInFlightRef = useRef(false);

  const setAcceptGate = useCallback((blocked: boolean) => {
    acceptGateRef.current = blocked;
    setCalendarInteractionBlocked(blocked);
  }, []);

  const setOverlay = useCallback((overlay: CalendarOptimisticOverlay) => {
    setOptimisticOverlay(overlay);
  }, []);

  const setSettle = useCallback((event: CalendarSettleEvent) => {
    const next = transitionCalendarSettle(settleRef.current, event);
    settleRef.current = next;
    setCalendarSettle(next);
  }, []);

  const acceptRange = useCallback((response: ProductionCalendarRangeResponse) => {
    if (accessLostRef.current) return;
    const copy = cloneResponse(response);
    acceptedResponseRef.current = copy;
    setAcceptedResponse(copy);
    setDeadlineMovementDisabled(false);
  }, []);

  useEffect(() => { onAcceptGateChange?.(calendarInteractionBlocked); }, [calendarInteractionBlocked, onAcceptGateChange]);
  useEffect(() => { onSettleStateChange?.(calendarSettle); }, [calendarSettle, onSettleStateChange]);

  useEffect(() => {
    operationTokenRef.current += 1;
    commandLockRef.current.active = false;
    snapshotRef.current = null;
    settleRefetchInFlightRef.current = false;
    setSelectedDay(null);
    setOverlay(null);
    setMoveDialog(null);
    setAcceptGate(false);
    setSettle({ type: "terminal" });
    setAnnouncement("");
    acceptedResponseRef.current = null;
    setAcceptedResponse(null);
    queuedRefetchRef.current = false;
    // The reset permits a newly navigated Calendar route to recover from an
    // access purge; the token bump above still fences every older async path.
    accessLostRef.current = false;
    if (confirmStore.getSnapshot()) confirmStore.resolve(false);
  }, [calendar.date, calendar.subview, calendar.layers, calendar.editorIds, calendar.includeUnassigned, calendar.stageKeys, calendar.showCompletedChecklist, calendar.showDeliveredProjects, calendar.overdueOnly, calendar.search, calendar.myTasks, identity.principalId, identity.role, identity.authorizationEpoch, setAcceptGate, setOverlay, setSettle]);

  useEffect(() => { if (!query.data) setSelectedDay(null); }, [query.data]);

  useEffect(() => {
    if (!query.data) return;
    // A late observer result can outlive a route-key change in a query client;
    // the server echoes the route date, so never accept data for another range.
    if (query.data.range.date !== calendar.date) return;
    if (acceptGateRef.current) {
      queuedRefetchRef.current = true;
      return;
    }
    acceptRange(query.data);
  }, [acceptRange, query.data, query.dataUpdatedAt]);

  useEffect(() => {
    const applied = query.data?.range.appliedFilters;
    if (!applied || sameFilters(applied, productionCalendarFiltersFor(calendar))) return;
    onAppliedFilters?.(applied);
  }, [calendar, onAppliedFilters, query.data?.range.appliedFilters]);

  const sourceEvents = acceptedResponse?.events ?? (!calendarInteractionBlocked ? query.data?.events ?? [] : []);
  const renderEvents = useMemo(() => sourceEvents.map((event) => {
    if (event.kind !== "project_deadline") return event;
    const canDrag = identity.role === "admin"
      && event.permissions.canDrag
      && !deadlineMovementDisabled
      && !calendarInteractionBlocked
      && !calendarSettle.pending;
    return canDrag === event.permissions.canDrag ? event : { ...event, permissions: { ...event.permissions, canDrag } };
  }), [calendarInteractionBlocked, calendarSettle.pending, deadlineMovementDisabled, identity.role, sourceEvents]);
  const mappedEvents = useMemo(() => mapCalendarEventsToFullCalendar(applyOptimisticOverlay(renderEvents, optimisticOverlay)), [optimisticOverlay, renderEvents]);
  const selectedEvents = selectedDay === null ? [] : renderEvents.filter((event) => eventCivilDate(event) === selectedDay);
  const dense = errorCode(query.error) === "calendar_range_too_dense";
  const refinement = errorRefinement(query.error) ?? "Refine the date range, Stage, Editor, layer, or search filters.";

  const announceLifecycle = useCallback((kind: Parameters<typeof calendarAnnouncement>[0], context: Parameters<typeof calendarAnnouncement>[1]) => {
    if (accessLostRef.current) return;
    const message = calendarAnnouncement(kind, context);
    if (message) setAnnouncement(message);
  }, []);

  const focusDescriptor = useCallback((descriptor: CalendarFocusDescriptor) => {
    if (accessLostRef.current) return;
    if (descriptor.control === "safe-fallback") {
      window.setTimeout(() => {
        if (accessLostRef.current) return;
        document.querySelector<HTMLElement>('[data-focus-key="calendar-safe-fallback"]')?.focus();
      }, 0);
      return;
    }
    window.setTimeout(() => {
      if (accessLostRef.current) return;
      const focusKey = descriptor.control === "move-reschedule" ? `calendar-move:${descriptor.eventId}` : descriptor.control === "recovery" ? "calendar-recovery" : null;
      const byKey = focusKey === "calendar-recovery"
        ? document.querySelector<HTMLElement>('.button[data-focus-key="calendar-recovery"]') ?? document.querySelector<HTMLElement>('[data-focus-key="calendar-recovery"]')
        : focusKey ? document.querySelector<HTMLElement>(`[data-focus-key="${focusKey}"]`) : null;
      const eventElement = [...document.querySelectorAll<HTMLElement>("[data-event-id]")].find((element) => element.getAttribute("data-event-id") === descriptor.eventId);
      (byKey ?? eventElement)?.focus();
    }, 0);
  }, []);

  const handleAccessLoss = useCallback(() => {
    accessLostRef.current = true;
    operationTokenRef.current += 1;
    commandLockRef.current.active = false;
    setAcceptGate(false);
    setOverlay(null);
    setMoveDialog(null);
    setSettle({ type: "terminal" });
    queuedRefetchRef.current = false;
    if (queryClient) {
      removeProductionCalendarQueries(queryClient, identity.principalId);
      void queryClient.cancelQueries({ queryKey: ["production-calendar", identity.principalId] });
    }
    if (confirmStore.getSnapshot()) confirmStore.resolve(false);
    setAnnouncement("");
    onAccessLoss?.();
  }, [identity.principalId, onAccessLoss, queryClient, setAcceptGate, setOverlay, setSettle]);

  const acceptForInteraction = useCallback((event: ProjectDeadlineCalendarEventDto, focus: CalendarFocusDescriptor): CalendarAcceptedSnapshot | null => {
    if (accessLostRef.current) return null;
    const accepted = acceptedResponseRef.current ?? query.data;
    if (!accepted) return null;
    if (!acceptedResponseRef.current) acceptRange(accepted);
    const snapshot = beginCalendarInteraction({
      event: cloneDeadline(event),
      filters: cloneFilters(productionCalendarFiltersFor(calendar)),
      principalId: identity.principalId,
      authorizationEpoch: identity.authorizationEpoch,
      focus,
      capturedNow: Date.now(),
    });
    // Keep the accepted snapshot in a ref so late callbacks never need to read
    // mutable query data or infer the original focus target again.
    snapshotRef.current = snapshot;
    setAcceptGate(true);
    return snapshot;
  }, [acceptRange, calendar, identity.authorizationEpoch, identity.principalId, query.data, setAcceptGate]);

  const refetchAuthoritative = useCallback(async (): Promise<{ ok: boolean; data?: ProductionCalendarRangeResponse }> => {
    const token = operationTokenRef.current;
    queuedRefetchRef.current = false;
    try {
      const result = await query.refetch();
      if (token !== operationTokenRef.current || accessLostRef.current) return { ok: false };
      if (result.error instanceof ApiError && (result.error.status === 401 || result.error.status === 403)) {
        if (token !== operationTokenRef.current || accessLostRef.current) return { ok: false };
        handleAccessLoss();
        return { ok: false };
      }
      if (result.isError || !result.data) return { ok: false };
      if (token !== operationTokenRef.current || accessLostRef.current) return { ok: false };
      acceptRange(result.data);
      return { ok: true, data: result.data };
    } catch (error) {
      if (token !== operationTokenRef.current || accessLostRef.current) return { ok: false };
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        if (token !== operationTokenRef.current || accessLostRef.current) return { ok: false };
        handleAccessLoss();
      }
      return { ok: false };
    }
  }, [acceptRange, handleAccessLoss, query.refetch]);

  const flushQueuedRefetch = useCallback(() => {
    if (acceptGateRef.current || !queuedRefetchRef.current || accessLostRef.current) return;
    void refetchAuthoritative();
  }, [refetchAuthoritative]);

  const finishInteraction = useCallback((drop: CalendarDropInfo | undefined, oldCivil: string, flush = true) => {
    const snapshot = snapshotRef.current;
    drop?.revert();
    setOverlay(null);
    setMoveDialog(null);
    commandLockRef.current.active = false;
    snapshotRef.current = null;
    setAcceptGate(false);
    announceLifecycle("cancelled", { street: snapshot?.event.project.street, oldCivil });
    focusDescriptor(snapshot?.focus ?? { eventId: snapshot?.event.id ?? "", control: "event" });
    if (flush) flushQueuedRefetch();
  }, [announceLifecycle, flushQueuedRefetch, focusDescriptor, setAcceptGate, setOverlay]);

  const proposalFromRequest = useCallback((snapshot: CalendarAcceptedSnapshot, event: ProjectDeadlineCalendarEventDto, localCivil: string, disambiguation: ProjectDeadlineDisambiguation | undefined, request: SaveProjectDeadlineRequest, drop?: CalendarDropInfo): DeadlineProposalResult => {
    if (request.deadline === null) return { ok: false, reason: "invalid" };
    const resolved = resolveSydneyCivilMinute(localCivil, disambiguation);
    if (!resolved.ok) {
      if (resolved.code === "repeated_local_time") return { ok: false, reason: "fold", choices: resolved.choices };
      if (resolved.code === "nonexistent_local_time") return { ok: false, reason: "gap" };
      return { ok: false, reason: "invalid" };
    }
    const timing: CalendarEventTiming = event.timing.allDay
      ? { allDay: true, start: localCivil.slice(0, 10), end: null }
      : { allDay: false, start: resolved.value.instant, end: null };
    return { ok: true, proposal: { snapshot, event, localCivil, ...(disambiguation ? { disambiguation } : {}), request, timing, ...(drop ? { drop } : {}) } };
  }, []);

  const isUnchangedDeadlineProposal = useCallback((event: ProjectDeadlineCalendarEventDto, proposal: DeadlineProposal): boolean => {
    // Defensive shape only (Deadlines are stored timed). Compare the full civil
    // string so a same-date time change is not mistaken for an unchanged target.
    if (event.timing.allDay && proposal.timing.allDay) return proposal.localCivil === event.deadlineLocalCivil;
    const resolved = resolveSydneyCivilMinute(proposal.localCivil, proposal.disambiguation);
    return resolved.ok && resolved.value.instant === event.timing.start;
  }, []);

  const runConfirmedProposal = useCallback(async (proposal: DeadlineProposal) => {
    const token = operationTokenRef.current;
    if (accessLostRef.current || token !== operationTokenRef.current) return;
    announceLifecycle("confirm-required", { street: proposal.event.project.street, oldCivil: proposal.event.deadlineLocalCivil, newCivil: proposal.localCivil });
    const consequences = previewProjectDeadlineReminderConsequences({
      oldDeadline: { localCivil: proposal.event.deadlineLocalCivil, instant: proposal.event.timing.allDay ? undefined : proposal.event.timing.start },
      newDeadline: { localCivil: proposal.localCivil, instant: proposal.timing.allDay ? undefined : proposal.timing.start },
      reminderOffsetsMinutes: proposal.event.reminderOffsetsMinutes,
      now: proposal.snapshot.capturedNow,
    });
    const ok = await confirm({
      title: "Move Deadline",
      message: `Move the Deadline for ${proposal.event.project.street}?`,
      confirmLabel: "Move Deadline",
      content: <ProductionCalendarMoveConfirmation street={proposal.event.project.street} oldCivil={proposal.event.deadlineLocalCivil} newCivil={proposal.localCivil} consequences={consequences} />,
    });
    if (accessLostRef.current || token !== operationTokenRef.current) return;
    if (!ok) {
      finishInteraction(proposal.drop, proposal.event.deadlineLocalCivil);
      return;
    }

    setOverlay({ eventId: proposal.event.id, timing: proposal.timing });
    announceLifecycle("saving", { street: proposal.event.project.street, newCivil: proposal.localCivil });
    try {
      const response = await apiPut<SaveResponse, SaveProjectDeadlineRequest>(`/api/projects/${encodeURIComponent(proposal.event.project.id)}/deadline`, proposal.request);
      if (accessLostRef.current || token !== operationTokenRef.current) return;
      if (!response.changed && currentMatchesSource(proposal.event, response.current)) {
        const baseline = acceptedResponseRef.current;
        if (baseline) acceptRange({ ...baseline, events: baseline.events.map((event) => event.id === proposal.event.id && event.kind === "project_deadline" ? canonicalEventFromSchedule(event, response.current) : event) });
        setOverlay(null);
        commandLockRef.current.active = false;
        snapshotRef.current = null;
        setAcceptGate(false);
        announceLifecycle("no-change", {});
        flushQueuedRefetch();
        return;
      }

      setAcceptGate(false);
      setSettle({ type: "winner" });
      commandLockRef.current.active = false;
      snapshotRef.current = null;
      if (queryClient) getProjectQueryRuntime(queryClient)?.publish(createProductionCalendarInvalidatedMessage());
      if (queryClient) await invalidateProjectResources(queryClient, { projectId: proposal.event.project.id, resources: [{ kind: "detail" }, { kind: "subtasks" }] }, false);
      if (accessLostRef.current || token !== operationTokenRef.current) return;
      settleRefetchInFlightRef.current = true;
      const settled = await refetchAuthoritative();
      if (accessLostRef.current || token !== operationTokenRef.current) return;
      settleRefetchInFlightRef.current = false;
      if (settled.ok) {
        setSettle({ type: "refetch-succeeded" });
        setOverlay(null);
        announceLifecycle("saved", { street: proposal.event.project.street, newCivil: proposal.localCivil });
      } else if (!accessLostRef.current) {
        setSettle({ type: "refetch-failed", reason: "The latest Calendar could not be loaded." });
        announceLifecycle("settle-failed", {});
      }
    } catch (error) {
      if (accessLostRef.current || token !== operationTokenRef.current) return;
      const action = classifyDeadlineFailure(error, { eventId: proposal.event.id });
      if (action?.accessLoss || (error instanceof ApiError && (error.status === 401 || error.status === 403))) {
        handleAccessLoss();
        return;
      }
      proposal.drop?.revert();
      setOverlay(null);
      if (action?.askFold) {
        const choices = choicesFromError(error);
        setAcceptGate(true);
        setMoveDialog({ event: proposal.event, snapshot: proposal.snapshot, initialCivil: proposal.localCivil, foldChoices: choices, drop: proposal.drop });
        if (action.announce) setAnnouncement(action.announce);
        return;
      }

      if (action?.disableMovement) setDeadlineMovementDisabled(true);
      if (!action) {
        setAcceptGate(false);
        commandLockRef.current.active = false;
        await refetchAuthoritative();
        if (accessLostRef.current || token !== operationTokenRef.current) return;
        setAnnouncement("The move could not be saved. Reloaded the latest.");
        focusDescriptor({ eventId: proposal.event.id, control: "event" });
        return;
      }

      if (action.refetch) setAcceptGate(false);
      const refreshed = action.refetch ? await refetchAuthoritative() : { ok: false };
      if (accessLostRef.current || token !== operationTokenRef.current) return;
      if (action.retainDraft) {
        const latest = responseEvent(refreshed.data ? cloneResponse(refreshed.data) : acceptedResponseRef.current, proposal.event.id) ?? proposal.event;
        const nextSnapshot = { ...proposal.snapshot, event: cloneDeadline(latest) };
        commandLockRef.current.active = true;
        setAcceptGate(true);
        setMoveDialog({ event: latest, snapshot: nextSnapshot, initialCivil: proposal.localCivil, drop: proposal.drop });
      } else {
        commandLockRef.current.active = false;
        setAcceptGate(false);
        focusDescriptor({ eventId: proposal.event.id, control: action.focus });
      }
      if (action.announce) setAnnouncement(action.announce);
    }
  }, [acceptRange, finishInteraction, flushQueuedRefetch, focusDescriptor, handleAccessLoss, announceLifecycle, queryClient, refetchAuthoritative, setAcceptGate, setOverlay, setSettle]);

  const mapAndRunDropProposal = useCallback((snapshot: CalendarAcceptedSnapshot, event: ProjectDeadlineCalendarEventDto, localCivil: string, subview: "month" | "week", disambiguation: ProjectDeadlineDisambiguation | undefined, drop: CalendarDropInfo) => {
    const target: CalendarManipulationTarget = subview === "month"
      ? { subview, targetDate: localCivil.slice(0, 10) }
      : { subview, targetDate: localCivil.slice(0, 10), targetCivilMinute: localCivil };
    const mapped = mapProjectDeadlineMoveToCommand({ event: snapshot.event, target, ...(disambiguation ? { disambiguation } : {}) });
    if (!mapped.ok) {
      if (mapped.error.code === "repeated_local_time" && mapped.error.choices) {
        setMoveDialog({ event, snapshot, initialCivil: localCivil, foldChoices: mapped.error.choices, drop, subview });
        return;
      }
      if (mapped.error.code === "nonexistent_local_time") {
        drop.revert();
        setMoveDialog({ event, snapshot, initialCivil: localCivil, drop });
        setAnnouncement("That time does not exist in Sydney on that date (daylight-saving gap). Pick another time.");
        return;
      }
      drop.revert();
      setAcceptGate(false);
      commandLockRef.current.active = false;
      snapshotRef.current = null;
      setAnnouncement(mapped.error.code === "nonexistent_local_time" ? "That time does not exist in Sydney on that date (daylight-saving gap). Pick another time." : "That is not a valid Sydney time. Adjust the value and try again.");
      focusDescriptor({ eventId: event.id, control: "event" });
      flushQueuedRefetch();
      return;
    }
    if (mapped.value.deadline === null) {
      drop.revert();
      setAcceptGate(false);
      commandLockRef.current.active = false;
      return;
    }
    const proposalResult = proposalFromRequest(snapshot, event, mapped.value.deadline.localCivil, disambiguation, mapped.value, drop);
    if (!proposalResult.ok) {
      drop.revert();
      setAcceptGate(false);
      commandLockRef.current.active = false;
      return;
    }
    const proposal = proposalResult.proposal;
    if (isUnchangedDeadlineProposal(event, proposal)) {
      finishInteraction(drop, event.deadlineLocalCivil);
      return;
    }
    void runConfirmedProposal(proposal);
  }, [finishInteraction, flushQueuedRefetch, focusDescriptor, isUnchangedDeadlineProposal, proposalFromRequest, runConfirmedProposal, setAcceptGate]);

  const handleDeadlineDrop = useCallback((info: CalendarDropInfo) => {
    if (calendar.subview === "agenda") { info.revert(); return; }
    const dto = info.event.extendedProps.dto;
    if (!dto || typeof dto !== "object" || (dto as { kind?: unknown }).kind !== "project_deadline") { info.revert(); return; }
    const event = dto as ProjectDeadlineCalendarEventDto;
    if (!event.permissions.canDrag || identity.role !== "admin" || deadlineMovementDisabled || settleRef.current.pending || !canStartCalendarCommand(commandLockRef.current)) { info.revert(); return; }
    let civil;
    try {
      civil = fullCalendarCallbackToSydneyCivil({ allDay: info.event.allDay, date: info.event.start!, dateStr: info.event.startStr });
    } catch {
      info.revert();
      setAnnouncement("That is not a valid Sydney time. Adjust the value and try again.");
      return;
    }
    const localCivil = civil.allDay ? proposedCivilForAllDay(event, civil.date) : civil.localCivil;
    const subview = calendar.subview === "month" ? "month" : "week";
    const snapshot = acceptForInteraction(event, { eventId: event.id, control: "event" });
    if (!snapshot) { info.revert(); return; }
    commandLockRef.current.active = true;
    announceLifecycle("picked-up", { street: event.project.street, oldCivil: event.deadlineLocalCivil });
    mapAndRunDropProposal(snapshot, event, localCivil, subview, undefined, info);
  }, [acceptForInteraction, announceLifecycle, calendar.subview, deadlineMovementDisabled, identity.role, mapAndRunDropProposal]);

  const openMoveDialog = useCallback((event: ProjectDeadlineCalendarEventDto) => {
    if (identity.role !== "admin" || !event.permissions.canDrag || deadlineMovementDisabled || settleRef.current.pending || !canStartCalendarCommand(commandLockRef.current)) return;
    const snapshot = acceptForInteraction(event, { eventId: event.id, control: "move-reschedule" });
    if (!snapshot) return;
    commandLockRef.current.active = true;
    announceLifecycle("picked-up", { street: event.project.street, oldCivil: event.deadlineLocalCivil });
    setMoveDialog({ event, snapshot, initialCivil: event.deadlineLocalCivil });
  }, [acceptForInteraction, announceLifecycle, deadlineMovementDisabled, identity.role]);

  const handleMoveDialogSubmit = useCallback((localCivil: string, disambiguation?: ProjectDeadlineDisambiguation) => {
    const state = moveDialog;
    if (!state || accessLostRef.current) return;
    setMoveDialog(null);
    if (state.subview && state.drop) {
      mapAndRunDropProposal(state.snapshot, state.event, localCivil, state.subview, disambiguation, state.drop);
      return;
    }
    const request: SaveProjectDeadlineRequest = {
      expectedVersion: state.snapshot.event.deadlineVersion,
      deadline: { localCivil, ...(disambiguation ? { disambiguation } : {}) },
      reminderOffsetsMinutes: [...state.snapshot.event.reminderOffsetsMinutes],
    };
    const proposalResult = proposalFromRequest(state.snapshot, state.event, localCivil, disambiguation, request, state.drop);
    if (!proposalResult.ok) {
      if (proposalResult.reason === "fold") {
        setAcceptGate(true);
        commandLockRef.current.active = true;
        setMoveDialog({ ...state, initialCivil: localCivil, foldChoices: proposalResult.choices });
        setAnnouncement("That time occurs twice in Sydney that day. Choose the earlier or later occurrence.");
      } else if (proposalResult.reason === "gap") {
        setMoveDialog({ ...state, initialCivil: localCivil, foldChoices: undefined });
        setAnnouncement("That time does not exist in Sydney on that date (daylight-saving gap). Pick another time.");
      } else {
        setMoveDialog({ ...state, initialCivil: localCivil, foldChoices: undefined });
      }
      return;
    }
    const proposal = proposalResult.proposal;
    if (isUnchangedDeadlineProposal(state.event, proposal)) {
      finishInteraction(state.drop, state.event.deadlineLocalCivil);
      return;
    }
    void runConfirmedProposal(proposal);
  }, [finishInteraction, isUnchangedDeadlineProposal, mapAndRunDropProposal, moveDialog, proposalFromRequest, runConfirmedProposal, setAcceptGate]);

  const handleMoveDialogCancel = useCallback(() => {
    const state = moveDialog;
    if (!state) return;
    finishInteraction(state.drop, state.snapshot.event.deadlineLocalCivil);
  }, [finishInteraction, moveDialog]);

  const refreshRecovery = useCallback(async () => {
    if (!settleRef.current.pending || settleRefetchInFlightRef.current || accessLostRef.current) return;
    const token = operationTokenRef.current;
    settleRefetchInFlightRef.current = true;
    const result = await refetchAuthoritative();
    if (token !== operationTokenRef.current || accessLostRef.current) return;
    settleRefetchInFlightRef.current = false;
    if (result.ok) {
      setSettle({ type: "refetch-succeeded" });
      setOverlay(null);
    }
  }, [refetchAuthoritative, setOverlay, setSettle]);

  useEffect(() => () => {
    operationTokenRef.current += 1;
    accessLostRef.current = true;
    commandLockRef.current.active = false;
    queuedRefetchRef.current = false;
    settleRefetchInFlightRef.current = false;
    setAcceptGate(false);
    onSettleStateChange?.({ pending: false, recoveryReason: null });
  }, [setAcceptGate]);

  const clearSettleOnNavigation = useCallback(() => {
    setSettle({ type: "terminal" });
    setOverlay(null);
    queuedRefetchRef.current = false;
  }, [setOverlay, setSettle]);

  return (
    <section className="qc-calendar-screen" aria-label="Production Calendar" tabIndex={-1} data-focus-key="calendar-safe-fallback">
      <ProductionCalendarToolbar calendar={calendar} range={range} onNavigate={(next) => { if (!calendarInteractionBlocked) { clearSettleOnNavigation(); onNavigate(next); } }} />
      <ProductionCalendarFiltersPanel
        filters={productionCalendarFiltersFor(calendar)}
        facetPeople={query.data?.filterFacets.people ?? []}
        stages={stageOptions}
        disabled={calendarInteractionBlocked || (query.isPending && !query.data)}
        onChange={(next) => { if (!calendarInteractionBlocked) { clearSettleOnNavigation(); onNavigate({ ...calendar, ...next, view: "calendar" }); } }}
      />

      {calendarSettle.recoveryReason && <div className="notice qc-calendar-recovery" role="alert"><span>{calendarSettle.recoveryReason}</span><button className="button button--secondary" type="button" data-focus-key="calendar-recovery" onClick={() => void refreshRecovery()}>Refresh</button></div>}
      {query.isPending && !query.data && <div className="empty qc-calendar-state" role="status">Loading calendar…</div>}

      {!query.isPending && query.error && !query.data && (
        <div className="empty qc-calendar-state" role="alert">
          <span className="serif">Calendar unavailable.</span>
          {dense ? <><p>That range is too dense — narrow the filters.</p><p>{refinement}</p></> : <p>Calendar could not be loaded. Try again.</p>}
          {!dense && <div style={{ marginTop: 16 }}><button className="button button--secondary" type="button" onClick={() => void query.refetch()}>Try again</button></div>}
        </div>
      )}

      {acceptedResponse && acceptedResponse.events.length === 0 && <div className="empty qc-calendar-state" role="status">No scheduled work in this range.</div>}

      {acceptedResponse && acceptedResponse.events.length > 0 && (
        <>
          <ProductionCalendarSurface
            key={`${calendar.subview}:${calendar.date}`}
            initialView={viewForSubview(calendar.subview)}
            initialDate={calendar.date}
            visibleRange={range}
            headerToolbar={false}
            events={mappedEvents}
            editable={mappedEvents.some((event) => event.editable === true)}
            eventStartEditable
            eventDurationEditable={false}
            droppable={false}
            selectable={false}
            weekends
            firstDay={1}
            slotMinTime="00:00:00"
            slotMaxTime="24:00:00"
            expandRows={calendar.subview === "week"}
            views={{ list: { type: "list", duration: { days: 14 } } }}
            eventDrop={(info) => handleDeadlineDrop(info as unknown as CalendarDropInfo)}
            dateClick={(info) => {
              if (calendar.subview === "month" && info.allDay) setSelectedDay(info.dateStr);
            }}
            eventContent={(info) => <ProductionCalendarEvent event={info.event.extendedProps.dto} subview={calendar.subview} onMoveReschedule={calendarSettle.pending || calendarInteractionBlocked ? undefined : openMoveDialog} />}
          />

          {calendar.subview === "month" && selectedDay !== null && (
            <section className="qc-calendar-disclosure" aria-label="Selected day">
              <div className="ey">Selected day · {selectedDay}</div>
              {selectedEvents.length === 0 ? <p className="muted">No scheduled work on this day.</p> : <div className="qc-calendar-disclosure__events">{selectedEvents.map((event) => <ProductionCalendarEvent key={event.id} event={event} subview={calendar.subview} compact onMoveReschedule={calendarSettle.pending || calendarInteractionBlocked ? undefined : openMoveDialog} />)}</div>}
            </section>
          )}
        </>
      )}
      <div className="dashboard-live-region sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
      {moveDialog && <ProductionCalendarMoveDialog event={moveDialog.event} initialCivil={moveDialog.initialCivil} foldChoices={moveDialog.foldChoices} onSubmit={handleMoveDialogSubmit} onCancel={handleMoveDialogCancel} />}
    </section>
  );
}
