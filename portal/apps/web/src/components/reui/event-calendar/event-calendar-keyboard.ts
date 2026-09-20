/**
 * #240 — the event-calendar's keyboard movement model. QUINCY-AUTHORED; not part of
 * `@reui/event-calendar`. Upstream declares `source: "keyboard"` on its proposed-update type and
 * never emits it; this file and the Adjust session in `event-calendar-dnd.tsx` are what does.
 *
 * It lives inside the vendored directory for ADR 0009's reason (a re-vendor must trip over it)
 * but is split the way ADR 0010 split external drop: everything here is PURE — a key matcher and
 * a proposal calculator, no DOM, no store, no private binding — so it is its own file with its
 * own tests. The half that needs private access (the module's gesture-cancel registry, the
 * announcer lookup, `internals.setDrag`) is `beginKeyboardAdjust` in `event-calendar-dnd.tsx`.
 *
 * THE GRAMMAR is the Gantt's (ADR 0009, `matchGanttBarKey`), by owner decision, so the two
 * scheduling surfaces teach one scheme: Space enters; Arrows step; M / S / E retarget to move /
 * start edge / end edge; Enter or Space commits; Escape cancels. Chords were rejected there for
 * reasons that hold here: Alt+Arrow is browser Back/Forward, Ctrl+Alt+Arrow is OS-owned.
 *
 * WHAT AN ARROW MEANS depends on the geometry the chip sits in — this calendar has four, where
 * the Gantt had one axis:
 *
 *   month     across = +/-1 day, down = +/-1 week, Home/End = ends of the week row,
 *             PageUp/PageDown = +/-1 month. An edge resizes across only.
 *   time      down = +/-snapDuration of ELAPSED time (Shift: one hour), across = the same CLOCK
 *             time on the neighbouring day, Home/End = the day's bounds. An edge resizes down only.
 *   day-bar   the time grid's all-day row, and any bar in it: across = +/-1 day, nothing down.
 *   resource  down as `time`; across = the neighbouring RESOURCE. The day never changes.
 *
 * The agenda is not a geometry: its rows are read-only by the vendor's own design.
 *
 * Two units, again (see `docs/lessons.md`, #219 and #241). A vertical step is elapsed time so
 * every instant is reachable — including the repeated hour's second pass, which #241 made
 * unreachable by pointer. A horizontal step is a CLOCK-time move, so Saturday 09:00 -> Sunday
 * 09:00 is 25 real hours across Sydney's autumn transition, not 24.
 */
import {
  elapsedMinutesAtWallClock,
  elapsedMinutesAtWallClockHour,
  toZoned,
  wallClockMinutesAtElapsed,
  zonedStartOfDay,
} from "@/components/reui/event-calendar/event-calendar-lib"
import {
  addDays,
  addMinutes,
  addMonths,
  differenceInCalendarDays,
  differenceInMinutes,
} from "date-fns"

type AdjustTarget = "move" | "start" | "end"
type AdjustGeometry = "month" | "time" | "day-bar" | "resource"

type AdjustMotion =
  | { type: "step"; axis: "x" | "y"; dir: -1 | 1; large: boolean }
  /** Home / End. */
  | { type: "edge"; dir: -1 | 1 }
  /** PageUp / PageDown. */
  | { type: "page"; dir: -1 | 1 }

type AdjustKeyAction =
  | AdjustMotion
  | { type: "enter" }
  | { type: "retarget"; target: AdjustTarget }
  | { type: "commit" }
  | { type: "cancel" }
  /** Tab: focus is leaving; the session ends, the key is NOT consumed. */
  | { type: "leave" }
  /** A held Space / Enter: consumed so the chip does not click, and otherwise ignored. */
  | { type: "swallow" }

