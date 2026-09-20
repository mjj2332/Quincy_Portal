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
 * This file: locale strings and `date-fns` `Locale` plumbing for the Gantt's date formatting. No
 * icons used.
 *
 * #219 stage 2 (PR A) edit, additive: added three `labels` — `keyboardNudgeLocked`,
 * `keyboardNudgeInvalid`, `keyboardNudgeRejected` — the short reasons `gantt-bar.tsx`'s keyboard
 * move/resize announces through the gantt root's live region on a failed nudge (the success case
 * reuses the existing `functions.formatEventTime`, unchanged).
 *
 * #219 PR A (Adjust mode) edit, additive: eight more `labels` for the modal keyboard Adjust
 * session that replaces the chords above (`gantt-bar.tsx`'s new `matchGanttBarKey` / Space to
 * enter) — `adjustInstructions` (the visually-hidden `aria-describedby` text, also prefixed onto
 * the entry announcement), `adjustTargetLabels` (names the three targets), and five composers
 * (`adjustEntered`/`adjustRetargeted`/`adjustStepped`/`adjustCommitted`) plus two plain strings
 * (`adjustNoChange`, `adjustCancelled`, `adjustTargetLocked`). A refused STEP (not a refused
 * retarget) reuses the existing `keyboardNudgeLocked`/`keyboardNudgeInvalid`/
 * `keyboardNudgeRejected` above unchanged — the same three reasons `nudgeEvent`'s single commit
 * already announces, on the SAME gate (`proposeNudge`, shared by both).
 */

import type {
  GanttDateRange,
  GanttScale,
} from "@/components/reui/gantt/gantt-types"
import {
  format,
  isSameMonth,
  isSameYear,
  subMilliseconds,
  type Locale,
} from "date-fns"

interface GanttI18nConfig {
  labels: {
    today: string
    previous: string
    next: string
    addEvent: string
    /** "Add task" hint at the foot of the tree. */
    addTask: string
    allDay: string
    loading: string
    event: string
    events: (count: number) => string
    week: (weekNumber: number) => string
    resources: string
    goToDate: string
    /** Hover hint over empty row space, click-only create. */
    scheduleHint: string
    /** Same hint where dragCreate is on and a drag paints a range. */
    scheduleHintDrag: string
    reorder: string
    /** Scale switcher label ("Timeline scale"). */
    selectView: string
    zoomIn: string
    zoomOut: string
    /** Aria-label of the tree/timeline splitter. */
    resizePanel: string
    /** Aria-label of the off-screen bar chips. */
    jumpToBar: (title: string) => string
    /** Read to screen readers as part of the bar label. */
    progress: (percent: number) => string
    /** Live duration readout on the resize indicator. */
    durationDays: (days: number) => string
    /** Appended to the bar aria-label when its segment is clipped by the range. */
    continues: string
    /** Names the planned (baseline) range in the bar tooltip and aria-label. */
    planned: (rangeLabel: string) => string
    /** Read to screen readers on a zero-duration (milestone) bar. */
    milestone: string
    /** Live-region reason on a keyboard nudge blocked by readOnly / draggable / a locked resize edge. */
    keyboardNudgeLocked: string
    /** Live-region reason on a keyboard nudge that would invert or zero out the range. */
    keyboardNudgeInvalid: string
    /** Live-region reason on a keyboard nudge blocked by the overlap policy, canDropEvent, or onEventUpdate. */
    keyboardNudgeRejected: string
    /** #219 PR A (Adjust mode) — visually-hidden `aria-describedby` text while adjusting; also prefixed onto the entry announcement. */
    adjustInstructions: string
    /** #219 PR A (Adjust mode) — names the three retarget-able parts of a bar. */
    adjustTargetLabels: {
      move: string
      resizeStart: string
      resizeEnd: string
    }
    /** #219 PR A (Adjust mode) — live-region text on Space entering the mode: which target, and its current range. */
    adjustEntered: (targetLabel: string, rangeLabel: string) => string
    /** #219 PR A (Adjust mode) — live-region text on M/S/E switching the target. */
    adjustRetargeted: (targetLabel: string) => string
    /** #219 PR A (Adjust mode) — live-region text on an accepted Arrow/Shift+Arrow step: the NEW preview range. */
    adjustStepped: (rangeLabel: string) => string
    /** #219 PR A (Adjust mode) — live-region reason when M/S/E targets an edge this segment does not own. */
    adjustTargetLocked: string
    /** #219 PR A (Adjust mode) — live-region text on Enter/Space committing a net change. */
    adjustCommitted: (rangeLabel: string) => string
    /** #219 PR A (Adjust mode) — live-region text on Enter/Space with no net change; the session just closes. */
    adjustNoChange: string
    /** #219 PR A (Adjust mode) — live-region text on Escape, or a blur/pointer-elsewhere cancel. */
    adjustCancelled: string
    scales: {
      day: string
      week: string
      month: string
      quarter: string
      year: string
    }
  }
  /** date-fns format strings, applied with the gantt `locale`. */
  formats: {
    monthTitle: string
    dayTitle: string
    timeGutter: string
    eventTime: string
  }
  functions: {
    formatTitle: (
      scale: GanttScale,
      ctx: {
        date: Date
        activeRange: GanttDateRange
        visibleRange: GanttDateRange
        locale?: Locale
      }
    ) => string
    formatEventTime: (
      start: Date,
      end: Date,
      allDay: boolean,
      locale?: Locale
    ) => string
    formatDayRange: (range: GanttDateRange, locale?: Locale) => string
    /** Composes the bar's screen-reader label from its localized parts. */
    formatEventAriaLabel: (parts: {
      title: string
      timeLabel: string
      /** Localized milestone clause, from `labels.milestone`. */
      milestoneLabel?: string
      rowTitle?: string
      progressLabel?: string
      /** Localized planned-range clause, from `labels.planned`. */
      plannedLabel?: string
      continues: boolean
    }) => string
  }
}

