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
 * `onDateChange`, `onEventUpdate`, …) with a crafted argument inside `act`. The fake renders each
 * event through the consumer's `renderEvent` with the consumer's `eventClassName`, under Quincy
 * `data-testid`s only — never a vendor `data-slot` (Guard F).
 */
import type { ReactNode } from "react";

type FakeEvent = { id: string; title: string; data?: unknown };
type FakeOccurrence = { key: string; event: FakeEvent };
type FakeCalendarProps = {
  children?: ReactNode;
  events?: FakeEvent[];
  view?: string;
  date?: Date;
  renderEvent?: (props: { occurrence: FakeOccurrence; segment: unknown; view: string; isDragging: boolean; isSelected: boolean }) => ReactNode;
  eventClassName?: (occurrence: FakeOccurrence) => string | undefined;
  [key: string]: unknown;
};

export const eventCalendarFake: { lastProps: FakeCalendarProps | null; reset: () => void } = {
  lastProps: null,
  reset() { this.lastProps = null; },
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
            <li key={event.id} data-testid="event-calendar-fake-event" data-event-id={event.id} className={props.eventClassName?.(occurrence)}>
              {props.renderEvent ? props.renderEvent({ occurrence, segment: {}, view, isDragging: false, isSelected: false }) : event.title}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export const eventCalendarModule = { EventCalendar: FakeEventCalendar };
export const eventCalendarNavModule = { EventCalendarNav: () => <div data-testid="event-calendar-fake-nav" /> };
export const eventCalendarContentModule = { EventCalendarContent: () => <div data-testid="event-calendar-fake-content" /> };
