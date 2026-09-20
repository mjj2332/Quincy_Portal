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
 * NOTHING ELSE changed. Diffed against the sandbox's own `src/components/vendor-219/<name>.tsx`
 * output, every line differs only in one of the three ways above.
 *
 * No production code imports this tree yet — `src/harness/harness-reachability.guard.test.ts`
 * makes that a build failure rather than a bug report, and the dev-only harness at
 * `src/harness/reui-scheduling/` is the only thing that renders it, with local fixture data.
 *
 * This file: the interactive bar — selection, the resize grips, the recurrence/completion
 * indicators, and the context menu. Two `IconPlaceholder`s resolved by `add`, matching each
 * placeholder's own `lucide=` prop (verified against the unprocessed registry JSON): `RepeatIcon`
 * (recurrence indicator) and `CheckIcon` (completion indicator).
 *
 * #219 stage 2 (PR A) edits, both additive:
 * 1. The single `showResize`-gated grip pair became two independently-gated grips, each checked
 *    against `gantt-dnd.tsx`'s edge-aware `canResize(segment, edge)` (owner decision on #215 — a
 *    project bar's shoot/start edge is fixed, only the deadline/end edge drags). Also added a
 *    `data-testid` on each grip (`gantt-resize-handle-start` / `-end`), additive: nothing
 *    Quincy-owned composes this deep inside the vendor's own render tree for a DOM test to hook a
 *    `data-testid` onto from the outside (unlike `<GanttBar>` itself, whose consumer props already
 *    reach the outer `<button>`), so `test-seam.guard.test.ts` Guard F's own suggested fix — "add a
 *    data-testid to the Quincy component that composes the vendor primitive" — has no Quincy
 *    component to add it to at this granularity. A minimal additive `data-testid` here is the
 *    honest hook; it is not `data-slot`, so Guard F (which governs `[data-slot=…]` selectors
 *    specifically) does not apply to it either way.
 * 2. Added keyboard move/resize (upstream has no keyboard path for either pointer gesture):
 *    `onKeyDown` (composed with any consumer handler via `mergeProps`, never replacing it) reads
 *    `Alt+ArrowLeft/Right` (move), `Shift+Alt+ArrowLeft/Right` (resize the end edge) and
 *    `Ctrl+Alt+ArrowLeft/Right` (resize the start edge), RTL-aware the same way the splitter's key
 *    handler in `gantt-view.tsx` does, and calls `gantt.tsx`'s new `nudgeEvent`. `aria-keyshortcuts`
 *    advertises only the chords permitted for THAT bar. The outcome announces through the gantt
 *    root's existing `[data-slot=gantt-announcer]` live region (found by DOM query from the bar,
 *    the same way `gantt-dnd.tsx`'s `beginGesture` already finds it for a pointer drag) — one
 *    region, reused, not one per bar.
 *
 *    `pendingKeyboardFocusEventId` below is the one non-obvious piece: `gantt-view.tsx` keys each
 *    bar's wrapping element on `segment.occurrence.key`, which embeds the occurrence's OWN start
 *    time (`gantt-lib.tsx`'s `buildEventIndex`). A move or a resize-start nudge changes `start`,
 *    which changes that key, which makes REACT UNMOUNT AND REMOUNT THE BAR — a real DOM node swap
 *    that drops browser focus with no help from React. (A resize-end nudge does not change `start`,
 *    so its key is stable and focus survives on its own — this module-level hand-off exists only
 *    for the other two actions.) Recording the nudged event's id here and refocusing the matching
 *    bar in a `useEffect` on its NEXT mount is the smallest fix that stays inside this file, in the
 *    same spirit as `gantt-dnd.tsx`'s own module-level `lastGestureEndedAt` flag.
 *
 * #219 PR A fix (Sol review, sol1 item 5): a matched chord is now gated on the SAME
 * `canMove`/`canResizeStart`/`canResizeEnd` flags `aria-keyshortcuts` is built from, BEFORE
 * `preventDefault`/`nudgeEvent` — see the `onKeyDown` handler's own comment at that gate for why
 * `nudgeEvent` alone cannot substitute for it (it has no notion of which edge THIS segment owns).
 *
 * #219 PR A fix (Sol review, sol1 item 7): the success announcement above reads
 * `result.start`/`result.end`/`result.allDay` — the range `nudgeEvent` itself just accepted —
 * instead of a follow-up `instance.api.getEvent(event.id)` call. That re-fetch read STALE data
 * under a controlled `events` prop: `gantt.tsx`'s `setField` never mutates internal state on the
 * controlled path, so until the parent's own `onEventsChange`-driven re-render lands (which has
 * not happened yet — this is still the same synchronous keydown handler that just queued it), a
 * `getEvent` call sees the OLD range. See `gantt.tsx`'s `applyProposedUpdate` header for the other
 * half of this fix (it now returns the accepted range itself, not a bare `boolean`).
 *
 * #219 stage 3 (PR A) edit, additive: `data-completed` bars (progress === 100) get a reduced-
 * emphasis fill — the outer shell's tint drops from `/20` (`/30` on hover) to `/10` (`/15` on
 * hover), and the progress-fill child's own tint drops from `/40` (border `/65`) to `/20` (border
 * `/35`) via `group-data-completed/gantt-bar-group:`. The label's `text-foreground` is left alone
 * on purpose: lowering a translucent accent fill's own alpha can only move the composited
 * background CLOSER to the light canvas underneath, which can only RAISE contrast against a fixed
 * dark label — so this dimming is safe by construction, whereas swapping the label itself to
 * `text-foreground-secondary` was checked and rejected (worst case, a dark stage colour like
 * oxblood at the OLD pre-dim /20+/40 compounded fill measured ~3.2:1 for that lighter role, under
 * the 4.5:1 floor — `text-foreground` measured ~7.2:1 in the same worst case). `data-past` is
 * untouched: an overdue unfinished task must not read as de-emphasised.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import {
  useGantt,
  useGanttSelector,
  useGanttViewConfig,
} from "@/components/reui/gantt/gantt"
import {
  useGanttGestures,
  wasRecentDrag,
} from "@/components/reui/gantt/gantt-dnd"
import {
  flattenResources,
  getBaselineVariance,
  resolveEventBaseline,
  toZoned,
} from "@/components/reui/gantt/gantt-lib"
import type {
  GanttOccurrence,
  GanttSegment,
} from "@/components/reui/gantt/gantt-types"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"

