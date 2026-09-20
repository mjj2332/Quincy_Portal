/**
 * ReUI's `@reui/event-calendar` — a headless-first event calendar (month, week, day, N-day, agenda
 * and resource views, pointer drag/resize/drag-create, an RFC 5545 recurrence subset, display time
 * zones, and an external CRUD contract) shipped as 13 files. Fetched via
 * `npx shadcn@latest add @reui/event-calendar` into a sandbox (`tmp/ReUI-Test-1`, `--path
 * src/components/vendor-219b`) for #219 (PR B: vendor the calendar, re-skin it, no consumer yet).
 *
 * VERBATIM. The only edits are mechanical, identical in kind across all 13 files, and machine-
 * checked at the vendoring commit — every differing line was one of these three:
 *
 * 1. Dropped the registry's `"use client"` directive (meaningless in this Vite SPA) — present in
 *    5 of the 13: this file's siblings `event-calendar.tsx`, `-agenda-view`, `-dnd`, `-month-view`
 *    and `-resource-view`.
 * 2. `cn` imported from `@/lib/utils` instead of the registry's raw `"cn"` package (8 files; see
 *    `reui/checkbox.tsx`'s header for why that package must never be installed).
 * 3. Shared primitives repointed from `@/components/ui/<name>` to `@/components/reui/<name>`
 *    (11 sites). Those seven — `button`, `calendar`, `dropdown-menu`, `popover`, `scroll-area`,
 *    `tooltip`, `icon-stack` — were ALREADY vendored and adapted before PR B, so this item added
 *    no new primitive and no new dependency. The sandbox's own copies of them were deliberately
 *    NOT copied across: Quincy's carry documented corrections the registry's do not.
 *
 * The tree's own file-to-file imports needed no rewrite — the registry emits them as
 * `@/components/reui/event-calendar/<name>` already, which is exactly where this lands. Like
 * `gantt/`, this multi-file item sits in its own subdirectory rather than flat among the other
 * vendored files, which is what lets `event-calendar-skin.guard.test.ts` scope itself to this
 * directory (`docs/reui-reuse.md`).
 *
 * No production code imports this tree. `src/harness/harness-reachability.guard.test.ts` and
 * `src/build/forbid-dev-only-modules.ts` make that a build failure rather than a bug report; the
 * dev-only harness at `src/harness/reui-scheduling/` is the only thing that renders it, on local
 * fixture data. FullCalendar remains the production calendar and PR B does not touch it.
 *
 * QUINCY EDIT LOG — every dated entry below is a real Quincy change made after the verbatim
 * vendoring commit. ADR 0009 (written for the Gantt, and the precedent this tree follows) calls
 * these headers the merge instructions: a future re-vendor re-runs the same sandbox install, then
 * replays each entry against the new file. Losing the log is the real cost, not the line count.
 *
 * THIS FILE: the label and format table — every user-visible string and date format the tree emits, overridable per key.
 *
 * Quincy edits since vendoring:
 *
 * 1. 2026-09-21, #240 — ADDED the `labels.adjust` table (type and English defaults): everything
 *    the keyboard Adjust session announces, including `showing` (the view followed the proposal)
 *    and `secondPass` / `endsSecondPass` (which pass of a DST repeated hour an end sits in).
 *    Additive; no existing key changed.
 */
import type {
  CalendarView,
  EventCalendarDateRange,
} from "@/components/reui/event-calendar/event-calendar-types"
import {
  format,
  isSameMonth,
  isSameYear,
  subMilliseconds,
  type Locale,
} from "date-fns"

