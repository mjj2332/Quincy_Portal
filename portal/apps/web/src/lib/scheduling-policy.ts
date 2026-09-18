import {
  checklistScheduleToDto,
  mapChecklistEndResizeToCommand,
  mapChecklistMoveToCommand,
  mapChecklistStartResizeToCommand,
  mapProjectDeadlineMoveToCommand,
  mapUnscheduledChecklistDropToCommand,
  mapUnscheduledProjectDropToCommand,
  normalizeChecklistSchedule,
  resolveSydneyCivilMinute,
  shiftSydneyCalendarDate,
  type CalendarManipulationTarget,
  type CalendarMappingResult,
  type CalendarPerson,
  type CalendarEventTiming,
  type ChecklistCalendarEventDto,
  type ChecklistCalendarUnscheduledEntryDto,
  type ChecklistDisambiguation,
  type ChecklistScheduleDto,
  type DueOnlyChecklistScheduleDto,
  type InitialChecklistScheduleInput,
  type ProjectCalendarUnscheduledEntryDto,
  type ProjectDeadlineCalendarEventDto,
  type ProjectDeadlineDisambiguation,
  type ProductionCalendarFilters,
  type ProductionCalendarRangeResponse,
  type RangeChecklistScheduleDto,
  type SaveChecklistScheduleRequest,
  type SaveProjectDeadlineRequest,
  type UnscheduledChecklistScheduleDto,
} from "@quincy/shared";
import { ApiError } from "./api";
import { cloneSource } from "./production-calendar-interaction";
import type { ChecklistMutationResult, SaveResponse } from "./scheduling-types";

export type ChecklistSource = ChecklistCalendarEventDto | ChecklistCalendarUnscheduledEntryDto;

export type SchedulingProposal =
  | { kind: "move"; entity: "checklist"; source: ChecklistCalendarEventDto; target: CalendarManipulationTarget; disambiguation?: ChecklistDisambiguation }
  | { kind: "resize"; entity: "checklist"; source: ChecklistCalendarEventDto; edge: "start" | "end"; target: CalendarManipulationTarget; disambiguation?: ChecklistDisambiguation }
  | { kind: "place"; entity: "checklist"; entry: ChecklistCalendarUnscheduledEntryDto; target: CalendarManipulationTarget; disambiguation?: ChecklistDisambiguation }
  | { kind: "place"; entity: "project_deadline"; entry: ProjectCalendarUnscheduledEntryDto; target: CalendarManipulationTarget; disambiguation?: ProjectDeadlineDisambiguation }
  | { kind: "deadline"; entity: "project_deadline"; event: ProjectDeadlineCalendarEventDto; target: CalendarManipulationTarget; disambiguation?: ProjectDeadlineDisambiguation };

export type SchedulingWarningCode = "subtask_before_project_shoot" | "subtask_after_project_deadline";
export type SchedulingWarning = { code: SchedulingWarningCode; message: string; endpoint: "start" | "end" };
export type ScheduleBounds = { shootDate: string | null; deadlineLocalCivil: string | null } | null;

export type SchedulingPlan =
  | { kind: "checklist"; request: SaveChecklistScheduleRequest; schedule: InitialChecklistScheduleInput; timing: CalendarEventTiming | null; warnings: SchedulingWarning[] }
  | { kind: "deadline"; request: SaveProjectDeadlineRequest; localCivil: string; timing: CalendarEventTiming; warnings: SchedulingWarning[] };

export function cloneFilters(filters: ProductionCalendarFilters): ProductionCalendarFilters {
  return { ...filters, layers: [...filters.layers], editorIds: [...filters.editorIds], stageKeys: [...filters.stageKeys] };
}

export function cloneResponse(response: ProductionCalendarRangeResponse): ProductionCalendarRangeResponse {
  return {
    ...response,
    range: { ...response.range, appliedFilters: cloneFilters(response.range.appliedFilters) },
    events: response.events.map((event) => cloneSource(event)),
    unscheduled: response.unscheduled.map((entry) => cloneSource(entry)),
  };
}

