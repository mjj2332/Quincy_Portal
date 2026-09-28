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
 * - A Deadline and a due-only item are points, but the vendor needs `end >= start` with some length
 *   to draw a chip, so they get a synthetic display end (`PRODUCTION_EVENT_CALENDAR_DISPLAY_MINUTES`
 *   when timed, the next zoned midnight when dated). `data.syntheticEnd` says so; the scheduling
 *   module ignores a proposal's end for these shapes.
 * - Deadlines and due-only items are never resizable; a checklist range resizes per edge when the
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
  type ProductionCalendarSubview,
} from "@quincy/shared";

/** Display length of a timed Deadline / timed due-only chip. Synthetic — never written anywhere. */
export const PRODUCTION_EVENT_CALENDAR_DISPLAY_MINUTES = 30;

/** Structural copy of the vendor's `CalendarView`. */
export type CalendarViewName = "month" | "week" | "day" | "days" | "agenda" | "resource";

export type ProductionEventCalendarShape = "deadline" | "range" | "due";

export type ProductionEventCalendarData = {
  dto: CalendarEventDto;
  shape: ProductionEventCalendarShape;
  /** True when `end` is a display length, not a stored endpoint (Deadlines, due-only items). */
  syntheticEnd: boolean;
  /** Assignee initials for a checklist item; null for a Deadline or an unassigned item. */
  initials: string | null;
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
  if (dto.kind === "project_deadline") return "deadline";
  return dto.schedule.state === "range" ? "range" : "due";
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
    initials: dto.kind === "checklist" && dto.assignee ? assigneeInitials(dto.assignee.name) : null,
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
 */
export function productionEventCalendarEventClassName(data: ProductionEventCalendarData | undefined): string | undefined {
  if (!data) return undefined;
  if (data.shape === "deadline") return "bg-(--ink-900) hover:bg-(--ink-800) text-(--paper-050) inset-ring-(--ink-900)";
  if (data.done) return "bg-border/25 hover:bg-border/35 inset-ring-border/25 text-muted-foreground";
  return "bg-(--paper-000) hover:bg-(--paper-100) inset-ring-(--border-hairline) text-foreground";
}

export function subviewToCalendarView(subview: ProductionCalendarSubview): CalendarViewName {
  return subview;
}

export function calendarViewToSubview(view: CalendarViewName): ProductionCalendarSubview | null {
  return view === "resource" ? null : view;
}
