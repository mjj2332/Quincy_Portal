import type {
  CalendarEventDto,
  CalendarEventTiming,
  ProjectDeadlineCalendarEventDto,
  ProductionCalendarFilters,
} from "@quincy/shared";

export type CalendarFocusDescriptor = {
  eventId: string;
  control: "event" | "move-reschedule" | "recovery" | "safe-fallback";
};

/** An interaction-start copy of the accepted response, never a query-cache reference. */
export type CalendarAcceptedSnapshot = {
  event: ProjectDeadlineCalendarEventDto;
  filters: ProductionCalendarFilters;
  principalId: string;
  authorizationEpoch: number;
  focus: CalendarFocusDescriptor;
  capturedNow: number;
};

export function beginCalendarInteraction(input: Omit<CalendarAcceptedSnapshot, "capturedNow"> & { capturedNow?: number }): CalendarAcceptedSnapshot {
  return {
    ...input,
    event: {
      ...input.event,
      project: { ...input.event.project, checklist: { ...input.event.project.checklist } },
      timing: { ...input.event.timing },
      status: { ...input.event.status },
      permissions: { ...input.event.permissions },
      reminderOffsetsMinutes: [...input.event.reminderOffsetsMinutes],
    },
    filters: { ...input.filters, layers: [...input.filters.layers], editorIds: [...input.filters.editorIds], stageKeys: [...input.filters.stageKeys] },
    capturedNow: input.capturedNow ?? Date.now(),
  };
}

export type CalendarOptimisticOverlay = {
  eventId: string;
  timing: CalendarEventTiming;
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

export type CalendarAnnouncementKind = "picked-up" | "confirm-required" | "cancelled" | "saving" | "saved" | "no-change" | "settle-failed";
export type CalendarAnnouncementContext = { street?: string; oldCivil?: string; newCivil?: string; terminal?: boolean };

function civil(value: string | undefined): string {
  return value?.replace("T", " ") ?? "the proposed time";
}

export function calendarAnnouncement(kind: CalendarAnnouncementKind, ctx: CalendarAnnouncementContext): string | undefined {
  if (ctx.terminal) return undefined;
  const street = ctx.street ? ` for ${ctx.street}` : "";
  switch (kind) {
    case "picked-up": return `Picked up the Deadline${street}. Current time: ${civil(ctx.oldCivil)}.`;
    case "confirm-required": return `Move the Deadline${street} from ${civil(ctx.oldCivil)} to ${civil(ctx.newCivil)}. Confirmation required.`;
    case "cancelled": return `Cancelled moving the Deadline${street}. It remains at ${civil(ctx.oldCivil)}.`;
    case "saving": return `Saving the Deadline${street} at ${civil(ctx.newCivil)}.`;
    case "saved": return `Moved the Deadline${street} to ${civil(ctx.newCivil)}.`;
    case "no-change": return "No change.";
    case "settle-failed": return "The move was saved, but the latest Calendar could not be loaded. Refresh to continue.";
  }
}

export type CalendarCommandLock = { active: boolean };

export function canStartCalendarCommand(lock: CalendarCommandLock): boolean {
  return !lock.active;
}

/** Apply the component-owned proposal without mutating the accepted response. */
export function applyOptimisticOverlay(events: readonly CalendarEventDto[], overlay: CalendarOptimisticOverlay): CalendarEventDto[] {
  if (!overlay) return events.slice();
  return events.map((event) => event.id === overlay.eventId ? { ...event, timing: overlay.timing } : event);
}

export function rollbackToBaseline(events: readonly CalendarEventDto[]): CalendarEventDto[] {
  return events.slice();
}

/** Calendar optimism is only safe once the confirmation promise has accepted the proposal. */
export function optimismSafeBeforeResponse(confirmed: boolean): boolean {
  return confirmed;
}
