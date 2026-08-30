import {
  formatSydneyCivilMinute,
  isSydneyCalendarDate,
  resolveSydneyCivilMinute,
  shiftSydneyCalendarDate,
  type DashboardCalendarState,
  type ProductionCalendarSubview,
} from "@quincy/shared";

type CalendarRange = { start: string; end: string };

export type ProductionCalendarToolbarProps = {
  calendar: DashboardCalendarState;
  range: CalendarRange;
  onNavigate: (next: DashboardCalendarState) => void;
  now?: Date | number | string;
};

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function parts(date: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match || !isSydneyCalendarDate(date)) throw new RangeError("Expected a canonical Calendar date.");
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function monthShift(date: string, delta: number): string {
  const current = parts(date);
  const monthIndex = current.year * 12 + current.month - 1 + delta;
  const year = Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12 + 1;
  const next = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
  if (!isSydneyCalendarDate(next)) throw new RangeError("The Calendar month navigation left the supported date range.");
  return next;
}

function shiftForSubview(calendar: DashboardCalendarState, delta: number): string {
  if (calendar.subview === "month") return monthShift(calendar.date, delta);
  const shifted = shiftSydneyCalendarDate(calendar.date, calendar.subview === "week" ? delta * 7 : delta * 14);
  if (!shifted.ok) throw new RangeError("The Calendar navigation left the supported date range.");
  return shifted.value;
}

function todayFor(now: Date | number | string): string {
  const value = formatSydneyCivilMinute(now instanceof Date ? now.getTime() : now).slice(0, 10);
  if (!isSydneyCalendarDate(value)) throw new RangeError("Could not resolve Sydney today.");
  return value;
}

function zoneAbbreviation(range: CalendarRange): string {
  const endDay = shiftSydneyCalendarDate(range.end, -1);
  if (!endDay.ok) return "Sydney time";
  const start = resolveSydneyCivilMinute(`${range.start}T12:00`);
  const end = resolveSydneyCivilMinute(`${endDay.value}T12:00`);
  const names = [start, end].flatMap((value) => value.ok ? [value.value.utcOffsetMinutes === 600 ? "AEST" : value.value.utcOffsetMinutes === 660 ? "AEDT" : `UTC${value.value.utcOffsetMinutes >= 0 ? "+" : ""}${value.value.utcOffsetMinutes / 60}`] : []);
  if (names.length === 0) return "Sydney time";
  return new Set(names).size === 1 ? names[0]! : "AEST/AEDT";
}

export function productionCalendarZoneLabel(range: CalendarRange): string {
  return `Sydney time · ${zoneAbbreviation(range)}`;
}

function periodLabel(calendar: DashboardCalendarState, range: CalendarRange): string {
  const focused = parts(calendar.date);
  if (calendar.subview === "month") return `${LONG_MONTHS[focused.month - 1]} ${focused.year}`;
  const end = shiftSydneyCalendarDate(range.end, -1);
  if (!end.ok) return range.start;
  const startParts = parts(range.start);
  const endParts = parts(end.value);
  if (startParts.year === endParts.year && startParts.month === endParts.month) return `${startParts.day}–${endParts.day} ${SHORT_MONTHS[startParts.month - 1]} ${startParts.year}`;
  if (startParts.year === endParts.year) return `${startParts.day} ${SHORT_MONTHS[startParts.month - 1]} – ${endParts.day} ${SHORT_MONTHS[endParts.month - 1]} ${startParts.year}`;
  return `${startParts.day} ${SHORT_MONTHS[startParts.month - 1]} ${startParts.year} – ${endParts.day} ${SHORT_MONTHS[endParts.month - 1]} ${endParts.year}`;
}

export function ProductionCalendarToolbar({ calendar, range, onNavigate, now = Date.now() }: ProductionCalendarToolbarProps) {
  const zoneLabel = productionCalendarZoneLabel(range);
  const move = (direction: -1 | 1) => onNavigate({ ...calendar, date: shiftForSubview(calendar, direction) });
  const setSubview = (subview: ProductionCalendarSubview) => onNavigate({ ...calendar, subview });

  return (
    <div className="qc-cal-toolbar" role="toolbar" aria-label={`Production Calendar navigation · ${zoneLabel}`}>
      <div className="qc-cal-toolbar__controls">
        <button className="button button--secondary" type="button" aria-label="Previous period" onClick={() => move(-1)}>Prev</button>
        <button className="button button--secondary" type="button" onClick={() => onNavigate({ ...calendar, date: todayFor(now) })}>Today</button>
        <button className="button button--secondary" type="button" aria-label="Next period" onClick={() => move(1)}>Next</button>
      </div>
      <div className="qc-cal-toolbar__period">
        <strong>{periodLabel(calendar, range)}</strong>
        <span className="qc-cal-zone">{zoneLabel}</span>
      </div>
      <div className="segment qc-cal-toolbar__views" aria-label="Calendar view">
        {(["month", "week", "agenda"] as const).map((subview) => <button key={subview} className={calendar.subview === subview ? "is-active" : ""} type="button" aria-pressed={calendar.subview === subview} onClick={() => setSubview(subview)}>{subview[0]!.toUpperCase() + subview.slice(1)}</button>)}
      </div>
    </div>
  );
}
