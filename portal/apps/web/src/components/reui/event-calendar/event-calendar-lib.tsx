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
 * THIS FILE: the pure date, segment and packing math — occurrence expansion, per-day segment splitting, lane packing, and the zoned-day helpers the views and the gesture engine share.
 *
 *   - `getDayTotalMinutes` deliberately returns 1380 / 1500 on DST transition days rather than
 *     assuming 1440. The views do not all honour that; this file is right and its callers were
 *     the ones needing fixes.
 *
 * Quincy edits since vendoring:
 *
 * 1. 2026-09-20, #219 PR B, stage 1 — type-only narrowing for this repo's
 *    `noUncheckedIndexedAccess: true`, which the registry does not compile under. 1 site:
 *    the lane-packing `lanes[lane]` writes hoisted into a local. No runtime behaviour
 *    changed.
 *
 * 2. 2026-09-21, #219 PR B, stage 3 — ADDED `elapsedMinutesAtWallClockHour` (exported). Converts
 *    a wall-clock hour setting into elapsed minutes from a given day's zoned midnight. Pure
 *    addition: nothing existing changed. It exists because the two grid views were computing
 *    `Math.min(endHour * 60, getDayTotalMinutes(...))`, which compares a wall-clock bound against
 *    an elapsed length — see this file's own note above that `getDayTotalMinutes` "is right and
 *    its callers were the ones needing fixes". Its callers are now fixed.
 *
 * 3. 2026-09-21, #241 — ADDED `wallClockMinutesAtElapsed`, `elapsedMinutesAtWallClock` and
 *    `wallClockWindow` (all exported): the crossing points between ELAPSED minutes and the time
 *    grid's wall-clock paint axis. `elapsedMinutesAtWallClockHour` (entry 2) now DELEGATES to
 *    `elapsedMinutesAtWallClock` so a bound and a pointer resolve a clock position identically —
 *    it used `setHours`, which put an hour ON the repeat at its second pass. One change to
 *    vendor code: `packTimedSegments` takes an optional `windowOf` accessor so a transition day
 *    can be packed by painted window; omitted, it behaves exactly as vendored. `setHours` is no
 *    longer imported. Cover: `event-calendar-dst.test.ts`, incl. a zone whose gap is AT midnight.
 */
