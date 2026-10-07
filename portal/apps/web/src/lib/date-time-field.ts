import { isSydneyCalendarDate, sydneyBusinessDate } from "@quincy/shared";
import { shellChromeBottom } from "./shell-chrome";

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
/** #677: a control that opens below the fold (the TIME input) and its label. The input must not rest in the bottom fade; the label may lie wholly inside the band (the "more below" cue) but never straddle the body's edge. */
export type BottomBoundary = { control: EdgeRect; label?: EdgeRect };
/** An item to keep clear of the fade; `required` ones are never skipped for lying outside the body (#587). */
export type FadeItem = EdgeRect & { required?: boolean; /** Wins over the other required items when they cannot all be cleared (the focused control, WCAG 2.4.11). Implies `required`. */ priority?: boolean };

/** #636: an overlap under 2px with the band edge or the body edge is not visible (a chip's last 2px at the mask's end is ~transparent), and sub-pixel layout (0.19px at 720x900) must not push the list past the presets. */
const SLIVER_TOLERANCE = 2;

/** The viewport's `--fade-size` in px, read through a hidden probe (a custom property cannot be read as a number directly). */
export function measureFade(viewport: HTMLElement): number {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;width:0;height:var(--fade-size)";
  viewport.append(probe);
  const fade = probe.getBoundingClientRect().height;
  probe.remove();
  return fade;
}

/** The smallest whole scroll within `window` at which `slivered` is false (#636), or undefined when there is none. */
function smallestClearScroll(window: { low: number; high: number }, slivered: (scroll: number) => boolean): number | undefined {
  for (let s = Math.ceil(window.low - 1e-9); s <= window.high; s += 1) if (!slivered(s)) return s;
  return undefined;
}

