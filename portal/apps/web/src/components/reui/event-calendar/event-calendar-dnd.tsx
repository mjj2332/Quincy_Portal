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
 * THIS FILE: the pointer gesture engine — drag, resize and drag-create, the surface/column/cell hit-testing they share, the floating carry clone and the refusal hint.
 *
 *   - Hand-rolled pointer events throughout: there is NO dnd-kit here, so none of the dnd-kit
 *     cautions recorded for `reui/kanban.tsx` (`MeasuringStrategy.Always`,
 *     `docs/reui-block-adoption.md` trap 3) transfer to this file. Do not import that remedy by
 *     analogy.
 *   - Gesture cancellation is MODULE-LEVEL singleton state (`activeGestureCancels`), not per
 *     instance. Anything that starts a gesture must register with it, or the gesture can outlive
 *     the calendar that owns it and strand a window listener. This is the main reason #219 PR B's
 *     external-drag adapter lives inside this tree rather than beside it — see ADR 0010.
 *   - `computeProposal` is a CLOSURE inside `beginGesture`, not a module-level function, so it
 *     cannot be called or reused from outside even in principle.
 *
 * Quincy edits since vendoring:
 *
 * 1. 2026-09-21, #219 PR B, stage 3 — ADDED `canResizeEdge(segment, edge)` and enforced it in
 *    `beginResize`, backing `CalendarEvent.resizableEdges`. `canResize` keeps its original
 *    meaning and signature so the public gestures object is unchanged; `canResizeEdge` is an
 *    additional key on it. A locked edge is refused at the gesture entry, not merely ungripped,
 *    so calling `gestures.beginResize` directly cannot bypass the lock — and the refusal still
 *    broadcasts through `onDragBlocked` like any other. Cover:
 *    `event-calendar-resize-edges.dom.test.tsx`, which fails on 4 of its 8 cases if the per-edge
 *    check is removed.
 *
 * 2. 2026-09-21, #219 PR B, stage 3 — ADDED the external-drop adapter (its own banner comment
 *    below the gesture engine). Pure addition; nothing inside `beginGesture` was touched.
 *
 * 3. 2026-09-21, #219 PR B, stage 4 — both cursor-following overlays lost their drop shadows.
 *    The carry clone traded `shadow-md` for `border border-border` (it had NO border, so the
 *    hairline had to be added, and it has to be `border-border` rather than a bare `border`);
 *    the refusal hint dropped `shadow-sm` and kept the `border-destructive/40` it already had,
 *    and its `rounded-md` came to `rounded-sm`. Quincy's elevation is a hairline, not a shadow.
 *    Note these are string constants CONCATENATED with the consumer's `ui?.dragCarry` /
 *    `dropHint` with no `cn()` / tailwind-merge in the path, so a consumer's `shadow-none` would
 *    only win by CSS source order — which is not a guarantee. This one genuinely had to be fixed
 *    in place; a wrapper could not have done it.
 */
import { useCallback, useEffect, useMemo } from "react"
import {
  useEventCalendar,
  useEventCalendarViewConfig,
  type EventCalendarInstance,
} from "@/components/reui/event-calendar/event-calendar"
import {
  snapMinutes,
  toZoned,
  zonedStartOfDay,
} from "@/components/reui/event-calendar/event-calendar-lib"
import type {
  CalendarView,
  EventCalendarProposedUpdate,
  EventCalendarSegment,
} from "@/components/reui/event-calendar/event-calendar-types"
import { addDays, addMinutes, differenceInCalendarDays } from "date-fns"

/**
 * Activation policy (dnd-kit parity where proven):
 * mouse move 5px before a drag starts (below = click), create 4px;
 * touch long-press 250ms with 5px tolerance (movement past tolerance
 * before the delay cancels the drag so taps stay taps).
 */
const EVENT_CALENDAR_ACTIVATION = {
  moveDistancePx: 5,
  createDistancePx: 4,
  touchDelayMs: 250,
  touchTolerancePx: 5,
  autoScrollEdgePx: 48,
  autoScrollMaxStepPx: 15,
} as const

type GestureKind = "move" | "resize-start" | "resize-end" | "create"

interface TimeColumnRect {
  day: Date
  rect: DOMRect
  boundsStartMin: number
  boundsEndMin: number
  resourceId?: string
}

interface DayCellRect {
  day: Date
  rect: DOMRect
}

interface Surface {
  /** Minute-precise day columns (week/day/days) or resource columns. */
  columns: TimeColumnRect[]
  /** Day-precise cells (month grid, all-day row). */
  cells: DayCellRect[]
  viewport: HTMLElement | null
  /**
   * Viewport rect captured ONCE at gesture start. The scroll container does
   * not move on screen while a pointer drag is captured (auto-scroll changes
   * its scrollTop, not its box), so reusing this avoids a per-pointermove
   * getBoundingClientRect - that read forces a synchronous full-document
   * reflow, which is cheap on a bare demo page but ~200ms on a long docs page
   * (big prop tables re-lay-out on every flush), turning drag into a slideshow.
   */
  viewportRect: DOMRect | null
  viewportStartScrollTop: number
  /**
   * Live scrollTop, seeded from the start value and advanced by auto-scroll
   * itself. Tracking it here lets pointerMinutes read a number instead of the
   * DOM `scrollTop` property every move (another forced reflow).
   */
  scrollTop: number
}

/** Module flag so chip onClick can ignore the click that ends a drag. */
let lastGestureEndedAt = 0
function wasRecentDrag(): boolean {
  return performance.now() - lastGestureEndedAt < 250
}

/**
 * A press that started on an event chip. Slot-create clicks consult this so a
 * refused drag (e.g. a locked chip that never registers a gesture) whose
 * trailing native click retargets to the empty grid does NOT open a create
 * dialog. Refreshed on release so it covers long presses; the chip's own
 * click-to-edit is unaffected (only grid slot-clicks check it).
 */
let lastChipPressAt = 0
function markChipPress(): void {
  lastChipPressAt = performance.now()
  window.addEventListener(
    "pointerup",
    () => {
      lastChipPressAt = performance.now()
    },
    { once: true, capture: true }
  )
}
function wasRecentChipPress(): boolean {
  return performance.now() - lastChipPressAt < 300
}

/**
 * Registry of in-flight gesture cancels. A gesture measures its surface (day
 * columns and cells) once at activation and then lives on window listeners, so
 * the CALENDAR - not the chip, chips legitimately unmount mid-gesture (lane
 * repacking, a "+N more" popover closing) - is what must be able to abort it.
 * Cancel fully reverts: listeners, overlays and the body drag state all clear,
 * and no update is committed.
 */
const activeGestureCancels = new Set<() => void>()