import { expandRecurrence } from "@/components/reui/event-calendar/event-calendar-recurrence"
import type {
  CalendarEvent,
  CalendarView,
  EventCalendarDateRange,
  EventCalendarOccurrence,
  EventCalendarOffDaysConfig,
  EventCalendarResource,
  EventCalendarSegment,
} from "@/components/reui/event-calendar/event-calendar-types"
import { TZDate } from "@date-fns/tz"
import {
  addDays,
  addMinutes,
  addMonths,
  addWeeks,
  differenceInCalendarDays,
  differenceInMinutes,
  format,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns"

type WeekStartsOn = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** Packing-effective minimum in minutes so tiny events do not stack invisibly. */
const MIN_PACK_SLOT = 30

/** The instant re-expressed in the display time zone (TZDate extends Date). */
function toZoned(date: Date, timeZone: string): TZDate {
  return new TZDate(date.getTime(), timeZone)
}

/** Zoned midnight of the day containing the instant. */
function zonedStartOfDay(date: Date, timeZone: string): TZDate {
  return startOfDay(toZoned(date, timeZone))
}

/** Stable per-day key in the display time zone. */
function getDayKey(date: Date, timeZone: string): string {
  return format(toZoned(date, timeZone), "yyyy-MM-dd")
}

/** Day length in minutes; 1380/1500 on DST transition days - never assume 1440. */
function getDayTotalMinutes(dayStart: Date, timeZone: string): number {
  const next = zonedStartOfDay(
    addDays(toZoned(dayStart, timeZone), 1),
    timeZone
  )
  return differenceInMinutes(next, dayStart)
}

/**
 * Elapsed minutes from a day's zoned midnight to that day's WALL-CLOCK `hour`.
 *
 * QUINCY ADDITION (#219 PR B stage 3). On an ordinary day this is just `hour * 60`, which is what
 * the views used to compute inline. On a DST transition day it is not, and the difference is the
 * entire bug it was added to fix:
 *
 *   - `hour` is a wall-clock LABEL — "the 17:00 gridline", "the end of the day".
 *   - Every minute quantity the views position blocks with is ELAPSED time since zoned midnight:
 *     `segmentOccurrence` computes `differenceInMinutes(segStart, cursor)`, not a clock reading.
 *
 * Mixing the two silently drops content. `Math.min(endHour * 60, getDayTotalMinutes(...))` — the
 * expression this replaces — reads as a safety clamp but compares a wall-clock bound against an
 * elapsed length, so on Sydney's 25-hour autumn day it evaluated to 1440 while the day genuinely
 * runs to 1500, and a 23:15 event (elapsed start 1455) failed `startMin < boundsEndMin` and never
 * rendered at all. The same clamp also capped the drop target and blanked the now-indicator for
 * that hour. Reproduced in a browser before the fix: 5 chips on a 24-hour day, 5 on the 23-hour
 * day, 4 on the 25-hour day, from one identical fixture.
 *
 * `hour >= 24` means the end of the day, which is the NEXT zoned midnight — 1380 or 1500 minutes
 * on a transition day, never 1440. Below 24 the hour is resolved as a real wall-clock time in the
 * zone, so a non-default `dayStartHour` / `dayEndHour` is converted correctly too rather than only
 * the 0/24 default being right.
 */
function elapsedMinutesAtWallClockHour(
  dayStart: Date,
  hour: number,
  timeZone: string
): number {
  // QUINCY (#241): one resolution for a wall-clock position, shared with the pointer path. Was
  // `setHours(midnight, hour)`, which on a 25-hour day resolved an hour ON the repeat to its
  // SECOND pass — so `dayStartHour: 2` hid the whole first pass under a slot the gutter showed.
  return elapsedMinutesAtWallClock(dayStart, Math.min(hour, 24) * 60, timeZone)
}

/**
 * QUINCY ADDITION (#241). The time grid paints every day column on ONE wall-clock axis — the same
 * 24 labels the shared hour gutter carries — so a week containing a DST transition day lines up
 * (the Google/Apple Calendar model: the skipped hour is an empty slot, the repeated hour's two
 * passes share one slot). ELAPSED minutes remain the unit for segments, bounds, gestures and
 * proposals; the three functions below (and `elapsedMinutesAtWallClockHour` above, which
 * delegates to the second) are the only crossing points, used at paint time and at pointer time. On an ordinary day all three are the identity.
 *
 * Wall-clock minutes (0..1440) on the gutter's axis for an elapsed minute of `dayStart`'s day.
 */
function wallClockMinutesAtElapsed(
  dayStart: Date,
  elapsedMin: number,
  timeZone: string
): number {
  const midnight = zonedStartOfDay(dayStart, timeZone)
  const total = getDayTotalMinutes(midnight, timeZone)
  if (total === 1440) return elapsedMin
  // The next midnight reads 00:00 on the clock; on this axis it is the bottom edge.
  if (elapsedMin >= total) return 1440 + (elapsedMin - total)
  // Strictly below: elapsed 0 is NOT wall-clock 0 where the gap swallows midnight (Santiago).
  if (elapsedMin < 0) return elapsedMin
  const at = toZoned(addMinutes(midnight, elapsedMin), timeZone)
  return at.getHours() * 60 + at.getMinutes() + (elapsedMin % 1)
}

/** Elapsed minute at which the day's clock first disagrees with elapsed time (the transition). */
function transitionElapsedMinute(
  midnight: Date,
  total: number,
  timeZone: string
): number {
  let lo = 0
  let hi = total
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (wallClockMinutesAtElapsed(midnight, mid, timeZone) !== mid) hi = mid
    else lo = mid + 1
  }
  return lo
}

/**
 * Inverse of `wallClockMinutesAtElapsed` (QUINCY, #241): the elapsed minute a position on the
 * wall-clock axis means. Two positions have no single answer and are decided here, once: a time
 * inside the REPEATED hour means its first pass, and a time inside the SKIPPED hour means the
 * instant the gap closes (02:30 on Sydney's spring day is 03:00).
 */
function elapsedMinutesAtWallClock(
  dayStart: Date,
  wallMin: number,
  timeZone: string
): number {
  const midnight = zonedStartOfDay(dayStart, timeZone)
  const total = getDayTotalMinutes(midnight, timeZone)
  if (total === 1440) return wallMin
  const transition = transitionElapsedMinute(midnight, total, timeZone)
  if (wallMin < transition) return wallMin
  // Past the transition the clock runs `total - 1440` behind elapsed time (ahead, in spring).
  return Math.max(transition, wallMin + (total - 1440))
}

