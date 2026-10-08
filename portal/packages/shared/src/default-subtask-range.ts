import { z } from "zod";
import { SUBTASK_END_PRESET_TIME, SUBTASK_START_PRESET_TIME, type RangeChecklistScheduleInput } from "./checklist-schedule";
import { formatSydneyCivilMinute, isSydneyCalendarDate, resolveSydneyCivilMinute, sydneyBusinessDate, type SydneyCivilDisambiguation } from "./sydney-civil-time";

export type DefaultSubtaskRange = RangeChecklistScheduleInput;

/** A Project's Deadline as the default range sees it: the civil minute and the fold it was stored with. */
export type DefaultSubtaskRangeDeadline = {
  /** Sydney local civil. A legacy date-only value ("YYYY-MM-DD") takes the end preset. */
  localCivil: string;
  /** 1 when the stored Deadline is the later of an ambiguous Sydney time; anything else is 0. */
  fold?: 0 | 1 | null;
};

export type DefaultSubtaskRangeInput = {
  /** Raw Project shoot date (free text). Used only when it is a canonical YYYY-MM-DD date. */
  shootDate: string | null | undefined;
  /** The Project's effective Deadline, or null while none is set. */
  deadline: DefaultSubtaskRangeDeadline | null | undefined;
  /** Project creation instant, epoch milliseconds. */
  projectCreatedAt: number;
  /** The moment the default is for, epoch milliseconds. A default that would end at or before it is pushed forward (ADR 0011). */
  now: number;
};

const CIVIL_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** Calendar arithmetic on a `YYYY-MM-DD` date, never +/-24h. */
function shiftDay(date: string, delta: 1 | -1): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const shifted = new Date(0);
  shifted.setUTCFullYear(year, month - 1, day + delta);
  shifted.setUTCHours(0, 0, 0, 0);
  return shifted.toISOString().slice(0, 10);
}

function presetRange(day: string): DefaultSubtaskRange {
  return { state: "range", start: { localCivil: `${day}T${SUBTASK_START_PRESET_TIME}` }, end: { localCivil: `${day}T${SUBTASK_END_PRESET_TIME}` } };
}

/**
 * A default range never ends in the past (#736). When `range`'s end is at or before `now`, it becomes today's
 * 09:00 to 17:00 Sydney, or tomorrow's once today's 17:00 is at or before `now`. A range that ends after `now`
 * is returned unchanged (a past start with a future end is kept). Idempotent: pushing an already pushed range
 * at a later time equals pushing the original at that time.
 */
export function notBeforeNow(range: DefaultSubtaskRange, now: number): DefaultSubtaskRange {
  if (!Number.isFinite(now)) throw new RangeError("now must be a finite epoch time");
  const resolved = resolveSydneyCivilMinute(range.end.localCivil, range.end.disambiguation ?? "earlier");
  if (!resolved.ok || resolved.value.epochMs > now) return range;
  const today = sydneyBusinessDate(now);
  const todayEnd = resolveSydneyCivilMinute(`${today}T${SUBTASK_END_PRESET_TIME}`);
  return presetRange(todayEnd.ok && todayEnd.value.epochMs <= now ? shiftDay(today, 1) : today);
}

/**
 * The Project's default Subtask range (ADR 0011, ADR 0016): a one-time copy of the shoot date at 09:00
 * through the Deadline at its own time. Pure: plain values in, a range input out; callers normalize it
 * with `normalizeChecklistSchedule(range, 1)`.
 *
 * - No usable shoot date: the Project's Sydney creation date.
 * - No usable Deadline: that day, 09:00 to 17:00.
 * - A default whose end is at or before `now` becomes today 09:00 to 17:00 Sydney, or tomorrow once today's 17:00 has passed (`notBeforeNow`).
 * - A Deadline at or before the start day's 09:00: the start moves to 09:00 on the Deadline's own day,
 *   or, when the Deadline is at or before that 09:00 too, to 09:00 the day before. The Deadline is kept.
 */
export function defaultSubtaskRange(input: DefaultSubtaskRangeInput): DefaultSubtaskRange {
  if (!Number.isFinite(input.now)) throw new RangeError("now must be a finite epoch time");
  return notBeforeNow(baseDefaultSubtaskRange(input), input.now);
}

