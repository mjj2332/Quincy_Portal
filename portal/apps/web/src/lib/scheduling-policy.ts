import {
  calendarChecklistEntityId,
  checklistScheduleToDto,
  mapChecklistEndResizeToCommand,
  mapChecklistMoveToCommand,
  mapChecklistStartResizeToCommand,
  mapProjectDeadlineMoveToCommand,
  mapUnscheduledProjectDropToCommand,
  normalizeChecklistSchedule,
  resolveSydneyCivilMinute,
  shiftSydneyCalendarDate,
  type CalendarManipulationTarget,
  type CalendarMappingResult,
  type CalendarPerson,
  type CalendarEventTiming,
  type ChecklistCalendarEventDto,
  type ChecklistDisambiguation,
  type ChecklistScheduleDto,
  type RangeChecklistScheduleInput,
  type ProjectCalendarUnscheduledEntryDto,
  type ProjectDeadlineCalendarEventDto,
  type ProjectDeadlineDisambiguation,
  type ProductionCalendarFilters,
  type ProductionCalendarRangeResponse,
  type SaveChecklistScheduleRequest,
  type SaveProjectDeadlineRequest,
} from "@quincy/shared";
import { ApiError } from "./api";
import { cloneSource } from "./production-calendar-interaction";
import { scheduleWindowWarnings, type ScheduleBounds, type SchedulingWarning } from "./schedule-bounds";
import type { ChecklistMutationResult, SaveResponse } from "./scheduling-types";

/** The Subtask a gesture starts from: always a scheduled range event (ADR 0011). */
export type ChecklistSource = ChecklistCalendarEventDto;

export type SchedulingProposal =
  | { kind: "move"; entity: "checklist"; source: ChecklistCalendarEventDto; target: CalendarManipulationTarget; disambiguation?: ChecklistDisambiguation }
  | { kind: "resize"; entity: "checklist"; source: ChecklistCalendarEventDto; edge: "start" | "end"; target: CalendarManipulationTarget; disambiguation?: ChecklistDisambiguation }
  | { kind: "place"; entity: "project_deadline"; entry: ProjectCalendarUnscheduledEntryDto; target: CalendarManipulationTarget; disambiguation?: ProjectDeadlineDisambiguation }
  | { kind: "deadline"; entity: "project_deadline"; event: ProjectDeadlineCalendarEventDto; target: CalendarManipulationTarget; disambiguation?: ProjectDeadlineDisambiguation };

// #288: the out-of-range rule and its types live in `schedule-bounds.ts`; re-exported for importers.
export type { ScheduleBounds, SchedulingWarning, SchedulingWarningCode } from "./schedule-bounds";

export type SchedulingPlan =
  | { kind: "checklist"; request: SaveChecklistScheduleRequest; schedule: RangeChecklistScheduleInput; timing: CalendarEventTiming | null; warnings: SchedulingWarning[] }
  | { kind: "deadline"; request: SaveProjectDeadlineRequest; localCivil: string; timing: CalendarEventTiming; warnings: SchedulingWarning[] };

export function cloneFilters(filters: ProductionCalendarFilters): ProductionCalendarFilters {
  return { ...filters, layers: [...filters.layers], editorIds: [...filters.editorIds], stageKeys: [...filters.stageKeys] };
}

export function cloneResponse(response: ProductionCalendarRangeResponse): ProductionCalendarRangeResponse {
  return {
    ...response,
    range: { ...response.range, appliedFilters: cloneFilters(response.range.appliedFilters) },
    events: response.events.map((event) => cloneSource(event)),
  };
}

export function responseEvent(response: ProductionCalendarRangeResponse | null, eventId: string): ProjectDeadlineCalendarEventDto | undefined {
  const event = response?.events.find((candidate) => candidate.id === eventId);
  return event?.kind === "project_deadline" ? event : undefined;
}

/**
 * The sentinel `projectDeadlinePlaceholder` stamps onto `timing.start` for an unscheduled project
 * deadline's placeholder DTO — inert to schedule math (year 1970), and exported so
 * `scheduling-undo.ts` can detect "this DTO represents 'no deadline was set', not a real one"
 * structurally, rather than by comparing `deadlineLocalCivil` against the display string
 * "Not scheduled" (#216 fix round 5 item 5).
 */
export const PROJECT_DEADLINE_PLACEHOLDER_INSTANT = "1970-01-01T00:00:00.000Z";