/**
 * The painted [start, end] on the wall-clock axis for an elapsed window (QUINCY, #241). A window
 * the repeated hour folds back on itself (first 02:15 -> second 02:15) would be zero or negative
 * tall; it keeps its elapsed length from its painted start instead of vanishing.
 */
function wallClockWindow(
  dayStart: Date,
  startMin: number,
  endMin: number,
  timeZone: string
): [number, number] {
  const start = wallClockMinutesAtElapsed(dayStart, startMin, timeZone)
  const end = wallClockMinutesAtElapsed(dayStart, endMin, timeZone)
  if (endMin > startMin && end <= start) return [start, start + (endMin - startMin)]
  return [start, end]
}

function snapMinutes(minutes: number, snap: number): number {
  return Math.round(minutes / snap) * snap
}

interface ViewRangeOptions {
  timeZone: string
  weekStartsOn: WeekStartsOn
  dayCount: number
  agendaDayCount: number
  fixedWeeks: boolean
}

interface ViewDateRanges {
  visibleRange: EventCalendarDateRange
  activeRange: EventCalendarDateRange
}

function getViewDateRange(
  view: CalendarView,
  date: Date,
  opts: ViewRangeOptions
): ViewDateRanges {
  const { timeZone, weekStartsOn, dayCount, agendaDayCount, fixedWeeks } = opts
  const zoned = toZoned(date, timeZone)

  if (view === "month") {
    const activeStart = startOfMonth(zoned)
    const activeEnd = startOfMonth(addMonths(zoned, 1))
    const visibleStart = startOfWeek(activeStart, { weekStartsOn })
    let visibleEnd: Date
    if (fixedWeeks) {
      visibleEnd = addDays(visibleStart, 42)
    } else {
      visibleEnd = startOfWeek(addDays(activeEnd, -1), { weekStartsOn })
      visibleEnd = addWeeks(visibleEnd, 1)
    }
    return {
      activeRange: { start: activeStart, end: activeEnd },
      visibleRange: { start: visibleStart, end: visibleEnd },
    }
  }

  if (view === "week") {
    const start = startOfWeek(zoned, { weekStartsOn })
    const range = { start, end: addWeeks(start, 1) }
    return { activeRange: range, visibleRange: range }
  }

  if (view === "day" || view === "resource") {
    const start = startOfDay(zoned)
    const range = { start, end: addDays(start, 1) }
    return { activeRange: range, visibleRange: range }
  }

  if (view === "days") {
    const start = startOfDay(zoned)
    const range = { start, end: addDays(start, Math.max(1, dayCount)) }
    return { activeRange: range, visibleRange: range }
  }

  // agenda
  const start = startOfDay(zoned)
  const range = { start, end: addDays(start, Math.max(1, agendaDayCount)) }
  return { activeRange: range, visibleRange: range }
}

/** Day of month of the last day of the month containing the zoned date. */
function lastDayOfZonedMonth(date: Date): number {
  return addDays(startOfMonth(addMonths(date, 1)), -1).getDate()
}

/** The anchor date stepped one period forward or backward for the view. */
function stepDate(
  view: CalendarView,
  date: Date,
  direction: 1 | -1,
  opts: Pick<ViewRangeOptions, "timeZone" | "dayCount" | "agendaDayCount">
): Date {
  const zoned = toZoned(date, opts.timeZone)
  if (view === "month") {
    const stepped = addMonths(zoned, direction)
    // addMonths clamps the day down into a shorter month and never restores
    // it, so next-then-prev from the 31st would leave the anchor on the 28th.
    // Sticking a month end to the target month's end keeps stepping
    // invertible, which matters because the anchor is what day and week view
    // open on after a month navigation.
    if (zoned.getDate() !== lastDayOfZonedMonth(zoned)) return stepped
    return addDays(stepped, lastDayOfZonedMonth(stepped) - stepped.getDate())
  }
  if (view === "week") return addWeeks(zoned, direction)
  if (view === "day" || view === "resource") return addDays(zoned, direction)
  if (view === "days")
    return addDays(zoned, direction * Math.max(1, opts.dayCount))
  return addDays(zoned, direction * Math.max(1, opts.agendaDayCount))
}

function rangesIntersect(
  a: EventCalendarDateRange,
  b: EventCalendarDateRange
): boolean {
  return a.start < b.end && a.end > b.start
}

