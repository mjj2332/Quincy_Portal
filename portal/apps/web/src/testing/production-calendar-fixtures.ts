/**
 * #222 — minimal Calendar DTO fixtures for the pure-lib tests (`production-calendar-permissions`,
 * `production-event-calendar-adapter`, `production-event-calendar-scheduling`). Test-only; nothing
 * in production imports this file.
 */
import {
  resolveSydneyCivilMinute,
  type ChecklistCalendarEventDto,
  type ChecklistCalendarUnscheduledEntryDto,
  type ChecklistScheduleEndpointDto,
  type ProjectCalendarUnscheduledEntryDto,
  type ProjectDeadlineCalendarEventDto,
} from "@quincy/shared";

export const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
export const ASSIGNEE_ID = "22222222-2222-4222-8222-222222222222";
export const SUBTASK_ID = "33333333-3333-4333-8333-333333333333";

const project = { id: PROJECT_ID, street: "1 Calendar Street", stageKey: "editing_autohdr" as const, checklist: { completed: 0, total: 2 }, delivered: false };
const assignee = { id: ASSIGNEE_ID, name: "Ada Lovelace", roleLabel: "Editor", isExternal: false, active: true };
const status = { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false };

/** A Sydney civil minute as a stored instant (the earlier pass of a repeated hour). */
export function instantOf(localCivil: string): string {
  const resolved = resolveSydneyCivilMinute(localCivil, "earlier");
  if (!resolved.ok) throw new Error(`fixture civil minute did not resolve: ${localCivil}`);
  return resolved.value.instant;
}

export function timed(localCivil: string): ChecklistScheduleEndpointDto {
  const resolved = resolveSydneyCivilMinute(localCivil, "earlier");
  if (!resolved.ok) throw new Error(`fixture civil minute did not resolve: ${localCivil}`);
  return { kind: "timed", localCivil, instant: resolved.value.instant, utcOffsetMinutes: resolved.value.utcOffsetMinutes, fold: resolved.value.fold, resolution: "stored" };
}

export function dated(localCivil: string): ChecklistScheduleEndpointDto {
  return { kind: "date", localCivil, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" };
}

function exclusiveAfter(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export function rangeEvent(start: ChecklistScheduleEndpointDto, end: ChecklistScheduleEndpointDto, over: { canDrag?: boolean; canResize?: boolean; canScheduleRange?: boolean; canOpenScheduleEditor?: boolean; completed?: boolean; id?: string; assigneeNull?: boolean } = {}): ChecklistCalendarEventDto {
  const timing = start.kind === "date"
    ? { allDay: true as const, start: start.localCivil, end: exclusiveAfter(end.localCivil) }
    : { allDay: false as const, start: start.instant!, end: end.instant };
  return {
    id: over.id ?? `checklist:${SUBTASK_ID}`, kind: "checklist", title: "Select hero images", project, assignee: over.assigneeNull ? null : assignee, timing,
    status: { ...status, completed: over.completed ?? false },
    schedule: { state: "range", version: 3, zone: "Australia/Sydney", start, end, due: end.localCivil },
    permissions: { canDrag: over.canDrag ?? true, canResize: over.canResize ?? true, canOpenScheduleEditor: over.canOpenScheduleEditor ?? true, canScheduleRange: over.canScheduleRange ?? true },
  } as ChecklistCalendarEventDto;
}

export function dueEvent(end: ChecklistScheduleEndpointDto, over: { canDrag?: boolean; id?: string } = {}): ChecklistCalendarEventDto {
  const timing = end.kind === "date" ? { allDay: true as const, start: end.localCivil, end: null } : { allDay: false as const, start: end.instant!, end: null };
  return {
    id: over.id ?? `checklist:${SUBTASK_ID}`, kind: "checklist", title: "Deliver proofs", project, assignee, timing, status,
    schedule: { state: "due_only", version: 2, zone: "Australia/Sydney", start: null, end, due: end.localCivil },
    permissions: { canDrag: over.canDrag ?? true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true },
  } as ChecklistCalendarEventDto;
}

export function deadlineEvent(localCivil: string, over: { canDrag?: boolean } = {}): ProjectDeadlineCalendarEventDto {
  return {
    id: `project-deadline:${PROJECT_ID}`, kind: "project_deadline", title: "1 Calendar Street", project,
    timing: { allDay: false, start: instantOf(localCivil), end: null }, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false },
    permissions: { canDrag: over.canDrag ?? true, canResize: false }, deadlineLocalCivil: localCivil, deadlineVersion: 4, reminderOffsetsMinutes: [],
  };
}

export function unscheduledChecklist(over: { reason?: "unscheduled" | "schedule_needs_attention" } = {}): ChecklistCalendarUnscheduledEntryDto {
  if (over.reason === "schedule_needs_attention") {
    return {
      id: `checklist:${SUBTASK_ID}`, kind: "checklist", reason: "schedule_needs_attention", attentionReason: "invalid", title: "Broken", project, assignee: null,
      schedule: { state: "invalid", version: 1, zone: null, start: null, end: null, due: null, error: { code: "subtask_schedule_storage_invalid", reason: "shape_mismatch" } },
      permissions: { canDrag: false, canResize: false, canOpenScheduleEditor: false, canScheduleRange: false },
    } as ChecklistCalendarUnscheduledEntryDto;
  }
  return {
    id: `checklist:${SUBTASK_ID}`, kind: "checklist", reason: "unscheduled", title: "Cull selects", project, assignee: null,
    schedule: { state: "unscheduled", version: 0, zone: "Australia/Sydney", start: null, end: null, due: null },
    permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true },
  } as ChecklistCalendarUnscheduledEntryDto;
}

export function unscheduledProject(): ProjectCalendarUnscheduledEntryDto {
  return {
    id: `project-deadline:${PROJECT_ID}`, kind: "project_deadline", reason: "unscheduled", title: "1 Calendar Street", project,
    permissions: { canDrag: true, canResize: false }, deadlineVersion: 0, reminderOffsetsMinutes: [],
  };
}
