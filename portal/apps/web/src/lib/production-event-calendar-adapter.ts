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

const DEADLINE_COLOR = "var(--ink-900)";
const CHECKLIST_COLOR = "var(--ink-700)";

/** Sydney zoned midnight of a civil date, or null (midnight never falls in a Sydney transition). */
function zonedMidnight(date: string): Date | null {
  const resolved = resolveSydneyCivilMinute(`${date.slice(0, 10)}T00:00`, "earlier");
  return resolved.ok ? new Date(resolved.value.instant) : null;
}

function instant(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function assigneeInitials(name: string): string | null {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const first = words[0]!.charAt(0);
  const last = words.length > 1 ? words[words.length - 1]!.charAt(0) : "";
  return `${first}${last}`.toUpperCase();
}

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

/** One DTO as a vendor event, or null when its timing cannot be placed (dropped, never thrown). */
export function toProductionEventCalendarEvent(dto: CalendarEventDto): ProductionEventCalendarEvent | null {
  const placed = placement(dto);
  if (!placed) return null;
  const shape = shapeOf(dto);
  const data: ProductionEventCalendarData = {
    dto,
    shape,
    syntheticEnd: placed.syntheticEnd,
    assignees: dto.kind === "checklist" ? dto.assignees : [],
    otherAssigneeCount: dto.kind === "checklist" ? dto.otherAssigneeCount : 0,
    done: dto.status.completed,
  };
  const base = {
    id: dto.id,
    title: dto.title,
    start: placed.start,
    end: placed.end,
    allDay: placed.allDay,
    color: shape === "deadline" ? DEADLINE_COLOR : CHECKLIST_COLOR,
    draggable: dto.permissions.canDrag,
    data,
  };
  if (shape === "range") {
    const canResize = dto.permissions.canResize;
    return { ...base, resizable: canResize, resizableEdges: { start: canResize, end: canResize } };
  }
  return { ...base, resizable: false };
}

export function toProductionEventCalendarEvents(dtos: readonly CalendarEventDto[]): ProductionEventCalendarEvent[] {
  const events: ProductionEventCalendarEvent[] = [];
  for (const dto of dtos) {
    const event = toProductionEventCalendarEvent(dto);
    if (event) events.push(event);
  }
  return events;
}

/**
 * The chip class for the vendor's `eventClassName`: Deadlines solid ink, checklist items paper,
 * done items dimmed with the hue-independent `--border` wash (see the harness's `dimDoneChip`).
 * Minimal and token-only; the design review owns the final look.
 *
 * Every branch must override EVERY state the vendor tints — rest, `hover:` and `data-selected:`.
 * The vendor runs the consumer class through `cn()` after its own, and tailwind-merge drops a
 * vendor utility only when the consumer supplies the SAME variant; any state left out keeps the
 * vendor's `--ec-event-color` wash under this branch's text colour.
 *
 * Checklist chips: the vendor's `data-selected:bg-(--ec-event-color)/30` over the `--ink-700`
 * accent turned a tall timed range into a flat mid-grey slab; paper with a light ink wash and one
 * ink ring replaces it.
 *
 * Deadlines: left to the vendor, a selected Deadline was ink-900/30 under paper text (2.03:1).
 * Selected holds the ink fill and draws a double keyline INSIDE the chip: 2px ink at the edge, then
 * 2px paper, then the fill. That is a 4px paper inset ring with a 2px ink inset shadow on top
 * (Tailwind composes `box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow), …`, and the
 * first layer paints on top). A plain paper ring touched the chip edge and merged into the paper
 * page, so the chip only looked 2px smaller: a shrink, not a mark. The ink outer line keeps the
 * chip's edge where it was, and the paper line inside it is the mark. A fill step is no cue either
 * (ink-700 vs ink-900 is 1.26:1). An outer `ring` would collide with the global focus outline.
 *
 * Hover is `--ink-700`, the Portal's primary-hover step: ink-800 on ink-900 was 1.08:1 and
 * invisible. The raw ramp, not `bg-primary-hover`: an inverse surface redefines that role to
 * greige-100, which would put paper text on a light fill.
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
 * agenda time column inside the chip without a selector on that span: greige-400 read 4.41:1 on
 * the ink-700 hover; greige-300 reads 6.8:1 there and 8.6:1 at rest.
 */
const CHECKLIST_SELECTED = "data-selected:bg-(--ink-700)/10 data-selected:inset-ring-(--ink-700)";
const DEADLINE_SELECTED =
  "data-selected:bg-(--ink-900) data-selected:hover:bg-(--ink-700) data-selected:inset-ring-4 data-selected:inset-ring-(--paper-050) data-selected:inset-shadow-[0_0_0_2px_var(--ink-900)]";
export const DEADLINE_AGENDA_HOVER = "data-[view=agenda]:hover:bg-(--ink-700)";
/** Mirrors `tokens/inverse.css`'s `--muted-foreground` for a dark surface. */
/** #602: `--focus-ring` is ink, the same as the Deadline fill, so the inset ring would be invisible; draw it paper, and lift the fill to the hover ink so focus reads apart from the selected state. Light chips keep the default. */
const DEADLINE_FOCUS_RING = "[--focus-ring:var(--paper-050)] focus-visible:bg-(--ink-700)";
const DEADLINE_INVERSE_ROLES = "[--muted-foreground:var(--greige-300)]";
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
  if (data.shape === "deadline") return `bg-(--ink-900) hover:bg-(--ink-700) text-(--paper-050) inset-ring-(--ink-900) ${DEADLINE_SELECTED} ${DEADLINE_AGENDA_HOVER} ${DEADLINE_INVERSE_ROLES} ${DEADLINE_AGENDA_DOT} ${DEADLINE_FOCUS_RING}`;
  if (data.done) return `bg-border/25 hover:bg-border/35 inset-ring-border/25 text-foreground-secondary ${CHECKLIST_SELECTED}`;
  return `bg-(--paper-000) hover:bg-(--paper-100) inset-ring-(--border-hairline) text-foreground ${CHECKLIST_SELECTED}`;
}

/**
 * #602: the "+N more" popover heads its day like every other Portal date ("Wed 18 Nov"), not the vendor's US
 * "Wednesday, November 18". The vendored agenda view builds its own day header from literals and ignores
 * `formats.agendaDayHeader`, so that one is not overridden here.
 */
export const PRODUCTION_EVENT_CALENDAR_I18N = { formats: { moreDayHeader: "EEE d MMM" } } as const;

export function subviewToCalendarView(subview: ProductionCalendarSubview): CalendarViewName {
  return subview;
}

export function calendarViewToSubview(view: CalendarViewName): ProductionCalendarSubview | null {
  return view === "resource" ? null : view;
}