function eventsOverlap(
  a: { start: Date; end: Date },
  b: { start: Date; end: Date }
): boolean {
  return a.start < b.end && a.end > b.start
}

/**
 * The one canonical multi-day segmentation. Splits an occurrence into per-day
 * segments clamped to the range. Rules (unit-tested in M1): exclusive end - an
 * event ending exactly at zoned midnight emits NO segment for that day;
 * zero-duration events emit one min-height segment; allDay occurrences walk
 * the same absolute instants as timed ones and only drop startMin/endMin, so
 * their bounds have to already BE display-zone midnights (see
 * CalendarEvent.allDay) or the bar paints on the wrong days.
 */
function segmentOccurrence<TData>(
  occurrence: EventCalendarOccurrence<TData>,
  range: EventCalendarDateRange,
  timeZone: string
): EventCalendarSegment<TData>[] {
  const occStart = occurrence.start
  const occEnd = occurrence.end
  const isZeroLength = occEnd.getTime() === occStart.getTime()

  const clampStart = occStart > range.start ? occStart : range.start
  const clampEnd = occEnd < range.end ? occEnd : range.end
  if (clampEnd < clampStart) return []
  if (clampEnd.getTime() === clampStart.getTime() && !isZeroLength) return []

  const segments: EventCalendarSegment<TData>[] = []
  let cursor = zonedStartOfDay(clampStart, timeZone)

  while (cursor < clampEnd || (isZeroLength && segments.length === 0)) {
    const next = zonedStartOfDay(
      addDays(toZoned(cursor, timeZone), 1),
      timeZone
    )
    const segStart = clampStart > cursor ? clampStart : cursor
    const segEnd = clampEnd < next ? clampEnd : next

    const emptySeg = segEnd.getTime() <= segStart.getTime()
    if (!emptySeg || isZeroLength) {
      const isStart = segStart.getTime() === occStart.getTime()
      const isEnd = segEnd.getTime() === occEnd.getTime()
      segments.push({
        occurrence,
        day: cursor,
        isStart,
        isEnd,
        continuesBefore: !isStart,
        continuesAfter: !isEnd,
        startMin: occurrence.allDay
          ? undefined
          : differenceInMinutes(segStart, cursor),
        endMin: occurrence.allDay
          ? undefined
          : Math.max(
              differenceInMinutes(segEnd, cursor),
              differenceInMinutes(segStart, cursor)
            ),
      })
    }
    if (isZeroLength) break
    cursor = next
  }

  return segments
}

/** True when the occurrence should render as a bar (all-day row / month lanes). */
function isBarOccurrence(
  occurrence: EventCalendarOccurrence,
  timeZone?: string
): boolean {
  return occurrence.allDay || spansMultipleDays(occurrence, timeZone)
}

function spansMultipleDays(
  occ: { start: Date; end: Date },
  timeZone?: string
): boolean {
  // An event ending exactly at the next midnight is still single-day
  // (exclusive end), so compare against a strictly-later instant. The
  // yardstick is the length of the day the event starts on, never a flat 24h:
  // a fall-back day is 25h long, and a 00:00-to-00:00 shift on it is still one
  // calendar day that belongs in the hour track, not in the all-day row.
  // Without a display zone the dates answer in their own frame (TZDate) or in
  // the host zone.
  const dayStart = startOfDay(
    timeZone ? toZoned(occ.start, timeZone) : occ.start
  )
  const nextDayStart = startOfDay(addDays(dayStart, 1))
  return (
    occ.end.getTime() - occ.start.getTime() >
    nextDayStart.getTime() - dayStart.getTime()
  )
}

interface PackedPosition {
  column: number
  columnCount: number
  columnSpan: number
}

/**
 * Google-style overlap packing for one day's timed segments.
 * Mutates column/columnCount/columnSpan on the segments, in place.
 * z resolution happens at render: event.zIndex verbatim, else 10 + column.
 */
