/**
 * #222 — minimal Calendar DTO fixtures for the pure-lib tests (`production-calendar-permissions`,
 * `production-event-calendar-adapter`, `production-event-calendar-scheduling`). Test-only; nothing
 * in production imports this file.
 */
import {
  adminProductionCalendarRangeResponseSchema,
  deriveProductionCalendarWindow,
  editorProductionCalendarRangeResponseSchema,
  externalCalendarRangeSchema,
  PRODUCTION_CALENDAR_ZONE,
  resolveSydneyCivilMinute,
  subtaskIdFromCalendarEntityId,
  type CalendarEventDto,
  type ChecklistScheduleDto,
  type ProductionCalendarProjectBounds,
  type ProductionCalendarRangeResponse,
  type ProductionCalendarSubview,
  type ChecklistCalendarEventDto,
  type ChecklistScheduleEndpointDto,
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

/** `at` plus one hour, as a timed endpoint (a timed range needs start < end); a date endpoint is its own one-day range end. */
function oneDayEnd(at: ChecklistScheduleEndpointDto): ChecklistScheduleEndpointDto {
  if (at.kind === "date") return at;
  const next = new Date(`${at.localCivil}:00Z`);
  next.setUTCHours(next.getUTCHours() + 1);
  return timed(next.toISOString().slice(0, 16));
}

/** A one-day (date) or one-hour (timed) range starting at `at`: the ordinary checklist chip the calendar tests move. */
export function oneDayEvent(at: ChecklistScheduleEndpointDto, over: Parameters<typeof rangeEvent>[2] = {}): ChecklistCalendarEventDto {
  return rangeEvent(at, oneDayEnd(at), over);
}

/** The matching range schedule DTO at `version` (for mutation bodies). */
export function oneDaySchedule(at: ChecklistScheduleEndpointDto, version: number): ChecklistScheduleDto {
  return rangeSchedule(at, oneDayEnd(at), version);
}

export function rangeEvent(start: ChecklistScheduleEndpointDto, end: ChecklistScheduleEndpointDto, over: { canDrag?: boolean; canResize?: boolean; canOpenScheduleEditor?: boolean; completed?: boolean; id?: string; assigneeNull?: boolean; version?: number } = {}): ChecklistCalendarEventDto {
  const timing = start.kind === "date"
    ? { allDay: true as const, start: start.localCivil, end: exclusiveAfter(end.localCivil) }
    : { allDay: false as const, start: start.instant!, end: end.instant };
  return {
    id: over.id ?? `checklist:${SUBTASK_ID}`, kind: "checklist", title: "Select hero images", project, assignee: over.assigneeNull ? null : assignee, timing,
    status: { ...status, completed: over.completed ?? false },
    schedule: { state: "range", version: over.version ?? 3, zone: "Australia/Sydney", start, end, due: end.localCivil },
    permissions: { canDrag: over.canDrag ?? true, canResize: over.canResize ?? true, canOpenScheduleEditor: over.canOpenScheduleEditor ?? true },
  } as ChecklistCalendarEventDto;
}

export function deadlineEvent(localCivil: string, over: { canDrag?: boolean; version?: number; offsets?: number[]; stageKey?: "editing_autohdr" | "editing" } = {}): ProjectDeadlineCalendarEventDto {
  return {
    id: `project-deadline:${PROJECT_ID}`, kind: "project_deadline", title: "1 Calendar Street", project: over.stageKey ? { ...project, stageKey: over.stageKey } : project,
    timing: { allDay: false, start: instantOf(localCivil), end: null }, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false },
    permissions: { canDrag: over.canDrag ?? true, canResize: false }, deadlineLocalCivil: localCivil, deadlineVersion: over.version ?? 4, reminderOffsetsMinutes: over.offsets ?? [],
  };
}

// ---------------------------------------------------------------------------------------------
// #222 round 3 — whole range responses and mutation bodies for the `ProductionEventCalendar-*`
// DOM suites. Every response goes through the shared role schema (`.parse`), so a fixture that
// drifts from the wire contract fails here rather than as a confusing render.
// ---------------------------------------------------------------------------------------------

export const PROJECT_STREET = project.street;
export const ASSIGNEE = assignee;

export type FixtureRole = "admin" | "editor" | "external_editor";

export type RangeResponseInput = {
  events?: CalendarEventDto[];
  subview?: ProductionCalendarSubview;
  date?: string;
  role?: FixtureRole;
  layers?: Array<"project" | "checklist">;
  projectBounds?: ProductionCalendarProjectBounds[];
};

export function rangeResponse(input: RangeResponseInput = {}): ProductionCalendarRangeResponse {
  const subview = input.subview ?? "month";
  const date = input.date ?? "2026-08-12";
  const window = deriveProductionCalendarWindow(date, subview);
  const raw = {
    range: {
      start: window.start, end: window.end, date, subview, zone: PRODUCTION_CALENDAR_ZONE,
      appliedFilters: { layers: input.layers ?? ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false },
    },
    events: input.events ?? [],
    filterFacets: {
      projects: [{ id: PROJECT_ID, street: project.street }],
      people: [assignee],
      myTasksUserId: ASSIGNEE_ID,
    },
    ...(input.projectBounds ? { projectBounds: input.projectBounds } : {}),
  };
  const role = input.role ?? "admin";
  const schema = role === "admin" ? adminProductionCalendarRangeResponseSchema : role === "editor" ? editorProductionCalendarRangeResponseSchema : externalCalendarRangeSchema;
  return schema.parse(raw) as ProductionCalendarRangeResponse;
}

/** The worker's checklist PATCH response: the BARE subtask uuid, never the `checklist:` entity id (#226). */
export function checklistMutationBody(event: ChecklistCalendarEventDto, schedule: ChecklistScheduleDto = event.schedule) {
  return { id: subtaskIdFromCalendarEntityId(event.id) ?? event.id, title: event.title, done: event.status.completed, assignee: event.assignee ? { id: event.assignee.id, name: event.assignee.name } : null, position: 1, schedule };
}

/** A range schedule DTO at `version` (for mutation bodies). */
export function rangeSchedule(start: ChecklistScheduleEndpointDto, end: ChecklistScheduleEndpointDto, version: number): ChecklistScheduleDto {
  return { state: "range", version, zone: "Australia/Sydney", start, end, due: end.localCivil } as ChecklistScheduleDto;
}

/** The worker's Deadline PUT response. */
export function deadlineSaveBody(localCivil: string, version = 5, offsets: number[] = []) {
  return { changed: true, current: { version, deadline: { localCivil, instant: instantOf(localCivil) }, reminderOffsetsMinutes: offsets }, eventIntent: null, publicationIds: [] };
}
