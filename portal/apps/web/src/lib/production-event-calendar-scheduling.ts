/**
 * #222 — the pure bridge from the vendored ReUI event calendar's proposals to the shared scheduling
 * controller's `SchedulingProposal`.
 *
 * A vendor update (drag, resize-start, resize-end, keyboard Adjust commit) or an external drop of an
 * unscheduled entry becomes exactly one of: a `SchedulingProposal`, a no-op, or an invalid edit.
 *
 * Rules:
 * - The edge comes from `source`. A `keyboard` commit names no edge, so it is classified from the
 *   deltas exactly like the Gantt's `ganttEditKind`: both edges by the same amount is a move, one
 *   edge is a resize of that edge, neither is a no-op, both by different amounts is invalid.
 * - The target subview is `"month"` when the proposal's granularity is `"day"` and `"week"` when it
 *   is `"minute"` — NEVER the UI view name: the shared mappers answer anything else (`day`, `days`,
 *   `agenda`) with `unsupported_subview`, or treat it inconsistently.
 * - A Deadline's or due-only item's `end` is the adapter's synthetic display end, so it is ignored:
 *   a pointer resize is invalid and a keyboard end-only change is a no-op.
 * - The DTO's endpoint KIND wins over the vendor's `allDay` flag: a timed range dropped on the
 *   all-day lane moves by date and keeps its wall time; a dated endpoint stays dated.
 * - Fold `disambiguation` is NEVER derived from the dropped instant (lesson #241). A repeated civil
 *   minute reaches the mapper unresolved, which reports `choices` for the disambiguation UI.
 * - `source: "api"` and a missing `granularity` are invalid: neither carries geometry to trust.
 *
 * Import boundary: like `production-gantt-scheduling.ts`, this file must never import
 * `@/components/reui/event-calendar/**`, not even `import type`. `EventCalendarUpdateLike` and
 * `EventCalendarDropTargetLike` are local structural subsets of the vendor's proposal/drop types.
 * The DTO is an explicit argument, never read back from the vendor event's `data`.
 */
import {
  formatSydneyCivilMinute,
  isSydneyCalendarDate,
  shiftSydneyCalendarDate,
  type CalendarEventDto,
  type CalendarManipulationTarget,
  type ChecklistCalendarEventDto,
  type ChecklistCalendarUnscheduledEntryDto,
  type ChecklistScheduleEndpointDto,
  type ProjectCalendarUnscheduledEntryDto,
  type ProjectDeadlineCalendarEventDto,
} from "@quincy/shared";
import type { SchedulingProposal } from "./scheduling-policy";

/** Structural subset of the vendor's `EventCalendarProposedUpdate`. */
export type EventCalendarUpdateLike = {
  /** The event as displayed (the adapter's instants, including any synthetic end). */
  event: { start: Date; end: Date };
  start: Date;
  end: Date;
  allDay: boolean;
  source: "drag" | "resize-start" | "resize-end" | "keyboard" | "api";
  granularity?: "day" | "minute";
};

/** Structural subset of the vendor's `EventCalendarExternalDropTarget`. */
export type EventCalendarDropTargetLike = { start: Date; dayGranular: boolean };

export type EventCalendarSchedulingResult =
  | { kind: "proposal"; proposal: SchedulingProposal }
  | { kind: "noop" }
  | { kind: "invalid"; reason: EventCalendarInvalidReason };

export type EventCalendarInvalidReason =
  | "api_source"
  | "missing_granularity"
  | "resize_unsupported"
  | "compound_edit"
  | "unschedulable"
  | "invalid_instant";

type Granularity = "day" | "minute";
type EditKind = "move" | "resize-start" | "resize-end";

const NOOP: EventCalendarSchedulingResult = { kind: "noop" };
const invalid = (reason: EventCalendarInvalidReason): EventCalendarSchedulingResult => ({ kind: "invalid", reason });
const found = (proposal: SchedulingProposal): EventCalendarSchedulingResult => ({ kind: "proposal", proposal });

