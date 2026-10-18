/**
 * #222 — the pure bridge from the Production Calendar's DTOs to the vendored ReUI event calendar.
 *
 * DTO → vendor event only; the reverse direction (a vendor proposal → a `SchedulingProposal`) is
 * `production-event-calendar-scheduling.ts`. Pure transforms, no React.
 *
 * Rules:
 * - Ids are the Calendar entity ids (`checklist:<uuid>`, `project-deadline:<uuid>`), unchanged.
 * - All-day start/end are Sydney ZONED midnights (the vendor's contract: another zone's midnight
 *   paints the wrong days) and the end is EXCLUSIVE, as the DTO's all-day end already is.
 * - A Deadline is a point, but the vendor needs `end >= start` with some length
 *   to draw a chip, so it gets a synthetic display end (`PRODUCTION_EVENT_CALENDAR_DISPLAY_MINUTES`
 *   when timed, the next zoned midnight when dated). `data.syntheticEnd` says so; the scheduling
 *   module ignores a proposal's end for it.
 * - Deadlines are never resizable; a checklist range resizes per edge when the
 *   (effective) `canResize` allows. Nothing is marked `readOnly` — the Reschedule affordance stays.
 *
 * Import boundary: like `production-gantt-adapter.ts`, this file must never import
 * `@/components/reui/event-calendar/**`, not even `import type` — `harness-reachability.guard.test.ts`
 * counts a type import as a consumer. `ProductionEventCalendarEvent` and `CalendarViewName` below are
 * local structural types that the vendor's `CalendarEvent<TData>` / `CalendarView` accept.
 */
import {
  resolveSydneyCivilMinute,
  shiftSydneyCalendarDate,
  type CalendarEventDto,
  type CalendarPerson,
  type ProductionCalendarSubview,
} from "@quincy/shared";
import { cn } from "@/lib/utils";
import { formatDayRangePortal } from "./date-format";
import {
  lateLabel,
  projectLateness,
  stageTone,
  subtaskLateness,
  subtaskPeopleTone,
  type Instant,
  type Lateness,
  type PeopleTone,
  type StageTone,
} from "./dashboard-appearance";

/**
 * The fixed view settings `ProductionEventCalendar` hands `<EventCalendar>`. One constant so the
 * surface and `production-event-calendar-window.test.ts` (vendor visible range ⊆ server window)
 * cannot drift apart. Kept in step with `deriveProductionCalendarWindow`: Monday weeks, six fixed
 * month rows (42 days), a 3-day `days` view and a 14-day agenda. `dayCountPresets` is the view
 * menu's "N days" list: the vendor default is `[5]`, which would offer a 5-day view the server window
 * is not derived for — so the menu offers exactly the 3-day view. `scrollToHour` is view-layer only
 * (the time grids' initial scroll), not part of the visible-range contract.
 */
export const PRODUCTION_EVENT_CALENDAR_VIEW_SETTINGS = {
  timeZone: "Australia/Sydney",
  weekStartsOn: 1,
  fixedWeeks: true,
  agendaDayCount: 14,
  dayCount: 3,
  // Mutable on purpose: the vendor prop is `number[]`, which a `readonly [3]` does not satisfy.
  dayCountPresets: [3] as number[],
  // Week, Day and 3-day open scrolled to 08:00 Sydney (the working day), not midnight. The vendor
  // prop is an hour number; month and agenda ignore it.
  scrollToHour: 8,
  // Phone agenda row (#648): wraps so the vendored time span (Quincy edit 7 in
  // `reui/event-calendar/event-calendar-event.tsx`) takes its own line above the dot + title.
  classNames: { agendaItem: "max-[721px]:flex-wrap max-[721px]:gap-y-0.5" },
} as const;

/** The controlled `date`: Sydney noon of the civil date, clear of any midnight / DST edge. */
export function productionEventCalendarAnchor(civilDate: string): Date {
  const resolved = resolveSydneyCivilMinute(`${civilDate}T12:00`, "earlier");
  return resolved.ok ? new Date(resolved.value.instant) : new Date(`${civilDate}T02:00:00.000Z`);
}