/** Cancel (and fully revert) every in-flight event calendar pointer gesture. */
function cancelActiveEventCalendarGestures(): void {
  for (const cancel of [...activeGestureCancels]) cancel()
}

/**
 * Mounted-consumer count for the gestures hook. Every chip holds one, so only
 * the LAST consumer leaving means the calendar itself is gone; aborting when
 * any single chip unmounts would kill a drag the user is still holding.
 */
let gestureConsumers = 0

/**
 * Snap a translate offset to the device pixel grid. The cursor-following
 * overlays (carry clone, drop hint) are their own `will-change: transform`
 * compositing layers: the GPU rasterizes their text once and repositions that
 * texture each frame, so a subpixel translate (getBoundingClientRect and raw
 * clientX/Y are routinely fractional) resamples the texture and blurs the
 * text. Rounding each offset to a whole device pixel lands the layer on the
 * grid so glyphs stay crisp, without giving up the per-frame GPU transform.
 */
function snapToPixel(value: number): number {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1
  return Math.round(value * dpr) / dpr
}

function collectSurface(
  origin: HTMLElement,
  fallbackRoot?: HTMLElement | null
): Surface {
  // A gesture from a portaled surface (the "+N more" popover) has no calendar
  // ancestor, so fall back to the root the host registered on the instance.
  const root =
    origin.closest<HTMLElement>("[data-slot=event-calendar-time-grid]") ??
    origin.closest<HTMLElement>("[data-slot=event-calendar-resource-view]") ??
    origin.closest<HTMLElement>("[data-slot=event-calendar-month-view]") ??
    origin.closest<HTMLElement>("[data-slot=event-calendar]") ??
    fallbackRoot ??
    null

  const columns: TimeColumnRect[] = []
  const cells: DayCellRect[] = []
  if (root) {
    for (const el of root.querySelectorAll<HTMLElement>("[data-ec-day]")) {
      const day = new Date(Number(el.dataset.ecDay))
      if (el.dataset.ecBoundsStart !== undefined) {
        columns.push({
          day,
          rect: el.getBoundingClientRect(),
          boundsStartMin: Number(el.dataset.ecBoundsStart),
          boundsEndMin: Number(el.dataset.ecBoundsEnd),
          resourceId: el.dataset.ecResource,
        })
      } else {
        cells.push({ day, rect: el.getBoundingClientRect() })
      }
    }
  }
  const viewport =
    root?.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]") ?? null
  const viewportStartScrollTop = viewport?.scrollTop ?? 0
  return {
    columns,
    cells,
    viewport,
    viewportRect: viewport?.getBoundingClientRect() ?? null,
    viewportStartScrollTop,
    scrollTop: viewportStartScrollTop,
  }
}

function findColumn(
  surface: Surface,
  clientX: number
): TimeColumnRect | undefined {
  const scrollAdjusted = surface.columns
  let best: TimeColumnRect | undefined
  for (const col of scrollAdjusted) {
    if (clientX >= col.rect.left && clientX < col.rect.right) return col
    if (!best) best = col
    // clamp to nearest horizontal column
    const bestDist = Math.min(
      Math.abs(clientX - best.rect.left),
      Math.abs(clientX - best.rect.right)
    )
    const dist = Math.min(
      Math.abs(clientX - col.rect.left),
      Math.abs(clientX - col.rect.right)
    )
    if (dist < bestDist) best = col
  }
  return best
}

function findCell(
  surface: Surface,
  x: number,
  y: number
): DayCellRect | undefined {
  return surface.cells.find(
    (cell) =>
      x >= cell.rect.left &&
      x < cell.rect.right &&
      y >= cell.rect.top &&
      y < cell.rect.bottom
  )
}

function pointerMinutes(
  surface: Surface,
  col: TimeColumnRect,
  clientY: number
): number {
  const scrollDelta = surface.scrollTop - surface.viewportStartScrollTop
  const boundsMinutes = col.boundsEndMin - col.boundsStartMin
  const pxPerMinute = col.rect.height / Math.max(1, boundsMinutes)
  const y = clientY - col.rect.top + scrollDelta
  return col.boundsStartMin + y / pxPerMinute
}

interface BeginGestureConfig<TData> {
  instance: EventCalendarInstance<TData>
  kind: GestureKind
  origin: HTMLElement
  startEvent: PointerEvent
  segment?: EventCalendarSegment<TData>
  /** create only */
  createDay?: Date
  createAllDay?: boolean
  /**
   * Consumer classNames for the engine's vanilla-DOM overlays (carry clone,
   * validation hint pill), forwarded by the gestures hook - the engine itself
   * must never import from the React chip module.
   */
  ui?: {
    dragCarry?: string
    dragCarryInvalid?: string
    dropHint?: string
  }
}

/**
 * A move/resize was refused (locked, per-event disabled, or interaction off).
 * Rather than silently swallow the press, track the pointer: once it crosses
 * the activation threshold - i.e. the user genuinely tried to drag - show a
 * not-allowed cursor and broadcast once via onDragBlocked so the consumer can
 * explain it. The calendar picks no message. Fires at most once per gesture.
 */
function beginBlockedGesture<TData>(
  instance: EventCalendarInstance<TData>,
  startEvent: PointerEvent,
  segment: EventCalendarSegment<TData>,
  gesture: "move" | "resize"
) {
  const startX = startEvent.clientX
  const startY = startEvent.clientY
  const activation = {
    ...EVENT_CALENDAR_ACTIVATION,
    ...instance.settings.activation,
  }
  const event = segment.occurrence.event
  const reason: "readOnly" | "disabled" | "interactions-off" = event.readOnly
    ? "readOnly"
    : (gesture === "move" ? event.draggable : event.resizable) === false
      ? "disabled"
      : "interactions-off"
  const pointerId = startEvent.pointerId
  let activated = false
  let finished = false
  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== pointerId || activated) return
    if (
      Math.hypot(e.clientX - startX, e.clientY - startY) <
      activation.moveDistancePx
    ) {
      return
    }
    activated = true
    document.body.style.cursor = "not-allowed"
    // body class alongside the inline cursor so consumer CSS can restyle or
    // detect the blocked-drag state (mirrors "ec-dragging")
    document.body.classList.add("ec-drag-blocked")
    // only now is there anything to get stuck: focus loss means the release
    // may never be delivered, leaving the cursor not-allowed document-wide
    window.addEventListener("blur", cleanup)
    instance.settings.onDragBlocked?.(segment.occurrence, { gesture, reason })
  }
  const cleanup = () => {
    if (finished) return
    finished = true
    window.removeEventListener("pointermove", onMove)
    window.removeEventListener("pointerup", onRelease)
    window.removeEventListener("pointercancel", onRelease)
    window.removeEventListener("blur", cleanup)
    if (activated) {
      document.body.style.cursor = ""
      document.body.classList.remove("ec-drag-blocked")
      // the pointer travelled: suppress the trailing click so the event's own
      // dialog does not open on top of the rejection message
      lastGestureEndedAt = performance.now()
    }
  }
  // only the pointer that started the press may end it: a second finger
  // lifting must not clear the not-allowed cursor out from under it
  const onRelease = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return
    cleanup()
  }
  window.addEventListener("pointermove", onMove)
  window.addEventListener("pointerup", onRelease)
  window.addEventListener("pointercancel", onRelease)
}