/** The whole scroll within `window` nearest to `from` at which `slivered` is false (#662), the smaller on a tie; undefined when there is none. */
function nearestClearScroll(window: { low: number; high: number }, slivered: (scroll: number) => boolean, from: number): number | undefined {
  let best: number | undefined;
  for (let s = Math.ceil(window.low - 1e-9); s <= window.high; s += 1) {
    if (slivered(s)) continue;
    if (best === undefined || Math.abs(s - from) < Math.abs(best - from)) best = s;
  }
  return best;
}

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
 * window has no valid position; it asks for its top edge aligned to the top band. Rects share one
 * coordinate space.
 *
 * #587 — an item wholly outside the body's visible area is ignored (scrolling to it would hide the month
 * navigation for nothing) UNLESS it is `required`: the day the person is about to edit, or the focused
 * element, must come into view. A required item is never skipped, and when the items cannot all be
 * cleared together the optional ones give way: the solve retries with the required items alone, and if those conflict too, with the `priority` item (the focused control) alone.
 *
 * #630 — `snaps` are body offsets of the tops of the preset rows (and 0), which the caller would rather land on, so
 * the popup never opens with the Today/Tomorrow row cut in half. #674: a row cannot rest flush under the top band, so each snap r > 0 is
 * resolved to `floor(max(r - fade, r / 2))`, the scroll at which that row sits clear of the band; 0 stays 0. When one lies inside the valid window, the SMALLEST
 * wins, never the nearest to `scrollTop` (0 when it is valid, so a day that fits under the presets opens at the top, and a
 * body a resize left further down comes back); when none does, the fade
 * guarantee still wins and the plain nearest-valid position is returned.
 *
 * #636, #662, #674 — `noSliver` items (the pressed time slot, and the active shortcut chip) are not required to be clear, but the chosen scroll must not leave one partly
 * inside the top or the bottom fade: the smallest valid snap where each is fully clear of both bands (or outside the body) wins; failing
 * that, the valid whole scroll that does with the least movement (the smallest when `snaps` were given); failing that, the #630 choice
 * stands, so required and `priority` items stay authoritative.
 *
 * #677 — `boundaries` (the TIME input and its label, which start below the fold) and `chips` (the preset chips) only ever tighten the landing above: when it already
 * leaves each input clear of the bottom band and each label uncut by the body's edge it stands; otherwise the smallest whole scroll with every input wholly below the
 * body or (#686, a short body that holds it from the start) clear of the bottom band, no `noSliver` item slivered and no chip crossing the top band's inner edge wins (a label wholly inside the bottom band is fine); none valid keeps the landing.
 */
export function scrollTopClearOfFade({ viewport, scrollTop, maxScrollTop, fade, items, snaps, noSliver, boundaries, chips }: { viewport: EdgeRect; scrollTop: number; maxScrollTop: number; fade: number; items: readonly FadeItem[]; snaps?: readonly number[]; noSliver?: readonly EdgeRect[]; boundaries?: readonly BottomBoundary[]; chips?: readonly EdgeRect[] }): number {
  const height = viewport.bottom - viewport.top;
  const max = Math.max(0, maxScrollTop);
  const clamp = (value: number) => Math.min(Math.max(0, value), max);
  const solve = (list: readonly FadeItem[]) => {
    let low = 0;
    let high = max;
    for (const item of list) {
      if (!item.required && (item.bottom <= viewport.top || item.top >= viewport.bottom)) continue;
      const top = item.top - viewport.top + scrollTop;
      const bottom = item.bottom - viewport.top + scrollTop;
      const latest = Math.max(top - fade, top / 2);
      const earliest = Math.min(bottom - height + fade, (max + bottom - height) / 2);
      const [from, to] = earliest <= latest ? [earliest, latest] : [clamp(latest), clamp(latest)];
      low = Math.max(low, from);
      high = Math.min(high, to);
    }
    return { low, high };
  };
  const required = items.map((item) => (item.priority ? { ...item, required: true } : item));
  let range = solve(required);
  if (range.low > range.high) range = solve(required.filter((item) => item.required));
  if (range.low > range.high) range = solve(required.filter((item) => item.priority));
  if (range.low > range.high) return scrollTop;
  // Whole pixels, toward the safe side: the top fade needs s <= high (floor), the bottom needs s >= low (ceil). A browser snaps scrollTop
  // to its device-pixel grid (0.5px at DPR 2), and a target sitting exactly on a fade edge lands inside it. Whole pixels are on every such grid.
  const whole = { low: Math.ceil(range.low - 1e-9), high: Math.floor(range.high + 1e-9) };
  const safe = whole.low <= whole.high ? whole : range;
  // #636, #662: an item in `noSliver` (the pressed time slot) is never asked to be clear, but it must not end up PARTLY inside either fade,
  // where a solid chip reads as a grey sliver. At `s` it is fine when fully past a band (above the top one, below the bottom one) or outside
  // the body. The top band is `min(fade, s)`, the bottom `min(fade, max - s)`.
  const sliveredWithin = (tolerance: number) => (s: number) => (noSliver ?? []).some((item) => {
    const top = item.top - viewport.top + scrollTop - s;
    const bottom = item.bottom - viewport.top + scrollTop - s;
    const inTopBand = top + tolerance < Math.min(fade, s) && bottom - tolerance > 0;
    const inBottomBand = bottom - tolerance > height - Math.min(fade, max - s) && top + tolerance < height;
    return inTopBand || inBottomBand;
  });
  const slivered = sliveredWithin(SLIVER_TOLERANCE);
  // #674: a snap is a row's TOP; landing on it raw puts that row flush under the top band (min(fade, s)). Rest where the row clears the band
  // instead: the same `max(r - fade, r / 2)` bound `solve` uses for the top fade, floored to a whole pixel (the safe side for a top band).
  // Snap 0 stays 0.
  const fadeAware = (snaps ?? []).map((snap) => (snap > 0 ? Math.floor(Math.max(snap - fade, snap / 2) + 1e-9) : snap));
  const landing = fadeAware.filter((snap) => snap >= safe.low && snap <= safe.high);
  const clearLanding = landing.filter((snap) => !slivered(snap));
  const legacy = (() => {
    if (clearLanding.length > 0) return Math.min(...clearLanding);
    if (noSliver?.length) {
      // With snaps the smallest clear whole scroll (#636); otherwise the clear whole scroll nearest to where the body is now (#662).
      // #662: without snaps, look for a scroll with no overlap at all first; the 2px tolerance absorbs sub-pixel rounding in what is
      // acceptable, it is not a reason to choose a 2px sliver when a clean scroll is just as reachable.
      const clear = snaps?.length
        ? smallestClearScroll(safe, slivered)
        : nearestClearScroll(safe, sliveredWithin(0), scrollTop) ?? nearestClearScroll(safe, slivered, scrollTop);
      if (clear !== undefined) return clear;
    }
    if (landing.length > 0) return Math.min(...landing);
    return Math.min(Math.max(scrollTop, safe.low), safe.high);
  })();
  if (!boundaries?.length) return legacy;
  // #677: the landing above may leave the TIME input in the bottom fade or its label cut by the body's edge (Today/Tomorrow at 390 landed at 110 with 4px of the
  // input in the band). A landing that already clears them stays. Otherwise the smallest whole scroll at which every input is wholly below the body (so
  // nothing is cut), no required/noSliver item is slivered, and no preset chip crosses the top fade's inner edge (a row tail wholly inside the fade is fine, #674).
  // Nothing valid: the landing above stands, so this only ever adds a constraint.
  const bottomOk = (s: number) => boundaries.every(({ control, label }) => {
    const rel = (rect: EdgeRect) => ({ top: rect.top - viewport.top + scrollTop - s, bottom: rect.bottom - viewport.top + scrollTop - s });
    const c = rel(control);
    const band = Math.min(fade, max - s);
    if (c.bottom - SLIVER_TOLERANCE > height - band && c.top + SLIVER_TOLERANCE < height) return false;
    if (label) {
      const l = rel(label);
      if (l.top + SLIVER_TOLERANCE < height && l.bottom - SLIVER_TOLERANCE > height) return false;
    }
    return true;
  });
  if (bottomOk(legacy)) return legacy;
  const crossesInnerEdge = (s: number) => (chips ?? []).some((chip) => {
    const top = chip.top - viewport.top + scrollTop - s;
    const bottom = chip.bottom - viewport.top + scrollTop - s;
    const edge = Math.min(fade, s);
    return top < edge && bottom > edge;
  });
  // #686: not capped at "wholly below the body": a short body (844x390) holds the input from the start, and the only valid rests are those that scroll it up clear of
  // the bottom band (which shrinks to nothing at the end of the scroll). Ascending, so a scroll that leaves it wholly below still wins when there is one.
  for (let s = Math.ceil(safe.low - 1e-9); s <= safe.high; s += 1) if (!slivered(s) && bottomOk(s) && !crossesInnerEdge(s)) return s;
  // #686: when no scroll meets every rule (a short, wide popup: the stacked chips cross the top fade's inner edge at nearly every scroll), the rules give way in a stated
  // order: (1) the required day stays in view (`safe`, hard); (2) the TIME input is not slivered; (3) the `noSliver` items (the active chip) are not slivered;
  // (4) a chip crossing the top fade's inner edge is dropped first. The smallest whole scroll meeting 1-3 wins; none keeps the landing.
  const strict = sliveredWithin(0);
  for (let s = Math.ceil(safe.low - 1e-9); s <= safe.high; s += 1) if (!strict(s) && bottomOk(s)) return s;
  for (let s = Math.ceil(safe.low - 1e-9); s <= safe.high; s += 1) if (!slivered(s) && bottomOk(s)) return s;
  return legacy;
}

/** #602: below this width the popup stacks its columns, the calendar takes 44px cells and the popup may cover its trigger. Tailwind's `max-[721px]:` compiles to this same `(width < 721px)`. */
export const POPUP_STACKED_QUERY = "(width < 721px)";
/** #686: a short viewport (every landscape phone). The popups drop the time-slot list (its own scroller trapped the wheel in a ~68px body) and let the title scroll with the body. Height only: the wide layout has the same trap. */
export const POPUP_SHORT_QUERY = "(height < 520px)";

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

/**
 * #528, #587 — for a popup too tall to sit above or below its field: it SHIFTS into view (it may cover
 * its own trigger) instead of flipping toward the sticky top bar. Shared by New shoot's Deadline and the
 * Timeline pickers.
 */
export const SHELL_AWARE_SHIFT_AVOIDANCE = { side: "shift", align: "shift", fallbackAxisSide: "none" } as const satisfies PopupCollisionAvoidance;

/**
 * #597: the open Project sheet's distance from each viewport edge, if one is up. The sheet is modal, so nothing behind it can open a
 * picker; any picker opened while one is up lives inside it, and the sheet (not the shell header) is what
 * covers the viewport's top. Base UI marks an open popup `data-open` and a closing one `data-closed`.
 * #629: on desktop the sheet is inset from the viewport on every side, so all four edges are read, not only the top.
 */
function openSheetInsets(): { top: number; right: number; bottom: number; left: number } | null {
  if (typeof document === "undefined") return null;
  const sheets = document.querySelectorAll<HTMLElement>('[data-slot="sheet-content"][data-open]');
  const last = sheets.item(sheets.length - 1);
  if (!last) return null;
  const rect = last.getBoundingClientRect();
  return { top: Math.max(0, rect.top), right: Math.max(0, window.innerWidth - rect.right), bottom: Math.max(0, window.innerHeight - rect.bottom), left: Math.max(0, rect.left) };
}

/**
 * #678: `collisionPadding` for a picker opened from the phone add-task bottom sheet. `shellAwarePopupPadding` insets the popup to the
 * open sheet's rect (right for the Project sheet, which covers the viewport's top); the bottom sheet is SHORT, so that would cap the popup
 * at the sheet's height and leave its footer off-screen. This one measures the viewport itself (shell header on top, the edge gap elsewhere).
 */
export function viewportPopupPadding(): { top: number; right: number; bottom: number; left: number } {
  const gap = DATE_TIME_POPUP_EDGE_GAP;
  return { top: shellChromeBottom() + gap, right: gap, bottom: gap, left: gap };
}

/**
 * `collisionPadding` kept inside whatever bounds the viewport: the open Project sheet's rect on all four edges when there
 * is one (#597, #629), else the shell header on top and the viewport gap elsewhere. Read at open time: a cold load has no header yet, and an impersonation banner lowers it.
 */
export function shellAwarePopupPadding(): { top: number; right: number; bottom: number; left: number } {
  const sheet = openSheetInsets();
  const gap = DATE_TIME_POPUP_EDGE_GAP;
  if (sheet) return { top: sheet.top + gap, right: sheet.right + gap, bottom: sheet.bottom + gap, left: sheet.left + gap };
  return { top: shellChromeBottom() + gap, right: gap, bottom: gap, left: gap };
}
