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

export type PopupCollisionAvoidance = { side?: "shift" | "none"; align?: "shift" | "none"; fallbackAxisSide?: "start" | "end" | "none" };
export type PopupCollisionPadding = number | { top?: number; right?: number; bottom?: number; left?: number };

/** `--space-4` in px: the gap a date popup keeps from the viewport edge, and the default `collisionPadding` below. */
export const DATE_TIME_POPUP_EDGE_GAP = 16;

/** `padding` as four edges with the top raised to at least `top`. Used to pin a popup's top to its field row (#537). */
export function popupPaddingWithTopAtLeast(padding: PopupCollisionPadding, top: number): { top: number; right: number; bottom: number; left: number } {
  const edges = typeof padding === "number" ? { top: padding, right: padding, bottom: padding, left: padding } : { top: padding.top ?? 0, right: padding.right ?? 0, bottom: padding.bottom ?? 0, left: padding.left ?? 0 };
  return { ...edges, top: Math.max(edges.top, top) };
}

type EdgeRect = { top: number; bottom: number };

/**
 * #537 — the popup body fades each edge by `min(fade, overflow past that edge)`: the top band is
 * `min(fade, s)` and the bottom band `min(fade, max - s)` at scroll `s`, so a move changes the bands it
 * is judged against. Selected items (the picked day, the pressed time slot) inside a band read as muddy
 * grey, not solid ink.
 *
 * Solved exactly, not by proposing a move and checking it. With the item at document offsets
 * `top`..`bottom` and a body of height `H`, it is clear at `s` when `top - s >= min(fade, s)` and
 * `bottom - s <= H - min(fade, max - s)`; each is a one-sided bound on `s`:
 *   s <= max(top - fade, top / 2)        and        s >= min(bottom - H + fade, (max + bottom - H) / 2)
 * so each item owns a closed interval of valid scroll positions. The result is the position nearest to
 * the current `scrollTop` inside the intersection of those intervals (so the least scroll, in either
 * direction), or the current `scrollTop` when the intersection is empty. An item taller than the clear
 * window has no valid position; it asks for its top edge aligned to the top band. An item wholly outside
 * the body's visible area is ignored, since scrolling to it would hide the month navigation for nothing.
 * Rects share one coordinate space.
 */
export function scrollTopClearOfFade({ viewport, scrollTop, maxScrollTop, fade, items }: { viewport: EdgeRect; scrollTop: number; maxScrollTop: number; fade: number; items: readonly EdgeRect[] }): number {
  const height = viewport.bottom - viewport.top;
  const max = Math.max(0, maxScrollTop);
  const clamp = (value: number) => Math.min(Math.max(0, value), max);
  let low = 0;
  let high = max;
  for (const item of items) {
    if (item.bottom <= viewport.top || item.top >= viewport.bottom) continue;
    const top = item.top - viewport.top + scrollTop;
    const bottom = item.bottom - viewport.top + scrollTop;
    const latest = Math.max(top - fade, top / 2);
    const earliest = Math.min(bottom - height + fade, (max + bottom - height) / 2);
    const [from, to] = earliest <= latest ? [earliest, latest] : [clamp(latest), clamp(latest)];
    low = Math.max(low, from);
    high = Math.min(high, to);
  }
  return low <= high ? Math.min(Math.max(scrollTop, low), high) : scrollTop;
}

/**
 * How a date popup resolves its collision policy (#447, #528): below `sm` it shifts over its
 * trigger; above, it stays on one axis. A caller's override replaces the default outright, and an
 * `undefined` override is "no opinion", so it can never erase the default.
 */
export function resolveDateTimePopupPlacement({ narrow, avoidance, padding }: { narrow: boolean; avoidance?: PopupCollisionAvoidance | undefined; padding?: PopupCollisionPadding | undefined }): { collisionAvoidance: PopupCollisionAvoidance; collisionPadding: PopupCollisionPadding } {
  return {
    collisionAvoidance: avoidance ?? (narrow ? { side: "shift", fallbackAxisSide: "none" } : { fallbackAxisSide: "none" }),
    collisionPadding: padding ?? DATE_TIME_POPUP_EDGE_GAP,
  };
}
