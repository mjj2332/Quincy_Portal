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
 * THIS FILE: the active-view switchboard — renders the component registered for the current view and publishes `data-view` / `data-loading`. There is no per-view JSX in a consumer's tree; this file is the whole dispatch.
 *
 * Quincy edits since vendoring: none yet.
 */
import { type ComponentType, type ReactNode } from "react"
import {
  useEventCalendarSelector,
  useEventCalendarViewConfig,
} from "@/components/reui/event-calendar/event-calendar"
import { EventCalendarAgendaView } from "@/components/reui/event-calendar/event-calendar-agenda-view"
import { EventCalendarMonthView } from "@/components/reui/event-calendar/event-calendar-month-view"
import { EventCalendarResourceView } from "@/components/reui/event-calendar/event-calendar-resource-view"
import {
  EventCalendarDaysView,
  EventCalendarDayView,
  EventCalendarWeekView,
} from "@/components/reui/event-calendar/event-calendar-time-grid"
import type { CalendarView } from "@/components/reui/event-calendar/event-calendar-types"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"

import { cn } from "@/lib/utils"

const DEFAULT_VIEW_COMPONENTS: Record<CalendarView, ComponentType> = {
  month: EventCalendarMonthView,
  week: EventCalendarWeekView,
  day: EventCalendarDayView,
  days: EventCalendarDaysView,
  agenda: EventCalendarAgendaView,
  resource: EventCalendarResourceView,
}

interface EventCalendarContentProps extends Omit<
  useRender.ComponentProps<"div">,
  "children"
> {
  /** Swap individual view implementations. */
  components?: Partial<Record<CalendarView, ComponentType>>
  /** Replaces the switchboard entirely; read useEventCalendarView() inside. */
  children?: ReactNode
}

function EventCalendarContent({
  className,
  render,
  components,
  children,
  ...props
}: EventCalendarContentProps) {
  const viewConfig = useEventCalendarViewConfig()
  const view = useEventCalendarSelector((state) => state.view)
  const loading = useEventCalendarSelector((state) => state.loading)

  const resolved = {
    ...DEFAULT_VIEW_COMPONENTS,
    ...viewConfig.components,
    ...components,
  }
  // A spread copies keys that hold `undefined`, so `components={{ month: isPro
  // ? ProMonth : undefined }}` would erase the default and render <undefined />.
  const ActiveView = resolved[view] ?? DEFAULT_VIEW_COMPONENTS[view]

  const defaultProps = {
    "data-slot": "event-calendar-content",
    "data-view": view,
    "data-loading": loading || undefined,
    className: cn(
      "relative flex min-h-0 min-w-0 flex-1 flex-col",
      "data-loading:pointer-events-none data-loading:opacity-60",
      viewConfig.classNames?.content,
      className
    ),
    children: children ?? <ActiveView />,
  }

  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(defaultProps, props),
  })
}

export { DEFAULT_VIEW_COMPONENTS, EventCalendarContent }
export type { EventCalendarContentProps }