function beginGesture<TData>(config: BeginGestureConfig<TData>) {
  const { instance, kind, origin, startEvent, segment, ui } = config
  const { settings, internals, api } = instance
  const timeZone = settings.timeZone
  const snap = settings.snapDuration
  // per-calendar tuning shallow-merged over the module defaults
  const activation = { ...EVENT_CALENDAR_ACTIVATION, ...settings.activation }
  const startX = startEvent.clientX
  const startY = startEvent.clientY
  const pointerId = startEvent.pointerId
  // Resolved once: the chip can be re-rendered away mid-gesture. A gesture
  // from a portaled surface (the "+N more" popover) has no calendar ancestor,
  // so fall back to the registered root - same reason as collectSurface.
  const announcer =
    origin
      .closest<HTMLElement>("[data-slot=event-calendar]")
      ?.querySelector<HTMLElement>("[data-slot=event-calendar-announcer]") ??
    internals
      .getRootEl()
      ?.querySelector<HTMLElement>("[data-slot=event-calendar-announcer]") ??
    null

  const isTouch = startEvent.pointerType === "touch"
  // resize activates immediately on precise pointers; on touch it waits for
  // the same long-press as a move, so a finger landing on the (invisible on
  // touch) handle strip can never start a resize the user never asked for
  let active = kind.startsWith("resize") && !isTouch
  let surface: Surface | null = active
    ? collectSurface(origin, internals.getRootEl())
    : null
  let rafScroll: number | null = null
  let lastProposalKey = ""
  let touchTimer: ReturnType<typeof setTimeout> | null = null
  let hintEl: HTMLDivElement | null = null
  let lastValid = true
  // Drag-create anchor minute, frozen at the first proposal: re-deriving it
  // from the stale startY client coordinate + the CURRENT scroll delta would
  // make the anchor drift with auto-scroll instead of staying pinned.
  let createAnchorMin: number | null = null
  let lastPointer: PointerEvent = startEvent

  const occurrence = segment?.occurrence
  const isBar = occurrence
    ? occurrence.allDay ||
      occurrence.end.getTime() - occurrence.start.getTime() >
        24 * 60 * 60 * 1000
    : false

  // Preserve the grab offset so the event does not jump to the pointer
  let grabOffsetMin = 0
  /**
   * The grabbed CHIP, not the whole occurrence. A cross-midnight event renders
   * one chip per day, so the offset above is measured in the grabbed chip's own
   * day frame (mixing the two frames jumps a tail chip a full day on grab) and
   * these two carry that chip back to the occurrence. For a chip that fits in
   * one day the lead is 0 and the duration is the occurrence's, i.e. unchanged.
   */
  let grabLeadMs = 0
  let grabSegDurationMs = occurrence
    ? occurrence.end.getTime() - occurrence.start.getTime()
    : 0
  /**
   * Which day of a multi-day bar was grabbed. Without it the day-granular move
   * slides the bar's START under the pointer, so a Mon-Fri bar grabbed on
   * Wednesday teleports two days forward on the first nudge.
   */
  let grabDayOffset = 0

  const activationDistance =
    kind === "create" ? activation.createDistancePx : activation.moveDistancePx

  // Each gesture keeps its own cursor: a resize must stay ns/ew-resize for
  // the whole drag (flipping to grabbing reads as a move) - vertical for
  // timed blocks, horizontal for day-granular bars. Moves grab.
  const gestureCursor = kind.startsWith("resize")
    ? isBar
      ? "ew-resize"
      : "ns-resize"
    : "grabbing"
  const setBodyDragging = (on: boolean, invalid = false) => {
    document.body.classList.toggle("ec-dragging", on)
    document.body.style.cursor = on
      ? invalid
        ? "not-allowed"
        : gestureCursor
      : ""
    document.body.style.userSelect = on ? "none" : ""
    if (!on) document.body.style.removeProperty("-webkit-user-select")
  }

  const activate = () => {
    if (active) return
    active = true
    // armed with the gesture, not with the press: a press that never activates
    // holds no drag state, no overlay and no body class to strand
    window.addEventListener("blur", onWindowBlur)
    surface = collectSurface(origin, internals.getRootEl())
    if (kind === "move" && occurrence) {
      const grabCell = findCell(surface, startX, startY)
      if (grabCell) {
        const originDay = zonedStartOfDay(occurrence.start, timeZone)
        // end is exclusive, so step back an instant for the last covered day
        const lastDay = zonedStartOfDay(
          new Date(
            Math.max(occurrence.end.getTime() - 1, occurrence.start.getTime())
          ),
          timeZone
        )
        const offset = differenceInCalendarDays(
          zonedStartOfDay(grabCell.day, timeZone),
          originDay
        )
        // A gesture from the "+N more" popover grabs over whatever cell that
        // floating surface happens to cover, so only a day the event actually
        // spans can be the grabbed day.
        if (
          offset >= 0 &&
          offset <= differenceInCalendarDays(lastDay, originDay)
        ) {
          grabDayOffset = offset
        }
      }
      if (surface.columns.length > 0 && !isBar) {
        const col = findColumn(surface, startX)
        if (col) {
          const colDayStart = zonedStartOfDay(col.day, timeZone)
          const segStartMs = Math.max(
            occurrence.start.getTime(),
            colDayStart.getTime()
          )
          grabLeadMs = segStartMs - occurrence.start.getTime()
          grabSegDurationMs =
            Math.min(
              occurrence.end.getTime(),
              addDays(colDayStart, 1).getTime()
            ) - segStartMs
          grabOffsetMin =
            pointerMinutes(surface, col, startY) -
            (segStartMs - colDayStart.getTime()) / 60000
        }
      }
    }
    setBodyDragging(true)
    createCarry()
  }

  const computeProposal = (
    e: PointerEvent
  ): {
    start: Date
    end: Date
    allDay: boolean
    dayGranular?: boolean
    resourceId?: string
  } | null => {
    if (!surface) return null

    // ---- create: select a slot range
    if (kind === "create") {
      if (config.createAllDay || surface.columns.length === 0) {
        const anchor = zonedStartOfDay(config.createDay!, timeZone)
        const cell = findCell(surface, e.clientX, e.clientY)
        const target = cell ? zonedStartOfDay(cell.day, timeZone) : anchor
        const start = anchor <= target ? anchor : target
        const end = addDays(anchor <= target ? target : anchor, 1)
        return { start, end, allDay: true, dayGranular: true }
      }
      const col = findColumn(surface, startX)
      if (!col) return null
      if (createAnchorMin === null) {
        createAnchorMin = snapMinutes(
          pointerMinutes(surface, col, startY),
          snap
        )
      }
      const anchorMin = createAnchorMin
      const curMin = snapMinutes(pointerMinutes(surface, col, e.clientY), snap)
      const lo = Math.max(col.boundsStartMin, Math.min(anchorMin, curMin))
      const hi = Math.min(
        col.boundsEndMin,
        Math.max(anchorMin, curMin, lo + snap)
      )
      const dayStart = zonedStartOfDay(col.day, timeZone)
      return {
        start: addMinutes(dayStart, lo),
        end: addMinutes(dayStart, hi),
        allDay: false,
        resourceId: col.resourceId,
      }
    }

    if (!occurrence) return null
    const durationMs = occurrence.end.getTime() - occurrence.start.getTime()

    // ---- day-granularity: month cells and bars in the all-day row
    const overCell = findCell(surface, e.clientX, e.clientY)

    // A timed event dropped on the all-day lane (a day cell inside a surface
    // that also has time columns) converts to a full-day event on that day.
    if (
      kind === "move" &&
      !isBar &&
      surface.columns.length > 0 &&
      overCell !== undefined
    ) {
      const targetDay = zonedStartOfDay(overCell.day, timeZone)
      return {
        start: targetDay,
        end: addDays(targetDay, 1),
        allDay: true,
        dayGranular: true,
      }
    }

    const useCells =
      surface.columns.length === 0 || (isBar && overCell !== undefined)

    if (useCells) {
      const cell = overCell ?? findCell(surface, startX, startY)
      if (!cell) return null
      const targetDay = zonedStartOfDay(cell.day, timeZone)
      if (kind === "move") {
        const originDay = zonedStartOfDay(occurrence.start, timeZone)
        // minus the grabbed day: the bar follows the pointer by the distance
        // travelled, it does not re-anchor its start under the pointer
        const delta =
          differenceInCalendarDays(targetDay, originDay) - grabDayOffset
        const start = addDays(toZoned(occurrence.start, timeZone), delta)
        return {
          start,
          end: new Date(start.getTime() + durationMs),
          allDay: occurrence.allDay,
          dayGranular: true,
        }
      }
      // bar edge resize: day granularity
      if (kind === "resize-start") {
        const time =
          occurrence.start.getTime() -
          zonedStartOfDay(occurrence.start, timeZone).getTime()
        const start = new Date(targetDay.getTime() + time)
        if (start >= occurrence.end) return null
        return {
          start,
          end: occurrence.end,
          allDay: occurrence.allDay,
          dayGranular: true,
        }
      }
      const time = occurrence.allDay
        ? 0
        : occurrence.end.getTime() -
          zonedStartOfDay(occurrence.end, timeZone).getTime()
      const end = occurrence.allDay
        ? addDays(targetDay, 1)
        : new Date(addDays(targetDay, time > 0 ? 0 : 1).getTime() + time)
      if (end <= occurrence.start) return null
      return {
        start: occurrence.start,
        end,
        allDay: occurrence.allDay,
        dayGranular: true,
      }
    }

    // ---- minute-granularity: time-grid columns
    const col = findColumn(surface, e.clientX)
    if (!col) return null
    const dayStart = zonedStartOfDay(col.day, timeZone)
    const rawMin = pointerMinutes(surface, col, e.clientY)

    if (kind === "move") {
      const newStartMin = snapMinutes(rawMin - grabOffsetMin, snap)
      // the clamp keeps the grabbed CHIP inside the column it is over; the
      // lead then carries the rest of a cross-midnight occurrence with it
      const chipDurationMin = Math.round(grabSegDurationMs / 60000)
      const clamped = Math.min(
        Math.max(newStartMin, col.boundsStartMin),
        col.boundsEndMin - chipDurationMin
      )
      const start = new Date(
        addMinutes(dayStart, clamped).getTime() - grabLeadMs
      )
      return {
        start,
        end: new Date(start.getTime() + durationMs),
        allDay: false,
        resourceId: col.resourceId,
      }
    }

    const min = snapMinutes(rawMin, snap)
    // Both endpoints expressed in the POINTED column's day coordinates.
    // Anchoring each endpoint to its OWN day breaks cross-midnight events:
    // a 23:30 pointer in the start day's column would apply 1410 minutes to
    // the end's next-day anchor and jump the end a full day late (and a
    // midnight-ending event computes occEndMin 0 against its own day).
    const occStartMinInCol = Math.round(
      (occurrence.start.getTime() - dayStart.getTime()) / 60000
    )
    const occEndMinInCol = Math.round(
      (occurrence.end.getTime() - dayStart.getTime()) / 60000
    )
    if (kind === "resize-start") {
      const clamped = Math.min(
        Math.max(min, col.boundsStartMin),
        Math.min(occEndMinInCol - snap, col.boundsEndMin)
      )
      const start = addMinutes(dayStart, clamped)
      if (start >= occurrence.end) return null
      return { start, end: occurrence.end, allDay: false }
    }
    const clamped = Math.max(
      Math.min(min, col.boundsEndMin),
      Math.max(occStartMinInCol + snap, col.boundsStartMin)
    )
    const end = addMinutes(dayStart, clamped)
    if (end <= occurrence.start) return null
    return { start: occurrence.start, end, allDay: false }
  }

  const applyProposal = (e: PointerEvent) => {
    const proposal = computeProposal(e)
    if (!proposal) return
    const key = `${proposal.start.getTime()}-${proposal.end.getTime()}-${proposal.allDay}-${proposal.resourceId ?? ""}`
    if (key === lastProposalKey) return
    lastProposalKey = key

    if (kind === "create") {
      const draft = { ...proposal, view: instance.getState().view }
      if (settings.canSelectSlot && !settings.canSelectSlot(draft)) return
      internals.setSlotDraft(draft)
      return
    }
    const update: EventCalendarProposedUpdate<TData> = {
      event: occurrence!.event,
      occurrence: occurrence!,
      ...proposal,
      source: kind as "drag" | "resize-start" | "resize-end",
    }
    if (kind === "move") update.source = "drag"
    const valid = settings.canDropEvent ? settings.canDropEvent(update) : true
    lastValid = valid
    setBodyDragging(true, !valid)
    internals.setDrag({
      kind: kind === "move" ? "move" : (kind as "resize-start" | "resize-end"),
      occurrence: occurrence!,
      proposedStart: proposal.start,
      proposedEnd: proposal.end,
      proposedAllDay: proposal.allDay,
      proposedDayGranular: proposal.dayGranular ?? false,
      proposedResourceId: proposal.resourceId,
      valid,
    })
  }

  // Cursor-attached carry clone for MOVE gestures: the event travels freely
  // with the pointer, like an absolutely positioned overlay, while the
  // in-grid ghost renders only a faint dashed placeholder at the snapped
  // drop slot (EVENT_CALENDAR_GHOST.move). Vanilla DOM: cloned once at
  // activation, transformed per pointermove, zero React work per frame.
  let carryEl: HTMLDivElement | null = null
  let carryDX = 0
  let carryDY = 0
  const CARRY_CLASS =
    "bg-background border-border pointer-events-none fixed top-0 left-0 z-100 overflow-hidden rounded-sm border opacity-90 will-change-transform" +
    (ui?.dragCarry ? " " + ui.dragCarry : "")
  const CARRY_INVALID_CLASS =
    `${CARRY_CLASS} ring-destructive/60 ring-1` +
    (ui?.dragCarryInvalid ? " " + ui.dragCarryInvalid : "")

  const createCarry = () => {
    if (kind !== "move") return
    const chip =
      origin.closest<HTMLElement>("[data-slot=event-calendar-event]") ?? origin
    const rect = chip.getBoundingClientRect()
    // The clone is re-parented to <body>, escaping the calendar's inherited
    // font-size, so copy the source chip's resolved type - this keeps the carry
    // matching the grid at any consumer text scale (e.g. root text-sm).
    const chipFont = getComputedStyle(chip)
    carryDX = startX - rect.left
    carryDY = startY - rect.top
    carryEl = document.createElement("div")
    carryEl.setAttribute("data-slot", "event-calendar-drag-carry")
    carryEl.setAttribute("aria-hidden", "true")
    carryEl.className = CARRY_CLASS
    carryEl.style.width = `${rect.width}px`
    carryEl.style.height = `${rect.height}px`
    carryEl.style.fontSize = chipFont.fontSize
    carryEl.style.lineHeight = chipFont.lineHeight
    carryEl.style.transform = `translate3d(${snapToPixel(rect.left)}px, ${snapToPixel(rect.top)}px, 0)`
    const clone = chip.cloneNode(true) as HTMLElement
    clone.removeAttribute("data-dragging")
    clone.style.width = "100%"
    clone.style.height = "100%"
    carryEl.appendChild(clone)
    document.body.appendChild(carryEl)
  }

  const positionCarry = (e: PointerEvent) => {
    if (!carryEl) return
    carryEl.style.transform = `translate3d(${snapToPixel(e.clientX - carryDX)}px, ${snapToPixel(e.clientY - carryDY)}px, 0)`
    const cls = lastValid ? CARRY_CLASS : CARRY_INVALID_CLASS
    if (carryEl.className !== cls) carryEl.className = cls
  }

  // Cursor-following validation hint, visible ONLY while the proposal is
  // rejected (canDropEvent / bounds). Vanilla DOM: zero React work per frame;
  // pairs with the not-allowed cursor and the ghost's destructive marking.
  const updateHint = (e: PointerEvent) => {
    if (lastValid || !active) {
      hintEl?.remove()
      hintEl = null
      return
    }
    if (!hintEl) {
      hintEl = document.createElement("div")
      hintEl.setAttribute("data-slot", "event-calendar-drop-hint")
      // physical left-0 anchor: translate3d positions in physical clientX
      // coordinates, so a logical start-0 anchor would fling it off-screen
      // in RTL documents
      hintEl.className =
        "bg-background text-destructive border-destructive/40 pointer-events-none fixed top-0 left-0 z-100 rounded-sm border px-2 py-0.5 text-xs font-medium" +
        (ui?.dropHint ? " " + ui.dropHint : "")
      hintEl.textContent = settings.i18n.labels.dropNotAllowed
      document.body.appendChild(hintEl)
    }
    hintEl.style.transform = `translate3d(${snapToPixel(e.clientX + 12)}px, ${snapToPixel(e.clientY + 16)}px, 0)`
  }

  const autoScroll = (e: PointerEvent) => {
    // Cached rect (see Surface.viewportRect) - never getBoundingClientRect per
    // move; the box is stable while the pointer is captured.
    const rect = surface?.viewportRect
    if (!surface?.viewport || !rect) return
    const edge = activation.autoScrollEdgePx
    const step = activation.autoScrollMaxStepPx
    let delta = 0
    /**
     * The scroller wraps the time track ONLY - the day headers and the all-day
     * row sit above it, outside the box - so its top edge is a hard floor. A
     * pointer above that floor is over one of those rows, and both are drop
     * targets in their own right (a bar moving across dates, a timed chip
     * lifted onto the all-day lane to convert it); they are already fully
     * visible, so reaching them is never a request to scroll. Without the
     * floor, "past the top edge" is true on every single move of a horizontal
     * all-day drag and the track pans out from under a gesture that only wants
     * to change the date - fast, because the proximity ratio grows past 1 the
     * further above the box the pointer sits.
     *
     * Below the track there is no such row, so overshooting the bottom keeps
     * scrolling - that is how a grid is normally asked to keep going - but the
     * eased speed is capped at one step per frame for the same reason.
     */
    if (e.clientY >= rect.top) {
      if (e.clientY < rect.top + edge) {
        delta = -step * ((rect.top + edge - e.clientY) / edge)
      } else if (e.clientY > rect.bottom - edge) {
        delta = step * Math.min(1, (e.clientY - (rect.bottom - edge)) / edge)
      }
    }
    if (rafScroll) cancelAnimationFrame(rafScroll)
    if (delta !== 0) {
      const tick = () => {
        // Write-then-readback: the browser clamps scrollTop at the scroll
        // extent, so mirror only the APPLIED delta - otherwise parking the
        // pointer in the edge zone at the limit keeps inflating the tracked
        // value past reality and poisons every later minute mapping. When
        // parked (nothing applied), stop the loop; the next pointermove
        // restarts it.
        const before = surface!.viewport!.scrollTop
        surface!.viewport!.scrollTop = before + delta
        const applied = surface!.viewport!.scrollTop - before
        if (applied === 0) return
        // keep the tracked scrollTop in step so pointerMinutes stays a pure
        // number read (no DOM scrollTop, no forced reflow)
        surface!.scrollTop += applied
        applyProposal(e)
        rafScroll = requestAnimationFrame(tick)
      }
      rafScroll = requestAnimationFrame(tick)
    }
  }

  // idempotent: pointerup, pointercancel, Escape, blur and the calendar-level
  // teardown can race; whichever lands first wins and the rest no-op
  let finished = false
  const cleanup = () => {
    if (finished) return
    finished = true
    activeGestureCancels.delete(cancel)
    window.removeEventListener("pointermove", onPointerMove)
    window.removeEventListener("pointerup", onPointerUp)
    window.removeEventListener("pointercancel", onCancel)
    window.removeEventListener("blur", onWindowBlur)
    window.removeEventListener("keydown", onKeyDown, true)
    if (rafScroll) cancelAnimationFrame(rafScroll)
    if (touchTimer) clearTimeout(touchTimer)
    hintEl?.remove()
    hintEl = null
    carryEl?.remove()
    carryEl = null
    setBodyDragging(false)
  }

  const cancel = () => {
    cleanup()
    if (active) {
      lastGestureEndedAt = performance.now()
      internals.setDrag(null)
      internals.setSlotDraft(null)
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation()
      cancel()
    }
  }

  // focus loss mid-gesture (alt-tab, OS dialogs) means the release may never
  // be delivered; treat it as a cancel so the gesture cannot get stuck and
  // commit its stale proposal on the next click
  const onWindowBlur = () => cancel()

  const onPointerMove = (e: PointerEvent) => {
    // a second finger must not drive - or cancel the pending long press of -
    // the gesture this pointer started
    if (e.pointerId !== pointerId) return
    lastPointer = e
    if (!active) {
      const distance = Math.hypot(e.clientX - startX, e.clientY - startY)
      if (isTouch) {
        // Long-press pending: moving past tolerance means scroll, not drag
        if (distance > activation.touchTolerancePx) cancel()
        return
      }
      if (distance < activationDistance) return
      activate()
    }
    applyProposal(e)
    autoScroll(e)
    updateHint(e)
    positionCarry(e)
  }

  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return
    cleanup()
    if (!active) return
    lastGestureEndedAt = performance.now()

    const state = instance.getState()
    if (kind === "create") {
      const draft = state.slotDraft
      internals.setSlotDraft(null)
      if (draft) {
        api.select({
          slot: { start: draft.start, end: draft.end, allDay: draft.allDay },
        })
        settings.onSelectSlot?.(draft)
      }
      return
    }
    const drag = state.drag
    internals.setDrag(null)
    if (!drag || !occurrence) return
    const unchanged =
      drag.proposedStart.getTime() === occurrence.start.getTime() &&
      drag.proposedEnd.getTime() === occurrence.end.getTime() &&
      (drag.proposedResourceId === undefined ||
        drag.proposedResourceId === occurrence.event.resourceId)
    if (unchanged) return
    // Commit through the one validation funnel; consumer reject = automatic
    // revert because the calendar never mutated during the gesture.
    const accepted = internals.applyProposedUpdate({
      event: occurrence.event,
      occurrence,
      start: drag.proposedStart,
      end: drag.proposedEnd,
      allDay: drag.proposedAllDay,
      resourceId: drag.proposedResourceId,
      source:
        kind === "move" ? "drag" : (kind as "resize-start" | "resize-end"),
    })
    // the polite live region is the only feedback a screen-reader user gets
    // that the drop landed, and on what; a vetoed commit stays silent
    if (accepted && announcer) {
      announcer.textContent = `${occurrence.event.title}, ${settings.i18n.functions.formatEventTime(
        toZoned(drag.proposedStart, timeZone),
        toZoned(drag.proposedEnd, timeZone),
        drag.proposedAllDay,
        { locale: settings.locale }
      )}`
    }
  }

  const onCancel = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return
    cancel()
  }

  window.addEventListener("pointermove", onPointerMove)
  window.addEventListener("pointerup", onPointerUp)
  window.addEventListener("pointercancel", onCancel)
  // a resize on a precise pointer is live from the first frame, so it never
  // reaches activate() to arm its own blur cancel
  if (active) window.addEventListener("blur", onWindowBlur)
  window.addEventListener("keydown", onKeyDown, true)
  activeGestureCancels.add(cancel)

  // Touch: long-press activation (movement past tolerance cancels above)
  if (isTouch && !active) {
    touchTimer = setTimeout(() => {
      activate()
      applyProposal(lastPointer)
    }, activation.touchDelayMs)
  }
}

