import { useCallback, useEffect, useRef, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import {
  checklistScheduleToDto,
  normalizeChecklistSchedule,
  previewProjectDeadlineReminderConsequences,
  type ProjectDeadlineReminderConsequence,
  resolveSydneyCivilMinute,
  subtaskIdFromCalendarEntityId,
  CHECKLIST_SCHEDULE_RANGES_ENABLED,
  type CalendarEventTiming,
  type CalendarManipulationTarget,
  type CalendarUnscheduledEntryDto,
  type ChecklistCalendarEventDto,
  type ChecklistCalendarUnscheduledEntryDto,
  type ChecklistDisambiguation,
  type DashboardCalendarState,
  type InitialChecklistScheduleInput,
  type ProjectCalendarUnscheduledEntryDto,
  type ProjectDeadlineCalendarEventDto,
  type ProjectDeadlineDisambiguation,
  type ProductionCalendarFilters,
  type ProductionCalendarRangeResponse,
  type SaveChecklistScheduleRequest,
  type SaveProjectDeadlineRequest,
} from "@quincy/shared";
import type { DashboardIdentity } from "./dashboard-projects";
import type { ChecklistMutationResult, SaveResponse } from "./scheduling-types";
import { ApiError, apiPatch, apiPut } from "./api";
import { confirm, confirmStore } from "./confirm";
import { invalidateProjectSurfaces, useOptionalProjectQueryClient } from "./project-data";
import { decodeChecklistMutationResponse, productionCalendarFiltersFor, removeProductionCalendarQueries, useProductionCalendarRange } from "./production-calendar-query";
import {
  adoptChecklistResult,
  canonicalChecklistEvent,
  canonicalEventFromSchedule,
  checklistCurrentCivil,
  checklistInputFromSchedule,
  checklistSchedulesEqual,
  checklistSourceFromResponse,
  choicesFromError,
  cloneFilters,
  cloneResponse,
  currentMatchesSource,
  endpointChoicesFromError,
  endpointOfError,
  inputDisambiguation,
  optimisticChecklistEvent,
  planSchedulingProposal,
  projectDeadlinePlaceholder,
  proposedCivilForAllDay,
  responseEvent,
  timingFromChecklistSchedule,
  type ChecklistSource,
  type ScheduleBounds,
  type SchedulingProposal,
  type SchedulingWarning,
} from "./scheduling-policy";
import { scheduleWarningText, scheduleWindowWarnings } from "./schedule-bounds";
import { applyUndo, type UndoOutcome, type UndoTicket } from "./scheduling-undo";
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
} from "./production-calendar-interaction";
import { ProductionCalendarMoveConfirmation } from "../components/ProductionCalendarMoveConfirmation";
import type { ProductionCalendarScheduleEditorError } from "../components/ProductionCalendarScheduleEditorFields";
import type {
  CalendarDropInfo,
  CalendarRevertable,
  CalendarResizeInfo,
} from "./scheduling-types";

/**
 * §216 step 4: the scheduling/mutation controller extracted from the (since deleted, #224) `ProductionCalendar.tsx`. A
 * pure move of state, refs, effects and command bodies — that component kept
 * every FullCalendar handler and the JSX render; this hook owns the interaction lifecycle
 * (accept/settle/optimistic-overlay/dialogs) and the network round trips. See docs/lessons.md
 * for the retained-dialog and open-token patterns this hook's state still has to honor.
 */

export type MoveDialogState = {
  event: ProjectDeadlineCalendarEventDto;
  snapshot: CalendarAcceptedSnapshot<ProjectDeadlineCalendarEventDto>;
  initialCivil: string;
  foldChoices?: Array<{ disambiguation: ProjectDeadlineDisambiguation; utcOffsetMinutes: number }>;
  drop?: CalendarRevertable;
  subview?: "month" | "week";
  unscheduledEntry?: ProjectCalendarUnscheduledEntryDto;
};

export type DeadlineProposal = {
  snapshot: CalendarAcceptedSnapshot<ProjectDeadlineCalendarEventDto>;
  event: ProjectDeadlineCalendarEventDto;
  localCivil: string;
  disambiguation?: ProjectDeadlineDisambiguation;
  request: SaveProjectDeadlineRequest;
  timing: CalendarEventTiming;
  drop?: CalendarRevertable;
  unscheduledEntry?: ProjectCalendarUnscheduledEntryDto;
};

export type DeadlineFoldChoice = { disambiguation: ProjectDeadlineDisambiguation; utcOffsetMinutes: number };

export type DeadlineProposalResult =
  | { ok: true; proposal: DeadlineProposal }
  | { ok: false; reason: "fold"; choices: DeadlineFoldChoice[] }
  | { ok: false; reason: "gap" }
  | { ok: false; reason: "invalid" };

export type ChecklistSnapshot = CalendarAcceptedSnapshot<ChecklistSource>;
export type ChecklistOperationInfo = {
  drop?: CalendarRevertable;
  resize?: CalendarResizeInfo;
  editor?: boolean;
  external?: boolean;
};
export type ChecklistProposal = {
  snapshot: ChecklistSnapshot;
  source: ChecklistSource;
  request: SaveChecklistScheduleRequest;
  schedule: InitialChecklistScheduleInput;
  timing: CalendarEventTiming | null;
  operation: ChecklistOperationInfo;
  target?: CalendarManipulationTarget;
  /**
   * #216 fix round 1 item 4: widened from `"end"`-only so a `submitProposal` start-resize can
   * retry through the same fold-dialog path as an end-resize. Purely additive — every pre-#216
   * caller (`handleChecklistDrop`/`handleChecklistResize`) still only ever passes `"end"` or
   * `undefined`, so this changes no existing behaviour.
   */
  edge?: "start" | "end";
  /** #221: the plan's bounds warnings (`planSchedulingProposal` → the shared `scheduleWindowWarnings`,
   * `schedule-bounds.ts`). Only set when non-empty, and only when the port supplies bounds
   * (`SchedulingPort.boundsFor`): the Gantt and, since #222, the event-calendar renderer (from its
   * `bounds=1` response) do; the retired FullCalendar renderer did not. */
  warnings?: SchedulingWarning[];
};
export type ChecklistFoldState = {
  proposal: ChecklistProposal;
  disambiguation: { start?: "earlier" | "later"; end?: "earlier" | "later" };
  endpoint: "start" | "end";
  choices: Array<{ disambiguation: "earlier" | "later"; utcOffsetMinutes: number }>;
};
export type ScheduleEditorState = {
  source: ChecklistSource;
  snapshot: ChecklistSnapshot;
  initialSchedule?: InitialChecklistScheduleInput;
  validationError?: ProductionCalendarScheduleEditorError;
};

/** #216 fix round 2 item 1: `submitProposal`'s own gate result — "busy" when `canStartCommand()`
 * was already false (an open confirmation/settle, or another command mid-flight), "not-accepted"
 * on the rarer `acceptForInteraction` failure (access lost / no data yet). Either way, no side
 * effects: the active snapshot/lock are left exactly as they were. */
export type SubmitProposalOutcome = { ok: true } | { ok: false; reason: "busy" | "not-accepted" };

