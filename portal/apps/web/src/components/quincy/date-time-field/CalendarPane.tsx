import { createContext, useContext } from "react";
import { Calendar } from "@/components/reui/calendar";
import { MONTH_NAMES } from "@/lib/date-format";
import { cellToCivil, civilToCell } from "@/lib/date-time-field";
import { cn } from "@/lib/utils";

export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * The popup's month/year dropdowns and day grid: `reui/calendar` (react-day-picker 10) in the
 * grid shape of schedule-10, on civil strings (a `Date` is only the cell key). Month and year are
 * the calendar's own native selects (`captionLayout="dropdown"`) rather than `reui/select`, whose
 * Base UI listbox inside a Base UI popover is unproven for option-dismiss and Escape. The
 * weekday header highlights Sydney's today, as schedule-10's custom Weekday renderer does, but
 * only while the month that contains today is on screen.
 *
 * `selection` is a union: `single` (one civil day) and, since #423, `range` (a start and an end day,
 * either of which may still be empty). The range is CONTROLLED: react-day-picker's own range state
 * machine (first click = from, second = to, a click inside shrinks it) would fight the popup's
 * Start | End toggle, so its computed `onSelect` is ignored and every pick goes through
 * `onPickDay`, which the popup resolves against the active end.
 */

/** The weekday name to highlight in the header, or null (set only while Sydney's today is on screen). */
export const TodayWeekdayContext = createContext<string | null>(null);

/**
 * Module-level on purpose: an inline component is a new type every render and react-day-picker
 * would remount the caption (dropping focus from the month/year select) on each month change.
 */
export const COMPONENTS = {
  Weekday: function Weekday({ children, className, ...props }: React.ComponentPropsWithoutRef<"th">) {
    const todayName = useContext(TodayWeekdayContext);
    return (
      <th
        {...props}
        className={cn(className, "flex flex-1 items-center justify-center", todayName !== null && children === todayName && "bg-muted text-foreground")}
      >
        {children}
      </th>
    );
  },
};

/**
 * Passing `selected` without `onSelect` leaves react-day-picker treating the selection as uncontrolled: it
 * keeps its own highlight after the draft changes from outside (a shortcut, an endpoint edit). A stable
 * no-op makes it controlled, so the grid always mirrors `selected`; picks arrive through `onDayClick`.
 */
const IGNORE_RANGE_SELECT = () => {};

/**
 * The range's endpoint that is NOT being edited: reui/calendar paints both ends bg-primary, so the
 * inactive one is outlined instead and the active end alone stays solid. A modifier on the day cell,
 * reaching the button inside it, keeps the vendored calendar untouched.
 */
const INACTIVE_END_CLASS = "[&_button]:!bg-card [&_button]:!text-foreground [&_button]:ring-2 [&_button]:ring-inset [&_button]:ring-primary " +
  // #581: reui/calendar's range-start/end hover (`!text-primary-foreground`, `bg-primary/80`) must not reach this end: it stays
  // foreground on card. `button[data-day]` adds the specificity that out-ranks the calendar's compound `data-[…]:hover:` rule.
  "[&_button[data-day]]:hover:!bg-card [&_button[data-day]]:hover:!text-foreground";
export { INACTIVE_END_CLASS };

export const LABELS = {
  labelMonthDropdown: () => "Month",
  labelYearDropdown: () => "Year",
  labelPrevious: () => "Previous month",
  labelNext: () => "Next month",
};

export const FORMATTERS = {
  formatMonthDropdown: (date: Date) => MONTH_NAMES[date.getMonth()]!,
  formatWeekdayName: (date: Date) => WEEKDAY_SHORT[date.getDay()]!,
};

export type CalendarSelection = { mode: "single"; day: string | null } | { mode: "range"; start: string | null; end: string | null; activeEnd?: "start" | "end" };

export function CalendarPane({ selection, today, month, onMonthChange, onPickDay, startYear, endYear }: {
  selection: CalendarSelection;
  today: string;
  month: Date;
  onMonthChange: (month: Date) => void;
  onPickDay: (civil: string) => void;
  startYear: number;
  endYear: number;
}) {
  const todayCell = civilToCell(today);
  const showToday = todayCell.getFullYear() === month.getFullYear() && todayCell.getMonth() === month.getMonth();
  const shared = {
    today: todayCell,
    month,
    onMonthChange,
    weekStartsOn: 1 as const,
    captionLayout: "dropdown" as const,
    startMonth: new Date(startYear, 0, 1),
    endMonth: new Date(endYear, 11, 1),
    labels: LABELS,
    formatters: FORMATTERS,
    className: String.raw`w-full bg-transparent p-0 [--cell-size:--spacing(9)] max-[721px]:[--cell-size:--spacing(11)] **:[.rdp-dropdown\_root]:flex **:[.rdp-dropdown\_root]:items-center **:[.rdp-dropdown\_root]:min-h-(--cell-size) pointer-coarse:**:[.rdp-dropdown\_root]:min-h-[44px]`,
    components: COMPONENTS,
  };
  return (
    <TodayWeekdayContext.Provider value={showToday ? WEEKDAY_SHORT[todayCell.getDay()]! : null}>
      {selection.mode === "single" ? (
        <Calendar
          {...shared}
          mode="single"
          required
          selected={selection.day ? civilToCell(selection.day) : undefined}
          onSelect={(next) => { if (next) onPickDay(cellToCivil(next)); }}
        />
      ) : (
        <Calendar
          {...shared}
          mode="range"
          selected={selection.start ? { from: civilToCell(selection.start), to: selection.end ? civilToCell(selection.end) : undefined } : undefined}
          onSelect={IGNORE_RANGE_SELECT}
          onDayClick={(day) => onPickDay(cellToCivil(day))}
          {...(selection.activeEnd && selection.start && selection.end && selection.start !== selection.end
            ? { modifiers: { inactive_end: civilToCell(selection.activeEnd === "start" ? selection.end : selection.start) }, modifiersClassNames: { inactive_end: INACTIVE_END_CLASS } }
            : {})}
        />
      )}
    </TodayWeekdayContext.Provider>
  );
}
