import { createContext, useContext } from "react";
import { Calendar } from "@/components/reui/calendar";
import { MONTH_NAMES } from "@/lib/date-format";
import { cellToCivil, civilToCell } from "@/lib/date-time-field";
import { cn } from "@/lib/utils";

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * The popup's month/year dropdowns and day grid: `reui/calendar` (react-day-picker 10) in the
 * grid shape of schedule-10, on civil strings (a `Date` is only the cell key). Month and year are
 * the calendar's own native selects (`captionLayout="dropdown"`) rather than `reui/select`, whose
 * Base UI listbox inside a Base UI popover is unproven for option-dismiss and Escape. The
 * weekday header highlights Sydney's today, as schedule-10's custom Weekday renderer does, but
 * only while the month that contains today is on screen.
 *
 * `selection` is a union so #423's range can add a case; only `single` exists today.
 */

/** The weekday name to highlight in the header, or null (set only while Sydney's today is on screen). */
const TodayWeekdayContext = createContext<string | null>(null);

/**
 * Module-level on purpose: an inline component is a new type every render and react-day-picker
 * would remount the caption (dropping focus from the month/year select) on each month change.
 */
const COMPONENTS = {
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

const LABELS = {
  labelMonthDropdown: () => "Month",
  labelYearDropdown: () => "Year",
  labelPrevious: () => "Previous month",
  labelNext: () => "Next month",
};

const FORMATTERS = {
  formatMonthDropdown: (date: Date) => MONTH_NAMES[date.getMonth()]!,
  formatWeekdayName: (date: Date) => WEEKDAY_SHORT[date.getDay()]!,
};

export type CalendarSelection = { mode: "single"; day: string | null };

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
  return (
    <TodayWeekdayContext.Provider value={showToday ? WEEKDAY_SHORT[todayCell.getDay()]! : null}>
      <Calendar
        mode="single"
        required
        selected={selection.day ? civilToCell(selection.day) : undefined}
        onSelect={(next) => { if (next) onPickDay(cellToCivil(next)); }}
        today={todayCell}
        month={month}
        onMonthChange={onMonthChange}
        weekStartsOn={1}
        captionLayout="dropdown"
        startMonth={new Date(startYear, 0, 1)}
        endMonth={new Date(endYear, 11, 1)}
        labels={LABELS}
        formatters={FORMATTERS}
        className="w-full bg-transparent p-0 [--cell-size:--spacing(9)] max-[721px]:[--cell-size:--spacing(11)]"
        components={COMPONENTS}
      />
    </TodayWeekdayContext.Provider>
  );
}
