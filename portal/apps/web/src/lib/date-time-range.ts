import { SUBTASK_END_PRESET_TIME, SUBTASK_START_PRESET_TIME, defaultSubtaskRangeDto, resolveSydneyCivilMinute, type ProjectDefaultRangeDto } from "@quincy/shared";
import { addCivilDays, civilWeekday, sydneyToday } from "@/lib/date-time-field";

/**
 * #423 — the pure rules behind the range form of `quincy/DateTimeField` (ADR 0016): the shortcut
 * rows and the Project default a Subtask range starts from. A range is two Sydney civil minutes,
 * each with the fold it was stored with. Weeks run Monday to Sunday, as in the single-day shortcuts.
 */

/** A range as the popup holds it: two civil minutes (`YYYY-MM-DDTHH:mm`) and their folds. */
export type DateTimeRangeValue = ProjectDefaultRangeDto;

export type RangeShortcutId = "today" | "tomorrow" | "this-week" | "next-week" | "project-default";

/**
 * `scope: "end"` shortcuts (Today, Tomorrow, This week, Next week) set only the end being edited, from the matching end of `pair`
 * (the whole range the shortcut used to set); `scope: "range"` (Project default) sets both. #683.
 */
export type RangeShortcut = {
  id: RangeShortcutId;
  label: string;
  sublabel: string;
  pair: DateTimeRangeValue;
  scope: "end" | "range";
};

export type RangeEnd = "start" | "end";

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function dayLabel(civil: string): string {
  const [, month = "1", day = "1"] = civil.slice(0, 10).split("-");
  return `${WEEKDAY_NAMES[civilWeekday(civil.slice(0, 10)) - 1]} ${Number(day)} ${MONTH_NAMES[Number(month) - 1]}`;
}

/** `30 Sep – 7 Oct`, or one day (`Sun 20 Sep`) when both ends fall on it: fits two lines in the shortcut rail. */
function spanLabel(startCivil: string, endCivil: string): string {
  const start = startCivil.slice(0, 10);
  const end = endCivil.slice(0, 10);
  if (start === end) return dayLabel(start);
  const short = (civil: string) => dayLabel(civil).split(" ").slice(1).join(" ");
  return `${short(start)} – ${short(end)}`;
}

/** One day at the presets: 09:00 to 17:00. */
function presetDay(start: string, end: string = start): DateTimeRangeValue {
  return { start: { localCivil: `${start}T${SUBTASK_START_PRESET_TIME}`, fold: 0 }, end: { localCivil: `${end}T${SUBTASK_END_PRESET_TIME}`, fold: 0 } };
}

/** `Wed 7 Oct · 09:00`: what an end holds, on the Start | End toggle and on the shortcut that would set it. The year is added (`Sun 3 Oct 2027 · 09:00`) only outside `today`'s Sydney year. */
export function momentLabel(civil: string, today: string = sydneyToday()): string {
  const time = civil.slice(11, 16);
  const day = civil.slice(0, 4) === today.slice(0, 4) ? dayLabel(civil) : `${dayLabel(civil)} ${civil.slice(0, 4)}`;
  return time ? `${day} · ${time}` : day;
}

/**
 * The shortcut rows for a popup opened on Sydney day `today`, with `active` the end being edited. A shortcut sets the ACTIVE end
 * at the presets (#683): Today and Tomorrow are 09:00 / 17:00 of that day, This week runs from today 09:00 to this Sunday 17:00,
 * Next week from next Monday 09:00 to the Sunday after at 17:00. Each sublabel shows the moment it sets on that end.
 * "Project default" re-copies the Project's current span into both ends and is absent when there is none. There is no "No date":
 * a Subtask always has a range.
 */
export function buildRangeShortcuts({ today, projectDefault, active }: { today: string; projectDefault: DateTimeRangeValue | null; active: RangeEnd }): RangeShortcut[] {
  const iso = civilWeekday(today);
  const tomorrow = addCivilDays(today, 1);
  const thisSunday = addCivilDays(today, 7 - iso);
  const nextMonday = addCivilDays(today, 8 - iso);
  const nextSunday = addCivilDays(nextMonday, 6);
  const row = (id: RangeShortcutId, label: string, pair: DateTimeRangeValue): RangeShortcut => ({ id, label, sublabel: momentLabel(pair[active].localCivil, today), pair, scope: "end" });
  const rows: RangeShortcut[] = [
    row("today", "Today", presetDay(today)),
    row("tomorrow", "Tomorrow", presetDay(tomorrow)),
    row("this-week", "This week", presetDay(today, thisSunday)),
    row("next-week", "Next week", presetDay(nextMonday, nextSunday)),
  ];
  if (projectDefault) {
    rows.push({ id: "project-default", label: "Project default", sublabel: spanLabel(projectDefault.start.localCivil, projectDefault.end.localCivil), pair: projectDefault, scope: "range" });
  }
  return rows;
}

