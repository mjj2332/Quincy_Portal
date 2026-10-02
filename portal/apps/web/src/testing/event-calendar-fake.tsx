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
 * - `eventCalendarFake.click(id)` clicks that event's rendered chip button, so `onEventClick` receives a real
 *   React click event (#463: the surface calls `e.preventDefault()` on it and anchors its menu to the chip).
 *   The chip also reports a right-click through `onEventContextMenu` and carries the `eventPopup` ARIA state.
 */
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

type FakeEvent = { id: string; title: string; start: Date; end: Date; allDay?: boolean; data?: unknown; draggable?: boolean; resizable?: boolean; resizableEdges?: { start?: boolean; end?: boolean } };
type FakeOccurrence = { key: string; event: FakeEvent };
type FakeCalendarProps = {
  children?: ReactNode;
  events?: FakeEvent[];
  view?: string;
  date?: Date;
  renderMoreIndicator?: (props: { day: Date; count: number; segments: Array<{ occurrence: FakeOccurrence }> }) => ReactNode;
  renderEvent?: (props: { occurrence: FakeOccurrence; segment: unknown; view: string; isDragging: boolean; isSelected: boolean }) => ReactNode;
  eventClassName?: (occurrence: FakeOccurrence) => string | undefined;
  onEventUpdate?: (update: unknown) => unknown;
  onEventClick?: (occurrence: FakeOccurrence, e: ReactMouseEvent) => void;
  onEventContextMenu?: (occurrence: FakeOccurrence, e: ReactMouseEvent) => void;
  eventPopup?: { isOpen: (occurrence: FakeOccurrence) => boolean };
  [key: string]: unknown;
};

export type FakeUpdateInput = {
  start: Date;
  end?: Date;
  allDay?: boolean;
  source?: "drag" | "resize-start" | "resize-end" | "keyboard" | "api";
  granularity?: "day" | "minute";
};

type FakeState = {
  lastProps: FakeCalendarProps | null;
  updateResults: unknown[];
  /** #464: ids drawn folded under a day's "+N more" (no chip in the DOM), as a dense month day does. */
  foldedIds: Set<string>;
  reset: () => void;
  event: (id: string) => FakeEvent | undefined;
  update: (id: string, input: FakeUpdateInput) => unknown;
  click: (id: string) => void;
};

export const eventCalendarFake: FakeState = {
  lastProps: null,
  updateResults: [],
  foldedIds: new Set(),
  reset() {
    this.lastProps = null;
    this.updateResults = [];
    this.foldedIds = new Set();
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
    const chip = [...document.querySelectorAll<HTMLElement>("[data-event-id]")].find((element) => element.getAttribute("data-event-id") === id)?.closest("button");
    if (!chip) throw new Error(`fake event calendar: no rendered chip for ${id}`);
    chip.click();
  },
};

function FakeEventCalendar(props: FakeCalendarProps) {
  eventCalendarFake.lastProps = props;
  const view = props.view ?? "month";
  const foldedEvents = (props.events ?? []).filter((event) => eventCalendarFake.foldedIds.has(event.id));
  return (
    <div data-testid="event-calendar-fake" data-view={view} data-date={props.date?.toISOString()}>
      {props.children}
      <ul data-testid="event-calendar-fake-events">
        {foldedEvents.length > 0 && (
          <li data-testid="event-calendar-fake-more">
            <button type="button" data-testid="event-calendar-fake-more-trigger">
              {props.renderMoreIndicator?.({ day: foldedEvents[0]!.start, count: foldedEvents.length, segments: foldedEvents.map((event) => ({ occurrence: { key: event.id, event } })) }) ?? `+${foldedEvents.length} more`}
            </button>
          </li>
        )}
        {(props.events ?? []).filter((event) => !eventCalendarFake.foldedIds.has(event.id)).map((event) => {
          const occurrence = { key: event.id, event };
          return (
            <li key={event.id} data-testid="event-calendar-fake-event" data-event-start={event.start.toISOString()} data-draggable={String(event.draggable ?? true)} className={props.eventClassName?.(occurrence)}>
              <button
                type="button"
                data-testid="event-calendar-fake-chip"
                aria-haspopup={props.eventPopup ? "menu" : undefined}
                aria-expanded={props.eventPopup ? props.eventPopup.isOpen(occurrence) : undefined}
                onClick={(e) => props.onEventClick?.(occurrence, e)}
                onContextMenu={(e) => props.onEventContextMenu?.(occurrence, e)}
              >
                {props.renderEvent ? props.renderEvent({ occurrence, segment: {}, view, isDragging: false, isSelected: false }) : event.title}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export const eventCalendarModule = { EventCalendar: FakeEventCalendar };
type FakeNavPartProps = { className?: string };
function fakeNavPart(testId: string, label: string) {
  return function FakeNavPart({ className }: FakeNavPartProps) {
    return <span data-testid={testId} className={className}>{label}</span>;
  };
}
/** The composed phone toolbar (#385) passes children to the nav and mounts the vendor's parts itself,
 *  so each part is stubbed under a Quincy test id that forwards `className`. With no children the nav
 *  renders exactly what it always did. */
export const eventCalendarNavModule = {
  EventCalendarNav: ({ children, className }: { children?: ReactNode; className?: string }) => <div data-testid="event-calendar-fake-nav" className={className}>{children}</div>,
  EventCalendarTitle: fakeNavPart("event-calendar-fake-title", "Title"),
  EventCalendarNavToday: fakeNavPart("event-calendar-fake-today", "Today"),
  EventCalendarViewSwitcher: fakeNavPart("event-calendar-fake-view-switcher", "View"),
  EventCalendarNavPrev: fakeNavPart("event-calendar-fake-prev", "Prev"),
  EventCalendarNavNext: fakeNavPart("event-calendar-fake-next", "Next"),
};
export const eventCalendarContentModule = { EventCalendarContent: () => <div data-testid="event-calendar-fake-content" /> };