/* =============================================================================
 * QUINCY ADDITION (#219 PR B stage 3) — external drop.
 *
 * Dragging something that is NOT yet a calendar event (an unscheduled Quincy item) onto the grid,
 * resolved through the calendar's own hit-testing rather than by scraping the DOM from outside.
 *
 * WHY THIS LIVES INSIDE THE VENDORED TREE (see docs/adr/0010):
 *
 * 1. The geometry it needs is private and stays private. `collectSurface` reads the vendor's own
 *    `data-ec-day` / `data-ec-bounds-start` / `data-ec-bounds-end` / `data-ec-resource` attribute
 *    contract, carries the auto-scroll compensation `scrollTop - viewportStartScrollTop`, and
 *    deliberately captures `viewportRect` once for a measured ~200ms-reflow reason. A module
 *    outside this tree would need all four helpers exported for one consumer, or would re-derive
 *    them against a private contract — which is the DOM scraping this was meant to replace.
 * 2. THE DECISIVE ONE: gesture lifecycle here is module-level singleton state.
 *    `activeGestureCancels` is not exported, and it is how a calendar aborts in-flight gestures
 *    when it unmounts. A gesture registered from outside this module would be invisible to
 *    `cancelActiveEventCalendarGestures()` and could outlive its calendar, stranding window
 *    listeners and a mutated `document.body`. That cannot be fixed from outside at all.
 * 3. `markChipPress` suppresses the trailing native click that would otherwise open a create
 *    dialog where the drop landed. It IS exported, so this one is convenience rather than
 *    necessity — but it is free here.
 *
 * WHAT DELIBERATELY STAYS OUTSIDE: the policy. Turning a dropped payload into a `CalendarEvent` is
 * Quincy's business, not the vendor's, and — unlike a move or resize — the commit path is not
 * coupled to the vendor either. `applyProposedUpdate` maps over existing events matching an id, so
 * it can only ever UPDATE; an external drop CREATES, through the public `api.addEvent`. This
 * module therefore reports a resolved target and never writes an event.
 *
 * This is a pure addition: nothing inside `beginGesture` was touched, nothing was deleted, and no
 * existing export changed. That is the cheapest possible story for a future re-vendor — replay
 * this block, and nothing else in the file has to be reconciled.
 * ========================================================================== */

