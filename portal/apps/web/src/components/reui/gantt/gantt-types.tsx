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
 * This file: pure type declarations (`GanttEvent`, `GanttResource`, `GanttScale`, …). No imports,
 * no icons, no `"use client"`, no `cn` — every rewrite above is inapplicable here; this header
 * exists so every one of the 9 files documents its own provenance rather than leaving one silently
 * unexplained.
 *
 * #219 stage 2 (PR A) edits, both additive:
 * 1. `GanttEvent.resizableEdges?: { start?: boolean; end?: boolean }`, beside the existing
 *    `resizable` flag (owner decision on #215 — a project bar's shoot/start edge is fixed, only
 *    the deadline/end edge drags). An omitted edge stays resizable; `resizable: false` still
 *    disables both regardless of `resizableEdges`. See `gantt-dnd.tsx`'s `canResize` and
 *    `gantt-bar.tsx`'s per-edge grip rendering.
 * 2. `GanttNudgeAction` and `GanttNudgeResult`, the request/response shape of `gantt.tsx`'s new
 *    `nudgeEvent` instance API method — the keyboard equivalent of the pointer move/resize
 *    gestures, since upstream had no keyboard path for either. `GanttProposedUpdate.source` below
 *    already admitted `"keyboard"` before this stage; `nudgeEvent` is what finally emits it.
 *
 * #219 PR A fix (Sol review, sol1 item 7), additive: `GanttNudgeResult` gained optional
 * `start`/`end`/`allDay`, present iff `applied` is true — see that field's own doc comment on
 * `GanttNudgeResult` below.
 *
 * #219 PR A (Adjust mode) addition, additive: `GanttAdjustState`, `GanttAdjustStepResult`, and
 * `GanttAdjustCommitResult` — the modal keyboard "Adjust" session that replaces the Ctrl+Alt+Arrow
 * / Shift+Alt+Arrow / Alt+Arrow chords (Opus and Sol both rejected them: Ctrl+Alt+Arrow is
 * OS-intercepted on some desktops, Alt+Arrow is browser Back/Forward). One `GanttAdjustState` lives
 * on `GanttState.adjust`, per instance, the same way `drag`/`slotDraft` do — see `gantt.tsx`'s
 * header for the begin/step/retarget/commit/cancel mechanics.
 *
 * #219 PR A fix (Sol round 4, HIGH), additive: `GanttAdjustState.ownerSnapshot` — immutable
 * primitives (`startMs`/`endMs`/`allDay`/`resourceId`/`recurring`) snapshotted at `beginAdjust`,
 * NOT a reference into `occurrence.event` itself. `gantt.tsx`'s `killAdjustSessionIfOrphaned` used
 * to diff the current event straight against `session.occurrence.event` — but that field IS the
 * live event object (never cloned), so an in-place mutation of it, or of one of its own `Date`
 * fields, moved BOTH sides of the comparison at once and the drift went undetected. See
 * `GanttAdjustState.ownerSnapshot`'s own doc comment.
 */

type GanttBarId = string

type GanttScale = "day" | "week" | "month" | "quarter" | "year"

/** Row drag-reorder proposal: `parentId` null is root, `resources` is the tree with the move applied. */
interface GanttResourceReorder {
  resourceId: string
  parentId: string | null
  /** Position among the new parent's children, the moved row excluded. */
  index: number
  resources: GanttResource[]
}

/**
 * "single" keeps the node on one track and refuses any gesture that would
 * create a concurrent schedule; "multiple" stacks them into stable lanes.
 */
type GanttScheduleMode = "single" | "multiple"

/**
 * Drop policy for a gesture overlapping another schedule in the SAME node.
 * Policy only - overlapping data always renders. "allow" (default) commits as
 * proposed, "clamp" stops at the neighbour's edge, "reject" never commits.
 */
type GanttOverlapPolicy = "allow" | "reject" | "clamp"