/** Display length of a timed Deadline chip. Synthetic — never written anywhere. */
export const PRODUCTION_EVENT_CALENDAR_DISPLAY_MINUTES = 30;

/** Structural copy of the vendor's `CalendarView`. */
export type CalendarViewName = "month" | "week" | "day" | "days" | "agenda" | "resource";

export type ProductionEventCalendarShape = "deadline" | "range";

/**
 * #922: what a chip paints, answered by `lib/dashboard-appearance.ts` and never re-derived here or in a
 * renderer. Lateness comes from the module's rules over the REAL instants (a Deadline's own instant, a
 * range's stored end), never the synthetic display end and never the server's `status.overdue`.
 * - `deadline`: `fill` is `ink` on time, `late` once missed, `delivered` once the Project is Delivered.
 * - `range`: the Project's Stage tone, the Subtask's lateness and its Colour-by-People tone.
 */
export type ProductionEventCalendarAppearance =
  | { kind: "deadline"; fill: "ink" | "late" | "delivered"; lateness: Lateness; lateLabel: string | null }
  | { kind: "range"; tone: StageTone; lateness: Lateness; lateLabel: string | null; people: PeopleTone; done: boolean };

export type ProductionEventCalendarData = {
  dto: CalendarEventDto;
  shape: ProductionEventCalendarShape;
  /** True when `end` is a display length, not a stored endpoint (Deadlines). */
  syntheticEnd: boolean;
  /** Named assignees of a checklist item, in assignment order; empty for a Deadline or an unassigned item. */
  assignees: CalendarPerson[];
  /** Assignees the viewer may not see (External Editors), shown only as a count. */
  otherAssigneeCount: number;
  done: boolean;
  appearance: ProductionEventCalendarAppearance;
};

/** Structural subset of the vendor's `CalendarEvent<ProductionEventCalendarData>`. */
export type ProductionEventCalendarEvent = {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  color: string;
  draggable: boolean;
  resizable: boolean;
  resizableEdges?: { start: boolean; end: boolean };
  readOnly?: boolean;
  data: ProductionEventCalendarData;
};

/** A Deadline's fill by state; also its `--ec-event-color`, so the drag ghost and agenda dot follow it. */
const DEADLINE_FILL_COLOR = { ink: "var(--ink-900)", late: "var(--late)", delivered: "var(--stage-delivered)" } as const;

/** Sydney zoned midnight of a civil date, or null (midnight never falls in a Sydney transition). */
function zonedMidnight(date: string): Date | null {
  const resolved = resolveSydneyCivilMinute(`${date.slice(0, 10)}T00:00`, "earlier");
  return resolved.ok ? new Date(resolved.value.instant) : null;
}