export function responseEvent(response: ProductionCalendarRangeResponse | null, eventId: string): ProjectDeadlineCalendarEventDto | undefined {
  const event = response?.events.find((candidate) => candidate.id === eventId);
  return event?.kind === "project_deadline" ? event : undefined;
}

export function projectDeadlinePlaceholder(entry: ProjectCalendarUnscheduledEntryDto): ProjectDeadlineCalendarEventDto {
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

export function currentMatchesSource(event: ProjectDeadlineCalendarEventDto, current: SaveResponse["current"]): boolean {
  return current.version === event.deadlineVersion
    && current.deadline?.localCivil === event.deadlineLocalCivil
    // Project Deadlines are stored as timed instants; an all-day DTO is only a
    // defensive presentation shape, never a reason to skip the instant check.
    && current.deadline?.instant === event.timing.start
    && JSON.stringify(current.reminderOffsetsMinutes) === JSON.stringify(event.reminderOffsetsMinutes);
}

export function canonicalEventFromSchedule(event: ProjectDeadlineCalendarEventDto, current: SaveResponse["current"]): ProjectDeadlineCalendarEventDto {
  const nextDeadline = current.deadline;
  return {
    ...cloneSource(event),
    deadlineLocalCivil: nextDeadline?.localCivil ?? event.deadlineLocalCivil,
    deadlineVersion: current.version,
    reminderOffsetsMinutes: [...current.reminderOffsetsMinutes],
    timing: nextDeadline ? { allDay: false, start: nextDeadline.instant, end: null } : event.timing,
  };
}

export function proposedCivilForAllDay(source: ProjectDeadlineCalendarEventDto, date: string): string {
  return `${date}T${source.deadlineLocalCivil.slice(11, 16)}`;
}

export function choicesFromError(error: unknown): Array<{ disambiguation: ProjectDeadlineDisambiguation; utcOffsetMinutes: number }> {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== "object") return [];
  const choices = (error.details as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return [];
  return choices.filter((choice): choice is { disambiguation: ProjectDeadlineDisambiguation; utcOffsetMinutes: number } => {
    if (!choice || typeof choice !== "object") return false;
    const value = choice as Record<string, unknown>;
    return (value.disambiguation === "earlier" || value.disambiguation === "later") && typeof value.utcOffsetMinutes === "number";
  });
}

export function endpointChoicesFromError(error: unknown): Array<{ disambiguation: "earlier" | "later"; utcOffsetMinutes: number }> {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== "object") return [];
  const details = error.details as { details?: unknown; choices?: unknown };
  const choices = Array.isArray(details.choices) ? details.choices : details.details && typeof details.details === "object" && Array.isArray((details.details as { choices?: unknown }).choices) ? (details.details as { choices: unknown[] }).choices : [];
  return choices.filter((choice): choice is { disambiguation: "earlier" | "later"; utcOffsetMinutes: number } => {
    if (!choice || typeof choice !== "object") return false;
    const value = choice as Record<string, unknown>;
    return (value.disambiguation === "earlier" || value.disambiguation === "later") && typeof value.utcOffsetMinutes === "number";
  });
}

export function endpointOfError(error: unknown): "start" | "end" | undefined {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== "object") return undefined;
  const details = error.details as { endpoint?: unknown; details?: unknown };
  if (details.endpoint === "start" || details.endpoint === "end") return details.endpoint;
  if (details.details && typeof details.details === "object") {
    const endpoint = (details.details as { endpoint?: unknown }).endpoint;
    if (endpoint === "start" || endpoint === "end") return endpoint;
  }
  return undefined;
}

export function stableScheduleValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableScheduleValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stableScheduleValue(child)]));
}