interface EventCalendarI18nConfig {
  labels: {
    today: string
    previous: string
    next: string
    addEvent: string
    allDay: string
    more: (count: number) => string
    noEvents: string
    loading: string
    event: string
    events: (count: number) => string
    selectView: string
    week: (weekNumber: number) => string
    resources: string
    goToDate: string
    /** Cursor hint while a drag/resize hovers a rejected position. */
    dropNotAllowed: string
    /** Aria-label suffix on chip segments that continue past the cell. */
    continues: string
    /**
     * QUINCY (#240): the keyboard Adjust session's live-region copy. `position` is the proposal
     * already formatted ("Mon, Sep 21, 9:15 - 10:15 AM", plus resource / repeated-hour suffixes).
     */
    adjust: {
      started: (title: string, target: string, position: string) => string
      targets: { move: string; start: string; end: string }
      committed: (title: string, position: string) => string
      unchanged: string
      cancelled: string
      /** That key means nothing for this target in this view. */
      refusedAxis: string
      /** The step would leave the day's bounds or the resource list. */
      refusedBounds: string
      refusedMinDuration: string
      /** M / S / E asked for a target this event does not allow. */
      refusedTarget: (target: string) => string
      /** Enter on a proposal `canDropEvent` rejects. */
      refusedInvalid: (position: string) => string
      /** `onEventUpdate` returned false. */
      rejected: string
      /** The event changed or disappeared underneath the session. */
      interrupted: string
      /** Appended to the step that made the view follow the proposal to another range. */
      showing: (range: string) => string
      /** Appended when the proposal starts in a DST repeated hour's second pass. */
      secondPass: string
      /** Appended when only the proposal's END is in the second pass, so the clock reads end-before-start. */
      endsSecondPass: string
    }
    /** Agenda label for the first day of a multi-day event. */
    timeFrom: (time: string) => string
    /** Agenda label for the last day of a multi-day event. */
    timeUntil: (time: string) => string
    /** View-switcher shortcut hint characters, per view. */
    viewShortcuts: Record<CalendarView, string>
    /** Aria-label of the agenda day collapse/expand toggle. */
    toggleDayEvents: (count: number, expanded: boolean) => string
    /** Aria-label of the agenda event details toggle. */
    eventDetails: (title: string) => string
    /** Compact "+N" overflow (agenda summary dot stack). */
    moreCompact: (count: number) => string
    /** Joins a bounded from-to time span. */
    timeRange: (from: string, to: string) => string
  }
  viewNames: {
    month: string
    week: string
    day: string
    days: (count: number) => string
    agenda: string
    resource: string
  }
  /** date-fns format strings, applied with the calendar `locale`. */
  formats: {
    monthTitle: string
    /** Undefined = smart cross-month range via functions.formatTitle. */
    weekTitle?: string
    dayTitle: string
    /** Undefined = smart range label via functions.formatTitle. */
    agendaTitle?: string
    monthDayHeader: string
    /** Narrow variant used by the month view below the compact breakpoint. */
    monthDayHeaderNarrow: string
    timeGridDayHeader: string
    agendaDayHeader: string
    /** Agenda date-gutter day number. */
    agendaDayNumber: string
    /** Agenda date-gutter weekday label. */
    agendaWeekday: string
    /** "+N more" popover day header. */
    moreDayHeader: string
    /** Month cell aria-label date. */
    monthCellAriaLabel: string
    /** Time-grid day column aria-label date. */
    dayAria: string
    /** Undefined = the resource view title falls back to dayTitle. */
    resourceTitle?: string
    timeGutter: string
    /** Sub-hour gutter labels (interval below 60 minutes). */
    timeGutterMinute: string
    eventTime: string
    monthCellDay: string
  }
  functions: {
    formatTitle: (
      view: CalendarView,
      ctx: {
        date: Date
        activeRange: EventCalendarDateRange
        visibleRange: EventCalendarDateRange
        locale?: Locale
      }
    ) => string
    formatEventTime: (
      start: Date,
      end: Date,
      allDay: boolean,
      /** date-fns options (the calendar `locale`); trailing so a 3-arg override still fits. */
      opts?: { locale?: Locale }
    ) => string
    formatDayRange: (
      range: EventCalendarDateRange,
      opts?: { locale?: Locale }
    ) => string
    /** Chip native tooltip text; return undefined to drop the attribute. */
    formatEventLabel?: (title: string, timeLabel: string) => string | undefined
    /** Chip aria-label composition. */
    formatEventAriaLabel?: (
      title: string,
      timeLabel: string,
      continues: boolean
    ) => string
  }
}