interface AdjustKeyEvent {
  key: string
  repeat: boolean
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

/**
 * The whole grammar in one place. `null` means "not ours — do not preventDefault": an idle chip
 * keeps Enter as its native activate, and no Alt/Ctrl/Meta chord is ever claimed.
 */
function matchAdjustKey(
  e: AdjustKeyEvent,
  adjusting: boolean,
  rtl: boolean
): AdjustKeyAction | null {
  if (e.altKey || e.ctrlKey || e.metaKey) return null
  if (!adjusting) return e.key === " " && !e.repeat ? { type: "enter" } : null
  // a decision is made once per press; only motion auto-repeats
  if (e.repeat && (e.key === " " || e.key === "Enter")) return { type: "swallow" }
  const across = rtl ? -1 : 1
  switch (e.key) {
    case "ArrowUp":
      return { type: "step", axis: "y", dir: -1, large: e.shiftKey }
    case "ArrowDown":
      return { type: "step", axis: "y", dir: 1, large: e.shiftKey }
    case "ArrowLeft":
      return { type: "step", axis: "x", dir: -across as -1 | 1, large: e.shiftKey }
    case "ArrowRight":
      return { type: "step", axis: "x", dir: across as -1 | 1, large: e.shiftKey }
    case "Home":
      return { type: "edge", dir: -1 }
    case "End":
      return { type: "edge", dir: 1 }
    case "PageUp":
      return { type: "page", dir: -1 }
    case "PageDown":
      return { type: "page", dir: 1 }
    case "Enter":
    case " ":
      return { type: "commit" }
    case "Escape":
      return { type: "cancel" }
    case "Tab":
      return { type: "leave" }
  }
  switch (e.key.toLowerCase()) {
    case "m":
      return { type: "retarget", target: "move" }
    case "s":
      return { type: "retarget", target: "start" }
    case "e":
      return { type: "retarget", target: "end" }
  }
  return null
}

interface AdjustWindow {
  start: Date
  end: Date
  allDay: boolean
  resourceId?: string
}

interface AdjustContext {
  geometry: AdjustGeometry
  target: AdjustTarget
  timeZone: string
  /** Minutes; the small vertical step and the minimum timed duration. */
  snapDuration: number
  /** The time grid's wall-clock day bounds (`dayStartHour` / `dayEndHour`). */
  startHour: number
  endHour: number
  weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6
  /** Leaf resources in column order; the resource geometry's horizontal axis. */
  resourceIds: string[]
}

/**
 * Why a motion produced no proposal. `axis`: that key means nothing for this target in this
 * geometry. `bounds`: it would leave the day's bounds or the resource list. `min-duration`: it
 * would shrink the event below one snap / one day.
 */
type AdjustRefusal = "axis" | "bounds" | "min-duration"

type AdjustProposal =
  | { ok: true; window: AdjustWindow }
  | { ok: false; reason: AdjustRefusal }

const refuse = (reason: AdjustRefusal): AdjustProposal => ({ ok: false, reason })

/** `date` shifted by whole days at the same CLOCK time in `timeZone`. */
function shiftDays(date: Date, days: number, timeZone: string): Date {
  const day = zonedStartOfDay(date, timeZone)
  const wall = wallClockMinutesAtElapsed(day, differenceInMinutes(date, day), timeZone)
  const target = zonedStartOfDay(addDays(toZoned(day, timeZone), days), timeZone)
  // a clock time the target day skips resolves to the instant its gap closes (#241)
  return addMinutes(target, elapsedMinutesAtWallClock(target, wall, timeZone))
}

/** The zoned day an event's END belongs to: `end` is exclusive, so step back an instant. */
function lastCoveredDay(w: AdjustWindow, timeZone: string): Date {
  return zonedStartOfDay(
    new Date(Math.max(w.end.getTime() - 1, w.start.getTime())),
    timeZone
  )
}

function dayGranular(
  w: AdjustWindow,
  motion: AdjustMotion,
  ctx: AdjustContext
): AdjustProposal {
  const { timeZone, target } = ctx
  let days: number
  if (motion.type === "step") {
    if (motion.axis === "x") days = motion.dir
    else if (ctx.geometry === "month" && target === "move") days = motion.dir * 7
    else return refuse("axis")
  } else if (motion.type === "page") {
    if (ctx.geometry !== "month" || target !== "move") return refuse("axis")
    const zoned = toZoned(w.start, timeZone)
    days = differenceInCalendarDays(addMonths(zoned, motion.dir), zoned)
  } else {
    // Home / End: the ends of the week row the moving edge currently sits in. Only the month
    // grid HAS week rows: an all-day row may be a day view's single column, and a resource
    // view's day never changes.
    if (ctx.geometry !== "month") return refuse("axis")
    const anchor =
      target === "end" || (target === "move" && motion.dir === 1)
        ? lastCoveredDay(w, timeZone)
        : zonedStartOfDay(w.start, timeZone)
    const weekday = toZoned(anchor, timeZone).getDay()
    const fromRowStart = (weekday - ctx.weekStartsOn + 7) % 7
    days = motion.dir === -1 ? -fromRowStart : 6 - fromRowStart
  }

  const start = target === "end" ? w.start : shiftDays(w.start, days, timeZone)
  const end = target === "start" ? w.end : shiftDays(w.end, days, timeZone)
  const next = { ...w, start, end }
  if (
    target !== "move" &&
    (end <= start ||
      lastCoveredDay(next, timeZone) < zonedStartOfDay(start, timeZone))
  ) {
    return refuse("min-duration")
  }
  return { ok: true, window: next }
}

function timed(
  w: AdjustWindow,
  motion: AdjustMotion,
  ctx: AdjustContext
): AdjustProposal {
  const { timeZone, target, snapDuration } = ctx
  if (motion.type === "page") return refuse("axis")

  if (motion.type === "step" && motion.axis === "x") {
    if (target !== "move") return refuse("axis")
    if (ctx.geometry === "resource") {
      const at = ctx.resourceIds.indexOf(w.resourceId ?? "")
      const next = ctx.resourceIds[at + motion.dir]
      if (at === -1 || next === undefined) return refuse("bounds")
      return { ok: true, window: { ...w, resourceId: next } }
    }
    const start = shiftDays(w.start, motion.dir, timeZone)
    const durationMs = w.end.getTime() - w.start.getTime()
    return {
      ok: true,
      window: { ...w, start, end: new Date(start.getTime() + durationMs) },
    }
  }

  // Vertical: everything below is ELAPSED time against the bounds of the edge's own day.
  const day = zonedStartOfDay(
    target === "end" ? lastCoveredDay(w, timeZone) : w.start,
    timeZone
  )
  const boundStart = addMinutes(
    day,
    elapsedMinutesAtWallClockHour(day, ctx.startHour, timeZone)
  )
  const boundEnd = addMinutes(
    day,
    elapsedMinutesAtWallClockHour(day, ctx.endHour, timeZone)
  )
  const durationMs = w.end.getTime() - w.start.getTime()
  const snapMs = snapDuration * 60_000

  let start = w.start
  let end = w.end
  if (motion.type === "step") {
    const deltaMs = motion.dir * (motion.large ? 60 : snapDuration) * 60_000
    if (target !== "end") start = new Date(start.getTime() + deltaMs)
    if (target !== "start") end = new Date(end.getTime() + deltaMs)
  } else if (target === "move") {
    start = motion.dir === -1 ? boundStart : new Date(boundEnd.getTime() - durationMs)
    end = new Date(start.getTime() + durationMs)
  } else if (target === "start") {
    start = motion.dir === -1 ? boundStart : new Date(end.getTime() - snapMs)
  } else {
    end = motion.dir === 1 ? boundEnd : new Date(start.getTime() + snapMs)
  }

  if (end.getTime() - start.getTime() < snapMs) return refuse("min-duration")
  if (target !== "end" && (start < boundStart || start >= boundEnd)) {
    return refuse("bounds")
  }
  // An end already past the bound (a cross-midnight block) keeps its tail: holding it in would
  // refuse every step. An end that is INSIDE is held inside, so no step pushes it over.
  if (target !== "start" && w.end <= boundEnd) {
    if (end > boundEnd || end <= boundStart) return refuse("bounds")
  }
  return { ok: true, window: { ...w, start, end } }
}

/**
 * The window one motion proposes from `current`, or why it proposes none. Never validates against
 * the consumer (`canDropEvent`) and never commits: the session does both.
 */
function computeKeyboardProposal(
  current: AdjustWindow,
  motion: AdjustMotion,
  ctx: AdjustContext
): AdjustProposal {
  const granular =
    ctx.geometry === "month" ||
    ctx.geometry === "day-bar" ||
    // an all-day booking in the resource view has no vertical extent either
    (ctx.geometry === "resource" &&
      current.allDay &&
      !(motion.type === "step" && motion.axis === "x"))
  return granular ? dayGranular(current, motion, ctx) : timed(current, motion, ctx)
}

export { computeKeyboardProposal, matchAdjustKey }
export type {
  AdjustContext,
  AdjustGeometry,
  AdjustKeyAction,
  AdjustMotion,
  AdjustProposal,
  AdjustRefusal,
  AdjustTarget,
  AdjustWindow,
}
