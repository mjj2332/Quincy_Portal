import { isSydneyCalendarDate, sydneyBusinessDate } from "@quincy/shared";

/**
 * #421 — the pure rules behind `quincy/DateTimeField`. A value here is always a civil
 * `YYYY-MM-DD` string; a `Date` appears only as the calendar grid's cell key (`civilToCell` /
 * `cellToCivil`, the same local-midnight pattern `ProductionEventCalendarRail` uses), never as a
 * value, so no result moves with the viewer's time zone or a DST transition.
 */

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const pad2 = (value: number) => String(value).padStart(2, "0");

function parts(civil: string): { year: number; month: number; day: number } {
  const [year = 1970, month = 1, day = 1] = civil.split("-").map(Number);
  return { year, month, day };
}

/** The Sydney civil day of `now` — computed when the popup opens, so it is stable while it is open. */
export function sydneyToday(now: number = Date.now()): string {
  return sydneyBusinessDate(now);
}

/** `civil` shifted by whole calendar days, via `Date.UTC` — never `ms + 86_400_000`. */
export function addCivilDays(civil: string, days: number): string {
  const { year, month, day } = parts(civil);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/** ISO weekday of a civil day: Monday = 1 .. Sunday = 7. */
export function civilWeekday(civil: string): number {
  const { year, month, day } = parts(civil);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/** The calendar grid's cell key for a civil day: local midnight of that calendar date. */
export function civilToCell(civil: string): Date {
  const { year, month, day } = parts(civil);
  return new Date(year, month - 1, day);
}

export function cellToCivil(cell: Date): string {
  return `${cell.getFullYear()}-${pad2(cell.getMonth() + 1)}-${pad2(cell.getDate())}`;
}

export type DateShortcut = {
  id: "today" | "tomorrow" | "later-this-week" | "next-week" | "no-date";
  label: string;
  sublabel: string;
  /** The civil day this shortcut picks, or `null` for "No date". */
  resolve: () => string | null;
};

function weekdayName(civil: string): string {
  return WEEKDAY_NAMES[civilWeekday(civil) - 1]!;
}

/**
 * The shortcut rows for a popup opened on Sydney day `today`. Weeks run Monday to Sunday.
 * "Later this week" is this week's Thursday and is offered only Mon-Wed (from Thursday it would
 * be today or the past, and rolling it into next week would duplicate "Next week"). "Next week"
 * is the Monday of the following week (on a Sunday that is tomorrow, which is accepted).
 * "No date" appears only when the field is clearable.
 */
export function buildShortcuts({ today, clearable }: { today: string; clearable: boolean }): DateShortcut[] {
  const iso = civilWeekday(today);
  const rows: DateShortcut[] = [];
  const tomorrow = addCivilDays(today, 1);
  rows.push({ id: "today", label: "Today", sublabel: weekdayName(today), resolve: () => today });
  rows.push({ id: "tomorrow", label: "Tomorrow", sublabel: weekdayName(tomorrow), resolve: () => tomorrow });
  if (iso <= 3) {
    const thursday = addCivilDays(today, 4 - iso);
    rows.push({ id: "later-this-week", label: "Later this week", sublabel: weekdayName(thursday), resolve: () => thursday });
  }
  const nextMonday = addCivilDays(today, 8 - iso);
  const { month, day } = parts(nextMonday);
  rows.push({ id: "next-week", label: "Next week", sublabel: `${weekdayName(nextMonday)} ${day} ${MONTH_NAMES[month - 1]}`, resolve: () => nextMonday });
  if (clearable) rows.push({ id: "no-date", label: "No date", sublabel: "", resolve: () => null });
  return rows;
}

/** Year range the month/year dropdowns offer: today's year +-10, widened to include `value`'s year. */
export function yearBounds(today: string, value: string | null): { startYear: number; endYear: number } {
  const todayYear = parts(today).year;
  let startYear = todayYear - 10;
  let endYear = todayYear + 10;
  if (value && isSydneyCalendarDate(value)) {
    const valueYear = parts(value).year;
    startYear = Math.min(startYear, valueYear);
    endYear = Math.max(endYear, valueYear);
  }
  return { startYear, endYear };
}

/**
 * #422 — the date-time form's pure rules.
 *
 * `splitCivilMinute` / `joinCivilMinute` move between a Sydney civil minute (`YYYY-MM-DDTHH:mm`) and
 * its day and time halves; a time is always zero-padded `HH:mm`.
 */
export function splitCivilMinute(localCivil: string): { day: string | null; time: string | null } {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(localCivil);
  return match ? { day: match[1]!, time: match[2]! } : { day: null, time: null };
}

export function joinCivilMinute(day: string | null, time: string | null): string | null {
  return day && time ? `${day}T${time}` : null;
}

/** The time column: the whole day in 15-minute steps, `00:00` to `23:45`. */
export function timeSlots(): string[] {
  return Array.from({ length: 96 }, (_, index) => `${pad2(Math.floor(index / 4))}:${pad2((index % 4) * 15)}`);
}

/**
 * The typed-time input: `H:MM`, `HH:MM` or `HHMM` on a 24-hour clock, `00:00` to `23:59`. An
 * off-grid minute (`17:07`) is accepted as typed and never rounded to a slot. Seconds, `24:00`,
 * a bare hour and anything else is rejected.
 */
export function parseTypedTime(text: string): { ok: true; time: string } | { ok: false } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim()) ?? /^(\d{2})(\d{2})$/.exec(text.trim());
  if (!match) return { ok: false };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return { ok: false };
  return { ok: true, time: `${pad2(hour)}:${pad2(minute)}` };
}

/** Whether two reminder offset sets hold the same offsets, whatever their order. Shared by both popups' "saved line is stale" rule. */
export function sameReminderOffsets(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((offset) => b.includes(offset));
}
