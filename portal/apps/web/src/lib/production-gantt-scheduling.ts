/**
 * #221 PR B1 — the pure bridge between the Dashboard Gantt and the shared scheduling controller.
 *
 * The Gantt reads `GanttProjectRowDto` / `GanttChecklistRowDto`; the controller speaks the
 * Calendar's DTOs and `SchedulingProposal`. Everything here is a pure transform: Gantt row → the
 * Calendar-shaped source the controller expects, a Gantt drag/resize/drop → a `SchedulingProposal`
 * the shared mappers plan, the Gantt's `ScheduleBounds` (the advisory window rule itself lives in
 * `schedule-bounds.ts`, shared with the Calendar), and the optimistic overlay back onto the Gantt
 * model.
 *
 * Time rule: every civil value is Sydney civil, derived through the shared Sydney helpers. A day
 * delta is `Math.round(ms / 86_400_000)` — the rounding absorbs the 23h/25h DST days — and is then
 * applied in CIVIL space (`shiftSydneyCalendarDate`), never by adding raw milliseconds to a civil
 * time.
 *
 * Import boundary: like `production-gantt-adapter.ts` (see its header), this file must never import
 * `@/components/reui/gantt/**`, not even `import type` — `harness-reachability.guard.test.ts`
 * counts a type import as a consumer. `GanttEdit` and `GanttScale` below are local structural types.
 */

import {
  calendarChecklistEntityId,
  shiftSydneyCalendarDate,
  subtaskIdFromCalendarEntityId,
  type CalendarEventTiming,
  type CalendarManipulationTarget,
  type CalendarProjectContext,
  type ChecklistCalendarEventDto,
  type ChecklistCalendarUnscheduledEntryDto,
  type DueOnlyChecklistScheduleDto,
  type GanttChecklistRowDto,
  type GanttProjectRowDto,
  type ProjectCalendarUnscheduledEntryDto,
  type ProjectDeadlineCalendarEventDto,
  type RangeChecklistScheduleDto,
  type UnscheduledChecklistScheduleDto,
} from "@quincy/shared";
import type { CalendarOptimisticOverlay } from "./production-calendar-interaction";
import {
  resolveCivilDayStart,
  type ProductionGanttEvent,
  type ProductionGanttModel,
  type ProductionGanttRowData,
} from "./production-gantt-adapter";
import {
  beforeLowerBound,
  endsAfterDeadline,
  scheduleBoundsFrom,
  sydneyCivilDate,
  sydneyCivilMinute,
  type ScheduleBounds,
} from "./schedule-bounds";
import {
  timingFromChecklistSchedule,
  type ChecklistSource,
  type SchedulingProposal,
} from "./scheduling-policy";

const DAY_MS = 86_400_000;
/** Calendar id prefix for a project deadline (workers/app/src/routes/production-calendar.ts). */
export const PROJECT_DEADLINE_ID_PREFIX = "project-deadline:";

export type GanttScale = "day" | "week" | "month" | "quarter" | "year";

/** A drag/resize the Gantt surface reports, in plain instants. Local — not the vendor type. */
export type GanttEdit = {
  kind: "move" | "resize-start" | "resize-end";
  eventStart: Date;
  eventEnd: Date;
  proposedStart: Date;
  proposedEnd: Date;
  scale: GanttScale;
};

// ---------------------------------------------------------------------------
// Sydney civil helpers
// ---------------------------------------------------------------------------

// `sydneyCivilMinute` / `sydneyCivilDate` live in `schedule-bounds.ts` (the created-at lower bound
// needs them too).

function shiftDate(date: string, delta: number): string | null {
  const shifted = shiftSydneyCalendarDate(date, delta);
  return shifted.ok ? shifted.value : null;
}

/**
 * Shift a civil minute's DATE by `delta` days and keep its wall time, as a plain civil string.
 * Deliberately unresolved: a wall time that is nonexistent/repeated on the new date must reach the
 * mapper/planner, which reports it with `endpoint` + `choices` for the disambiguation UI, rather
 * than being swallowed here as "no proposal".
 */