/** Where a pointer currently resolves to on the calendar surface. */
interface EventCalendarExternalDropTarget {
  start: Date
  /** `start` + the dragged item's duration, or the next zoned midnight when `allDay`. */
  end: Date
  allDay: boolean
  resourceId?: string
  view: CalendarView
  /**
   * True when the target came from a day CELL (month grid, all-day row) rather than a
   * minute-precise column, so the caller can tell "the 4th, some time" from "the 4th at 14:15".
   */
  dayGranular: boolean
}

interface EventCalendarExternalDropOptions<TPayload> {
  /** Opaque to this module — mirrors the tree's own `TData` convention. */
  payload: TPayload
  /** Length of the thing being dropped. Ignored when the target resolves as all-day. */
  durationMinutes: number
  /** Resolve day-cell targets as all-day rather than as a timed block at the day's start. */
  preferAllDay?: boolean
  /** Refuse a target. A refused target previews nothing and commits nothing. */
  canDrop?: (target: EventCalendarExternalDropTarget, payload: TPayload) => boolean
  /** Commit. Called once, on release over an accepted target. */
  onDrop: (target: EventCalendarExternalDropTarget, payload: TPayload) => void
  /**
   * An ACTIVATED drag that ended without a commit: Escape, window blur, a calendar unmount, or a
   * release over nothing droppable. NOT called for a press that never passed the activation
   * threshold — that is a click on the drag source, not a cancelled drag, and the consumer's own
   * onClick handles it. `event-calendar-external-drop.dom.test.tsx` pins both halves.
   */
  onCancel?: () => void
}

