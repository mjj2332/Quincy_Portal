import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  deriveProductionCalendarWindow,
  formatSydneyCivilMinute,
  mapChecklistEndResizeToCommand,
  mapChecklistMoveToCommand,
  mapUnscheduledChecklistDropToCommand,
  normalizeChecklistSchedule,
  mapProjectDeadlineMoveToCommand,
  mapUnscheduledProjectDropToCommand,
  previewProjectDeadlineReminderConsequences,
  resolveSydneyCivilMinute,
  shiftSydneyCalendarDate,
  checklistScheduleToDto,
  STAGE_PRESENTATION_KEYS,
  CHECKLIST_SCHEDULE_RANGES_ENABLED,
  type CalendarPerson,
  type CalendarEventDto,
  type CalendarEventTiming,
  type CalendarManipulationTarget,
  type CalendarUnscheduledEntryDto,
  type ChecklistCalendarEventDto,
  type ChecklistCalendarUnscheduledEntryDto,
  type ChecklistDisambiguation,
  type ChecklistScheduleDto,
  type DueOnlyChecklistScheduleDto,
  type RangeChecklistScheduleDto,
  type UnscheduledChecklistScheduleDto,
  type DashboardCalendarState,
  type InitialChecklistScheduleInput,
  type ProjectDeadlineCalendarEventDto,
  type ProjectDeadlineDisambiguation,
  type ProjectCalendarUnscheduledEntryDto,
  type ProductionCalendarFilters,
  type ProductionCalendarRangeResponse,
  type ProductionCalendarSubview,
  type SaveProjectDeadlineRequest,
  type SaveChecklistScheduleRequest,
} from "@quincy/shared";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import { ApiError, apiPatch, apiPut } from "../lib/api";
import { confirm, confirmStore } from "../lib/confirm";
import { invalidateProjectSurfaces, useOptionalProjectQueryClient } from "../lib/project-data";
import { decodeChecklistMutationResponse, productionCalendarFiltersFor, removeProductionCalendarQueries, useProductionCalendarRange, type ChecklistMutationResult } from "../lib/production-calendar-query";
import { fullCalendarCallbackToSydneyCivil } from "../lib/production-calendar-fullcalendar";
import {
  applyOptimisticOverlay,
  beginCalendarInteraction,
  canStartCalendarCommand,
  calendarAnnouncement,
  classifyChecklistFailure,
  classifyDeadlineFailure,
  cloneSource,
  transitionCalendarSettle,
  type CalendarAcceptedSnapshot,
  type CalendarInteractionSource,
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
import { ProductionCalendarFoldChoice } from "./ProductionCalendarFoldChoice";
import { ProductionCalendarScheduleEditor, type ProductionCalendarScheduleEditorError } from "./ProductionCalendarScheduleEditor";
import { ProductionCalendarUnscheduledPanel, unscheduledChecklistDraggable, unscheduledProjectDraggable } from "./ProductionCalendarUnscheduledPanel";
import { presentationStages, useStages } from "../lib/stages";
import { useCapabilities } from "../lib/capabilities";
import { useMediaQuery, usePrefersReducedMotion } from "../lib/use-media-query";

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
  onProjectAnchorClick?: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
};

type CalendarDropInfo = {
  event: { allDay: boolean; start: Date | null; startStr: string; end: Date | null; endStr: string; extendedProps: { dto?: unknown } };
  revert: () => void;
};

type CalendarRevertable = { revert: () => void };

type CalendarExternalDropInfo = {
  date: Date;
  dateStr: string;
  allDay: boolean;
  draggedEl: HTMLElement;
};

type CalendarExternalReceiveInfo = {
  event: { extendedProps?: { unscheduledId?: unknown; unscheduledKind?: unknown } };
  revert: () => void;
};

type CalendarResizeInfo = CalendarDropInfo & {
  startDelta?: { milliseconds?: number; days?: number; months?: number } | null;
  endDelta?: { milliseconds?: number; days?: number; months?: number } | null;
};

type MoveDialogState = {
  event: ProjectDeadlineCalendarEventDto;
  snapshot: CalendarAcceptedSnapshot<ProjectDeadlineCalendarEventDto>;
  initialCivil: string;
  foldChoices?: Array<{ disambiguation: ProjectDeadlineDisambiguation; utcOffsetMinutes: number }>;
  drop?: CalendarRevertable;
  subview?: "month" | "week";
  unscheduledEntry?: ProjectCalendarUnscheduledEntryDto;
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
  snapshot: CalendarAcceptedSnapshot<ProjectDeadlineCalendarEventDto>;
  event: ProjectDeadlineCalendarEventDto;
  localCivil: string;
  disambiguation?: ProjectDeadlineDisambiguation;
  request: SaveProjectDeadlineRequest;
  timing: CalendarEventTiming;
  drop?: CalendarRevertable;
  unscheduledEntry?: ProjectCalendarUnscheduledEntryDto;
};

type DeadlineFoldChoice = { disambiguation: ProjectDeadlineDisambiguation; utcOffsetMinutes: number };

type DeadlineProposalResult =
  | { ok: true; proposal: DeadlineProposal }
  | { ok: false; reason: "fold"; choices: DeadlineFoldChoice[] }
  | { ok: false; reason: "gap" }
  | { ok: false; reason: "invalid" };

type ChecklistSource = ChecklistCalendarEventDto | ChecklistCalendarUnscheduledEntryDto;
type ChecklistSnapshot = CalendarAcceptedSnapshot<ChecklistSource>;
type ChecklistOperationInfo = {
  drop?: CalendarRevertable;
  resize?: CalendarResizeInfo;
  editor?: boolean;
  external?: boolean;
};
type ChecklistProposal = {
    snapshot: ChecklistSnapshot;
  source: ChecklistSource;
  request: SaveChecklistScheduleRequest;
  schedule: InitialChecklistScheduleInput;
  timing: CalendarEventTiming | null;
  operation: ChecklistOperationInfo;
  target?: CalendarManipulationTarget;
  edge?: "end";
};
type ChecklistFoldState = {
  proposal: ChecklistProposal;
  disambiguation: { start?: "earlier" | "later"; end?: "earlier" | "later" };
  endpoint: "start" | "end";
  choices: Array<{ disambiguation: "earlier" | "later"; utcOffsetMinutes: number }>;
};
type ScheduleEditorState = {
  source: ChecklistSource;
  snapshot: ChecklistSnapshot;
  initialSchedule?: InitialChecklistScheduleInput;
  validationError?: ProductionCalendarScheduleEditorError;
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

function cloneFilters(filters: ProductionCalendarFilters): ProductionCalendarFilters {
  return { ...filters, layers: [...filters.layers], editorIds: [...filters.editorIds], stageKeys: [...filters.stageKeys] };
}

function cloneResponse(response: ProductionCalendarRangeResponse): ProductionCalendarRangeResponse {
  return {
    ...response,
    range: { ...response.range, appliedFilters: cloneFilters(response.range.appliedFilters) },
    events: response.events.map((event) => cloneSource(event)),
    unscheduled: response.unscheduled.map((entry) => cloneSource(entry)),
  };
}

function responseEvent(response: ProductionCalendarRangeResponse | null, eventId: string): ProjectDeadlineCalendarEventDto | undefined {
  const event = response?.events.find((candidate) => candidate.id === eventId);
  return event?.kind === "project_deadline" ? event : undefined;
}

function projectDeadlinePlaceholder(entry: ProjectCalendarUnscheduledEntryDto): ProjectDeadlineCalendarEventDto {
  return {
    id: entry.id,
    kind: "project_deadline",
    title: entry.title,
    project: cloneSource(entry).project,
    timing: { allDay: false, start: "1970-01-01T00:00:00.000Z", end: null },
    status: { overdue: false, delivered: entry.project.delivered, completed: false, sameAssigneeOverlap: false },
    permissions: { canDrag: entry.permissions.canDrag, canResize: false },
    deadlineLocalCivil: "Not scheduled",
    deadlineVersion: entry.deadlineVersion,
    reminderOffsetsMinutes: [],
  };
}

function canDragUnscheduledEntry(entry: CalendarUnscheduledEntryDto, rangesEnabled: boolean): boolean {
  return entry.kind === "project_deadline"
    ? unscheduledProjectDraggable(entry)
    : unscheduledChecklistDraggable(entry, rangesEnabled);
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
    ...cloneSource(event),
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

function endpointChoicesFromError(error: unknown): Array<{ disambiguation: "earlier" | "later"; utcOffsetMinutes: number }> {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== "object") return [];
  const details = error.details as { details?: unknown; choices?: unknown };
  const choices = Array.isArray(details.choices) ? details.choices : details.details && typeof details.details === "object" && Array.isArray((details.details as { choices?: unknown }).choices) ? (details.details as { choices: unknown[] }).choices : [];
  return choices.filter((choice): choice is { disambiguation: "earlier" | "later"; utcOffsetMinutes: number } => {
    if (!choice || typeof choice !== "object") return false;
    const value = choice as Record<string, unknown>;
    return (value.disambiguation === "earlier" || value.disambiguation === "later") && typeof value.utcOffsetMinutes === "number";
  });
}

function endpointOfError(error: unknown): "start" | "end" | undefined {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== "object") return undefined;
  const details = error.details as { endpoint?: unknown; details?: unknown };
  if (details.endpoint === "start" || details.endpoint === "end") return details.endpoint;
  if (details.details && typeof details.details === "object") {
    const endpoint = (details.details as { endpoint?: unknown }).endpoint;
    if (endpoint === "start" || endpoint === "end") return endpoint;
  }
  return undefined;
}