const DEFAULT_LABELS: GanttI18nConfig["labels"] = {
  today: "Today",
  previous: "Previous",
  next: "Next",
  addEvent: "Add event",
  addTask: "Add task",
  allDay: "All day",
  loading: "Loading events",
  event: "event",
  events: (count) => (count === 1 ? "1 event" : `${count} events`),
  week: (weekNumber) => `W${weekNumber}`,
  resources: "Resources",
  goToDate: "Go to date",
  scheduleHint: "Click to add a schedule",
  scheduleHintDrag: "Click or drag to add a schedule",
  reorder: "Reorder",
  selectView: "Select view",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  resizePanel: "Resize panel",
  jumpToBar: (title) => `Scroll to "${title}"`,
  progress: (percent) => `${percent}% complete`,
  durationDays: (days) => (days === 1 ? "1 day" : `${days} days`),
  continues: "continues",
  planned: (rangeLabel) => `Planned ${rangeLabel}`,
  milestone: "milestone",
  keyboardNudgeLocked: "That can't be changed.",
  keyboardNudgeInvalid: "That change isn't possible.",
  keyboardNudgeRejected: "That change was rejected.",
  adjustInstructions:
    "Adjust mode. Use the arrow keys to move by one step, Shift plus an arrow key for a larger step, M, S, or E to target the whole bar, the start, or the end, Enter or Space to commit, and Escape to cancel.",
  adjustTargetLabels: {
    move: "whole bar",
    resizeStart: "start",
    resizeEnd: "end",
  },
  adjustEntered: (targetLabel, rangeLabel) =>
    `Adjusting the ${targetLabel}, currently ${rangeLabel}.`,
  adjustRetargeted: (targetLabel) => `Now adjusting the ${targetLabel}.`,
  adjustStepped: (rangeLabel) => `Now ${rangeLabel}.`,
  adjustTargetLocked: "That target can't be adjusted.",
  adjustCommitted: (rangeLabel) => `Adjusted to ${rangeLabel}.`,
  adjustNoChange: "No change made.",
  adjustCancelled: "Adjustment cancelled.",
  scales: {
    day: "Day",
    week: "Week",
    month: "Month",
    quarter: "Quarter",
    year: "Year",
  },
}

const DEFAULT_FORMATS: GanttI18nConfig["formats"] = {
  monthTitle: "MMMM yyyy",
  dayTitle: "EEEE, MMMM d, yyyy",
  timeGutter: "h a",
  eventTime: "h:mm a",
}

/**
 * Default formatting functions BOUND to a config's labels/formats, so that
 * `formats` overrides flow into the default renderers (a consumer overriding
 * formats.eventTime without replacing formatEventTime still sees it applied).
 */
