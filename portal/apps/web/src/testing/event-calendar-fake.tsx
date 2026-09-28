/**
 * #222 — a stand-in for the vendored ReUI event calendar, for `ProductionEventCalendar` tests where
 * the real tree is impractical. Test-only; nothing in production imports this file, and it never
 * imports `components/reui/event-calendar/` itself.
 *
 * Use it by mocking each vendor module the surface imports:
 *
 *   vi.mock("./reui/event-calendar/event-calendar", async () => (await import("../testing/event-calendar-fake")).eventCalendarModule);
 *   vi.mock("./reui/event-calendar/event-calendar-nav", async () => (await import("../testing/event-calendar-fake")).eventCalendarNavModule);
 *   vi.mock("./reui/event-calendar/event-calendar-content", async () => (await import("../testing/event-calendar-fake")).eventCalendarContentModule);
 *   vi.mock("./reui/event-calendar/event-calendar-dnd", async () => (await import("../testing/event-calendar-fake")).eventCalendarDndModule);
 *
 * `eventCalendarFake.lastProps` records the props of the most recent `<EventCalendar>` render, so a
 * test can assert the controlled view/date/interactions and invoke a callback (`onSlotClick`,
 * `onDateChange`, …) with a crafted argument inside `act`. The fake renders each event through the
 * consumer's `renderEvent` with the consumer's `eventClassName`, inside a focusable `<button>` like
 * the vendor chip (the controller's focus return climbs to it from the chip content's
 * `data-event-id`), under Quincy `data-testid`s only — never a vendor `data-slot` (Guard F) nor a
 * vendor `data-ec-*` attribute (skin guard, detector 9).
 *
 * Writes (round 3):
 * - `eventCalendarFake.update(id, { start, end?, allDay?, source?, granularity? })` calls
 *   `onEventUpdate` with the CURRENT rendered event as `update.event` (the scheduling module reads
 *   the original instants from it), records and returns the result (`false` = the vendor would snap
 *   back; `"deferred"` = the consumer owns it).
 * - `eventCalendarFake.click(id)` calls `onEventClick` with that event's occurrence.
 * - `useEventCalendarExternalDrop().begin(e, options)` records `options` in `lastDrag`; when
 *   `nextDropTarget` is set it runs `canDrop` and, if allowed, `onDrop` immediately (else
 *   `onCancel`). `lastDropAccepted` records the verdict.
 */
import type { ReactNode } from "react";

type FakeEvent = { id: string; title: string; start: Date; end: Date; allDay?: boolean; data?: unknown; draggable?: boolean; resizable?: boolean; resizableEdges?: { start?: boolean; end?: boolean } };
type FakeOccurrence = { key: string; event: FakeEvent };
type FakeCalendarProps = {
  children?: ReactNode;
  events?: FakeEvent[];
  view?: string;
  date?: Date;
  renderEvent?: (props: { occurrence: FakeOccurrence; segment: unknown; view: string; isDragging: boolean; isSelected: boolean }) => ReactNode;
  eventClassName?: (occurrence: FakeOccurrence) => string | undefined;
  onEventUpdate?: (update: unknown) => unknown;
  onEventClick?: (occurrence: FakeOccurrence, e: unknown) => void;
  [key: string]: unknown;
};

export type FakeUpdateInput = {
  start: Date;
  end?: Date;
  allDay?: boolean;
  source?: "drag" | "resize-start" | "resize-end" | "keyboard" | "api";
  granularity?: "day" | "minute";
};

export type FakeDropTarget = { start: Date; end: Date; allDay: boolean; view: string; dayGranular: boolean; resourceId?: string };
export type FakeDropOptions = {
  payload: unknown;
  durationMinutes: number;
  preferAllDay?: boolean;
  canDrop?: (target: FakeDropTarget, payload: unknown) => boolean;
  onDrop: (target: FakeDropTarget, payload: unknown) => void;
  onCancel?: () => void;
};

type FakeState = {
  lastProps: FakeCalendarProps | null;
  updateResults: unknown[];
  lastDrag: FakeDropOptions | null;
  nextDropTarget: FakeDropTarget | null;
  lastDropAccepted: boolean | null;
  reset: () => void;
  event: (id: string) => FakeEvent | undefined;
  update: (id: string, input: FakeUpdateInput) => unknown;
  click: (id: string) => void;
};

export const eventCalendarFake: FakeState = {
  lastProps: null,
  updateResults: [],
  lastDrag: null,
  nextDropTarget: null,
  lastDropAccepted: null,
  reset() {
    this.lastProps = null;
    this.updateResults = [];
    this.lastDrag = null;
    this.nextDropTarget = null;
    this.lastDropAccepted = null;
  },
  event(id) {
    return this.lastProps?.events?.find((candidate) => candidate.id === id);
  },
  update(id, input) {
    const event = this.event(id);
    if (!event) throw new Error(`fake event calendar: no rendered event ${id}`);
    const start = input.start;
    const end = input.end ?? new Date(start.getTime() + (event.end.getTime() - event.start.getTime()));
    const result = this.lastProps?.onEventUpdate?.({
      event,
      occurrence: { key: event.id, event },
      start,
      end,
      allDay: input.allDay ?? Boolean(event.allDay),
      source: input.source ?? "drag",
      ...(input.source === "api" ? {} : { granularity: input.granularity ?? (input.allDay ?? event.allDay ? "day" : "minute") }),
    });
    this.updateResults.push(result);
    return result;
  },
  click(id) {
    const event = this.event(id);
    if (!event) throw new Error(`fake event calendar: no rendered event ${id}`);
    this.lastProps?.onEventClick?.({ key: event.id, event }, {});
  },
};

function FakeEventCalendar(props: FakeCalendarProps) {
  eventCalendarFake.lastProps = props;
  const view = props.view ?? "month";
  return (
    <div data-testid="event-calendar-fake" data-view={view} data-date={props.date?.toISOString()}>
      {props.children}
      <ul data-testid="event-calendar-fake-events">
        {(props.events ?? []).map((event) => {
          const occurrence = { key: event.id, event };
          return (
            <li key={event.id} data-testid="event-calendar-fake-event" data-event-start={event.start.toISOString()} data-draggable={String(event.draggable ?? true)} className={props.eventClassName?.(occurrence)}>
              <button type="button" data-testid="event-calendar-fake-chip" onClick={(e) => props.onEventClick?.(occurrence, e)}>
                {props.renderEvent ? props.renderEvent({ occurrence, segment: {}, view, isDragging: false, isSelected: false }) : event.title}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function useFakeExternalDrop() {
  return {
    begin(_e: unknown, options: FakeDropOptions) {
      eventCalendarFake.lastDrag = options;
      const target = eventCalendarFake.nextDropTarget;
      if (!target) return;
      const accepted = options.canDrop?.(target, options.payload) ?? true;
      eventCalendarFake.lastDropAccepted = accepted;
      if (accepted) options.onDrop(target, options.payload);
      else options.onCancel?.();
    },
  };
}

export const eventCalendarModule = { EventCalendar: FakeEventCalendar };
export const eventCalendarNavModule = { EventCalendarNav: () => <div data-testid="event-calendar-fake-nav" /> };
export const eventCalendarContentModule = { EventCalendarContent: () => <div data-testid="event-calendar-fake-content" /> };
export const eventCalendarDndModule = { useEventCalendarExternalDrop: useFakeExternalDrop };
