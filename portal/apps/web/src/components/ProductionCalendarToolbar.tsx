import { buttonClasses } from "./quincy/Button";
import { SEGMENT_GROUP, SEGMENT_BUTTON } from "./quincy/segment";
import { COARSE_TAP_TARGET } from "./production-calendar-classes";
import { cn } from "@/lib/utils";
import {
  formatSydneyCivilMinute,
  isSydneyCalendarDate,
  resolveSydneyCivilMinute,
  shiftSydneyCalendarDate,
  type DashboardCalendarState,
  type ProductionCalendarSubview,
} from "@quincy/shared";

const TOOLBAR =
  "grid grid-cols-[auto_1fr_auto] items-center gap-[18px] mb-[18px] pt-[12px] pb-[16px] " +
  "border-b border-solid border-border " +
  "max-[721px]:grid-cols-1 max-[721px]:gap-[10px]";

const TOOLBAR_CONTROLS =
  "flex items-center gap-[6px] max-[721px]:justify-center";

const TOOLBAR_PERIOD =
  "min-w-0 flex flex-col items-center gap-[3px] text-center max-[721px]:-order-1";

const TOOLBAR_VIEWS =
  "flex items-center gap-[6px] max-[721px]:justify-center";

// `.qc-cal-toolbar button` in the coarse block. `buttonClasses` and SEGMENT_BUTTON already ship
// `max-[721px]:min-h-[44px]`, so only the width floor and the coarse-pointer half are local.
const TOOLBAR_BUTTON = COARSE_TAP_TARGET;

// `.qc-cal-toolbar__views button { min-width: 72px }`, and `flex: 1` under 720px.
const TOOLBAR_VIEW_BUTTON = "min-w-[72px] max-[721px]:flex-1";

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
    <div className={TOOLBAR} role="toolbar" tabIndex={-1} data-focus-key="calendar-recovery" aria-label={`Production Calendar navigation · ${zoneLabel}`}>
      <div className={TOOLBAR_CONTROLS}>
        <button className={buttonClasses("secondary", { className: TOOLBAR_BUTTON })} type="button" aria-label="Previous period" onClick={() => move(-1)}>Prev</button>
        <button className={buttonClasses("secondary", { className: TOOLBAR_BUTTON })} type="button" onClick={() => onNavigate({ ...calendar, date: todayFor(now) })}>Today</button>
        <button className={buttonClasses("secondary", { className: TOOLBAR_BUTTON })} type="button" aria-label="Next period" onClick={() => move(1)}>Next</button>
      </div>
      <div className={TOOLBAR_PERIOD}>
        <strong className="[font:var(--type-h3)] tracking-[-.02em]">{periodLabel(calendar, range)}</strong>
        <span className="text-muted-foreground [font:var(--type-eyebrow)] tracking-[.1em] uppercase">{zoneLabel}</span>
      </div>
      <div className={cn(SEGMENT_GROUP, TOOLBAR_VIEWS)} aria-label="Calendar view">
        {(["month", "week", "agenda"] as const).map((subview) => <button key={subview} className={cn(SEGMENT_BUTTON, TOOLBAR_VIEW_BUTTON, TOOLBAR_BUTTON, calendar.subview === subview && "is-active")} type="button" aria-pressed={calendar.subview === subview} onClick={() => setSubview(subview)}>{subview[0]!.toUpperCase() + subview.slice(1)}</button>)}
      </div>
    </div>
  );
}
