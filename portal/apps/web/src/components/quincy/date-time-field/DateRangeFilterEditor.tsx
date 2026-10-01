import { useMemo, useState } from "react";
import type { DateRange } from "react-day-picker";
import { Calendar } from "@/components/reui/calendar";
import type { FilterEditorProps } from "@/components/reui/filters/filters-types";
import { Button } from "@/components/reui/button";
import { COMPONENTS, FORMATTERS, LABELS, TodayWeekdayContext, WEEKDAY_SHORT } from "./CalendarPane";
import { cellToCivil, civilToCell, sydneyToday, yearBounds } from "@/lib/date-time-field";

/**
 * #429: the Dashboard Filter's date-range value editor (Shoot date, Deadline "is between"), a
 * `FilterEditorProps` component for the vendored ReUI `Filters` (`reui/filters` ships no date type: "a
 * date ships as an `editor`"). Composes `reui/calendar` in `mode="range"` on Sydney civil strings (a
 * `Date` is only the cell key, as in `CalendarPane`), with `CalendarPane`'s exported month/weekday tables, labels and
 * today-weekday header, and Cancel / Apply buttons. The value is `[from, to]` inclusive `YYYY-MM-DD` days; Apply is enabled once a
 * start day is picked (a single day is a one-day range). It does not depend on the date popup's range
 * mode (#423): TODO move this onto `CalendarPane`'s range case once #423 lands.
 */
export function DateRangeFilterEditor({ value, onValueChange, commit, cancel }: FilterEditorProps<string | string[], unknown>) {
  const today = useMemo(() => sydneyToday(), []);
  const initial = Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "string" ? { from: value[0], to: value[1] } : null;
  const [range, setRange] = useState<{ from: string; to: string | null } | null>(initial);
  const [month, setMonth] = useState<Date>(() => civilToCell(initial?.from ?? today));
  const { startYear, endYear } = yearBounds(today, initial?.from ?? null);
  const selected: DateRange | undefined = range ? { from: civilToCell(range.from), ...(range.to ? { to: civilToCell(range.to) } : {}) } : undefined;

  function apply() {
    if (!range) return;
    const next = [range.from, range.to ?? range.from] as string[];
    onValueChange(next);
    commit(next);
  }

  const todayCell = civilToCell(today);
  const showToday = todayCell.getFullYear() === month.getFullYear() && todayCell.getMonth() === month.getMonth();
  return (
    <div className="flex flex-col gap-[var(--space-3)] p-[var(--space-3)]" data-testid="date-range-editor">
      <TodayWeekdayContext.Provider value={showToday ? WEEKDAY_SHORT[todayCell.getDay()]! : null}>
      <Calendar
        mode="range"
        selected={selected}
        onSelect={(next) => {
          if (!next?.from) { setRange(null); return; }
          setRange({ from: cellToCivil(next.from), to: next.to ? cellToCivil(next.to) : null });
        }}
        today={civilToCell(today)}
        month={month}
        onMonthChange={setMonth}
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
      <div className="flex items-center justify-end gap-[var(--space-2)]">
        <Button type="button" variant="outline" onClick={cancel}>Cancel</Button>
        <Button type="button" disabled={!range} onClick={apply}>Apply</Button>
      </div>
    </div>
  );
}