import { cn } from "@/lib/utils"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/reui/context-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/reui/tooltip"
import { RepeatIcon, CheckIcon } from "lucide-react"

/** Which of the three keyboard chords (if any) a keydown matches. */
type GanttBarKeyChord = "move" | "resize-start" | "resize-end"

/**
 * Alt+ArrowLeft/Right = move, Shift+Alt+ArrowLeft/Right = resize the END edge,
 * Ctrl+Alt+ArrowLeft/Right = resize the START edge. Meta+Alt+Arrow (Cmd on
 * macOS) never matches - that chord space belongs to the OS. Shift+Ctrl
 * together matches neither (ambiguous, and none of the three chords needs
 * both modifiers at once).
 */
function matchGanttBarKeyChord(e: {
  key: string
  altKey: boolean
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}): GanttBarKeyChord | null {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return null
  if (!e.altKey || e.metaKey) return null
  if (e.shiftKey && e.ctrlKey) return null
  if (e.shiftKey) return "resize-end"
  if (e.ctrlKey) return "resize-start"
  return "move"
}

/**
 * Logical time-axis direction (-1 earlier, +1 later) for an ArrowLeft/Right
 * key, RTL-aware the same way the splitter's key handler in `gantt-view.tsx`
 * (`~:2744`) is: physical ArrowLeft/Right, mirrored by `direction: rtl`.
 */
function ganttArrowDirection(key: "ArrowLeft" | "ArrowRight", rtl: boolean): -1 | 1 {
  const physical = key === "ArrowLeft" ? -1 : 1
  return (rtl ? -physical : physical) as -1 | 1
}

/**
 * `aria-keyshortcuts` value: only the chords permitted for THIS bar, or `undefined` for none.
 * `isRecurring` always wins to `undefined` - Quincy fix (#219 PR A, Sol review, sol1 item 2):
 * `nudgeEvent` has no occurrence-aware exception semantics yet (see `gantt.tsx`'s own doc comment
 * on it), so a recurring occurrence's bar must neither advertise nor act on a keyboard nudge - it
 * would silently rewrite the SERIES MASTER, not just this occurrence.
 */