/**
 * Resolve a pointer position to a drop target, mirroring `computeProposal`'s own branching:
 * minute columns when the view has them, day cells otherwise.
 *
 * Returns null when the surface offers neither. That is not a failure — the AGENDA view renders no
 * `data-ec-day` nodes at all and consumes no slot draft, so a drop there has no geometry and must
 * be an explicit, tested no-op rather than an accidental one.
 */
function resolveExternalDropTarget<TData>(
  instance: EventCalendarInstance<TData>,
  surface: Surface,
  clientX: number,
  clientY: number,
  durationMinutes: number,
  preferAllDay: boolean
): EventCalendarExternalDropTarget | null {
  // `settings` hangs off the instance (resolved options); `view` is reactive state.
  const settings = instance.settings
  const { view } = instance.getState()
  const timeZone = settings.timeZone

  // Day-granular first when the pointer is genuinely over a cell: the month grid and the all-day
  // row both publish cells, and a time-grid surface publishes BOTH (its all-day row is cells, its
  // columns are minutes), so cell containment is what disambiguates them — not view name.
  const cell = findCell(surface, clientX, clientY)
  if (cell) {
    const start = zonedStartOfDay(cell.day, timeZone)
    if (preferAllDay) {
      return {
        start,
        end: zonedStartOfDay(addDays(toZoned(start, timeZone), 1), timeZone),
        allDay: true,
        view,
        dayGranular: true,
      }
    }
    return {
      start,
      end: addMinutes(start, durationMinutes),
      allDay: false,
      view,
      dayGranular: true,
    }
  }

  if (surface.columns.length === 0) return null

  const col = findColumn(surface, clientX)
  if (!col) return null

  const raw = pointerMinutes(surface, col, clientY)
  // Clamp so a drop cannot start past the end of the day, then snap — same order the move gesture
  // uses. `boundsEndMin` is ELAPSED minutes and is 1380/1500 on a DST transition day, never a flat
  // 1440; see `elapsedMinutesAtWallClockHour` in event-calendar-lib.tsx.
  const clamped = Math.min(
    Math.max(raw, col.boundsStartMin),
    Math.max(col.boundsStartMin, col.boundsEndMin - durationMinutes)
  )
  const snapped = snapMinutes(clamped, settings.snapDuration)
  const dayStart = zonedStartOfDay(col.day, timeZone)
  const start = addMinutes(dayStart, snapped)

  return {
    start,
    end: addMinutes(start, durationMinutes),
    allDay: false,
    resourceId: col.resourceId,
    view,
    dayGranular: false,
  }
}