function shiftCivilMinute(localCivil: string, delta: number): string | null {
  const date = shiftDate(localCivil.slice(0, 10), delta);
  return date ? `${date}${localCivil.slice(10, 16)}` : null;
}

function dayDelta(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}

function projectContext(project: GanttProjectRowDto): CalendarProjectContext {
  return { id: project.id, street: project.street, stageKey: project.stageKey, checklist: { ...project.checklist }, delivered: project.delivered };
}

// ---------------------------------------------------------------------------
// Gantt rows → Calendar-shaped sources
// ---------------------------------------------------------------------------

export function ganttChecklistSource(project: GanttProjectRowDto, row: GanttChecklistRowDto): ChecklistSource | null {
  const schedule = row.schedule;
  const common = {
    id: calendarChecklistEntityId(row.id),
    kind: "checklist" as const,
    title: row.title,
    project: projectContext(project),
    assignee: row.assignee ? { ...row.assignee } : null,
  };
  const { canDrag, canResize, canOpenScheduleEditor, canScheduleRange } = row.permissions;

  if (schedule.state === "unscheduled") {
    return { ...common, reason: "unscheduled", schedule: schedule as UnscheduledChecklistScheduleDto, permissions: { canDrag, canResize: false, canOpenScheduleEditor, canScheduleRange } };
  }
  if (schedule.state !== "due_only" && schedule.state !== "range") return null;

  const timing = timingFromChecklistSchedule(schedule);
  if (!timing) return null;
  const status = { overdue: false, delivered: project.delivered, completed: row.done, sameAssigneeOverlap: false };
  if (schedule.state === "due_only") {
    return { ...common, timing, status, schedule: schedule as DueOnlyChecklistScheduleDto, permissions: { canDrag, canResize: false, canOpenScheduleEditor, canScheduleRange } };
  }
  return { ...common, timing, status, schedule: schedule as RangeChecklistScheduleDto, permissions: { canDrag, canResize, canOpenScheduleEditor, canScheduleRange } };
}

export function ganttDeadlineEvent(project: GanttProjectRowDto): ProjectDeadlineCalendarEventDto | null {
  const deadline = project.deadline;
  if (!deadline) return null;
  return {
    id: `${PROJECT_DEADLINE_ID_PREFIX}${project.id}`,
    kind: "project_deadline",
    title: project.street,
    project: projectContext(project),
    timing: { allDay: false, start: deadline.at, end: null },
    status: { overdue: deadline.overdue, delivered: project.delivered, completed: false, sameAssigneeOverlap: false },
    permissions: { canDrag: project.permissions.canEditDeadline, canResize: false },
    deadlineLocalCivil: deadline.localCivil,
    deadlineVersion: deadline.version,
    reminderOffsetsMinutes: [...deadline.reminderOffsetsMinutes],
  };
}

export function ganttDeadlineEntry(project: GanttProjectRowDto): ProjectCalendarUnscheduledEntryDto {
  return {
    id: `${PROJECT_DEADLINE_ID_PREFIX}${project.id}`,
    kind: "project_deadline",
    reason: "unscheduled",
    title: project.street,
    project: projectContext(project),
    permissions: { canDrag: project.permissions.canEditDeadline, canResize: false },
    deadlineVersion: project.deadlineVersion,
    reminderOffsetsMinutes: [],
  };
}

// ---------------------------------------------------------------------------
// Advisory schedule window
// ---------------------------------------------------------------------------

/** The Gantt's input to the shared rule (`scheduleWindowWarnings`, `schedule-bounds.ts`). */
export function ganttScheduleBounds(project: GanttProjectRowDto): ScheduleBounds {
  return scheduleBoundsFrom({ shootDateCivil: project.shootDateCivil, createdAt: project.createdAt, deadlineLocalCivil: project.deadline?.localCivil ?? null });
}

// ---------------------------------------------------------------------------
// Gantt edits → SchedulingProposal
// ---------------------------------------------------------------------------

function dayScaleTimedTarget(instant: Date): CalendarManipulationTarget | null {
  const civil = sydneyCivilMinute(instant);
  return civil ? { subview: "week", targetDate: civil.slice(0, 10), targetCivilMinute: civil } : null;
}

