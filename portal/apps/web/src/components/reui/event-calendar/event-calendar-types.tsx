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
 * THIS FILE: the public type surface — `CalendarEvent`, the view union, occurrences, segments, proposed updates, slot info and drafts.
 *
 *   - There is no `done` / `completed` concept anywhere in this type surface. The chips'
 *     `data-past` is derived from the clock alone. Past is NOT done — a Quincy consumer supplies
 *     completion through the event's generic `data` payload, never by reading `data-past`.
 *
 * Quincy edits since vendoring: none yet.
 */
type EventCalendarEventId = string

type CalendarView = "month" | "week" | "day" | "days" | "agenda" | "resource"

/** Bookable resource. The resource view flattens children and renders leaves
 *  only, as booking columns; a parent's own title never renders. */
interface EventCalendarResource {
  id: string
  title: string
  color?: string
  children?: EventCalendarResource[]
}

/** Half-open: start is inclusive, end is exclusive. */
interface EventCalendarDateRange {
  start: Date
  end: Date
}

type EventCalendarWeekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU"

interface EventCalendarRecurrenceRule {
  freq: "daily" | "weekly" | "monthly" | "yearly"
  interval?: number
  count?: number
  /** Inclusive instant. */
  until?: Date
  byWeekday?: Array<
    EventCalendarWeekday | { day: EventCalendarWeekday; ordinal: number }
  >
  byMonthDay?: number[]
  byMonth?: number[]
  weekStart?: EventCalendarWeekday
  exDates?: Date[]
  rDates?: Date[]
}

interface CalendarEvent<TData = unknown> {
  id: EventCalendarEventId
  title: string
  start: Date
  /** Exclusive; must be >= start. */
  end: Date
  /** Start and end must be midnights in the display time zone: segmentation
   *  walks raw instants, so another zone's midnight paints the wrong days. */
  allDay?: boolean
  /** Structured rule or a raw "RRULE:..." line. */
  recurrence?: EventCalendarRecurrenceRule | string
  /** This event is an edited single occurrence of that series. */
  recurringEventId?: EventCalendarEventId
  /** Which occurrence it replaces (RECURRENCE-ID semantics). */
  originalStart?: Date
  /** Token or css color; flows to the --ec-event-color css var. */
  color?: string
  /** Excluded from drag and resize regardless of interactions state. */
  readOnly?: boolean
  /** Per-event overrides; defaults come from interactions.drag / .resize. */
  draggable?: boolean
  resizable?: boolean
  /** Packing prominence; feeds getEventPriority ordering. */
  priority?: number
  /** Verbatim stacking override; replaces the computed 10 + column. */
  zIndex?: number
  resourceId?: string
  data?: TData
}

interface EventCalendarOccurrence<TData = unknown> {
  /** Stable per instance: `${event.id}::${startISO}`. */
  key: string
  eventId: EventCalendarEventId
  event: CalendarEvent<TData>
  start: Date
  end: Date
  allDay: boolean
  isRecurring: boolean
  recurrenceIndex?: number
}

interface EventCalendarSegment<TData = unknown> {
  occurrence: EventCalendarOccurrence<TData>
  /** Zoned midnight of the segment's day; startMin/endMin count from it. */
  day: Date
  isStart: boolean
  isEnd: boolean
  continuesBefore: boolean
  continuesAfter: boolean
  /** Timed only: minutes from the zoned day start. */
  startMin?: number
  endMin?: number
  /** Layout output: lane stacks month bars and all-day lanes;
   *  column/columnCount/columnSpan pack time-grid overlaps;
   *  rowIndex/colStart/colSpan place a bar in the week row. */
  lane?: number
  column?: number
  columnCount?: number
  columnSpan?: number
  rowIndex?: number
  colStart?: number
  colSpan?: number
}

interface EventCalendarSelection {
  eventKeys: string[]
  /** Committed slot selection; EventCalendarSlotDraft holds the in-gesture one. */
  slot: { start: Date; end: Date; allDay: boolean } | null
}

interface EventCalendarInteractions {
  drag: boolean
  resize: boolean
  selectSlot: boolean
}

