import { resolveSydneyCivilMinute, shiftSydneyCalendarDate } from "@quincy/shared";

/**
 * #222 — the Calendar's Sydney time copy, shared by both renderers so they cannot drift apart.
 *
 * - `utcOffsetLabel`: an occurrence's UTC offset (`UTC+11:00`). A negative offset uses U+2212 `−`,
 *   the typographic minus, never an ASCII hyphen. Sydney's own offsets are always positive; the
 *   sign branch still has to be right. Used by the schedule editor fields and the event-calendar
 *   dialogs (and, until #224, the FullCalendar move / fold dialogs).
 * - `productionCalendarZoneLabel`: `Sydney time · AEST`, `· AEDT`, or `· AEST/AEDT` when the
 *   visible range crosses a DST change. Used under both toolbars' period titles.
 */
export function utcOffsetLabel(minutes: number): string {
  const sign = minutes < 0 ? "−" : "+";
  const absolute = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

/** A civil-date window, end EXCLUSIVE (the shape `deriveProductionCalendarWindow` returns). */
export type SydneyCalendarRange = { start: string; end: string };

function zoneAbbreviation(range: SydneyCalendarRange): string {
  const endDay = shiftSydneyCalendarDate(range.end, -1);
  if (!endDay.ok) return "Sydney time";
  const start = resolveSydneyCivilMinute(`${range.start}T12:00`);
  const end = resolveSydneyCivilMinute(`${endDay.value}T12:00`);
  const names = [start, end].flatMap((value) => value.ok ? [value.value.utcOffsetMinutes === 600 ? "AEST" : value.value.utcOffsetMinutes === 660 ? "AEDT" : `UTC${value.value.utcOffsetMinutes >= 0 ? "+" : ""}${value.value.utcOffsetMinutes / 60}`] : []);
  if (names.length === 0) return "Sydney time";
  return new Set(names).size === 1 ? names[0]! : "AEST/AEDT";
}

export function productionCalendarZoneLabel(range: SydneyCalendarRange): string {
  return `Sydney time · ${zoneAbbreviation(range)}`;
}
