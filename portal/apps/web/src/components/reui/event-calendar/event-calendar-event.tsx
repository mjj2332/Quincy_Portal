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
 * THIS FILE: the event chip family, plus the tree's shared class constants — the drag ghost, the drag-to-create slot draft, the colour presets and the fade truncation.
 *
 *   - `EVENT_CALENDAR_COLORS` WAS ten chromatic `var(--color-<hue>-500)` presets — the registry's
 *     default palette, and not Quincy's monochrome brand. Nothing in this tree consumes it.
 *     `event-calendar-skin.guard.test.ts` keeps it that way.
 *
 * Quincy edits since vendoring:
 *
 * 1. 2026-09-21, #219 PR B, stage 3 — each of the four resize grips is now gated on its OWN edge
 *    via `gestures.canResizeEdge`, backing `CalendarEvent.resizableEdges`. `showResize` still
 *    covers the whole-event vetoes.
 * 2. 2026-09-21, #219 PR B, stage 3 — added `data-testid="event-calendar-resize-handle-<edge>"`
 *    beside the vendor's own `data-slot` on those grips. Guard F (`test-seam.guard.test.ts`,
 *    issue #92) forbids a DOM test from selecting a `data-slot` only a `components/reui/` file
 *    authors, and there is no Quincy component composing this deep inside the vendor's render
 *    tree to hang a hook on instead — so the testid goes here, exactly as PR A did in
 *    `gantt-bar.tsx`. Minimal and additive; it is not a `data-slot`, so Guard F does not govern
 *    it either way.
 * 3. 2026-09-21 (#219 PR B): the chip applies `viewConfig.eventClassName?.(occurrence)`, before
 *    `classNames.event` so a blanket override still wins.
 * 4. 2026-09-21, #240 — the chip opens the keyboard Adjust session. ADDED: an `isAdjusting`
 *    selector, `data-ec-event-id` (how the session finds this event's chip after a commit
 *    re-renders it elsewhere), `data-adjusting`, `aria-keyshortcuts="Space"`, and an `onKeyDown`
 *    that hands Space to `beginKeyboardAdjust` with the SAME move / resize-edge gates the grips
 *    use. Enter and click are untouched. Previews and agenda rows never open a session.
 */
import {
  createContext,
  useContext,
  useMemo,
  type CSSProperties,
  type ReactNode,
} from "react"
import {
  useEventCalendar,
  useEventCalendarSelector,
  useEventCalendarViewConfig,
  useEventCalendarViewContext,
} from "@/components/reui/event-calendar/event-calendar"
import {
  markChipPress,
  useEventCalendarGestures,
  wasRecentDrag,
} from "@/components/reui/event-calendar/event-calendar-dnd"
import { matchAdjustKey } from "@/components/reui/event-calendar/event-calendar-keyboard"
import {
  spansMultipleDays,
  toZoned,
  zonedStartOfDay,
} from "@/components/reui/event-calendar/event-calendar-lib"
import type {
  EventCalendarOccurrence,
  EventCalendarSegment,
} from "@/components/reui/event-calendar/event-calendar-types"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { addDays, format } from "date-fns"

import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/reui/tooltip"
import { RepeatIcon } from "lucide-react"

/*
 * QUINCY REMOVAL (#219 PR B stage 4): `EVENT_CALENDAR_COLORS` deleted. It was ten chromatic
 * `var(--color-<hue>-500)` presets — blue, emerald, violet, rose, amber, cyan, orange, pink,
 * teal, indigo — in a brand that is monochrome greige and ink. Nothing in the tree consumed it;
 * it was exported, so "unused" was a promise about the rest of the repo rather than a structural
 * fact, and a dead palette const is exactly the thing a future contributor wires up helpfully.
 *
 * It is also INVISIBLE to the non-token-palette detector, which matches Tailwind class names:
 * these are CSS custom-property VALUES, so no `bg-amber-500` ever appears. Deleting it is what
 * makes the absence structural; the skin guard's `EVENT_CALENDAR_COLORS` detector then keeps it
 * from coming back from anywhere in `src/`.
 *
 * A re-vendor WILL bring it back. Delete it again — event colour in Quincy comes from a semantic
 * token (see `harness/reui-scheduling/fixtures.ts`'s `STAGE_COLORS`), never from a hue wheel.
 */

/**
 * Drag-ghost surfaces, shared verbatim by every view. A move CARRIES the
 * event: the dnd engine attaches a full clone to the cursor
 * (data-slot=event-calendar-drag-carry), so this in-grid ghost is only the
 * dashed placeholder for the snapped drop slot. A resize STRETCHES instead:
 * the chip itself at the proposed extent, dashed rather than solid.
 */
const EVENT_CALENDAR_GHOST = {
  move: "rounded-sm border border-dashed border-(--ec-event-color)/50 bg-(--ec-event-color)/8",
  resize:
    "rounded-sm border border-dashed border-(--ec-event-color)/70 overflow-hidden",
  invalid: "border-destructive/70 bg-destructive/10",
  invalidResize: "border-destructive/70",
  /** Applied to the clone inside an invalid resize ghost. */
  invalidContent: "opacity-60",
} as const

/**
 * Fade-out truncation for stacked timed blocks, where squeezed cascade
 * columns clip titles into a mash of glyphs; a right-edge mask fade reads
 * cleaner than an ellipsis at those widths. Masked ONLY below a 10rem
 * container: mask-image forces text off subpixel antialiasing, so masking
 * wide chips makes the whole grid read bolder and shimmer while resizing.
 * Wide chips keep the plain ellipsis. Exported for consumer renderEvent.
 */
const EVENT_CALENDAR_FADE_TRUNCATE =
  "w-full truncate @max-[10rem]:text-clip @max-[10rem]:[mask-image:linear-gradient(to_right,#000_calc(100%-0.75rem),transparent)] @max-[10rem]:rtl:[mask-image:linear-gradient(to_left,#000_calc(100%-0.75rem),transparent)]"

/**
 * The drag-to-create selection, shared by every view: a dashed primary
 * outline over a faint wash with the range printed inside. `box` is the timed
 * grid's single minute-positioned rectangle; `segment` is one day-cell slice
 * of a multi-cell draft, with side borders and rounding only on the run's two
 * ends so it reads as one dashed box rather than a row of them.
 */
const EVENT_CALENDAR_SLOT_DRAFT = {
  box: "rounded-sm border border-dashed border-primary/40 bg-primary/5",
  segment: "border-y border-dashed border-primary/40",
  segmentStart: "rounded-s-sm border-s",
  segmentEnd: "rounded-e-sm border-e",
  /**
   * The wash for segmented views, on the CELL not the dashed overlay: the
   * overlay stacks above the chips, so tinting it would wash them instead.
   */
  surface: "bg-primary/5",
  /**
   * The range readout. `leading-none` is load-bearing: the shortest timed
   * draft is one snap interval tall (16px at the default 15-minute snap and
   * 4rem hour height), and looser leading renders ~18px, clipped by the
   * draft's own overflow-hidden.
   */
  label:
    "text-primary truncate px-1 py-0.5 text-[0.6875rem] leading-none font-medium",
} as const

interface EventCalendarChipContextValue<TData = unknown> {
  occurrence: EventCalendarOccurrence<TData>
  segment: EventCalendarSegment<TData>
  isDragging: boolean
  isSelected: boolean
}

const EventCalendarChipContext =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createContext<EventCalendarChipContextValue<any> | null>(null)

/** The chip's subject; usable inside renderEvent content and chip children. */
function useEventCalendarEventChip<
  TData = unknown,
>(): EventCalendarChipContextValue<TData> {
  const ctx = useContext(EventCalendarChipContext)
  if (!ctx) {
    throw new Error(
      "useEventCalendarEventChip must be used within <EventCalendarEvent>"
    )
  }
  return ctx as EventCalendarChipContextValue<TData>
}

interface EventCalendarEventProps<TData = unknown> extends Omit<
  useRender.ComponentProps<"button">,
  "children"
> {
  segment: EventCalendarSegment<TData>
  /** Replaces the default chip CONTENT; the wrapper stays calendar-owned. */
  children?: ReactNode
  /**
   * Static drag clone: the chip as-is but inert - no gestures, resize
   * handles, selection/drag state, focus or pointer events.
   */
  preview?: boolean
}

/**
 * The one interactive event element in every view. The wrapper owns a11y,
 * data attributes, selection and drag/resize wiring; content comes from
 * children, else renderEvent, else the built-in default.
 */
function EventCalendarEvent<TData = unknown>({
  segment,
  className,
  render,
  children,
  preview = false,
  ...props
}: EventCalendarEventProps<TData>) {
  const instance = useEventCalendar<TData>()
  const viewConfig = useEventCalendarViewConfig<TData>()
  const { view } = useEventCalendarViewContext()
  const gestures = useEventCalendarGestures<TData>()
  const { settings } = instance
  const occurrence = segment.occurrence
  const event = occurrence.event

  const isSelectedRaw = useEventCalendarSelector<TData, boolean>(
    (state) => state.selection.eventKeys.includes(occurrence.key),
    { calendar: instance }
  )
  const isDraggingRaw = useEventCalendarSelector<TData, boolean>(
    (state) => state.drag?.occurrence.key === occurrence.key,
    { calendar: instance }
  )
  // reactive, unlike gestures.canResize: api.setInteractions({ resize })
  // must add/remove the handles without waiting for an unrelated re-render
  const resizeOn = useEventCalendarSelector<TData, boolean>(
    (state) => state.interactions.resize,
    { calendar: instance }
  )
  // A preview clone must never inherit the source's selected/dragging state
  // (the drag key matches, which would dim the clone itself).
  const isSelected = preview ? false : isSelectedRaw
  const isDragging = preview ? false : isDraggingRaw
  // QUINCY (#240): a keyboard Adjust session previews through the same drag state
  const isAdjusting = useEventCalendarSelector<TData, boolean>(
    (state) =>
      !preview &&
      state.drag?.keyboard === true &&
      state.drag.occurrence.key === occurrence.key,
    { calendar: instance }
  )

  const isBar =
    occurrence.allDay || spansMultipleDays(occurrence, settings.timeZone)
  const inTimeGrid =
    view === "week" || view === "day" || view === "days" || view === "resource"
  const interactive = view !== "agenda" && !preview
  // QUINCY (#240): the same gates the pointer path uses; drives `aria-keyshortcuts` and Space
  const adjustable =
    interactive &&
    (gestures.canDrag(segment) ||
      gestures.canResizeEdge(segment, "start") ||
      gestures.canResizeEdge(segment, "end"))
  const timedBlock = inTimeGrid && !isBar
  const horizontalBar = isBar && !inTimeGrid
  // >= compactEventMinutes renders the stacked (title over time) layout, where
  // squeezed cascade columns fade-truncate instead of clipping into neighbors
  const stackedBlock =
    timedBlock &&
    (segment.endMin ?? 0) - (segment.startMin ?? 0) >=
      viewConfig.compactEventMinutes

  const defaultContent = (
    <>
      {/* leading dot for single-row chips (month cells, all-day bars); a
          time-grid block takes its color from the tinted surface instead, and
          in its stacked layout a dot would sit alone on the first line */}
      {!timedBlock && (
        <span
          aria-hidden
          data-slot="event-calendar-event-dot"
          // -me-0.5 tightens only the dot-to-title gap; the chip keeps gap-1.5
          className="-me-0.5 size-1.5 shrink-0 rounded-full bg-(--ec-event-color)"
        />
      )}
      {occurrence.isRecurring && (
        <RepeatIcon className="size-2.5 shrink-0 opacity-70" aria-hidden="true" />
      )}
      <span
        className={cn(
          "font-medium",
          stackedBlock ? EVENT_CALENDAR_FADE_TRUNCATE : "truncate"
        )}
      >
        {event.title}
      </span>
      {/* month cells are narrow: a compact never-shrinking start time keeps
          the title readable; grids show the full range */}
      {!occurrence.allDay &&
        segment.isStart &&
        (view === "month" ? (
          <span className="text-muted-foreground shrink-0">
            {format(
              toZoned(occurrence.start, settings.timeZone),
              settings.i18n.formats.eventTime,
              { locale: settings.locale }
            )}
          </span>
        ) : (
          <span
            className={cn(
              "text-muted-foreground hidden @[8rem]:inline",
              stackedBlock ? EVENT_CALENDAR_FADE_TRUNCATE : "truncate"
            )}
          >
            {settings.i18n.functions.formatEventTime(
              toZoned(occurrence.start, settings.timeZone),
              toZoned(occurrence.end, settings.timeZone),
              occurrence.allDay,
              { locale: settings.locale }
            )}
          </span>
        ))}
    </>
  )

  // Per-day time text for a multi-day event: "From 9:00 AM", "All day",
  // "Until 5:00 PM". Boundaries come from the occurrence vs segment.day, never
  // the packing flags - lane merging rewrites those on shared segments.
  const agendaTimeText = (() => {
    if (view !== "agenda") return ""
    if (occurrence.allDay) return settings.i18n.labels.allDay
    const dayStart = zonedStartOfDay(segment.day, settings.timeZone)
    const dayEnd = addDays(toZoned(dayStart, settings.timeZone), 1)
    const startsBefore = occurrence.start < dayStart
    const endsAfter = occurrence.end > dayEnd
    if (startsBefore && endsAfter) return settings.i18n.labels.allDay
    if (endsAfter) {
      return settings.i18n.labels.timeFrom(
        format(
          toZoned(occurrence.start, settings.timeZone),
          settings.i18n.formats.eventTime,
          { locale: settings.locale }
        )
      )
    }
    if (startsBefore) {
      return settings.i18n.labels.timeUntil(
        format(
          toZoned(occurrence.end, settings.timeZone),
          settings.i18n.formats.eventTime,
          { locale: settings.locale }
        )
      )
    }
    return settings.i18n.functions.formatEventTime(
      toZoned(occurrence.start, settings.timeZone),
      toZoned(occurrence.end, settings.timeZone),
      false,
      { locale: settings.locale }
    )
  })()

  // Agenda default row: time column, color-dot badge, plain title
  const agendaDefaultContent = (
    <>
      <span className="text-muted-foreground w-40 shrink-0 truncate tabular-nums">
        {agendaTimeText}
      </span>
      <span
        aria-hidden
        data-slot="event-calendar-agenda-dot"
        className="size-2 shrink-0 rounded-full bg-(--ec-event-color)"
      />
      <span className="truncate text-sm">{event.title}</span>
      {occurrence.isRecurring && (
        <RepeatIcon className="text-muted-foreground size-2.5 shrink-0" aria-hidden="true" />
      )}
    </>
  )

  // Memoized so a drag - which re-renders the lane on every pointer move -
  // never re-invokes the consumer's renderEvent per frame: a referentially
  // stable element lets React skip the custom subtree instead of flickering it.
  // The render fns are deps, so an inline arrow from the consumer defeats it.
  const customContent = useMemo(() => {
    const renderProps = { occurrence, segment, view, isDragging, isSelected }
    return view === "agenda"
      ? viewConfig.renderAgendaEvent?.(renderProps)
      : viewConfig.renderEvent?.(renderProps)
  }, [
    occurrence,
    segment,
    view,
    isDragging,
    isSelected,
    viewConfig.renderAgendaEvent,
    viewConfig.renderEvent,
  ])
  const content =
    children ??
    customContent ??
    (view === "agenda" ? agendaDefaultContent : defaultContent)

  const timeLabel = settings.i18n.functions.formatEventTime(
    toZoned(occurrence.start, settings.timeZone),
    toZoned(occurrence.end, settings.timeZone),
    occurrence.allDay,
    { locale: settings.locale }
  )
  // native hover tooltip text; a formatter returning undefined drops the title
  const label = settings.i18n.functions.formatEventLabel
    ? settings.i18n.functions.formatEventLabel(event.title, timeLabel)
    : `${event.title}, ${timeLabel}`

  // Optional styled tooltip (viewConfig.eventTooltip, default off). It replaces
  // the native title so the two never stack, and a preview never gets one. A
  // falsy renderEventTooltip result (including the false/"" of `cond && <node>`)
  // falls back to the label; an empty label leaves no content and skips it.
  const tooltipOpts =
    typeof viewConfig.eventTooltip === "object" ? viewConfig.eventTooltip : null
  const tooltipContent =
    !preview && viewConfig.eventTooltip
      ? viewConfig.renderEventTooltip?.({
          occurrence,
          segment,
          view,
          label,
        }) || label
      : null
  const tooltipOn = Boolean(tooltipContent)

  const showResize =
    interactive && resizeOn && !event.readOnly && event.resizable !== false
  // Hover grip pill (mirrors the gantt bars) marking the resize direction.
  // Shown on compact sub-compactEventMinutes blocks too: the 1.5rem chip
  // min-height leaves edge room without colliding with the centered title.
  const grip = (
    <span
      aria-hidden
      data-slot="event-calendar-resize-grip"
      className={cn(
        "bg-foreground/40 rounded-full",
        timedBlock ? "h-0.5 w-2.5" : "h-2.5 w-0.5",
        viewConfig.classNames?.resizeGrip
      )}
    />
  )
  // QUINCY (#219 PR B stage 3): each grip is gated on its OWN edge. `showResize` still covers the
  // whole-event cases (interactions.resize, readOnly, resizable: false); `canResizeEdge` narrows
  // it per edge so a locked edge draws no grip. The gesture entry refuses it as well — see
  // `beginResize` in event-calendar-dnd.tsx.
  const resizeHandles = showResize && (
    <>
      {timedBlock && segment.isStart && gestures.canResizeEdge(segment, "start") && (
        <span
          data-slot="event-calendar-resize-handle"
          data-edge="start"
          data-testid="event-calendar-resize-handle-start"
          className={cn(
            "absolute inset-x-1 top-0 flex h-1.5 cursor-ns-resize items-center justify-center opacity-0 transition-opacity duration-150 group-hover/ec-event:opacity-100",
            viewConfig.classNames?.resizeHandle
          )}
          onPointerDown={(e) => gestures.beginResize(e, segment, "start")}
        >
          {grip}
        </span>
      )}
      {timedBlock && segment.isEnd && gestures.canResizeEdge(segment, "end") && (
        <span
          data-slot="event-calendar-resize-handle"
          data-edge="end"
          data-testid="event-calendar-resize-handle-end"
          className={cn(
            "absolute inset-x-1 bottom-0 flex h-1.5 cursor-ns-resize items-center justify-center opacity-0 transition-opacity duration-150 group-hover/ec-event:opacity-100",
            viewConfig.classNames?.resizeHandle
          )}
          onPointerDown={(e) => gestures.beginResize(e, segment, "end")}
        >
          {grip}
        </span>
      )}
      {(horizontalBar || (isBar && inTimeGrid)) && segment.isStart && gestures.canResizeEdge(segment, "start") && (
        <span
          data-slot="event-calendar-resize-handle"
          data-edge="start"
          data-testid="event-calendar-resize-handle-start"
          className={cn(
            "absolute inset-y-0 start-0 flex w-2 cursor-ew-resize items-center justify-center opacity-0 transition-opacity duration-150 group-hover/ec-event:opacity-100",
            viewConfig.classNames?.resizeHandle
          )}
          onPointerDown={(e) => gestures.beginResize(e, segment, "start")}
        >
          {grip}
        </span>
      )}
      {(horizontalBar || (isBar && inTimeGrid)) && segment.isEnd && gestures.canResizeEdge(segment, "end") && (
        <span
          data-slot="event-calendar-resize-handle"
          data-edge="end"
          data-testid="event-calendar-resize-handle-end"
          className={cn(
            "absolute inset-y-0 end-0 flex w-2 cursor-ew-resize items-center justify-center opacity-0 transition-opacity duration-150 group-hover/ec-event:opacity-100",
            viewConfig.classNames?.resizeHandle
          )}
          onPointerDown={(e) => gestures.beginResize(e, segment, "end")}
        >
          {grip}
        </span>
      )}
    </>
  )

  const defaultProps = {
    type: "button" as const,
    "data-slot": "event-calendar-event",
    "data-view": view,
    "data-all-day": occurrence.allDay || undefined,
    "data-recurring": occurrence.isRecurring || undefined,
    "data-selected": isSelected || undefined,
    "data-dragging": isDragging || undefined,
    "data-preview": preview || undefined,
    "data-past": occurrence.end.getTime() < Date.now() || undefined,
    title: preview || tooltipOn ? undefined : label,
    "aria-label":
      settings.i18n.functions.formatEventAriaLabel?.(
        event.title,
        timeLabel,
        segment.continuesBefore || segment.continuesAfter
      ) ??
      `${event.title}, ${timeLabel}${
        segment.continuesBefore || segment.continuesAfter
          ? `, ${settings.i18n.labels.continues}`
          : ""
      }`,
    // A background tint alone conveys selection, so the chip is a real toggle
    // wherever it is interactive (agenda rows never select, previews are inert).
    "aria-pressed": interactive ? isSelected : undefined,
    "aria-hidden": preview || undefined,
    tabIndex: preview ? -1 : undefined,
    // QUINCY (#240): how the Adjust session finds this event's chip again after a commit moves
    // it to another cell or column (a different element). Vendored-tree-only, per Detector 9.
    "data-ec-event-id": String(event.id),
    "data-adjusting": isAdjusting || undefined,
    "aria-keyshortcuts": adjustable ? "Space" : undefined,
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      // QUINCY (#240): Space opens the keyboard Adjust session (the Gantt's grammar, ADR 0009).
      // Everything after that is read on `window` by the session itself, because the view may
      // follow the move and unmount this chip. An event nothing can adjust leaves Space alone,
      // so it keeps its native activate.
      if (!adjustable || isAdjusting || e.target !== e.currentTarget) return
      if (matchAdjustKey(e, false, false)?.type !== "enter") return
      if (gestures.beginAdjust(segment, e.currentTarget)) e.preventDefault()
    },
    style: {
      "--ec-event-color": event.color ?? "var(--color-primary)",
    } as CSSProperties,
    onPointerDown: (e: React.PointerEvent) => {
      e.stopPropagation()
      // suppress the trailing slot-create click when this press yields no drag
      markChipPress()
      if (interactive) gestures.beginMove(e, segment)
    },
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation()
      if (wasRecentDrag()) return
      // consumer first: e.preventDefault() opts out of built-in selection
      settings.onEventClick?.(occurrence, e)
      // the agenda is a read-only list: a click never selects/focuses a row
      if (e.defaultPrevented || view === "agenda") return
      instance.api.selectEvent(occurrence.key)
    },
    onDoubleClick: (e: React.MouseEvent) => {
      e.stopPropagation()
      settings.onEventDoubleClick?.(occurrence, e)
    },
    className: cn(
      "group/ec-event text-foreground relative flex w-full min-w-0 cursor-pointer touch-none items-center overflow-hidden text-start select-none",
      preview && "pointer-events-none",
      view === "agenda"
        ? // plain list row: color lives in the dot badge, not a tinted pill;
          // hover AND selection surfaces are owned by the agenda row wrapper
          // QUINCY: rounded-sm, matching the grid chips — one radius across the chip family.
          "gap-3 rounded-sm text-sm"
        : cn(
            // @container removes intrinsic sizing; only grid chips are containers
            // py-1: room above/below inline badges (attendee pill etc.)
            "@container gap-1.5 rounded-sm px-1.5 py-1 leading-normal",
            // soft tint + inset ring, not an accent border
            // QUINCY: the `dark:` lift that sat here is gone. Quincy has no `dark:` variant —
            // a dark surface is `[data-surface="inverse"]`, which re-scopes the tokens
            // themselves, so a variant keyed on the `dark` class could only ever be dead code
            // that silently comes alive if someone adds that class.
            "bg-(--ec-event-color)/15 hover:bg-(--ec-event-color)/25",
            "inset-ring inset-ring-(--ec-event-color)/15",
            "transition-[background-color,box-shadow] duration-150",
            "data-dragging:opacity-40",
            "data-selected:bg-(--ec-event-color)/30 data-selected:inset-ring-(--ec-event-color)/40",
            segment.continuesBefore && "rounded-s-none",
            segment.continuesAfter && "rounded-e-none"
          ),
      // QUINCY ADDITION (#219 PR B): per-chip consumer classes — "dimmed done tasks". Before
      // `classNames.event` so a blanket override still wins; see the hook's doc on viewConfig.
      viewConfig.eventClassName?.(occurrence),
      viewConfig.classNames?.event,
      className
    ),
    children: (
      <>
        {content}
        {resizeHandles}
      </>
    ),
  }

  const chip = useRender({
    defaultTagName: "button",
    render,
    props: mergeProps<"button">(defaultProps, props),
  })

  return (
    <EventCalendarChipContext.Provider
      value={{ occurrence, segment, isDragging, isSelected }}
    >
      {tooltipOn ? (
        <TooltipProvider delay={tooltipOpts?.delay ?? 600}>
          <Tooltip>
            <TooltipTrigger render={chip} />
            <TooltipContent
              side={tooltipOpts?.side ?? "top"}
              className={viewConfig.classNames?.eventTooltip}
            >
              {tooltipContent}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        chip
      )}
    </EventCalendarChipContext.Provider>
  )
}

export {
  EVENT_CALENDAR_FADE_TRUNCATE,
  EVENT_CALENDAR_GHOST,
  EVENT_CALENDAR_SLOT_DRAFT,
  EventCalendarEvent,
  useEventCalendarEventChip,
}
export type { EventCalendarChipContextValue, EventCalendarEventProps }