interface EventCalendarDragState<TData = unknown> {
  kind: "move" | "resize-start" | "resize-end"
  occurrence: EventCalendarOccurrence<TData>
  proposedStart: Date
  proposedEnd: Date
  proposedAllDay: boolean
  /** Day-granular proposal (month cells, all-day lane), not minute columns; the
   *  all-day ghost keys on it: proposedAllDay misses timed MULTI-DAY bars. */
  proposedDayGranular: boolean
  proposedResourceId?: string
  /** Last canDropEvent verdict; drives data-drop-invalid styling. */
  valid: boolean
}

/** The in-progress drag-create rectangle only; cleared on commit or cancel. */
interface EventCalendarSlotDraft {
  start: Date
  end: Date
  allDay: boolean
  view: CalendarView
  resourceId?: string
}

/** "View settings" toggles; undefined defers to the root view-config prop. */
interface EventCalendarViewSettings {
  weekends?: boolean
  weekNumbers?: boolean
  nowIndicator?: boolean
  offDays?: boolean
}

interface EventCalendarState<TData = unknown> {
  view: CalendarView
  /** Anchor date; navigation steps this, and both ranges derive from it. */
  date: Date
  /** Read by the "days" view only; other views ignore it. */
  dayCount: number
  /** Full rendered grid incl. outside days - fetch remote data for THIS. */
  visibleRange: EventCalendarDateRange
  /** The logical period (the month/week itself). */
  activeRange: EventCalendarDateRange
  events: CalendarEvent<TData>[]
  selection: EventCalendarSelection
  interactions: EventCalendarInteractions
  loading: boolean
  drag: EventCalendarDragState<TData> | null
  slotDraft: EventCalendarSlotDraft | null
  viewSettings: EventCalendarViewSettings
}

interface EventCalendarRangeInfo {
  range: EventCalendarDateRange
  activeRange: EventCalendarDateRange
  view: CalendarView
  date: Date
  timeZone: string
}

interface EventCalendarProposedUpdate<TData = unknown> {
  event: CalendarEvent<TData>
  /** null when source === "api". */
  occurrence: EventCalendarOccurrence<TData> | null
  start: Date
  end: Date
  allDay: boolean
  resourceId?: string
  source: "drag" | "resize-start" | "resize-end" | "keyboard" | "api"
}

/** false = reject/revert; void or true = accept; object = accept with adjustment. */
type EventCalendarUpdateResult =
  | boolean
  | void
  | { start?: Date; end?: Date; allDay?: boolean }

/** A click is a point, not a range; `end` is present for timed slots. */
interface EventCalendarSlotInfo {
  date: Date
  end?: Date
  allDay: boolean
  view: CalendarView
  resourceId?: string
}

/** Off-days; `true` = weekend defaults. Marked cells carry `data-off`. */
interface EventCalendarOffDaysConfig {
  /** Weekday numbers treated as off (0 = Sunday). Default [0, 6]. */
  weekendDays?: number[]
  /** Additional explicit off dates (compared by day in the display zone). */
  dates?: Date[]
  /** Full custom predicate; runs in addition to weekendDays/dates. */
  isOffDay?: (day: Date) => boolean
  /** Marker classes; default "bg-muted/25". */
  className?: string
}

interface EventCalendarDataAdapter<TData = unknown> {
  getEvents(
    range: EventCalendarDateRange,
    signal?: AbortSignal
  ): Promise<CalendarEvent<TData>[]>
}

export type {
  CalendarEvent,
  CalendarView,
  EventCalendarDataAdapter,
  EventCalendarDateRange,
  EventCalendarDragState,
  EventCalendarEventId,
  EventCalendarInteractions,
  EventCalendarOccurrence,
  EventCalendarOffDaysConfig,
  EventCalendarProposedUpdate,
  EventCalendarRangeInfo,
  EventCalendarRecurrenceRule,
  EventCalendarResource,
  EventCalendarSegment,
  EventCalendarSelection,
  EventCalendarSlotDraft,
  EventCalendarSlotInfo,
  EventCalendarState,
  EventCalendarViewSettings,
  EventCalendarUpdateResult,
  EventCalendarWeekday,
}