/** Vertical placement of row content when the node holds several lanes; "start" pins it to the first lane. */
type GanttRowAlign = "start" | "center"

/** One tree node, not domain-bound: a task (one schedule) or a resource lane (many). Children nest as collapsible groups. */
interface GanttResource {
  id: string
  title: string
  color?: string
  /** Per-node cardinality; falls back to the view-level default. */
  scheduleMode?: GanttScheduleMode
  /**
   * Planned (as-built baseline) window for the WHOLE node, ghosted as a
   * band behind its lanes - independent of any per-event baselines. Half
   * open; set both or neither. Equal instants mark a planned milestone.
   */
  baselineStart?: Date
  baselineEnd?: Date
  children?: GanttResource[]
}

/** Preferred name for a tree node; `GanttResource` is the legacy alias. */
type GanttNode = GanttResource

/** Half-open: `start` inclusive, `end` exclusive. */
interface GanttDateRange {
  start: Date
  end: Date
}

type GanttWeekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU"

interface GanttRecurrenceRule {
  freq: "daily" | "weekly" | "monthly" | "yearly"
  interval?: number
  count?: number
  /** Inclusive, unlike the exclusive `end` of a range. */
  until?: Date
  byWeekday?: Array<GanttWeekday | { day: GanttWeekday; ordinal: number }>
  byMonthDay?: number[]
  byMonth?: number[]
  weekStart?: GanttWeekday
  exDates?: Date[]
  rDates?: Date[]
}

interface GanttEvent<TData = unknown> {
  id: GanttBarId
  title: string
  /** Plain instants, not ISO strings. `end` is exclusive and must be >= start. */
  start: Date
  end: Date
  allDay?: boolean
  /** Structured rule or a raw "RRULE:..." line. */
  recurrence?: GanttRecurrenceRule | string
  /** An edited single occurrence of that series; `originalStart` is the RECURRENCE-ID it replaces. */
  recurringEventId?: GanttBarId
  originalStart?: Date
  /** Token or css color; flows to the --gantt-event-color css var. */
  color?: string
  /** Vetoes only, ANDed with interactions.drag / .resize: readOnly blocks both, draggable/resizable one each. */
  readOnly?: boolean
  draggable?: boolean
  resizable?: boolean
  /**
   * Per-edge override, additive: an omitted edge stays resizable.
   * `resizable: false` wins over this regardless of what it says.
   */
  resizableEdges?: { start?: boolean; end?: boolean }
  /** Feeds the default getEventPriority; higher orders and packs first. */
  priority?: number
  /** Completion 0-100, not 0-1. */
  progress?: number
  /**
   * Planned (as-built baseline) window, drawn behind the bar so the actual
   * start/end read against it. Half-open like start/end; set both or
   * neither. Equal instants mark a planned milestone. A recurring series
   * has no single planned window, so events with `recurrence` render none.
   */
  baselineStart?: Date
  baselineEnd?: Date
  /** Explicit stacking override; wins over the computed z. */
  zIndex?: number
  resourceId?: string
  /**
   * Ids of the events this one waits on (finish-to-start). The view draws an
   * elbow arrow from each named event's end into this one's start; unknown
   * ids, recurring series, and endpoints on hidden rows are skipped.
   * Rendering only - the gantt never reschedules dependents; enforcement
   * stays consumer territory (canDropEvent/onEventUpdate).
   */
  dependencies?: GanttBarId[]
  data?: TData
}

interface GanttOccurrence<TData = unknown> {
  /** Stable per instance: `${event.id}::${startISO}`. */
  key: string
  eventId: GanttBarId
  event: GanttEvent<TData>
  start: Date
  end: Date
  allDay: boolean
  isRecurring: boolean
  recurrenceIndex?: number
}