function packTimedSegments<TData>(
  segments: EventCalendarSegment<TData>[],
  // QUINCY (#241): the window to pack by, when it is not the segment's own elapsed
  // startMin/endMin — the time grid packs a DST transition day by PAINTED (wall-clock) window.
  windowOf?: (segment: EventCalendarSegment<TData>) => [number, number]
): void {
  if (segments.length === 0) return

  type Working = {
    seg: EventCalendarSegment<TData>
    startMin: number
    effEnd: number
  }

  const items: Working[] = segments
    .map((seg) => {
      const [startMin, endMin] = windowOf?.(seg) ?? [
        seg.startMin ?? 0,
        seg.endMin ?? seg.startMin ?? 0,
      ]
      return {
        seg,
        startMin,
        effEnd: Math.max(endMin, startMin + MIN_PACK_SLOT),
      }
    })
    .sort(
      (a, b) =>
        a.startMin - b.startMin ||
        b.effEnd - b.startMin - (a.effEnd - a.startMin) ||
        a.seg.occurrence.key.localeCompare(b.seg.occurrence.key)
    )

  // Sweep into connected clusters
  const clusters: Working[][] = []
  let current: Working[] = []
  let clusterEnd = -Infinity
  for (const item of items) {
    if (item.startMin >= clusterEnd) {
      current = []
      clusters.push(current)
      clusterEnd = -Infinity
    }
    current.push(item)
    clusterEnd = Math.max(clusterEnd, item.effEnd)
  }

  for (const cluster of clusters) {
    // Greedy column assignment
    const colEnds: number[] = []
    const byColumn = new Map<number, Working[]>()
    for (const item of cluster) {
      let col = colEnds.findIndex((end) => end <= item.startMin)
      if (col === -1) {
        col = colEnds.length
        colEnds.push(0)
      }
      colEnds[col] = item.effEnd
      item.seg.column = col
      const bucket = byColumn.get(col) ?? []
      bucket.push(item)
      byColumn.set(col, bucket)
    }
    const columnCount = colEnds.length

    // Partial-overlap expansion: widen rightward into free columns
    for (const item of cluster) {
      let span = 1
      const col = item.seg.column ?? 0
      while (col + span < columnCount) {
        const occupants = byColumn.get(col + span) ?? []
        const blocked = occupants.some(
          (o) => o.startMin < item.effEnd && o.effEnd > item.startMin
        )
        if (blocked) break
        span++
      }
      item.seg.columnCount = columnCount
      item.seg.columnSpan = span
    }
  }
}

/**
 * Greedy lane packing for bar segments within one week row (7 columns).
 * Mutates lane/rowIndex/colStart/colSpan on the segments, in place.
 */
/**
 * Build the laned month-row bars for one week: consecutive-day segments of
 * the same occurrence merge into ONE bar (colStart -> colSpan) stacked into
 * lanes. Returns NEW segment objects - the shared per-day segments (also
 * rendered by the all-day rows and day cells) must stay pristine: mutating
 * their isEnd/continues flags gave the first-day chip a whole-bar shape and
 * a bogus end resize handle in the week all-day row, where dragging it
 * collapsed the event to a single day.
 */
function packWeekRowLanes<TData>(
  segments: EventCalendarSegment<TData>[],
  rowIndex: number,
  rowStart: Date,
  timeZone: string
): EventCalendarSegment<TData>[] {
  type Bar = {
    seg: EventCalendarSegment<TData>
    colStart: number
    colSpan: number
    isStart: boolean
    isEnd: boolean
    lane: number
  }

  const bars: Bar[] = segments.map((seg) => {
    const dayIndex = Math.round(
      (zonedStartOfDay(seg.day, timeZone).getTime() -
        zonedStartOfDay(rowStart, timeZone).getTime()) /
        (24 * 60 * 60 * 1000)
    )
    return {
      seg,
      colStart: Math.max(0, Math.min(6, dayIndex)),
      colSpan: 1,
      isStart: seg.isStart,
      isEnd: seg.isEnd,
      lane: 0,
    }
  })

  // Merge consecutive-day segments of the same occurrence into one bar per row
  const merged = new Map<string, Bar>()
  for (const bar of bars) {
    const key = bar.seg.occurrence.key
    const existing = merged.get(key)
    if (existing) {
      const start = Math.min(existing.colStart, bar.colStart)
      const end = Math.max(
        existing.colStart + existing.colSpan,
        bar.colStart + bar.colSpan
      )
      existing.colStart = start
      existing.colSpan = end - start
      existing.isStart = existing.isStart || bar.isStart
      existing.isEnd = existing.isEnd || bar.isEnd
    } else {
      merged.set(key, bar)
    }
  }

  const rowBars = Array.from(merged.values()).sort(
    (a, b) =>
      a.colStart - b.colStart ||
      b.colSpan - a.colSpan ||
      a.seg.occurrence.key.localeCompare(b.seg.occurrence.key)
  )

  const lanes: boolean[][] = []
  for (const bar of rowBars) {
    let lane = 0
    let row: boolean[] = []
    for (;;) {
      row = lanes[lane] ??= new Array(7).fill(false)
      let free = true
      for (let c = bar.colStart; c < bar.colStart + bar.colSpan; c++) {
        if (row[c]) {
          free = false
          break
        }
      }
      if (free) break
      lane++
    }
    for (let c = bar.colStart; c < bar.colStart + bar.colSpan; c++) {
      row[c] = true
    }
    bar.lane = lane
  }

  return rowBars.map((bar) => ({
    ...bar.seg,
    isStart: bar.isStart,
    isEnd: bar.isEnd,
    continuesBefore: !bar.isStart,
    continuesAfter: !bar.isEnd,
    lane: bar.lane,
    rowIndex,
    colStart: bar.colStart,
    colSpan: bar.colSpan,
  }))
}