function baseDefaultSubtaskRange(input: DefaultSubtaskRangeInput): DefaultSubtaskRange {
  let startDay: string;
  if (typeof input.shootDate === "string" && isSydneyCalendarDate(input.shootDate)) {
    startDay = input.shootDate;
  } else {
    if (!Number.isFinite(input.projectCreatedAt)) throw new RangeError("projectCreatedAt must be a finite epoch time");
    startDay = formatSydneyCivilMinute(input.projectCreatedAt).slice(0, 10);
    if (!isSydneyCalendarDate(startDay)) throw new RangeError("projectCreatedAt is not a valid instant");
  }

  const range = (start: string, end: string, disambiguation?: SydneyCivilDisambiguation): DefaultSubtaskRange => ({
    state: "range",
    start: { localCivil: start },
    end: { localCivil: end, ...(disambiguation ? { disambiguation } : {}) },
  });

  const raw = input.deadline?.localCivil;
  let deadlineCivil: string | null = null;
  if (typeof raw === "string") {
    if (CIVIL_MINUTE.test(raw) && isSydneyCalendarDate(raw.slice(0, 10))) deadlineCivil = raw;
    else if (isSydneyCalendarDate(raw)) deadlineCivil = `${raw}T${SUBTASK_END_PRESET_TIME}`;
  }
  if (!deadlineCivil) return range(`${startDay}T${SUBTASK_START_PRESET_TIME}`, `${startDay}T${SUBTASK_END_PRESET_TIME}`);

  const disambiguation = input.deadline?.fold === 1 ? "later" : "earlier";
  const deadlineDay = deadlineCivil.slice(0, 10);
  // Civil strings of one shape order lexicographically.
  for (const day of [startDay, deadlineDay]) {
    const start = `${day}T${SUBTASK_START_PRESET_TIME}`;
    if (start < deadlineCivil) return range(start, deadlineCivil, disambiguation);
  }
  return range(`${shiftDay(deadlineDay, -1)}T${SUBTASK_START_PRESET_TIME}`, deadlineCivil, disambiguation);
}

/**
 * A Project's default range as a client holds it: two moments, each a civil minute plus its fold. The
 * popup's "Project default" shortcut applies it, and the composer shows it as the new Subtask's range.
 */
export type ProjectDefaultRangeDto = {
  start: { localCivil: string; fold: 0 | 1 };
  end: { localCivil: string; fold: 0 | 1 };
};

const projectDefaultMomentSchema = z.object({
  localCivil: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  fold: z.union([z.literal(0), z.literal(1)]),
}).strict();

export const projectDefaultRangeSchema: z.ZodType<ProjectDefaultRangeDto> = z.object({ start: projectDefaultMomentSchema, end: projectDefaultMomentSchema }).strict();

/** `defaultSubtaskRange`, as the wire carries it. Only the end can sit on a repeated time, so only it carries a fold. */
export function defaultSubtaskRangeDto(input: DefaultSubtaskRangeInput): ProjectDefaultRangeDto {
  const range = defaultSubtaskRange(input);
  return {
    start: { localCivil: range.start.localCivil, fold: range.start.disambiguation === "later" ? 1 : 0 },
    end: { localCivil: range.end.localCivil, fold: range.end.disambiguation === "later" ? 1 : 0 },
  };
}

/** `notBeforeNow` on the wire shape, for clients holding a cached default. A pushed range carries no fold. */
export function projectDefaultAsOf(dto: ProjectDefaultRangeDto, now: number): ProjectDefaultRangeDto {
  const pushed = notBeforeNow(
    { state: "range", start: { localCivil: dto.start.localCivil }, end: { localCivil: dto.end.localCivil, disambiguation: dto.end.fold === 1 ? "later" : "earlier" } },
    now,
  );
  if (pushed.end.localCivil === dto.end.localCivil && pushed.start.localCivil === dto.start.localCivil) return dto;
  return { start: { localCivil: pushed.start.localCivil, fold: 0 }, end: { localCivil: pushed.end.localCivil, fold: 0 } };
}
