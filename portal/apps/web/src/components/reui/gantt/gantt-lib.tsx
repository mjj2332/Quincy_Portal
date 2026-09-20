/**
 * ReUI's `@reui/gantt` — a headless-first Gantt (horizontal resource timeline, day-to-year
 * scales, external CRUD contract, a subscribable store) shipped as 9 files. Fetched via
 * `npx shadcn@latest add @reui/gantt` into a sandbox (`tmp/ReUI-Test-1`, `--path
 * src/components/vendor-219`) for #219 (PR A, stage 1 of 3: shared infra + Gantt vendor, no
 * consumer yet). VERBATIM: `add` already resolves every registry `IconPlaceholder` to a real
 * lucide icon (see below), so the only edits here are mechanical, identical in kind across all 9
 * files:
 *
 * 1. Dropped the registry's `"use client"` directive (meaningless in this Vite SPA) — present in
 *    gantt.tsx, gantt-bar.tsx, gantt-nav.tsx; absent from the other six.
 * 2. `cn` imported from `@/lib/utils` instead of the registry's raw `"cn"` package (see
 *    `reui/checkbox.tsx`'s header for why that package must never be installed).
 * 3. Every cross-file import repointed from the sandbox's `--path`
 *    (`@/components/vendor-219/<name>`) to this file's real home: `@/components/reui/gantt/<name>`
 *    for the other eight gantt files, `@/components/reui/<name>` for the shared base-nova/ReUI
 *    primitives this registry item depends on (`button`, `calendar`, `checkbox`, `context-menu`,
 *    `dropdown-menu`, `popover`, `scroll-area`, `tooltip` — all already vendored in this
 *    directory, the last six as of #219 stage 1).
 *
 * Diffed against the sandbox's own `src/components/vendor-219/<name>.tsx` output, every line
 * differs only in one of the three ways above — WITH ONE EXCEPTION, forced by typecheck rather
 * than chosen: this repo's `tsconfig.base.json` sets `noUncheckedIndexedAccess: true`, which the
 * sandbox's own `tsconfig.app.json` does not. One array index the vendor code treats as always
 * in-bounds therefore typechecks in the sandbox and fails here. Fixed with the smallest possible
 * edit, a non-null assertion, marked inline at the one site: `laneIntervals[lane]!.push(interval)`
 * — the preceding `while (laneIntervals.length <= lane) laneIntervals.push([])` guarantees the
 * index is populated.
 *
 * No production code imports this tree yet — `src/harness/harness-reachability.guard.test.ts`
 * makes that a build failure rather than a bug report, and the dev-only harness at
 * `src/harness/reui-scheduling/` is the only thing that renders it, with local fixture data.
 *
 * This file: pure scheduling math — lane packing, baseline variance, timezone conversion via
 * `@date-fns/tz`. No icons used.
 *
 * #219 stage 2 (PR A) edit, additive: added `isResizableEdge` and `computeGanttKeyboardProposal`
 * for the Portal's keyboard move/resize equivalent of the pointer drag/resize gestures. Both live
 * here rather than in `gantt-dnd.tsx` (the pointer gesture machinery) or `gantt.tsx` (the
 * `nudgeEvent` API method that calls them) because `gantt-dnd.tsx` already depends on `gantt.tsx`
 * for `useGantt`/`useGanttViewConfig`/`GanttInstance` — `gantt.tsx` importing anything back from
 * `gantt-dnd.tsx` would be a cycle. This file has no dependents that could cycle back, so both
 * `gantt-dnd.tsx`'s `canResize` and `gantt.tsx`'s `nudgeEvent` import from here instead.
 *
 * #219 PR A fix (Sol review, sol1 item 4) — `computeGanttKeyboardProposal`'s day-unit
 * (`step >= 1440`) branches wrapped every moved/resized edge in `zonedStartOfDay`, and the timed
 * MOVE branch derived the new end from the new start plus the ORIGINAL elapsed milliseconds. Both
 * are wrong for a timed (non-midnight-aligned) subject: a 14:00 resize edge landed on 00:00, and a
 * subject whose start/end straddle a DST transition's wall-clock gap changed the end's time of
 * day. Fixed: every day-unit edge now shifts by zoned `addDays` alone, preserving its OWN wall
 * time exactly, with start and end of a timed move shifted INDEPENDENTLY (never end = start +
 * elapsed ms). The pre-existing day-ALIGNED move branch (both edges already at zoned midnight, or
 * `allDay`) is unchanged — it already preserved the civil-day span correctly. This is a
 * KEYBOARD-ONLY fix: the pointer drag's own day-snap path in `gantt-dnd.tsx` (`beginGesture`,
 * around its `snapMin`/`maxStartMin` logic) still snaps to absolute zoned midnight and is
 * deliberately left untouched by this change — see `gantt-dnd.tsx`'s own header for that path.
 *
 * #219 PR A (Adjust mode) addition — `computeGanttKeyboardProposal`'s `step` now also admits a
 * WHOLE MULTIPLE of a civil day (e.g. `10080` = 7 days), for Shift+Arrow's "larger unit" in Adjust
 * mode (`gantt.tsx`'s `stepAdjust`, sized by the new `resolveAdjustLargerStepMinutes` below). Every
 * day-unit "new position" edge (`addDays(..., direction)`) now shifts by `direction * dayUnits`
 * instead of a bare `direction` — `dayUnits = step / (24 * 60)`, always a whole number at both call
 * sites (1 today, 7 for the larger unit). The MINIMUM-duration bounds (`addDays(..., -1)` /
 * `addDays(..., 1)` in the two resize branches) stay literal single-day regardless of `dayUnits` —
 * they express "at least one day long," not "one step," so a 7-day step resizing toward inversion
 * still refuses only once the range would drop under one full day, not under seven.
 *
 * #219 PR A (Adjust mode) addition — `matchGanttBarKey` (with its `ganttArrowDirection` helper,
 * moved here from `gantt-bar.tsx`) replaces that file's old `matchGanttBarKeyChord`: a pure,
 * table-testable matcher for the WHOLE new key scheme (Space to enter, Arrow/Shift+Arrow to step,
 * M/S/E to retarget, Enter/Space to commit, Escape to cancel), RTL-aware and independent of any
 * eligibility check (the caller in `gantt-bar.tsx` still gates Space/retarget on canMove/
 * canResizeStart/canResizeEnd/isRecurring, same as it always gated the old chords).
 */