function buildGanttBarKeyShortcuts(
  canMove: boolean,
  canResizeStart: boolean,
  canResizeEnd: boolean,
  isRecurring: boolean
): string | undefined {
  if (isRecurring) return undefined
  const chords: string[] = []
  if (canMove) chords.push("Alt+ArrowLeft", "Alt+ArrowRight")
  if (canResizeStart) chords.push("Control+Alt+ArrowLeft", "Control+Alt+ArrowRight")
  if (canResizeEnd) chords.push("Shift+Alt+ArrowLeft", "Shift+Alt+ArrowRight")
  return chords.length > 0 ? chords.join(" ") : undefined
}

/**
 * The event id whose bar should reclaim focus on its NEXT mount - see this file's header for why
 * a move / resize-start nudge needs this (the occurrence key it commits under changes, so React
 * remounts the bar and drops focus with no help from React). A single module-level slot is enough:
 * only one bar can be focused, and the flag is consumed (set back to `null`) the instant a mount
 * claims it.
 */
let pendingKeyboardFocusEventId: string | null = null

/**
 * Effective Tailwind palette presets for bar colors; every entry works on
 * light and dark surfaces through the bar's alpha background + accent border.
 */
const GANTT_COLORS: Array<{ name: string; value: string }> = [
  { name: "Blue", value: "var(--color-blue-500)" },
  { name: "Emerald", value: "var(--color-emerald-500)" },
  { name: "Violet", value: "var(--color-violet-500)" },
  { name: "Rose", value: "var(--color-rose-500)" },
  { name: "Amber", value: "var(--color-amber-500)" },
  { name: "Cyan", value: "var(--color-cyan-500)" },
  { name: "Orange", value: "var(--color-orange-500)" },
  { name: "Pink", value: "var(--color-pink-500)" },
  { name: "Teal", value: "var(--color-teal-500)" },
  { name: "Indigo", value: "var(--color-indigo-500)" },
]

interface GanttBarContextValue<TData = unknown> {
  occurrence: GanttOccurrence<TData>
  segment: GanttSegment<TData>
  isDragging: boolean
  isSelected: boolean
}

const GanttBarContext =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createContext<GanttBarContextValue<any> | null>(null)

/** The bar's subject; usable inside renderEvent content and bar children. */
function useGanttBarContext<TData = unknown>(): GanttBarContextValue<TData> {
  const ctx = useContext(GanttBarContext)
  if (!ctx) {
    throw new Error("useGanttBarContext must be used within <GanttBar>")
  }
  return ctx as GanttBarContextValue<TData>
}

interface GanttBarProps<TData = unknown> extends Omit<
  useRender.ComponentProps<"button">,
  "children"
> {
  segment: GanttSegment<TData>
  /** Replaces the default bar CONTENT; the wrapper stays gantt-owned. */
  children?: ReactNode
  /**
   * The title renders beside the bar (view-owned), so the default inner
   * content is suppressed. Explicit children and renderEvent still win.
   */
  labelOutside?: boolean
  /**
   * The owning row's title for the aria-label. Pass it when the row is in
   * scope (the internal view does); omitting falls back to a tree lookup.
   */
  rowTitle?: string
}

/**
 * The one interactive bar element. The wrapper owns positioning hooks, a11y,
 * selection, drag/resize listeners, and data attributes; content comes from
 * children, the root renderEvent override, or the built-in default.
 */