export function checklistSchedulesEqual(left: ChecklistScheduleDto, right: ChecklistScheduleDto): boolean {
  return JSON.stringify(stableScheduleValue(left)) === JSON.stringify(stableScheduleValue(right));
}

export function timingFromChecklistSchedule(schedule: ChecklistScheduleDto): CalendarEventTiming | null {
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

export function checklistInputFromSchedule(schedule: ChecklistScheduleDto): InitialChecklistScheduleInput {
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

export function checklistCurrentCivil(event: ChecklistCalendarEventDto): string {
  if (event.schedule.state === "due_only") return event.schedule.end?.localCivil ?? event.timing.start;
  if (event.schedule.state === "range") return event.schedule.start?.localCivil ?? event.timing.start;
  return event.timing.start;
}

export function inputDisambiguation(schedule: InitialChecklistScheduleInput, endpoint: "start" | "end"): "earlier" | "later" | undefined {
  const value = schedule.state === "range" ? schedule[endpoint] : schedule.state === "due_only" && endpoint === "end" ? schedule.end : undefined;
  return value?.kind === "timed" ? value.disambiguation : undefined;
}

export function checklistSourceFromResponse(response: ProductionCalendarRangeResponse | null, id: string): ChecklistSource | undefined {
  const event = response?.events.find((candidate) => candidate.id === id);
  if (event?.kind === "checklist") return event;
  const entry = response?.unscheduled.find((candidate) => candidate.id === id);
  return entry?.kind === "checklist" ? entry : undefined;
}

export function checklistAssigneeForResult(source: ChecklistSource, result: ChecklistMutationResult): CalendarPerson | null {
  if (source.assignee && result.assignee && source.assignee.id === result.assignee.id) return source.assignee;
  return result.assignee;
}

export function canonicalChecklistEvent(source: ChecklistSource, result: ChecklistMutationResult): ChecklistCalendarEventDto | null {
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

export function optimisticChecklistEvent(source: ChecklistSource, schedule: ChecklistScheduleDto): ChecklistCalendarEventDto | null {
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

export function adoptChecklistResult(response: ProductionCalendarRangeResponse, source: ChecklistSource, result: ChecklistMutationResult): ProductionCalendarRangeResponse {
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

function civilDateOnly(value: string): string {
  return value.slice(0, 10);
}

/**
 * Advisory-only, never `ok:false`: compares a checklist schedule's civil start/end against the
 * project's shoot date (lower bound) and deadline (upper bound) in Sydney civil-string space —
 * lexicographic on `YYYY-MM-DD[THH:MM]`, collapsing to the date portion when either side of a
 * comparison is date-kind. `bounds === null` (no data source yet — see #216 §0.1) yields `[]`.
 */
export function checkScheduleBounds(schedule: InitialChecklistScheduleInput, bounds: ScheduleBounds): SchedulingWarning[] {
  if (!bounds) return [];
  const warnings: SchedulingWarning[] = [];
  const start = schedule.state === "range" ? schedule.start : null;
  const end = schedule.state === "range" || schedule.state === "due_only" ? schedule.end : null;

  if (bounds.shootDate && start) {
    if (civilDateOnly(start.localCivil) < bounds.shootDate) {
      warnings.push({ code: "subtask_before_project_shoot", message: "This subtask starts before the shoot date.", endpoint: "start" });
    }
  }

  if (bounds.deadlineLocalCivil && end) {
    const dateOnly = end.kind === "date";
    const endCivil = dateOnly ? civilDateOnly(end.localCivil) : end.localCivil;
    const boundCivil = dateOnly ? civilDateOnly(bounds.deadlineLocalCivil) : bounds.deadlineLocalCivil;
    if (endCivil > boundCivil) {
      warnings.push({ code: "subtask_after_project_deadline", message: "This subtask ends after the project deadline.", endpoint: "end" });
    }
  }

  return warnings;
}

function deadlineTimingFromLocalCivil(deadline: { localCivil: string; disambiguation?: ProjectDeadlineDisambiguation }, allDay: boolean): CalendarMappingResult<CalendarEventTiming> {
  const resolved = resolveSydneyCivilMinute(deadline.localCivil, deadline.disambiguation);
  if (!resolved.ok) {
    return { ok: false, error: { code: resolved.code, message: resolved.message, ...("choices" in resolved ? { choices: resolved.choices } : {}) } };
  }
  return { ok: true, value: allDay ? { allDay: true, start: civilDateOnly(deadline.localCivil), end: null } : { allDay: false, start: resolved.value.instant, end: null } };
}

/**
 * Dispatches a typed `SchedulingProposal` to the matching shared mapper, exactly as
 * `ProductionCalendar.tsx`'s `mapChecklistCommand`/`mapAndRunDropProposal`/
 * `mapAndRunUnscheduledProjectProposal` do today, then folds in `normalizeChecklistSchedule` +
 * `timingFromChecklistSchedule` (checklist) or a civil-minute resolution (deadline) to build the
 * `SchedulingPlan`. Mapper errors pass through unchanged (same `code`/`endpoint`/`choices`).
 */
export function planSchedulingProposal(proposal: SchedulingProposal, options?: { bounds?: ScheduleBounds }): CalendarMappingResult<SchedulingPlan> {
  const bounds = options?.bounds ?? null;

  if (proposal.entity === "checklist") {
    const mapped = proposal.kind === "move"
      ? mapChecklistMoveToCommand({ event: proposal.source, target: proposal.target, ...(proposal.disambiguation ? { disambiguation: proposal.disambiguation } : {}) })
      : proposal.kind === "resize"
        ? proposal.edge === "end"
          ? mapChecklistEndResizeToCommand({ event: proposal.source, target: { ...proposal.target, edge: "end" }, edge: "end", ...(proposal.disambiguation ? { disambiguation: proposal.disambiguation } : {}) })
          : mapChecklistStartResizeToCommand({ event: proposal.source, target: { ...proposal.target, edge: "start" }, edge: "start", ...(proposal.disambiguation ? { disambiguation: proposal.disambiguation } : {}) })
        : mapUnscheduledChecklistDropToCommand({ event: proposal.entry, target: proposal.target, ...(proposal.disambiguation ? { disambiguation: proposal.disambiguation } : {}) });
    if (!mapped.ok) return mapped;
    const normalized = normalizeChecklistSchedule(mapped.value.schedule, mapped.value.expectedVersion);
    if (!normalized.ok) return { ok: false, error: normalized.error };
    const timing = timingFromChecklistSchedule(checklistScheduleToDto(normalized.value));
    const warnings = checkScheduleBounds(mapped.value.schedule, bounds);
    return { ok: true, value: { kind: "checklist", request: mapped.value, schedule: mapped.value.schedule, timing, warnings } };
  }

  const mapped = proposal.kind === "deadline"
    ? mapProjectDeadlineMoveToCommand({ event: proposal.event, target: proposal.target, ...(proposal.disambiguation ? { disambiguation: proposal.disambiguation } : {}) })
    : mapUnscheduledProjectDropToCommand({ event: proposal.entry, target: proposal.target, ...(proposal.disambiguation ? { disambiguation: proposal.disambiguation } : {}) });
  if (!mapped.ok) return mapped;
  if (mapped.value.deadline === null) return { ok: false, error: { code: "invalid_schedule", message: "The deadline mapper returned no deadline." } };
  const allDay = proposal.kind === "deadline" ? proposal.event.timing.allDay : false;
  const timing = deadlineTimingFromLocalCivil(mapped.value.deadline, allDay);
  if (!timing.ok) return timing;
  return { ok: true, value: { kind: "deadline", request: mapped.value, localCivil: mapped.value.deadline.localCivil, timing: timing.value, warnings: [] } };
}