function durationNonZero(value: CalendarResizeInfo["startDelta"]): boolean {
  if (!value) return false;
  return (value.milliseconds ?? 0) !== 0 || (value.days ?? 0) !== 0 || (value.months ?? 0) !== 0;
}

function stableScheduleValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableScheduleValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stableScheduleValue(child)]));
}

function checklistSchedulesEqual(left: ChecklistScheduleDto, right: ChecklistScheduleDto): boolean {
  return JSON.stringify(stableScheduleValue(left)) === JSON.stringify(stableScheduleValue(right));
}

function timingFromChecklistSchedule(schedule: ChecklistScheduleDto): CalendarEventTiming | null {
  if (schedule.state === "unscheduled" || schedule.state === "legacy_unresolved" || schedule.state === "invalid" || !schedule.end) return null;
  if (schedule.state === "due_only") {
    return schedule.end.kind === "date"
      ? { allDay: true, start: schedule.end.localCivil, end: null }
      : { allDay: false, start: schedule.end.instant ?? "", end: null };
  }
  if (!schedule.start) return null;
  if (schedule.start.kind === "date" && schedule.end.kind === "date") {
    const exclusive = shiftSydneyCalendarDate(schedule.end.localCivil, 1);
    return exclusive.ok ? { allDay: true, start: schedule.start.localCivil, end: exclusive.value } : null;
  }
  if (schedule.start.kind !== "timed" || schedule.end.kind !== "timed" || !schedule.start.instant || !schedule.end.instant) return null;
  return { allDay: false, start: schedule.start.instant, end: schedule.end.instant };
}

function checklistInputFromSchedule(schedule: ChecklistScheduleDto): InitialChecklistScheduleInput {
  if (schedule.state === "unscheduled") return { state: "unscheduled" };
  if (schedule.state === "legacy_unresolved" || schedule.state === "invalid") {
    const due = schedule.due ?? "";
    const kind = due.includes("T") ? "timed" : "date";
    return { state: "due_only", end: { kind, localCivil: due } };
  }
  if (schedule.state === "due_only") {
    return { state: "due_only", end: schedule.end ? { kind: schedule.end.kind, localCivil: schedule.end.localCivil, ...(schedule.end.fold === 1 ? { disambiguation: "later" as const } : schedule.end.fold === 0 ? { disambiguation: "earlier" as const } : {}) } : { kind: "date", localCivil: schedule.due ?? "" } };
  }
  return {
    state: "range",
    start: schedule.start ? { kind: schedule.start.kind, localCivil: schedule.start.localCivil, ...(schedule.start.fold === 1 ? { disambiguation: "later" as const } : schedule.start.fold === 0 ? { disambiguation: "earlier" as const } : {}) } : { kind: "date", localCivil: "" },
    end: schedule.end ? { kind: schedule.end.kind, localCivil: schedule.end.localCivil, ...(schedule.end.fold === 1 ? { disambiguation: "later" as const } : schedule.end.fold === 0 ? { disambiguation: "earlier" as const } : {}) } : { kind: "date", localCivil: "" },
  };
}

function checklistCurrentCivil(event: ChecklistCalendarEventDto): string {
  if (event.schedule.state === "due_only") return event.schedule.end?.localCivil ?? event.timing.start;
  if (event.schedule.state === "range") return event.schedule.start?.localCivil ?? event.timing.start;
  return event.timing.start;
}

function inputDisambiguation(schedule: InitialChecklistScheduleInput, endpoint: "start" | "end"): "earlier" | "later" | undefined {
  const value = schedule.state === "range" ? schedule[endpoint] : schedule.state === "due_only" && endpoint === "end" ? schedule.end : undefined;
  return value?.kind === "timed" ? value.disambiguation : undefined;
}

function checklistSourceFromResponse(response: ProductionCalendarRangeResponse | null, id: string): ChecklistSource | undefined {
  const event = response?.events.find((candidate) => candidate.id === id);
  if (event?.kind === "checklist") return event;
  const entry = response?.unscheduled.find((candidate) => candidate.id === id);
  return entry?.kind === "checklist" ? entry : undefined;
}

function checklistAssigneeForResult(source: ChecklistSource, result: ChecklistMutationResult): CalendarPerson | null {
  if (source.assignee && result.assignee && source.assignee.id === result.assignee.id) return source.assignee;
  return result.assignee;
}

function canonicalChecklistEvent(source: ChecklistSource, result: ChecklistMutationResult): ChecklistCalendarEventDto | null {
  const schedule = result.schedule;
  const timing = timingFromChecklistSchedule(schedule);
  if (!timing) return null;
  const permissions = source.permissions;
  const common = {
    id: result.id,
    kind: "checklist" as const,
    title: result.title,
    project: { ...source.project, checklist: { ...source.project.checklist } },
    assignee: checklistAssigneeForResult(source, result),
    timing,
    status: { ...("timing" in source ? source.status : { overdue: false, delivered: source.project.delivered, completed: false, sameAssigneeOverlap: false }), completed: result.done },
  };
  if (schedule.state === "due_only") return {
    ...common,
    schedule: schedule as DueOnlyChecklistScheduleDto,
    permissions: { canDrag: permissions.canDrag, canResize: false, canOpenScheduleEditor: permissions.canOpenScheduleEditor, canScheduleRange: permissions.canScheduleRange },
  };
  if (schedule.state !== "range") return null;
  return {
    ...common,
    schedule: schedule as RangeChecklistScheduleDto,
    permissions: { canDrag: permissions.canDrag, canResize: permissions.canResize, canOpenScheduleEditor: permissions.canOpenScheduleEditor, canScheduleRange: permissions.canScheduleRange },
  };
}