/**
 * Begin an external drag from any element — a tray item, a list row, anything outside the grid.
 *
 * Lifecycle mirrors `beginGesture`: measure the surface once at activation, then live on window
 * listeners; register the cancel in `activeGestureCancels` so the calendar can abort it; revert
 * fully on cancel. It does NOT reuse `beginGesture` itself: that function carries ~35 closure
 * variables and several `occurrence!` assertions predicated on a segment existing, and a
 * payload-only gesture has no segment, so threading one through would mean auditing every one of
 * them for no benefit.
 *
 * The in-grid preview is the vendor's own slot draft (`internals.setSlotDraft`), which is what the
 * month view, time grid and resource view already render. It shows the vendor's dashed slot box
 * rather than a likeness of the dragged item; a consumer wanting its own cursor-following preview
 * renders one itself, which the harness tray does.
 */
function useEventCalendarExternalDrop<TData = unknown, TPayload = unknown>() {
  const instance = useEventCalendar<TData>()

  const begin = useCallback(
    (
      e: React.PointerEvent,
      options: EventCalendarExternalDropOptions<TPayload>
    ) => {
      if (e.button !== 0) return
      const {
        payload,
        durationMinutes,
        preferAllDay = false,
        canDrop,
        onDrop,
        onCancel,
      } = options

      const startX = e.clientX
      const startY = e.clientY
      const isTouch = e.pointerType === "touch"
      const origin = e.currentTarget as HTMLElement

      let surface: Surface | null = null
      let active = false
      let target: EventCalendarExternalDropTarget | null = null
      let accepted = false
      let touchTimer: ReturnType<typeof setTimeout> | null = null
      let finished = false

      const clearPreview = () => {
        instance.internals.setSlotDraft(null)
        document.body.removeAttribute("data-ec-external-drag")
      }

      const teardown = () => {
        if (finished) return
        finished = true
        if (touchTimer !== null) clearTimeout(touchTimer)
        window.removeEventListener("pointermove", onPointerMove)
        window.removeEventListener("pointerup", onPointerUp)
        window.removeEventListener("pointercancel", cancel)
        window.removeEventListener("keydown", onKeyDown)
        window.removeEventListener("blur", cancel)
        activeGestureCancels.delete(cancel)
        clearPreview()
        // Only a gesture that ACTIVATED suppresses the trailing native click. A press that never
        // passed the activation threshold is a plain click on the drag source, and swallowing it
        // would break any onClick the consumer put on that tray row — and, because
        // `lastGestureEndedAt` is module-wide, would also suppress chip clicks across the whole
        // calendar for 250ms after someone merely tapped the tray.
        if (active) {
          markChipPress()
          lastGestureEndedAt = performance.now()
        }
      }

      function cancel() {
        if (finished) return
        teardown()
        onCancel?.()
      }

      const activate = () => {
        if (active) return
        active = true
        surface = collectSurface(origin, instance.internals.getRootEl())
        document.body.setAttribute("data-ec-external-drag", "")
      }

      const refresh = (clientX: number, clientY: number) => {
        if (!surface) return
        surface.scrollTop = surface.viewport?.scrollTop ?? surface.scrollTop
        target = resolveExternalDropTarget(
          instance,
          surface,
          clientX,
          clientY,
          durationMinutes,
          preferAllDay
        )
        accepted = target !== null && (canDrop?.(target, payload) ?? true)
        instance.internals.setSlotDraft(
          accepted && target
            ? {
                start: target.start,
                end: target.end,
                allDay: target.allDay,
                view: target.view,
                resourceId: target.resourceId,
              }
            : null
        )
        document.body.toggleAttribute("data-ec-external-drag-invalid", !accepted)
      }

      function onPointerMove(move: PointerEvent) {
        if (!active) {
          const dx = Math.abs(move.clientX - startX)
          const dy = Math.abs(move.clientY - startY)
          const threshold = isTouch
            ? EVENT_CALENDAR_ACTIVATION.touchTolerancePx
            : EVENT_CALENDAR_ACTIVATION.moveDistancePx
          if (isTouch) {
            // Movement past tolerance BEFORE the long-press delay means the user is scrolling,
            // not dragging — same rule the chip gestures use, so a tray stays scrollable.
            if (dx > threshold || dy > threshold) cancel()
            return
          }
          if (dx < threshold && dy < threshold) return
          activate()
        }
        refresh(move.clientX, move.clientY)
      }

      function onPointerUp(up: PointerEvent) {
        if (!active) {
          teardown()
          return
        }
        refresh(up.clientX, up.clientY)
        const committed = accepted && target
        const resolved = target
        teardown()
        if (committed && resolved) onDrop(resolved, payload)
        else onCancel?.()
      }

      function onKeyDown(key: KeyboardEvent) {
        if (key.key === "Escape") cancel()
      }

      window.addEventListener("pointermove", onPointerMove)
      window.addEventListener("pointerup", onPointerUp)
      window.addEventListener("pointercancel", cancel)
      window.addEventListener("keydown", onKeyDown)
      window.addEventListener("blur", cancel)
      activeGestureCancels.add(cancel)

      if (isTouch) {
        touchTimer = setTimeout(() => {
          touchTimer = null
          activate()
          refresh(startX, startY)
        }, EVENT_CALENDAR_ACTIVATION.touchDelayMs)
      }
    },
    [instance]
  )

  return { begin }
}

