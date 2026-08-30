import type {
  CalendarEventDto,
  CalendarEventTiming,
  CalendarUnscheduledEntryDto,
  ChecklistScheduleDto,
  ProjectDeadlineCalendarEventDto,
  ProductionCalendarFilters,
} from "@quincy/shared";

export type CalendarInteractionSource = CalendarEventDto | CalendarUnscheduledEntryDto;

export type CalendarFocusDescriptor = {
  eventId: string;
  control: "event" | "move-reschedule" | "recovery" | "safe-fallback";
};

/** An interaction-start copy of the accepted response, never a query-cache reference. */
export type CalendarAcceptedSnapshot<TEvent extends CalendarInteractionSource = CalendarInteractionSource> = {
  event: TEvent;
  filters: ProductionCalendarFilters;
  principalId: string;
  authorizationEpoch: number;
  focus: CalendarFocusDescriptor;
  capturedNow: number;
};

function cloneChecklistSchedule(schedule: ChecklistScheduleDto): ChecklistScheduleDto {
  if (schedule.state === "legacy_unresolved") {
    return {
      ...schedule,
      error: {
        ...schedule.error,
        ...(schedule.error.foldChoices ? { foldChoices: schedule.error.foldChoices.map((choice) => ({ ...choice })) } : {}),
      },
    };
  }
  if (schedule.state === "invalid") return { ...schedule, error: { ...schedule.error } };
  return {
    ...schedule,
    start: schedule.start ? { ...schedule.start } : null,
    end: schedule.end ? { ...schedule.end } : null,
  } as typeof schedule;
}

/** The single authoritative deep clone for interaction snapshots and accepted data. */
export function cloneSource<TEvent extends CalendarInteractionSource>(event: TEvent): TEvent {
  const project = { ...event.project, checklist: { ...event.project.checklist } };
  const timingFields = "timing" in event ? { timing: { ...event.timing }, status: { ...event.status } } : {};
  if (event.kind === "project_deadline") {
    return {
      ...event,
      project,
      permissions: { ...event.permissions },
      reminderOffsetsMinutes: [...event.reminderOffsetsMinutes],
      ...timingFields,
    } as TEvent;
  }
  return {
    ...event,
    project,
    assignee: event.assignee ? { ...event.assignee } : null,
    permissions: { ...event.permissions },
    ...timingFields,
    schedule: cloneChecklistSchedule(event.schedule),
  } as TEvent;
}

export function beginCalendarInteraction<TEvent extends CalendarInteractionSource>(input: Omit<CalendarAcceptedSnapshot<TEvent>, "capturedNow"> & { capturedNow?: number }): CalendarAcceptedSnapshot<TEvent> {
  return {
    ...input,
    event: cloneSource(input.event),
    filters: { ...input.filters, layers: [...input.filters.layers], editorIds: [...input.filters.editorIds], stageKeys: [...input.filters.stageKeys] },
    capturedNow: input.capturedNow ?? Date.now(),
  };
}

export type CalendarOptimisticOverlay = {
  eventId: string;
  timing: CalendarEventTiming;
} | {
  kind: "reschedule-unscheduled";
  entryId: string;
  timing: CalendarEventTiming;
  asEvent: CalendarEventDto;
} | null;

export type CalendarSettleState = {
  pending: boolean;
  recoveryReason: string | null;
};

export type CalendarSettleEvent =
  | { type: "winner" }
  | { type: "refetch-succeeded" }
  | { type: "refetch-failed"; reason: string }
  | { type: "terminal" };

/** The Calendar command barrier follows the same small table as the Board settle barrier. */
export function transitionCalendarSettle(state: CalendarSettleState, event: CalendarSettleEvent): CalendarSettleState {
  if (event.type === "winner") return { pending: true, recoveryReason: null };
  if (event.type === "refetch-failed") return state.pending ? { pending: true, recoveryReason: event.reason } : state;
  if (event.type === "refetch-succeeded" || event.type === "terminal") return { pending: false, recoveryReason: null };
  return state;
}

export type DeadlineFailureAction = {
  code: string;
  rollback: true;
  refetch: boolean;
  retry: false;
  retainDraft: boolean;
  disableMovement: boolean;
  askFold: boolean;
  accessLoss: boolean;
  focus: CalendarFocusDescriptor["control"];
  announce: string;
};