import { expandRecurrence } from "@/components/reui/gantt/gantt-recurrence"
import type {
  GanttBaseline,
  GanttBaselineVariance,
  GanttDateRange,
  GanttEvent,
  GanttNudgeAction,
  GanttOccurrence,
  GanttOffDaysConfig,
  GanttOverlapPolicy,
  GanttRecurrenceRule,
  GanttResource,
  GanttScale,
  GanttScheduleMode,
  GanttSegment,
} from "@/components/reui/gantt/gantt-types"
import { TZDate } from "@date-fns/tz"
import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  differenceInCalendarDays,
  differenceInMinutes,
  format,
  startOfDay,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  startOfYear,
} from "date-fns"

type WeekStartsOn = 0 | 1 | 2 | 3 | 4 | 5 | 6

/**
 * Packing-effective minimum in minutes so tiny events do not stack invisibly.
 * It is a packing FOOTPRINT, not a render size: two schedules less than this
 * apart are treated as concurrent and split into separate lanes even though
 * their real ranges do not touch.
 */
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

function snapMinutes(minutes: number, snap: number): number {
  return Math.round(minutes / snap) * snap
}

interface ViewRangeOptions {
  timeZone: string
  weekStartsOn: WeekStartsOn
}

interface ViewDateRanges {
  visibleRange: GanttDateRange
  activeRange: GanttDateRange
}

/** Axis range for the anchor date at the given scale. */
function getGanttDateRange(
  scale: GanttScale,
  date: Date,
  opts: ViewRangeOptions
): ViewDateRanges {
  const { timeZone, weekStartsOn } = opts
  const zoned = toZoned(date, timeZone)

  if (scale === "week") {
    const start = startOfWeek(zoned, { weekStartsOn })
    const range = { start, end: addWeeks(start, 1) }
    return { activeRange: range, visibleRange: range }
  }
  if (scale === "month") {
    // exact month: no outside days on the horizontal axis
    const start = startOfMonth(zoned)
    const range = { start, end: startOfMonth(addMonths(zoned, 1)) }
    return { activeRange: range, visibleRange: range }
  }
  if (scale === "quarter") {
    // week-aligned so the axis partitions into uniform week units
    const quarterStart = startOfQuarter(zoned)
    const quarterEnd = startOfQuarter(addMonths(zoned, 3))
    const start = startOfWeek(quarterStart, { weekStartsOn })
    let end = startOfWeek(quarterEnd, { weekStartsOn })
    if (end < quarterEnd) end = addWeeks(end, 1)
    return {
      activeRange: { start: quarterStart, end: quarterEnd },
      visibleRange: { start, end },
    }
  }
  if (scale === "year") {
    const start = startOfYear(zoned)
    const range = { start, end: startOfYear(addYears(zoned, 1)) }
    return { activeRange: range, visibleRange: range }
  }
  const start = startOfDay(zoned)
  const range = { start, end: addDays(start, 1) }
  return { activeRange: range, visibleRange: range }
}

/** The anchor date stepped one period forward or backward for the scale. */
function stepGanttDate(
  scale: GanttScale,
  date: Date,
  direction: 1 | -1,
  opts: Pick<ViewRangeOptions, "timeZone">
): Date {
  const zoned = toZoned(date, opts.timeZone)
  if (scale === "week") return addWeeks(zoned, direction)
  if (scale === "month") return addMonths(zoned, direction)
  if (scale === "quarter") return addMonths(zoned, direction * 3)
  if (scale === "year") return addYears(zoned, direction)
  return addDays(zoned, direction)
}

function rangesIntersect(a: GanttDateRange, b: GanttDateRange): boolean {
  return a.start < b.end && a.end > b.start
}

function eventsOverlap(
  a: { start: Date; end: Date },
  b: { start: Date; end: Date }
): boolean {
  return a.start < b.end && a.end > b.start
}

/**
 * Range visibility for an occurrence: half-open like rangesIntersect, except
 * a zero-length occurrence (a milestone). The plain test can never admit an
 * instant sitting exactly on the range start, so milestones compare the
 * start closed; the end stays exclusive - an instant on the range end
 * belongs to the next period. gantt-recurrence inlines this same rule
 * (importing it back here would cycle the modules).
 */
function occurrenceIntersects(
  occ: { start: Date; end: Date },
  range: GanttDateRange
): boolean {
  if (occ.end.getTime() === occ.start.getTime()) {
    return occ.start >= range.start && occ.start < range.end
  }
  return rangesIntersect(occ, range)
}

function spansMultipleDays(occ: { start: Date; end: Date }): boolean {
  // An event ending exactly at the next midnight is still single-day
  // (exclusive end), so compare against a strictly-later instant.
  return occ.end.getTime() - occ.start.getTime() > 24 * 60 * 60 * 1000
}