function optimisticChecklistEvent(source: ChecklistSource, schedule: ChecklistScheduleDto): ChecklistCalendarEventDto | null {
  return canonicalChecklistEvent(source, {
    id: source.id,
    title: source.title,
    done: "status" in source ? source.status.completed : false,
    assignee: source.assignee,
    position: 0,
    schedule,
    scheduleVersion: schedule.version,
  });
}

function adoptChecklistResult(response: ProductionCalendarRangeResponse, source: ChecklistSource, result: ChecklistMutationResult): ProductionCalendarRangeResponse {
  const nextEvent = canonicalChecklistEvent(source, result);
  const schedule = result.schedule;
  const sourceWasEvent = "timing" in source;
  const events = response.events.filter((event) => event.id !== result.id);
  if (nextEvent) events.push(nextEvent);
  const unscheduled = response.unscheduled.filter((entry) => entry.id !== result.id);
  if (!nextEvent && schedule.state === "unscheduled") {
    const entry: ChecklistCalendarUnscheduledEntryDto = {
      id: result.id,
      kind: "checklist",
      reason: "unscheduled",
      title: result.title,
      project: { ...source.project, checklist: { ...source.project.checklist } },
      assignee: checklistAssigneeForResult(source, result),
      schedule: schedule as UnscheduledChecklistScheduleDto,
      permissions: {
        canDrag: source.permissions.canDrag,
        canResize: false,
        canOpenScheduleEditor: source.permissions.canOpenScheduleEditor,
        canScheduleRange: source.permissions.canScheduleRange,
      },
    };
    unscheduled.push(entry);
  }
  return { ...response, events: sourceWasEvent || nextEvent ? events : response.events, unscheduled };
}

