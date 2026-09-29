import type { ChecklistScheduleEndpointInput, RangeChecklistScheduleInput } from "./checklist-schedule";
import { isChecklistCivilMinute } from "./checklist-schedule";
import { formatSydneyCivilMinute, isSydneyCalendarDate, resolveSydneyCivilMinute } from "./sydney-civil-time";

export type DefaultSubtaskRange = RangeChecklistScheduleInput;

export type DefaultSubtaskRangeInput = {
  /** Raw Project shoot date (free text). Used only when it is a canonical YYYY-MM-DD date. */
  shootDate: string | null | undefined;
  /** Project Deadline as Sydney local civil ("YYYY-MM-DDTHH:MM" or a date). Pass null when the Project has no Deadline set. */
  deadlineLocalCivil: string | null | undefined;
  /** Project creation instant, epoch milliseconds. */
  projectCreatedAt: number;
  /** A Subtask's existing due end, when migrating one. It becomes the range's end. An unusable value is ignored. */
  existingDueEnd?: ChecklistScheduleEndpointInput | null;
};

function previousDay(date: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

function dateRange(start: string, end: string): DefaultSubtaskRange {
  // A range never runs backwards: an inversion collapses to one day on the later-known end.
  const first = end < start ? end : start;
  return { state: "range", start: { kind: "date", localCivil: first }, end: { kind: "date", localCivil: end } };
}

function timedRange(startDate: string, end: Extract<ChecklistScheduleEndpointInput, { kind: "timed" }>): DefaultSubtaskRange | null {
  const resolvedEnd = resolveSydneyCivilMinute(end.localCivil, end.disambiguation);
  if (!resolvedEnd.ok || !isChecklistCivilMinute(end.localCivil)) return null;
  const resolvedStart = resolveSydneyCivilMinute(`${startDate}T00:00`, "earlier");
  if (!resolvedStart.ok) return null;
  if (resolvedStart.value.epochMs < resolvedEnd.value.epochMs) {
    return { state: "range", start: { kind: "timed", localCivil: `${startDate}T00:00` }, end };
  }
  return oneDayTimedRange(end);
}

function oneDayTimedRange(end: Extract<ChecklistScheduleEndpointInput, { kind: "timed" }>): DefaultSubtaskRange | null {
  const resolvedEnd = resolveSydneyCivilMinute(end.localCivil, end.disambiguation);
  if (!resolvedEnd.ok || !isChecklistCivilMinute(end.localCivil)) return null;
  // One day ending on the due. A due exactly at 00:00 starts on the preceding day so that start < end.
  const dueDate = end.localCivil.slice(0, 10);
  const collapsed = resolveSydneyCivilMinute(`${dueDate}T00:00`, "earlier");
  const startCivil = collapsed.ok && collapsed.value.epochMs < resolvedEnd.value.epochMs ? `${dueDate}T00:00` : `${previousDay(dueDate)}T00:00`;
  return { state: "range", start: { kind: "timed", localCivil: startCivil }, end };
}

/**
 * A one-day range ending on `end` (ADR 0011): the seed an editor offers for a legacy due-only row.
 * A date end gives start = end. A timed end starts at 00:00 that day (the previous day when the end is exactly 00:00).
 * Returns null when the end cannot be resolved, so a caller seeds blank fields rather than garbage.
 */
export function oneDaySubtaskRange(end: ChecklistScheduleEndpointInput): RangeChecklistScheduleInput | null {
  if (end.kind === "date") return isSydneyCalendarDate(end.localCivil) ? dateRange(end.localCivil, end.localCivil) : null;
  return oneDayTimedRange(end);
}

/**
 * The Project's default Subtask range (ADR 0011): a one-time copy of the shoot date to the Deadline.
 * Pure: plain values in, a range input out. Callers normalize it with `normalizeChecklistSchedule(range, 1)`.
 */
export function defaultSubtaskRange(input: DefaultSubtaskRangeInput): DefaultSubtaskRange {
  let startDate: string;
  if (typeof input.shootDate === "string" && isSydneyCalendarDate(input.shootDate)) {
    startDate = input.shootDate;
  } else {
    if (!Number.isFinite(input.projectCreatedAt)) throw new RangeError("projectCreatedAt must be a finite epoch time");
    startDate = formatSydneyCivilMinute(input.projectCreatedAt).slice(0, 10);
    if (!isSydneyCalendarDate(startDate)) throw new RangeError("projectCreatedAt is not a valid instant");
  }

  const existing = input.existingDueEnd;
  if (existing?.kind === "date" && isSydneyCalendarDate(existing.localCivil)) return dateRange(startDate, existing.localCivil);
  if (existing?.kind === "timed") {
    const range = timedRange(startDate, existing);
    if (range) return range;
  }

  const deadlineDate = typeof input.deadlineLocalCivil === "string" ? input.deadlineLocalCivil.slice(0, 10) : null;
  return dateRange(startDate, deadlineDate && isSydneyCalendarDate(deadlineDate) ? deadlineDate : startDate);
}
