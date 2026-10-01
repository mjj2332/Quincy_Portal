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
 * weekday header highlights Sydney's today, as schedule-10's custom Weekday renderer does.
 *
 * `selection` is a union so #423's range can add a case; only `single` exists today.
 */
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
  const todayName = WEEKDAY_SHORT[civilToCell(today).getDay()];
  return (
    <Calendar
      mode="single"
      required
      selected={selection.day ? civilToCell(selection.day) : undefined}
      onSelect={(next) => { if (next) onPickDay(cellToCivil(next)); }}
      today={civilToCell(today)}
      month={month}
      onMonthChange={onMonthChange}
      weekStartsOn={1}
      captionLayout="dropdown"
      startMonth={new Date(startYear, 0, 1)}
      endMonth={new Date(endYear, 11, 1)}
      labels={{
        labelMonthDropdown: () => "Month",
        labelYearDropdown: () => "Year",
        labelPrevious: () => "Previous month",
        labelNext: () => "Next month",
      }}
      formatters={{
        formatMonthDropdown: (date) => MONTH_NAMES[date.getMonth()]!,
        formatWeekdayName: (date) => WEEKDAY_SHORT[date.getDay()]!,
      }}
      className="w-full bg-transparent p-0 [--cell-size:--spacing(9)] max-[721px]:[--cell-size:--spacing(11)]"
      components={{
        Weekday: ({ children, className, ...props }: React.ComponentPropsWithoutRef<"th">) => (
          <th
            {...props}
            className={cn(className, "flex flex-1 items-center justify-center", children === todayName && "bg-muted text-foreground")}
          >
            {children}
          </th>
        ),
      }}
    />
  );
}