export function ProductionCalendar({ identity, calendar, onNavigate, onAppliedFilters, onAcceptGateChange, onSettleStateChange, onAccessLoss, projectHrefFor, onOpenProject, onProjectAnchorClick }: ProductionCalendarProps) {
  const range = useMemo(() => deriveProductionCalendarWindow(calendar.date, calendar.subview), [calendar.date, calendar.subview]);
  const query = useProductionCalendarRange({ identity, calendar, enabled: true });
  const queryClient = useOptionalProjectQueryClient();
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
  const [acceptedResponse, setAcceptedResponse] = useState<ProductionCalendarRangeResponse | null>(null);
  const [calendarInteractionBlocked, setCalendarInteractionBlocked] = useState(false);
  const [optimisticOverlay, setOptimisticOverlay] = useState<CalendarOptimisticOverlay>(null);
  const [calendarSettle, setCalendarSettle] = useState<CalendarSettleState>({ pending: false, recoveryReason: null });
  const [moveDialog, setMoveDialog] = useState<MoveDialogState | null>(null);
  const [scheduleEditor, setScheduleEditor] = useState<ScheduleEditorState | null>(null);
  const [checklistFold, setChecklistFold] = useState<ChecklistFoldState | null>(null);
  const [deadlineMovementDisabled, setDeadlineMovementDisabled] = useState(false);
  const [checklistRangeSchedulingDisabled, setChecklistRangeSchedulingDisabled] = useState(false);
  const [checklistNeedsAttention, setChecklistNeedsAttention] = useState<Set<string>>(() => new Set());
  const [announcement, setAnnouncement] = useState("");
  const [calendarAccessLost, setCalendarAccessLost] = useState(false);
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
    const prev = settleRef.current;
    const next = transitionCalendarSettle(prev, event);
    settleRef.current = next;
    // transitionCalendarSettle mirrors the Board's table and always returns a
    // fresh object; skip the state update (and the redundant onSettleStateChange)
    // when the settle state is unchanged — e.g. acceptRange already cleared a
    // pending settle before the mutation flow's explicit refetch-succeeded.
    if (next.pending === prev.pending && next.recoveryReason === prev.recoveryReason) return;
    setCalendarSettle(next);
  }, []);

  const acceptRange = useCallback((response: ProductionCalendarRangeResponse, authoritative = true) => {
    if (accessLostRef.current) return;
    const copy = cloneResponse(response);
    acceptedResponseRef.current = copy;
    setAcceptedResponse(copy);
    // Needs-attention / movement-disabled markers are client-only and are NOT
    // carried in the locally-synthesized adoption a mutation performs — only a
    // genuine authoritative range refetch proves an item was repaired or a
    // project un-archived. Healing them off a local adoption would clear a marker
    // for an unrelated item still present in the stale baseline.
    if (!authoritative) return;
    if (settleRef.current.pending) setSettle({ type: "refetch-succeeded" });
    setChecklistNeedsAttention((current) => {
      const invalidIds = new Set(copy.unscheduled.filter((entry) => entry.kind === "checklist" && entry.reason === "schedule_needs_attention" && entry.attentionReason === "invalid").map((entry) => entry.id));
      const presentIds = new Set([
        ...copy.events.filter((event) => event.kind === "checklist").map((event) => event.id),
        ...copy.unscheduled.filter((entry) => entry.kind === "checklist").map((entry) => entry.id),
      ]);
      let changed = false;
      const next = new Set(current);
      for (const id of current) {
        if (presentIds.has(id) && !invalidIds.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setDeadlineMovementDisabled(false);
    setChecklistRangeSchedulingDisabled(false);
  }, [setSettle]);

  useEffect(() => { onAcceptGateChange?.(calendarInteractionBlocked); }, [calendarInteractionBlocked, onAcceptGateChange]);
  useEffect(() => { onSettleStateChange?.(calendarSettle); }, [calendarSettle, onSettleStateChange]);

  const calendarResetKey = `${calendar.date}|${calendar.subview}|${calendar.layers.join(",")}|${calendar.editorIds.join(",")}|${calendar.includeUnassigned}|${calendar.stageKeys.join(",")}|${calendar.showCompletedChecklist}|${calendar.showDeliveredProjects}|${calendar.overdueOnly}|${calendar.search}|${calendar.myTasks}`;

  useEffect(() => {
    operationTokenRef.current += 1;
    commandLockRef.current.active = false;
    snapshotRef.current = null;
    settleRefetchInFlightRef.current = false;
    setSelectedDay(null);
    setOverlay(null);
    setMoveDialog(null);
    setScheduleEditor(null);
    setChecklistFold(null);
    setAcceptGate(false);
    setSettle({ type: "terminal" });
    setAnnouncement("");
    setChecklistNeedsAttention(new Set());
    acceptedResponseRef.current = null;
    setAcceptedResponse(null);
    queuedRefetchRef.current = false;
    // The reset permits a newly navigated Calendar route to recover from an
    // access purge; the token bump above still fences every older async path.
    accessLostRef.current = false;
    setCalendarAccessLost(false);
    if (confirmStore.getSnapshot()) confirmStore.resolve(false);
  }, [calendarResetKey, identity.principalId, identity.role, identity.authorizationEpoch, setAcceptGate, setOverlay, setSettle]);

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

  const announceLifecycle = useCallback((kind: Parameters<typeof calendarAnnouncement>[0], context: Parameters<typeof calendarAnnouncement>[1]) => {
    if (accessLostRef.current) return;
    const message = calendarAnnouncement(kind, context);
    if (message) setAnnouncement(message);
  }, []);

  const announceChecklistLifecycle = useCallback((kind: Parameters<typeof calendarAnnouncement>[0], context: Omit<Parameters<typeof calendarAnnouncement>[1], "entity">) => {
    announceLifecycle(kind, { ...context, entity: "checklist" });
  }, [announceLifecycle]);

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
    setCalendarAccessLost(true);
    operationTokenRef.current += 1;
    commandLockRef.current.active = false;
    setAcceptGate(false);
    setOverlay(null);
    setMoveDialog(null);
    setScheduleEditor(null);
    setChecklistFold(null);
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

  useEffect(() => {
    if (accessLostRef.current) return;
    const err = query.error;
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) handleAccessLoss();
  }, [query.error, handleAccessLoss]);

  const acceptForInteraction = useCallback(function <TEvent extends CalendarInteractionSource>(event: TEvent, focus: CalendarFocusDescriptor): CalendarAcceptedSnapshot<TEvent> | null {
    if (accessLostRef.current) return null;
    const accepted = acceptedResponseRef.current ?? query.data;
    if (!accepted) return null;
    if (!acceptedResponseRef.current) acceptRange(accepted);
    const snapshot = beginCalendarInteraction({
      event,
      filters: cloneFilters(productionCalendarFiltersFor(calendar)),
      principalId: identity.principalId,
      authorizationEpoch: identity.authorizationEpoch,
      focus,
      capturedNow: Date.now(),
    });
    // Keep the accepted snapshot in a ref so late callbacks never need to read
    // mutable query data or infer the original focus target again.
    snapshotRef.current = snapshot as CalendarAcceptedSnapshot<CalendarInteractionSource>;
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

  const finishInteraction = useCallback((drop: CalendarRevertable | undefined, oldCivil: string, flush = true) => {
    const snapshot = snapshotRef.current;
    drop?.revert();
    setOverlay(null);
    setMoveDialog(null);
    commandLockRef.current.active = false;
    snapshotRef.current = null;
    setAcceptGate(false);
    announceLifecycle("cancelled", { entity: "deadline", street: snapshot?.event.project.street, oldCivil });
    focusDescriptor(snapshot?.focus ?? { eventId: snapshot?.event.id ?? "", control: "event" });
    if (flush) flushQueuedRefetch();
  }, [announceLifecycle, flushQueuedRefetch, focusDescriptor, setAcceptGate, setOverlay]);

  const proposalFromRequest = useCallback((snapshot: CalendarAcceptedSnapshot<ProjectDeadlineCalendarEventDto>, event: ProjectDeadlineCalendarEventDto, localCivil: string, disambiguation: ProjectDeadlineDisambiguation | undefined, request: SaveProjectDeadlineRequest, drop?: CalendarRevertable): DeadlineProposalResult => {
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
    announceLifecycle("confirm-required", { entity: "deadline", street: proposal.event.project.street, oldCivil: proposal.event.deadlineLocalCivil, newCivil: proposal.localCivil });
    const consequences = previewProjectDeadlineReminderConsequences({
      oldDeadline: { localCivil: proposal.event.deadlineLocalCivil, instant: proposal.event.timing.allDay ? undefined : proposal.event.timing.start },
      newDeadline: { localCivil: proposal.localCivil, instant: proposal.timing.allDay ? undefined : proposal.timing.start },
      reminderOffsetsMinutes: proposal.event.reminderOffsetsMinutes,
      now: proposal.snapshot.capturedNow,
    });
    const scheduling = Boolean(proposal.unscheduledEntry);
    const ok = await confirm({
      title: scheduling ? "Schedule Deadline" : "Move Deadline",
      message: scheduling
        ? `Schedule the Deadline for ${proposal.event.project.street}?`
        : `Move the Deadline for ${proposal.event.project.street}?`,
      confirmLabel: scheduling ? "Schedule Deadline" : "Move Deadline",
      content: <ProductionCalendarMoveConfirmation street={proposal.event.project.street} oldCivil={proposal.event.deadlineLocalCivil} newCivil={proposal.localCivil} consequences={consequences} />,
    });
    if (accessLostRef.current || token !== operationTokenRef.current) return;
    if (!ok) {
      finishInteraction(proposal.drop, proposal.event.deadlineLocalCivil);
      return;
    }

    setOverlay(proposal.unscheduledEntry
      ? { kind: "reschedule-unscheduled", entryId: proposal.unscheduledEntry.id, timing: proposal.timing, asEvent: { ...proposal.event, timing: proposal.timing, deadlineLocalCivil: proposal.localCivil } }
      : { eventId: proposal.event.id, timing: proposal.timing });
    announceLifecycle("saving", { entity: "deadline", street: proposal.event.project.street, newCivil: proposal.localCivil });
    try {
      const response = await apiPut<SaveResponse, SaveProjectDeadlineRequest>(`/api/projects/${encodeURIComponent(proposal.event.project.id)}/deadline`, proposal.request);
      if (accessLostRef.current || token !== operationTokenRef.current) return;
      if (!response.changed && currentMatchesSource(proposal.event, response.current)) {
        const baseline = acceptedResponseRef.current;
        if (baseline) acceptRange({ ...baseline, events: baseline.events.map((event) => event.id === proposal.event.id && event.kind === "project_deadline" ? canonicalEventFromSchedule(event, response.current) : event) }, false);
        setOverlay(null);
        commandLockRef.current.active = false;
        snapshotRef.current = null;
        setAcceptGate(false);
        announceLifecycle("no-change", { entity: "deadline" });
        flushQueuedRefetch();
        return;
      }

      setAcceptGate(false);
      setSettle({ type: "winner" });
      commandLockRef.current.active = false;
      snapshotRef.current = null;
      // invalidateProjectSurfaces owns the production-calendar broadcast (producer: "calendar"
      // suppresses this tab's own refetch; refetchAuthoritative below is the single settle refetch).
      if (queryClient) {
        await invalidateProjectSurfaces(queryClient, { projectId: proposal.event.project.id, resources: [{ kind: "detail" }, { kind: "subtasks" }, { kind: "activity" }], dashboard: true, calendar: true, producer: "calendar" });
      }
      if (accessLostRef.current || token !== operationTokenRef.current) return;
      settleRefetchInFlightRef.current = true;
      const settled = await refetchAuthoritative();
      if (accessLostRef.current || token !== operationTokenRef.current) return;
      settleRefetchInFlightRef.current = false;
      if (settled.ok) {
        setSettle({ type: "refetch-succeeded" });
        setOverlay(null);
        announceLifecycle("saved", { entity: "deadline", street: proposal.event.project.street, newCivil: proposal.localCivil });
      } else if (!accessLostRef.current) {
        setSettle({ type: "refetch-failed", reason: "The latest Calendar could not be loaded." });
        announceLifecycle("settle-failed", { entity: "deadline" });
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
        setMoveDialog({ event: proposal.event, snapshot: proposal.snapshot, initialCivil: proposal.localCivil, foldChoices: choices, drop: proposal.drop, ...(proposal.unscheduledEntry ? { unscheduledEntry: proposal.unscheduledEntry } : {}) });
        if (action.announce) setAnnouncement(action.announce);
        return;
      }

      if (action?.disableMovement) setDeadlineMovementDisabled(true);
      if (!action) {
        setAcceptGate(false);
        commandLockRef.current.active = false;
        await refetchAuthoritative();
        if (accessLostRef.current || token !== operationTokenRef.current) return;
        announceLifecycle("rollback", { entity: "deadline" });
        focusDescriptor({ eventId: proposal.event.id, control: "event" });
        return;
      }

      if (action.refetch) setAcceptGate(false);
      const refreshed = action.refetch ? await refetchAuthoritative() : { ok: false };
      if (accessLostRef.current || token !== operationTokenRef.current) return;
      if (action.retainDraft) {
        const refreshedResponse = refreshed.data ? cloneResponse(refreshed.data) : acceptedResponseRef.current;
        const refreshedEntry = proposal.unscheduledEntry
          ? refreshedResponse?.unscheduled.find((entry): entry is ProjectCalendarUnscheduledEntryDto => entry.id === proposal.unscheduledEntry!.id && entry.kind === "project_deadline")
          : undefined;
        const latest = refreshedEntry
          ? projectDeadlinePlaceholder(refreshedEntry)
          : responseEvent(refreshedResponse, proposal.event.id) ?? proposal.event;
        const nextSnapshot = { ...proposal.snapshot, event: cloneSource(latest) };
        // Rebase the retry onto the authoritative unscheduled entry when the refetch
        // found one — the mapper derives expectedVersion from it, so a stale entry
        // would just conflict again.
        const nextUnscheduledEntry = refreshedEntry ?? proposal.unscheduledEntry;
        commandLockRef.current.active = true;
        setAcceptGate(true);
        setMoveDialog({ event: latest, snapshot: nextSnapshot, initialCivil: proposal.localCivil, drop: proposal.drop, ...(nextUnscheduledEntry ? { unscheduledEntry: nextUnscheduledEntry } : {}) });
      } else {
        commandLockRef.current.active = false;
        setAcceptGate(false);
        focusDescriptor({ eventId: proposal.event.id, control: action.focus });
      }
      if (action.announce) setAnnouncement(action.announce);
    }
  }, [acceptRange, finishInteraction, flushQueuedRefetch, focusDescriptor, handleAccessLoss, announceLifecycle, queryClient, refetchAuthoritative, setAcceptGate, setOverlay, setSettle]);

  const mapAndRunDropProposal = useCallback((snapshot: CalendarAcceptedSnapshot<ProjectDeadlineCalendarEventDto>, event: ProjectDeadlineCalendarEventDto, localCivil: string, subview: "month" | "week", disambiguation: ProjectDeadlineDisambiguation | undefined, drop: CalendarDropInfo) => {
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
        announceLifecycle("dst-gap", { entity: "deadline" });
        return;
      }
      drop.revert();
      setAcceptGate(false);
      commandLockRef.current.active = false;
      snapshotRef.current = null;
      announceLifecycle(mapped.error.code === "nonexistent_local_time" ? "dst-gap" : "invalid", { entity: "deadline" });
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

  const mapAndRunUnscheduledProjectProposal = useCallback((snapshot: CalendarAcceptedSnapshot<ProjectDeadlineCalendarEventDto>, entry: ProjectCalendarUnscheduledEntryDto, event: ProjectDeadlineCalendarEventDto, localCivil: string, target: CalendarManipulationTarget, disambiguation: ProjectDeadlineDisambiguation | undefined, drop?: CalendarRevertable) => {
    const mapped = mapUnscheduledProjectDropToCommand({ event: entry, target, ...(disambiguation ? { disambiguation } : {}) });
    if (!mapped.ok) {
      if (mapped.error.code === "repeated_local_time" && mapped.error.choices) {
        drop?.revert();
        setMoveDialog({ event, snapshot, initialCivil: localCivil, foldChoices: mapped.error.choices, drop, unscheduledEntry: entry });
        return;
      }
      if (mapped.error.code === "nonexistent_local_time") {
        drop?.revert();
        setMoveDialog({ event, snapshot, initialCivil: localCivil, drop, unscheduledEntry: entry });
        announceLifecycle("dst-gap", { entity: "deadline" });
        return;
      }
      drop?.revert();
      setOverlay(null);
      setAcceptGate(false);
      commandLockRef.current.active = false;
      snapshotRef.current = null;
      announceLifecycle("invalid", { entity: "deadline" });
      focusDescriptor({ eventId: entry.id, control: "event" });
      flushQueuedRefetch();
      return;
    }
    if (mapped.value.deadline === null) {
      drop?.revert();
      setAcceptGate(false);
      commandLockRef.current.active = false;
      snapshotRef.current = null;
      return;
    }
    const proposalResult = proposalFromRequest(snapshot, event, mapped.value.deadline.localCivil, disambiguation, mapped.value, drop);
    if (!proposalResult.ok) {
      drop?.revert();
      setAcceptGate(false);
      commandLockRef.current.active = false;
      snapshotRef.current = null;
      return;
    }
    void runConfirmedProposal({ ...proposalResult.proposal, unscheduledEntry: entry });
  }, [flushQueuedRefetch, focusDescriptor, proposalFromRequest, runConfirmedProposal, setAcceptGate, setOverlay]);

  const handleDeadlineDrop = useCallback((info: CalendarDropInfo) => {
    if (actionOnlyWeek) { info.revert(); return; }
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
      announceLifecycle("invalid", { entity: "deadline" });
      return;
    }
    const localCivil = civil.allDay ? proposedCivilForAllDay(event, civil.date) : civil.localCivil;
    const subview = calendar.subview === "month" ? "month" : "week";
    const snapshot = acceptForInteraction(event, { eventId: event.id, control: "event" });
    if (!snapshot) { info.revert(); return; }
    commandLockRef.current.active = true;
    announceLifecycle("picked-up", { entity: "deadline", street: event.project.street, oldCivil: event.deadlineLocalCivil });
    mapAndRunDropProposal(snapshot, event, localCivil, subview, undefined, info);
  }, [acceptForInteraction, actionOnlyWeek, announceLifecycle, calendar.subview, deadlineMovementDisabled, identity.role, mapAndRunDropProposal]);

  const openMoveDialog = useCallback((event: ProjectDeadlineCalendarEventDto) => {
    if (identity.role !== "admin" || !event.permissions.canDrag || deadlineMovementDisabled || settleRef.current.pending || !canStartCalendarCommand(commandLockRef.current)) return;
    const snapshot = acceptForInteraction(event, { eventId: event.id, control: "move-reschedule" });
    if (!snapshot) return;
    commandLockRef.current.active = true;
    announceLifecycle("picked-up", { entity: "deadline", street: event.project.street, oldCivil: event.deadlineLocalCivil });
    setMoveDialog({ event, snapshot, initialCivil: event.deadlineLocalCivil });
  }, [acceptForInteraction, announceLifecycle, deadlineMovementDisabled, identity.role]);

  const openUnscheduledProjectDialog = useCallback((entry: ProjectCalendarUnscheduledEntryDto) => {
    if (calendarInteractionBlocked || settleRef.current.pending || !canDragUnscheduledEntry(entry, rangesEnabled) || !canStartCalendarCommand(commandLockRef.current)) return;
    const sourceSnapshot = acceptForInteraction(entry, { eventId: entry.id, control: "move-reschedule" });
    if (!sourceSnapshot) return;
    const event = projectDeadlinePlaceholder(entry);
    const snapshot = { ...sourceSnapshot, event } as CalendarAcceptedSnapshot<ProjectDeadlineCalendarEventDto>;
    const initialCivil = `${calendar.date}T17:00`;
    commandLockRef.current.active = true;
    announceLifecycle("picked-up", { entity: "deadline", street: entry.project.street, oldCivil: "Not scheduled" });
    setMoveDialog({ event, snapshot, initialCivil, unscheduledEntry: entry });
  }, [acceptForInteraction, announceLifecycle, calendar.date, calendarInteractionBlocked, rangesEnabled]);

  const handleMoveDialogSubmit = useCallback((localCivil: string, disambiguation?: ProjectDeadlineDisambiguation) => {
    const state = moveDialog;
    if (!state || accessLostRef.current) return;
    setMoveDialog(null);
    if (state.unscheduledEntry) {
      mapAndRunUnscheduledProjectProposal(
        state.snapshot,
        state.unscheduledEntry,
        state.event,
        localCivil,
        { subview: "week", targetDate: localCivil.slice(0, 10), targetCivilMinute: localCivil },
        disambiguation,
        state.drop,
      );
      return;
    }
    if (state.subview && state.drop) {
      mapAndRunDropProposal(state.snapshot, state.event, localCivil, state.subview, disambiguation, state.drop as CalendarDropInfo);
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
        announceLifecycle("fold-choice", { entity: "deadline" });
      } else if (proposalResult.reason === "gap") {
        setMoveDialog({ ...state, initialCivil: localCivil, foldChoices: undefined });
        announceLifecycle("dst-gap", { entity: "deadline" });
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
  }, [finishInteraction, isUnchangedDeadlineProposal, mapAndRunDropProposal, mapAndRunUnscheduledProjectProposal, moveDialog, proposalFromRequest, runConfirmedProposal, setAcceptGate]);

  const handleMoveDialogCancel = useCallback(() => {
    const state = moveDialog;
    if (!state) return;
    finishInteraction(state.drop, state.snapshot.event.deadlineLocalCivil);
  }, [finishInteraction, moveDialog]);

  const finishChecklistInteraction = useCallback((operation: ChecklistOperationInfo, source: ChecklistSource, announcement?: { kind: Parameters<typeof calendarAnnouncement>[0]; context?: Omit<Parameters<typeof calendarAnnouncement>[1], "entity"> }, flush = true) => {
    operation.drop?.revert();
    operation.resize?.revert();
    setOverlay(null);
    setScheduleEditor(null);
    setChecklistFold(null);
    commandLockRef.current.active = false;
    snapshotRef.current = null;
    setAcceptGate(false);
    if (announcement) announceChecklistLifecycle(announcement.kind, announcement.context ?? {});
    focusDescriptor({ eventId: source.id, control: "event" });
    if (flush) flushQueuedRefetch();
  }, [announceChecklistLifecycle, flushQueuedRefetch, focusDescriptor, setAcceptGate, setOverlay]);

  const runChecklistMutation = useCallback(async (proposal: ChecklistProposal) => {
    const token = operationTokenRef.current;
    if (accessLostRef.current || token !== operationTokenRef.current) return;
    const normalizedSchedule = normalizeChecklistSchedule(proposal.schedule, proposal.source.schedule.version);
    const optimisticEvent = !(("timing" in proposal.source)) && normalizedSchedule.ok
      ? optimisticChecklistEvent(proposal.source, checklistScheduleToDto(normalizedSchedule.value))
      : null;
    setOverlay(proposal.timing
      ? optimisticEvent
        ? { kind: "reschedule-unscheduled", entryId: proposal.source.id, timing: proposal.timing, asEvent: optimisticEvent }
        : { eventId: proposal.source.id, timing: proposal.timing }
      : null);
    announceChecklistLifecycle("saving", { street: proposal.source.project.street });
    try {
      // The captured role chooses the response arm before this request. The
      // internal Worker DTO is intentionally not treated as the External DTO.
      const response = await apiPatch<unknown, { schedule: SaveChecklistScheduleRequest }>(
        `/api/projects/${encodeURIComponent(proposal.source.project.id)}/subtasks/${encodeURIComponent(proposal.source.id)}`,
        { schedule: proposal.request },
      );
      if (accessLostRef.current || token !== operationTokenRef.current) return;
      const result = decodeChecklistMutationResponse(identity.role, response);
      const noop = result.scheduleVersion === proposal.source.schedule.version
        && checklistSchedulesEqual(result.schedule, proposal.source.schedule);
      const baseline = acceptedResponseRef.current;
      if (baseline) acceptRange(adoptChecklistResult(baseline, proposal.source, result), false);
      setChecklistNeedsAttention((current) => { const next = new Set(current); next.delete(proposal.source.id); return next; });
      if (noop) {
        setOverlay(null);
        setScheduleEditor(null);
        setChecklistFold(null);
        commandLockRef.current.active = false;
        snapshotRef.current = null;
        setAcceptGate(false);
        announceChecklistLifecycle("no-change", {});
        flushQueuedRefetch();
        return;
      }

      setScheduleEditor(null);
      setChecklistFold(null);
      setAcceptGate(false);
      setSettle({ type: "winner" });
      commandLockRef.current.active = false;
      snapshotRef.current = null;
      // invalidateProjectSurfaces owns the production-calendar broadcast (producer: "calendar").
      if (queryClient) {
        await invalidateProjectSurfaces(queryClient, { projectId: proposal.source.project.id, resources: [{ kind: "detail" }, { kind: "subtasks" }, { kind: "activity" }], dashboard: false, calendar: true, producer: "calendar" });
      }
      if (accessLostRef.current || token !== operationTokenRef.current) return;
      settleRefetchInFlightRef.current = true;
      const settled = await refetchAuthoritative();
      if (accessLostRef.current || token !== operationTokenRef.current) return;
      settleRefetchInFlightRef.current = false;
      if (settled.ok) {
        setSettle({ type: "refetch-succeeded" });
        setOverlay(null);
        announceChecklistLifecycle("saved", { street: proposal.source.project.street });
      } else if (!accessLostRef.current) {
        setSettle({ type: "refetch-failed", reason: "The latest Calendar could not be loaded." });
        announceChecklistLifecycle("settle-failed", {});
      }
    } catch (error) {
      if (accessLostRef.current || token !== operationTokenRef.current) return;
      const action = classifyChecklistFailure(error, { eventId: proposal.source.id, fromEditor: proposal.operation.editor });
      if (action?.accessLoss || (error instanceof ApiError && (error.status === 401 || error.status === 403))) {
        handleAccessLoss();
        return;
      }

      proposal.operation.drop?.revert();
      proposal.operation.resize?.revert();
      setOverlay(null);
      if (action?.rangeDisabled) setChecklistRangeSchedulingDisabled(true);
      if (action?.needsAttention) setChecklistNeedsAttention((current) => new Set(current).add(proposal.source.id));

      if (action?.askFold) {
        const choices = endpointChoicesFromError(error);
        const endpoint = endpointOfError(error);
        if (choices.length && endpoint) {
          const priorChoice = inputDisambiguation(proposal.schedule, endpoint);
          if (proposal.operation.editor) {
            setAcceptGate(true);
            commandLockRef.current.active = true;
            setScheduleEditor({ source: proposal.source, snapshot: proposal.snapshot, initialSchedule: proposal.schedule, validationError: { code: action.code, message: action.announce, endpoint, choices } });
          } else {
            setAcceptGate(true);
            commandLockRef.current.active = true;
            setChecklistFold({ proposal, disambiguation: { ...(priorChoice && endpoint === "start" ? { start: priorChoice } : {}), ...(priorChoice && endpoint === "end" ? { end: priorChoice } : {}) }, endpoint, choices });
          }
          setAnnouncement(action.announce);
          return;
        }
      }

      if (!action) {
        setAcceptGate(false);
        commandLockRef.current.active = false;
        snapshotRef.current = null;
        await refetchAuthoritative();
        if (accessLostRef.current || token !== operationTokenRef.current) return;
        announceChecklistLifecycle("rollback", {});
        focusDescriptor({ eventId: proposal.source.id, control: "event" });
        return;
      }

      if (action.refetch) setAcceptGate(false);
      const refreshed = action.refetch ? await refetchAuthoritative() : { ok: false };
      if (accessLostRef.current || token !== operationTokenRef.current) return;
      if (action.retainDraft) {
        const latest = checklistSourceFromResponse(refreshed.data ? cloneResponse(refreshed.data) : acceptedResponseRef.current, proposal.source.id) ?? proposal.source;
        const nextSnapshot: ChecklistSnapshot = { ...proposal.snapshot, event: cloneSource(latest) };
        commandLockRef.current.active = true;
        setAcceptGate(true);
        setScheduleEditor({ source: latest, snapshot: nextSnapshot, initialSchedule: proposal.schedule, validationError: { code: action.code, message: action.announce, ...(endpointOfError(error) ? { endpoint: endpointOfError(error) } : {}) } });
      } else {
        setScheduleEditor(null);
        setChecklistFold(null);
        commandLockRef.current.active = false;
        setAcceptGate(false);
        focusDescriptor({ eventId: proposal.source.id, control: action.focus });
      }
      setAnnouncement(action.announce);
      if (!action.refetch) flushQueuedRefetch();
    }
  }, [acceptRange, announceChecklistLifecycle, flushQueuedRefetch, focusDescriptor, handleAccessLoss, identity.role, queryClient, refetchAuthoritative, setAcceptGate, setOverlay, setSettle]);

  const mapChecklistCommand = useCallback((snapshot: ChecklistSnapshot, event: ChecklistSource, target: CalendarManipulationTarget, operation: ChecklistOperationInfo, disambiguation?: ChecklistDisambiguation, edge?: "end") => {
    const mapped = edge
      ? mapChecklistEndResizeToCommand({ event: snapshot.event as ChecklistCalendarEventDto, target: { ...target, edge: "end" }, edge: "end", ...(disambiguation ? { disambiguation } : {}) })
      : "reason" in event && event.reason === "unscheduled"
        ? mapUnscheduledChecklistDropToCommand({ event: snapshot.event as ChecklistCalendarUnscheduledEntryDto, target, ...(disambiguation ? { disambiguation } : {}) })
        : mapChecklistMoveToCommand({ event: snapshot.event as ChecklistCalendarEventDto, target, ...(disambiguation ? { disambiguation } : {}) });
    if (!mapped.ok) {
      const repeated = mapped.error.code === "repeated_local_time" || mapped.error.code === "subtask_schedule_repeated_local_time";
      const nonexistent = mapped.error.code === "nonexistent_local_time" || mapped.error.code === "subtask_schedule_nonexistent_local_time";
      if (repeated && mapped.error.choices && mapped.error.endpoint) {
        const sourceSchedule = checklistInputFromSchedule(event.schedule);
        const proposal: ChecklistProposal = { snapshot, source: event, request: { expectedVersion: event.schedule.version, schedule: sourceSchedule }, schedule: sourceSchedule, timing: "timing" in event ? event.timing : null, operation, target, ...(edge ? { edge } : {}) };
        setChecklistFold({ proposal, disambiguation: typeof disambiguation === "object" ? disambiguation : {}, endpoint: mapped.error.endpoint, choices: mapped.error.choices });
        announceChecklistLifecycle("fold-choice", {});
        return;
      }
      finishChecklistInteraction(operation, event, { kind: nonexistent ? "dst-gap" : "invalid" });
      return;
    }
    if (!rangesEnabled && mapped.value.schedule.state === "range") {
      finishChecklistInteraction(operation, event, { kind: "range-disabled" });
      return;
    }
    const normalized = normalizeChecklistSchedule(mapped.value.schedule, mapped.value.expectedVersion);
    if (!normalized.ok) {
      finishChecklistInteraction(operation, event, { kind: "invalid" });
      return;
    }
    const proposal: ChecklistProposal = {
      snapshot,
      source: event,
      request: mapped.value,
      schedule: mapped.value.schedule,
      timing: timingFromChecklistSchedule(checklistScheduleToDto(normalized.value)),
      operation,
      target,
      ...(edge ? { edge } : {}),
    };
    void runChecklistMutation(proposal);
  }, [announceChecklistLifecycle, finishChecklistInteraction, rangesEnabled, runChecklistMutation]);

  const handleChecklistFoldSubmit = useCallback((choice: "earlier" | "later") => {
    const state = checklistFold;
    if (!state || state.proposal.source.kind !== "checklist" || !state.proposal.target) return;
    const next = { ...state.disambiguation, [state.endpoint]: choice } as { start?: "earlier" | "later"; end?: "earlier" | "later" };
    setChecklistFold(null);
    mapChecklistCommand(state.proposal.snapshot, state.proposal.source, state.proposal.target, state.proposal.operation, next, state.proposal.edge);
  }, [checklistFold, mapChecklistCommand]);

  const handleChecklistFoldCancel = useCallback(() => {
    const state = checklistFold;
    if (!state) return;
    finishChecklistInteraction(state.proposal.operation, state.proposal.source, { kind: "cancelled" });
  }, [checklistFold, finishChecklistInteraction]);

  const handleChecklistDrop = useCallback((info: CalendarDropInfo) => {
    if (actionOnlyWeek) { info.revert(); return; }
    const dto = info.event.extendedProps.dto;
    if (!dto || typeof dto !== "object" || (dto as { kind?: unknown }).kind !== "checklist") { info.revert(); return; }
    const event = dto as ChecklistCalendarEventDto;
    if (!event.permissions.canDrag || (event.schedule.state === "range" && (!rangesEnabled || !event.permissions.canScheduleRange)) || settleRef.current.pending || calendar.subview === "agenda" || !canStartCalendarCommand(commandLockRef.current)) { info.revert(); return; }
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
    commandLockRef.current.active = true;
    announceChecklistLifecycle("picked-up", { street: event.project.street, oldCivil: checklistCurrentCivil(event), overlap: event.status.sameAssigneeOverlap === true, assignee: event.assignee?.name });
    mapChecklistCommand(snapshot, event, target, { drop: info });
  }, [acceptForInteraction, actionOnlyWeek, announceChecklistLifecycle, calendar.subview, focusDescriptor, mapChecklistCommand, rangesEnabled]);

  const handleChecklistResize = useCallback((info: CalendarResizeInfo) => {
    if (actionOnlyWeek) { info.revert(); return; }
    const dto = info.event.extendedProps.dto;
    if (!dto || typeof dto !== "object" || (dto as { kind?: unknown }).kind !== "checklist") { info.revert(); return; }
    const event = dto as ChecklistCalendarEventDto;
    if (event.schedule.state !== "range" || !event.permissions.canResize || !event.permissions.canScheduleRange || !rangesEnabled || settleRef.current.pending || calendar.subview === "agenda" || !canStartCalendarCommand(commandLockRef.current)) { info.revert(); return; }
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
    commandLockRef.current.active = true;
    announceChecklistLifecycle("picked-up", { street: event.project.street, oldCivil: checklistCurrentCivil(event), overlap: event.status.sameAssigneeOverlap === true, assignee: event.assignee?.name });
    mapChecklistCommand(snapshot, event, target, { resize: info }, undefined, "end");
  }, [acceptForInteraction, actionOnlyWeek, announceChecklistLifecycle, calendar.subview, focusDescriptor, mapChecklistCommand, rangesEnabled]);

  const handleUnscheduledDrop = useCallback((info: CalendarExternalDropInfo) => {
    if (calendar.subview === "agenda" || actionOnlyWeek || calendarInteractionBlocked || settleRef.current.pending || !canStartCalendarCommand(commandLockRef.current)) {
      return;
    }
    const unscheduledId = info.draggedEl.dataset.unscheduledId;
    const unscheduledKind = info.draggedEl.dataset.unscheduledKind;
    const accepted = acceptedResponseRef.current;
    const entry = accepted?.unscheduled.find((candidate) => candidate.id === unscheduledId && (
      unscheduledKind === "project" ? candidate.kind === "project_deadline" : unscheduledKind === "checklist" && candidate.kind === "checklist"
    ));
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
    commandLockRef.current.active = true;
    if (entry.kind === "project_deadline") {
      const event = projectDeadlinePlaceholder(entry);
      const deadlineSnapshot = { ...snapshot, event } as CalendarAcceptedSnapshot<ProjectDeadlineCalendarEventDto>;
      const localCivil = subview === "month" ? `${targetDate}T17:00` : target.targetCivilMinute!;
      announceLifecycle("picked-up", { entity: "deadline", street: entry.project.street, oldCivil: "Not scheduled" });
      mapAndRunUnscheduledProjectProposal(deadlineSnapshot, entry, event, localCivil, target, undefined, undefined);
      return;
    }
    mapChecklistCommand(snapshot as ChecklistSnapshot, entry, target, { external: true });
  }, [acceptForInteraction, actionOnlyWeek, announceChecklistLifecycle, announceLifecycle, calendar.subview, calendarInteractionBlocked, mapAndRunUnscheduledProjectProposal, mapChecklistCommand, rangesEnabled, setAcceptGate]);

  const handleUnscheduledReceive = useCallback((info: CalendarExternalReceiveInfo) => {
    info.revert();
  }, []);

  const openChecklistScheduleEditor = useCallback((source: ChecklistSource, initialSchedule?: InitialChecklistScheduleInput) => {
    if (source.schedule.state === "invalid" || !source.permissions.canOpenScheduleEditor || calendarInteractionBlocked || settleRef.current.pending || !canStartCalendarCommand(commandLockRef.current)) return;
    const snapshot = acceptForInteraction(source, { eventId: source.id, control: "move-reschedule" });
    if (!snapshot) return;
    commandLockRef.current.active = true;
    announceChecklistLifecycle("picked-up", {
      street: source.project.street,
      oldCivil: "timing" in source ? checklistCurrentCivil(source) : "Not scheduled",
      ...("timing" in source && source.assignee?.name ? { assignee: source.assignee.name } : {}),
      ...("timing" in source && source.status.sameAssigneeOverlap === true ? { overlap: true } : {}),
    });
    setScheduleEditor({ source, snapshot, ...(initialSchedule ? { initialSchedule } : {}) });
  }, [acceptForInteraction, announceChecklistLifecycle, calendarInteractionBlocked]);

  const openUnscheduledChecklistScheduleEditor = useCallback((entry: ChecklistCalendarUnscheduledEntryDto) => {
    const initialSchedule: InitialChecklistScheduleInput | undefined = entry.reason === "unscheduled"
      ? { state: "due_only", end: { kind: "date", localCivil: calendar.date } }
      : undefined;
    openChecklistScheduleEditor(entry, initialSchedule);
  }, [calendar.date, openChecklistScheduleEditor]);

  const handleScheduleEditorSubmit = useCallback((schedule: InitialChecklistScheduleInput) => {
    const state = scheduleEditor;
    if (!state || accessLostRef.current) return;
    if ((!rangesEnabled || !state.source.permissions.canScheduleRange) && schedule.state === "range") {
      setScheduleEditor({ ...state, initialSchedule: schedule, validationError: { code: "subtask_schedule_ranges_disabled", message: "Range scheduling is unavailable in this app version." } });
      return;
    }
    const normalized = normalizeChecklistSchedule(schedule, state.source.schedule.version);
    if (!normalized.ok) {
      setScheduleEditor({ ...state, initialSchedule: schedule, validationError: normalized.error });
      return;
    }
    const proposal: ChecklistProposal = {
      snapshot: state.snapshot,
      source: state.source,
      request: { expectedVersion: state.source.schedule.version, schedule },
      schedule,
      timing: timingFromChecklistSchedule(checklistScheduleToDto(normalized.value)),
      operation: { editor: true },
    };
    setScheduleEditor(null);
    void runChecklistMutation(proposal);
  }, [rangesEnabled, runChecklistMutation, scheduleEditor]);

  const handleScheduleEditorCancel = useCallback(() => {
    const state = scheduleEditor;
    if (!state) return;
    finishChecklistInteraction({ editor: true }, state.source, { kind: "cancelled" });
  }, [finishChecklistInteraction, scheduleEditor]);

  const handleCalendarDrop = useCallback((info: CalendarDropInfo) => {
    const dto = info.event.extendedProps.dto;
    if (dto && typeof dto === "object" && (dto as { kind?: unknown }).kind === "checklist") handleChecklistDrop(info);
    else handleDeadlineDrop(info);
  }, [handleChecklistDrop, handleDeadlineDrop]);

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
    <section className="qc-calendar-screen" aria-label="Production Calendar" tabIndex={-1} data-focus-key="calendar-safe-fallback" data-reduced-motion={prefersReducedMotion ? "true" : undefined}>
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

      {acceptedResponse && !calendarAccessLost && <div className="qc-calendar-layout">
        <div className="qc-calendar-grid">
          {acceptedResponse.events.length === 0 && <div className="empty qc-calendar-state" role="status">No scheduled work in this range.</div>}
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
              return dto ? <ProductionCalendarEvent event={dto} subview={calendar.subview} needsAttention={checklistNeedsAttention.has(dto.id)} projectHref={projectHrefFor?.(dto.project.id)} onOpenProject={() => onOpenProject?.(dto.project.id)} onProjectAnchorClick={onProjectAnchorClick} onMoveReschedule={calendarSettle.pending || calendarInteractionBlocked ? undefined : openMoveDialog} onChecklistSchedule={calendarSettle.pending || calendarInteractionBlocked ? undefined : openChecklistScheduleEditor} /> : null;
            }}
          />

          {calendar.subview === "month" && selectedDay !== null && (
            <section className="qc-calendar-disclosure" aria-label="Selected day">
              <div className="ey">Selected day · {selectedDay}</div>
              {selectedEvents.length === 0 ? <p className="muted">No scheduled work on this day.</p> : <div className="qc-calendar-disclosure__events">{selectedEvents.map((event) => <ProductionCalendarEvent key={event.id} event={event} subview={calendar.subview} compact needsAttention={checklistNeedsAttention.has(event.id)} projectHref={projectHrefFor?.(event.project.id)} onOpenProject={() => onOpenProject?.(event.project.id)} onProjectAnchorClick={onProjectAnchorClick} onMoveReschedule={calendarSettle.pending || calendarInteractionBlocked ? undefined : openMoveDialog} />)}</div>}
            </section>
          )}
        </div>
        <ProductionCalendarUnscheduledPanel
          projectEntries={projectUnscheduledEntries}
          checklistEntries={checklistUnscheduledEntries}
          facets={unscheduledFacets}
          subview={calendar.subview}
          rangesEnabled={rangesEnabled}
          onScheduleProject={openUnscheduledProjectDialog}
          onScheduleChecklist={openUnscheduledChecklistScheduleEditor}
          disabled={calendarInteractionBlocked || calendarSettle.pending}
          dragSuppressed={actionOnlyWeek}
          projectHrefFor={projectHrefFor}
          onOpenProject={onOpenProject}
          onProjectAnchorClick={onProjectAnchorClick}
        />
      </div>}
      <div className="dashboard-live-region sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
      {moveDialog && <ProductionCalendarMoveDialog event={moveDialog.event} initialCivil={moveDialog.initialCivil} foldChoices={moveDialog.foldChoices} onSubmit={handleMoveDialogSubmit} onCancel={handleMoveDialogCancel} />}
      {scheduleEditor && <ProductionCalendarScheduleEditor key={`${scheduleEditor.source.id}:${JSON.stringify(scheduleEditor.initialSchedule ?? null)}`} event={scheduleEditor.source} rangesEnabled={rangesEnabled && scheduleEditor.source.permissions.canScheduleRange} initialSchedule={scheduleEditor.initialSchedule} validationError={scheduleEditor.validationError} onSubmit={handleScheduleEditorSubmit} onCancel={handleScheduleEditorCancel} />}
      {checklistFold && <ProductionCalendarFoldChoice endpoint={checklistFold.endpoint} choices={checklistFold.choices} eyebrow={checklistFold.proposal.source.project.street} onSubmit={handleChecklistFoldSubmit} onCancel={handleChecklistFoldCancel} />}
    </section>
  );
}