const DEFAULT_LABELS: EventCalendarI18nConfig["labels"] = {
  today: "Today",
  previous: "Previous",
  next: "Next",
  addEvent: "Add event",
  allDay: "All day",
  more: (count) => `+${count} more`,
  noEvents: "No events",
  loading: "Loading events",
  event: "event",
  events: (count) => (count === 1 ? "1 event" : `${count} events`),
  selectView: "Select view",
  week: (weekNumber) => `W${weekNumber}`,
  resources: "Resources",
  goToDate: "Go to date",
  dropNotAllowed: "Can't place here",
  continues: "continues",
  adjust: {
    started: (title, target, position) =>
      `${title}. Adjusting ${target}. ${position}. Arrow keys to change, M S E to switch between move, start and end, Enter to confirm, Escape to cancel.`,
    targets: { move: "position", start: "start", end: "end" },
    committed: (title, position) => `${title} set to ${position}.`,
    unchanged: "No change made.",
    cancelled: "Adjustment cancelled.",
    refusedAxis: "That direction does nothing here.",
    refusedBounds: "Can't go further.",
    refusedMinDuration: "Can't make it shorter.",
    refusedTarget: (target) => `The ${target} of this event can't be changed.`,
    refusedInvalid: (position) => `Can't place at ${position}.`,
    rejected: "Change not accepted.",
    interrupted: "Adjustment ended: the event changed.",
    showing: (range) => `Now showing ${range}.`,
    secondPass: "second pass of the repeated hour",
    endsSecondPass: "ends in the second pass of the repeated hour",
  },
  timeFrom: (time) => `From ${time}`,
  timeUntil: (time) => `Until ${time}`,
  viewShortcuts: {
    month: "M",
    week: "W",
    day: "D",
    days: "5",
    agenda: "A",
    resource: "G",
  },
  toggleDayEvents: (count) => (count === 1 ? "1 event" : `${count} events`),
  eventDetails: (title) => title,
  moreCompact: (count) => `+${count}`,
  timeRange: (from, to) => `${from} - ${to}`,
}

const DEFAULT_VIEW_NAMES: EventCalendarI18nConfig["viewNames"] = {
  month: "Month",
  week: "Week",
  day: "Day",
  days: (count) => (count === 1 ? "1 day" : `${count} days`),
  agenda: "Agenda",
  resource: "Time Grid",
}

const DEFAULT_FORMATS: EventCalendarI18nConfig["formats"] = {
  monthTitle: "MMMM yyyy",
  weekTitle: undefined,
  dayTitle: "EEEE, MMMM d, yyyy",
  agendaTitle: undefined,
  monthDayHeader: "EEE",
  monthDayHeaderNarrow: "EEEEE",
  timeGridDayHeader: "EEE d",
  agendaDayHeader: "EEEE, MMMM d",
  agendaDayNumber: "d",
  agendaWeekday: "EEE",
  moreDayHeader: "EEEE, MMMM d",
  monthCellAriaLabel: "PPPP",
  dayAria: "PPPP",
  resourceTitle: undefined,
  timeGutter: "h a",
  timeGutterMinute: "h:mm a",
  eventTime: "h:mm a",
  monthCellDay: "d",
}

/**
 * Default formatting functions BOUND to a config's labels/formats, so that
 * `formats` overrides flow into the default renderers (a consumer overriding
 * formats.monthTitle without replacing formatTitle still sees it applied).
 */