export function ganttEditToProposal(source: ChecklistCalendarEventDto, edit: GanttEdit): SchedulingProposal | null {
  const schedule = source.schedule;
  if (schedule.state === "due_only" && edit.kind !== "move") return null;

  const start = schedule.state === "range" ? schedule.start : null;
  const end = schedule.end;
  if (!end || (schedule.state === "range" && !start)) return null;

  const edgeInstant = edit.kind === "resize-end" ? edit.proposedEnd : edit.proposedStart;
  const originalInstant = edit.kind === "resize-end" ? edit.eventEnd : edit.eventStart;
  const edge = edit.kind === "resize-start" ? "start" : edit.kind === "resize-end" ? "end" : null;
  const movedEndpoint = edit.kind === "resize-end" ? end : edit.kind === "resize-start" ? start! : (start ?? end);
  const timed = movedEndpoint.kind === "timed";

  const wrap = (target: CalendarManipulationTarget): SchedulingProposal => (edge
    ? { kind: "resize", entity: "checklist", source, edge, target: { ...target, edge } }
    : { kind: "move", entity: "checklist", source, target });

  if (edit.scale === "day" && timed) {
    const target = dayScaleTimedTarget(edgeInstant);
    return target ? wrap(target) : null;
  }

  const delta = dayDelta(originalInstant, edgeInstant);
  if (delta === 0) return null;

  if (edge === null) {
    // `checklistMoveSchedule`'s month path reads `targetDate` as the new civil date of the START
    // endpoint (range) or the END endpoint (due_only), preserving wall time for timed endpoints.
    const targetDate = shiftDate(movedEndpoint.localCivil.slice(0, 10), delta);
    return targetDate ? wrap({ subview: "month", targetDate }) : null;
  }

  if (!timed) {
    if (edge === "start") {
      const targetDate = shiftDate(movedEndpoint.localCivil, delta);
      return targetDate ? wrap({ subview: "month", targetDate }) : null;
    }
    // The end-resize mapper reads `target.end` as the EXCLUSIVE all-day end.
    const exclusive = shiftDate(movedEndpoint.localCivil, delta + 1);
    return exclusive ? wrap({ subview: "month", targetDate: exclusive, end: exclusive }) : null;
  }

  const shifted = shiftCivilMinute(movedEndpoint.localCivil, delta);
  return shifted ? wrap({ subview: "week", targetDate: shifted.slice(0, 10), targetCivilMinute: shifted }) : null;
}

export function ganttPlacementToProposal(entry: ChecklistCalendarUnscheduledEntryDto, slot: { start: Date; allDay: boolean }, scale: GanttScale): SchedulingProposal | null {
  if (entry.reason !== "unscheduled") return null;
  if (scale === "day" && !slot.allDay) {
    const target = dayScaleTimedTarget(slot.start);
    return target ? { kind: "place", entity: "checklist", entry, target } : null;
  }
  const targetDate = sydneyCivilDate(slot.start);
  return targetDate ? { kind: "place", entity: "checklist", entry, target: { subview: "month", targetDate } } : null;
}

export function ganttDeadlineEditToProposal(event: ProjectDeadlineCalendarEventDto, proposedEnd: Date, originalEnd: Date, scale: GanttScale): SchedulingProposal | null {
  if (scale === "day") {
    const target = dayScaleTimedTarget(proposedEnd);
    return target ? { kind: "deadline", entity: "project_deadline", event, target } : null;
  }
  const delta = dayDelta(originalEnd, proposedEnd);
  if (delta === 0) return null;
  // `mapProjectDeadlineMoveToCommand`'s month path shifts the deadline's civil date to `targetDate`
  // and preserves its wall time.
  const targetDate = shiftDate(event.deadlineLocalCivil.slice(0, 10), delta);
  return targetDate ? { kind: "deadline", entity: "project_deadline", event, target: { subview: "month", targetDate } } : null;
}

// ---------------------------------------------------------------------------
// Deadline effects preview (#221 PR C)
// ---------------------------------------------------------------------------

export type DeadlineEffectStatus = "on-time" | "after";

export type DeadlineStartClash = { kind: "deadline-before-start"; boundKind: "shoot" | "created" };