export type SchedulingCommandsInput = {
  identity: DashboardIdentity;
  calendar: DashboardCalendarState;
  resetKey: string;
  query: ReturnType<typeof useProductionCalendarRange>;
  onAcceptGateChange?: (blocked: boolean) => void;
  onSettleStateChange?: (state: CalendarSettleState) => void;
  onAccessLoss?: () => void;
};

/**
 * #221: every data-access decision the scheduling controller makes, behind one port, so the same
 * orchestration (lock, token fencing, settle, access loss, fold/gap, retainDraft, unmount
 * withdrawal, announcements) drives both the Calendar and the Gantt. The port object may change
 * identity every render — the controller reads it through a ref. Its only reactive members are
 * `latest`/`latestStamp` (accept effect) and `latestError` (access-loss effect).
 */
export type SchedulingPort<TBaseline> = {
  /** Accept-eligible data (the Calendar also requires the server-echoed route date to match). */
  latest: TBaseline | undefined;
  /** Raw latest data with NO eligibility check — `acceptForInteraction`'s pre-accept fallback. */
  latestUnchecked: TBaseline | undefined;
  latestStamp: number;
  latestError: unknown;
  refetch: () => Promise<{ data?: TBaseline; error?: unknown; isError: boolean }>;
  clone: (baseline: TBaseline) => TBaseline;
  /** Heals client-only needs-attention markers off an authoritative baseline; returns `current`
   * itself when nothing changed. */
  healNeedsAttention: (current: Set<string>, baseline: TBaseline) => Set<string>;
  snapshotFilters: () => ProductionCalendarFilters;
  findUnscheduledEntry: (baseline: TBaseline, id: string | undefined, kind: string | undefined) => CalendarUnscheduledEntryDto | undefined;
  findChecklist: (baseline: TBaseline, id: string) => ChecklistSource | undefined;
  findDeadline: (baseline: TBaseline, eventId: string) => ProjectDeadlineCalendarEventDto | undefined;
  findUnscheduledDeadline: (baseline: TBaseline, entryId: string) => ProjectCalendarUnscheduledEntryDto | undefined;
  adoptChecklist: (baseline: TBaseline, source: ChecklistSource, result: ChecklistMutationResult) => TBaseline;
  adoptDeadline: (baseline: TBaseline, event: ProjectDeadlineCalendarEventDto, current: SaveResponse["current"]) => TBaseline;
  purge: (queryClient: QueryClient) => void;
  invalidation: (kind: "checklist" | "deadline", projectId: string) => Parameters<typeof invalidateProjectSurfaces>[1];
  defaultPlacementDate: () => string;
  settleFailedReason: string;
  /**
   * #288: the project's advisory scheduling window, or `null` when unknown. The controller runs the
   * ONE shared out-of-range rule (`scheduleWindowWarnings`, `schedule-bounds.ts`) over it twice: in
   * the plan (`ChecklistProposal.warnings`), and over the schedule the server actually SAVED — that
   * text is appended to the "saved" announcement (` Warning: <text>`, the vendor's
   * `dropWarningSuffix` wording) and handed to `onCommitted` as `warningText`. Absent (the
   * retired FullCalendar renderer): no warnings, and the announcement is unchanged.
   */
  boundsFor?: (projectId: string) => ScheduleBounds | null;
  /**
   * #221 PR C: a surface-owned Deadline confirmation. When present, `runConfirmedProposal` awaits
   * this instead of the shared `confirm()` modal; absent (the Calendar), behaviour is unchanged.
   * `signal` aborts when the controller withdraws the confirmation (unmount, reset, access loss) —
   * the surface must close its dialog and resolve `false`.
   */
  confirmDeadline?: (input: SchedulingDeadlineConfirmInput) => Promise<boolean>;
};

/** #221 PR C: the public shape of a Deadline awaiting confirmation (`SchedulingPort.confirmDeadline`). */
export type SchedulingDeadlineConfirmInput = {
  proposal: {
    street: string;
    projectId: string;
    oldCivil: string;
    newCivil: string;
    /** The resolved new instant; `null` only for the defensive all-day shape. */
    newInstant: string | null;
    /** `true` when placing a Deadline that was not set (the dialog says "Schedule"). */
    scheduling: boolean;
  };
  consequences: ProjectDeadlineReminderConsequence[];
  signal: AbortSignal;
};

/** #221: fired once per successful NON-noop mutation, right after the response is decoded and
 * before invalidation — the Gantt builds its Undo ticket from it. */
export type SchedulingCommittedInfo =
  | {
      kind: "checklist";
      projectId: string;
      before: ChecklistSource;
      checklistResult: ChecklistMutationResult;
      warnings: SchedulingWarning[];
      /** The shared rule's text over the SAVED schedule and `boundsFor` — the same text the live
       * announcement carries; `null` when in range or the port has no `boundsFor`. */
      warningText: string | null;
    }
  | {
      kind: "deadline";
      projectId: string;
      before: ProjectDeadlineCalendarEventDto;
      deadlineResult: SaveResponse;
      warnings: SchedulingWarning[];
    };

export type SchedulingControllerInput<TBaseline> = {
  identity: DashboardIdentity;
  resetKey: string;
  port: SchedulingPort<TBaseline>;
  onAcceptGateChange?: (blocked: boolean) => void;
  onSettleStateChange?: (state: CalendarSettleState) => void;
  onAccessLoss?: () => void;
  onCommitted?: (info: SchedulingCommittedInfo) => void;
  /** After a successful Undo, before its refetch: lets a surface patch rows the refetch won't
   * return (the Gantt's continuation pages). Checklist Undo carries the decoded restored row. */
  onUndone?: (info: { kind: "checklist" | "deadline"; projectId: string; checklistResult?: ChecklistMutationResult }) => void;
};

export type RunUndoOutcome = UndoOutcome | { ok: false; reason: "busy" };