/**
 * The subject's validated planned window, or null: both instants present,
 * end not before start, and (for events) non-recurring - a series has no
 * single planned window. An edited single occurrence (recurringEventId
 * without its own rule) is a plain event here and keeps its baseline.
 * Structural on purpose: a GanttResource node's own baseline pair resolves
 * through the same rule.
 */
function resolveEventBaseline(subject: {
  baselineStart?: Date
  baselineEnd?: Date
  recurrence?: GanttRecurrenceRule | string
}): GanttBaseline | null {
  if (!subject.baselineStart || !subject.baselineEnd || subject.recurrence) {
    return null
  }
  const startMs = subject.baselineStart.getTime()
  const endMs = subject.baselineEnd.getTime()
  if (endMs < startMs) return null
  return {
    start: subject.baselineStart,
    end: subject.baselineEnd,
    milestone: endMs === startMs,
  }
}

interface GanttDependencyGeometry {
  /** Orthogonal elbow path for the connector line, in the caller's units. */
  line: string
  /** Filled arrowhead at the target anchor, pointing along +x. */
  arrow: string
}

/**
 * Finish-to-start connector geometry from a predecessor's END anchor to a
 * successor's START anchor, in whatever units the caller works in (the view
 * passes rem). A target with room ahead takes the classic Z route: out by
 * `clearance`, across to the target lane, in. A target at or behind the
 * source's exit loops instead: out, hop `laneStep` toward the target's side
 * (down when level - below reads as "later"), back past the target, in.
 * The line stops `arrowSize` short of the anchor so it never pokes through
 * the head. The exit stub can sit under an outside-after bar label; a
 * consumer that shows those widens the label's start margin instead of the
 * routing changing shape (a drop-first exit was tried and read worse
 * everywhere else).
 */
function buildDependencyPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: { clearance: number; laneStep: number; arrowSize: number }
): GanttDependencyGeometry {
  const { clearance, laneStep, arrowSize } = opts
  const lineEndX = to.x - arrowSize
  const arrow = `M ${to.x} ${to.y} L ${lineEndX} ${to.y - arrowSize * 0.6} L ${lineEndX} ${to.y + arrowSize * 0.6} Z`
  if (lineEndX >= from.x + clearance) {
    return {
      line: `M ${from.x} ${from.y} H ${from.x + clearance} V ${to.y} H ${lineEndX}`,
      arrow,
    }
  }
  const midY = to.y >= from.y ? from.y + laneStep : from.y - laneStep
  return {
    line: `M ${from.x} ${from.y} H ${from.x + clearance} V ${midY} H ${to.x - clearance} V ${to.y} H ${lineEndX}`,
    arrow,
  }
}

/** Actual end against the planned end; null when no valid baseline exists. */
function getBaselineVariance<TData>(
  event: GanttEvent<TData>
): GanttBaselineVariance | null {
  const baseline = resolveEventBaseline(event)
  if (!baseline) return null
  const deltaMs = event.end.getTime() - baseline.end.getTime()
  return deltaMs > 0 ? "late" : deltaMs < 0 ? "early" : "on-time"
}

interface PackedPosition {
  column: number
  columnCount: number
  columnSpan: number
}

/**
 * Identity of a schedule ACROSS time edits. `occurrence.key` embeds the start
 * instant, so it changes the moment a schedule is moved or start-resized -
 * useless as lane memory. This key survives the edit: the event id plus, for a
 * recurring series, the occurrence's position in it.
 */
function getLaneKey(occurrence: {
  eventId: string
  recurrenceIndex?: number
}): string {
  return `${occurrence.eventId}::${occurrence.recurrenceIndex ?? 0}`
}

/**
 * What one schedule held on the previous layout pass. The TIMES are what make
 * this more than a lane number: they are how the packer tells the schedule the
 * user just edited apart from the ones that merely sat still.
 */
interface GanttLaneMemo {
  lane: number
  startMs: number
  endMs: number
}

interface PackOptions {
  /**
   * Where each schedule sat on the previous pass, by getLaneKey.
   *
   * A schedule whose times are UNCHANGED keeps its lane if that lane is still
   * free, so editing one schedule never re-indexes the ones around it. A
   * schedule whose times CHANGED - the one the user just dragged or resized -
   * deliberately forfeits its pin and re-seeks the lowest free lane. That is
   * what makes the arrangement live rather than frozen: a schedule dragged
   * onto its neighbours stacks DOWN into the first free lane, and one dragged
   * clear of them comes back UP inline. Only the edited schedule moves.
   */
  preferredLanes?: Map<string, GanttLaneMemo>
  /** "single" collapses the row to one track; see GanttScheduleMode. */
  mode?: "single" | "multiple"
}

/**
 * Overlap packing for one row's timed segments.
 * Mutates column/columnCount/columnSpan on the segments, in place.
 * z resolution happens at render: event.zIndex verbatim, else 10 + column.
 */