interface GanttSegment<TData = unknown> {
  occurrence: GanttOccurrence<TData>
  /** Range-start reference instant of the segment's timeline slice. */
  day: Date
  isStart: boolean
  isEnd: boolean
  continuesBefore: boolean
  continuesAfter: boolean
  /** Minutes from the visible range start, clamped to the range. */
  startMin?: number
  endMin?: number
  /** Lane packing: 0-based lane index, then the lanes the node's row resolved to. */
  column?: number
  columnCount?: number
  columnSpan?: number
}

/** A validated planned window; `milestone` when start and end coincide. */
interface GanttBaseline {
  start: Date
  end: Date
  milestone: boolean
}

/** Actual end against the planned end: before it, after it, or exactly on it. */
type GanttBaselineVariance = "early" | "late" | "on-time"

interface GanttSelection {
  eventKeys: string[]
  slot: { start: Date; end: Date; allDay: boolean } | null
}

interface GanttInteractions {
  /** Horizontal move within the bar's own row; never across rows. */
  drag: boolean
  resize: boolean
  selectSlot: boolean
}

interface GanttDragState<TData = unknown> {
  kind: "move" | "resize-start" | "resize-end"
  occurrence: GanttOccurrence<TData>
  proposedStart: Date
  proposedEnd: Date
  proposedAllDay: boolean
  proposedResourceId?: string
  /** Last canDropEvent verdict; drives data-drop-invalid styling. */
  valid: boolean
  /**
   * #219 PR A fix (Sol re-review round 2, HIGH #4): which input owns this ghost -
   * `gantt-dnd.tsx`'s `applyProposal` (pointer) or `gantt.tsx`'s `stepAdjust` (keyboard). The two
   * inputs are mutually exclusive by construction (`beginAdjust` refuses while a pointer gesture is
   * pending/active; a pointer gesture starting on the session's own occurrence cancels Adjust
   * first - both centralized, not per-call-site), but `gantt-dnd.tsx`'s `onPointerUp` still checks
   * this before committing, defensively: a release must never commit a keyboard-owned preview it
   * did not itself drive.
   */
  source: "pointer" | "keyboard"
}

/** The in-gesture drag-create rectangle only; the committed slot is GanttSelection.slot. */
interface GanttSlotDraft {
  start: Date
  end: Date
  allDay: boolean
  resourceId?: string
}

/**
 * #219 PR A (Adjust mode) — one bar's modal keyboard Adjust session, on `GanttState.adjust`. Lives
 * on the STORE (per instance), never module-level and never bar `useState` (bars remount on a
 * move / resize-start commit — see `gantt-bar.tsx`'s header). `occurrence` is the exact bar that
 * opened the session (recurring events never enter, so this is always the event's sole occurrence);
 * `entry` is the snapshot to revert to on cancel and to diff against at commit ("no net change = no
 * emit"); `preview` is the CURRENT proposed range, which each accepted step updates and each
 * refused step leaves untouched.
 */
interface GanttAdjustState<TData = unknown> {
  eventId: GanttBarId
  occurrence: GanttOccurrence<TData>
  target: GanttNudgeAction
  entry: { start: Date; end: Date; allDay: boolean }
  preview: { start: Date; end: Date; allDay: boolean }
  /**
   * #219 PR A fix (Sol round 4, HIGH) — immutable primitives snapshotted from `occurrence.event`
   * at `beginAdjust`, never updated by a retarget (same lifetime as `occurrence` itself). This is
   * what `killAdjustSessionIfOrphaned` diffs the CURRENT event against, instead of
   * `occurrence.event` directly: `occurrence.event` is the live event object, not a clone, so
   * comparing `stillPresent.start.getTime()` against `occurrence.event.start.getTime()` was
   * comparing a value against itself whenever the event (or one of its own `Date` fields) was
   * mutated in place rather than replaced — the two sides always read identical, so the drift went
   * undetected and a stale session survived. Primitives can't alias: `startMs`/`endMs` are numbers,
   * not `Date` objects, so they freeze the value at snapshot time regardless of what happens to the
   * live event afterward.
   */
  ownerSnapshot: {
    startMs: number
    endMs: number
    allDay: boolean
    resourceId?: string
    recurring: boolean
  }
  /**
   * #219 PR A fix (Sol re-review round 2, HIGH #2), additive: every `GanttNudgeAction` the session
   * has been under (M/S/E retargets append, deduped) - `commitAdjust`'s final re-validation checks
   * the lock state of ALL of them, not just `target` (the CURRENT one), because a move-then-retarget
   * session's final preview can carry work from more than one target. Always non-empty: seeded with
   * `beginAdjust`'s own `initialTarget`.
   */
  touchedTargets: GanttNudgeAction[]
}

