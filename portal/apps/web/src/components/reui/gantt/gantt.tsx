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
 * Separately from the three mechanical, per-line edits above: this registry item landed inside a
 * `gantt/` subdirectory of `components/reui/`, not flat alongside the other 38 pre-existing
 * vendored files — `docs/reui-reuse.md` now permits a subdirectory for a multi-file registry item
 * like this one (#219 PR A standards review item 7). The nesting is what lets
 * `gantt-skin.guard.test.ts` scope itself to exactly this directory (its own explicit nine-file
 * list, `VENDORED_FILES`, is read relative to this folder) instead of having to scan every file
 * under `components/reui/` and separate Gantt classes from every other vendored primitive's by
 * filename pattern alone.
 *
 * Diffed against the sandbox's own `src/components/vendor-219/<name>.tsx` output, every line
 * differs only in one of the three ways above — WITH ONE EXCEPTION, forced by typecheck rather
 * than chosen: this repo's `tsconfig.base.json` sets `noUncheckedIndexedAccess: true`, which the
 * sandbox's own `tsconfig.app.json` does not. A nested-loop pairwise scan in
 * `useGanttNodeSchedules` (`schedules[i]`/`schedules[j]`, both loop-bounded) therefore typechecks
 * in the sandbox and fails here. Fixed with the smallest possible edit, four non-null assertions,
 * marked inline at the one site — search this file for "Quincy edit (#219 stage 1)".
 *
 * #219 PR A standards review item 10: the "every line differs only in one of the three ways
 * above" claim (with the one exception just above) describes this file's state AT commit
 * `4bb46296`, not its state now. Everything logged below is a real, dated Quincy edit made SINCE
 * that commit; `git diff --stat 4bb46296 HEAD -- gantt.tsx` currently reads +962/−13.
 *
 * No production code imports this tree yet — `src/harness/harness-reachability.guard.test.ts`
 * makes that a build failure rather than a bug report, and the dev-only harness at
 * `src/harness/reui-scheduling/` is the only thing that renders it, with local fixture data.
 *
 * This file: the root — `useGantt`/`useGanttSelector`/`useGanttViewConfig` hooks, the
 * subscribable store, and the external CRUD contract (`onEventCreate`/`onEventUpdate`/
 * `onEventDelete`/…) that a consumer wires up. No icons used.
 *
 * #219 stage 2 (PR A) edit, additive: added `GanttApi.nudgeEvent`, the instance API method behind
 * `gantt-bar.tsx`'s keyboard move/resize (upstream has no keyboard path for either gesture). Built
 * on `gantt-lib.tsx`'s `computeGanttKeyboardProposal`/`isResizableEdge` rather than importing
 * anything from `gantt-dnd.tsx` — that file already depends on this one for `useGantt`/
 * `useGanttViewConfig`/`GanttInstance`, so the reverse import would be a cycle.
 *
 * #219 PR A fix (Sol review, sol1 items 2 and 3) — three corrections to `nudgeEvent`, all in this
 * method:
 * 1. It refuses (`{ applied: false, reason: "locked" }`) whenever the resolved event carries a
 *    `recurrence` rule — see the comment at that check for why (no occurrence-aware exceptions
 *    exist yet, and this method always targets the series MASTER).
 * 2. `nudgeEvent` used to have no VIEW-level `scheduleMode` default to fall back to (that config
 *    lives in a React context a store-level API method has no component in its call stack to
 *    read), so it only honoured a node's OWN `scheduleMode` override. That is now a documented
 *    CALLER contract instead of a silent limitation: `nudgeEvent` takes an optional
 *    `viewScheduleMode` parameter (see its own doc comment) that `gantt-bar.tsx` passes as
 *    `useGanttViewConfig().scheduleMode`. And the overlap policy itself now runs through the SAME
 *    shared `gantt-lib.tsx` helpers (`resolveOverlapPolicy`/`overlapsAnyNeighbour`/
 *    `clampToNeighbours`) `gantt-dnd.tsx`'s `beginGesture` uses, so "clamp" — previously ignored
 *    outright here — now clamps identically to a pointer gesture.
 * 3. The overlap/clamp neighbour lookup no longer reads unranged `api.getOccurrences()` (scoped to
 *    whatever the store's CURRENT `visibleRange` happens to be, so an off-screen same-resource
 *    neighbour was invisible to it). It now queries the UNION of the event's own current span and
 *    the proposed range — `gantt-dnd.tsx`'s pointer gesture engine received the identical fix.
 *
 * #219 PR A fix (Sol review, sol1 item 6): `GanttInternals` gained `claimKeyboardFocus`/
 * `consumeKeyboardFocus`/`clearKeyboardFocus`, replacing `gantt-bar.tsx`'s module-level
 * `pendingKeyboardFocusEventId` — a variable shared by EVERY `<Gantt>` instance in the process,
 * so two instances rendering the same event id could steal focus from each other. The token now
 * lives in THIS store's own closure (`createGanttStore`), keyed on event id AND the exact target
 * occurrence key (not id alone), and self-clears if a commit unrelated to the claim (one this
 * store's own `notify()` count shows happened AFTER the claim) passes without anything consuming
 * it — see `notify()`'s own comment for the mechanics.
 *
 * #219 PR A fix (Sol review, sol1 item 7): `applyProposedUpdate` (used by both `nudgeEvent` here and
 * `gantt-dnd.tsx`'s pointer release) now returns the ACCEPTED `{ start, end, allDay }` instead of a
 * bare `boolean`, and `nudgeEvent`'s result carries those same fields. `gantt-bar.tsx`'s success
 * announcement used to re-fetch via `api.getEvent(event.id)` right after this call, which can read
 * the OLD range: under a controlled `events` prop, `setField`'s controlled path only invokes
 * `onEventsChange` — it never mutates internal state — so the parent's own state update (which
 * carries the new range) has not landed by the time that same synchronous call stack reads it back.
 */

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from "react"
import {
  mergeGanttI18n,
  type GanttI18nConfig,
  type GanttI18nOverrides,
} from "@/components/reui/gantt/gantt-i18n"
import {
  buildEventIndex,
  clampToNeighbours,
  computeGanttKeyboardProposal,
  defaultEventOrder,
  eventsOverlap,
  findResource,
  getGanttDateRange,
  getRangeKey,
  isGanttGestureInFlight,
  isResizableEdge,
  overlapsAnyNeighbour,
  resolveAdjustLargerStepMinutes,
  resolveOverlapPolicy,
  stepGanttDate,
  toZoned,
  type GanttIndex,
  type GanttOverlapNeighbour,
  type WeekStartsOn,
} from "@/components/reui/gantt/gantt-lib"
import type {
  GanttAdjustCommitResult,
  GanttAdjustState,
  GanttAdjustStepResult,
  GanttBarId,
  GanttBaseline,
  GanttBaselineVariance,
  GanttDateRange,
  GanttDragState,
  GanttEvent,
  GanttInteractions,
  GanttNudgeAction,
  GanttNudgeResult,
  GanttOccurrence,
  GanttOffDaysConfig,
  GanttOverlapPolicy,
  GanttProposedUpdate,
  GanttRangeInfo,
  GanttResource,
  GanttResourceReorder,
  GanttRowAlign,
  GanttScale,
  GanttScheduleMode,
  GanttSegment,
  GanttSelection,
  GanttSlotDraft,
  GanttSlotInfo,
  GanttState,
  GanttUpdateResult,
} from "@/components/reui/gantt/gantt-types"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import type { Locale } from "date-fns"

import { cn } from "@/lib/utils"

const DEFAULT_INTERACTIONS: GanttInteractions = {
  drag: true,
  resize: true,
  selectSlot: true,
}

/** Infinite-scroll growth cap, in whole periods per side. */
const MAX_RANGE_WINDOW = 12

/** A node holds as many concurrent schedules as it needs unless told otherwise. */
const DEFAULT_SCHEDULE_MODE: GanttScheduleMode = "multiple"

/** Tree label sits on the first schedule's baseline, not the grown row's middle. */
const DEFAULT_ROW_ALIGN: GanttRowAlign = "start"

/**
 * A node's cardinality: its own override wins over the view-level default.
 * Shared by the layout pass and the gesture engine so both read one rule.
 */
function resolveScheduleMode(
  node: GanttResource | null | undefined,
  scheduleMode: GanttScheduleMode | undefined
): GanttScheduleMode {
  return node?.scheduleMode ?? scheduleMode ?? DEFAULT_SCHEDULE_MODE
}

const EMPTY_SELECTION: GanttSelection = { eventKeys: [], slot: null }

interface GanttCallbacks<TData = unknown> {
  onEventClick?: (
    occurrence: GanttOccurrence<TData>,
    e: React.MouseEvent
  ) => void
  onEventDoubleClick?: (
    occurrence: GanttOccurrence<TData>,
    e: React.MouseEvent
  ) => void
  onEventUpdate?: (update: GanttProposedUpdate<TData>) => GanttUpdateResult
  canDropEvent?: (update: GanttProposedUpdate<TData>) => boolean
  onSlotClick?: (slot: GanttSlotInfo, e: React.MouseEvent) => void
  onSelectSlot?: (slot: GanttSlotDraft) => void
  canSelectSlot?: (slot: GanttSlotDraft) => boolean
  /** Fires when the "add task" hint is activated; create a new tree row. */
  onCreateTask?: (ctx: { parentId: string | null; index: number }) => void
  /**
   * Gates the "add task" hint. The shipped view offers root-level creation
   * only (parentId = null); parentId stays in the contract for group-level
   * affordances a consumer builds via its own UI + onCreateTask.
   */
  canCreateTask?: (ctx: { parentId: string | null }) => boolean
  /** Click on a tree row's surface (chevron/checkbox/grip clicks excluded). */
  onResourceClick?: (ctx: GanttColumnContext, e: React.MouseEvent) => void
  onResourceDoubleClick?: (ctx: GanttColumnContext, e: React.MouseEvent) => void
  onRangeChange?: (info: GanttRangeInfo) => void
  onScaleChange?: (scale: GanttScale) => void
  onDateChange?: (date: Date) => void
  onSelectionChange?: (selection: GanttSelection) => void
  onInteractionsChange?: (interactions: GanttInteractions) => void
  onEventsChange?: (events: GanttEvent<TData>[]) => void
  /**
   * Commit gate for timeline resource-row drag reorder. Return false to
   * reject; apply the move by adopting proposal.resources into your
   * `resources` state (controlled - the calendar never self-mutates).
   */
  onResourceReorder?: (proposal: GanttResourceReorder) => void | false
  /** Live validity predicate while a resource row is being dragged. */
  canReorderResource?: (proposal: GanttResourceReorder) => boolean
  /**
   * Fires when a reorder gesture is released on a position rejected by
   * `canReorderResource` (e.g. a pinned row). Use it to explain the rejection
   * (a toast) - the destructive drop indicator already shows it live.
   */
  onResourceReorderReject?: (proposal: GanttResourceReorder) => void
}

interface UseGanttStateOptions<TData = unknown> extends GanttCallbacks<TData> {
  events?: GanttEvent<TData>[]
  defaultEvents?: GanttEvent<TData>[]
  scale?: GanttScale
  defaultScale?: GanttScale
  date?: Date
  defaultDate?: Date
  selection?: GanttSelection
  defaultSelection?: GanttSelection
  interactions?: Partial<GanttInteractions>
  defaultInteractions?: Partial<GanttInteractions>
  loading?: boolean
  timeZone?: string
  locale?: Locale
  weekStartsOn?: WeekStartsOn
  slotDuration?: number
  snapDuration?: number
  i18n?: GanttI18nOverrides
  /**
   * Hard travel bounds for infinite scrolling; either side may be omitted
   * for unlimited travel in that direction.
   */
  rangeBounds?: { min?: Date; max?: Date }
  /** Pointer-activation threshold overrides for drag/resize/create. */
  activation?: GanttActivationConfig
  /**
   * Infinite-scroll growth cap in whole periods per side; past it the
   * anchor slides instead (DOM stays bounded). Default 12.
   */
  maxRangeWindow?: number
  /** Tree nodes of the gantt (GanttNode is the preferred type name). */
  resources?: GanttResource[]
  /**
   * What a gesture may do when it would overlap another schedule in the SAME
   * node: "allow" (default), "clamp" to the neighbour's edge, or "reject".
   * Policy only - overlapping data always renders. A node in "single"
   * scheduleMode rejects regardless.
   */
  overlap?: GanttOverlapPolicy
  /**
   * Make canDropEvent binding: releasing a gesture whose last verdict was
   * invalid reverts it, like the "reject" overlap policy, instead of
   * committing anyway. Default false - canDropEvent alone stays advisory
   * (it styles the ghost; onEventUpdate is the commit gate).
   */
  enforceCanDrop?: boolean
  getEventPriority?: (event: GanttEvent<TData>) => number
  eventOrder?: (a: GanttOccurrence<TData>, b: GanttOccurrence<TData>) => number
  getOccurrences?: (
    event: GanttEvent<TData>,
    range: GanttDateRange,
    ctx: { timeZone: string }
  ) => Array<{ start: Date; end: Date }> | null
}

/**
 * Resolved configuration: every UseGanttStateOptions field except the
 * controlled/uncontrolled state pairs, with defaults applied and i18n merged.
 * Read via ref semantics - callback identity changes never re-render the grid.
 */
interface GanttSettings<TData = unknown> extends GanttCallbacks<TData> {
  timeZone: string
  locale?: Locale
  weekStartsOn: WeekStartsOn
  slotDuration: number
  snapDuration: number
  i18n: GanttI18nConfig
  rangeBounds?: { min?: Date; max?: Date }
  activation?: GanttActivationConfig
  maxRangeWindow?: number
  resources: GanttResource[]
  overlap: GanttOverlapPolicy
  enforceCanDrop?: boolean
  getEventPriority: (event: GanttEvent<TData>) => number
  eventOrder: (a: GanttOccurrence<TData>, b: GanttOccurrence<TData>) => number
  getOccurrences?: (
    event: GanttEvent<TData>,
    range: GanttDateRange,
    ctx: { timeZone: string }
  ) => Array<{ start: Date; end: Date }> | null
}

interface GanttApi<TData = unknown> {
  next(): void
  prev(): void
  today(): void
  goTo(date: Date): void
  setScale(scale: GanttScale): void
  getEvents(): GanttEvent<TData>[]
  getEvent(id: GanttBarId): GanttEvent<TData> | undefined
  setEvents(events: GanttEvent<TData>[]): void
  addEvent(event: GanttEvent<TData>): void
  updateEvent(id: GanttBarId, patch: Partial<GanttEvent<TData>>): void
  /**
   * The keyboard equivalent of one pointer move/resize step (#219 — upstream has no keyboard path
   * for either gesture). `direction` is a TIME-AXIS direction (-1 earlier, +1 later), the same
   * sense `next()`/`prev()` use, not a "grow/shrink" one — same convention the pointer gesture
   * itself uses (dragging the pointer right always increases minutes, regardless of which edge is
   * grabbed). Commits through the same `onEventUpdate`/`onEventsChange` funnel as a pointer drag,
   * with `source: "keyboard"`; never through `updateEvent` above, which skips the drop checks.
   *
   * `viewScheduleMode` is `useGanttViewConfig().scheduleMode` — Quincy fix (#219 PR A, Sol review,
   * sol1 item 3): this is a store-level method with no component in its call stack to read that
   * context from itself, so a caller with view access (`gantt-bar.tsx`'s keyboard handler) passes
   * the effective value in explicitly. Omitting it falls back to a node's OWN `scheduleMode`
   * override only, same as calling `nudgeEvent` from outside a view (e.g. a test, or a fully
   * custom UI with no `<Gantt>` view-config context to read).
   */
  nudgeEvent(
    id: GanttBarId,
    action: GanttNudgeAction,
    direction: -1 | 1,
    viewScheduleMode?: GanttScheduleMode
  ): GanttNudgeResult
  removeEvent(id: GanttBarId): void
  getOccurrences(range?: GanttDateRange): GanttOccurrence<TData>[]
  findOverlapping(candidate: {
    start: Date
    end: Date
    excludeEventId?: string
  }): GanttOccurrence<TData>[]
  select(selection: Partial<GanttSelection>): void
  selectEvent(key: string, opts?: { additive?: boolean }): void
  clearSelection(): void
  setInteractions(patch: Partial<GanttInteractions>): void
  getVisibleRange(): GanttDateRange
  getActiveRange(): GanttDateRange
  /** TZDate in the gantt's display time zone. */
  toZoned(date: Date): Date
}

/** Cross-file plumbing for sibling view/interaction modules; not public API. */
interface GanttInternals<TData = unknown> {
  getIndex(): GanttIndex<TData>
  setDrag(drag: GanttDragState<TData> | null): void
  setSlotDraft(draft: GanttSlotDraft | null): void
  /**
   * Quincy fix (#219 PR A, Sol review, sol1 item 7): returns the ACCEPTED range (after any
   * `onEventUpdate` consumer adjustment), not just whether the commit happened - `nudgeEvent`'s own
   * success announcement used to re-fetch via `api.getEvent` immediately after this call, which
   * reads the OLD range under a controlled `events` prop (the parent's state update that actually
   * carries the new range has not landed yet - `setField`'s controlled path only invokes the
   * `onEventsChange` callback, it never mutates internal state). Returning the accepted values
   * directly removes that read-after-write race. `null` means rejected (mirrors the old `false`).
   */
  applyProposedUpdate(
    update: GanttProposedUpdate<TData>
  ): { start: Date; end: Date; allDay: boolean } | null
  getSettingsVersion(): number
  /**
   * Grow visibleRange by whole periods for infinite scrolling; resets on
   * date/scale changes. Returns false once the growth cap is reached.
   */
  extendRange(direction: "before" | "after"): boolean
  /**
   * True when the LAST anchor-date change was an extendRange window slide
   * (not a navigation) - the view keeps its scroll guard across slides.
   */
  didAnchorSlide(): boolean
  /**
   * Quincy addition (#219 PR A round 3, Sol HIGH #5): bumps every time `cancelAdjust` or
   * `killAdjustSessionIfOrphaned` actually tears down a session - the ONLY two callers that ever
   * bump it, so it is a clean, cheap signal for "a session just ended with the CANCELLED outcome,
   * from somewhere that has no announcer of its own in scope" - covers an external teardown
   * (deletion, a replaced event, a date/scale/anchor-slide change), AND a programmatic cancel with
   * no local announcer available, like `gantt-dnd.tsx`'s `beginGesture` cancelling a same-bar
   * session before a pointer gesture starts (its own doc comment there explains why it deliberately
   * does not announce itself). It never fires for `commitAdjust` (see that method's own comment for
   * why it clears the session through a path that never reaches either of these two), so a
   * successful commit's own distinct message is never at risk of being overwritten here.
   * `<Gantt>`'s root-level announcer effect subscribes to this instead of `state.adjust` itself so
   * it can tell "the session just died and needs the standard 'cancelled' announcement" apart from
   * "the session just died because THIS bar's own handler already announced something else inline"
   * (blur/Escape/pointerdown-elsewhere in `gantt-bar.tsx` used to self-announce for exactly this
   * reason; they no longer need to, since this now covers them uniformly too) - and, critically,
   * apart from "the bar that owned it unmounted" (deletion), which no per-bar effect could ever
   * observe in the first place. See `gantt-bar.tsx`'s header for why the per-bar owner-death effect
   * this replaced could not cover that last case.
   */
  getAdjustCancelledVersion(): number
  /** View reports the visible-center instant (or null) for the nav title. */
  setViewportCenter(date: Date | null): void
  /**
   * Quincy addition (#219 PR A, Sol review, sol1 item 6): the keyboard focus hand-off's pending
   * token, scoped to THIS Gantt instance (was a module-level variable shared by every `<Gantt>` in
   * the process - two instances rendering the SAME event id could steal focus from each other).
   * See `gantt-bar.tsx`'s header for why a move/resize-start nudge needs a hand-off at all.
   */
  claimKeyboardFocus(token: GanttPendingKeyboardFocus): void
  /**
   * True (and clears the token) iff it matches BOTH `eventId` and `key` - a mount for a different
   * event, or the right event under the WRONG key, never consumes (and never clears) a token that
   * is not its own.
   */
  consumeKeyboardFocus(eventId: GanttBarId, key: string): boolean
  /**
   * Unconditional clear - the start of the NEXT nudge and a pointer interaction both call this, so
   * a token nothing ever consumed (the target never mounted, or a controlled consumer dropped/
   * delayed the change) cannot later steal focus from an unrelated mount. Also self-clears
   * automatically: it survives at most one store commit after the one that claimed it (see
   * `notify()`) before being dropped as stale on its own.
   */
  clearKeyboardFocus(): void
  /**
   * #219 PR A — begins one bar's modal keyboard Adjust session (`GanttState.adjust`). The CALLER
   * (`gantt-bar.tsx`'s Space handler) is the only place that knows this SEGMENT's own clip state,
   * so it has already gated eligibility (not recurring, at least one of canMove/canResizeStart/
   * canResizeEnd) and computed `initialTarget` (move if canMove, else the first resizable edge)
   * before calling this - this method does not re-derive either.
   *
   * Quincy fix (#219 PR A, Sol re-review round 2, HIGH #4): refuses (returns `false`, no session
   * opened) while ANY gantt pointer gesture, anywhere on the page, is pending or active
   * (`gantt-lib.tsx`'s `isGanttGestureInFlight`) - centralizing the "pointer vs keyboard ownership
   * of state.drag" rule at its OTHER end: `gantt-dnd.tsx`'s `beginGesture` already cancels an
   * active Adjust session on the SAME occurrence before a gesture starts, so together the two
   * inputs are structurally mutually exclusive, never both driving `state.drag` at once. The
   * caller must check the return value - a refused Space enters nothing and announces nothing.
   */
  beginAdjust(
    eventId: GanttBarId,
    occurrence: GanttOccurrence<TData>,
    initialTarget: GanttNudgeAction
  ): boolean
  /**
   * One Arrow (`unit: "snap"`) or Shift+Arrow (`unit: "large"`) step on the session's CURRENT
   * target, from its CURRENT preview (not the original committed range - repeated steps
   * accumulate). Runs the SAME lock/overlap/clamp/canDropEvent gates `nudgeEvent` does (the shared
   * `proposeNudge` helper below); a refused step leaves `preview` untouched. An accepted step
   * updates `preview` AND drives `state.drag` with the identical shape a pointer gesture's own
   * `applyProposal` (`gantt-dnd.tsx`) produces - reusing the SAME ghost-preview render path in
   * `gantt-view.tsx` (`fractionOf(drag.proposedStart/End)`) a sighted keyboard user sees, with zero
   * changes to that layout code (Adjust-mode preference (a) over building a second preview
   * surface - see `gantt-bar.tsx`'s header for the fallback (b) this repo did not need).
   */
  stepAdjust(
    direction: -1 | 1,
    unit: "snap" | "large",
    viewScheduleMode?: GanttScheduleMode
  ): GanttAdjustStepResult
  /**
   * M/S/E - switches the session's target. The CALLER has already validated availability the same
   * segment-aware way `beginAdjust`'s `initialTarget` is computed; this method does not re-check it
   * (there is no segment-clip information at the store level to check it against).
   */
  retargetAdjust(target: GanttNudgeAction): void
  /**
   * Enter or Space - commits the NET preview (relative to entry) through the same
   * `applyProposedUpdate` funnel a pointer release uses, exactly once, with `source: "keyboard"`;
   * no net change emits nothing. Always clears the session (and any driven `state.drag`), win or
   * lose.
   *
   * Quincy fix (#219 PR A, Sol re-review round 2, HIGH #2): immediately before that single write,
   * re-validates the FINAL preview against the CURRENT event/settings (see `validateAdjustCommit`
   * in `gantt.tsx`) - a refusal here (event now locked/recurring, a now-overlapping neighbour under
   * "reject", or an enforced `canDropEvent` veto) commits nothing, same as `onEventUpdate` itself
   * rejecting. `viewScheduleMode` is `useGanttViewConfig().scheduleMode`, the same store-has-no-
   * component-context reason `stepAdjust` already takes it.
   */
  commitAdjust(viewScheduleMode?: GanttScheduleMode): GanttAdjustCommitResult
  /**
   * Escape, blur, or a pointer-down outside the bar - discards the preview, emits nothing, clears
   * the session (and any driven `state.drag`). A no-op when no session is active. Also called by
   * `gantt-dnd.tsx`'s `beginGesture` (a pointer gesture starting on the session's own bar) and
   * `gantt.tsx`'s `<Gantt>` on its own unmount (a hoisted calendar's session outliving the root -
   * see #219 PR A round 3, Sol HIGH #4b).
   *
   * Quincy addition (#219 PR A round 3, Sol HIGH #5): bumps `getAdjustCancelledVersion` on an
   * actual teardown - see that method's own doc comment for the single "Adjustment cancelled."
   * announcement this drives from `<Gantt>`'s root, uniformly, for every caller above.
   */
  cancelAdjust(): void
}

/** See `GanttInternals.claimKeyboardFocus`. */
interface GanttPendingKeyboardFocus {
  eventId: GanttBarId
  targetKey: string
}

interface GanttInstance<TData = unknown> {
  getState(): GanttState<TData>
  subscribe(listener: () => void): () => void
  api: GanttApi<TData>
  settings: GanttSettings<TData>
  internals: GanttInternals<TData>
}

function resolveSettings<TData>(
  options: UseGanttStateOptions<TData>
): GanttSettings<TData> {
  const {
    // strip state pairs; the rest flows into settings
    events: _e,
    defaultEvents: _de,
    scale: _v,
    defaultScale: _dv,
    date: _d,
    defaultDate: _dd,
    selection: _s,
    defaultSelection: _ds,
    interactions: _i,
    defaultInteractions: _di,
    loading: _l,
    ...rest
  } = options
  const getEventPriority =
    options.getEventPriority ??
    ((event: GanttEvent<TData>) => event.priority ?? 0)
  return {
    ...rest,
    timeZone:
      options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: options.locale,
    // locale-first default: a de/fr locale gets Monday weeks without also
    // having to set weekStartsOn; an explicit weekStartsOn always wins
    weekStartsOn:
      options.weekStartsOn ?? options.locale?.options?.weekStartsOn ?? 0,
    slotDuration: options.slotDuration ?? 30,
    snapDuration: options.snapDuration ?? 15,
    i18n: mergeGanttI18n(options.i18n),
    rangeBounds: options.rangeBounds,
    resources: options.resources ?? [],
    overlap: options.overlap ?? "allow",
    getEventPriority,
    // priority-aware default: higher getEventPriority packs/orders first
    eventOrder:
      options.eventOrder ??
      ((a, b) =>
        getEventPriority(b.event) - getEventPriority(a.event) ||
        defaultEventOrder(a, b)),
    getOccurrences: options.getOccurrences,
  }
}

const warned = new Set<string>()
function warnOnce(key: string, message: string) {
  if (process.env.NODE_ENV !== "production" && !warned.has(key)) {
    warned.add(key)
    console.warn(`[gantt] ${message}`)
  }
}

interface GanttStore<TData> {
  instance: GanttInstance<TData>
  setOptions(next: UseGanttStateOptions<TData>): boolean
  notify(): void
  emitRangeIfChanged(): void
}

function createGanttStore<TData>(
  initial: UseGanttStateOptions<TData>
): GanttStore<TData> {
  let options = initial
  let settings = resolveSettings(initial)
  let settingsVersion = 0

  const listeners = new Set<() => void>()

  const internal = {
    scale: initial.defaultScale ?? "day",
    date: initial.defaultDate ?? new Date(),
    events: initial.defaultEvents ?? [],
    selection: initial.defaultSelection ?? EMPTY_SELECTION,
    interactions: { ...DEFAULT_INTERACTIONS, ...initial.defaultInteractions },
    drag: null as GanttDragState<TData> | null,
    slotDraft: null as GanttSlotDraft | null,
    /** #219 PR A — the active Adjust-mode session, if any. See `GanttAdjustState`'s own doc comment. */
    adjust: null as GanttAdjustState<TData> | null,
    /** Whole extra periods rendered on each side (infinite scroll). */
    rangeWindow: { before: 0, after: 0 },
    /** Visible-center instant reported by the view; drives the nav title. */
    viewportCenter: null as Date | null,
  }

  let snapshot: GanttState<TData> | null = null
  let indexCache: {
    events: GanttEvent<TData>[]
    rangeKey: string
    timeZone: string
    index: GanttIndex<TData>
  } | null = null
  let lastEmittedRangeKey: string | null = null
  /** Whether the last anchor change came from an extendRange window slide. */
  let lastAnchorChangeWasSlide = false
  /**
   * Quincy addition (#219 PR A round 3, Sol HIGH #5): see `GanttInternals.getAdjustCancelledVersion`'s
   * doc comment - bumped ONLY inside `killAdjustSessionIfOrphaned`, below.
   */
  let adjustCancelledVersion = 0

  // Quincy addition (#219 PR A, Sol review, sol1 item 6): this instance's keyboard focus hand-off
  // token - see `GanttInternals.claimKeyboardFocus`'s doc comment. `notifyCount` gives it a bounded
  // lifetime with no timers: `claimKeyboardFocus` is always called AFTER the nudge's OWN commit has
  // already gone through `notify()` (once or twice - `applyProposedUpdate`'s own `setField` and the
  // caller's trailing `invalidate()`/`notify()`, for an uncontrolled `events` prop), so the token
  // records the notifyCount AT claim time, strictly AFTER those. The render that is meant to
  // consume it (the new occurrence key's bar mounting, `gantt-bar.tsx`'s `useLayoutEffect`) rides
  // that SAME already-notified batch - React flushes it before this synchronous call stack (still
  // inside the keydown handler) returns to the event loop, so no notify() call can land in
  // between. The FIRST notify() called after claim() is therefore necessarily a LATER, unrelated
  // one; consumption has already had its one chance by then.
  //
  // Quincy fix (#219 PR A, Sol re-review round 2, MEDIUM #6): was `+ 1` here, giving an unconsumed
  // token a second extra render's worth of survival (Sol: "takes two renders to expire") - a
  // window in which some LATER, unrelated bar mount matching the same eventId + targetKey (e.g. an
  // undo that recreates the exact occurrence) could still steal focus. `consumeKeyboardFocus` nulls
  // the token directly and synchronously in the happy path, before any further notify() can occur,
  // so this arithmetic only ever governs the abandoned-token fallback below.
  let pendingKeyboardFocus: GanttPendingKeyboardFocus | null = null
  let pendingKeyboardFocusClaimedAtNotifyCount = 0
  let notifyCount = 0

  const invalidate = () => {
    snapshot = null
  }

  const notify = () => {
    notifyCount++
    if (
      pendingKeyboardFocus &&
      notifyCount > pendingKeyboardFocusClaimedAtNotifyCount
    ) {
      pendingKeyboardFocus = null
    }
    listeners.forEach((listener) => listener())
    emitRangeIfChanged()
  }

  /**
   * #219 PR A fix (Sol re-review round 2, HIGH #3): an Adjust session is bound to the event it
   * started on (`internal.adjust.occurrence.event`, a snapshot as of `beginAdjust`/last
   * retarget). If that event is deleted, or replaced with a new object under the same id
   * (`events` update from ANY source - a controlled prop, an uncontrolled `api.*` mutator, or a
   * consumer's own `onEventUpdate` racing this session), or the view's date/scale changes, the
   * session's captured `entry`/`preview` no longer describes anything real. Left alone, it can
   * write over the newer external state on the next Enter, or - since nothing ever cleared
   * `internal.adjust` - resurrect `role="application"`/`data-adjusting` on a bar that later
   * remounts under the same occurrence key (e.g. an undone edit reverts the event to the exact
   * start the session was keyed on). `drag` (the session's keyboard-owned ghost preview) dies
   * with it, atomically, so a render never shows one without the other. Returns whether a session
   * was actually torn down, so callers only pay for an extra `notify()` when one was.
   *
   * Quincy addition (#219 PR A round 3, Sol HIGH #5): also bumps `adjustCancelledVersion` on a
   * real teardown - see `GanttInternals.getAdjustCancelledVersion`'s own doc comment for why this
   * is the one function that ever does.
   *
   * Quincy fix (#219 PR A round 3, Sol HIGH #3): "replaced with a new object under the same id"
   * used to be OBJECT IDENTITY (`stillPresent !== session.occurrence.event`) - any fresh object
   * reference orphaned the session, even one carrying identical scheduling fields. A controlled
   * consumer produces a fresh `events` array (and fresh event objects) on every render as a matter
   * of course, so a harmless clone or a title/colour-only edit used to cancel an in-progress
   * session for no reason. This now compares the fields that actually describe WHEN/WHERE/WHETHER
   * the event is scheduled - `start`/`end`/`allDay`/`resourceId`/`recurrence` - snapshotted from
   * `session.occurrence.event` AT `beginAdjust` (never updated by a retarget, see
   * `GanttAdjustState`'s own doc comment) against the CURRENT event under the same id. The session
   * dies only when the event is gone, one of those fields actually differs, or the date/scale
   * changed - a controlled clone or a metadata-only edit (title, colour, `draggable`, …) leaves it
   * alone.
   *
   * Quincy fix (#219 PR A round 4, Sol HIGH): the "CURRENT event" side of this diff used to read
   * `session.occurrence.event` DIRECTLY - that field is the live event object, never cloned, so an
   * in-place mutation of it (or of one of its own `start`/`end` `Date` objects) moved BOTH sides of
   * every comparison below at once: `stillPresent` (found by id in `nextEvents`) IS
   * `session.occurrence.event` whenever the event was mutated rather than replaced, so the
   * comparison was really `x.getTime() !== x.getTime()` - always `false`, whatever changed. This
   * now diffs against `session.ownerSnapshot` - immutable primitives captured at `beginAdjust`
   * (see that field's own doc comment on `GanttAdjustState`) - which cannot alias the live event
   * no matter what happens to it afterward.
   */
  const killAdjustSessionIfOrphaned = (
    nextEvents: GanttEvent<TData>[],
    dateOrScaleChanged: boolean
  ): boolean => {
    const session = internal.adjust
    if (!session) return false
    const stillPresent = nextEvents.find((event) => event.id === session.eventId)
    const owner = session.ownerSnapshot
    const scheduleDrifted =
      !stillPresent ||
      stillPresent.start.getTime() !== owner.startMs ||
      stillPresent.end.getTime() !== owner.endMs ||
      (stillPresent.allDay ?? false) !== owner.allDay ||
      stillPresent.resourceId !== owner.resourceId ||
      !!stillPresent.recurrence !== owner.recurring
    const orphaned = scheduleDrifted || dateOrScaleChanged
    if (!orphaned) return false
    internal.adjust = null
    internal.drag = null
    // Quincy addition (#219 PR A round 3, Sol HIGH #5): this IS the external teardown - see
    // `GanttInternals.getAdjustCancelledVersion`'s doc comment for why this is the one and only
    // place that bumps it.
    adjustCancelledVersion++
    return true
  }

  const getState = (): GanttState<TData> => {
    if (snapshot) return snapshot
    const scale = options.scale ?? internal.scale
    const date = options.date ?? internal.date
    const rangeOpts = {
      timeZone: settings.timeZone,
      weekStartsOn: settings.weekStartsOn,
    }
    const { visibleRange: baseRange, activeRange } = getGanttDateRange(
      scale,
      date,
      rangeOpts
    )
    // Infinite scroll: widen by whole periods; the anchor period stays put
    const { before, after } = internal.rangeWindow
    let visibleRange = baseRange
    if (before > 0 || after > 0) {
      let earlier = date
      for (let i = 0; i < before; i++) {
        earlier = stepGanttDate(scale, earlier, -1, rangeOpts)
      }
      let later = date
      for (let i = 0; i < after; i++) {
        later = stepGanttDate(scale, later, 1, rangeOpts)
      }
      visibleRange = {
        start: getGanttDateRange(scale, earlier, rangeOpts).visibleRange.start,
        end: getGanttDateRange(scale, later, rangeOpts).visibleRange.end,
      }
    }
    snapshot = {
      scale,
      date,
      visibleRange,
      activeRange,
      events: options.events ?? internal.events,
      selection: options.selection ?? internal.selection,
      interactions: options.interactions
        ? { ...DEFAULT_INTERACTIONS, ...options.interactions }
        : internal.interactions,
      loading: options.loading ?? false,
      drag: internal.drag,
      slotDraft: internal.slotDraft,
      adjust: internal.adjust,
      viewportCenter: internal.viewportCenter,
    }
    return snapshot
  }

  const emitRangeIfChanged = () => {
    if (!settings.onRangeChange) return
    const state = getState()
    const key = `${state.scale}:${getRangeKey(state.visibleRange)}:${settings.timeZone}`
    if (key === lastEmittedRangeKey) return
    lastEmittedRangeKey = key
    settings.onRangeChange({
      range: state.visibleRange,
      activeRange: state.activeRange,
      scale: state.scale,
      date: state.date,
      timeZone: settings.timeZone,
    })
  }

  type ControlledKey =
    | "scale"
    | "date"
    | "events"
    | "selection"
    | "interactions"

  const setField = <K extends ControlledKey>(
    key: K,
    value: GanttState<TData>[K extends "events" ? "events" : K]
  ) => {
    const controlled = options[key] !== undefined
    if (key === "date" || key === "scale") {
      // value-equal sets are no-ops: they must not touch store state (the
      // controlled path would mutate without notify) nor drop infinite-
      // scroll growth for a navigation that never happened
      const current = getState()[key]
      const same =
        key === "date"
          ? (current as Date).getTime() === (value as Date).getTime()
          : current === value
      if (same) return
      // navigating re-anchors the axis; drop any infinite-scroll growth and
      // let the title follow the anchor again until the user scrolls
      internal.rangeWindow = { before: 0, after: 0 }
      internal.viewportCenter = null
      lastAnchorChangeWasSlide = false
      invalidate()
    }
    if (!controlled) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(internal as any)[key] = value
      invalidate()
      // #219 PR A fix (Sol re-review round 2, HIGH #3): uncontrolled `events`/`date`/`scale`
      // never flow back through `setOptions` (that only re-runs on a prop change, and these
      // are internal state) - this is the one place an uncontrolled mutation actually lands,
      // so it is where an active Adjust session's owner-death check has to live for that mode.
      if (key === "events" || key === "date" || key === "scale") {
        killAdjustSessionIfOrphaned(internal.events, key === "date" || key === "scale")
      }
    }
    const callbacks: Record<ControlledKey, ((v: never) => void) | undefined> = {
      scale: settings.onScaleChange as never,
      date: settings.onDateChange as never,
      events: settings.onEventsChange as never,
      selection: settings.onSelectionChange as never,
      interactions: settings.onInteractionsChange as never,
    }
    callbacks[key]?.(value as never)
    if (!controlled) notify()
  }

  const applyProposedUpdate = (
    update: GanttProposedUpdate<TData>,
    // extra non-timing fields committed in the SAME events emission: a second
    // setField pass would read stale controlled options.events and emit an
    // array without the timing change
    extra?: Partial<GanttEvent<TData>>
  ): { start: Date; end: Date; allDay: boolean } | null => {
    const result = settings.onEventUpdate?.(update)
    if (result === false) return null
    const acceptedStart = result && typeof result === "object" ? result.start ?? update.start : update.start
    const acceptedEnd = result && typeof result === "object" ? result.end ?? update.end : update.end
    const acceptedAllDay = result && typeof result === "object" ? result.allDay ?? update.allDay : update.allDay
    const adjusted: Partial<GanttEvent<TData>> = {
      start: acceptedStart,
      end: acceptedEnd,
      allDay: acceptedAllDay,
    }
    if (update.resourceId !== undefined) adjusted.resourceId = update.resourceId
    const merged = extra ? { ...extra, ...adjusted } : adjusted
    const events = getState().events
    const next = events.map((event) =>
      event.id === update.event.id ? { ...event, ...merged } : event
    )
    setField("events", next)
    // update.start/end/allDay are always Date/boolean at both call sites (nudgeEvent's own
    // proposal, gantt-dnd.tsx's drag.proposed*) - a consumer's `result` can only override with
    // its own concrete values, never introduce `undefined`, so these are never undefined either.
    return { start: acceptedStart!, end: acceptedEnd!, allDay: acceptedAllDay! }
  }

  const getIndex = (): GanttIndex<TData> => {
    const state = getState()
    const rangeKey = getRangeKey(state.visibleRange)
    if (
      indexCache &&
      indexCache.events === state.events &&
      indexCache.rangeKey === rangeKey &&
      indexCache.timeZone === settings.timeZone
    ) {
      return indexCache.index
    }
    const index = buildEventIndex(state.events, state.visibleRange, {
      timeZone: settings.timeZone,
      eventOrder: settings.eventOrder,
      getOccurrences: settings.getOccurrences,
    })
    indexCache = {
      events: state.events,
      rangeKey,
      timeZone: settings.timeZone,
      index,
    }
    return index
  }

  /** The SAME keyboard step (in minutes) `nudgeEvent` has always used, factored out so Adjust
   * mode's `stepAdjust` can size its own "snap" step from the identical rule. Mirrors
   * `gantt-view.tsx`'s own `snapMin` for the pointer's sub-day snap. */
  const baseNudgeStepMinutes = (): number => {
    const state = getState()
    return state.scale === "day" ? settings.snapDuration : 24 * 60
  }

  /**
   * Quincy fix (#219 PR A, Sol re-review round 2, HIGH #2): factored out of `proposeNudge` below so
   * `commitAdjust`'s final re-validation (`validateAdjustCommit`) can check the SAME per-action lock
   * rule against the CURRENT event/state without re-deriving a stepped proposal. `readOnly`/
   * `recurrence` are event-wide, checked once by callers before iterating actions; this only covers
   * the per-ACTION (move vs. a specific resize edge) half of the gate.
   */
  /**
   * Quincy fix (#219 PR A, Sol re-review round 2, MEDIUM #5): `nudgeEvent` (unlike Adjust mode,
   * which already carries `session.occurrence` from `beginAdjust`) has no occurrence in hand.
   * `proposeNudge` always refuses `event.recurrence` before this could ever be reached for a
   * recurring event (see its own check, below), so the event's own start/end IS its sole
   * occurrence - the same shape `gantt-recurrence.tsx`'s own non-recurring branch builds.
   */
  const soleOccurrenceOf = (event: GanttEvent<TData>): GanttOccurrence<TData> => ({
    key: `${event.id}::${event.start.toISOString()}`,
    eventId: event.id,
    event,
    start: event.start,
    end: event.end,
    allDay: event.allDay ?? false,
    isRecurring: false,
  })

  const isActionLocked = (
    event: GanttEvent<TData>,
    action: GanttNudgeAction,
    state: GanttState<TData>
  ): boolean => {
    if (action === "move") {
      return !state.interactions.drag || event.draggable === false
    }
    const edge = action === "resize-start" ? "start" : "end"
    return !state.interactions.resize || !isResizableEdge(event, edge)
  }

  /**
   * The shared core of ONE keyboard move/resize proposal - locks, the day/minute step math
   * (`computeGanttKeyboardProposal`), the overlap/clamp policy, and the advisory/enforced
   * `canDropEvent` check. `nudgeEvent` (below) calls this once with `subject = {event.start,
   * event.end}` and commits immediately; Adjust mode's `stepAdjust` (in `internals`) calls this
   * repeatedly with `subject = ` the session's CURRENT preview, so steps accumulate, and defers
   * committing until `commitAdjust`. Never commits anything itself - purely a gated proposal.
   */
  const proposeNudge = (
    event: GanttEvent<TData>,
    subject: { start: Date; end: Date; allDay: boolean },
    action: GanttNudgeAction,
    direction: -1 | 1,
    step: number,
    viewScheduleMode: GanttScheduleMode | undefined,
    excludeEventId: GanttBarId,
    // Quincy fix (#219 PR A, Sol re-review round 2, MEDIUM #5): the caller's occurrence, passed
    // through to the `canDropEvent` check below instead of a hardcoded null - `nudgeEvent` builds
    // one (`soleOccurrenceOf`), `stepAdjust` passes its session's own.
    occurrence: GanttOccurrence<TData>
  ):
    | { ok: true; start: Date; end: Date; allDay: boolean }
    | { ok: false; reason: "locked" | "invalid" | "rejected" } => {
    if (event.readOnly) return { ok: false, reason: "locked" }
    // Quincy fix (#219 PR A, Sol review, sol1 item 2): no occurrence-aware exception semantics yet
    // - see `nudgeEvent`'s own comment on the identical check, which this replaces.
    if (event.recurrence) return { ok: false, reason: "locked" }
    const state = getState()
    if (isActionLocked(event, action, state)) {
      return { ok: false, reason: "locked" }
    }

    const proposal = computeGanttKeyboardProposal(
      subject,
      action,
      direction,
      step,
      settings.timeZone
    )
    if (!proposal) return { ok: false, reason: "invalid" }

    // Overlap policy: a "single" schedule-mode node always rejects concurrency; otherwise
    // settings.overlap decides, through the SAME shared gantt-lib.tsx helpers gantt-dnd.tsx's
    // beginGesture uses (sol1 item 3) - shared by nudgeEvent AND stepAdjust via this function.
    const node = event.resourceId
      ? findResource(settings.resources, event.resourceId)
      : null
    const nodeMode = resolveScheduleMode(node, viewScheduleMode)
    const overlapPolicy = resolveOverlapPolicy(nodeMode, settings.overlap)

    let finalProposal = proposal
    if (overlapPolicy !== "allow" && event.resourceId !== undefined) {
      // Range-aware, not `visibleRange`-limited (Sol MEDIUM, sol1 item 3): the query spans the
      // UNION of the CURRENT subject's own span and the proposal, so a same-resource neighbour the
      // step is actually about to touch is seen even when it sits outside the current viewport.
      // For a chained Adjust-mode step this is the session's current PREVIEW, not the originally
      // committed range - the same rule nudgeEvent's single step already applies (subject ===
      // event.start/end there).
      const neighbourFrom = new Date(
        Math.min(proposal.start.getTime(), subject.start.getTime())
      )
      const neighbourTo = new Date(
        Math.max(proposal.end.getTime(), subject.end.getTime())
      )
      const neighbours: GanttOverlapNeighbour[] = api
        .getOccurrences({ start: neighbourFrom, end: neighbourTo })
        .filter(
          (other) =>
            other.event.resourceId === event.resourceId &&
            other.eventId !== excludeEventId
        )
        .map((other) => ({
          start: other.start.getTime(),
          end: other.end.getTime(),
        }))

      if (overlapPolicy === "clamp") {
        const clamped = clampToNeighbours(
          action,
          { start: subject.start, end: subject.end },
          proposal,
          neighbours,
          overlapPolicy
        )
        finalProposal = { ...proposal, start: clamped.start, end: clamped.end }
      } else if (overlapsAnyNeighbour(neighbours, proposal)) {
        return { ok: false, reason: "rejected" }
      }
    }

    const update: GanttProposedUpdate<TData> = {
      event,
      occurrence,
      start: finalProposal.start,
      end: finalProposal.end,
      allDay: finalProposal.allDay,
      resourceId: event.resourceId,
      source: "keyboard",
    }
    // canDropEvent stays advisory unless enforceCanDrop, mirroring the pointer release check in
    // gantt-dnd.tsx's onPointerUp exactly.
    const valid = settings.canDropEvent ? settings.canDropEvent(update) : true
    if (settings.enforceCanDrop && !valid) {
      return { ok: false, reason: "rejected" }
    }

    return {
      ok: true,
      start: finalProposal.start,
      end: finalProposal.end,
      allDay: finalProposal.allDay,
    }
  }

  /**
   * Quincy fix (#219 PR A, Sol re-review round 2, HIGH #2): re-validates an Adjust session's FINAL
   * preview against the CURRENT event + settings, immediately before `commitAdjust`'s single
   * `applyProposedUpdate` call. `stepAdjust`'s own gate (`proposeNudge`, above) only ever checked
   * state AT THAT STEP; nothing re-checked it again right before the write, so a consumer that
   * locked an edge, added an overlapping neighbour, or flipped `enforceCanDrop` between the last
   * accepted step and Enter could still have the stale preview committed.
   *
   * Checks, in order: the event carries no `readOnly`/`recurrence` (re-checked - either can change
   * out from under an in-progress session, same as `proposeNudge`'s own event-wide check); every
   * target TOUCHED during the session (`session.touchedTargets` - not just the CURRENT one, because
   * a move-then-retarget-to-resize session's final range can reflect BOTH) is still unlocked; the
   * CURRENT overlap policy against CURRENT same-resource neighbours ("reject" refuses outright,
   * "clamp" re-clamps the session's own before/after arc - anchor = `session.entry`, the pre-session
   * span, proposal = `session.preview`, mirroring `clampToNeighbours`' own "a pre-existing overlap
   * has no edge to stop at" rule, the same way each individual step already anchors against ITS OWN
   * pre-step subject); and the enforced `canDropEvent` gate. Returns the (possibly re-clamped) final
   * range on success - `commitAdjust` writes THAT, not the raw `session.preview`, so a neighbour that
   * appeared mid-session under "clamp" still stops the write at its edge instead of silently
   * overlapping it.
   *
   * Quincy fix (#219 PR A round 3, Sol HIGH #2): `clampToNeighbours` is called with `session.target`
   * - the LAST target the session was retargeted to, not every edge it actually touched. A
   * move-then-retarget-to-resize-end session's "resize-end" clamp kind only ever bounds the END
   * ("to"); it never touches "from" at all, by design (a resize-end gesture should never move the
   * start). But `finalRange.start` still carries whatever the earlier "move" step left it at, and a
   * neighbour that only overlaps THAT edge has no clamp defending it once the CURRENT target has
   * moved on - `session.target`'s own clamp has no reason to even look at that edge. Re-checking the
   * CLAMPED range against every neighbour on both edges (not just the one `session.target` implies)
   * closes that: any residual overlap under a policy that forbids one ("clamp" or "reject" - never
   * "allow", which permits overlap by design) refuses the commit instead of writing it.
   */
  const validateAdjustCommit = (
    event: GanttEvent<TData>,
    session: GanttAdjustState<TData>,
    viewScheduleMode: GanttScheduleMode | undefined
  ):
    | { ok: true; start: Date; end: Date; allDay: boolean }
    | { ok: false; reason: "locked" | "rejected" } => {
    if (event.readOnly) return { ok: false, reason: "locked" }
    if (event.recurrence) return { ok: false, reason: "locked" }
    const state = getState()
    for (const target of session.touchedTargets) {
      if (isActionLocked(event, target, state)) {
        return { ok: false, reason: "locked" }
      }
    }

    const node = event.resourceId
      ? findResource(settings.resources, event.resourceId)
      : null
    const nodeMode = resolveScheduleMode(node, viewScheduleMode)
    const overlapPolicy = resolveOverlapPolicy(nodeMode, settings.overlap)

    let finalRange = {
      start: session.preview.start,
      end: session.preview.end,
      allDay: session.preview.allDay,
    }
    if (overlapPolicy !== "allow" && event.resourceId !== undefined) {
      const neighbourFrom = new Date(
        Math.min(session.entry.start.getTime(), session.preview.start.getTime())
      )
      const neighbourTo = new Date(
        Math.max(session.entry.end.getTime(), session.preview.end.getTime())
      )
      const neighbours: GanttOverlapNeighbour[] = api
        .getOccurrences({ start: neighbourFrom, end: neighbourTo })
        .filter(
          (other) =>
            other.event.resourceId === event.resourceId &&
            other.eventId !== session.eventId
        )
        .map((other) => ({
          start: other.start.getTime(),
          end: other.end.getTime(),
        }))

      if (overlapPolicy === "clamp") {
        const clamped = clampToNeighbours(
          session.target,
          { start: session.entry.start, end: session.entry.end },
          finalRange,
          neighbours,
          overlapPolicy
        )
        finalRange = { ...finalRange, start: clamped.start, end: clamped.end }
        // Quincy fix (#219 PR A round 3, Sol HIGH #2): the clamp above only defends the edge
        // session.target implies - see this method's own doc comment. Re-check the CLAMPED range
        // against every neighbour on BOTH edges; a residual overlap on the edge an EARLIER target
        // touched (and the current target's clamp kind never looks at) refuses the commit instead
        // of silently writing an overlapping range.
        if (overlapsAnyNeighbour(neighbours, finalRange)) {
          return { ok: false, reason: "rejected" }
        }
      } else if (overlapsAnyNeighbour(neighbours, finalRange)) {
        return { ok: false, reason: "rejected" }
      }
    }

    const update: GanttProposedUpdate<TData> = {
      event,
      occurrence: session.occurrence,
      start: finalRange.start,
      end: finalRange.end,
      allDay: finalRange.allDay,
      resourceId: event.resourceId,
      source: "keyboard",
    }
    const valid = settings.canDropEvent ? settings.canDropEvent(update) : true
    if (settings.enforceCanDrop && !valid) {
      return { ok: false, reason: "rejected" }
    }

    return {
      ok: true,
      start: finalRange.start,
      end: finalRange.end,
      allDay: finalRange.allDay,
    }
  }

  /** Anchor clamp: navigation may never leave the configured bounds. */
  const clampToBounds = (date: Date): Date => {
    const bounds = settings.rangeBounds
    if (!bounds) return date
    if (bounds.min && date.getTime() < bounds.min.getTime()) return bounds.min
    if (bounds.max && date.getTime() > bounds.max.getTime()) return bounds.max
    return date
  }

  const api: GanttApi<TData> = {
    next() {
      const state = getState()
      setField(
        "date",
        clampToBounds(
          stepGanttDate(state.scale, state.date, 1, {
            timeZone: settings.timeZone,
          })
        )
      )
    },
    prev() {
      const state = getState()
      setField(
        "date",
        clampToBounds(
          stepGanttDate(state.scale, state.date, -1, {
            timeZone: settings.timeZone,
          })
        )
      )
    },
    today() {
      setField("date", clampToBounds(new Date()))
    },
    goTo(date) {
      setField("date", clampToBounds(date))
    },
    setScale(scale) {
      setField("scale", scale)
    },
    getEvents() {
      return getState().events
    },
    getEvent(id) {
      return getState().events.find((event) => event.id === id)
    },
    setEvents(events) {
      setField("events", events)
    },
    addEvent(event) {
      setField("events", [...getState().events, event])
    },
    updateEvent(id, patch) {
      const event = api.getEvent(id)
      if (!event) return
      const merged = { ...event, ...patch }
      const timingChanged =
        patch.start !== undefined ||
        patch.end !== undefined ||
        patch.allDay !== undefined
      if (timingChanged && settings.onEventUpdate) {
        // timing + rest commit as ONE events emission (a rejected update
        // drops the whole patch, same as before)
        const rest = { ...patch }
        delete rest.start
        delete rest.end
        delete rest.allDay
        applyProposedUpdate(
          {
            event: merged,
            occurrence: null,
            start: merged.start,
            end: merged.end,
            allDay: merged.allDay ?? false,
            source: "api",
          },
          Object.keys(rest).length > 0 ? rest : undefined
        )
        return
      }
      setField(
        "events",
        getState().events.map((e) => (e.id === id ? merged : e))
      )
    },
    nudgeEvent(id, action, direction, viewScheduleMode) {
      const event = api.getEvent(id)
      if (!event) return { applied: false, reason: "not-found" }
      // #219 PR A (Adjust mode) refactor: the lock/step/overlap/clamp/canDropEvent gating below
      // used to live inline here; it is now `proposeNudge`, shared with Adjust mode's `stepAdjust`
      // (`internals`) so both a single programmatic nudge and a chained Adjust-mode step apply the
      // IDENTICAL gates. Behavior is unchanged - subject is this event's own current start/end,
      // exactly as before.
      // Quincy fix (#219 PR A, Sol re-review round 2, MEDIUM #5): `nudgeEvent` has no bar/session
      // to read an occurrence off, so it builds the event's sole one - `proposeNudge` already
      // refuses `event.recurrence` before either use touches it.
      const occurrence = soleOccurrenceOf(event)
      const outcome = proposeNudge(
        event,
        { start: event.start, end: event.end, allDay: event.allDay ?? false },
        action,
        direction,
        baseNudgeStepMinutes(),
        viewScheduleMode,
        id,
        occurrence
      )
      if (!outcome.ok) return { applied: false, reason: outcome.reason }
      const update: GanttProposedUpdate<TData> = {
        event,
        occurrence,
        start: outcome.start,
        end: outcome.end,
        allDay: outcome.allDay,
        resourceId: event.resourceId,
        source: "keyboard",
      }
      // Commit through the one validation funnel; onEventUpdate can still
      // veto (-> "rejected"), same as a pointer drag's own commit.
      const accepted = applyProposedUpdate(update)
      // Quincy fix (#219 PR A, Sol review, sol1 item 7): return the ACCEPTED range from
      // `applyProposedUpdate` itself, not a follow-up `api.getEvent` read - see that
      // function's own header for the controlled-mode race this closes.
      return accepted
        ? { applied: true, start: accepted.start, end: accepted.end, allDay: accepted.allDay }
        : { applied: false, reason: "rejected" }
    },
    removeEvent(id) {
      setField(
        "events",
        getState().events.filter((event) => event.id !== id)
      )
    },
    getOccurrences(range) {
      if (!range) return getIndex().occurrences
      const state = getState()
      const within =
        range.start >= state.visibleRange.start &&
        range.end <= state.visibleRange.end
      if (within) {
        return getIndex().occurrences.filter((occ) => eventsOverlap(occ, range))
      }
      return buildEventIndex(state.events, range, {
        timeZone: settings.timeZone,
        eventOrder: settings.eventOrder,
        getOccurrences: settings.getOccurrences,
      }).occurrences
    },
    findOverlapping({ start, end, excludeEventId }) {
      return api
        .getOccurrences({ start, end })
        .filter((occ) => occ.eventId !== excludeEventId)
    },
    select(partial) {
      const current = getState().selection
      setField("selection", {
        eventKeys: partial.eventKeys ?? current.eventKeys,
        slot: partial.slot !== undefined ? partial.slot : current.slot,
      })
    },
    selectEvent(key, opts) {
      const current = getState().selection
      const eventKeys = opts?.additive
        ? current.eventKeys.includes(key)
          ? current.eventKeys.filter((k) => k !== key)
          : [...current.eventKeys, key]
        : [key]
      setField("selection", { ...current, eventKeys })
    },
    clearSelection() {
      setField("selection", EMPTY_SELECTION)
    },
    setInteractions(patch) {
      setField("interactions", { ...getState().interactions, ...patch })
    },
    getVisibleRange() {
      return getState().visibleRange
    },
    getActiveRange() {
      return getState().activeRange
    },
    toZoned(date) {
      return toZoned(date, settings.timeZone)
    },
  }

  const internals: GanttInternals<TData> = {
    getIndex,
    setDrag(drag) {
      internal.drag = drag
      invalidate()
      notify()
    },
    setSlotDraft(draft) {
      internal.slotDraft = draft
      invalidate()
      notify()
    },
    setViewportCenter(date) {
      const prev = internal.viewportCenter
      if (prev?.getTime() === date?.getTime()) return
      internal.viewportCenter = date
      invalidate()
      notify()
    },
    applyProposedUpdate,
    getSettingsVersion() {
      return settingsVersion
    },
    extendRange(direction) {
      const state = getState()
      const bounds = settings.rangeBounds
      if (
        direction === "before" &&
        bounds?.min &&
        state.visibleRange.start.getTime() <= bounds.min.getTime()
      ) {
        return false
      }
      if (
        direction === "after" &&
        bounds?.max &&
        state.visibleRange.end.getTime() >= bounds.max.getTime()
      ) {
        return false
      }
      const cap = Math.max(1, settings.maxRangeWindow ?? MAX_RANGE_WINDOW)
      const { before, after } = internal.rangeWindow
      const grow = direction === "before" ? before < cap : after < cap
      if (grow) {
        internal.rangeWindow =
          direction === "before"
            ? { before: before + 1, after }
            : { before, after: after + 1 }
      } else {
        // window is at capacity: SLIDE the anchor one period instead, so
        // travel stays unbounded while the DOM stays bounded
        const next = stepGanttDate(
          state.scale,
          state.date,
          direction === "before" ? -1 : 1,
          {
            timeZone: settings.timeZone,
          }
        )
        if (options.date !== undefined) {
          // controlled anchor: propose the slide; nothing changes until the
          // parent adopts it - and THAT re-render lands through `setOptions`,
          // which already calls `killAdjustSessionIfOrphaned` on a date change
          // (see below), so no separate call is needed on this branch.
          settings.onDateChange?.(next)
          return false
        }
        internal.date = next
        lastAnchorChangeWasSlide = true
        // Quincy fix (#219 PR A round 3, Sol HIGH #4a): this uncontrolled anchor slide never flows
        // through `setOptions` (that only runs on a controlled prop change) or `setField` (this
        // branch assigns `internal.date` directly, bypassing it) - it was a teardown bypass
        // identical in kind to the ones `setField`/`setOptions` already close for a `goTo`/scale
        // change. A PURE window grow (the `if (grow)` branch above) deliberately does NOT call this
        // - it never moves the anchor, so an active session's occurrence/preview mapping is still
        // valid.
        killAdjustSessionIfOrphaned(internal.events, true)
        settings.onDateChange?.(next)
      }
      invalidate()
      notify()
      return true
    },
    didAnchorSlide() {
      return lastAnchorChangeWasSlide
    },
    getAdjustCancelledVersion() {
      return adjustCancelledVersion
    },
    claimKeyboardFocus(token) {
      pendingKeyboardFocus = token
      pendingKeyboardFocusClaimedAtNotifyCount = notifyCount
    },
    consumeKeyboardFocus(eventId, key) {
      if (
        pendingKeyboardFocus &&
        pendingKeyboardFocus.eventId === eventId &&
        pendingKeyboardFocus.targetKey === key
      ) {
        pendingKeyboardFocus = null
        return true
      }
      return false
    },
    clearKeyboardFocus() {
      pendingKeyboardFocus = null
    },
    beginAdjust(eventId, occurrence, initialTarget) {
      // Quincy fix (#219 PR A, Sol re-review round 2, HIGH #4): see this method's own interface
      // doc comment - a pointer gesture anywhere on the page (pending, not only active) refuses a
      // NEW keyboard session outright, rather than letting both inputs drive `state.drag` at once.
      if (isGanttGestureInFlight()) return false
      const entry = {
        start: occurrence.start,
        end: occurrence.end,
        allDay: occurrence.allDay,
      }
      internal.adjust = {
        eventId,
        occurrence,
        target: initialTarget,
        entry,
        // No `state.drag` yet: the committed bar's own position IS the preview until the
        // first accepted step (the bar renders it via `data-adjusting`, not a ghost - see
        // this interface's `stepAdjust` doc comment for when the ghost path starts).
        preview: entry,
        // Quincy fix (#219 PR A, Sol re-review round 2, HIGH #2): every target the session has ever
        // been under - `commitAdjust`'s final re-validation checks ALL of them, not just whichever
        // one is current at commit time. See `validateAdjustCommit`'s own doc comment.
        touchedTargets: [initialTarget],
        // Quincy fix (#219 PR A round 4, Sol HIGH): immutable primitives, NOT a reference into
        // `occurrence.event` - see `GanttAdjustState.ownerSnapshot`'s own doc comment for why
        // `killAdjustSessionIfOrphaned` needs this instead of diffing the live event directly.
        ownerSnapshot: {
          startMs: occurrence.event.start.getTime(),
          endMs: occurrence.event.end.getTime(),
          allDay: occurrence.event.allDay ?? false,
          resourceId: occurrence.event.resourceId,
          recurring: !!occurrence.event.recurrence,
        },
      }
      invalidate()
      notify()
      return true
    },
    stepAdjust(direction, unit, viewScheduleMode) {
      const session = internal.adjust
      if (!session) return { applied: false, reason: "invalid" }
      const event = api.getEvent(session.eventId)
      if (!event) return { applied: false, reason: "invalid" }
      const base = baseNudgeStepMinutes()
      const step =
        unit === "large" ? resolveAdjustLargerStepMinutes(base) : base
      const outcome = proposeNudge(
        event,
        session.preview,
        session.target,
        direction,
        step,
        viewScheduleMode,
        session.eventId,
        session.occurrence
      )
      if (!outcome.ok) return { applied: false, reason: outcome.reason }
      // Quincy fix (#219 PR A, Sol re-review round 2, LOW): a post-clamp proposal identical to the
      // session's CURRENT preview (already sitting at an overlap-"clamp" neighbour's edge, or a
      // bounds clamp) is a no-op - true no state write at all (not even `invalidate()`/`notify()`),
      // and `gantt-bar.tsx`'s own caller skips announcing, so held-down key-repeat past that point
      // is silent instead of re-announcing the identical range on every repeat.
      if (
        outcome.start.getTime() === session.preview.start.getTime() &&
        outcome.end.getTime() === session.preview.end.getTime() &&
        outcome.allDay === session.preview.allDay
      ) {
        return {
          applied: false,
          noChange: true,
          start: session.preview.start,
          end: session.preview.end,
          allDay: session.preview.allDay,
        }
      }
      const preview = {
        start: outcome.start,
        end: outcome.end,
        allDay: outcome.allDay,
      }
      internal.adjust = { ...session, preview }
      // Drives the SAME ghost-preview render path a pointer gesture's own `applyProposal`
      // does (`gantt-view.tsx`'s `fractionOf(drag.proposedStart/End)`) - see this interface's
      // `stepAdjust` doc comment. `valid: true`: an accepted step already passed the identical
      // lock/overlap/canDropEvent gate `nudgeEvent`'s single commit does (`proposeNudge`), so
      // there is nothing left to style as invalid.
      internal.drag = {
        kind: session.target,
        occurrence: session.occurrence,
        proposedStart: preview.start,
        proposedEnd: preview.end,
        proposedAllDay: preview.allDay,
        proposedResourceId: event.resourceId,
        valid: true,
        // #219 PR A fix (Sol re-review round 2, HIGH #4): tags this ghost as keyboard-owned - see
        // `gantt-types.tsx`'s `GanttDragState.source` doc comment.
        source: "keyboard",
      }
      invalidate()
      notify()
      return {
        applied: true,
        start: preview.start,
        end: preview.end,
        allDay: preview.allDay,
      }
    },
    retargetAdjust(target) {
      if (!internal.adjust) return
      // Preview carries over: switching M/S/E mid-session keeps whatever the prior target
      // already moved/resized to, so a move-then-resize sequence composes instead of the
      // second target discarding the first's work.
      const touchedTargets = internal.adjust.touchedTargets.includes(target)
        ? internal.adjust.touchedTargets
        : [...internal.adjust.touchedTargets, target]
      internal.adjust = { ...internal.adjust, target, touchedTargets }
      invalidate()
      notify()
    },
    commitAdjust(viewScheduleMode) {
      const session = internal.adjust
      if (!session) return { committed: false }
      const event = api.getEvent(session.eventId)
      // Clear the session (and any driven ghost) before the commit call below, so its own
      // `notify()` (uncontrolled `events`) already reflects Adjust mode having ended - a
      // controlled `events` prop never calls `setField`'s internal `notify()`, so this
      // function's own `invalidate()`/`notify()` below is what a controlled consumer relies on.
      internal.adjust = null
      internal.drag = null
      if (!event) {
        invalidate()
        notify()
        return { committed: false }
      }
      const noChange =
        session.preview.start.getTime() === session.entry.start.getTime() &&
        session.preview.end.getTime() === session.entry.end.getTime() &&
        session.preview.allDay === session.entry.allDay
      if (noChange) {
        invalidate()
        notify()
        return { committed: false, noChange: true }
      }
      // Quincy fix (#219 PR A, Sol re-review round 2, HIGH #2): re-validate the FINAL preview
      // against the CURRENT event/settings immediately before the write - see
      // `validateAdjustCommit`'s own doc comment for why a step-time-only gate is not enough.
      const revalidation = validateAdjustCommit(event, session, viewScheduleMode)
      if (!revalidation.ok) {
        invalidate()
        notify()
        return { committed: false }
      }
      const update: GanttProposedUpdate<TData> = {
        event,
        occurrence: session.occurrence,
        start: revalidation.start,
        end: revalidation.end,
        allDay: revalidation.allDay,
        resourceId: event.resourceId,
        source: "keyboard",
      }
      const accepted = applyProposedUpdate(update)
      invalidate()
      notify()
      return accepted
        ? {
            committed: true,
            start: accepted.start,
            end: accepted.end,
            allDay: accepted.allDay,
          }
        : { committed: false }
    },
    cancelAdjust() {
      if (!internal.adjust) return
      internal.adjust = null
      internal.drag = null
      // Quincy addition (#219 PR A round 3, Sol HIGH #5): see `GanttInternals.getAdjustCancelledVersion`'s
      // own doc comment - this and `killAdjustSessionIfOrphaned` are the two callers that ever bump
      // it; `<Gantt>`'s root announcer effect is what turns this into the single "Adjustment
      // cancelled." message now, so the three `gantt-bar.tsx` call sites that used to announce it
      // inline (blur, pointerdown-elsewhere, Escape) no longer need to.
      adjustCancelledVersion++
      invalidate()
      notify()
    },
  }

  const instance: GanttInstance<TData> = {
    getState,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    api,
    get settings() {
      return settings
    },
    internals,
  }

  const STATE_KEYS = [
    "events",
    "scale",
    "date",
    "selection",
    "interactions",
    "loading",
  ] as const
  const SETTINGS_KEYS = [
    "timeZone",
    "locale",
    "weekStartsOn",
    "slotDuration",
    "snapDuration",
    "i18n",
    "rangeBounds",
    "activation",
    "maxRangeWindow",
    "resources",
    "overlap",
    "enforceCanDrop",
    "getEventPriority",
    "eventOrder",
    "getOccurrences",
  ] as const

  return {
    instance,
    setOptions(next) {
      const prev = options
      options = next
      // compare by value: a freshly constructed but equal controlled date
      // must not wipe infinite-scroll growth on every parent re-render
      if (
        prev.date?.getTime() !== next.date?.getTime() ||
        prev.scale !== next.scale
      ) {
        internal.rangeWindow = { before: 0, after: 0 }
        lastAnchorChangeWasSlide = false
      }
      let changed = false
      for (const key of STATE_KEYS) {
        if (prev[key] !== next[key]) {
          changed = true
          break
        }
      }
      // #219 PR A fix (Sol re-review round 2, HIGH #3): controlled `events`/`date`/`scale` land
      // here on every render that changes them - the one place a controlled owner-death has to
      // be caught (the uncontrolled equivalent lives in `setField`, which this mode never runs).
      if (
        killAdjustSessionIfOrphaned(
          next.events ?? internal.events,
          prev.date?.getTime() !== next.date?.getTime() || prev.scale !== next.scale
        )
      ) {
        changed = true
      }
      let settingsChanged = false
      for (const key of SETTINGS_KEYS) {
        if (prev[key] !== next[key]) {
          settingsChanged = true
          break
        }
      }
      settings = resolveSettings(next)
      if (settingsChanged) {
        settingsVersion++
        changed = true
      }
      if (changed) invalidate()
      return changed
    },
    notify,
    emitRangeIfChanged,
  }
}