function makeDefaultFunctions(
  cfg: Pick<EventCalendarI18nConfig, "labels" | "formats">
): EventCalendarI18nConfig["functions"] {
  return {
    formatTitle: (view, { date, activeRange, locale }) => {
      const opts = { locale }
      if (view === "month") {
        return format(date, cfg.formats.monthTitle, opts)
      }
      if (view === "resource") {
        return format(
          date,
          cfg.formats.resourceTitle ?? cfg.formats.dayTitle,
          opts
        )
      }
      if (view === "day") {
        return format(date, cfg.formats.dayTitle, opts)
      }
      if (view === "week" && cfg.formats.weekTitle) {
        return format(date, cfg.formats.weekTitle, opts)
      }
      if (view === "agenda" && cfg.formats.agendaTitle) {
        return format(date, cfg.formats.agendaTitle, opts)
      }
      // week / days / agenda: smart range label, last day is activeRange.end - 1ms.
      // subMilliseconds keeps the zoned date type (a plain new Date(ms)
      // would flip the label to the machine zone near midnight)
      const rangeEnd = subMilliseconds(activeRange.end, 1)
      const start = activeRange.start
      if (isSameMonth(start, rangeEnd)) {
        return `${format(start, "MMMM d", opts)} - ${format(rangeEnd, "d, yyyy", opts)}`
      }
      if (isSameYear(start, rangeEnd)) {
        return `${format(start, "MMM d", opts)} - ${format(rangeEnd, "MMM d, yyyy", opts)}`
      }
      return `${format(start, "MMM d, yyyy", opts)} - ${format(rangeEnd, "MMM d, yyyy", opts)}`
    },
    formatEventTime: (start, end, allDay, opts) => {
      if (allDay) return cfg.labels.allDay
      const fmt = cfg.formats.eventTime
      // Multi-day timed events carry the date on both sides. Compare calendar
      // days off the last rendered instant (end is exclusive, so a 14:00 to
      // midnight event still ends on the start day). Elapsed ms would miss an
      // exactly-24h event and a DST day that only runs 23 hours.
      const lastInstant =
        end.getTime() - 1 >= start.getTime() ? subMilliseconds(end, 1) : start
      if (format(start, "yyyy-MM-dd") !== format(lastInstant, "yyyy-MM-dd")) {
        return `${format(start, `MMM d, ${fmt}`, opts)} - ${format(end, `MMM d, ${fmt}`, opts)}`
      }
      return `${format(start, fmt, opts)} - ${format(end, fmt, opts)}`
    },
    formatDayRange: (range, opts) => {
      // subMilliseconds keeps the zoned date type, same reason as formatTitle
      const rangeEnd = subMilliseconds(range.end, 1)
      return `${format(range.start, "MMM d", opts)} - ${format(rangeEnd, "MMM d", opts)}`
    },
  }
}

const DEFAULT_EVENT_CALENDAR_I18N: EventCalendarI18nConfig = {
  labels: DEFAULT_LABELS,
  viewNames: DEFAULT_VIEW_NAMES,
  formats: DEFAULT_FORMATS,
  functions: makeDefaultFunctions({
    labels: DEFAULT_LABELS,
    formats: DEFAULT_FORMATS,
  }),
}

/**
 * One level deeper than `Partial`, because the merge below is per nested
 * section: overriding a single label must not force a consumer to restate the
 * other 22. Unknown keys are still rejected by the excess property check.
 */
type EventCalendarI18nOverrides = {
  [K in keyof EventCalendarI18nConfig]?: Partial<EventCalendarI18nConfig[K]>
}

/**
 * Shallow merge per nested object, matching the filters.tsx i18n contract:
 * a partial override replaces individual keys, never whole sections. Default
 * functions are re-bound to the MERGED labels/formats; explicit `functions`
 * overrides still win.
 */
function mergeEventCalendarI18n(
  overrides?: EventCalendarI18nOverrides
): EventCalendarI18nConfig {
  if (!overrides) return DEFAULT_EVENT_CALENDAR_I18N
  const labels = { ...DEFAULT_LABELS, ...overrides.labels }
  const viewNames = { ...DEFAULT_VIEW_NAMES, ...overrides.viewNames }
  const formats = { ...DEFAULT_FORMATS, ...overrides.formats }
  return {
    labels,
    viewNames,
    formats,
    functions: {
      ...makeDefaultFunctions({ labels, formats }),
      ...overrides.functions,
    },
  }
}

export { DEFAULT_EVENT_CALENDAR_I18N, mergeEventCalendarI18n }
export type { EventCalendarI18nConfig, EventCalendarI18nOverrides }