export type DeadlineEffectsPreview = {
  affected: Array<{ id: string; title: string; before: DeadlineEffectStatus; after: DeadlineEffectStatus }>;
  clashes: Array<{ kind: "subtask-after-deadline"; id: string; title: string } | DeadlineStartClash>;
  /** Checklist rows actually loaded for this project; `total` is the project's full count. */
  loaded: number;
  total: number;
  truncated: boolean;
};

/**
 * The new deadline's civil DATE before the project's lower bound (`ganttScheduleBounds` — the
 * shoot date, else the Sydney creation date). Same civil-date rule as `scheduleWindowWarnings`'
 * lower bound, so the drop hint and the confirm dialog always agree. The adapter's own inverted-bar
 * check compares instants (a created-at bar starts at `createdAt` itself), so a deadline earlier on
 * the creation DAY is inverted there but not a clash here — display-only, never blocking.
 */
export function deadlineStartClash(project: GanttProjectRowDto, newLocalCivil: string): DeadlineStartClash | null {
  const lower = ganttScheduleBounds(project).lower;
  if (!lower || !beforeLowerBound(newLocalCivil, lower)) return null;
  return { kind: "deadline-before-start", boundKind: lower.kind };
}

export function deadlineStartClashText(clash: DeadlineStartClash): string {
  return clash.boundKind === "shoot" ? "Deadline before the shoot date." : "Deadline before the project was created.";
}

/**
 * What moving `project`'s deadline to `newDeadline` does to its LOADED checklist rows: every
 * scheduled (`range`/`due_only`) row whose after-deadline status flips either way, plus the clashes
 * (rows newly after the deadline, and a deadline before the bar start). Pure; advisory only.
 */
export function previewDeadlineEffects(project: GanttProjectRowDto, newDeadline: { localCivil: string; instant: string }): DeadlineEffectsPreview {
  const oldCivil = project.deadline?.localCivil ?? null;
  const affected: DeadlineEffectsPreview["affected"] = [];
  const clashes: DeadlineEffectsPreview["clashes"] = [];
  for (const row of project.children.rows) {
    const schedule = row.schedule;
    if (schedule.state !== "range" && schedule.state !== "due_only") continue;
    const end = schedule.end;
    if (!end) continue;
    const before: DeadlineEffectStatus = endsAfterDeadline(end, oldCivil) ? "after" : "on-time";
    const after: DeadlineEffectStatus = endsAfterDeadline(end, newDeadline.localCivil) ? "after" : "on-time";
    if (before === after) continue;
    affected.push({ id: row.id, title: row.title, before, after });
    if (after === "after") clashes.push({ kind: "subtask-after-deadline", id: row.id, title: row.title });
  }
  const startClash = deadlineStartClash(project, newDeadline.localCivil);
  if (startClash) clashes.push(startClash);
  return { affected, clashes, loaded: project.children.rows.length, total: project.children.total, truncated: project.children.truncated };
}

/**
 * The vendor `dropWarning` for a project bar's end-edge resize: the same mapping the commit uses
 * (`ganttDeadlineEditToProposal`), then `deadlineStartClash` on the target date. `null` for a
 * project with no deadline or a no-op edit.
 */
export function ganttDeadlineDropWarning(project: GanttProjectRowDto, proposedEnd: Date, originalEnd: Date, scale: GanttScale): string | null {
  const event = ganttDeadlineEvent(project);
  if (!event) return null;
  const proposal = ganttDeadlineEditToProposal(event, proposedEnd, originalEnd, scale);
  if (!proposal || proposal.entity !== "project_deadline" || proposal.kind !== "deadline") return null;
  const clash = deadlineStartClash(project, proposal.target.targetDate);
  return clash ? deadlineStartClashText(clash) : null;
}

// ---------------------------------------------------------------------------
// Optimistic overlay
// ---------------------------------------------------------------------------