function packTimedSegments<TData>(
  segments: GanttSegment<TData>[],
  options: PackOptions = {}
): void {
  if (segments.length === 0) return

  if (options.mode === "single") {
    // one track: every schedule shares lane 0 and the row never grows
    for (const seg of segments) {
      seg.column = 0
      seg.columnCount = 1
      seg.columnSpan = 1
    }
    return
  }

  const preferredLanes = options.preferredLanes

  type Working = {
    seg: GanttSegment<TData>
    startMin: number
    effEnd: number
    lane: number
    /** The occupancy entry this item added, so a settle can take it back. */
    interval?: { from: number; to: number }
  }

  const items: Working[] = segments
    .map((seg) => {
      const startMin = seg.startMin ?? 0
      const endMin = seg.endMin ?? startMin
      return {
        seg,
        startMin,
        effEnd: Math.max(endMin, startMin + MIN_PACK_SLOT),
        lane: -1,
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
    // Per-lane occupancy INTERVALS, not a single running end: pass 1 claims
    // remembered lanes out of time order, so a lane can be free before an
    // occupant and busy after it.
    const laneIntervals: Array<Array<{ from: number; to: number }>> = []
    const isFree = (lane: number, item: Working) =>
      !(laneIntervals[lane] ?? []).some(
        (iv) => iv.from < item.effEnd && iv.to > item.startMin
      )
    const claim = (lane: number, item: Working) => {
      while (laneIntervals.length <= lane) laneIntervals.push([])
      const interval = { from: item.startMin, to: item.effEnd }
      // Quincy edit (#219 stage 1): non-null assertion. The `while` loop above guarantees
      // `laneIntervals.length > lane`, so this index is always defined; Quincy's stricter
      // `noUncheckedIndexedAccess` (unset in the vendor's own tsconfig) does not know that.
      laneIntervals[lane]!.push(interval)
      item.lane = lane
      item.interval = interval
    }
    const release = (item: Working) => {
      const occupants = laneIntervals[item.lane] ?? []
      const at = occupants.indexOf(item.interval!)
      if (at >= 0) occupants.splice(at, 1)
    }

    // pass 1: schedules that did not move keep the lane they had. The one the
    // user just edited is NOT pinned - its times differ from the memo, so it
    // falls through to pass 2 and re-seeks a lane against its new span.
    const pending: Working[] = []
    for (const item of cluster) {
      const memo = preferredLanes?.get(getLaneKey(item.seg.occurrence))
      const untouched =
        memo !== undefined &&
        memo.startMs === item.seg.occurrence.start.getTime() &&
        memo.endMs === item.seg.occurrence.end.getTime()
      if (untouched && memo.lane >= 0 && isFree(memo.lane, item)) {
        claim(memo.lane, item)
      } else {
        pending.push(item)
      }
    }
    // pass 2: the rest take the lowest free lane - overlapping goes DOWN into
    // the first lane with room, fitting comes back UP to lane 0
    for (const item of pending) {
      let lane = 0
      while (!isFree(lane, item)) lane++
      claim(lane, item)
    }

    // pass 3: nothing floats above an empty lane. A pin only survives while
    // something above it still needs the space - once the schedule that was
    // there moves away or is deleted, its neighbour settles down into the
    // gap. Without this a row keeps a permanently blank top lane and never
    // shrinks back. Settling in lane order, and only ever DOWNWARD into space
    // that is genuinely free, means two schedules can never trade places -
    // so an edit still moves at most the schedule it touched.
    const byLane = [...cluster].sort(
      (a, b) => a.lane - b.lane || a.startMin - b.startMin
    )
    for (const item of byLane) {
      if (item.lane === 0) continue
      let lane = 0
      while (lane < item.lane && !isFree(lane, item)) lane++
      if (lane < item.lane) {
        release(item)
        claim(lane, item)
      }
    }
  }

  // Lane memory can leave holes (the schedule that held lane 0 was deleted or
  // moved away). Collapse the row's USED lanes onto 0..n-1: relative stacking
  // order survives, so nothing reshuffles, but the row cannot creep taller
  // than the lanes it actually needs.
  const used = [...new Set(items.map((item) => item.lane))].sort(
    (a, b) => a - b
  )
  const compacted = new Map(used.map((lane, index) => [lane, index]))
  const columnCount = used.length
  for (const item of items) {
    item.lane = compacted.get(item.lane) ?? 0
    item.seg.column = item.lane
    item.seg.columnCount = columnCount
  }

  // Partial-overlap expansion: widen rightward into free lanes
  for (const cluster of clusters) {
    for (const item of cluster) {
      let span = 1
      while (item.lane + span < columnCount) {
        const blocked = cluster.some(
          (other) =>
            other !== item &&
            other.lane === item.lane + span &&
            other.startMin < item.effEnd &&
            other.effEnd > item.startMin
        )
        if (blocked) break
        span++
      }
      item.seg.columnSpan = span
    }
  }
}

function defaultEventOrder(a: GanttOccurrence, b: GanttOccurrence): number {
  return (
    a.start.getTime() - b.start.getTime() ||
    b.end.getTime() -
      b.start.getTime() -
      (a.end.getTime() - a.start.getTime()) ||
    a.key.localeCompare(b.key)
  )
}

interface BuildIndexOptions<TData = unknown> {
  timeZone: string
  /** Escape hatch for exotic recurrence: return the expanded occurrences. */
  getOccurrences?: (
    event: GanttEvent<TData>,
    range: GanttDateRange,
    ctx: { timeZone: string }
  ) => Array<{ start: Date; end: Date }> | null | undefined
  eventOrder?: (a: GanttOccurrence<TData>, b: GanttOccurrence<TData>) => number
}

interface GanttIndex<TData = unknown> {
  occurrences: GanttOccurrence<TData>[]
}

function buildEventIndex<TData>(
  events: GanttEvent<TData>[],
  visibleRange: GanttDateRange,
  opts: BuildIndexOptions<TData>
): GanttIndex<TData> {
  const { timeZone } = opts
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

  const occurrences: GanttOccurrence<TData>[] = []
  for (const event of events) {
    const replaced = overrideTimes.get(event.id)
    const custom = opts.getOccurrences?.(event, visibleRange, { timeZone })
    if (custom) {
      custom.forEach((occ, i) => {
        if (replaced?.has(occ.start.getTime())) return
        if (
          !occurrenceIntersects(
            { start: occ.start, end: occ.end },
            visibleRange
          )
        )
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
  return { occurrences }
}

/** Cache key for index memoization; cheap string compare. */
function getRangeKey(range: GanttDateRange): string {
  return `${range.start.getTime()}-${range.end.getTime()}`
}

/** Depth-first flatten of the resource tree (parents included). */
function flattenResources(
  resources: GanttResource[],
  depth = 0
): Array<{ resource: GanttResource; depth: number }> {
  const rows: Array<{ resource: GanttResource; depth: number }> = []
  for (const resource of resources) {
    rows.push({ resource, depth })
    if (resource.children?.length) {
      rows.push(...flattenResources(resource.children, depth + 1))
    }
  }
  return rows
}

/** Depth-first lookup of one node in the tree. */
function findResource(
  resources: GanttResource[],
  id: string
): GanttResource | null {
  for (const resource of resources) {
    if (resource.id === id) return resource
    const found = resource.children?.length
      ? findResource(resource.children, id)
      : null
    if (found) return found
  }
  return null
}

/**
 * Pure tree move: removes `resourceId` from wherever it sits and reinserts it
 * under `parentId` (null = root) at `index`. Returns a new tree; the original
 * is untouched. Returns null for impossible moves (unknown ids, or dropping a
 * node into its own subtree).
 */
function reorderResources(
  resources: GanttResource[],
  resourceId: string,
  parentId: string | null,
  index: number
): GanttResource[] | null {
  let moved: GanttResource | null = null

  const strip = (nodes: GanttResource[]): GanttResource[] =>
    nodes.flatMap((node) => {
      if (node.id === resourceId) {
        moved = node
        return []
      }
      if (!node.children?.length) return [node]
      return [{ ...node, children: strip(node.children) }]
    })

  const stripped = strip(resources)
  if (!moved) return null

  const contains = (node: GanttResource, id: string): boolean =>
    node.id === id || !!node.children?.some((child) => contains(child, id))
  if (parentId !== null && contains(moved, parentId)) return null

  const insert = (nodes: GanttResource[]): GanttResource[] => {
    if (parentId === null) {
      const next = [...nodes]
      next.splice(Math.min(Math.max(index, 0), next.length), 0, moved!)
      return next
    }
    return nodes.map((node) => {
      if (node.id === parentId) {
        const children = [...(node.children ?? [])]
        children.splice(
          Math.min(Math.max(index, 0), children.length),
          0,
          moved!
        )
        return { ...node, children }
      }
      if (!node.children?.length) return node
      return { ...node, children: insert(node.children) }
    })
  }

  const next = insert(stripped)
  // unknown parentId: the node vanished - reject
  if (parentId !== null) {
    const flat = flattenResources(next)
    if (!flat.some(({ resource }) => resource.id === resourceId)) return null
  }
  return next
}

const DEFAULT_WEEKEND_DAYS = [0, 6]

/** Resolves whether a day is an off day (non-working) in the display zone. */
function resolveOffDay(
  day: Date,
  timeZone: string,
  config: boolean | GanttOffDaysConfig | undefined
): boolean {
  if (!config) return false
  const resolved: GanttOffDaysConfig = config === true ? {} : config
  const weekendDays = resolved.weekendDays ?? DEFAULT_WEEKEND_DAYS
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

/**
 * Edge-level resizability veto shared by `gantt-dnd.tsx`'s pointer `canResize` (segment-based) and
 * `gantt.tsx`'s `nudgeEvent` (event-based, no segment) — see this file's header for why it lives
 * here rather than in either of those. Does NOT check milestone-ness or `interactions.resize` -
 * both are call-site-specific (a segment already knows its own occurrence range; `nudgeEvent` reads
 * live interactions state).
 */
function isResizableEdge(
  event: Pick<GanttEvent, "readOnly" | "resizable" | "resizableEdges">,
  edge?: "start" | "end"
): boolean {
  if (event.readOnly) return false
  if (event.resizable === false) return false
  if (edge && event.resizableEdges?.[edge] === false) return false
  return true
}

interface GanttKeyboardProposal {
  start: Date
  end: Date
  allDay: boolean
}

/** True when `d` sits exactly on a zoned midnight in `timeZone`. */
function isZonedMidnight(d: Date, timeZone: string): boolean {
  return zonedStartOfDay(d, timeZone).getTime() === d.getTime()
}

/**
 * Pure proposal for one keyboard move/resize nudge - the keyboard equivalent of one pointer-drag
 * snap step (owner decision on #215/#219: every pointer scheduling gesture needs a keyboard
 * equivalent). Returns null when the step would invert or zero the range (minimum duration = one
 * step); a milestone (zero-duration subject) moves but never resizes.
 *
 * `step` is in minutes and is the SAME unit a pointer drag snaps to (`gantt-view.tsx`'s own
 * `snapMin = scale === "day" ? settings.snapDuration : 24 * 60`): `settings.snapDuration` at the
 * day scale, one civil day at week/month/quarter/year. At `step >= 24 * 60` the moving edge steps
 * by a CIVIL day in `timeZone` - zoned midnight to zoned midnight, via `@date-fns/tz`'s `TZDate`
 * arithmetic, never a raw `+= 1440 * 60000` ms, which drifts by an hour across a DST boundary -
 * mirroring the day-snapped branch of the pointer drag's own proposal math in `gantt-dnd.tsx`'s
 * `beginGesture`. Below that threshold the edge steps by raw minutes, matching the pointer's own
 * sub-day snap.
 */
function computeGanttKeyboardProposal(
  subject: { start: Date; end: Date; allDay: boolean },
  action: "move" | "resize-start" | "resize-end",
  direction: -1 | 1,
  step: number,
  timeZone: string
): GanttKeyboardProposal | null {
  const milestone = subject.end.getTime() === subject.start.getTime()
  const dayMode = step >= 24 * 60
  // #219 PR A (Adjust mode): step may be a WHOLE MULTIPLE of a civil day (Shift+Arrow's larger
  // unit, e.g. 10080 = 7 days) - see this function's own header. Always a whole number at both
  // call sites; Math.round only guards against float drift, never rounds a genuine fraction.
  const dayUnits = dayMode ? Math.round(step / (24 * 60)) : 0
  const dayStep = direction * dayUnits

  if (action !== "move") {
    // a milestone is an instant: it has no edges to resize
    if (milestone) return null
    if (action === "resize-start") {
      // Quincy fix (#219 PR A, sol1 item 4): shift the moving edge by zoned civil
      // day(s), preserving ITS OWN wall time exactly (14:00 stays 14:00) - never
      // `zonedStartOfDay`, which silently snapped every day-unit resize to
      // midnight regardless of the edge's actual time of day. The bound is a
      // fixed SINGLE day short of the FIXED edge's own wall time (the minimum
      // valid duration is one day, regardless of how big THIS step is), via
      // `addDays`, not a midnight snap of it either.
      const newStartMs = dayMode
        ? addDays(toZoned(subject.start, timeZone), dayStep).getTime()
        : subject.start.getTime() + direction * step * 60000
      const maxStartMs = dayMode
        ? addDays(toZoned(subject.end, timeZone), -1).getTime()
        : subject.end.getTime() - step * 60000
      if (newStartMs > maxStartMs) return null
      return {
        start: new Date(newStartMs),
        end: subject.end,
        allDay: subject.allDay,
      }
    }
    // resize-end - mirrors resize-start above.
    const newEndMs = dayMode
      ? addDays(toZoned(subject.end, timeZone), dayStep).getTime()
      : subject.end.getTime() + direction * step * 60000
    const minEndMs = dayMode
      ? addDays(toZoned(subject.start, timeZone), 1).getTime()
      : subject.start.getTime() + step * 60000
    if (newEndMs < minEndMs) return null
    return {
      start: subject.start,
      end: new Date(newEndMs),
      allDay: subject.allDay,
    }
  }

  // move
  if (milestone) {
    const newMs = dayMode
      ? addDays(toZoned(subject.start, timeZone), dayStep).getTime()
      : subject.start.getTime() + direction * step * 60000
    return {
      start: new Date(newMs),
      end: new Date(newMs),
      allDay: subject.allDay,
    }
  }
  if (dayMode) {
    if (
      subject.allDay ||
      (isZonedMidnight(subject.start, timeZone) &&
        isZonedMidnight(subject.end, timeZone))
    ) {
      // Day-snapped scales preserve the CALENDAR span for a day-aligned
      // subject, never drifting the end to e.g. 23:00 across a DST change -
      // mirrors gantt-dnd.tsx's own move branch exactly.
      const daySpan = Math.max(
        differenceInCalendarDays(
          toZoned(subject.end, timeZone),
          toZoned(subject.start, timeZone)
        ),
        1
      )
      const newStartZoned = zonedStartOfDay(
        addDays(toZoned(subject.start, timeZone), dayStep),
        timeZone
      )
      const newStart = new Date(newStartZoned.getTime())
      const newEnd = zonedStartOfDay(
        addDays(toZoned(newStart, timeZone), daySpan),
        timeZone
      )
      return {
        start: newStart,
        end: new Date(newEnd.getTime()),
        allDay: subject.allDay,
      }
    }
    // A timed (non-midnight-aligned) subject at a day-or-more scale keeps
    // EACH edge's own wall-clock time of day across the move - start and end
    // are shifted INDEPENDENTLY via zoned `addDays`, never end = start +
    // elapsed ms. Quincy fix (#219 PR A, sol1 item 4): the old elapsed-ms
    // shortcut was only correct when the transition day's DST gap did not
    // fall between the two wall times; when it did (e.g. 01:30-03:30 moved
    // onto a day whose 02:00-03:00 hour is skipped or repeated) it silently
    // changed the end's wall time. This intentionally means the real
    // (millisecond) duration can change across a transition - the WALL-CLOCK
    // span is what a day-unit keyboard nudge preserves, mirroring how a
    // day-aligned subject already preserves its civil-day span above.
    const newStart = addDays(toZoned(subject.start, timeZone), dayStep)
    const newEnd = addDays(toZoned(subject.end, timeZone), dayStep)
    return {
      start: new Date(newStart.getTime()),
      end: new Date(newEnd.getTime()),
      allDay: subject.allDay,
    }
  }
  // minute-mode: raw ms arithmetic, exact duration preserved
  const newStartMs = subject.start.getTime() + direction * step * 60000
  const durationMs = subject.end.getTime() - subject.start.getTime()
  return {
    start: new Date(newStartMs),
    end: new Date(newStartMs + durationMs),
    allDay: subject.allDay,
  }
}

/**
 * #219 PR A (Adjust mode) — Shift+Arrow's "larger unit" step, in minutes, for
 * `computeGanttKeyboardProposal` above. Owner decision: if the view's normal keyboard step
 * (`baseStepMinutes` - `gantt.tsx`'s `scale === "day" ? snapDuration : 24 * 60`) is already a civil
 * day or more (week/month/quarter/year scales, or the day scale with a whole-day snap), the larger
 * unit is 7 civil days. If the normal step is SUB-day (the day scale with `snapDuration < 1440`),
 * the larger unit is 1 hour when that snap is under an hour, otherwise 1 civil day - one rung up
 * from "a few minutes" without jumping straight to a week. Pure and table-tested; the DST-crossing
 * behaviour itself is `computeGanttKeyboardProposal`'s (zoned `addDays`, wall-time preserving) -
 * this function only sizes the step.
 */
function resolveAdjustLargerStepMinutes(baseStepMinutes: number): number {
  if (baseStepMinutes >= 24 * 60) return 7 * 24 * 60
  return baseStepMinutes < 60 ? 60 : 24 * 60
}

/**
 * Same-node neighbour span, in ms - the minimal shape `overlapsAnyNeighbour`/`clampToNeighbours`
 * need, independent of `GanttOccurrence`'s full shape so a call site can build it from any source.
 */
interface GanttOverlapNeighbour {
  start: number
  end: number
}

/**
 * A node's cardinality overrides the view/settings overlap option: "single" always rejects
 * concurrency, regardless of what the option says. Shared by the pointer gesture engine
 * (`gantt-dnd.tsx`) and the keyboard nudge (`gantt.tsx`'s `nudgeEvent`) so both resolve the SAME
 * effective policy from the SAME two inputs - #219 PR A fix (Sol review, sol1 item 3): before this,
 * `nudgeEvent` had no VIEW-level `scheduleMode` default to fall back to (a store-level API method
 * has no component in its call stack to read `useGanttViewConfig` from), so a node relying on the
 * view default for "single" mode could be nudged past a neighbour that pointer drag would refuse.
 * Callers now pass the effective `viewConfig.scheduleMode` in explicitly.
 */
function resolveOverlapPolicy(
  scheduleMode: GanttScheduleMode,
  overlap: GanttOverlapPolicy
): GanttOverlapPolicy {
  return scheduleMode === "single" ? "reject" : overlap
}

/** True when `proposal` overlaps any same-node neighbour - the "reject" policy's veto. */
function overlapsAnyNeighbour(
  neighbours: GanttOverlapNeighbour[],
  proposal: { start: Date; end: Date }
): boolean {
  const proposalStart = proposal.start.getTime()
  const proposalEnd = proposal.end.getTime()
  return neighbours.some(
    (other) => other.start < proposalEnd && other.end > proposalStart
  )
}

/**
 * Stops a move/resize proposal at the nearest same-node neighbour's edge instead of letting it
 * overlap - the "clamp" policy. Extracted from `gantt-dnd.tsx`'s pointer-only `clampToNeighbours`
 * closure (#219 PR A fix, Sol review, sol1 item 3) so `gantt.tsx`'s keyboard `nudgeEvent` clamps
 * IDENTICALLY instead of ignoring the policy outright, which is what it did before this fix.
 *
 * `anchor` is the occurrence's CURRENT (pre-gesture) span: only a neighbour clear of it can clamp -
 * a pre-existing overlap has no edge to stop at. Runs AFTER the caller's own unit snapping, so the
 * clamp always wins when both apply.
 */
function clampToNeighbours(
  kind: "move" | "resize-start" | "resize-end",
  anchor: { start: Date; end: Date },
  proposal: { start: Date; end: Date },
  neighbours: GanttOverlapNeighbour[],
  overlapPolicy: GanttOverlapPolicy
): { start: Date; end: Date } {
  if (overlapPolicy !== "clamp") return proposal
  const anchorStart = anchor.start.getTime()
  const anchorEnd = anchor.end.getTime()
  let floor = -Infinity
  let ceiling = Infinity
  for (const other of neighbours) {
    if (other.end <= anchorStart) floor = Math.max(floor, other.end)
    else if (other.start >= anchorEnd) ceiling = Math.min(ceiling, other.start)
  }
  if (floor === -Infinity && ceiling === Infinity) return proposal
  let from = proposal.start.getTime()
  let to = proposal.end.getTime()
  if (kind === "resize-start") {
    from = Math.min(Math.max(from, floor), to)
  } else if (kind === "resize-end") {
    to = Math.max(Math.min(to, ceiling), from)
  } else {
    // a move keeps its duration and parks against whichever edge it meets
    const duration = to - from
    if (from < floor) {
      from = floor
      to = from + duration
    }
    if (to > ceiling) {
      to = ceiling
      from = to - duration
    }
    // window narrower than the bar itself: park at the earlier edge
    if (from < floor) {
      from = floor
      to = from + duration
    }
  }
  return { start: new Date(from), end: new Date(to) }
}

/**
 * #219 PR A (Adjust mode) — the WHOLE new key scheme's request shape, from `matchGanttBarKey`.
 * `retarget`'s `target` reuses `GanttNudgeAction` (`gantt.tsx`'s `retargetAdjust`/`beginAdjust`
 * take the identical union); `step`'s `unit` names which of the two step sizes `stepAdjust` should
 * use (`"snap"` = one base nudge step, `"large"` = `resolveAdjustLargerStepMinutes`'s step).
 */
type GanttBarKeyAction =
  | { type: "enter" }
  | { type: "step"; direction: -1 | 1; unit: "snap" | "large" }
  | { type: "retarget"; target: GanttNudgeAction }
  | { type: "commit" }
  | { type: "cancel" }

/**
 * Logical time-axis direction (-1 earlier, +1 later) for an ArrowLeft/Right
 * key, RTL-aware the same way the splitter's key handler in `gantt-view.tsx`
 * (`~:2744`) is: physical ArrowLeft/Right, mirrored by `direction: rtl`.
 */
function ganttArrowDirection(
  key: "ArrowLeft" | "ArrowRight",
  rtl: boolean
): -1 | 1 {
  const physical = key === "ArrowLeft" ? -1 : 1
  return (rtl ? -physical : physical) as -1 | 1
}

/**
 * #219 PR A (Adjust mode) — pure, table-tested replacement for the old `matchGanttBarKeyChord`
 * (Ctrl+Alt+Arrow / Shift+Alt+Arrow / Alt+Arrow; Opus and Sol both rejected those - Ctrl+Alt+Arrow
 * is OS-intercepted on some desktops, Alt+Arrow is browser Back/Forward). `adjusting` selects which
 * table applies: IDLE only recognizes bare Space ("enter" - eligibility, e.g. canMove/isRecurring,
 * is the CALLER's job, same as the old chords); ADJUSTING recognizes bare Escape ("cancel"), bare
 * Enter/Space ("commit"), bare M/S/E ("retarget" - move/resize-start/resize-end respectively), and
 * ArrowLeft/ArrowRight with or without Shift ("step" - Shift is the ONLY modifier a step allows,
 * selecting the larger unit; Alt or Ctrl held at the same time no longer matches ANYTHING, unlike
 * the old chords they used to select). Every branch requires Alt/Ctrl/Meta to be absent - none of
 * the new bindings is a chord, so a browser or OS shortcut sharing the bare key never collides.
 */
function matchGanttBarKey(
  e: {
    key: string
    altKey: boolean
    shiftKey: boolean
    ctrlKey: boolean
    metaKey: boolean
  },
  adjusting: boolean,
  rtl: boolean
): GanttBarKeyAction | null {
  const noChordModifiers = !e.altKey && !e.ctrlKey && !e.metaKey
  if (!noChordModifiers) return null

  if (!adjusting) {
    if (!e.shiftKey && (e.key === " " || e.key === "Spacebar")) {
      return { type: "enter" }
    }
    return null
  }

  if (!e.shiftKey && e.key === "Escape") return { type: "cancel" }
  if (!e.shiftKey && (e.key === "Enter" || e.key === " " || e.key === "Spacebar")) {
    return { type: "commit" }
  }
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    return {
      type: "step",
      direction: ganttArrowDirection(e.key, rtl),
      unit: e.shiftKey ? "large" : "snap",
    }
  }
  if (e.shiftKey) return null
  const lower = e.key.toLowerCase()
  if (lower === "m") return { type: "retarget", target: "move" }
  if (lower === "s") return { type: "retarget", target: "resize-start" }
  if (lower === "e") return { type: "retarget", target: "resize-end" }
  return null
}

/**
 * #219 PR A fix (Sol re-review round 2, HIGH #4) — the page-wide in-flight-gesture registry,
 * relocated here (was `gantt-dnd.tsx`'s module-level `activeGestureCancels`, still exported as
 * `cancelActiveGanttGestures` from there unchanged) so `gantt.tsx`'s `beginAdjust` can check it
 * too: a pointer gesture is registered here from `beginGesture`'s very first line (BEFORE
 * activation - a "pending" gesture that has only moved less than the activation threshold is
 * still registered) until its `cleanup()`, so `isGanttGestureInFlight()` is true for the gesture's
 * ENTIRE lifetime, pending or active. `gantt.tsx` cannot depend on `gantt-dnd.tsx` directly (that
 * file already imports `useGantt`/`GanttInstance` FROM `gantt.tsx` - the reverse would cycle),
 * which is the same reason `computeGanttKeyboardProposal`/`isResizableEdge`/`matchGanttBarKey`
 * above live here rather than in either of those two files. Global (not per-`<Gantt>`-instance) on
 * purpose, same as `cancelActiveGanttGestures` always was: a pointer gesture on ANY gantt bar on
 * the page blocks Space starting a NEW keyboard session on any OTHER gantt bar too, exactly as
 * conservative as the existing "cancel every in-flight gesture on view unmount" behavior.
 */
const activeGanttGestureCancels = new Set<() => void>()

/** Registers one in-flight gesture's cancel callback - called once, at `beginGesture`'s start. */
function registerGanttGesture(cancel: () => void): void {
  activeGanttGestureCancels.add(cancel)
}

/** Deregisters one gesture - called once, from that SAME gesture's own `cleanup()`. */
function unregisterGanttGesture(cancel: () => void): void {
  activeGanttGestureCancels.delete(cancel)
}

/** True while ANY gantt pointer gesture, anywhere on the page, is pending or active. */
function isGanttGestureInFlight(): boolean {
  return activeGanttGestureCancels.size > 0
}

/** Cancel (and fully revert) every in-flight gantt pointer gesture. */
function cancelActiveGanttGestures(): void {
  for (const cancel of [...activeGanttGestureCancels]) cancel()
}

export {
  buildDependencyPath,
  buildEventIndex,
  cancelActiveGanttGestures,
  clampToNeighbours,
  computeGanttKeyboardProposal,
  defaultEventOrder,
  eventsOverlap,
  findResource,
  flattenResources,
  ganttArrowDirection,
  getBaselineVariance,
  getDayKey,
  getDayTotalMinutes,
  getGanttDateRange,
  getLaneKey,
  getRangeKey,
  isGanttGestureInFlight,
  isResizableEdge,
  matchGanttBarKey,
  MIN_PACK_SLOT,
  occurrenceIntersects,
  overlapsAnyNeighbour,
  packTimedSegments,
  rangesIntersect,
  registerGanttGesture,
  reorderResources,
  resolveAdjustLargerStepMinutes,
  resolveEventBaseline,
  resolveOffDay,
  resolveOverlapPolicy,
  snapMinutes,
  spansMultipleDays,
  stepGanttDate,
  toZoned,
  unregisterGanttGesture,
  zonedStartOfDay,
}
export type {
  BuildIndexOptions,
  GanttBarKeyAction,
  GanttDependencyGeometry,
  GanttIndex,
  GanttKeyboardProposal,
  GanttLaneMemo,
  GanttOverlapNeighbour,
  PackOptions,
  ViewDateRanges,
  ViewRangeOptions,
  WeekStartsOn,
}