function makeDefaultGanttFunctions(
  cfg: Pick<GanttI18nConfig, "labels" | "formats">
): GanttI18nConfig["functions"] {
  return {
    formatTitle: (scale, { date, activeRange, locale }) => {
      const opts = { locale }
      if (scale === "day") {
        return format(date, cfg.formats.dayTitle, opts)
      }
      if (scale === "month") {
        return format(date, cfg.formats.monthTitle, opts)
      }
      if (scale === "quarter") {
        return format(date, "QQQ yyyy", opts)
      }
      if (scale === "year") {
        return format(date, "yyyy", opts)
      }
      // week: smart range label, last day is activeRange.end - 1ms.
      // subMilliseconds keeps the zoned date type (a plain new Date(ms)
      // would flip the label to the machine zone near midnight)
      const rangeEnd = subMilliseconds(activeRange.end, 1)
      const start = activeRange.start
      if (isSameMonth(start, rangeEnd)) {
        return `${format(start, "MMMM d", opts)} - ${format(rangeEnd, "d, yyyy", opts)}`
      }
      if (isSameYear(start, rangeEnd)) {
        return `${format(start, "MMM d", opts)} - ${format(rangeEnd, "MMM d, yyyy", opts)}`
      }
      return `${format(start, "MMM d, yyyy", opts)} - ${format(rangeEnd, "MMM d, yyyy", opts)}`
    },
    formatEventTime: (start, end, allDay, locale) => {
      const opts = { locale }
      if (end.getTime() === start.getTime()) {
        // a milestone is an instant, not a range - "9:00 AM - 9:00 AM" reads
        // like a data bug
        return allDay
          ? format(start, "MMM d, yyyy", opts)
          : format(start, `MMM d, ${cfg.formats.eventTime}`, opts)
      }
      if (allDay) {
        // a gantt bar is a DATE RANGE: show it, never a bare "All day".
        // Ends are exclusive midnights, so the last shown day is end - 1ms;
        // subMilliseconds keeps the caller's zoned date type intact.
        const last =
          end.getTime() - 1 >= start.getTime() ? subMilliseconds(end, 1) : start
        const sameDay =
          format(start, "yyyy-MM-dd") === format(last, "yyyy-MM-dd")
        if (sameDay) return format(start, "MMM d, yyyy", opts)
        if (isSameYear(start, last)) {
          return `${format(start, "MMM d", opts)} - ${format(last, "MMM d, yyyy", opts)}`
        }
        return `${format(start, "MMM d, yyyy", opts)} - ${format(last, "MMM d, yyyy", opts)}`
      }
      const fmt = cfg.formats.eventTime
      // Multi-day timed events carry the date on both sides. Compare calendar
      // days off the last rendered instant (end is exclusive, so a 14:00 to
      // midnight bar still ends on the start day). Elapsed ms would miss an
      // exactly-24h bar and a DST day that only runs 23 hours.
      const lastInstant =
        end.getTime() - 1 >= start.getTime() ? subMilliseconds(end, 1) : start
      if (format(start, "yyyy-MM-dd") !== format(lastInstant, "yyyy-MM-dd")) {
        return `${format(start, `MMM d, ${fmt}`, opts)} - ${format(end, `MMM d, ${fmt}`, opts)}`
      }
      return `${format(start, fmt, opts)} - ${format(end, fmt, opts)}`
    },
    formatDayRange: (range, locale) => {
      const opts = { locale }
      const rangeEnd = subMilliseconds(range.end, 1)
      return `${format(range.start, "MMM d", opts)} - ${format(rangeEnd, "MMM d", opts)}`
    },
    formatEventAriaLabel: ({
      title,
      timeLabel,
      milestoneLabel,
      rowTitle,
      progressLabel,
      plannedLabel,
      continues,
    }) =>
      [
        title,
        timeLabel,
        milestoneLabel,
        rowTitle,
        progressLabel,
        plannedLabel,
        continues ? cfg.labels.continues : undefined,
      ]
        .filter(Boolean)
        .join(", "),
  }
}

const DEFAULT_GANTT_I18N: GanttI18nConfig = {
  labels: DEFAULT_LABELS,
  formats: DEFAULT_FORMATS,
  functions: makeDefaultGanttFunctions({
    labels: DEFAULT_LABELS,
    formats: DEFAULT_FORMATS,
  }),
}

/** Deep-partial override shape: replace individual keys, never sections. */
interface GanttI18nOverrides {
  labels?: Partial<Omit<GanttI18nConfig["labels"], "scales" | "adjustTargetLabels">> & {
    scales?: Partial<GanttI18nConfig["labels"]["scales"]>
    // #219 PR A (Adjust mode): same per-key merge treatment as `scales` above - an override of
    // just one target name must not drop the other two defaults.
    adjustTargetLabels?: Partial<GanttI18nConfig["labels"]["adjustTargetLabels"]>
  }
  formats?: Partial<GanttI18nConfig["formats"]>
  functions?: Partial<GanttI18nConfig["functions"]>
}

/**
 * Shallow merge per nested object, matching the filters.tsx i18n contract:
 * a partial override replaces individual keys, never whole sections. Default
 * functions are re-bound to the MERGED labels/formats so a `formats` (or
 * `labels.continues`) override reaches the default renderers; explicit
 * `functions` overrides still win.
 */
function mergeGanttI18n(overrides?: GanttI18nOverrides): GanttI18nConfig {
  if (!overrides) return DEFAULT_GANTT_I18N
  const labels = {
    ...DEFAULT_LABELS,
    ...overrides.labels,
    // nested section: replace individual scale names, never the whole set
    scales: {
      ...DEFAULT_LABELS.scales,
      ...overrides.labels?.scales,
    },
    // #219 PR A (Adjust mode): same per-key merge treatment as `scales` above.
    adjustTargetLabels: {
      ...DEFAULT_LABELS.adjustTargetLabels,
      ...overrides.labels?.adjustTargetLabels,
    },
  }
  const formats = { ...DEFAULT_FORMATS, ...overrides.formats }
  return {
    labels,
    formats,
    functions: {
      ...makeDefaultGanttFunctions({ labels, formats }),
      ...overrides.functions,
    },
  }
}

export { DEFAULT_GANTT_I18N, mergeGanttI18n }
export type { GanttI18nConfig, GanttI18nOverrides }