/**
 * `gantt.tsx`'s `GanttInternals.stepAdjust` verdict — one Arrow/Shift+Arrow step. `noChange: true`
 * (#219 PR A fix, Sol re-review round 2, LOW) mirrors `GanttAdjustCommitResult`'s own field: the
 * step computed a valid, unlocked, un-rejected proposal, but the post-clamp result is IDENTICAL to
 * the session's current preview (already at an overlap-"clamp" neighbour's edge, or a bounds
 * clamp) - held-down Arrow/Shift+Arrow key-repeat past that point writes nothing further and
 * re-announces nothing, rather than spamming the SAME range text on every repeat.
 */
interface GanttAdjustStepResult {
  applied: boolean
  reason?: "locked" | "invalid" | "rejected"
  noChange?: boolean
  start?: Date
  end?: Date
  allDay?: boolean
}

/**
 * `gantt.tsx`'s `GanttInternals.commitAdjust` verdict. `committed: false` means there was nothing
 * to commit (defensive only) or `onEventUpdate` rejected the net change; `noChange: true` means the
 * session ended exactly where it started (no `onEventUpdate` was emitted either way).
 */
interface GanttAdjustCommitResult {
  committed: boolean
  noChange?: boolean
  start?: Date
  end?: Date
  allDay?: boolean
}

interface GanttState<TData = unknown> {
  scale: GanttScale
  date: Date
  /** Full rendered axis range - fetch remote data for THIS, not for activeRange (the logical month/week). */
  visibleRange: GanttDateRange
  activeRange: GanttDateRange
  events: GanttEvent<TData>[]
  selection: GanttSelection
  interactions: GanttInteractions
  loading: boolean
  drag: GanttDragState<TData> | null
  slotDraft: GanttSlotDraft | null
  /** #219 PR A (Adjust mode) — see `GanttAdjustState`'s own doc comment. */
  adjust: GanttAdjustState<TData> | null
  /** Center of the scrolled viewport; the nav title follows it. null falls back to the anchor date. */
  viewportCenter: Date | null
}

interface GanttRangeInfo {
  range: GanttDateRange
  activeRange: GanttDateRange
  scale: GanttScale
  date: Date
  timeZone: string
}

/**
 * #219 PR A fix (Sol re-review round 2, MEDIUM #5): `occurrence` is null ONLY for `source: "api"`
 * (an arbitrary `api.updateEvent` patch has no occurrence context to derive - the caller passed a
 * bare id + patch, not a bar). Every other source - a pointer gesture (`"drag"` /
 * `"resize-start"` / `"resize-end"`) or a keyboard nudge (`"keyboard"`, from `nudgeEvent` or
 * Adjust mode) - always has a real occurrence in hand (the bar that was dragged, or the sole
 * non-recurring occurrence `nudgeEvent` resolves before proposing) and must pass it through, so a
 * consumer's `canDropEvent`/`onEventUpdate` can read `update.occurrence` on those paths without a
 * null check. The union, not a plain `| null` field, is what makes an accidental null on a
 * non-`"api"` source a type error at the construction site instead of a runtime surprise.
 */