export type SchedulingController<TBaseline> = {
  acceptedResponse: TBaseline | null;
  interactionBlocked: boolean;
  optimisticOverlay: CalendarOptimisticOverlay;
  settle: CalendarSettleState;
  announcement: string;
  accessLost: boolean;
  checklistNeedsAttention: Set<string>;
  deadlineMovementDisabled: boolean;
  checklistRangeSchedulingDisabled: boolean;
  moveDialog: MoveDialogState | null;
  scheduleEditor: ScheduleEditorState | null;
  checklistFold: ChecklistFoldState | null;
  /**
   * #216 fix round 1 item 4, gated per fix round 2 item 1: the typed-proposal entry point. Checks
   * `canStartCommand()` first — same gate the (retired) FullCalendar handlers checked externally before their
   * own `acceptForInteraction` call — so a second `submitProposal` while one is already
   * pending/confirming is rejected with no side effects, rather than overwriting the active
   * snapshot and running two concurrent flows. On success, plans the `SchedulingProposal` via
   * `planSchedulingProposal` and feeds the plan into the SAME internal accept/plan/confirm/mutate
   * functions (`runChecklistProposal`/`runDeadlineProposal`) the move dialog's and checklist fold's
   * retries call too — fix round 2 item 3: one path, not two.
   */
  submitProposal: (proposal: SchedulingProposal, options?: { revertable?: CalendarRevertable }) => SubmitProposalOutcome;
  /** #221: applies an Undo ticket (a compensating versioned mutation, `applyUndo`) under the same
   * command lock/accept gate/token fence as a forward edit. "busy" when `canStartCommand()` is
   * false; never retried on conflict. */
  runUndo: (ticket: UndoTicket) => Promise<RunUndoOutcome>;
  openMoveDialog: (event: ProjectDeadlineCalendarEventDto) => void;
  openUnscheduledProjectDialog: (entry: ProjectCalendarUnscheduledEntryDto) => void;
  openChecklistScheduleEditor: (source: ChecklistSource, initialSchedule?: InitialChecklistScheduleInput) => void;
  openUnscheduledChecklistScheduleEditor: (entry: ChecklistCalendarUnscheduledEntryDto) => void;
  submitMoveDialog: (localCivil: string, disambiguation?: ProjectDeadlineDisambiguation) => void;
  cancelMoveDialog: () => void;
  submitScheduleEditor: (schedule: InitialChecklistScheduleInput) => void;
  cancelScheduleEditor: () => void;
  submitChecklistFold: (choice: "earlier" | "later") => void;
  cancelChecklistFold: () => void;
  acceptForInteraction: <TEvent extends CalendarInteractionSource>(event: TEvent, focus: CalendarFocusDescriptor) => CalendarAcceptedSnapshot<TEvent> | null;
  canStartCommand: () => boolean;
  /**
   * #216 fix round 1 item 2: reads `acceptedResponseRef.current` (hook-private, synchronously
   * fresh), not the `acceptedResponse` render-state snapshot — the external-drop handler stayed
   * in the retired `ProductionCalendar.tsx` and on `main` read the ref for exactly this reason; a render-state
   * read there is a stale-closure risk the ref read never was.
   */
  findUnscheduledEntry: (id: string | undefined, kind: string | undefined) => CalendarUnscheduledEntryDto | undefined;
  refreshRecovery: () => Promise<void>;
  clearSettleOnNavigation: () => void;
  /** Announcement helpers the FullCalendar handlers (stayed in the since-deleted ProductionCalendar.tsx)
   * needed for their own "picked-up"/"invalid" calls — both read the hook-private `accessLostRef`
   * and write the hook-private `announcement` state, so they can't be reimplemented outside it. */
  announceLifecycle: (kind: Parameters<typeof calendarAnnouncement>[0], context: Parameters<typeof calendarAnnouncement>[1]) => void;
  announceChecklistLifecycle: (kind: Parameters<typeof calendarAnnouncement>[0], context: Omit<Parameters<typeof calendarAnnouncement>[1], "entity">) => void;
  /** Same hook-private-ref reasoning as the two announce helpers above. */
  focusDescriptor: (descriptor: CalendarFocusDescriptor) => void;
};

export type SchedulingCommands = SchedulingController<ProductionCalendarRangeResponse>;

/**
 * §216 fix round 2 item 2: on a fold/gap mapping failure, the dialog needs the civil time that
 * was actually ATTEMPTED — the shared mapper's own error object never carries it (only
 * code/message/endpoint/choices), so this reproduces exactly what the positional callers compute
 * as `localCivil` BEFORE calling the mapper: `proposedCivilForAllDay` for a month-subview drag
 * (preserves the pre-drag wall-clock time), the unscheduled-panel's fixed 17:00 default for a
 * month-subview placement, and the target's own civil minute verbatim for week-subview (both
 * kinds) — never `event.deadlineLocalCivil`, which for a placement is literally "Not scheduled".
 */
function attemptedDeadlineLocalCivil(proposal: Extract<SchedulingProposal, { entity: "project_deadline" }>, event: ProjectDeadlineCalendarEventDto): string {
  if (proposal.target.subview === "month") {
    return proposal.kind === "place" ? `${proposal.target.targetDate}T17:00` : proposedCivilForAllDay(event, proposal.target.targetDate);
  }
  return proposal.target.targetCivilMinute ?? event.deadlineLocalCivil;
}

function proposalProjectId(proposal: SchedulingProposal): string {
  if (proposal.entity === "checklist") return proposal.kind === "place" ? proposal.entry.project.id : proposal.source.project.id;
  return proposal.kind === "place" ? proposal.entry.project.id : proposal.event.project.id;
}

/**
 * #221: the Calendar's `SchedulingPort` — every Calendar-data access the controller used to make
 * inline, moved here verbatim. Not memoised: the controller reads the port through a ref.
 */
export function useCalendarSchedulingPort(calendar: DashboardCalendarState, query: ReturnType<typeof useProductionCalendarRange>, principalId: string): SchedulingPort<ProductionCalendarRangeResponse> {
  return {
    // A late observer result can outlive a route-key change in a query client;
    // the server echoes the route date, so never accept data for another range.
    latest: query.data && query.data.range.date === calendar.date ? query.data : undefined,
    latestUnchecked: query.data,
    latestStamp: query.dataUpdatedAt,
    latestError: query.error,
    refetch: async () => {
      const result = await query.refetch();
      return { data: result.data, error: result.error, isError: result.isError };
    },
    clone: cloneResponse,
    healNeedsAttention: (current, copy) => {
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
    },
    snapshotFilters: () => cloneFilters(productionCalendarFiltersFor(calendar)),
    findUnscheduledEntry: (baseline, id, kind) => baseline.unscheduled.find((candidate) => candidate.id === id && (
      kind === "project" ? candidate.kind === "project_deadline" : kind === "checklist" && candidate.kind === "checklist"
    )),
    findChecklist: checklistSourceFromResponse,
    findDeadline: responseEvent,
    findUnscheduledDeadline: (baseline, entryId) => baseline.unscheduled.find((entry): entry is ProjectCalendarUnscheduledEntryDto => entry.id === entryId && entry.kind === "project_deadline"),
    adoptChecklist: adoptChecklistResult,
    adoptDeadline: (baseline, event, current) => ({ ...baseline, events: baseline.events.map((candidate) => candidate.id === event.id && candidate.kind === "project_deadline" ? canonicalEventFromSchedule(candidate, current) : candidate) }),
    purge: (queryClient) => {
      removeProductionCalendarQueries(queryClient, principalId);
      void queryClient.cancelQueries({ queryKey: ["production-calendar", principalId] });
    },
    // invalidateProjectSurfaces owns the production-calendar broadcast (producer: "calendar"
    // suppresses this tab's own refetch; refetchAuthoritative is the single settle refetch).
    invalidation: (kind, projectId) => kind === "deadline"
      ? { projectId, resources: [{ kind: "detail" }, { kind: "activity" }], dashboard: true, calendar: true, gantt: true, producer: "calendar" }
      : { projectId, resources: [{ kind: "subtasks" }, { kind: "activity" }], dashboard: false, calendar: true, gantt: true, producer: "calendar" },
    defaultPlacementDate: () => calendar.date,
    settleFailedReason: "The latest Calendar could not be loaded.",
  };
}