function GanttBar<TData = unknown>({
  segment,
  className,
  render,
  children,
  labelOutside,
  rowTitle: rowTitleProp,
  ...props
}: GanttBarProps<TData>) {
  const instance = useGantt<TData>()
  const viewConfig = useGanttViewConfig<TData>()
  const gestures = useGanttGestures<TData>()
  const { settings } = instance
  const occurrence = segment.occurrence
  const event = occurrence.event

  // Reclaims focus after a move / resize-start nudge remounts this bar under
  // a new occurrence key - see this file's header for why. A resize-end
  // nudge never sets `pendingKeyboardFocusEventId` (its key is stable, so
  // this effect has nothing to do), and any OTHER bar's mount ignores an id
  // that is not its own.
  const barRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (pendingKeyboardFocusEventId !== event.id) return
    pendingKeyboardFocusEventId = null
    barRef.current?.focus({ preventScroll: true })
  }, [event.id])

  const isSelected = useGanttSelector<TData, boolean>(
    (state) => state.selection.eventKeys.includes(occurrence.key),
    { calendar: instance }
  )
  const isDragging = useGanttSelector<TData, boolean>(
    (state) => state.drag?.occurrence.key === occurrence.key,
    { calendar: instance }
  )
  // Which gesture owns this bar: a move hides the original (the smooth clone
  // stands in for it); a resize keeps it as a faint placeholder behind the
  // dashed preview so you can see the original extent.
  const dragKind = useGanttSelector<TData, string | null>(
    (state) =>
      state.drag?.occurrence.key === occurrence.key ? state.drag.kind : null,
    { calendar: instance }
  )
  // Hover-only range tooltip. Focus opens are ignored (the known button+
  // tooltip flash: clicking a bar opens a dialog, focus returns, and a
  // focus-triggered tooltip would pop). Hidden while dragging/resizing.
  const [tipOpen, setTipOpen] = useState(false)
  // Gated on tipOpen: with the tooltip closed the selector returns a stable
  // false, so gesture start/end doesn't re-render every mounted bar.
  const anyInteracting = useGanttSelector<TData, boolean>(
    (state) => tipOpen && (state.drag !== null || state.slotDraft !== null),
    { calendar: instance }
  )

  const progress =
    typeof event.progress === "number"
      ? Math.min(Math.max(Math.round(event.progress), 0), 100)
      : null

  // A zero-duration occurrence is a MILESTONE: the button stays the
  // interactive shell (click, select, menu, move), the diamond replaces the
  // tinted bar body, and the view keeps the title outside.
  const milestone = occurrence.end.getTime() === occurrence.start.getTime()

  // The bar only LABELS its baseline (attributes, tooltip, aria); the ghost
  // itself is view-owned chrome, because its range differs from this bar's.
  const baseline = viewConfig.baselineBars ? resolveEventBaseline(event) : null
  const baselineVariance = baseline ? getBaselineVariance(event) : null

  const defaultContent = (
    <>
      {occurrence.isRecurring && (
        <RepeatIcon className="size-2.5 shrink-0 opacity-70" aria-hidden="true" />
      )}
      <span className="truncate font-medium">{event.title}</span>
      {!occurrence.allDay && segment.isStart && (
        <span className="text-muted-foreground hidden truncate @[8rem]:inline">
          {settings.i18n.functions.formatEventTime(
            toZoned(occurrence.start, settings.timeZone),
            toZoned(occurrence.end, settings.timeZone),
            occurrence.allDay,
            settings.locale
          )}
        </span>
      )}
    </>
  )

  const renderProps = { occurrence, segment, isDragging, isSelected }
  const content =
    children ??
    viewConfig.renderEvent?.(renderProps) ??
    (labelOutside || milestone ? null : defaultContent)
  // Consumer-owned content owns the WHOLE inner visualization: the built-in
  // progress fill and done mark yield so custom bars start from a blank
  // canvas (progress stays readable via data-progress/data-completed).
  const consumerOwnsContent = children !== undefined || !!viewConfig.renderEvent

  const timeLabel = settings.i18n.functions.formatEventTime(
    toZoned(occurrence.start, settings.timeZone),
    toZoned(occurrence.end, settings.timeZone),
    occurrence.allDay,
    settings.locale
  )
  // Memoized: a second full formatEventTime per render would double the
  // bar's formatting cost, and it cannot wait for the tooltip because the
  // label also feeds aria-label. Keyed on the instants, not the baseline
  // object - resolveEventBaseline allocates a fresh one every render.
  const baselineStartMs = baseline?.start.getTime()
  const baselineEndMs = baseline?.end.getTime()
  const plannedLabel = useMemo(
    () =>
      baselineStartMs === undefined || baselineEndMs === undefined
        ? undefined
        : settings.i18n.labels.planned(
            settings.i18n.functions.formatEventTime(
              toZoned(new Date(baselineStartMs), settings.timeZone),
              toZoned(new Date(baselineEndMs), settings.timeZone),
              occurrence.allDay,
              settings.locale
            )
          ),
    [
      baselineStartMs,
      baselineEndMs,
      occurrence.allDay,
      settings.i18n,
      settings.timeZone,
      settings.locale,
    ]
  )
  // name the row too: the split-pane layout carries no grid semantics.
  // The prop path is O(1); the lookup fallback is memoized so external
  // GanttBar usage never flattens the tree per render.
  const fallbackRowTitle = useMemo(
    () =>
      rowTitleProp === undefined && event.resourceId
        ? flattenResources(settings.resources).find(
            ({ resource }) => resource.id === event.resourceId
          )?.resource.title
        : undefined,
    [rowTitleProp, event.resourceId, settings.resources]
  )
  const rowTitle = rowTitleProp ?? fallbackRowTitle

  // Each grip is gated on ITS OWN edge, not "does this bar resize at all":
  // a start-locked bar (owner decision on #215 — a project bar's shoot/start
  // edge is fixed) draws no start grip while its end grip still works. The
  // same three flags gate the keyboard chords below and aria-keyshortcuts.
  const canMove = gestures.canDrag(segment)
  const canResizeStart = segment.isStart && gestures.canResize(segment, "start")
  const canResizeEnd = segment.isEnd && gestures.canResize(segment, "end")
  const keyShortcuts = buildGanttBarKeyShortcuts(
    canMove,
    canResizeStart,
    canResizeEnd,
    occurrence.isRecurring
  )
  const resizeHandles = (canResizeStart || canResizeEnd) && (
    <>
      {canResizeStart && (
        <span
          data-slot="gantt-resize-handle"
          data-edge="start"
          data-testid="gantt-resize-handle-start"
          // grip hugs the start edge (justify-start + tight inset) so the
          // indicator reads as "resize this end", not a centered pill.
          // pointer-coarse keeps it visible on touch, where hover never fires
          className="absolute inset-y-0 start-0.5 flex w-2 cursor-ew-resize items-center justify-start opacity-0 group-hover/gantt-bar-group:opacity-100 pointer-coarse:opacity-100"
          onPointerDown={(e) => gestures.beginResize(e, segment, "start")}
        >
          <span
            aria-hidden
            className="bg-foreground/40 h-2.5 w-0.5 rounded-full"
          />
        </span>
      )}
      {canResizeEnd && (
        <span
          data-slot="gantt-resize-handle"
          data-edge="end"
          data-testid="gantt-resize-handle-end"
          // grip hugs the end edge (justify-end + tight inset) so the
          // indicator reads as "resize this end", not a centered pill.
          // pointer-coarse keeps it visible on touch, where hover never fires
          className="absolute inset-y-0 end-0.5 flex w-2 cursor-ew-resize items-center justify-end opacity-0 group-hover/gantt-bar-group:opacity-100 pointer-coarse:opacity-100"
          onPointerDown={(e) => gestures.beginResize(e, segment, "end")}
        >
          <span
            aria-hidden
            className="bg-foreground/40 h-2.5 w-0.5 rounded-full"
          />
        </span>
      )}
    </>
  )

  const defaultProps = {
    type: "button" as const,
    ref: barRef,
    "data-slot": "gantt-bar",
    "data-milestone": milestone || undefined,
    "data-all-day": occurrence.allDay || undefined,
    "data-recurring": occurrence.isRecurring || undefined,
    "data-selected": isSelected || undefined,
    "data-dragging": isDragging || undefined,
    "data-drag-kind": dragKind ?? undefined,
    "data-past": occurrence.end.getTime() < Date.now() || undefined,
    "data-label-outside": labelOutside || undefined,
    "data-progress": progress ?? undefined,
    "data-completed": progress === 100 || undefined,
    "data-baseline": !!baseline || undefined,
    "data-baseline-variance": baselineVariance ?? undefined,
    "aria-keyshortcuts": keyShortcuts,
    "aria-label": settings.i18n.functions.formatEventAriaLabel({
      title: event.title,
      timeLabel,
      milestoneLabel: milestone ? settings.i18n.labels.milestone : undefined,
      rowTitle,
      progressLabel:
        progress !== null ? settings.i18n.labels.progress(progress) : undefined,
      plannedLabel,
      continues: segment.continuesBefore || segment.continuesAfter,
    }),
    style: {
      "--gantt-event-color": event.color ?? "var(--color-primary)",
    } as CSSProperties,
    onPointerDown: (e: React.PointerEvent) => {
      e.stopPropagation()
      gestures.beginMove(e, segment)
    },
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation()
      if (wasRecentDrag()) return
      instance.api.selectEvent(occurrence.key)
      settings.onEventClick?.(occurrence, e)
    },
    onDoubleClick: (e: React.MouseEvent) => {
      e.stopPropagation()
      settings.onEventDoubleClick?.(occurrence, e)
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const chord = matchGanttBarKeyChord(e)
      if (!chord) return
      // Quincy fix (#219 PR A, Sol review, sol1 item 2): a chord can still MATCH here even though
      // a recurring occurrence advertises none (aria-keyshortcuts and the matcher are independent)
      // - this bar must not act on it either, for the same reason it does not advertise it.
      if (occurrence.isRecurring) return
      // Quincy fix (#219 PR A, Sol review, sol1 item 5): gate on the SAME canMove/canResizeStart/
      // canResizeEnd flags aria-keyshortcuts advertises, BEFORE preventDefault/nudgeEvent - a
      // clipped edge (segment.isStart/isEnd false, a multi-day bar cut off at the viewport edge)
      // omits a chord from aria-keyshortcuts for a reason nudgeEvent cannot see: it operates on
      // the EVENT's own resizableEdges, not on which edge THIS rendered segment owns. Without this
      // gate, a chord not advertised here could still fire and resize the wrong edge of the event.
      if (chord === "move" && !canMove) return
      if (chord === "resize-start" && !canResizeStart) return
      if (chord === "resize-end" && !canResizeEnd) return
      // preventDefault only for a chord that is actually ours - Alt+Arrow
      // etc. otherwise falls through to whatever else is listening
      e.preventDefault()
      const rtl = getComputedStyle(e.currentTarget).direction === "rtl"
      const direction = ganttArrowDirection(
        e.key as "ArrowLeft" | "ArrowRight",
        rtl
      )
      // Quincy fix (#219 PR A, Sol review, sol1 item 3): pass the effective view-level
      // scheduleMode through explicitly - nudgeEvent is a store-level method with no component
      // in its call stack to read useGanttViewConfig() from itself.
      const result = instance.api.nudgeEvent(
        event.id,
        chord,
        direction,
        viewConfig.scheduleMode
      )
      // A move or resize-start commit changes this occurrence's key (see
      // this file's header) - claim the hand-off BEFORE the remount so the
      // next bar mounted for this event id reclaims focus.
      if (result.applied && chord !== "resize-end") {
        pendingKeyboardFocusEventId = event.id
      }
      const ganttRoot = e.currentTarget.closest<HTMLElement>(
        "[data-slot=gantt]"
      )
      const announcer = ganttRoot?.querySelector<HTMLElement>(
        "[data-slot=gantt-announcer]"
      )
      if (!announcer) return
      if (result.applied) {
        // Quincy fix (#219 PR A, Sol review, sol1 item 7): announce from the result's OWN
        // accepted range, not a follow-up `api.getEvent` re-fetch - under a controlled `events`
        // prop that read the OLD range synchronously, before the parent's state update (queued by
        // this same nudge, via onEventsChange) had landed. See `gantt.tsx`'s `applyProposedUpdate`
        // header for the full mechanics. `result.start`/`end` are always set when `applied` is true.
        announcer.textContent = `${event.title}, ${settings.i18n.functions.formatEventTime(
          toZoned(result.start!, settings.timeZone),
          toZoned(result.end!, settings.timeZone),
          result.allDay ?? false,
          settings.locale
        )}`
        return
      }
      if (result.reason === "locked") {
        announcer.textContent = settings.i18n.labels.keyboardNudgeLocked
      } else if (result.reason === "invalid") {
        announcer.textContent = settings.i18n.labels.keyboardNudgeInvalid
      } else if (result.reason === "rejected") {
        announcer.textContent = settings.i18n.labels.keyboardNudgeRejected
      }
      // "not-found" is defensive only - a bar always names a real event id.
    },
    className: cn(
      "group/gantt-bar-group text-foreground @container relative flex w-full min-w-0 cursor-pointer touch-none items-center gap-1.5 overflow-hidden rounded-sm px-1.5 py-0.5 text-start leading-normal select-none",
      "focus-visible:ring-ring/50 outline-none focus-visible:ring-2",
      // the unfilled remainder has to be legible on its own - at /12 a bar
      // with a progress fill read as a floating segment with no basement
      "bg-(--gantt-event-color)/20 hover:bg-(--gantt-event-color)/30",
      // done: reduced emphasis, never reduced legibility - the label stays
      // text-foreground (see this file's header), only the tint itself
      // fades, which can only raise contrast against that fixed dark label
      "data-completed:bg-(--gantt-event-color)/10 data-completed:hover:bg-(--gantt-event-color)/15",
      // move: hide the original (the smooth cursor clone represents it)
      "data-[drag-kind=move]:opacity-0",
      // resize: keep the original event exactly, just fade it to a soft
      // placeholder behind the dashed preview - no dramatic restyle
      "data-[drag-kind=resize-start]:opacity-40 data-[drag-kind=resize-end]:opacity-40",
      "data-selected:bg-(--gantt-event-color)/30",
      /* the diamond is the milestone's body, so the shell sheds its own
         tinted fill and centers the glyph on the instant */
      milestone &&
        "justify-center bg-transparent px-0 hover:bg-transparent data-selected:bg-transparent",
      segment.continuesBefore && "rounded-s-none",
      segment.continuesAfter && "rounded-e-none",
      viewConfig.classNames?.event,
      className
    ),
    children: (
      <>
        {milestone && !consumerOwnsContent && (
          // the filled diamond IS the milestone's body - chrome, so a custom
          // renderEvent still starts from a blank canvas (data-milestone
          // keeps the fact readable there)
          <span
            aria-hidden
            data-slot="gantt-bar-milestone"
            className={cn(
              "size-2.5 shrink-0 rotate-45 rounded-[2px] border border-(--gantt-event-color) bg-(--gantt-event-color)/80",
              isSelected && "ring-ring/50 ring-2"
            )}
          />
        )}
        {progress !== null && !milestone && (
          // Chrome, not content: it is an absolutely-positioned layer BEHIND
          // whatever the bar renders, so a consumer bar (renderEvent) keeps
          // its completion fill instead of silently losing it. The inline
          // done-mark below stays gated, because that one really is content.
          <span
            aria-hidden
            data-slot="gantt-bar-progress"
            className={cn(
              "pointer-events-none absolute inset-y-0 start-0 border-e border-(--gantt-event-color)/65 bg-(--gantt-event-color)/40 data-full:border-e-0",
              // done: same reduced-emphasis fill as the shell above, read off
              // the ancestor's data-completed (this span carries no attribute
              // of its own) via the shell's named group
              "group-data-completed/gantt-bar-group:border-(--gantt-event-color)/35 group-data-completed/gantt-bar-group:bg-(--gantt-event-color)/20"
            )}
            data-full={progress === 100 || undefined}
            style={{ width: `${progress}%` }}
          />
        )}
        {progress === 100 && !consumerOwnsContent && !milestone && (
          // done mark: completion chrome like the fill itself, so it shows
          // for outside-label bars too (where the inner content is empty)
          <CheckIcon className="relative size-2.5 shrink-0 opacity-80" aria-hidden="true" />
        )}
        {content}
        {resizeHandles}
      </>
    ),
  }

  const barButton = useRender({
    defaultTagName: "button",
    render,
    props: mergeProps<"button">(defaultProps, props),
  })

  // Consumer-owned right-click menu (headless): the primitive only wires the
  // ContextMenu; the items and their handlers come entirely from the block.
  const menu = viewConfig.renderEventMenu?.(renderProps)

  // The bar is simultaneously the tooltip trigger and (when a menu exists)
  // the context-menu trigger; Base UI composes both via render props.
  const trigger = menu ? (
    <ContextMenuTrigger render={<TooltipTrigger render={barButton} />} />
  ) : (
    <TooltipTrigger render={barButton} />
  )

  const barTree = (
    <TooltipProvider delay={500} closeDelay={0} timeout={300}>
      <Tooltip
        open={tipOpen && !anyInteracting}
        onOpenChange={(next: boolean, details: { reason?: string }) => {
          // opens only on hover; focus/press opens are dropped
          if (next && details?.reason !== "trigger-hover") return
          setTipOpen(next)
        }}
      >
        {trigger}
        {tipOpen && !anyInteracting && (
          <TooltipContent side="top" className="pointer-events-none">
            <div className="font-medium">{event.title}</div>
            <div className="opacity-80">{timeLabel}</div>
            {plannedLabel && <div className="opacity-80">{plannedLabel}</div>}
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  )

  return (
    <GanttBarContext.Provider
      value={{ occurrence, segment, isDragging, isSelected }}
    >
      {menu ? (
        <ContextMenu>
          {barTree}
          <ContextMenuContent data-slot="gantt-bar-menu" className="min-w-44">
            {menu}
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        barTree
      )}
    </GanttBarContext.Provider>
  )
}

export { GANTT_COLORS, GanttBar, useGanttBarContext }
export type { GanttBarContextValue, GanttBarProps }
