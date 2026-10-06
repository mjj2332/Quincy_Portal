/**
 * #222 — the event-calendar's left rail, composed after ReUI block `event-calendar-2`'s
 * `calendar-rail.tsx` (local source: the main checkout's `tmp/ReUI_Full_Source_Code/reui-blocks-main/
 * components/event-calendar-2/components/calendar-rail.tsx`; the ReUI MCP was down): a mini month
 * with busy dots, an Up next list. (Its filters slot was removed in #430: Layers and Show live in the Dashboard's Display, the rest in the shared Filter.)
 * Presentational; never imports `components/reui/event-calendar/` (not even a type).
 *
 * Adapted from the block, on purpose:
 * - No `Intl.DateTimeFormat().resolvedOptions().timeZone` and no vendor `getDayKey`: every date here
 *   is a Sydney CIVIL date string. Busy days come from the DTOs' Sydney civil dates; the mini month's
 *   local-midnight `Date`s are converted with local getters, never `toISOString`.
 * - The block's "My Calendars" CRUD list is dropped; no `sonner`, no
 *   `@/components/ui/*` (every primitive is `components/reui/*`).
 * - Up next is a read-only list from a second agenda query the surface owns (outside the accept
 *   gate); a row navigates the calendar to that day.
 *
 * Reuse: `reui/calendar` (+ `CalendarDayButton`), `reui/item` rows, `reui/scroll-area` around the
 * whole rail (the block's own composition), `quincy/Eyebrow` section labels.
 */
import { useCallback, useMemo, useState, type ComponentProps, type JSX } from "react";
import type { DayButton } from "react-day-picker";
import { formatSydneyCivilMinute, shiftSydneyCalendarDate, type CalendarEventDto } from "@quincy/shared";
import { cn } from "@/lib/utils";
import { Calendar, CalendarDayButton } from "./reui/calendar";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "./reui/item";
import { ScrollArea } from "./reui/scroll-area";
import { Eyebrow } from "./quincy/Eyebrow";

export type ProductionEventCalendarUpNext = { status: "pending" | "error" | "ready"; events: CalendarEventDto[] };

export type ProductionEventCalendarRailProps = {
  /** The calendar's civil date (`YYYY-MM-DD`). */
  date: string;
  onDateChange: (civilDate: string) => void;
  /** The visible range's events — busy dots. */
  events: readonly CalendarEventDto[];
  /** Sydney civil minute of "now" (`YYYY-MM-DDTHH:MM`), for Up next. */
  nowCivil: string;
  upNext: ProductionEventCalendarUpNext;
  onOpenUpNext: (event: CalendarEventDto) => void;
  className?: string;
};

const UP_NEXT_LIMIT = 5;
/** A long range cannot make the busy-day walk unbounded (the window is at most six weeks anyway). */
const MAX_BUSY_SPAN_DAYS = 62;