export type ChecklistFailureAction = {
  code: string;
  rollback: true;
  refetch: boolean;
  retry: false;
  retainDraft: boolean;
  askFold: boolean;
  rangeDisabled: boolean;
  needsAttention: boolean;
  mappingDefect: boolean;
  accessLoss: boolean;
  focus: CalendarFocusDescriptor["control"];
  announce: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function statusOf(value: unknown): number | undefined {
  const direct = record(value)?.status;
  return typeof direct === "number" ? direct : undefined;
}

function codeOf(value: unknown): string | undefined {
  const direct = record(value);
  if (!direct) return undefined;
  if (typeof direct.code === "string") return direct.code;
  const details = record(direct.details);
  return typeof details?.code === "string" ? details.code : undefined;
}

function action(
  code: string,
  values: Omit<DeadlineFailureAction, "code" | "rollback" | "retry">,
): DeadlineFailureAction {
  return { code, rollback: true, retry: false, ...values };
}

export function classifyDeadlineFailure(value: unknown, ctx: { eventId: string }): DeadlineFailureAction | null {
  const status = statusOf(value);
  if (status === 401 || status === 403) {
    return action(String(status), {
      refetch: false,
      retainDraft: false,
      disableMovement: false,
      askFold: false,
      accessLoss: true,
      focus: "safe-fallback",
      announce: "",
    });
  }

  const code = codeOf(value);
  switch (code) {
    case "deadline_version_conflict":
      return action(code, { refetch: true, retainDraft: true, disableMovement: false, askFold: false, accessLoss: false, focus: "event", announce: "The Deadline changed elsewhere. Reloaded the latest; no retry was made." });
    case "deadline_project_archived":
      return action(code, { refetch: true, retainDraft: false, disableMovement: true, askFold: false, accessLoss: false, focus: "safe-fallback", announce: "This project was archived. Its Deadline can no longer be moved here." });
    case "deadline_project_delivered":
      return action(code, { refetch: true, retainDraft: false, disableMovement: true, askFold: false, accessLoss: false, focus: "safe-fallback", announce: "This project was delivered. Its Deadline can no longer be moved here." });
    case "deadline_nonexistent_local_time":
      return action(code, { refetch: false, retainDraft: true, disableMovement: false, askFold: false, accessLoss: false, focus: "move-reschedule", announce: "That time does not exist in Sydney on that date (daylight-saving gap). Pick another time." });
    case "deadline_repeated_local_time":
      return action(code, { refetch: false, retainDraft: true, disableMovement: false, askFold: true, accessLoss: false, focus: "move-reschedule", announce: "That time occurs twice in Sydney that day. Choose the earlier or later occurrence." });
    case "deadline_invalid_reminder_offsets":
      return action(code, { refetch: true, retainDraft: false, disableMovement: false, askFold: false, accessLoss: false, focus: "event", announce: "The saved reminder offsets are no longer valid. Reloaded the latest Deadline." });
    case "deadline_invalid_version":
      return action(code, { refetch: true, retainDraft: false, disableMovement: false, askFold: false, accessLoss: false, focus: "event", announce: "The source Deadline version is invalid. Reloaded; start the move again." });
    case "deadline_invalid_local_time":
      return action(code, { refetch: false, retainDraft: true, disableMovement: false, askFold: false, accessLoss: false, focus: "move-reschedule", announce: "That is not a valid Sydney time. Adjust the value and try again." });
    case "deadline_resolver_defect":
      return action(code, { refetch: true, retainDraft: false, disableMovement: false, askFold: false, accessLoss: false, focus: "recovery", announce: "Scheduling could not be resolved. Reloaded the latest; try again." });
    case "project_not_found":
      return action(code, { refetch: true, retainDraft: false, disableMovement: true, askFold: false, accessLoss: false, focus: "safe-fallback", announce: "That project is no longer available." });
    default:
      return null;
  }
}

export function classifyChecklistFailure(value: unknown, ctx: { eventId: string; fromEditor?: boolean }): ChecklistFailureAction | null {
  const status = statusOf(value);
  if (status === 401 || status === 403) {
    return {
      code: String(status), rollback: true, refetch: false, retry: false, retainDraft: false,
      askFold: false, rangeDisabled: false, needsAttention: false, mappingDefect: false,
      accessLoss: true, focus: "safe-fallback", announce: "",
    };
  }

  const code = codeOf(value);
  const retainDraft = Boolean(ctx.fromEditor);
  switch (code) {
    case "subtask_schedule_version_conflict":
      // "No retry" means no automatic retry; an editor retains its draft for manual resubmission.
      return { code, rollback: true, refetch: true, retry: false, retainDraft, askFold: false, rangeDisabled: false, needsAttention: false, mappingDefect: false, accessLoss: false, focus: "event", announce: "The checklist schedule changed elsewhere. Reloaded the latest; no retry was made." };
    case "subtask_item_conflict":
      return { code, rollback: true, refetch: true, retry: false, retainDraft: false, askFold: false, rangeDisabled: false, needsAttention: false, mappingDefect: false, accessLoss: false, focus: "event", announce: "The checklist item changed elsewhere. Reloaded the latest item; no retry was made." };
    case "subtask_schedule_ranges_disabled":
      return { code, rollback: true, refetch: true, retry: false, retainDraft: false, askFold: false, rangeDisabled: true, needsAttention: false, mappingDefect: false, accessLoss: false, focus: "event", announce: "Range scheduling is unavailable in this app version." };
    case "subtask_schedule_storage_invalid":
      return { code, rollback: true, refetch: false, retry: false, retainDraft: false, askFold: false, rangeDisabled: false, needsAttention: true, mappingDefect: false, accessLoss: false, focus: "event", announce: "This checklist schedule needs attention. Repair is unavailable in Calendar." };
    case "subtask_schedule_reload_required":
      return { code, rollback: true, refetch: true, retry: false, retainDraft: false, askFold: false, rangeDisabled: false, needsAttention: false, mappingDefect: true, accessLoss: false, focus: "event", announce: "The checklist schedule could not be applied. Reloaded the latest; try again." };
    case "subtask_schedule_nonexistent_local_time":
      return { code, rollback: true, refetch: false, retry: false, retainDraft, askFold: false, rangeDisabled: false, needsAttention: false, mappingDefect: false, accessLoss: false, focus: retainDraft ? "move-reschedule" : "event", announce: "That time does not exist in Sydney on that date (daylight-saving gap)." };
    case "subtask_schedule_repeated_local_time":
      return { code, rollback: true, refetch: false, retry: false, retainDraft, askFold: true, rangeDisabled: false, needsAttention: false, mappingDefect: false, accessLoss: false, focus: retainDraft ? "move-reschedule" : "event", announce: "That time occurs twice in Sydney that day. Choose the earlier or later occurrence for each endpoint." };
    case "subtask_schedule_invalid_order":
    case "subtask_schedule_mixed_endpoint_kinds":
    case "subtask_schedule_missing_endpoint":
    case "subtask_schedule_start_without_end":
    case "subtask_schedule_invalid_local_time":
    case "subtask_schedule_invalid_version":
    case "subtask_schedule_resolver_defect":
      return { code, rollback: true, refetch: false, retry: false, retainDraft, askFold: false, rangeDisabled: false, needsAttention: false, mappingDefect: false, accessLoss: false, focus: retainDraft ? "move-reschedule" : "event", announce: "That schedule change isn't valid." };
    default:
      return null;
  }
}

export type CalendarAnnouncementKind =
  | "picked-up"
  | "confirm-required"
  | "cancelled"
  | "saving"
  | "saved"
  | "no-change"
  | "conflict"
  | "rollback"
  | "settle-failed"
  | "dst-gap"
  | "fold-choice"
  | "invalid"
  | "range-disabled";
export type CalendarAnnouncementContext = {
  entity: "deadline" | "checklist";
  street?: string;
  oldCivil?: string;
  newCivil?: string;
  overlap?: boolean;
  assignee?: string;
  terminal?: boolean;
};

function civil(value: string | undefined): string {
  return value?.replace("T", " ") ?? "the proposed time";
}

export function calendarAnnouncement(kind: CalendarAnnouncementKind, ctx: CalendarAnnouncementContext): string | undefined {
  if (ctx.terminal) return undefined;
  const street = ctx.street ? ` for ${ctx.street}` : "";
  if (ctx.entity === "checklist") {
    switch (kind) {
      case "picked-up": return `Picked up the checklist schedule${street}. Current time: ${civil(ctx.oldCivil)}.${ctx.overlap ? " This item overlaps another task for the same assignee." : ""}`;
      case "confirm-required": return `Save the checklist schedule${street} from ${civil(ctx.oldCivil)} to ${civil(ctx.newCivil)}. Confirmation required.`;
      case "cancelled": return "Cancelled scheduling the checklist item.";
      case "saving": return `Saving the checklist schedule${street}.`;
      case "saved": return `Saved the checklist schedule${street}.`;
      case "no-change": return "No change.";
      case "conflict": return "The checklist schedule changed elsewhere. Reloaded the latest; no retry was made.";
      case "rollback": return "The checklist schedule could not be saved. Reloaded the latest.";
      case "settle-failed": return "The schedule was saved, but the latest Calendar could not be loaded. Refresh to continue.";
      case "dst-gap": return "That time does not exist in Sydney on that date (daylight-saving gap).";
      case "fold-choice": return "That time occurs twice in Sydney that day. Choose the earlier or later occurrence for each endpoint.";
      case "invalid": return "That schedule change isn't valid.";
      case "range-disabled": return "Range scheduling is unavailable in this app version.";
    }
  }
  switch (kind) {
    case "picked-up": return `Picked up the Deadline${street}. Current time: ${civil(ctx.oldCivil)}.`;
    case "confirm-required": return `Move the Deadline${street} from ${civil(ctx.oldCivil)} to ${civil(ctx.newCivil)}. Confirmation required.`;
    case "cancelled": return `Cancelled moving the Deadline${street}. It remains at ${civil(ctx.oldCivil)}.`;
    case "saving": return `Saving the Deadline${street} at ${civil(ctx.newCivil)}.`;
    case "saved": return `Moved the Deadline${street} to ${civil(ctx.newCivil)}.`;
    case "no-change": return "No change.";
    // Drift-guard mirror of the classifier's conflict announcement; runtime paths use the classifier.
    case "conflict": return "The Deadline changed elsewhere. Reloaded the latest; no retry was made.";
    case "rollback": return "The move could not be saved. Reloaded the latest.";
    case "settle-failed": return "The move was saved, but the latest Calendar could not be loaded. Refresh to continue.";
    case "dst-gap": return "That time does not exist in Sydney on that date (daylight-saving gap). Pick another time.";
    case "fold-choice": return "That time occurs twice in Sydney that day. Choose the earlier or later occurrence.";
    case "invalid": return "That is not a valid Sydney time. Adjust the value and try again.";
    case "range-disabled": return "Range scheduling is unavailable in this app version.";
  }
}

/**
 * FullCalendar's drop announcement is intentionally left enabled for now. If
 * real VoiceOver/NVDA testing finds it pre-empts this Calendar's polite
 * settled result, Slice 11 may enable the scoped suppression seam in the
 * FullCalendar surface (TB5C accessibility checklist line 972).
 */
export const SUPPRESS_FULLCALENDAR_DROP_ANNOUNCEMENT = false;

export type CalendarCommandLock = { active: boolean };

export function canStartCalendarCommand(lock: CalendarCommandLock): boolean {
  return !lock.active;
}

/** Apply the component-owned proposal without mutating the accepted response. */
export function applyOptimisticOverlay(events: readonly CalendarEventDto[], overlay: CalendarOptimisticOverlay): CalendarEventDto[] {
  if (!overlay) return events.slice();
  if ("kind" in overlay) {
    if (overlay.kind === "reschedule-unscheduled") return [...events.filter((event) => event.id !== overlay.asEvent.id), overlay.asEvent];
    return events.slice();
  }
  return events.map((event) => event.id === overlay.eventId ? { ...event, timing: overlay.timing } : event);
}

export function rollbackToBaseline(events: readonly CalendarEventDto[]): CalendarEventDto[] {
  return events.slice();
}

/** Calendar optimism is only safe once the confirmation promise has accepted the proposal. */
export function optimismSafeBeforeResponse(confirmed: boolean): boolean {
  return confirmed;
}