interface EventCalendarDayBucket<TData = unknown> {
  allDay: EventCalendarSegment<TData>[]
  timed: EventCalendarSegment<TData>[]
}

interface EventCalendarWeekRow<TData = unknown> {
  rowIndex: number
  rowStart: Date
  /** Laned bar segments (one per occurrence per row). */
  bars: EventCalendarSegment<TData>[]
}

interface EventCalendarIndex<TData = unknown> {
  occurrences: EventCalendarOccurrence<TData>[]
  byDay: Map<string, EventCalendarDayBucket<TData>>
  weekRows: EventCalendarWeekRow<TData>[]
}

interface BuildIndexOptions<TData> {
  timeZone: string
  weekStartsOn: WeekStartsOn
  eventOrder?: (
    a: EventCalendarOccurrence<TData>,
    b: EventCalendarOccurrence<TData>
  ) => number
  getOccurrences?: (
    event: CalendarEvent<TData>,
    range: EventCalendarDateRange,
    ctx: { timeZone: string }
  ) => Array<{ start: Date; end: Date }> | null
}

function defaultEventOrder(
  a: EventCalendarOccurrence,
  b: EventCalendarOccurrence
): number {
  return (
    a.start.getTime() - b.start.getTime() ||
    b.end.getTime() -
      b.start.getTime() -
      (a.end.getTime() - a.start.getTime()) ||
    a.key.localeCompare(b.key)
  )
}

function buildEventIndex<TData>(
  events: CalendarEvent<TData>[],
  visibleRange: EventCalendarDateRange,
  opts: BuildIndexOptions<TData>
): EventCalendarIndex<TData> {
  const { timeZone, weekStartsOn } = opts
  const order = opts.eventOrder ?? defaultEventOrder

  // RECURRENCE-ID override replacement: an event carrying recurringEventId +
  // originalStart is an edited single occurrence of that series. The parent's
  // expansion drops the replaced instant; the override renders as its own
  // occurrence through the normal path below.
  const overrideTimes = new Map<string, Set<number>>()
  for (const event of events) {
    if (!event.recurringEventId || !event.originalStart) continue
    let times = overrideTimes.get(event.recurringEventId)
    if (!times) overrideTimes.set(event.recurringEventId, (times = new Set()))
    times.add(event.originalStart.getTime())
  }

  const occurrences: EventCalendarOccurrence<TData>[] = []
  for (const event of events) {
    const replaced = overrideTimes.get(event.id)
    const custom = opts.getOccurrences?.(event, visibleRange, { timeZone })
    if (custom) {
      custom.forEach((occ, i) => {
        if (replaced?.has(occ.start.getTime())) return
        if (!rangesIntersect({ start: occ.start, end: occ.end }, visibleRange))
          return
        occurrences.push({
          key: `${event.id}::${occ.start.toISOString()}`,
          eventId: event.id,
          event,
          start: occ.start,
          end: occ.end,
          allDay: event.allDay ?? false,
          isRecurring: true,
          recurrenceIndex: i,
        })
      })
      continue
    }
    const expanded = expandRecurrence(event, visibleRange, { timeZone })
    occurrences.push(
      ...(replaced
        ? expanded.filter((occ) => !replaced.has(occ.start.getTime()))
        : expanded)
    )
  }
  occurrences.sort(order)

  const byDay = new Map<string, EventCalendarDayBucket<TData>>()
  const barSegmentsByRow = new Map<number, EventCalendarSegment<TData>[]>()
  const firstRowStart = startOfWeek(toZoned(visibleRange.start, timeZone), {
    weekStartsOn,
  })

  for (const occurrence of occurrences) {
    const segments = segmentOccurrence(occurrence, visibleRange, timeZone)
    const bar = isBarOccurrence(occurrence, timeZone)
    for (const seg of segments) {
      const key = getDayKey(seg.day, timeZone)
      let bucket = byDay.get(key)
      if (!bucket) {
        bucket = { allDay: [], timed: [] }
        byDay.set(key, bucket)
      }
      if (bar) {
        bucket.allDay.push(seg)
        // calendar-day math, not a fixed 168h divisor: DST transition weeks
        // are 167/169h long and the fixed divisor mis-buckets every later
        // Sunday one row early (which then clamps into the wrong column)
        const rowIndex = Math.floor(
          differenceInCalendarDays(toZoned(seg.day, timeZone), firstRowStart) /
            7
        )
        const rowBucket = barSegmentsByRow.get(rowIndex) ?? []
        rowBucket.push(seg)
        barSegmentsByRow.set(rowIndex, rowBucket)
      } else {
        bucket.timed.push(seg)
      }
    }
  }

  for (const bucket of byDay.values()) {
    packTimedSegments(bucket.timed)
  }

  const weekRows: EventCalendarWeekRow<TData>[] = []
  for (const [rowIndex, segs] of barSegmentsByRow) {
    const rowStart = addWeeks(firstRowStart, rowIndex)
    weekRows.push({
      rowIndex,
      rowStart,
      bars: packWeekRowLanes(segs, rowIndex, rowStart, timeZone),
    })
  }
  weekRows.sort((a, b) => a.rowIndex - b.rowIndex)

  return { occurrences, byDay, weekRows }
}