/** Per-chip / per-surface pointer gesture wiring. */
function useEventCalendarGestures<TData = unknown>() {
  const instance = useEventCalendar<TData>()
  // Overlay classNames bridged from React config into the vanilla-DOM engine
  // (which must never import from the chip module - circular).
  const { classNames } = useEventCalendarViewConfig<TData>()
  const ui = useMemo(
    () => ({
      dragCarry: classNames?.dragCarry,
      dragCarryInvalid: classNames?.dragCarryInvalid,
      dropHint: classNames?.dropHint,
    }),
    [classNames]
  )

  // An in-flight gesture lives on window listeners and body-appended overlays,
  // so it must never outlive the calendar. Chips hold this hook too and they
  // legitimately unmount mid-gesture, so only the LAST consumer leaving - the
  // calendar itself going away - aborts.
  useEffect(() => {
    gestureConsumers += 1
    return () => {
      gestureConsumers -= 1
      if (gestureConsumers === 0) cancelActiveEventCalendarGestures()
    }
  }, [])

  const canDrag = useCallback(
    (segment: EventCalendarSegment<TData>) => {
      const { interactions } = instance.getState()
      const event = segment.occurrence.event
      return interactions.drag && !event.readOnly && event.draggable !== false
    },
    [instance]
  )

  const canResize = useCallback(
    (segment: EventCalendarSegment<TData>) => {
      const { interactions } = instance.getState()
      const event = segment.occurrence.event
      return interactions.resize && !event.readOnly && event.resizable !== false
    },
    [instance]
  )

  /**
   * QUINCY (#219 PR B stage 3): per-edge gate layered over `canResize`. `canResize` keeps its
   * original meaning ("is resizing available for this event at all") so the public gestures
   * object's shape is unchanged; this narrows it to one edge.
   */
  const canResizeEdge = useCallback(
    (segment: EventCalendarSegment<TData>, edge: "start" | "end") => {
      if (!canResize(segment)) return false
      return segment.occurrence.event.resizableEdges?.[edge] !== false
    },
    [canResize]
  )

  const beginMove = useCallback(
    (e: React.PointerEvent, segment: EventCalendarSegment<TData>) => {
      if (e.button !== 0) return
      if (!canDrag(segment)) {
        // refused, but still give feedback + broadcast on a real drag attempt
        beginBlockedGesture(instance, e.nativeEvent, segment, "move")
        return
      }
      beginGesture({
        instance,
        kind: "move",
        origin: e.currentTarget as HTMLElement,
        startEvent: e.nativeEvent,
        segment,
        ui,
      })
    },
    [instance, canDrag, ui]
  )

  const beginResize = useCallback(
    (
      e: React.PointerEvent,
      segment: EventCalendarSegment<TData>,
      edge: "start" | "end"
    ) => {
      if (e.button !== 0) return
      // QUINCY (#219 PR B stage 3): per-edge, not just per-event. A locked edge is refused here
      // as well as ungripped in event-calendar-event.tsx, so calling this directly cannot bypass
      // the lock. Refusal still broadcasts through onDragBlocked, exactly as a whole-event
      // refusal does — a locked edge is a real refusal the consumer may want to explain.
      if (!canResizeEdge(segment, edge)) {
        e.stopPropagation()
        beginBlockedGesture(instance, e.nativeEvent, segment, "resize")
        return
      }
      e.stopPropagation()
      e.preventDefault()
      beginGesture({
        instance,
        kind: edge === "start" ? "resize-start" : "resize-end",
        origin: e.currentTarget as HTMLElement,
        startEvent: e.nativeEvent,
        segment,
        ui,
      })
    },
    [instance, canResizeEdge, ui]
  )

  const beginCreate = useCallback(
    (e: React.PointerEvent, day: Date, allDay: boolean) => {
      if (e.button !== 0) return
      if (!instance.getState().interactions.selectSlot) return
      beginGesture({
        instance,
        kind: "create",
        origin: e.currentTarget as HTMLElement,
        startEvent: e.nativeEvent,
        createDay: day,
        createAllDay: allDay,
        ui,
      })
    },
    [instance, ui]
  )

  return { beginMove, beginResize, beginCreate, canDrag, canResize, canResizeEdge }
}

export type {
  EventCalendarExternalDropOptions,
  EventCalendarExternalDropTarget,
}
export {
  EVENT_CALENDAR_ACTIVATION,
  cancelActiveEventCalendarGestures,
  markChipPress,
  useEventCalendarExternalDrop,
  useEventCalendarGestures,
  wasRecentChipPress,
  wasRecentDrag,
}