type GanttProposedUpdate<TData = unknown> = {
  event: GanttEvent<TData>
  start: Date
  end: Date
  allDay: boolean
  resourceId?: string
} & (
  | { source: "api"; occurrence: GanttOccurrence<TData> | null }
  | {
      source: "drag" | "resize-start" | "resize-end" | "keyboard"
      occurrence: GanttOccurrence<TData>
    }
)

/** false = reject/revert; void or true = accept; object = accept with adjustment. */
type GanttUpdateResult =
  | boolean
  | void
  | { start?: Date; end?: Date; allDay?: boolean }

/** The action a keyboard nudge requests; mirrors the pointer gesture kinds minus `"move"`'s pointer specifics. */
type GanttNudgeAction = "move" | "resize-start" | "resize-end"

/**
 * `gantt.tsx`'s `nudgeEvent` verdict. `reason` is set only when `applied` is false:
 * `"not-found"` (no such event id), `"locked"` (readOnly / draggable / the targeted
 * resizableEdges edge), `"invalid"` (the proposed range would invert or zero out - see
 * `gantt-lib.tsx`'s `computeGanttKeyboardProposal`), or `"rejected"` (the overlap "reject" policy,
 * `canDropEvent` with `enforceCanDrop`, or `onEventUpdate` returning `false`).
 */
interface GanttNudgeResult {
  applied: boolean
  reason?: "locked" | "invalid" | "rejected" | "not-found"
  /**
   * Quincy addition (#219 PR A, Sol review, sol1 item 7): the ACCEPTED range, present iff
   * `applied` is true - after any overlap clamp AND any `onEventUpdate` consumer adjustment. The
   * caller (`gantt-bar.tsx`'s keyboard handler) announces from these fields directly instead of
   * re-fetching via `api.getEvent` right after the call, which can read the OLD range under a
   * controlled `events` prop (see `gantt.tsx`'s `applyProposedUpdate` header for why).
   */
  start?: Date
  end?: Date
  allDay?: boolean
}

/** A click is a point, not a range; `end` is reserved for future gestures. */
interface GanttSlotInfo {
  date: Date
  end?: Date
  allDay: boolean
  resourceId?: string
}

/** Off-day marking; `true` takes the defaults. Marked cells carry `data-off` for CSS customization. */
interface GanttOffDaysConfig {
  /** Weekday numbers treated as off (0 = Sunday). Default [0, 6]. */
  weekendDays?: number[]
  /** Extra off dates compared by day in the display zone. */
  dates?: Date[]
  /** Runs in addition to weekendDays and dates, not instead; any match marks the day off. */
  isOffDay?: (day: Date) => boolean
  /** Marker classes; default "bg-muted/40". */
  className?: string
}

/** External-data contract; OAuth, tokens, and sync loops are application backend territory. */
interface GanttDataAdapter<TData = unknown> {
  getEvents(
    range: GanttDateRange,
    signal?: AbortSignal
  ): Promise<GanttEvent<TData>[]>
}

export type {
  GanttAdjustCommitResult,
  GanttAdjustState,
  GanttAdjustStepResult,
  GanttBaseline,
  GanttBaselineVariance,
  GanttEvent,
  GanttDataAdapter,
  GanttDateRange,
  GanttDragState,
  GanttBarId,
  GanttInteractions,
  GanttNode,
  GanttNudgeAction,
  GanttNudgeResult,
  GanttOccurrence,
  GanttOffDaysConfig,
  GanttOverlapPolicy,
  GanttProposedUpdate,
  GanttRangeInfo,
  GanttRecurrenceRule,
  GanttResource,
  GanttRowAlign,
  GanttScheduleMode,
  GanttSegment,
  GanttSelection,
  GanttSlotDraft,
  GanttSlotInfo,
  GanttState,
  GanttResourceReorder,
  GanttScale,
  GanttUpdateResult,
  GanttWeekday,
}