/** Cache key for index memoization; cheap string compare. */
function getRangeKey(range: EventCalendarDateRange): string {
  return `${range.start.getTime()}-${range.end.getTime()}`
}

/** Depth-first flatten of the resource tree (parents included). */
function flattenResources(
  resources: EventCalendarResource[],
  depth = 0
): Array<{ resource: EventCalendarResource; depth: number }> {
  const rows: Array<{ resource: EventCalendarResource; depth: number }> = []
  for (const resource of resources) {
    rows.push({ resource, depth })
    if (resource.children?.length) {
      rows.push(...flattenResources(resource.children, depth + 1))
    }
  }
  return rows
}

const DEFAULT_WEEKEND_DAYS = [0, 6]

/**
 * Resolves whether a day is an off day (non-working) in the display zone.
 * Callers pass the calendar's own weekendDays so the shading cannot contradict
 * the weekend the rest of the calendar renders; an explicit offDays.weekendDays
 * still wins over it.
 */
function resolveOffDay(
  day: Date,
  timeZone: string,
  config: boolean | EventCalendarOffDaysConfig | undefined,
  defaultWeekendDays?: number[]
): boolean {
  if (!config) return false
  const resolved: EventCalendarOffDaysConfig = config === true ? {} : config
  const weekendDays =
    resolved.weekendDays ?? defaultWeekendDays ?? DEFAULT_WEEKEND_DAYS
  const zoned = toZoned(day, timeZone)
  if (weekendDays.includes(zoned.getDay())) return true
  if (resolved.dates?.length) {
    const key = getDayKey(day, timeZone)
    if (resolved.dates.some((date) => getDayKey(date, timeZone) === key)) {
      return true
    }
  }
  return resolved.isOffDay?.(day) ?? false
}

export {
  buildEventIndex,
  defaultEventOrder,
  elapsedMinutesAtWallClock,
  elapsedMinutesAtWallClockHour,
  eventsOverlap,
  flattenResources,
  getDayKey,
  getDayTotalMinutes,
  getRangeKey,
  getViewDateRange,
  isBarOccurrence,
  MIN_PACK_SLOT,
  packTimedSegments,
  packWeekRowLanes,
  rangesIntersect,
  resolveOffDay,
  segmentOccurrence,
  snapMinutes,
  spansMultipleDays,
  stepDate,
  toZoned,
  wallClockMinutesAtElapsed,
  wallClockWindow,
  zonedStartOfDay,
}
export type {
  BuildIndexOptions,
  EventCalendarDayBucket,
  EventCalendarIndex,
  EventCalendarWeekRow,
  ViewDateRanges,
  ViewRangeOptions,
  WeekStartsOn,
}