export function projectDeadlinePlaceholder(entry: ProjectCalendarUnscheduledEntryDto): ProjectDeadlineCalendarEventDto {
  return {
    id: entry.id,
    kind: "project_deadline",
    title: entry.title,
    project: cloneSource(entry).project,
    timing: { allDay: false, start: PROJECT_DEADLINE_PLACEHOLDER_INSTANT, end: null },
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
  if (schedule.start.kind === "date" && schedule.end.kind === "date") {
    const exclusive = shiftSydneyCalendarDate(schedule.end.localCivil, 1);
    return exclusive.ok ? { allDay: true, start: schedule.start.localCivil, end: exclusive.value } : null;
  }
  if (schedule.start.kind !== "timed" || schedule.end.kind !== "timed" || !schedule.start.instant || !schedule.end.instant) return null;
  return { allDay: false, start: schedule.start.instant, end: schedule.end.instant };
}

function endpointInput(endpoint: ChecklistScheduleDto["start"]): RangeChecklistScheduleInput["start"] {
  return { kind: endpoint.kind, localCivil: endpoint.localCivil, ...(endpoint.fold === 1 ? { disambiguation: "later" as const } : endpoint.fold === 0 ? { disambiguation: "earlier" as const } : {}) };
}

export function checklistInputFromSchedule(schedule: ChecklistScheduleDto): RangeChecklistScheduleInput {
  return { state: "range", start: endpointInput(schedule.start), end: endpointInput(schedule.end) };
}

export function checklistCurrentCivil(event: ChecklistCalendarEventDto): string {
  return event.schedule.start.localCivil;
}

export function inputDisambiguation(schedule: RangeChecklistScheduleInput, endpoint: "start" | "end"): "earlier" | "later" | undefined {
  const value = schedule[endpoint];
  return value.kind === "timed" ? value.disambiguation : undefined;
}

export function checklistSourceFromResponse(response: ProductionCalendarRangeResponse | null, id: string): ChecklistSource | undefined {
  const event = response?.events.find((candidate) => candidate.id === id);
  return event?.kind === "checklist" ? event : undefined;
}

export function checklistAssigneeForResult(source: ChecklistSource, result: ChecklistMutationResult): CalendarPerson | null {
  if (source.assignee && result.assignee && source.assignee.id === result.assignee.id) return source.assignee;
  return result.assignee;
}

/** Keep the source's person objects when the result names the same people; a list-less result keeps the source's list while its first assignee is unchanged. */
export function checklistAssigneesForResult(source: ChecklistSource, result: ChecklistMutationResult): CalendarPerson[] {
  const kept = source.assignees;
  if (result.assignees === null) {
    if (!result.assignee) return [];
    return kept[0]?.id === result.assignee.id ? kept : [result.assignee];
  }
  const same = result.assignees.length === kept.length && result.assignees.every((person, index) => person.id === kept[index]?.id);
  return same ? kept : result.assignees;
}

export function canonicalChecklistEvent(source: ChecklistSource, result: ChecklistMutationResult): ChecklistCalendarEventDto | null {
  const schedule = result.schedule;
  const timing = timingFromChecklistSchedule(schedule);
  if (!timing) return null;
  return {
    id: result.id,
    kind: "checklist",
    title: result.title,
    project: { ...source.project, checklist: { ...source.project.checklist } },
    assignee: checklistAssigneeForResult(source, result),
    assignees: checklistAssigneesForResult(source, result),
    otherAssigneeCount: source.otherAssigneeCount,
    timing,
    status: { ...source.status, completed: result.done },
    schedule,
    permissions: { ...source.permissions },
  };
}

export function optimisticChecklistEvent(source: ChecklistSource, schedule: ChecklistScheduleDto): ChecklistCalendarEventDto | null {
  return canonicalChecklistEvent(source, {
    id: source.id,
    title: source.title,
    done: source.status.completed,
    assignee: source.assignee,
    assignees: source.assignees,
    position: 0,
    schedule,
    scheduleVersion: schedule.version,
  });
}

export function adoptChecklistResult(response: ProductionCalendarRangeResponse, source: ChecklistSource, result: ChecklistMutationResult): ProductionCalendarRangeResponse {
  // The subtasks route's PATCH response carries the BARE subtask uuid in `result.id`
  // (workers/app/src/lib/project-subtasks.ts), never the `checklist:`-prefixed Calendar
  // entity id. Re-mint it here before it becomes an entity id anywhere below — comparing
  // it against `event.id` (an entity id) or writing it straight into a new event
  // would otherwise leave a duplicate, un-prefixed row until the next
  // authoritative refetch overwrote it (#226).
  const entityId = calendarChecklistEntityId(result.id);
  const nextEvent = canonicalChecklistEvent(source, { ...result, id: entityId });
  const events = response.events.filter((event) => event.id !== entityId);
  if (nextEvent) events.push(nextEvent);
  return { ...response, events };
}

function civilDateOnly(value: string): string {
  return value.slice(0, 10);
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
 * the retired `ProductionCalendar.tsx`'s `mapChecklistCommand`/`mapAndRunDropProposal`/
 * `mapAndRunUnscheduledProjectProposal` did, then folds in `normalizeChecklistSchedule` +
 * `timingFromChecklistSchedule` (checklist) or a civil-minute resolution (deadline) to build the
 * `SchedulingPlan`. Mapper errors pass through unchanged (same `code`/`endpoint`/`choices`).
 * A checklist plan's `warnings` are the shared out-of-range rule (`scheduleWindowWarnings`) over
 * `options.bounds`; no bounds → `[]`.
 */
export function planSchedulingProposal(proposal: SchedulingProposal, options?: { bounds?: ScheduleBounds | null }): CalendarMappingResult<SchedulingPlan> {
  const bounds = options?.bounds ?? null;

  if (proposal.entity === "checklist") {
    const mapped = proposal.kind === "move"
      ? mapChecklistMoveToCommand({ event: proposal.source, target: proposal.target, ...(proposal.disambiguation ? { disambiguation: proposal.disambiguation } : {}) })
      : proposal.edge === "end"
        ? mapChecklistEndResizeToCommand({ event: proposal.source, target: { ...proposal.target, edge: "end" }, edge: "end", ...(proposal.disambiguation ? { disambiguation: proposal.disambiguation } : {}) })
        : mapChecklistStartResizeToCommand({ event: proposal.source, target: { ...proposal.target, edge: "start" }, edge: "start", ...(proposal.disambiguation ? { disambiguation: proposal.disambiguation } : {}) });
    if (!mapped.ok) return mapped;
    const normalized = normalizeChecklistSchedule(mapped.value.schedule, mapped.value.expectedVersion);
    if (!normalized.ok) return { ok: false, error: normalized.error };
    const timing = timingFromChecklistSchedule(checklistScheduleToDto(normalized.value));
    const warnings = scheduleWindowWarnings(mapped.value.schedule, bounds);
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
