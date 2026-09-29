import type { RangeChecklistScheduleInput } from "./checklist-schedule";
import { formatSydneyCivilMinute, isSydneyCalendarDate } from "./sydney-civil-time";

export type DefaultSubtaskRange = RangeChecklistScheduleInput;

export type DefaultSubtaskRangeInput = {
  /** Raw Project shoot date (free text). Used only when it is a canonical YYYY-MM-DD date. */
  shootDate: string | null | undefined;
  /** Project Deadline as Sydney local civil ("YYYY-MM-DDTHH:MM" or a date). Pass null when the Project has no Deadline set. */
  deadlineLocalCivil: string | null | undefined;
  /** Project creation instant, epoch milliseconds. */
  projectCreatedAt: number;
};

function dateRange(start: string, end: string): DefaultSubtaskRange {
  // A range never runs backwards: an inversion collapses to one day on the later-known end.
  const first = end < start ? end : start;
  return { state: "range", start: { kind: "date", localCivil: first }, end: { kind: "date", localCivil: end } };
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

  const deadlineDate = typeof input.deadlineLocalCivil === "string" ? input.deadlineLocalCivil.slice(0, 10) : null;
  return dateRange(startDate, deadlineDate && isSydneyCalendarDate(deadlineDate) ? deadlineDate : startDate);
}