export function useSchedulingCommands(input: SchedulingCommandsInput): SchedulingCommands {
  const { identity, calendar, resetKey, query, onAcceptGateChange, onSettleStateChange, onAccessLoss } = input;
  const port = useCalendarSchedulingPort(calendar, query, identity.principalId);
  return useSchedulingController({ identity, resetKey, port, onAcceptGateChange, onSettleStateChange, onAccessLoss });
}

/**
 * #221: the §216 controller, generic over its data source. Every Calendar-data access now goes
 * through `port` (read via `portRef`, refreshed every render), so no callback's dep list churns on
 * port identity. `useSchedulingCommands` is the Calendar's thin wrapper over this.
 */
export function useSchedulingController<TBaseline>(input: SchedulingControllerInput<TBaseline>): SchedulingController<TBaseline> {
  const { identity, resetKey, port, onAcceptGateChange, onSettleStateChange, onAccessLoss, onCommitted, onUndone } = input;
  const queryClient = useOptionalProjectQueryClient();
  // Refs updated every render: callbacks read the LATEST port at call time.
  const portRef = useRef(port);
  portRef.current = port;
  const { latest, latestStamp, latestError } = port;

  const [acceptedResponse, setAcceptedResponse] = useState<TBaseline | null>(null);
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
  const acceptedResponseRef = useRef<TBaseline | null>(null);
  const snapshotRef = useRef<CalendarAcceptedSnapshot | null>(null);
  const acceptGateRef = useRef(false);
  const settleRef = useRef<CalendarSettleState>({ pending: false, recoveryReason: null });
  const operationTokenRef = useRef(0);
  const commandLockRef = useRef<CalendarCommandLock>({ active: false });
  const queuedRefetchRef = useRef(false);
  const accessLostRef = useRef(false);
  const settleRefetchInFlightRef = useRef(false);
  // Unmount cleanup runs a closure from whichever render created it — refs, updated every render
  // (the `move-to-control.tsx` pattern), so the LATEST callbacks are the ones cleanup reaches for.
  const onAcceptGateChangeRef = useRef(onAcceptGateChange);
  const onSettleStateChangeRef = useRef(onSettleStateChange);
  const onCommittedRef = useRef(onCommitted);
  const onUndoneRef = useRef(onUndone);
  useEffect(() => {
    onAcceptGateChangeRef.current = onAcceptGateChange;
    onSettleStateChangeRef.current = onSettleStateChange;
    onCommittedRef.current = onCommitted;
    onUndoneRef.current = onUndone;
  });
  // The confirm this hook currently has open, so unmount can withdraw exactly that one
  // request rather than leaving it stranded over whatever view replaced this component.
  const openConfirmControllerRef = useRef<AbortController | null>(null);

  // §216 correction #0.1: no data source yet for the out-of-bounds warning here (bounds arrive
  // with #218/#221). §216 §0's rangesEnabled circularity note: this is computed from the hook's
  // OWN state so every internal validation stays zero-render-lag — the parent independently
  // derives the same boolean from `checklistRangeSchedulingDisabled` (below) for its own render.
  const rangesEnabled = CHECKLIST_SCHEDULE_RANGES_ENABLED && !checklistRangeSchedulingDisabled;

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

  const acceptRange = useCallback((response: TBaseline, authoritative = true) => {
    if (accessLostRef.current) return;
    const port = portRef.current;
    const copy = port.clone(response);
    acceptedResponseRef.current = copy;
    setAcceptedResponse(copy);
    // Needs-attention / movement-disabled markers are client-only and are NOT
    // carried in the locally-synthesized adoption a mutation performs — only a
    // genuine authoritative range refetch proves an item was repaired or a
    // project un-archived. Healing them off a local adoption would clear a marker
    // for an unrelated item still present in the stale baseline.
    if (!authoritative) return;
    if (settleRef.current.pending) setSettle({ type: "refetch-succeeded" });
    setChecklistNeedsAttention((current) => port.healNeedsAttention(current, copy));
    setDeadlineMovementDisabled(false);
    setChecklistRangeSchedulingDisabled(false);
  }, [setSettle]);

  useEffect(() => { onAcceptGateChange?.(calendarInteractionBlocked); }, [calendarInteractionBlocked, onAcceptGateChange]);
  useEffect(() => { onSettleStateChange?.(calendarSettle); }, [calendarSettle, onSettleStateChange]);

  useEffect(() => {
    operationTokenRef.current += 1;
    commandLockRef.current.active = false;
    snapshotRef.current = null;
    settleRefetchInFlightRef.current = false;
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
    // #221 PR C: a port-owned confirmation (`confirmDeadline`) never sees `confirmStore` — withdraw
    // it through its signal. For the shared `confirm()` this is the same outcome (resolves false).
    openConfirmControllerRef.current?.abort();
    openConfirmControllerRef.current = null;
    if (confirmStore.getSnapshot()) confirmStore.resolve(false);
  }, [resetKey, identity.principalId, identity.role, identity.authorizationEpoch, setAcceptGate, setOverlay, setSettle]);

  useEffect(() => {
    // `latest` is already accept-eligible — the port owns the eligibility check (the Calendar's
    // route-date echo check lives in `useCalendarSchedulingPort`).
    if (!latest) return;
    if (acceptGateRef.current) {
      queuedRefetchRef.current = true;
      return;
    }
    acceptRange(latest);
  }, [acceptRange, latest, latestStamp]);

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
      // #222: the retired FullCalendar card was itself focusable (`tabIndex={-1}`) and was focused as before.
      // The event-calendar renderer tags its chip CONTENT; the focusable element is the vendor's chip
      // `<button>` around it (whose own `data-ec-*` attributes are vendor-internal —
      // `event-calendar-skin.guard.test.ts`, detector 9).
      const eventTarget = eventElement && !eventElement.matches("button, [tabindex]") ? eventElement.closest<HTMLElement>("button") ?? eventElement : eventElement;
      (byKey ?? eventTarget)?.focus();
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
    if (queryClient) portRef.current.purge(queryClient);
    openConfirmControllerRef.current?.abort();
    openConfirmControllerRef.current = null;
    if (confirmStore.getSnapshot()) confirmStore.resolve(false);
    setAnnouncement("");
    onAccessLoss?.();
  }, [onAccessLoss, queryClient, setAcceptGate, setOverlay, setSettle]);

  useEffect(() => {
    if (accessLostRef.current) return;
    const err = latestError;
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) handleAccessLoss();
  }, [latestError, handleAccessLoss]);

  // §216 step 4: the four external-facing FullCalendar handlers (retired in #224) that used to set
  // `commandLockRef.current.active = true` immediately after every successful accept now get
  // that from here instead — every one of those call sites did it unconditionally right after,
  // so folding it in is behaviour-preserving and lets `commandLockRef` stay hook-private.
  const acceptForInteraction = useCallback(function <TEvent extends CalendarInteractionSource>(event: TEvent, focus: CalendarFocusDescriptor): CalendarAcceptedSnapshot<TEvent> | null {
    if (accessLostRef.current) return null;
    const port = portRef.current;
    const accepted = acceptedResponseRef.current ?? port.latestUnchecked;
    if (!accepted) return null;
    if (!acceptedResponseRef.current) acceptRange(accepted);
    const snapshot = beginCalendarInteraction({
      event,
      filters: port.snapshotFilters(),
      principalId: identity.principalId,
      authorizationEpoch: identity.authorizationEpoch,
      focus,
      capturedNow: Date.now(),
    });
    // Keep the accepted snapshot in a ref so late callbacks never need to read
    // mutable query data or infer the original focus target again.
    snapshotRef.current = snapshot as CalendarAcceptedSnapshot<CalendarInteractionSource>;
    setAcceptGate(true);
    commandLockRef.current.active = true;
    return snapshot;
  }, [acceptRange, identity.authorizationEpoch, identity.principalId, setAcceptGate]);

  // Combines the two ref-based start-gates every (retired) FullCalendar handler used to check directly
  // (`settleRef.current.pending`, `canStartCalendarCommand(commandLockRef.current)`) into one
  // predicate the component can call without reaching into hook-private refs.
  const canStartCommand = useCallback((): boolean => !settleRef.current.pending && canStartCalendarCommand(commandLockRef.current), []);

  const findUnscheduledEntry = useCallback((id: string | undefined, kind: string | undefined): CalendarUnscheduledEntryDto | undefined => {
    const baseline = acceptedResponseRef.current;
    return baseline ? portRef.current.findUnscheduledEntry(baseline, id, kind) : undefined;
  }, []);

  const refetchAuthoritative = useCallback(async (): Promise<{ ok: boolean; data?: TBaseline }> => {
    const token = operationTokenRef.current;
    queuedRefetchRef.current = false;
    try {
      const result = await portRef.current.refetch();
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
  }, [acceptRange, handleAccessLoss]);

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
    const confirmController = new AbortController();
    openConfirmControllerRef.current = confirmController;
    const confirmDeadline = portRef.current.confirmDeadline;
    const ok = confirmDeadline ? await confirmDeadline({
      proposal: {
        street: proposal.event.project.street,
        projectId: proposal.event.project.id,
        oldCivil: proposal.event.deadlineLocalCivil,
        newCivil: proposal.localCivil,
        newInstant: proposal.timing.allDay ? null : proposal.timing.start,
        scheduling,
      },
      consequences,
      signal: confirmController.signal,
    }) : await confirm({
      title: scheduling ? "Schedule Deadline" : "Move Deadline",
      message: scheduling
        ? `Schedule the Deadline for ${proposal.event.project.street}?`
        : `Move the Deadline for ${proposal.event.project.street}?`,
      confirmLabel: scheduling ? "Schedule Deadline" : "Move Deadline",
      content: <ProductionCalendarMoveConfirmation street={proposal.event.project.street} oldCivil={proposal.event.deadlineLocalCivil} newCivil={proposal.localCivil} consequences={consequences} />,
      signal: confirmController.signal,
    });
    // Safe to clear unconditionally only because `commandLockRef` serialises the drop path, so
    // this is still the controller installed above. Were two confirmations ever able to run at
    // once, this would strand the newer one and unmount would fail to withdraw it.
    openConfirmControllerRef.current = null;
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
        if (baseline) acceptRange(portRef.current.adoptDeadline(baseline, proposal.event, response.current), false);
        setOverlay(null);
        commandLockRef.current.active = false;
        snapshotRef.current = null;
        setAcceptGate(false);
        announceLifecycle("no-change", { entity: "deadline" });
        flushQueuedRefetch();
        return;
      }

      onCommittedRef.current?.({ kind: "deadline", projectId: proposal.event.project.id, before: proposal.event, deadlineResult: response, warnings: [] });
      setAcceptGate(false);
      setSettle({ type: "winner" });
      commandLockRef.current.active = false;
      snapshotRef.current = null;
      // invalidateProjectSurfaces owns the surface broadcast (the port's `producer` suppresses this
      // tab's own refetch; refetchAuthoritative below is the single settle refetch).
      if (queryClient) {
        await invalidateProjectSurfaces(queryClient, portRef.current.invalidation("deadline", proposal.event.project.id));
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
        setSettle({ type: "refetch-failed", reason: portRef.current.settleFailedReason });
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
        const port = portRef.current;
        const refreshedResponse = refreshed.data ? port.clone(refreshed.data) : acceptedResponseRef.current;
        const refreshedEntry = proposal.unscheduledEntry && refreshedResponse
          ? port.findUnscheduledDeadline(refreshedResponse, proposal.unscheduledEntry.id)
          : undefined;
        const latest = refreshedEntry
          ? projectDeadlinePlaceholder(refreshedEntry)
          : (refreshedResponse ? port.findDeadline(refreshedResponse, proposal.event.id) : undefined) ?? proposal.event;
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

  /**
   * §216 fix round 3 item 3: the ONE deadline plan/error/confirm/mutate path — both the move dialog's
   * retry (`mapAndRunDropProposal`/`mapAndRunUnscheduledProjectProposal` below) and `submitProposal` build a `SchedulingProposal` and call this. `event` is an
   * explicit argument (not derived from `snapshot.event`), matching main exactly: main's
   * `mapAndRunDropProposal`/`mapAndRunUnscheduledProjectProposal` always mapped against
   * `snapshot.event` (the freshest accepted schedule) but used a *separately passed* `event` for
   * the dialog state, announce, focus and `proposalFromRequest` — never `snapshot.event` there.
   * `attemptedLocalCivil`, when the caller already has one on hand (round 2 item 2), is used
   * as-is instead of being re-derived — see `attemptedDeadlineLocalCivil`'s own docblock. `isPlace`
   * (`proposal.kind === "place"`) carries the two genuine, pre-existing behavioural differences
   * between an in-calendar drag and an external panel drop forward exactly as they were: a
   * repeated-time fold on a drag leaves the dragged event where it visually landed (no revert)
   * while a placement reverts immediately; a placement also clears the optimistic overlay
   * defensively on the generic-invalid branch where a drag never did (inert either way — the
   * overlay is never set before this point in either flow — but preserved for exactness).
   * `snapshotRef` on that same generic-invalid branch is unconditional for both, per main
   * (fix round 3 item 1).
   */
  const runDeadlineProposal = useCallback((proposal: Extract<SchedulingProposal, { entity: "project_deadline" }>, snapshot: CalendarAcceptedSnapshot<ProjectDeadlineCalendarEventDto>, event: ProjectDeadlineCalendarEventDto, drop?: CalendarRevertable, attemptedLocalCivil?: string) => {
    const isPlace = proposal.kind === "place";
    const planned = planSchedulingProposal(proposal, { bounds: portRef.current.boundsFor?.(proposalProjectId(proposal)) ?? null });
    if (!planned.ok) {
      const seedLocalCivil = attemptedLocalCivil ?? attemptedDeadlineLocalCivil(proposal, event);
      if (planned.error.code === "repeated_local_time" && planned.error.choices) {
        // §216 fix round 3 item 2: no announce here on main — a drag OR a placement opens the fold
        // dialog silently for a repeated_local_time. Only the nonexistent_local_time (gap) branch
        // below announces "dst-gap", on both paths, per main.
        if (isPlace) drop?.revert();
        setMoveDialog({
          event, snapshot, initialCivil: seedLocalCivil, foldChoices: planned.error.choices, drop,
          ...(isPlace ? { unscheduledEntry: proposal.entry } : { subview: proposal.target.subview === "month" ? "month" as const : "week" as const }),
        });
        return;
      }
      if (planned.error.code === "nonexistent_local_time") {
        drop?.revert();
        setMoveDialog({ event, snapshot, initialCivil: seedLocalCivil, drop, ...(isPlace ? { unscheduledEntry: proposal.entry } : {}) });
        announceLifecycle("dst-gap", { entity: "deadline" });
        return;
      }
      drop?.revert();
      if (isPlace) setOverlay(null);
      setAcceptGate(false);
      commandLockRef.current.active = false;
      // §216 fix round 3 item 1: unconditional — main (ProductionCalendar.tsx:995-1001) cleared
      // snapshotRef on this generic-invalid branch for a drag too, not just a placement. Only the
      // overlay clear above stays placement-only, per main.
      snapshotRef.current = null;
      announceLifecycle("invalid", { entity: "deadline" });
      focusDescriptor({ eventId: event.id, control: "event" });
      flushQueuedRefetch();
      return;
    }
    if (planned.value.kind !== "deadline") return;
    const proposalResult = proposalFromRequest(snapshot, event, planned.value.localCivil, proposal.disambiguation, planned.value.request, drop);
    if (!proposalResult.ok) {
      drop?.revert();
      setAcceptGate(false);
      commandLockRef.current.active = false;
      if (isPlace) snapshotRef.current = null;
      return;
    }
    const deadlineProposal = proposalResult.proposal;
    if (isUnchangedDeadlineProposal(event, deadlineProposal)) {
      finishInteraction(drop, event.deadlineLocalCivil);
      return;
    }
    void runConfirmedProposal(isPlace ? { ...deadlineProposal, unscheduledEntry: proposal.entry } : deadlineProposal);
  }, [announceLifecycle, finishInteraction, flushQueuedRefetch, focusDescriptor, isUnchangedDeadlineProposal, proposalFromRequest, runConfirmedProposal, setAcceptGate, setOverlay]);

  const mapAndRunDropProposal = useCallback((snapshot: CalendarAcceptedSnapshot<ProjectDeadlineCalendarEventDto>, event: ProjectDeadlineCalendarEventDto, localCivil: string, subview: "month" | "week", disambiguation: ProjectDeadlineDisambiguation | undefined, drop: CalendarDropInfo) => {
    const target: CalendarManipulationTarget = subview === "month"
      ? { subview, targetDate: localCivil.slice(0, 10) }
      : { subview, targetDate: localCivil.slice(0, 10), targetCivilMinute: localCivil };
    // §216 fix round 4 item 1: the SchedulingProposal's own `event` (what planSchedulingProposal
    // maps against) is `snapshot.event` — main (ProductionCalendar.tsx:983) mapped
    // mapProjectDeadlineMoveToCommand from snapshot.event (the freshest accepted source civil
    // time/expectedVersion/reminder offsets), never the positional `event`. The positional `event`
    // is still passed separately to runDeadlineProposal for the dialog/focus/proposalFromRequest
    // uses, matching main exactly there too (see runDeadlineProposal's own docblock).
    runDeadlineProposal({ kind: "deadline", entity: "project_deadline", event: snapshot.event, target, ...(disambiguation ? { disambiguation } : {}) }, snapshot, event, drop, localCivil);
  }, [runDeadlineProposal]);

  const mapAndRunUnscheduledProjectProposal = useCallback((snapshot: CalendarAcceptedSnapshot<ProjectDeadlineCalendarEventDto>, entry: ProjectCalendarUnscheduledEntryDto, event: ProjectDeadlineCalendarEventDto, localCivil: string, target: CalendarManipulationTarget, disambiguation: ProjectDeadlineDisambiguation | undefined, drop?: CalendarRevertable) => {
    runDeadlineProposal({ kind: "place", entity: "project_deadline", entry, target, ...(disambiguation ? { disambiguation } : {}) }, snapshot, event, drop, localCivil);
  }, [runDeadlineProposal]);

  const openMoveDialog = useCallback((event: ProjectDeadlineCalendarEventDto) => {
    if (identity.role !== "admin" || !event.permissions.canDrag || deadlineMovementDisabled || settleRef.current.pending || !canStartCalendarCommand(commandLockRef.current)) return;
    const snapshot = acceptForInteraction(event, { eventId: event.id, control: "move-reschedule" });
    if (!snapshot) return;
    announceLifecycle("picked-up", { entity: "deadline", street: event.project.street, oldCivil: event.deadlineLocalCivil });
    setMoveDialog({ event, snapshot, initialCivil: event.deadlineLocalCivil });
  }, [acceptForInteraction, announceLifecycle, deadlineMovementDisabled, identity.role]);

  // §216 correction #4: the unscheduled-entry draggability check (`canDragUnscheduledEntry`,
  // which imports from `ProductionCalendarUnscheduledPanel`) stays a component-only function —
  // `lib/` must not import a component. the retired `ProductionCalendar.tsx` wrapped its call to this command
  // with that check instead of this hook performing it internally.
  const openUnscheduledProjectDialog = useCallback((entry: ProjectCalendarUnscheduledEntryDto) => {
    if (calendarInteractionBlocked || settleRef.current.pending || !canStartCalendarCommand(commandLockRef.current)) return;
    const sourceSnapshot = acceptForInteraction(entry, { eventId: entry.id, control: "move-reschedule" });
    if (!sourceSnapshot) return;
    const event = projectDeadlinePlaceholder(entry);
    const snapshot = { ...sourceSnapshot, event } as CalendarAcceptedSnapshot<ProjectDeadlineCalendarEventDto>;
    const initialCivil = `${portRef.current.defaultPlacementDate()}T17:00`;
    announceLifecycle("picked-up", { entity: "deadline", street: entry.project.street, oldCivil: "Not scheduled" });
    setMoveDialog({ event, snapshot, initialCivil, unscheduledEntry: entry });
  }, [acceptForInteraction, announceLifecycle, calendarInteractionBlocked]);

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
    // The Calendar entity id is `checklist:<subtaskId>` — DOM ids, focus descriptors,
    // and optimistic overlays all depend on that prefix staying on the wire. The
    // subtasks route needs the bare uuid; a malformed/unprefixed id here is a mapping
    // defect, not a request worth sending, so bail out through the same revert +
    // "invalid" announcement path a bad target civil time already uses.
    const subtaskId = subtaskIdFromCalendarEntityId(proposal.source.id);
    if (subtaskId === null) {
      finishChecklistInteraction(proposal.operation, proposal.source, { kind: "invalid" });
      return;
    }
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
        `/api/projects/${encodeURIComponent(proposal.source.project.id)}/subtasks/${encodeURIComponent(subtaskId)}`,
        { schedule: proposal.request },
      );
      if (accessLostRef.current || token !== operationTokenRef.current) return;
      const result = decodeChecklistMutationResponse(identity.role, response);
      const noop = result.scheduleVersion === proposal.source.schedule.version
        && checklistSchedulesEqual(result.schedule, proposal.source.schedule);
      const baseline = acceptedResponseRef.current;
      if (baseline) acceptRange(portRef.current.adoptChecklist(baseline, proposal.source, result), false);
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

      const warningText = scheduleWarningText(scheduleWindowWarnings(checklistInputFromSchedule(result.schedule), portRef.current.boundsFor?.(proposal.source.project.id) ?? null));
      onCommittedRef.current?.({ kind: "checklist", projectId: proposal.source.project.id, before: proposal.source, checklistResult: result, warnings: proposal.warnings ?? [], warningText });
      setScheduleEditor(null);
      setChecklistFold(null);
      setAcceptGate(false);
      setSettle({ type: "winner" });
      commandLockRef.current.active = false;
      snapshotRef.current = null;
      // invalidateProjectSurfaces owns the surface broadcast (the port's `producer`).
      if (queryClient) {
        await invalidateProjectSurfaces(queryClient, portRef.current.invalidation("checklist", proposal.source.project.id));
      }
      if (accessLostRef.current || token !== operationTokenRef.current) return;
      settleRefetchInFlightRef.current = true;
      const settled = await refetchAuthoritative();
      if (accessLostRef.current || token !== operationTokenRef.current) return;
      settleRefetchInFlightRef.current = false;
      if (settled.ok) {
        setSettle({ type: "refetch-succeeded" });
        setOverlay(null);
        const saved = calendarAnnouncement("saved", { street: proposal.source.project.street, entity: "checklist" });
        // Same guard as `announceLifecycle`; the warning rides the one "saved" announcement.
        if (!accessLostRef.current && saved) setAnnouncement(warningText ? `${saved} Warning: ${warningText}` : saved);
      } else if (!accessLostRef.current) {
        setSettle({ type: "refetch-failed", reason: portRef.current.settleFailedReason });
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
        const port = portRef.current;
        const refreshedResponse = refreshed.data ? port.clone(refreshed.data) : acceptedResponseRef.current;
        const latest = (refreshedResponse ? port.findChecklist(refreshedResponse, proposal.source.id) : undefined) ?? proposal.source;
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
  }, [acceptRange, announceChecklistLifecycle, finishChecklistInteraction, flushQueuedRefetch, focusDescriptor, handleAccessLoss, identity.role, queryClient, refetchAuthoritative, setAcceptGate, setOverlay, setSettle]);

  /**
   * §216 fix round 3 item 3: the ONE checklist plan/error/mutate path — both `mapChecklistCommand`
   * (the checklist fold's retry, below) and `submitProposal` build a
   * `SchedulingProposal` and call this. `event` is an explicit argument, matching main exactly:
   * main's `mapChecklistCommand` mapped against `snapshot.event` (the freshest accepted schedule)
   * but used a *separately passed* `event` for the branch decision, `ChecklistProposal.source`,
   * `finishChecklistInteraction` and `checklistInputFromSchedule` — never `snapshot.event` there.
   */
  const runChecklistProposal = useCallback((proposal: Extract<SchedulingProposal, { entity: "checklist" }>, snapshot: ChecklistSnapshot, event: ChecklistSource, operation: ChecklistOperationInfo) => {
    const planned = planSchedulingProposal(proposal, { bounds: portRef.current.boundsFor?.(proposalProjectId(proposal)) ?? null });
    if (!planned.ok) {
      const repeated = planned.error.code === "repeated_local_time" || planned.error.code === "subtask_schedule_repeated_local_time";
      const nonexistent = planned.error.code === "nonexistent_local_time" || planned.error.code === "subtask_schedule_nonexistent_local_time";
      if (repeated && planned.error.choices && planned.error.endpoint) {
        const sourceSchedule = checklistInputFromSchedule(event.schedule);
        const edge = proposal.kind === "resize" ? proposal.edge : undefined;
        const foldProposal: ChecklistProposal = { snapshot, source: event, request: { expectedVersion: event.schedule.version, schedule: sourceSchedule }, schedule: sourceSchedule, timing: "timing" in event ? event.timing : null, operation, target: proposal.target, ...(edge ? { edge } : {}) };
        setChecklistFold({ proposal: foldProposal, disambiguation: typeof proposal.disambiguation === "object" ? proposal.disambiguation : {}, endpoint: planned.error.endpoint, choices: planned.error.choices });
        announceChecklistLifecycle("fold-choice", {});
        return;
      }
      finishChecklistInteraction(operation, event, { kind: nonexistent ? "dst-gap" : "invalid" });
      return;
    }
    if (planned.value.kind !== "checklist") return;
    if (!rangesEnabled && planned.value.schedule.state === "range") {
      finishChecklistInteraction(operation, event, { kind: "range-disabled" });
      return;
    }
    const mutationProposal: ChecklistProposal = {
      snapshot,
      source: event,
      request: planned.value.request,
      schedule: planned.value.schedule,
      timing: planned.value.timing,
      operation,
      target: proposal.target,
      ...(proposal.kind === "resize" ? { edge: proposal.edge } : {}),
      ...(planned.value.warnings.length ? { warnings: planned.value.warnings } : {}),
    };
    void runChecklistMutation(mutationProposal);
  }, [announceChecklistLifecycle, finishChecklistInteraction, rangesEnabled, runChecklistMutation]);

  const mapChecklistCommand = useCallback((snapshot: ChecklistSnapshot, event: ChecklistSource, target: CalendarManipulationTarget, operation: ChecklistOperationInfo, disambiguation?: ChecklistDisambiguation, edge?: "start" | "end") => {
    const proposal: SchedulingProposal = edge === "start"
      ? { kind: "resize", entity: "checklist", source: snapshot.event as ChecklistCalendarEventDto, edge: "start", target, ...(disambiguation ? { disambiguation } : {}) }
      : edge === "end"
        ? { kind: "resize", entity: "checklist", source: snapshot.event as ChecklistCalendarEventDto, edge: "end", target, ...(disambiguation ? { disambiguation } : {}) }
        : "reason" in event && event.reason === "unscheduled"
          ? { kind: "place", entity: "checklist", entry: snapshot.event as ChecklistCalendarUnscheduledEntryDto, target, ...(disambiguation ? { disambiguation } : {}) }
          : { kind: "move", entity: "checklist", source: snapshot.event as ChecklistCalendarEventDto, target, ...(disambiguation ? { disambiguation } : {}) };
    runChecklistProposal(proposal, snapshot, event, operation);
  }, [runChecklistProposal]);

  /**
   * §216 fix round 1 item 4, gated + unified per fix round 2 items 1 and 3: checks
   * `canStartCommand()` before doing anything else — the positional FullCalendar handlers (retired in #224) checked
   * this externally before their own `acceptForInteraction` call, but `submitProposal` is a
   * self-contained command with no external caller to gate it, so it has to gate itself. No side
   * effects on a "busy" rejection: `acceptForInteraction` (which replaces `snapshotRef` and
   * activates the command lock) is never reached. On success, plans + runs through the exact same
   * `runChecklistProposal`/`runDeadlineProposal` the move dialog's and checklist fold's retries call.
   */
  const submitProposal = useCallback((proposal: SchedulingProposal, options?: { revertable?: CalendarRevertable }): SubmitProposalOutcome => {
    if (!canStartCommand()) return { ok: false, reason: "busy" };
    const revertable = options?.revertable;
    if (proposal.entity === "checklist") {
      const source: ChecklistSource = proposal.kind === "place" ? proposal.entry : proposal.source;
      const snapshot = acceptForInteraction(source, { eventId: source.id, control: "event" });
      if (!snapshot) return { ok: false, reason: "not-accepted" };
      runChecklistProposal(proposal, snapshot, source, revertable ? { drop: revertable } : {});
      return { ok: true };
    }
    const event = proposal.kind === "place" ? projectDeadlinePlaceholder(proposal.entry) : proposal.event;
    const snapshot = acceptForInteraction(event, { eventId: event.id, control: "event" });
    if (!snapshot) return { ok: false, reason: "not-accepted" };
    runDeadlineProposal(proposal, snapshot, event, revertable);
    return { ok: true };
  }, [acceptForInteraction, canStartCommand, runChecklistProposal, runDeadlineProposal]);

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

  const openChecklistScheduleEditor = useCallback((source: ChecklistSource, initialSchedule?: InitialChecklistScheduleInput) => {
    if (source.schedule.state === "invalid" || !source.permissions.canOpenScheduleEditor || calendarInteractionBlocked || settleRef.current.pending || !canStartCalendarCommand(commandLockRef.current)) return;
    const snapshot = acceptForInteraction(source, { eventId: source.id, control: "move-reschedule" });
    if (!snapshot) return;
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
      ? { state: "due_only", end: { kind: "date", localCivil: portRef.current.defaultPlacementDate() } }
      : undefined;
    openChecklistScheduleEditor(entry, initialSchedule);
  }, [openChecklistScheduleEditor]);

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

  /**
   * #221: Undo as a command. Same gate (`canStartCommand`), lock, accept gate and token fence as a
   * forward edit; a 401/403 (`applyUndo`'s "access") is access loss. Never retried on conflict.
   */
  const runUndo = useCallback(async (ticket: UndoTicket): Promise<RunUndoOutcome> => {
    // Access loss releases the lock, so `canStartCommand` alone would let an Undo toast that
    // outlived the session fire a write into a purged surface.
    if (accessLostRef.current) return { ok: false, reason: "access" };
    if (!canStartCommand()) return { ok: false, reason: "busy" };
    const token = operationTokenRef.current;
    const fenced = () => accessLostRef.current || token !== operationTokenRef.current;
    // #291: a successful Undo's refetch is a settle refetch, exactly like a forward save's — the
    // lock and accept gate are released and settle is pending (which `canStartCommand` refuses)
    // while it runs, and a failure enters settle recovery (`refreshRecovery`) rather than announcing
    // over a surface still drawing the forward state. `true` when the caller may announce success.
    const settleUndo = async (beforeRefetch?: () => Promise<void>): Promise<boolean> => {
      setAcceptGate(false);
      setSettle({ type: "winner" });
      commandLockRef.current.active = false;
      if (beforeRefetch) {
        await beforeRefetch();
        if (fenced()) return false;
      }
      settleRefetchInFlightRef.current = true;
      const settled = await refetchAuthoritative();
      if (fenced()) return false;
      settleRefetchInFlightRef.current = false;
      if (settled.ok) {
        setSettle({ type: "refetch-succeeded" });
        return true;
      }
      setSettle({ type: "refetch-failed", reason: portRef.current.settleFailedReason });
      if (ticket.kind === "checklist") announceChecklistLifecycle("settle-failed", {});
      else announceLifecycle("settle-failed", { entity: "deadline" });
      return false;
    };
    commandLockRef.current.active = true;
    setAcceptGate(true);
    const outcome = await applyUndo(ticket);
    if (fenced()) return outcome;
    if (!outcome.ok && outcome.reason === "access") {
      handleAccessLoss();
      return outcome;
    }
    if (outcome.ok) {
      let checklistResult: ChecklistMutationResult | undefined;
      try {
        checklistResult = ticket.kind === "checklist" && outcome.response !== undefined
          ? decodeChecklistMutationResponse(identity.role, outcome.response)
          : undefined;
      } catch {
        // The write happened but its body is unreadable — reported, never hidden: no row patch,
        // the refetch converges the surface on server truth, and the outcome is "failed" (final,
        // like the forward path's undecodable save, which also rolls back to a refetch).
        const failed: UndoOutcome = { ok: false, reason: "failed" };
        if (!(await settleUndo())) return failed;
        setAnnouncement("Undo result could not be read. Reloaded the latest.");
        flushQueuedRefetch();
        return failed;
      }
      onUndoneRef.current?.({ kind: ticket.kind, projectId: ticket.projectId, ...(checklistResult ? { checklistResult } : {}) });
      // invalidateProjectSurfaces owns the surface broadcast (the port's `producer`).
      const invalidate = async () => {
        if (queryClient) await invalidateProjectSurfaces(queryClient, portRef.current.invalidation(ticket.kind, ticket.projectId));
      };
      if (!(await settleUndo(invalidate))) return outcome;
      setAnnouncement("Change undone.");
      flushQueuedRefetch();
      return outcome;
    }
    commandLockRef.current.active = false;
    setAcceptGate(false);
    await refetchAuthoritative();
    if (fenced()) return outcome;
    setAnnouncement(outcome.reason === "conflict" ? "Undo failed — the item changed since." : "Undo failed.");
    return outcome;
  }, [announceChecklistLifecycle, announceLifecycle, canStartCommand, flushQueuedRefetch, handleAccessLoss, identity.role, queryClient, refetchAuthoritative, setAcceptGate, setSettle]);

  useEffect(() => () => {
    operationTokenRef.current += 1;
    accessLostRef.current = true;
    commandLockRef.current.active = false;
    queuedRefetchRef.current = false;
    settleRefetchInFlightRef.current = false;
    // The parent learns about the gate only through the effect above, which needs this
    // component's state to change, and a state update on an unmounting component is dropped. A
    // route change mid-drop (Back, a rail link) would leave the Dashboard's controls disabled
    // until reload. So release the parent's gate and the confirm this interaction opened
    // directly. Late responses are already fenced by the token bump above.
    openConfirmControllerRef.current?.abort();
    openConfirmControllerRef.current = null;
    if (acceptGateRef.current) onAcceptGateChangeRef.current?.(false);
    setAcceptGate(false);
    onSettleStateChangeRef.current?.({ pending: false, recoveryReason: null });
  }, [setAcceptGate]);

  const clearSettleOnNavigation = useCallback(() => {
    setSettle({ type: "terminal" });
    setOverlay(null);
    queuedRefetchRef.current = false;
  }, [setOverlay, setSettle]);

  return {
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
    submitProposal,
    runUndo,
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
  };
}
