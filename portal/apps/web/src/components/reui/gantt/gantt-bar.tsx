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
 * #219 PR A fix (Sol review, sol1 item 6), three parts:
 * 1. The focus hand-off token moved to `instance.internals.claimKeyboardFocus`/
 *    `consumeKeyboardFocus`/`clearKeyboardFocus` — see the module-level doc comment above (where
 *    `pendingKeyboardFocusEventId` used to live) and `gantt.tsx`'s own header for the full
 *    mechanics. `onKeyDown` clears any stale claim before processing a NEW chord; both
 *    `onPointerDown` handlers (the bar's own move, and each resize grip's) clear it too — a pointer
 *    interaction abandons whatever a previous keyboard nudge was waiting on.
 * 2. `ref: consumerRef` is now destructured OUT of the incoming props (see that destructure's own
 *    comment) and merged with `barRef` via `useRender`'s own `ref` parameter, instead of living in
 *    `defaultProps.ref` where `mergeProps(defaultProps, props)` would silently drop it the moment a
 *    consumer's JSX included a `ref` prop key at all (mergeProps does not treat `ref` specially -
 *    rightmost wins, same as any other plain key).
 * 3. The mount effect now checks the occurrence KEY too, not just the event id — closing a gap the
 *    module-level version never had to worry about (it only ever compared ids): the same event id
 *    rendered by two SEPARATE `<Gantt>` instances is now structurally impossible to confuse anyway
 *    (fix 1's per-instance store), but a DIFFERENT occurrence of the SAME event under the same
 *    instance is a real case the key check still guards.
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
 *
 * #219 PR A (Adjust mode) edit — replaces the whole Alt+Arrow / Shift+Alt+Arrow / Ctrl+Alt+Arrow
 * chord scheme above with a modal keyboard session (Opus and Sol both rejected the chords:
 * Ctrl+Alt+Arrow is OS-intercepted on some desktops, Alt+Arrow is browser Back/Forward):
 * - `matchGanttBarKeyChord` is GONE; `onKeyDown` now calls `gantt-lib.tsx`'s new
 *   `matchGanttBarKey(e, adjusting, rtl)` instead - one pure matcher for the WHOLE scheme (idle
 *   Space enters; while adjusting, Arrow/Shift+Arrow steps, M/S/E retargets, Enter/Space commits,
 *   Escape cancels). `adjusting` is read from `state.adjust` via `useGanttSelector`, keyed on
 *   `occurrence.key` the same way `isDragging`/`dragKind` already are.
 * - Space's "enter" match still gates on the SAME `canMove`/`canResizeStart`/`canResizeEnd` flags
 *   `aria-keyshortcuts` is built from (now just `"Space"`, not a per-chord list), plus
 *   `occurrence.isRecurring` - exactly the sol1 item 5/item 2 gating the old chords had, applied to
 *   the ONE new entry point instead of three. An INELIGIBLE Space is left un-prevented, so the
 *   button's native activate (open event) still fires - "Space keeps its current activate
 *   behaviour" per the spec.
 * - `step`/`retarget`/`commit`/`cancel` (while already adjusting) call the five `GanttInternals`
 *   Adjust methods (`gantt.tsx`) directly; a refused step reuses the EXISTING
 *   `keyboardNudgeLocked`/`Invalid`/`Rejected` announcements unchanged (same `proposeNudge` gate
 *   `nudgeEvent` uses), and a refused retarget announces the new `adjustTargetLocked` instead
 *   (a different failure shape: the target itself is unavailable, not a step within it).
 * - `role="application"`, `data-adjusting`, and `aria-describedby` (a visually-hidden `sr-only`
 *   span holding `i18n.labels.adjustInstructions`) are set only while THIS bar is the one
 *   adjusting. The bar itself never renders the moving/resizing PREVIEW - `stepAdjust` drives
 *   `state.drag` the same shape a pointer gesture's own `applyProposal` does, so `gantt-view.tsx`'s
 *   existing ghost (and this bar's own `data-drag-kind` fade, via the SAME `isDragging`/`dragKind`
 *   selectors a real drag already uses) renders it with no new preview surface. Quincy fix (#219 PR
 *   A, Sol re-review round 2, MEDIUM #7): the bar itself carries no Adjust-specific outline any
 *   more - it visually lost to the ordinary `focus-visible` ring even when visible, and a move
 *   gesture hides the bar entirely (opacity-0) while it still holds keyboard focus, showing nothing
 *   either way. `gantt-view.tsx`'s ghost, which is never hidden, carries `data-adjust-ghost` while
 *   it is keyboard-owned instead - see that file's own comment beside it.
 * - A commit that changes `start` (move, or a start-edge resize) claims the focus hand-off the same
 *   way a successful move/resize-start nudge always did, comparing the committed `start` against
 *   `occurrence.start` directly (NOT "was the last target resize-end" - Adjust mode's target can
 *   change mid-session via M/S/E, so only the ACTUAL net start delta says whether a remount, and
 *   therefore a refocus, is coming).
 * - Blur, or a `pointerdown` anywhere outside this bar (captured at `document` while adjusting),
 *   CANCELS - both re-read `instance.getState().adjust` live (not a closed-over boolean) rather
 *   than trust a stale render's `adjusting` prop, because a COMMIT that remounts this bar can fire
 *   a browser blur on the outgoing node with this component's LAST-rendered handler closure (still
 *   `adjusting: true`) - a stale-closure cancel here would silently overwrite the commit's own
 *   announcement with "cancelled" moments after a real write succeeded. `cancelAdjust` no-ops
 *   harmlessly on an already-empty session either way, but the announcement race is the real risk
 *   this guards.
 */

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
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
  matchGanttBarKey,
  resolveEventBaseline,
  toZoned,
} from "@/components/reui/gantt/gantt-lib"
import type {
  GanttNudgeAction,
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

/**
 * `aria-keyshortcuts` value while idle: `"Space"` when eligible for Adjust mode, `undefined`
 * otherwise. `isRecurring` always wins to `undefined` - Quincy fix (#219 PR A, Sol review, sol1
 * item 2): the store's Adjust methods have no occurrence-aware exception semantics yet (see
 * `gantt.tsx`'s doc comment on `nudgeEvent`, which `proposeNudge` - shared by Adjust mode's
 * `stepAdjust` - inherits), so a recurring occurrence's bar must neither advertise nor act on a
 * keyboard adjustment - it would silently rewrite the SERIES MASTER, not just this occurrence.
 * #219 PR A (Adjust mode): replaces the old per-chord list (`Alt+ArrowLeft Control+Alt+...` etc.)
 * with the single new entry point - one Space chord covers all three targets now.
 */
function buildGanttBarKeyShortcuts(
  canAdjust: boolean,
  isRecurring: boolean
): string | undefined {
  return canAdjust && !isRecurring ? "Space" : undefined
}

/**
 * Quincy fix (#219 PR A, Sol review, sol1 item 6): the keyboard focus hand-off's pending token USED
 * TO live in a module-level `pendingKeyboardFocusEventId` here - a single slot shared by EVERY
 * `<Gantt>` instance in the process, so two instances rendering the same event id could steal focus
 * from each other, and it held only the event id (not the exact target key), so an unrelated later
 * mount for that id could consume a claim that was never meant for it. It now lives on the owning
 * `<Gantt>` instance's own store (`gantt.tsx`'s `GanttInternals.claimKeyboardFocus`/
 * `consumeKeyboardFocus`/`clearKeyboardFocus` - see that file's header for the storage/staleness
 * mechanics), keyed on event id AND occurrence key together.
 */

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
  // Quincy fix (#219 PR A, Sol review, sol1 item 6): pulled out explicitly rather than left inside
  // `...props` - `@base-ui/react/merge-props`'s `mergeProps` does NOT merge `ref` (rightmost prop
  // wins like any other plain key), so `mergeProps(defaultProps, props)` below would silently
  // overwrite this component's own `barRef` with a consumer-supplied one (or with `undefined`, if
  // the consumer's JSX includes a `ref` prop key at all, even unset). Merged explicitly via
  // `useRender`'s own `ref` parameter instead, which DOES merge (see the `useRender(...)` call).
  ref: consumerRef,
  ...props
}: GanttBarProps<TData>) {
  const instance = useGantt<TData>()
  const viewConfig = useGanttViewConfig<TData>()
  const gestures = useGanttGestures<TData>()
  const { settings } = instance
  const occurrence = segment.occurrence
  const event = occurrence.event

  // Reclaims focus after a move / resize-start nudge remounts this bar under a new occurrence key
  // - see this file's header for why. A resize-end nudge never claims a token (its key is stable,
  // so this effect has nothing to do); any OTHER bar's mount (wrong event id, or the right id under
  // a different key) leaves a real pending claim untouched - `consumeKeyboardFocus` only clears on
  // an exact match.
  const barRef = useRef<HTMLButtonElement>(null)
  // Quincy fix (#219 PR A, Sol re-review round 2, MEDIUM #6): `useLayoutEffect`, not `useEffect` -
  // the reclaim must land, and the token must be consumed (nulled), synchronously in the SAME
  // commit that mounts this bar under its new key, before the browser paints and before any LATER
  // notify() could observe an unconsumed token past its one intended render - see
  // `gantt.tsx`'s `notify()` doc comment on the token's lifetime.
  useLayoutEffect(() => {
    if (instance.internals.consumeKeyboardFocus(event.id, occurrence.key)) {
      barRef.current?.focus({ preventScroll: true })
    }
  }, [instance, event.id, occurrence.key])

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
  // #219 PR A (Adjust mode) - this bar's own Adjust session, keyed on occurrence.key the same way
  // isDragging/dragKind are above (a session's `occurrence` never changes mid-session - see
  // gantt-types.tsx's GanttAdjustState doc comment - so this stays TRUE across every step/retarget
  // until commit/cancel, without racing the occurrence.key checks those selectors already do).
  const adjustTarget = useGanttSelector<TData, GanttNudgeAction | null>(
    (state) =>
      state.adjust?.occurrence.key === occurrence.key ? state.adjust.target : null,
    { calendar: instance }
  )
  const adjusting = adjustTarget !== null
  // #219 PR A fix (Sol re-review round 2, HIGH #3): set right before every LOCAL cancel/commit
  // call below, consumed by the owner-death effect further down - see that effect's own comment.
  const localTeardownRef = useRef(false)
  const wasAdjustingRef = useRef(adjusting)

  // Finds the ONE shared live region the same way gantt-dnd.tsx's beginGesture already does for a
  // pointer drag - reused, not one per bar.
  const announce = (text: string) => {
    const ganttRoot = barRef.current?.closest<HTMLElement>("[data-slot=gantt]")
    const announcer = ganttRoot?.querySelector<HTMLElement>(
      "[data-slot=gantt-announcer]"
    )
    if (announcer) announcer.textContent = text
  }
  const formatRange = (start: Date, end: Date, allDay: boolean) =>
    settings.i18n.functions.formatEventTime(
      toZoned(start, settings.timeZone),
      toZoned(end, settings.timeZone),
      allDay,
      settings.locale
    )
  const adjustTargetLabel = (target: GanttNudgeAction): string => {
    const labels = settings.i18n.labels.adjustTargetLabels
    if (target === "move") return labels.move
    if (target === "resize-start") return labels.resizeStart
    return labels.resizeEnd
  }

  // Pointer-down ANYWHERE outside this bar cancels the session (the spec's "Blur / pointer-down
  // elsewhere = CANCEL" - blur is handled by the button's own onBlur below; this covers a pointer
  // interaction that never focuses anything, e.g. a drag started on a different bar entirely).
  // Captured at `document` (not this bar) because "elsewhere" is everywhere else in the page; the
  // capture phase means it still fires even if some inner handler stops propagation. Re-reads
  // `instance.getState().adjust` live rather than trusting `adjusting` from this closure - see the
  // effect's own dependency comment and this file's header for the stale-closure race this avoids.
  useEffect(() => {
    if (!adjusting) return
    const onDocumentPointerDown = (ev: PointerEvent) => {
      const live = instance.getState().adjust
      if (live?.occurrence.key !== occurrence.key) return
      if (ev.target instanceof Node && barRef.current?.contains(ev.target)) {
        return
      }
      localTeardownRef.current = true
      instance.internals.cancelAdjust()
      announce(settings.i18n.labels.adjustCancelled)
    }
    document.addEventListener("pointerdown", onDocumentPointerDown, true)
    return () =>
      document.removeEventListener("pointerdown", onDocumentPointerDown, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `announce`/`settings` close over this
    // render's values, which is what we want the NEXT pointerdown to see too; re-running the effect
    // on every render (by adding them) would thrash the listener for no behavioral gain.
  }, [adjusting, instance, occurrence.key])

  // #219 PR A fix (Sol re-review round 2, HIGH #3): every cancel/commit path ABOVE runs inside
  // this bar's own handlers and already announces inline - set right before each one's own
  // `cancelAdjust`/`commitAdjust` call. But the session's OWNER can die with none of them ever
  // running: the owning event deleted or replaced from outside, or the view's date/scale changing
  // mid-session (`gantt.tsx`'s `killAdjustSessionIfOrphaned`, called from both `setOptions` and
  // `setField`). That store-level teardown flips `adjusting` true -> false on this bar's next
  // render with no local handler in the loop, so the cancellation announcement has to happen
  // here instead. Gated on `localTeardownRef` so it fires exactly once and never re-announces
  // "cancelled" over a cancel/commit branch's OWN just-set message - the same stale-overwrite
  // race the blur handler above is already written to avoid.
  useEffect(() => {
    const wasAdjusting = wasAdjustingRef.current
    wasAdjustingRef.current = adjusting
    if (!wasAdjusting || adjusting) return
    if (localTeardownRef.current) {
      localTeardownRef.current = false
      return
    }
    announce(settings.i18n.labels.adjustCancelled)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- same reasoning as the
    // pointerdown-elsewhere effect above: `announce`/`settings` close over this render's values
    // on purpose.
  }, [adjusting])

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
  // same three flags gate Adjust mode's entry point (Space) and aria-keyshortcuts.
  const canMove = gestures.canDrag(segment)
  const canResizeStart = segment.isStart && gestures.canResize(segment, "start")
  const canResizeEnd = segment.isEnd && gestures.canResize(segment, "end")
  const canAdjust = canMove || canResizeStart || canResizeEnd
  const keyShortcuts = buildGanttBarKeyShortcuts(canAdjust, occurrence.isRecurring)
  const instructionsId = useId()
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
          onPointerDown={(e) => {
            // Quincy fix (#219 PR A, Sol review, sol1 item 6): a pointer interaction is one of the
            // explicit clear triggers for a stale keyboard-focus claim.
            instance.internals.clearKeyboardFocus()
            // #219 PR A fix (Sol re-review round 2, HIGH #4): the "cancel Adjust first" check that
            // used to live here (a pointer gesture on THIS bar mid-session would otherwise race
            // stepAdjust for state.drag) moved into `gantt-dnd.tsx`'s `beginGesture` - the single
            // entry point EVERY pointer gesture goes through, not one copy per call site. The
            // owner-death effect above still announces the cancellation.
            gestures.beginResize(e, segment, "start")
          }}
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
          onPointerDown={(e) => {
            instance.internals.clearKeyboardFocus()
            // #219 PR A fix (Sol re-review round 2, HIGH #4): see the start grip's own comment -
            // the "cancel Adjust first" check moved to `gantt-dnd.tsx`'s `beginGesture`.
            gestures.beginResize(e, segment, "end")
          }}
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
    // ref is intentionally absent here - see the `ref: consumerRef` destructure above. It is
    // merged with `barRef` via `useRender`'s own `ref` parameter below instead.
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
    // #219 PR A (Adjust mode) - see this file's header. `role="application"` re-scopes ALL keyboard
    // interaction on this element while it holds an active session (arrow keys mean "step", not
    // "scroll the page"); `aria-describedby` points at the visually-hidden instructions span below.
    role: adjusting ? "application" : undefined,
    "data-adjusting": adjusting || undefined,
    "aria-describedby": adjusting ? instructionsId : undefined,
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
      // Quincy fix (#219 PR A, Sol review, sol1 item 6): a pointer interaction is one of the
      // explicit clear triggers for a stale keyboard-focus claim.
      instance.internals.clearKeyboardFocus()
      // #219 PR A fix (Sol re-review round 2, HIGH #4): see the resize grips' own comment above -
      // the "cancel Adjust first" check moved to `gantt-dnd.tsx`'s `beginGesture`.
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
    // #219 PR A (Adjust mode) - Blur is one of the two CANCEL triggers (the other is a pointer-down
    // elsewhere, in the effect above). Re-reads live state rather than the `adjusting` closure - see
    // this file's header for the stale-closure race a commit's own remount can otherwise cause.
    onBlur: () => {
      const live = instance.getState().adjust
      if (live?.occurrence.key !== occurrence.key) return
      localTeardownRef.current = true
      instance.internals.cancelAdjust()
      announce(settings.i18n.labels.adjustCancelled)
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const rtl = getComputedStyle(e.currentTarget).direction === "rtl"
      const match = matchGanttBarKey(e, adjusting, rtl)
      if (!match) return

      if (match.type === "enter") {
        // Quincy fix (#219 PR A, Sol review, sol1 item 2/5, carried over): gate on the SAME
        // canMove/canResizeStart/canResizeEnd/isRecurring flags aria-keyshortcuts is built from,
        // BEFORE preventDefault - an ineligible Space is left un-prevented, so the button's native
        // activate (open event) still fires, exactly as the spec requires ("Space keeps its current
        // activate behaviour").
        if (!canAdjust || occurrence.isRecurring) return
        e.preventDefault()
        // Quincy fix (#219 PR A, Sol review, sol1 item 6): clear any STALE claim from an earlier
        // nudge before processing this one.
        instance.internals.clearKeyboardFocus()
        const initialTarget: GanttNudgeAction = canMove
          ? "move"
          : canResizeStart
            ? "resize-start"
            : "resize-end"
        // Quincy fix (#219 PR A, Sol re-review round 2, HIGH #4): a pointer gesture pending or
        // active anywhere on the page refuses the session outright (see `gantt.tsx`'s own doc
        // comment on this method) - no session, no announcement, no ghost. `preventDefault` above
        // already stands either way: this Space chord IS ours (canAdjust/isRecurring already
        // passed), the refusal is a transient pointer/keyboard race, not "this key means nothing
        // here" - the button's native activate must not ALSO fire on top of a chord we claimed.
        const entered = instance.internals.beginAdjust(event.id, occurrence, initialTarget)
        if (!entered) return
        announce(
          `${settings.i18n.labels.adjustInstructions} ${settings.i18n.labels.adjustEntered(
            adjustTargetLabel(initialTarget),
            formatRange(occurrence.start, occurrence.end, occurrence.allDay)
          )}`
        )
        return
      }

      // Every other match type only comes back while `adjusting` is true (matchGanttBarKey's own
      // adjusting table) - all of them are handled keys per the spec ("All handled keys
      // preventDefault... grid must not scroll, no text selection").
      e.preventDefault()

      if (match.type === "cancel") {
        localTeardownRef.current = true
        instance.internals.cancelAdjust()
        announce(settings.i18n.labels.adjustCancelled)
        return
      }

      if (match.type === "retarget") {
        const eligible =
          match.target === "move"
            ? canMove
            : match.target === "resize-start"
              ? canResizeStart
              : canResizeEnd
        if (!eligible) {
          announce(settings.i18n.labels.adjustTargetLocked)
          return
        }
        instance.internals.retargetAdjust(match.target)
        announce(settings.i18n.labels.adjustRetargeted(adjustTargetLabel(match.target)))
        return
      }

      if (match.type === "step") {
        // Quincy fix (#219 PR A, Sol review, sol1 item 3, carried over): pass the effective
        // view-level scheduleMode through explicitly - the store has no component in its call
        // stack to read useGanttViewConfig() from itself.
        const result = instance.internals.stepAdjust(
          match.direction,
          match.unit,
          viewConfig.scheduleMode
        )
        if (result.applied) {
          announce(
            settings.i18n.labels.adjustStepped(
              formatRange(result.start!, result.end!, result.allDay ?? false)
            )
          )
        } else if (result.reason === "locked") {
          announce(settings.i18n.labels.keyboardNudgeLocked)
        } else if (result.reason === "invalid") {
          announce(settings.i18n.labels.keyboardNudgeInvalid)
        } else if (result.reason === "rejected") {
          announce(settings.i18n.labels.keyboardNudgeRejected)
        }
        return
      }

      // match.type === "commit"
      // Quincy fix (#219 PR A, Sol re-review round 2, HIGH #2): the same view-scheduleMode
      // pass-through `stepAdjust` above already needs - `commitAdjust` now re-validates the overlap
      // policy against the CURRENT resource, which needs it too.
      localTeardownRef.current = true
      const result = instance.internals.commitAdjust(viewConfig.scheduleMode)
      if (result.committed) {
        // A committed START change (move, or a start-edge resize - whichever target actually moved
        // it, regardless of which target was LAST selected via M/S/E) changes this occurrence's key
        // (see this file's header) and remounts the bar - claim the hand-off the same way a
        // successful move/resize-start nudge always did.
        if (result.start!.getTime() !== occurrence.start.getTime()) {
          instance.internals.claimKeyboardFocus({
            eventId: event.id,
            targetKey: `${event.id}::${result.start!.toISOString()}`,
          })
        }
        announce(
          settings.i18n.labels.adjustCommitted(
            formatRange(result.start!, result.end!, result.allDay ?? false)
          )
        )
      } else if (result.noChange) {
        announce(settings.i18n.labels.adjustNoChange)
      } else {
        announce(settings.i18n.labels.keyboardNudgeRejected)
      }
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
      // #219 PR A fix (Sol re-review round 2, MEDIUM #7): a hairline dashed outline on the bar
      // itself used to mark an active keyboard Adjust session here - removed. It visually lost to
      // the ordinary `focus-visible:ring` above even while the bar was visible, and once a step
      // drove `state.drag`, a move gesture hides the bar entirely (`data-[drag-kind=move]:opacity-0`
      // above) - focus stayed on an invisible element with nothing to show for it. The
      // Adjust-specific treatment now lives on `gantt-view.tsx`'s own drag ghost
      // (`data-adjust-ghost`), which is never hidden and never competes with the bar's own focus
      // ring; that ring (unchanged, above) remains this element's visible focus indication.
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
        {adjusting && (
          // #219 PR A (Adjust mode) - the aria-describedby target above; visually hidden, always
          // readable by AT (unlike aria-hidden content, which this deliberately is NOT).
          <span id={instructionsId} className="sr-only">
            {settings.i18n.labels.adjustInstructions}
          </span>
        )}
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
    // Quincy fix (#219 PR A, Sol review, sol1 item 6): `useRender`'s own `ref` PARAMETER (distinct
    // from `props.ref`, which `mergeProps` above never sets - see the `ref: consumerRef` destructure
    // higher up) is merged internally (via `@base-ui/utils/useMergedRefs`) with any `ref` on `render`
    // itself, so passing an array here composes `barRef` (this component's own hand-off target) with
    // whatever the CONSUMER passed as `<GanttBar ref={...}>` - both receive the node. Normalized to
    // a flat array because `consumerRef` is itself typed to accept an array (mirroring `useRender`'s
    // own `ref` prop), which `Array.isArray` narrows before spreading.
    ref: consumerRef == null
      ? [barRef]
      : Array.isArray(consumerRef)
        ? [barRef, ...consumerRef]
        : [barRef, consumerRef],
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