function localDate(civil: string): Date {
  const [year = 1970, month = 1, day = 1] = civil.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function civilOfLocal(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function nextDay(civil: string): string | null {
  const shifted = shiftSydneyCalendarDate(civil, 1);
  return shifted.ok ? shifted.value : null;
}

/** First civil day and EXCLUSIVE end key (`YYYY-MM-DDTHH:MM`) of an event, in Sydney. */
function civilSpan(event: CalendarEventDto): { startKey: string; endKey: string } {
  const { timing } = event;
  if (timing.allDay) {
    const endDate = timing.end ?? nextDay(timing.start) ?? timing.start;
    return { startKey: `${timing.start}T00:00`, endKey: `${endDate}T00:00` };
  }
  const startKey = formatSydneyCivilMinute(timing.start);
  return { startKey, endKey: timing.end ? formatSydneyCivilMinute(timing.end) : startKey };
}

/** Every Sydney civil day an event touches (all-day ends exclusive; a timed end at midnight too). */
export function busyCivilDates(events: readonly CalendarEventDto[]): Set<string> {
  const days = new Set<string>();
  for (const event of events) {
    const { timing } = event;
    const first = timing.allDay ? timing.start : formatSydneyCivilMinute(timing.start).slice(0, 10);
    let last = first;
    if (timing.allDay && timing.end) {
      const shifted = shiftSydneyCalendarDate(timing.end, -1);
      last = shifted.ok && shifted.value > first ? shifted.value : first;
    } else if (!timing.allDay && timing.end) {
      const endCivil = formatSydneyCivilMinute(timing.end);
      const endDay = endCivil.slice(0, 10);
      const inclusive = endCivil.endsWith("T00:00") ? shiftSydneyCalendarDate(endDay, -1) : { ok: true as const, value: endDay };
      last = inclusive.ok && inclusive.value > first ? inclusive.value : first;
    }
    let cursor: string | null = first;
    for (let step = 0; cursor && cursor <= last && step < MAX_BUSY_SPAN_DAYS; step += 1) {
      days.add(cursor);
      cursor = nextDay(cursor);
    }
  }
  return days;
}

/** The soonest events that have not ended by `nowCivil`, in start order, capped. */
export function upNextEvents(events: readonly CalendarEventDto[], nowCivil: string, limit = UP_NEXT_LIMIT): CalendarEventDto[] {
  return events
    .map((event) => ({ event, ...civilSpan(event) }))
    .filter(({ startKey, endKey }) => (endKey > startKey ? endKey > nowCivil : startKey >= nowCivil))
    .sort((a, b) => (a.startKey < b.startKey ? -1 : a.startKey > b.startKey ? 1 : a.event.id.localeCompare(b.event.id)))
    .slice(0, limit)
    .map(({ event }) => event);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "Thu 13 Aug · 10:00" / "Thu 13 Aug · All day", from the civil values — no device time zone.
 * A range that started before today (Sydney) and is still running shows where it ends instead:
 * "Until Fri 2 Oct · All day" / "Until Fri 2 Oct · 17:00" (an all-day end is exclusive, so the last day is the one before).
 */
function upNextLabel(event: CalendarEventDto, nowCivil: string): string {
  const { startKey, endKey } = civilSpan(event);
  const running = endKey > startKey && startKey.slice(0, 10) < nowCivil.slice(0, 10);
  let key = startKey;
  if (running) {
    const lastDay = event.timing.allDay ? shiftSydneyCalendarDate(endKey.slice(0, 10), -1) : { ok: true as const, value: endKey.slice(0, 10) };
    key = `${lastDay.ok ? lastDay.value : endKey.slice(0, 10)}${endKey.slice(10)}`;
  }
  const [year = 1970, month = 1, day = 1] = key.slice(0, 10).split("-").map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  const when = event.timing.allDay ? "All day" : key.slice(11, 16);
  return `${running ? "Until " : ""}${weekday} ${day} ${MONTHS[month - 1]} · ${when}`;
}

function upNextTitle(event: CalendarEventDto): string {
  return event.kind === "project_deadline" ? event.project.street : event.title;
}

function upNextDetail(event: CalendarEventDto): string {
  return event.kind === "project_deadline" ? "Deadline" : event.project.street;
}

export function ProductionEventCalendarRail({ date, onDateChange, events, nowCivil, upNext, onOpenUpNext, className }: ProductionEventCalendarRailProps): JSX.Element {
  // The painted month is its own state (browse ahead without moving the grid), pulled back during
  // render whenever the calendar date lands in another month — the block's pattern.
  const dateMonth = date.slice(0, 7);
  const [month, setMonth] = useState(() => localDate(`${dateMonth}-01`));
  const [syncedMonth, setSyncedMonth] = useState(dateMonth);
  if (dateMonth !== syncedMonth) {
    setSyncedMonth(dateMonth);
    setMonth(localDate(`${dateMonth}-01`));
  }

  const busy = useMemo(() => busyCivilDates(events), [events]);
  // Stable per `busy`: an inline component would remount every day button each render and drop
  // keyboard focus (the block's own warning).
  const DayButtonWithDot = useCallback(({ day, modifiers, children, ...props }: ComponentProps<typeof DayButton>) => {
    const civil = civilOfLocal(day.date);
    const isBusy = !modifiers.outside && busy.has(civil);
    return (
      <CalendarDayButton day={day} modifiers={modifiers} data-testid={`event-calendar-rail-day-${civil}`} data-busy={isBusy ? "true" : undefined} {...props}>
        {children}
        <span aria-hidden="true" className={cn("size-1 rounded-full", isBusy ? "bg-primary in-data-[selected-single=true]:bg-primary-foreground" : "bg-transparent")} />
      </CalendarDayButton>
    );
  }, [busy]);

  const list = useMemo(() => upNextEvents(upNext.events, nowCivil), [nowCivil, upNext.events]);

  return (
    <aside className={cn("flex min-h-0 flex-col", className)} aria-label="Calendar rail" data-testid="event-calendar-rail">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-[var(--space-5)] p-[var(--space-4)]">
          <div data-testid="event-calendar-rail-month">
            <Calendar
              mode="single"
              required
              selected={localDate(date)}
              month={month}
              onMonthChange={setMonth}
              onSelect={(next: Date | undefined) => { if (next) onDateChange(civilOfLocal(next)); }}
              weekStartsOn={1}
              buttonVariant="ghost"
              className="w-full bg-transparent p-0 [--cell-size:--spacing(8)]"
              components={{ DayButton: DayButtonWithDot }}
            />
          </div>

          <section className="grid gap-[var(--space-2)]" aria-label="Up next" data-testid="event-calendar-up-next">
            <Eyebrow>Up next</Eyebrow>
            {upNext.status === "pending" && <p className="m-0 text-muted-foreground text-[length:var(--text-xs)]" role="status">Loading…</p>}
            {upNext.status === "error" && <p className="m-0 text-muted-foreground text-[length:var(--text-xs)]">Up next is unavailable.</p>}
            {upNext.status === "ready" && list.length === 0 && <p className="m-0 text-muted-foreground text-[length:var(--text-xs)]">Nothing scheduled.</p>}
            {upNext.status === "ready" && list.length > 0 && (
              <ItemGroup className="gap-[var(--space-1)]">
                {list.map((event) => (
                  <Item
                    key={event.id}
                    size="xs"
                    render={<button type="button" />}
                    className="min-w-0 text-left hover:bg-muted max-[721px]:min-h-[44px]"
                    data-testid="event-calendar-up-next-item"
                    onClick={() => onOpenUpNext(event)}
                  >
                    <ItemContent className="min-w-0">
                      <ItemTitle className="truncate">{upNextTitle(event)}</ItemTitle>
                      <ItemDescription className="max-[721px]:line-clamp-1 text-[length:var(--text-2xs)]">{upNextLabel(event, nowCivil)} · {upNextDetail(event)}</ItemDescription>
                    </ItemContent>
                  </Item>
                ))}
              </ItemGroup>
            )}
          </section>
        </div>
      </ScrollArea>
    </aside>
  );
}