function instant(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** #916: initials moved to the appearance module, the one place a person's bar label comes from. */
export { personInitials as assigneeInitials } from "./dashboard-appearance";

function shapeOf(dto: CalendarEventDto): ProductionEventCalendarShape {
  return dto.kind === "project_deadline" ? "deadline" : "range";
}

function placement(dto: CalendarEventDto): { start: Date; end: Date; allDay: boolean; syntheticEnd: boolean } | null {
  const { timing } = dto;
  if (timing.allDay) {
    const start = zonedMidnight(timing.start);
    if (!start) return null;
    if (timing.end !== null) {
      const end = zonedMidnight(timing.end);
      return end && end > start ? { start, end, allDay: true, syntheticEnd: false } : null;
    }
    const next = shiftSydneyCalendarDate(timing.start.slice(0, 10), 1);
    const end = next.ok ? zonedMidnight(next.value) : null;
    return end ? { start, end, allDay: true, syntheticEnd: true } : null;
  }
  const start = instant(timing.start);
  if (!start) return null;
  if (timing.end !== null) {
    const end = instant(timing.end);
    return end && end >= start ? { start, end, allDay: false, syntheticEnd: false } : null;
  }
  return { start, end: new Date(start.getTime() + PRODUCTION_EVENT_CALENDAR_DISPLAY_MINUTES * 60_000), allDay: false, syntheticEnd: true };
}

/**
 * The instant lateness is measured from. A Deadline: its own instant (the chip's start; its end is a display
 * length). A range: its stored end, which `timing.end` carries (and the optimistic overlay rewrites), so the
 * chip turns late where it is drawn ending; the schedule's end only when timing has none.
 */
function dueInstant(dto: CalendarEventDto, placed: { start: Date; end: Date; syntheticEnd: boolean }): Instant {
  if (dto.kind === "project_deadline") return placed.start;
  return placed.syntheticEnd ? dto.schedule.end.instant : placed.end;
}

function appearanceOf(dto: CalendarEventDto, due: Instant, now: Instant): ProductionEventCalendarAppearance {
  if (dto.kind === "project_deadline") {
    const lateness = projectLateness({ stageKey: dto.project.stageKey, deadlineAt: new Date(due).getTime(), archived: dto.project.archived }, now);
    const fill = stageTone(dto.project.stageKey).stage === "delivered" ? "delivered" : lateness.late ? "late" : "ink";
    return { kind: "deadline", fill, lateness, lateLabel: lateLabel(lateness) };
  }
  const lateness = subtaskLateness({ dueAt: due, complete: dto.status.completed }, now);
  return {
    kind: "range",
    tone: stageTone(dto.project.stageKey),
    lateness,
    lateLabel: lateLabel(lateness),
    people: subtaskPeopleTone({ assignees: dto.assignees, otherAssigneeCount: dto.otherAssigneeCount }),
    done: dto.status.completed,
  };
}

/**
 * One DTO as a vendor event, or null when its timing cannot be placed (dropped, never thrown). `now` is the
 * instant lateness is judged at (the surface passes `useNow`), so a chip turns late without a refetch.
 */
export function toProductionEventCalendarEvent(dto: CalendarEventDto, now: Instant): ProductionEventCalendarEvent | null {
  const placed = placement(dto);
  if (!placed) return null;
  const shape = shapeOf(dto);
  const appearance = appearanceOf(dto, dueInstant(dto, placed), now);
  const data: ProductionEventCalendarData = {
    dto,
    shape,
    syntheticEnd: placed.syntheticEnd,
    assignees: dto.kind === "checklist" ? dto.assignees : [],
    otherAssigneeCount: dto.kind === "checklist" ? dto.otherAssigneeCount : 0,
    done: dto.status.completed,
    appearance,
  };
  const base = {
    id: dto.id,
    title: dto.title,
    start: placed.start,
    end: placed.end,
    allDay: placed.allDay,
    color: appearance.kind === "deadline" ? DEADLINE_FILL_COLOR[appearance.fill] : appearance.tone.color,
    draggable: dto.permissions.canDrag,
    data,
  };
  if (shape === "range") {
    const canResize = dto.permissions.canResize;
    return { ...base, resizable: canResize, resizableEdges: { start: canResize, end: canResize } };
  }
  return { ...base, resizable: false };
}

export function toProductionEventCalendarEvents(dtos: readonly CalendarEventDto[], now: Instant): ProductionEventCalendarEvent[] {
  const events: ProductionEventCalendarEvent[] = [];
  for (const dto of dtos) {
    const event = toProductionEventCalendarEvent(dto, now);
    if (event) events.push(event);
  }
  return events;
}

/**
 * The chip class for the vendor's `eventClassName`, drawn from `data.appearance` (#922, frame 3d in
 * `design/prototypes/dashboard-views/project/Dashboard views v3.dc.html`). The colour itself is never
 * in the class: the adapter sets `event.color` (the Stage tone, or the Deadline's fill), the vendor
 * writes it to `--ec-event-color` on the chip, and every branch paints with that property. So one
 * class per treatment serves every Stage, and the drag ghost and agenda dot follow the same colour.
 *
 * - A range: a 14% wash of its Stage tone, edged `--border-width-mid` (1.5px) in the full tone; ink
 *   text. Awaiting RAW draws hollow (the module's `hollow-dashed`): paper with a dashed tone edge.
 * - A late range keeps its wash and swaps the edge for a `--border-width-bold` `--late` ring; the
 *   chip's content prints the module's late label, so colour is never the only cue.
 * - A done range: paper-100 with a `--text-muted` edge (3.36:1, the owner's done look, D2) and
 *   secondary text; its title is struck through in the content.
 * - A Deadline: solid `--ec-event-color`: ink on time, `--late` once missed, `--stage-delivered`
 *   once the Project is Delivered.
 *
 * Every branch must override EVERY state the vendor tints — rest, `hover:` and `data-selected:`.
 * The vendor runs the consumer class through `cn()` after its own, and tailwind-merge drops a
 * vendor utility only when the consumer supplies the SAME variant; any state left out keeps the
 * vendor's own `--ec-event-color` wash (docs/lessons.md, "A consumer `eventClassName` must override
 * every state the vendor tints"). The washes stop at 28% (selected + hover): the secondary meta line
 * (greige-600) holds 4.5:1 on the darkest tone, Editing's slate, up to there.
 *
 * Every range chip re-scopes `--muted-foreground` to `--text-secondary` (`RANGE_META`), frame 3d's
 * `.ev small`. The vendor's agenda time column is `text-muted-foreground`, the app-wide `--text-muted`
 * (greige-400), which read 2.5–3.6:1 on a paper row and under a Stage wash. The re-scope reaches it
 * through the role, as the Deadline's inverse re-scope does, without a selector on the vendor's span.
 *
 * Deadlines: left to the vendor, a selected Deadline was ink-900/30 under paper text (2.03:1).
 * Selected holds the fill and draws a double keyline INSIDE the chip: 2px fill colour at the edge,
 * then 2px paper, then the fill. That is a 4px paper inset ring with a 2px inset shadow on top
 * (Tailwind composes `box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow), …`, and the
 * first layer paints on top). A plain paper ring touched the chip edge and merged into the paper
 * page, so the chip only looked 2px smaller: a shrink, not a mark. An outer `ring` would collide
 * with the global focus outline.
 *
 * Hover (and keyboard focus) lifts a Deadline's fill to 85% over the page, the step ink-900 → ink-700
 * used to be: a darker step on ink was invisible (ink-800 on ink-900, 1.08:1), and one class now
 * serves the three fills. Paper text keeps 5.2:1 or better on every lifted fill.
 *
 * Agenda hover: the vendored agenda row passes `hover:bg-muted` after this class, so
 * tailwind-merge drops our `hover:` and the row went paper-on-paper (1.07:1);
 * `data-[view=agenda]:hover:` wins on specificity (0,3,0 vs 0,2,0), not source order. It couples
 * to the vendor chip's `data-view` attribute.
 *
 * The Deadline chip is a dark surface, so it re-scopes `--muted-foreground` the way
 * `tokens/inverse.css` does for `[data-surface="inverse"]` (greige-300; inverse.css has no named
 * role for it, so the raw step mirrors that file). `text-muted-foreground` is an `@theme inline`
 * role that compiles to `color: var(--muted-foreground)`, so the re-scope reaches the vendored
 * agenda time column inside the chip without a selector on that span: greige-300 reads 6.8:1 on
 * the lifted ink and 8.6:1 at rest. On oxblood and olive it falls under 4.5:1, so a late or
 * delivered Deadline's muted text is paper-050 instead.
 */
/** Frame 3d's meta line (`.ev small`): greige-600 for the vendor's `text-muted-foreground` time text. */
const RANGE_META = "[--muted-foreground:var(--text-secondary)]";
const RANGE_WASH =
  "bg-(--ec-event-color)/14 hover:bg-(--ec-event-color)/20 data-selected:bg-(--ec-event-color)/24 data-selected:hover:bg-(--ec-event-color)/28 text-foreground";
const RANGE_HOLLOW =
  "bg-(--paper-000) hover:bg-(--ec-event-color)/8 data-selected:bg-(--ec-event-color)/14 data-selected:hover:bg-(--ec-event-color)/20 text-foreground border-(length:--border-width-mid) border-dashed border-(--ec-event-color) inset-ring-0";
const RANGE_EDGE = "inset-ring-(length:--border-width-mid) inset-ring-(--ec-event-color) data-selected:inset-ring-2 data-selected:inset-ring-(--ec-event-color)";
/** The hollow chip draws its edge as a dashed border; selected adds the tone ring inside it. */
const HOLLOW_SELECTED_EDGE = "data-selected:inset-ring-2 data-selected:inset-ring-(--ec-event-color)";
const RANGE_LATE = "inset-ring-(length:--border-width-bold) inset-ring-(--late) data-selected:inset-ring-2 data-selected:inset-ring-(--late)";
const RANGE_DONE =
  "bg-(--paper-100) hover:bg-(--paper-200) inset-ring-(length:--border-width-mid) inset-ring-(--text-muted) text-foreground-secondary data-selected:bg-(--ink-700)/10 data-selected:inset-ring-2 data-selected:inset-ring-(--ink-700)";
const DEADLINE_SELECTED =
  "data-selected:bg-(--ec-event-color) data-selected:hover:bg-(--ec-event-color)/85 data-selected:inset-ring-4 data-selected:inset-ring-(--paper-050) data-selected:inset-shadow-[0_0_0_2px_var(--ec-event-color)]";
export const DEADLINE_AGENDA_HOVER = "data-[view=agenda]:hover:bg-(--ec-event-color)/85";
/** #602: `--focus-ring` is ink, the same as the ink Deadline fill, so the inset ring would be invisible; draw it paper, and lift the fill so focus reads apart from the selected state. Light chips keep the default. */
const DEADLINE_FOCUS_RING = "[--focus-ring:var(--paper-050)] focus-visible:bg-(--ec-event-color)/85";
/** Mirrors `tokens/inverse.css`'s `--muted-foreground` for a dark surface; paper on the two lighter fills. */
const DEADLINE_INVERSE_ROLES = { ink: "[--muted-foreground:var(--greige-300)]", late: "[--muted-foreground:var(--paper-050)]", delivered: "[--muted-foreground:var(--paper-050)]" } as const;
/**
 * Hides the vendored agenda row's colour dot on a Deadline, keeping its box so titles stay aligned
 * with checklist rows. The ink fill already carries the Deadline's colour; the dot is ink-on-ink,
 * invisible at rest and a black smudge on the ink-700 hover. `--ec-event-color` stays ink (it also
 * colours the drag ghost). Couples to the vendor's `data-slot`, as the agenda hover couples to
 * `data-view`.
 */
export const DEADLINE_AGENDA_DOT = "[&_[data-slot=event-calendar-agenda-dot]]:invisible";

/**
 * #464: the mark a Show-in landing puts on every chip of the Project it landed on. An OUTLINE, because
 * every chip already spends its inset ring and shadow on its own rest/selected treatment; the outline
 * sits outside the chip and touches none of them. It names no `data-selected:` variant.
 */
const LANDED_HIGHLIGHT = "outline-2 outline-offset-1 outline-(--ink-900)";

export function productionEventCalendarEventClassName(data: ProductionEventCalendarData | undefined, highlighted = false): string | undefined {
  const base = baseEventClassName(data);
  return highlighted && base ? `${base} ${LANDED_HIGHLIGHT}` : base;
}

/**
 * #602: the global `:focus-visible` outline draws outside the chip, and the month cell and the agenda scroller
 * (`overflow-hidden`) clip it. Inset it by the ring's own width. `!` because `tokens/base.css` sets `outline` as an
 * unlayered shorthand that beats a layered utility (docs/lessons.md #522, #219). Lands on the chip's focusable root:
 * `event-calendar-event.tsx` applies `eventClassName` to the same element that takes the props.
 */
const CHIP_FOCUS_RING_INSET = "focus-visible:![outline-offset:calc(-1*var(--border-width-bold))]";

function baseEventClassName(data: ProductionEventCalendarData | undefined): string | undefined {
  const base = chipColourClassName(data);
  return base ? `${base} ${CHIP_FOCUS_RING_INSET}` : undefined;
}

function chipColourClassName(data: ProductionEventCalendarData | undefined): string | undefined {
  if (!data) return undefined;
  const { appearance } = data;
  if (appearance.kind === "deadline") {
    return `bg-(--ec-event-color) hover:bg-(--ec-event-color)/85 text-(--paper-050) inset-ring-(--ec-event-color) ${DEADLINE_SELECTED} ${DEADLINE_AGENDA_HOVER} ${DEADLINE_INVERSE_ROLES[appearance.fill]} ${DEADLINE_AGENDA_DOT} ${DEADLINE_FOCUS_RING}`;
  }
  if (appearance.done) return `${RANGE_DONE} ${RANGE_META}`;
  const hollow = appearance.tone.treatment === "hollow-dashed";
  // A late ring replaces the tone edge (and the hollow chip's `inset-ring-0`); cn keeps the later one.
  const edge = appearance.lateness.late ? RANGE_LATE : hollow ? HOLLOW_SELECTED_EDGE : RANGE_EDGE;
  return cn(hollow ? RANGE_HOLLOW : RANGE_WASH, edge, RANGE_META);
}

/**
 * #602 / #614: the "+N more" popover and the agenda day header both name a day like every other Portal date
 * ("Wed 18 Nov", "Wed" + "7 Oct 2026"), not the vendor's US "Wednesday, November 18". The agenda keeps the year
 * because it can span years. The vendored agenda view reads `agendaDayWeekday` / `agendaDayDate` (its group
 * aria-label uses the same text); it still ignores `formats.agendaDayHeader`, which is not overridden here.
 */
export const PRODUCTION_EVENT_CALENDAR_I18N = {
  formats: { moreDayHeader: "EEE d MMM", agendaDayWeekday: "EEE", agendaDayDate: "d MMM yyyy", dayTitle: "EEE d MMM yyyy" },
  functions: {
    /**
     * #643: week / days / agenda read as the Portal's day-first range ("28 Sep – 4 Oct 2026"). Every other view
     * goes to `base`, the vendor's merged default, so the `formats` above (month, day) keep applying. The range
     * end is exclusive, so the last day is one millisecond earlier, as the vendor does it.
     */
    formatTitle: <C extends { activeRange: DayRange }>(
      view: CalendarViewName,
      ctx: C,
      base?: (view: CalendarViewName, ctx: C) => string,
    ): string => {
      if (view === "week" || view === "days" || view === "agenda") return formatPortalRange(ctx.activeRange);
      return base ? base(view, ctx) : "";
    },
    /** #643: the agenda group's aria-label and the drag-draft labels. */
    formatDayRange: (range: DayRange): string => formatPortalRange(range),
  },
};

type DayRange = { start: Date; end: Date };

function formatPortalRange(range: DayRange): string {
  // Exclusive end: the last day shown is a millisecond before it (a DST day is 23 hours, not 24).
  return formatDayRangePortal(range.start, new Date(range.end.getTime() - 1));
}

export function subviewToCalendarView(subview: ProductionCalendarSubview): CalendarViewName {
  return subview;
}

export function calendarViewToSubview(view: CalendarViewName): ProductionCalendarSubview | null {
  return view === "resource" ? null : view;
}