/** A Calendar timing as Gantt instants; `end: null` is a zero-length milestone. */
function instantsFromTiming(timing: CalendarEventTiming): { start: Date; end: Date; allDay: boolean } | null {
  if (timing.allDay) {
    const start = resolveCivilDayStart(timing.start.slice(0, 10));
    if (!start.ok) return null;
    if (timing.end === null) return { start: start.date, end: start.date, allDay: true };
    const end = resolveCivilDayStart(timing.end.slice(0, 10));
    return end.ok ? { start: start.date, end: end.date, allDay: true } : null;
  }
  const start = new Date(timing.start);
  if (Number.isNaN(start.getTime())) return null;
  if (timing.end === null) return { start, end: start, allDay: false };
  const end = new Date(timing.end);
  return Number.isNaN(end.getTime()) ? null : { start, end, allDay: false };
}

function replaceEvent(
  model: ProductionGanttModel,
  eventId: string,
  update: (event: ProductionGanttEvent<ProductionGanttRowData>) => ProductionGanttEvent<ProductionGanttRowData>,
): ProductionGanttModel {
  const index = model.events.findIndex((event) => event.id === eventId);
  if (index < 0) return model;
  const events = [...model.events];
  events[index] = update(events[index]!);
  return { ...model, events };
}

function withProjectBarEnd(model: ProductionGanttModel, projectId: string, end: Date): ProductionGanttModel {
  if (Number.isNaN(end.getTime())) return model;
  return replaceEvent(model, `project-bar:${projectId}`, (event) => ({ ...event, end }));
}

function withChecklistOverlay(model: ProductionGanttModel, entityId: string, timing: CalendarEventTiming): ProductionGanttModel {
  const subtaskId = subtaskIdFromCalendarEntityId(entityId);
  const instants = instantsFromTiming(timing);
  if (!subtaskId || !instants) return model;
  return replaceEvent(model, `task:${subtaskId}`, (event) => ({ ...event, ...instants }));
}

function withRescheduledEntry(model: ProductionGanttModel, entityId: string, timing: CalendarEventTiming): ProductionGanttModel {
  const subtaskId = subtaskIdFromCalendarEntityId(entityId);
  const instants = instantsFromTiming(timing);
  if (!subtaskId || !instants) return model;
  const resourceId = `task:${subtaskId}`;
  const entry = model.attention.find((candidate) => candidate.resourceId === resourceId && candidate.kind === "task");
  if (!entry || entry.kind !== "task") return model;
  const color = model.resources.flatMap((resource) => resource.children ?? []).find((child) => child.id === resourceId)?.color;
  const event: ProductionGanttEvent<ProductionGanttRowData> = {
    id: resourceId,
    title: entry.dto.title,
    ...instants,
    ...(color !== undefined ? { color } : {}),
    // Pending write: not interactive until the authoritative refetch replaces it.
    readOnly: true,
    resourceId,
    ...(entry.dto.done ? { progress: 100 } : {}),
    data: { kind: "task", dto: entry.dto, hollowStart: false, missingDeadline: false },
  };
  return {
    ...model,
    events: [...model.events.filter((candidate) => candidate.id !== resourceId), event],
    attention: model.attention.filter((candidate) => candidate !== entry),
  };
}

/**
 * Applies the controller's in-flight overlay (and a deadline pending in the confirm dialog) to a
 * Gantt model. Pure: returns a new model and never mutates `model`; an overlay naming nothing in
 * the model is a no-op.
 */
export function applyGanttOptimisticOverlay(
  model: ProductionGanttModel,
  overlay: CalendarOptimisticOverlay,
  pendingDeadline?: { projectId: string; end: Date } | null,
): ProductionGanttModel {
  let next = model;
  if (overlay) {
    if ("kind" in overlay) {
      next = withRescheduledEntry(next, overlay.entryId, overlay.timing);
    } else if (overlay.eventId.startsWith(PROJECT_DEADLINE_ID_PREFIX)) {
      const instants = instantsFromTiming(overlay.timing);
      if (instants) next = withProjectBarEnd(next, overlay.eventId.slice(PROJECT_DEADLINE_ID_PREFIX.length), instants.start);
    } else {
      next = withChecklistOverlay(next, overlay.eventId, overlay.timing);
    }
  }
  if (pendingDeadline) next = withProjectBarEnd(next, pendingDeadline.projectId, pendingDeadline.end);
  return next;
}