// ---------------------------------------------------------------------------
// Sydney civil helpers
// ---------------------------------------------------------------------------

/** "YYYY-MM-DDTHH:mm" in Sydney, or null for an invalid instant. */
function civilMinute(instant: Date): string | null {
  if (Number.isNaN(instant.getTime())) return null;
  const value = formatSydneyCivilMinute(instant.getTime());
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) && isSydneyCalendarDate(value.slice(0, 10)) ? value : null;
}

function nextDate(date: string): string | null {
  const shifted = shiftSydneyCalendarDate(date, 1);
  return shifted.ok ? shifted.value : null;
}

// ---------------------------------------------------------------------------
// Edge classification
// ---------------------------------------------------------------------------

/** Pointer sources name the edge; a keyboard commit is classified from its deltas. */
function editKind(update: EventCalendarUpdateLike, pointOnly: boolean): EditKind | "none" | "compound" | "resize_unsupported" {
  if (update.source === "drag") return "move";
  if (update.source === "resize-start" || update.source === "resize-end") return pointOnly ? "resize_unsupported" : update.source;
  const startDelta = update.start.getTime() - update.event.start.getTime();
  if (pointOnly) return startDelta === 0 ? "none" : "move";
  const endDelta = update.end.getTime() - update.event.end.getTime();
  if (startDelta === 0 && endDelta === 0) return "none";
  if (startDelta === endDelta) return "move";
  if (endDelta === 0) return "resize-start";
  if (startDelta === 0) return "resize-end";
  return "compound";
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * The target for one endpoint moved to `proposed`. Day granularity → `month` + the new civil date;
 * a timed endpoint also carries its OWN wall time on that date (for the resize mappers, which read
 * `targetCivilMinute`; the move mappers read only the date and preserve wall time themselves).
 * Minute granularity → `week` + the dropped civil minute. `null` = no change.
 */
function endpointTarget(endpoint: ChecklistScheduleEndpointDto | { kind: "timed"; localCivil: string }, proposed: Date, original: Date, granularity: Granularity, withWallTime: boolean): CalendarManipulationTarget | null | "invalid" {
  const minute = civilMinute(proposed);
  if (!minute) return "invalid";
  const date = minute.slice(0, 10);
  if (granularity === "day") {
    if (date === endpoint.localCivil.slice(0, 10)) return null;
    return endpoint.kind === "timed" && withWallTime
      ? { subview: "month", targetDate: date, targetCivilMinute: `${date}${endpoint.localCivil.slice(10, 16)}` }
      : { subview: "month", targetDate: date };
  }
  if (proposed.getTime() === original.getTime()) return null;
  return endpoint.kind === "date" ? { subview: "week", targetDate: date } : { subview: "week", targetDate: date, targetCivilMinute: minute };
}

/** A dated range's end resize: the vendor's end is an exclusive zoned midnight. */
function exclusiveEndTarget(endpoint: ChecklistScheduleEndpointDto, proposed: Date, granularity: Granularity): CalendarManipulationTarget | null | "invalid" {
  const minute = civilMinute(proposed);
  if (!minute) return "invalid";
  const exclusive = minute.endsWith("T00:00") ? minute.slice(0, 10) : nextDate(minute.slice(0, 10));
  const current = nextDate(endpoint.localCivil.slice(0, 10));
  if (!exclusive || !current) return "invalid";
  if (exclusive === current) return null;
  return { subview: granularity === "day" ? "month" : "week", targetDate: exclusive, end: exclusive };
}

function toResult(target: CalendarManipulationTarget | null | "invalid", wrap: (target: CalendarManipulationTarget) => SchedulingProposal): EventCalendarSchedulingResult {
  if (target === "invalid") return invalid("invalid_instant");
  return target === null ? NOOP : found(wrap(target));
}

// ---------------------------------------------------------------------------
// Vendor update → proposal
// ---------------------------------------------------------------------------

function deadlineProposal(event: ProjectDeadlineCalendarEventDto, update: EventCalendarUpdateLike, granularity: Granularity): EventCalendarSchedulingResult {
  const endpoint = { kind: "timed" as const, localCivil: event.deadlineLocalCivil };
  // The mapper's month path shifts the deadline's civil date and preserves its wall time.
  const target = endpointTarget(endpoint, update.start, update.event.start, granularity, false);
  return toResult(target, (t) => ({ kind: "deadline", entity: "project_deadline", event, target: t }));
}

function checklistProposal(source: ChecklistCalendarEventDto, update: EventCalendarUpdateLike, granularity: Granularity, kind: EditKind): EventCalendarSchedulingResult {
  const schedule = source.schedule;
  if (schedule.state === "due_only") {
    if (!schedule.end) return invalid("unschedulable");
    // The display start IS the due endpoint.
    const target = endpointTarget(schedule.end, update.start, update.event.start, granularity, false);
    return toResult(target, (t) => ({ kind: "move", entity: "checklist", source, target: t }));
  }
  if (schedule.state !== "range" || !schedule.start || !schedule.end) return invalid("unschedulable");

  if (kind === "move") {
    const target = endpointTarget(schedule.start, update.start, update.event.start, granularity, false);
    return toResult(target, (t) => ({ kind: "move", entity: "checklist", source, target: t }));
  }
  if (kind === "resize-start") {
    const target = endpointTarget(schedule.start, update.start, update.event.start, granularity, true);
    return toResult(target, (t) => ({ kind: "resize", entity: "checklist", source, edge: "start", target: { ...t, edge: "start" } }));
  }
  const target = schedule.end.kind === "date"
    ? exclusiveEndTarget(schedule.end, update.end, granularity)
    : endpointTarget(schedule.end, update.end, update.event.end, granularity, true);
  return toResult(target, (t) => ({ kind: "resize", entity: "checklist", source, edge: "end", target: { ...t, edge: "end" } }));
}

/**
 * One vendor proposal against its DTO. `dto` must be the event the proposal was made on (the caller
 * looks it up by `update.event.id`); this module never reads it back from the vendor event.
 */
export function eventCalendarUpdateToProposal(dto: CalendarEventDto, update: EventCalendarUpdateLike): EventCalendarSchedulingResult {
  if (update.source === "api") return invalid("api_source");
  const granularity = update.granularity;
  if (granularity !== "day" && granularity !== "minute") return invalid("missing_granularity");

  const pointOnly = dto.kind === "project_deadline" || dto.schedule.state === "due_only";
  const kind = editKind(update, pointOnly);
  if (kind === "none") return NOOP;
  if (kind === "compound") return invalid("compound_edit");
  if (kind === "resize_unsupported") return invalid("resize_unsupported");

  return dto.kind === "project_deadline" ? deadlineProposal(dto, update, granularity) : checklistProposal(dto, update, granularity, kind);
}

// ---------------------------------------------------------------------------
// External drop → placement
// ---------------------------------------------------------------------------

/** An unscheduled entry dropped on the calendar: a day cell places by date, a column by minute. */
export function eventCalendarDropToProposal(entry: ChecklistCalendarUnscheduledEntryDto | ProjectCalendarUnscheduledEntryDto, drop: EventCalendarDropTargetLike): EventCalendarSchedulingResult {
  const minute = civilMinute(drop.start);
  if (!minute) return invalid("invalid_instant");
  const date = minute.slice(0, 10);
  const target: CalendarManipulationTarget = drop.dayGranular ? { subview: "month", targetDate: date } : { subview: "week", targetDate: date, targetCivilMinute: minute };
  if (entry.kind === "project_deadline") return found({ kind: "place", entity: "project_deadline", entry, target });
  if (entry.reason !== "unscheduled") return invalid("unschedulable");
  return found({ kind: "place", entity: "checklist", entry, target });
}