/**
 * Headless root hook - the full calendar engine without any markup.
 * Pass the returned instance to <Gantt calendar={instance}> or drive
 * fully custom UI from instance.getState()/subscribe/api.
 */
function useGanttState<TData = unknown>(
  options: UseGanttStateOptions<TData> = {}
): GanttInstance<TData> {
  const [store] = useState(() => createGanttStore<TData>(options))
  const changed = store.setOptions(options)
  const changedRef = useRef(false)
  if (changed) changedRef.current = true
  useLayoutEffect(() => {
    if (changedRef.current) {
      changedRef.current = false
      store.notify()
    }
  })
  useEffect(() => {
    store.emitRangeIfChanged()
    // mount-only: onRangeChange fires once for the initial range
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return store.instance
}

const GanttContext =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createContext<GanttInstance<any> | null>(null)

/** The stable calendar instance; throws outside <Gantt>. */
function useGantt<TData = unknown>(): GanttInstance<TData> {
  const instance = useContext(GanttContext)
  if (!instance) {
    throw new Error("useGantt must be used within <Gantt>")
  }
  return instance as GanttInstance<TData>
}

interface UseGanttSelectorOptions<TData, TSelected> {
  calendar?: GanttInstance<TData>
  isEqual?: (a: TSelected, b: TSelected) => boolean
}

/** Fine-grained subscription with equality memoization (Object.is default). */
function useGanttSelector<TData = unknown, TSelected = unknown>(
  selector: (state: GanttState<TData>) => TSelected,
  options?: UseGanttSelectorOptions<TData, TSelected>
): TSelected {
  const contextInstance = useContext(GanttContext)
  const instance = options?.calendar ?? contextInstance
  if (!instance) {
    throw new Error(
      "useGanttSelector needs an <Gantt> ancestor or an explicit `calendar` option"
    )
  }
  const isEqual = options?.isEqual ?? Object.is
  const lastRef = useRef<{ value: TSelected } | null>(null)
  const selectorRef = useRef(selector)
  selectorRef.current = selector

  const getSnapshot = () => {
    const next = selectorRef.current(instance.getState() as GanttState<TData>)
    if (lastRef.current && isEqual(lastRef.current.value, next)) {
      return lastRef.current.value
    }
    lastRef.current = { value: next }
    return next
  }

  return useSyncExternalStore(instance.subscribe, getSnapshot, getSnapshot)
}

function useGanttScale(): {
  scale: GanttScale
  setScale: (scale: GanttScale) => void
} {
  const instance = useGantt()
  const scale = useGanttSelector((state) => state.scale)
  return { scale, setScale: instance.api.setScale }
}

function useGanttNavigation(): {
  date: Date
  /** i18n.functions.formatTitle output for the current view. */
  title: string
  visibleRange: GanttDateRange
  activeRange: GanttDateRange
  next: () => void
  prev: () => void
  today: () => void
  goTo: (date: Date) => void
  /** True when the anchor period contains now in the display time zone. */
  isToday: boolean
} {
  const instance = useGantt()
  const { settings } = instance
  const slice = useGanttSelector(
    (state) => ({
      date: state.date,
      scale: state.scale,
      visibleRange: state.visibleRange,
      activeRange: state.activeRange,
      viewportCenter: state.viewportCenter,
    }),
    {
      isEqual: (a, b) =>
        a.date.getTime() === b.date.getTime() &&
        a.scale === b.scale &&
        a.viewportCenter?.getTime() === b.viewportCenter?.getTime() &&
        getRangeKey(a.visibleRange) === getRangeKey(b.visibleRange),
    }
  )
  useGanttSettingsVersion(instance)
  const now = new Date()
  // The title names what you are LOOKING at: the visible-center period when
  // the view reports one, otherwise the anchor period.
  const titleDate = slice.viewportCenter ?? slice.date
  const titleActive = slice.viewportCenter
    ? getGanttDateRange(slice.scale, slice.viewportCenter, {
        timeZone: settings.timeZone,
        weekStartsOn: settings.weekStartsOn,
      }).activeRange
    : slice.activeRange
  return {
    date: slice.date,
    title: settings.i18n.functions.formatTitle(slice.scale, {
      date: toZoned(titleDate, settings.timeZone),
      activeRange: titleActive,
      visibleRange: slice.visibleRange,
      locale: settings.locale,
    }),
    visibleRange: slice.visibleRange,
    activeRange: slice.activeRange,
    next: instance.api.next,
    prev: instance.api.prev,
    today: instance.api.today,
    goTo: instance.api.goTo,
    isToday: now >= slice.activeRange.start && now < slice.activeRange.end,
  }
}

function useGanttSelection(): {
  selection: GanttSelection
  select: (selection: Partial<GanttSelection>) => void
  selectEvent: (key: string, opts?: { additive?: boolean }) => void
  clearSelection: () => void
} {
  const instance = useGantt()
  const selection = useGanttSelector((state) => state.selection)
  return {
    selection,
    select: instance.api.select,
    selectEvent: instance.api.selectEvent,
    clearSelection: instance.api.clearSelection,
  }
}

function useGanttInteractions(): {
  interactions: GanttInteractions
  setInteractions: (patch: Partial<GanttInteractions>) => void
} {
  const instance = useGantt()
  const interactions = useGanttSelector((state) => state.interactions)
  return { interactions, setInteractions: instance.api.setInteractions }
}

/** Expanded, sorted occurrences; defaults to the visible range. */
function useGanttOccurrences<TData = unknown>(
  range?: GanttDateRange
): GanttOccurrence<TData>[] {
  const instance = useGantt<TData>()
  return useGanttSelector<TData, GanttOccurrence<TData>[]>(
    () => instance.api.getOccurrences(range),
    {
      calendar: instance,
      // keys encode id + start only, so end edits (resize-end) and payload
      // changes (title, color, progress) must be compared explicitly
      isEqual: (a, b) =>
        a.length === b.length &&
        a.every(
          (occ, i) =>
            occ.key === b[i]?.key &&
            occ.end.getTime() === b[i].end.getTime() &&
            occ.event === b[i].event
        ),
    }
  )
}

interface GanttNodeSchedules<TData = unknown> {
  /** The node itself, or null when the id is not in the tree. */
  node: GanttResource | null
  /** Cardinality in force for this node (its own override, else the default). */
  scheduleMode: GanttScheduleMode
  /** The node's occurrences in the visible range, in axis order. */
  schedules: GanttOccurrence<TData>[]
  /** Pairs of the node's schedules that overlap in time. */
  conflicts: Array<[GanttOccurrence<TData>, GanttOccurrence<TData>]>
}

/**
 * Everything a consumer needs to MANAGE one node's schedules without
 * re-deriving layout: the node, its resolved cardinality, its schedules in
 * order, and the pairs that collide. Pure state - it renders nothing, so a
 * "manage schedules" panel is entirely the consumer's design.
 */
function useGanttNodeSchedules<TData = unknown>(
  nodeId: string
): GanttNodeSchedules<TData> {
  const settings = useGanttSettings<TData>()
  const viewConfig = useGanttViewConfig<TData>()
  const occurrences = useGanttOccurrences<TData>()

  const node = findResource(settings.resources, nodeId)
  const schedules = occurrences.filter(
    (occurrence) => occurrence.event.resourceId === nodeId
  )
  const conflicts: Array<[GanttOccurrence<TData>, GanttOccurrence<TData>]> = []
  // Quincy edit (#219 stage 1): non-null assertions on `schedules[i]`/`schedules[j]` (x4 below).
  // Both loop bounds (`i < schedules.length`, `j < schedules.length`) guarantee these indices are
  // defined; Quincy's stricter `noUncheckedIndexedAccess` (unset in the vendor's own tsconfig)
  // does not know that.
  for (let i = 0; i < schedules.length; i++) {
    for (let j = i + 1; j < schedules.length; j++) {
      if (eventsOverlap(schedules[i]!, schedules[j]!)) {
        conflicts.push([schedules[i]!, schedules[j]!])
      }
    }
  }
  return {
    node,
    scheduleMode: resolveScheduleMode(node, viewConfig.scheduleMode),
    schedules,
    conflicts,
  }
}

/** Subscribes to settings changes only (version counter, not state). */
function useGanttSettingsVersion<TData>(
  instance: GanttInstance<TData>
): number {
  return useSyncExternalStore(
    instance.subscribe,
    instance.internals.getSettingsVersion,
    instance.internals.getSettingsVersion
  )
}

/** Resolved settings incl. merged i18n; re-renders only when settings change. */
function useGanttSettings<TData = unknown>(): GanttSettings<TData> {
  const instance = useGantt<TData>()
  useGanttSettingsVersion(instance)
  return instance.settings
}

interface GanttClassNames {
  nav?: string
  toolbar?: string
  /** The gantt body (tree + track). */
  view?: string
  event?: string
  /** The planned-window (baseline) ghost drawn behind a bar. */
  baseline?: string
  /** The dependency-arrow layer (an SVG; color flows from currentColor). */
  dependencies?: string
}

/** Row context handed to tree-panel column and label renderers. */
interface GanttColumnContext {
  resource: GanttResource
  depth: number
  isGroup: boolean
  collapsed: boolean
}

/** One extra tree-panel column after the built-in name column. */
interface GanttColumn {
  /** Stable id; doubles as the default header label. */
  id: string
  /** Header label. */
  title?: ReactNode
  /** Fixed column width in px. Default 96. */
  width?: number
  /** Cell content alignment. Default "start". */
  align?: "start" | "center" | "end"
  /** Cell content per row; omit or return null for an empty cell. */
  render?: (ctx: GanttColumnContext) => ReactNode
  /** Extra classes on every cell of this column (header included). */
  className?: string
}

/** Pointer-activation thresholds; unset keys keep the dnd-kit parity defaults. */
interface GanttActivationConfig {
  /** Mouse travel (px) before a bar move starts. Default 5. */
  moveDistancePx?: number
  /** Mouse travel (px) before a drag-create starts. Default 4. */
  createDistancePx?: number
  /** Touch long-press delay in ms. Default 250. */
  touchDelayMs?: number
  /** Touch movement tolerance (px) during the long-press. Default 5. */
  touchTolerancePx?: number
}

/** Layout metrics (rem unless noted); every knob falls back to its default. */
/** A gridline: false to hide it, true for the default solid stroke, or a style. */
type GanttGridLine = boolean | "solid" | "dashed"

interface GanttTimelineLines {
  /** Unit boundary lines running down the timeline. Default solid. */
  vertical?: GanttGridLine
  /** Row separator lines running across the timeline. Default solid. */
  horizontal?: GanttGridLine
}

/** Resolved stroke per axis; null means the axis draws nothing. */
interface GanttResolvedLines {
  vertical: "solid" | "dashed" | null
  horizontal: "solid" | "dashed" | null
}

/**
 * One place decides what the grid draws, so the header lines, the body lines
 * and the row separators can never disagree.
 */
function resolveTimelineLines(
  value: GanttTimelineLines | "vertical" | "both" | "none" | undefined
): GanttResolvedLines {
  if (value === "none") return { vertical: null, horizontal: null }
  if (value === "vertical") return { vertical: "solid", horizontal: null }
  if (value === "both" || value === undefined) {
    return { vertical: "solid", horizontal: "solid" }
  }
  const stroke = (line: GanttGridLine | undefined) =>
    line === false ? null : line === true || line === undefined ? "solid" : line
  return {
    vertical: stroke(value.vertical),
    horizontal: stroke(value.horizontal),
  }
}

interface GanttMetrics {
  /** Height of one schedule bar. Default 1.25. */
  laneHeight?: number
  /** Gap between stacked schedules in one node. Default 0.1875. */
  laneGap?: number
  /**
   * Vertical inset between the row's edges and its block of schedules - the
   * breathing room around the stack, kept separate from laneGap so schedules
   * in one node can sit tight without cramping the row. Default 0.5.
   */
  rowPadding?: number
  /** Minimum row height. Default 2.5. */
  minRowHeight?: number
  /**
   * Drag-drop indicator height, centered in its lane band and published on
   * the ghost as --gantt-ghost-height so consumer styling can read the same
   * number. Default 1.25.
   */
  ghostHeight?: number
  /** barLabel "auto" flips the title outside below this bar width. Default 7. */
  autoLabelMin?: number
  /** Unit width at zoom 1, per scale. Day scale = width per interval unit. */
  unitWidths?: Partial<Record<GanttScale, number>>
  /** Minimum timeline pane width in px. Default 200. */
  minTimelineWidth?: number
  /** Scroll distance (px) from an edge that grows the range. Default 160. */
  infiniteScrollEdge?: number
}

/** Live gesture snapshot handed to the drag/resize indicator render props. */
interface GanttDragIndicatorProps<TData = unknown> {
  occurrence: GanttOccurrence<TData>
  kind: "move" | "resize-start" | "resize-end"
  /** Proposed (snapped) range of the current gesture step. */
  start: Date
  end: Date
  valid: boolean
  /** The event's planned (baseline) window, so a custom overlay can keep
   * drawing it mid-gesture; null when the event carries none. */
  baseline: GanttBaseline | null
}

/** Slot handed to a custom schedule-hint renderer. */
interface GanttScheduleHintProps {
  start: Date
  end: Date
  resource: GanttResource
}

/** Parent rollup handed to a custom summary renderer. */
interface GanttSummaryProps {
  resource: GanttResource
  start: Date
  end: Date
  progress: number | null
}

/** Planned window handed to a custom baseline renderer. */
interface GanttBaselineProps<TData = unknown> {
  event: GanttEvent<TData>
  start: Date
  end: Date
  /** Planned start and end coincide: a point in the plan, not a window. */
  milestone: boolean
  variance: GanttBaselineVariance
}

/** Planned NODE window handed to a custom row-baseline renderer. */
interface GanttRowBaselineProps {
  resource: GanttResource
  start: Date
  end: Date
  /** Planned start and end coincide: a point in the plan, not a window. */
  milestone: boolean
  /** Latest actual end across the node's (and, for a group, its subtree's)
   * events against the planned end; null when there is nothing to compare. */
  variance: GanttBaselineVariance | null
}

/** Left tree-panel sizing and splitter behavior. */
interface GanttTreePanelConfig {
  /** Initial panel width in px. Default 288. */
  width?: number
  /** Splitter lower bound in px. Default 180. */
  minWidth?: number
  /** Splitter upper bound in px. Default 640. */
  maxWidth?: number
  /** Drag/keyboard splitter between the panels. Default true. */
  resizable?: boolean
  /** Width of the sticky name column in px. Default 208. */
  nameColumnWidth?: number
  /** Fires after any user resize (drag release, keyboard, double-click reset). */
  onWidthChange?: (width: number) => void
}

interface GanttRenderEventProps<TData = unknown> {
  occurrence: GanttOccurrence<TData>
  segment: GanttSegment<TData>
  isDragging: boolean
  isSelected: boolean
}

/**
 * View-layer configuration: display props and render overrides. These live on
 * <Gantt> (and per-view components), never in the headless options.
 */
interface GanttViewConfig<TData = unknown> {
  /** Red now-line on the axis. */
  nowIndicator: boolean
  /**
   * Day-scale unit interval in minutes: axis units and gridlines follow it.
   */
  interval: number
  /**
   * Scroll implementation for the gantt body: "custom" (default, shadcn
   * ScrollArea) or "native" (browser scrollbars via overflow auto).
   */
  scrollbars: "custom" | "native"
  /**
   * Placement hint over empty timeline track: a validated, snapped tile that
   * opens the schedule flow (onSlotClick, else onSelectSlot) at that day.
   * Works on every scale. Default off.
   */
  displayScheduleHint: boolean
  /**
   * Where the viewport opens. `"now"` (default) centres the current instant
   * when the anchor period contains it and falls back to the anchor; `"anchor"`
   * always centres the anchor; a Date centres that instant.
   *
   * Only `"now"` follows the wall clock - which is right for a live board and
   * wrong for a demo or a report, whose opening composition must not depend on
   * the hour it is viewed at. Those pass an explicit instant.
   */
  initialCenter: "now" | "anchor" | Date
  /**
   * Empty-track presses on schedulable rows start a drag-create gesture that
   * commits through onSelectSlot. Default off: the whole panel drags-to-pan
   * instead, and scheduling flows through the hint tile / onSlotClick.
   */
  dragCreate: boolean
  /**
   * "Add task" affordance at the foot of the tree that opens the create-task
   * flow (onCreateTask). Shown only when canCreateTask allows it. Default off.
   */
  displayCreateTaskHint: boolean
  /** Floating zoom in/out control over the track. Default on. */
  zoomControl: boolean
  /**
   * Ctrl/Cmd + wheel over the timeline zooms the time range, anchored on the
   * pointer. Trackpad pinch arrives as the same event (browsers set ctrlKey
   * on it), so this is also the pinch-to-zoom switch. Default on. The gesture
   * is handed back to the browser at the zoom limits, so page zoom still
   * works there.
   */
  wheelZoom: boolean
  /** Nav button variant; all nav buttons follow it. Default "ghost". */
  navButtonVariant: "ghost" | "outline" | "secondary" | "default"
  /** Nav button size; icon buttons use the icon twin. Default "sm". */
  navButtonSize: "sm" | "default"
  /**
   * Off-day (non-working day) marking on day/week/month scales. true =
   * weekends with a muted background; a config object customizes weekdays,
   * explicit dates, a predicate, and the marker class.
   */
  offDays?: boolean | GanttOffDaysConfig
  /**
   * Extra tree-panel columns after the built-in name column. The tree panel
   * scrolls horizontally when the columns outgrow it; the name column stays
   * pinned.
   */
  columns?: GanttColumn[]
  /**
   * Consumer slot pinned at the end of the tree-panel header - the intended
   * home for an add/remove-columns dropdown menu.
   */
  columnsMenu?: ReactNode
  /** Tree-panel width, splitter bounds, and resizability. */
  treePanel?: GanttTreePanelConfig
  /**
   * Timeline gridlines. The object form controls the two axes independently
   * and gives each its own stroke: `{ vertical: "dashed", horizontal: true }`.
   * An omitted axis stays on and solid. `true` means solid.
   *
   * The three legacy shorthands still work: "none" (bare), "vertical" (unit
   * boundaries only, rows separated by whitespace) and "both" (adds row
   * separators).
   */
  timelineLines: GanttTimelineLines | "vertical" | "both" | "none"
  /**
   * Bar title placement: "inside" (default) renders it in the bar, "outside"
   * beside the bar, "auto" moves it outside only when the bar is too short.
   */
  barLabel: "inside" | "outside" | "auto"
  /** Edge chips that scroll to bars outside the visible timeline. Default true. */
  offscreenIndicators: boolean
  /**
   * Extend the timeline into the past/future while scrolling near an edge
   * (the anchor period stays the nav title). Default true.
   */
  infiniteScroll: boolean
  /** Zoom bounds and button step for the floating control. Default 0.5 - 3, step 0.25. */
  zoomRange?: { min?: number; max?: number; step?: number }
  /** Layout metric overrides (row/lane/unit geometry, thresholds). */
  metrics?: GanttMetrics
  /** Sticky nav bar (same contract as the event calendar). Default false. */
  stickyNav: boolean
  /**
   * Leaf-row selection checkboxes in the tree panel. Default true;
   * uncontrolled unless selectedRows is passed.
   */
  rowCheckboxes: boolean
  /** Controlled selected row ids; pairs with onSelectedRowsChange. */
  selectedRows?: string[]
  onSelectedRowsChange?: (ids: string[]) => void
  /** Controlled collapsed group ids; pairs with onCollapsedGroupsChange. */
  collapsedGroups?: string[]
  /** Initial collapsed group ids (uncontrolled). */
  defaultCollapsedGroups?: string[]
  onCollapsedGroupsChange?: (ids: string[]) => void
  /** Controlled zoom multiplier; pairs with onZoomChange. */
  zoom?: number
  /** Initial zoom multiplier (uncontrolled). Default 1. */
  defaultZoom?: number
  onZoomChange?: (zoom: number) => void
  /**
   * Allow drag-create and slot clicks on rows that have children. Default
   * false: parents aggregate their subtree instead of owning bars.
   */
  parentScheduling: boolean
  /**
   * Rollup strips on parent rows without bars of their own: the envelope of
   * descendant bars with duration-weighted progress. Default true.
   */
  summaryBars: boolean
  /**
   * As-built comparison: the planned window of every bar carrying
   * baselineStart/baselineEnd, ghosted behind it on its own lane (equal
   * instants draw a planned milestone diamond), and of every NODE whose
   * GanttResource carries the same pair, drawn as a band behind its lanes.
   * Display only - dragging a bar moves the actual dates and never its
   * baseline. Default true; rows and events without baseline data draw
   * nothing.
   */
  baselineBars: boolean
  /**
   * Finish-to-start arrows between bars whose events name `dependencies`.
   * Drawn from the predecessor's end into the dependent's start, under the
   * bars; endpoints on hidden rows are skipped. Default true; nothing
   * renders when no visible event names a dependency.
   */
  dependencyLines: boolean
  /**
   * How many schedules a tree node may hold. "multiple" (default) stacks
   * concurrent schedules into stable lanes and grows the row; "single" keeps
   * one track per node - the task-gantt shape. Any node can override it with
   * its own `scheduleMode`.
   */
  scheduleMode: GanttScheduleMode
  /**
   * Vertical placement of a row's content once a node holds several lanes.
   * "start" (default) keeps the tree label on the baseline of the FIRST
   * schedule; "center" centers both against the grown row.
   */
  rowAlign: GanttRowAlign
  classNames?: GanttClassNames
  renderEvent?: (props: GanttRenderEventProps<TData>) => ReactNode
  /**
   * Right-click menu for a bar: return shadcn ContextMenu items (the primitive
   * wraps every bar in a ContextMenu and renders this as its content). Read
   * the occurrence for the subject and drive actions through the gantt api
   * (useGantt) or your own state - fully headless. Omit for no menu.
   */
  renderEventMenu?: (props: GanttRenderEventProps<TData>) => ReactNode
  /**
   * Tree-node label. Receives the resource with its tree position; return
   * any rich content (icons, badges). Default is the plain title.
   */
  renderResourceLabel?: (props: {
    resource: GanttResource
    depth: number
    isGroup: boolean
    collapsed: boolean
  }) => ReactNode
  /**
   * Right-click menu for a tree row (same contract as renderEventMenu):
   * return shadcn ContextMenu items and drive actions through your own state.
   */
  renderResourceMenu?: (ctx: GanttColumnContext) => ReactNode
  /** Rendered in the timeline body when there are no resources. */
  renderNoResources?: () => ReactNode
  /**
   * Replaces the smooth cursor-following MOVE clone. Content is React and
   * re-renders per snap step; the gantt owns the fixed wrapper and writes
   * its position imperatively per pointermove (no per-frame React).
   */
  renderDragPreview?: (props: GanttDragIndicatorProps<TData>) => ReactNode
  /**
   * Replaces the RESIZE edge line + status chip. Same positioning contract
   * as renderDragPreview: your content, gantt-owned cursor tracking.
   */
  renderResizeIndicator?: (props: GanttDragIndicatorProps<TData>) => ReactNode
  /**
   * Replaces the schedule-hint tile + bubble. Rendered inside the snapped,
   * validated, pointer-transparent wrapper: set pointer-events-auto on your
   * clickable parts and drive your own create flow from the slot.
   */
  renderScheduleHint?: (props: GanttScheduleHintProps) => ReactNode
  /** Replaces the parent rollup strip (the positioned wrapper stays gantt-owned). */
  renderSummary?: (props: GanttSummaryProps) => ReactNode
  /**
   * Replaces the baseline ghost's content, the milestone diamond included
   * (props.milestone forks the two). The positioned, pointer-transparent
   * wrapper stays gantt-owned.
   */
  renderBaseline?: (props: GanttBaselineProps<TData>) => ReactNode
  /**
   * Replaces the ROW baseline band's content (same wrapper contract as
   * renderBaseline).
   */
  renderRowBaseline?: (props: GanttRowBaselineProps) => ReactNode
  /**
   * Replaces the rollup MATH: return 0-100 (or null to hide) for a group
   * from its descendant events. Default: duration-weighted mean progress.
   */
  getSummaryProgress?: (ctx: {
    resource: GanttResource
    events: GanttEvent<TData>[]
  }) => number | null
}

const DEFAULT_VIEW_CONFIG: GanttViewConfig = {
  nowIndicator: true,
  interval: 60,
  scrollbars: "custom",
  displayScheduleHint: false,
  initialCenter: "now",
  displayCreateTaskHint: false,
  dragCreate: false,
  zoomControl: true,
  wheelZoom: true,
  navButtonVariant: "ghost",
  navButtonSize: "sm",
  timelineLines: "vertical",
  barLabel: "inside",
  offscreenIndicators: true,
  infiniteScroll: true,
  stickyNav: false,
  rowCheckboxes: true,
  parentScheduling: false,
  summaryBars: true,
  baselineBars: true,
  dependencyLines: true,
  scheduleMode: "multiple",
  rowAlign: "start",
}

const GanttViewConfigContext = createContext<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  GanttViewConfig<any>
>(DEFAULT_VIEW_CONFIG)

/** Root-level display props + render overrides, for view components. */
function useGanttViewConfig<TData = unknown>(): GanttViewConfig<TData> {
  return useContext(GanttViewConfigContext)
}

const VIEW_CONFIG_KEYS: Array<keyof GanttViewConfig> = [
  "nowIndicator",
  "interval",
  "scrollbars",
  "displayScheduleHint",
  "initialCenter",
  "displayCreateTaskHint",
  "dragCreate",
  "zoomControl",
  "wheelZoom",
  "navButtonVariant",
  "navButtonSize",
  "offDays",
  "columns",
  "columnsMenu",
  "treePanel",
  "metrics",
  "timelineLines",
  "barLabel",
  "offscreenIndicators",
  "infiniteScroll",
  "zoomRange",
  "stickyNav",
  "rowCheckboxes",
  "selectedRows",
  "onSelectedRowsChange",
  "collapsedGroups",
  "defaultCollapsedGroups",
  "onCollapsedGroupsChange",
  "zoom",
  "defaultZoom",
  "onZoomChange",
  "parentScheduling",
  "summaryBars",
  "baselineBars",
  "dependencyLines",
  "scheduleMode",
  "rowAlign",
  "classNames",
  "renderEvent",
  "renderEventMenu",
  "renderResourceLabel",
  "renderResourceMenu",
  "renderNoResources",
  "renderDragPreview",
  "renderResizeIndicator",
  "renderScheduleHint",
  "renderSummary",
  "renderBaseline",
  "renderRowBaseline",
  "getSummaryProgress",
]

interface GanttProps<TData = unknown>
  extends
    UseGanttStateOptions<TData>,
    Partial<GanttViewConfig<TData>>,
    Omit<useRender.ComponentProps<"div">, "children" | "defaultValue"> {
  /** Adopt a hoisted useGanttState instance; option props are then ignored. */
  calendar?: GanttInstance<TData>
  /** Imperative escape hatch usable from outside the tree. */
  apiRef?: RefObject<GanttApi<TData> | null>
  children?: ReactNode
}

const OPTION_KEYS: Array<keyof UseGanttStateOptions> = [
  "events",
  "defaultEvents",
  "scale",
  "defaultScale",
  "date",
  "defaultDate",
  "selection",
  "defaultSelection",
  "interactions",
  "defaultInteractions",
  "loading",
  "timeZone",
  "locale",
  "weekStartsOn",
  "slotDuration",
  "snapDuration",
  "i18n",
  "rangeBounds",
  "activation",
  "maxRangeWindow",
  "resources",
  "overlap",
  "enforceCanDrop",
  "getEventPriority",
  "eventOrder",
  "getOccurrences",
  "onEventClick",
  "onEventDoubleClick",
  "onEventUpdate",
  "canDropEvent",
  "onSlotClick",
  "onSelectSlot",
  "canSelectSlot",
  "onCreateTask",
  "canCreateTask",
  "onResourceClick",
  "onResourceDoubleClick",
  "onRangeChange",
  "onScaleChange",
  "onDateChange",
  "onSelectionChange",
  "onInteractionsChange",
  "onEventsChange",
  "onResourceReorder",
  "onResourceReorderReject",
  "canReorderResource",
]

function shallowEqualRecord(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  for (const key of aKeys) {
    if (!Object.is(a[key], b[key])) return false
  }
  return true
}

function splitOptions<TData>(props: Record<string, unknown>): {
  options: UseGanttStateOptions<TData>
  viewConfig: GanttViewConfig<TData>
  rest: Record<string, unknown>
} {
  const options: Record<string, unknown> = {}
  const viewConfig: Record<string, unknown> = { ...DEFAULT_VIEW_CONFIG }
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(props)) {
    if ((OPTION_KEYS as string[]).includes(key)) options[key] = value
    else if ((VIEW_CONFIG_KEYS as string[]).includes(key)) {
      if (value !== undefined) viewConfig[key] = value
    } else rest[key] = value
  }
  return {
    options: options as UseGanttStateOptions<TData>,
    viewConfig: viewConfig as unknown as GanttViewConfig<TData>,
    rest,
  }
}

/**
 * Root provider + container. Composition contract:
 * <Gantt><GanttNav/><GanttToolbar/><GanttView/></Gantt>
 */
function Gantt<TData = unknown>({
  calendar,
  apiRef,
  className,
  render,
  children,
  // Quincy fix (#219 PR A round 3, Sol HIGH #5): pulled out explicitly for the SAME reason
  // `gantt-bar.tsx`'s own `ref: consumerRef` destructure is - `mergeProps` does not merge `ref`
  // (rightmost prop wins like any other plain key), so leaving it inside `...props` (which flows
  // into `rest` below, then `mergeProps(defaultProps, rest)`) would silently drop this component's
  // own `containerRef`, or overwrite it with `undefined`, the moment a consumer's JSX included a
  // `ref` prop key at all. Merged explicitly via `useRender`'s own `ref` parameter instead, which
  // DOES merge (see the `useRender(...)` call below).
  ref: consumerRef,
  ...props
}: GanttProps<TData>) {
  const { options, viewConfig, rest } = splitOptions<TData>(
    props as Record<string, unknown>
  )

  // Stable context identity: splitOptions builds a fresh object per render,
  // and every row subscribes to this context - hand out the previous object
  // unless a config value actually changed.
  const viewConfigRef = useRef(viewConfig)
  if (
    !shallowEqualRecord(
      viewConfigRef.current as unknown as Record<string, unknown>,
      viewConfig as unknown as Record<string, unknown>
    )
  ) {
    viewConfigRef.current = viewConfig
  }
  const stableViewConfig = viewConfigRef.current

  if (calendar && Object.keys(options).length > 0) {
    warnOnce(
      "calendar-and-options",
      "both `calendar` and option props were passed; option props are ignored when adopting an instance."
    )
  }

  const own = useGanttState<TData>(calendar ? {} : options)
  const instance = calendar ?? own

  useEffect(() => {
    if (apiRef) apiRef.current = instance.api
  }, [apiRef, instance])

  // Quincy fix (#219 PR A round 3, Sol HIGH #4b): a hoisted `calendar` (`useGanttState` called
  // outside this component, adopted via the `calendar` prop above) outlives THIS component's own
  // mount - unmounting this <Gantt> root does not touch the instance's store at all. Left alone,
  // an active Adjust session's `internal.adjust`/`internal.drag` would survive the gap untouched,
  // and a later remount's `GanttBar` would read them straight off `getState()` and resurrect
  // `role="application"`/`data-adjusting`/the ghost with no Space ever pressed on the new mount -
  // the same resurrection-on-remount hazard `killAdjustSessionIfOrphaned` already closes for a
  // stale event object reappearing under the same id, just via the component lifecycle instead of
  // a store mutation. `cancelAdjust()` is the existing no-announcement "discard and clear" path
  // (Escape/blur/pointer-outside already use it) and is a safe no-op when no session is active, so
  // this needs no session-aware guard of its own; it also runs (harmlessly) for a NON-hoisted
  // instance, whose whole store is discarded with this render regardless.
  useEffect(() => {
    return () => {
      instance.internals.cancelAdjust()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance])

  const containerRef = useRef<HTMLDivElement>(null)

  // Quincy fix (#219 PR A round 3, Sol HIGH #5): moved here from a per-bar effect in
  // `gantt-bar.tsx` - that effect could only announce an external teardown when the bar it lived
  // on SURVIVED the teardown (a replaced resource/timing, or a date/scale change: same occurrence
  // key, same bar node, next render sees `adjusting` flip true -> false). A DELETED event's bar
  // unmounts before any such effect could ever fire, so cancellation went completely unannounced -
  // see `gantt-bar.tsx`'s header for the fuller history. The announcer div is a sibling of
  // `children` above, not inside any bar, so THIS root survives every teardown that isn't its own
  // unmount (item #4b's `cancelAdjust()` above already covers that one, silently - there is no
  // live region left to announce into once this root itself is gone).
  //
  // `getAdjustCancelledVersion()` (see its own doc comment) - not `state.adjust` - is what this
  // subscribes to: it bumps EXACTLY once per genuine external teardown and never for a LOCAL
  // cancel/commit (both already announce their own message inline, from `gantt-bar.tsx`, and
  // clear `internal.adjust` through a path that never reaches `killAdjustSessionIfOrphaned` - see
  // that method's own comment). Comparing against a ref means a later notify with no NEW teardown
  // (nothing left to tear down) never re-announces, and a fresh mount only starts watching from
  // whatever version already exists at that point - no backlog fires retroactively.
  //
  // Quincy fix (#219 PR A round 4, Sol MEDIUM): `useRef`'s initializer only ever applies on this
  // hook's VERY FIRST call - every later render ignores it, so it used to carry a STALE baseline
  // across an `instance` change (the `calendar` prop swapping to a DIFFERENT hoisted store; this
  // component itself never unmounts). The new instance's own counter starts from ITS OWN history
  // (typically 0), which reads as "different" from the leftover baseline on its first notify -
  // even an ordinary one, no teardown at all - and falsely announced cancellation. The effect
  // below now RESETS the baseline to the new instance's current counter every time `instance`
  // itself changes, before it ever subscribes.
  const lastExternalTeardownVersionRef = useRef(
    instance.internals.getAdjustCancelledVersion()
  )
  useEffect(() => {
    lastExternalTeardownVersionRef.current =
      instance.internals.getAdjustCancelledVersion()
    const unsubscribe = instance.subscribe(() => {
      const version = instance.internals.getAdjustCancelledVersion()
      if (version === lastExternalTeardownVersionRef.current) return
      lastExternalTeardownVersionRef.current = version
      const announcer = containerRef.current?.querySelector<HTMLElement>(
        "[data-slot=gantt-announcer]"
      )
      if (announcer) announcer.textContent = instance.settings.i18n.labels.adjustCancelled
    })
    return unsubscribe
  }, [instance])

  const defaultProps = {
    "data-slot": "gantt",
    // own the foreground (previews and consumer shells may not set body
    // color) and the type scale: every gantt label inherits the root's text
    // size, so one class here (or on the consumer's className) rescales the
    // whole component - e.g. className="text-sm" for a roomier grid
    className: cn(
      "text-foreground flex min-h-0 min-w-0 flex-col text-xs",
      className
    ),
    children: (
      <>
        {children}
        <div
          data-slot="gantt-announcer"
          aria-live="polite"
          className="sr-only"
        />
      </>
    ),
  }

  return (
    <GanttContext.Provider value={instance}>
      <GanttViewConfigContext.Provider value={stableViewConfig}>
        {useRender({
          defaultTagName: "div",
          render,
          props: mergeProps<"div">(defaultProps, rest),
          // Quincy fix (#219 PR A round 3, Sol HIGH #5): same `ref` composition `gantt-bar.tsx`'s
          // own `barButton` `useRender` call already uses - merged internally (via
          // `@base-ui/utils/useMergedRefs`) with whatever the CONSUMER passed as
          // `<Gantt ref={...}>`, both receive the node.
          ref: consumerRef == null
            ? [containerRef]
            : Array.isArray(consumerRef)
              ? [containerRef, ...consumerRef]
              : [containerRef, consumerRef],
        })}
      </GanttViewConfigContext.Provider>
    </GanttContext.Provider>
  )
}

export {
  DEFAULT_ROW_ALIGN,
  DEFAULT_SCHEDULE_MODE,
  DEFAULT_VIEW_CONFIG,
  Gantt,
  GanttContext,
  GanttViewConfigContext,
  resolveScheduleMode,
  resolveTimelineLines,
  useGantt,
  useGanttInteractions,
  useGanttNavigation,
  useGanttNodeSchedules,
  useGanttOccurrences,
  useGanttScale,
  useGanttSelection,
  useGanttSelector,
  useGanttSettings,
  useGanttSettingsVersion,
  useGanttState,
  useGanttViewConfig,
}
export type {
  GanttActivationConfig,
  GanttApi,
  GanttBaselineProps,
  GanttCallbacks,
  GanttClassNames,
  GanttColumn,
  GanttColumnContext,
  GanttDragIndicatorProps,
  GanttGridLine,
  GanttInstance,
  GanttInternals,
  GanttMetrics,
  GanttNodeSchedules,
  GanttProps,
  GanttRenderEventProps,
  GanttResolvedLines,
  GanttRowBaselineProps,
  GanttScheduleHintProps,
  GanttSettings,
  GanttSummaryProps,
  GanttTimelineLines,
  GanttTreePanelConfig,
  GanttViewConfig,
  UseGanttStateOptions,
}