export type RangeMoment = { localCivil: string; fold: 0 | 1 };

/** What a shortcut does to a draft: a new moment for an end, or `"keep"` to leave that end's draft (typed text, fold choice) untouched. */
export type RangeShortcutResult = { start: RangeMoment | "keep"; end: RangeMoment | "keep" };

const CIVIL_MINUTE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Wall-clock minutes of a civil minute (no zone: 09:00 to 17:00 is 480 whatever Sydney's offset did in between), or null when it is not one. */
function civilMinutes(civil: string | null): number | null {
  const match = civil ? CIVIL_MINUTE.exec(civil) : null;
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  return Date.UTC(y, mo - 1, d, h, mi) / 60_000;
}

function civilFromMinutes(minutes: number): string {
  return new Date(minutes * 60_000).toISOString().slice(0, 16);
}

/** An end of the draft as the popup holds it: its civil minute (null when empty) and its instant (null when empty, invalid, in a daylight-saving gap or an unchosen repeat). */
export type RangeEndState = { civil: string | null; epochMs: number | null };

function epochOf(moment: RangeMoment): number | null {
  const result = resolveSydneyCivilMinute(moment.localCivil, moment.fold === 1 ? "later" : "earlier");
  return result.ok ? result.value.epochMs : null;
}

/**
 * Applies a shortcut to the draft's two ends. Each end is judged on its own and order is by instant, the rule the server
 * enforces (ADR 0016); only the duration a START collision keeps is civil (wall-clock) minutes. All the collision rules live
 * here (#683):
 * - A Project default sets both ends from either tab, no collision handling.
 * - Otherwise only the active end takes the shortcut's moment and the other is `"keep"`, unless
 *   - the other end has no instant (empty, invalid, in a gap): it is filled from `pair`, whatever the active end holds; or
 *   - START: the new start is at or after the end, so the end moves to keep the old civil duration (the pair's end when
 *     that duration is unknown or not positive); or
 *   - END: the new end is at or before the start, so the start becomes the shortcut's own start (never the past).
 */
export function applyRangeShortcut(row: RangeShortcut, active: RangeEnd, current: { start: RangeEndState; end: RangeEndState }): RangeShortcutResult {
  const { pair } = row;
  if (row.scope === "range") return { start: pair.start, end: pair.end };
  const fromPair: RangeShortcutResult = { start: pair.start, end: pair.end };
  const other = current[active === "start" ? "end" : "start"];
  const moment = pair[active];
  const newEpoch = epochOf(moment);
  if (other.epochMs === null || newEpoch === null) return fromPair;
  if (active === "start") {
    if (newEpoch < other.epochMs) return { start: moment, end: "keep" };
    const oldStart = civilMinutes(current.start.civil);
    const oldEnd = civilMinutes(current.end.civil);
    const newStart = civilMinutes(moment.localCivil);
    if (oldStart === null || oldEnd === null || newStart === null || oldEnd <= oldStart) return fromPair;
    const shifted: RangeMoment = { localCivil: civilFromMinutes(newStart + (oldEnd - oldStart)), fold: 0 };
    // The civil shift can land in a daylight-saving gap (a minute Sydney skips): the pair's end is always a real minute.
    if (epochOf(shifted) === null) return fromPair;
    return { start: moment, end: shifted };
  }
  if (newEpoch > other.epochMs) return { start: "keep", end: moment };
  return fromPair;
}

/**
 * The Project default as a client holds it, derived from a Project's own facts (the Timeline row and
 * the Calendar bounds carry these; the Checklist's list response carries the finished range). The
 * same rule as `defaultSubtaskRange` in `@quincy/shared`: this only names the inputs.
 */
export function deadlineFoldOf(localCivil: string, atInstant: string): 0 | 1 {
  const earlier = resolveSydneyCivilMinute(localCivil, "earlier");
  return earlier.ok && earlier.value.instant !== atInstant ? 1 : 0;
}

/**
 * The Project default from a Project's own facts: the shoot date, creation instant (ISO) and the effective Deadline
 * with its fold. Null when `createdAt` is not a usable instant (the shared rule throws on it). The Calendar's
 * `projectBounds` and the Gantt's project row both carry exactly these.
 */
export function projectDefaultFromFacts(facts: { shootDate: string | null; createdAt: string; deadline: { localCivil: string; fold: 0 | 1 } | null }, now: number): ProjectDefaultRangeDto | null {
  try {
    return defaultSubtaskRangeDto({ shootDate: facts.shootDate, deadline: facts.deadline, projectCreatedAt: Date.parse(facts.createdAt), now });
  } catch {
    return null;
  }
}
