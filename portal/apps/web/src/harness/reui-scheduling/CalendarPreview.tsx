/**
 * #219 stage 3 (PR B) harness content — the module `src/harness/reui-scheduling/main.tsx`
 * lazy-imports alongside `GanttPreview`. Quincy-owned (not a ReUI vendored file). Renders the
 * vendored `components/reui/event-calendar/` tree against local fixture data ONLY: no
 * `lib/use-scheduling-commands`, no `lib/scheduling-policy`, no API client, no
 * `lib/toast-store.ts`. This is the one file under `src/harness/` allowed to import
 * `components/reui/event-calendar` — see `src/harness/harness-reachability.guard.test.ts`.
 *
 * Composition follows `event-calendar.tsx`'s own documented contract verbatim:
 * `<EventCalendar><EventCalendarNav/><EventCalendarToolbar/><EventCalendarContent/></EventCalendar>`.
 *
 * `events`/`view`/`date` are all CONTROLLED (see the `<EventCalendar>` props below), the same
 * pattern `GanttPreview.tsx` already uses for `events`/`date`/`scale` — switching scenarios swaps
 * the whole board in one render rather than leaving stale state from the previous scenario visible.
 *
 * PR B vends the calendar and re-skins it; there is no drag-and-drop wiring yet (that is stage 3's
 * own later step, tracked against the `unscheduled` tray below) and no keyboard layer (PR A's
 * Gantt keyboard legend has no calendar counterpart in this PR), so neither appears here.
 */
import { useCallback, useState } from "react";
import { EventCalendar } from "@/components/reui/event-calendar/event-calendar";
import { EventCalendarNav, EventCalendarToolbar } from "@/components/reui/event-calendar/event-calendar-nav";
import { EventCalendarContent } from "@/components/reui/event-calendar/event-calendar-content";
import type {
  CalendarEvent,
  CalendarView,
  EventCalendarProposedUpdate,
} from "@/components/reui/event-calendar/event-calendar-types";
import { buildCalendarScenario, formatZonedInstant, SCENARIOS, type ScenarioId } from "./fixtures";

const LOG_CAP = 20;

const VIEWS: CalendarView[] = ["month", "week", "day", "days", "agenda", "resource"];

interface LogEntry {
  id: number;
  source: string;
  eventId: string;
  startText: string;
  endText: string;
}

let nextLogId = 0;

export default function CalendarPreview() {
  const [scenarioId, setScenarioId] = useState<ScenarioId>("today");
  const [view, setView] = useState<CalendarView>("week");
  const [log, setLog] = useState<LogEntry[]>([]);

  const fixture = buildCalendarScenario(scenarioId);
  // Local fixture state only (per the stage-1/PR-A precedent — no scheduling-commands hook, no API
  // client), re-seeded whenever the scenario switches; `date` stays controlled too so a scenario
  // switch forces the anchor back to the fixture's own month even after the user has panned away.
  const [events, setEvents] = useState<CalendarEvent[]>(fixture.events);
  const [date, setDate] = useState<Date>(fixture.date);
  const [activeScenarioId, setActiveScenarioId] = useState<ScenarioId>(scenarioId);
  if (activeScenarioId !== scenarioId) {
    // Scenario switch: adopt the new fixture (React 19 render-phase state adjustment, not an
    // effect — the switch must be visible in THIS commit, not one tick later).
    setActiveScenarioId(scenarioId);
    setEvents(fixture.events);
    setDate(fixture.date);
  }

  const pushLog = useCallback((entry: Omit<LogEntry, "id">) => {
    setLog((previous) => [{ id: nextLogId++, ...entry }, ...previous].slice(0, LOG_CAP));
  }, []);

  const handleEventUpdate = useCallback(
    (update: EventCalendarProposedUpdate) => {
      pushLog({
        source: update.source,
        eventId: update.event.id,
        startText: formatZonedInstant(update.start),
        endText: formatZonedInstant(update.end),
      });
      return true;
    },
    [pushLog],
  );

  const handleSelectSlot = useCallback(
    (slot: { start: Date; end: Date }) => {
      pushLog({
        source: "selectSlot",
        eventId: "(slot)",
        startText: formatZonedInstant(slot.start),
        endText: formatZonedInstant(slot.end),
      });
    },
    [pushLog],
  );

  const handleDragBlocked = useCallback(
    (
      occurrence: { event: { id: string }; start: Date; end: Date },
      info: { gesture: "move" | "resize"; reason: "readOnly" | "disabled" | "interactions-off" },
    ) => {
      pushLog({
        source: `blocked:${info.gesture}:${info.reason}`,
        eventId: occurrence.event.id,
        startText: formatZonedInstant(occurrence.start),
        endText: formatZonedInstant(occurrence.end),
      });
    },
    [pushLog],
  );

  return (
    <div className="grid gap-4 p-4">
      <div role="group" aria-label="Scenario" className="flex flex-wrap items-center gap-2">
        {SCENARIOS.map((scenario) => (
          <button
            key={scenario.id}
            type="button"
            data-testid={`harness-cal-scenario-${scenario.id}`}
            aria-pressed={scenarioId === scenario.id}
            onClick={() => setScenarioId(scenario.id)}
          >
            {scenario.label}
          </button>
        ))}
      </div>

      <div role="group" aria-label="View" className="flex flex-wrap items-center gap-2">
        {VIEWS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            data-testid={`harness-cal-view-${candidate}`}
            aria-pressed={view === candidate}
            onClick={() => setView(candidate)}
          >
            {candidate}
          </button>
        ))}
      </div>

      <EventCalendar
        events={events}
        onEventsChange={setEvents}
        view={view}
        onViewChange={setView}
        date={date}
        onDateChange={setDate}
        resources={fixture.resources}
        timeZone="Australia/Sydney"
        onEventUpdate={handleEventUpdate}
        onSelectSlot={handleSelectSlot}
        onDragBlocked={handleDragBlocked}
        className="h-[40rem]"
      >
        <EventCalendarNav />
        <EventCalendarToolbar />
        <EventCalendarContent />
      </EventCalendar>

      <div data-testid="harness-cal-tray">
        <h2 className="q-h3">Unscheduled</h2>
        {/* Plain, non-draggable list items — stage 3 wires the external-drag source onto these. */}
        <ul>
          {fixture.unscheduled.map((item) => (
            <li key={item.id} data-testid={`harness-cal-tray-${item.id}`}>
              {item.title} · {item.durationMinutes} min
            </li>
          ))}
        </ul>
      </div>

      <div data-testid="harness-cal-dst-notes">
        <h2 className="q-h3">DST notes — check in the browser</h2>
        <ul>
          <li>
            dst-autumn (25h day): "DST probe: late-night edit" (23:15–23:45) should be INVISIBLE in
            a time-grid view (week/day/days) — its elapsed startMin (1455) is past the vendor's
            1440-minute bounds-end clamp. See `fixtures.ts`'s `dst-late-night` comment.
          </li>
          <li>
            dst-spring (23h day): "DST probe: transition-hour edit" (1:30–3:30) should render a
            SHORTER block than the same event on dst-autumn — 1 real elapsed hour on the spring day
            vs. 3 real elapsed hours on the autumn day for the same wall-clock span. Compare the
            event's own height against the hour gutter lines to see whether they still agree.
          </li>
        </ul>
      </div>

      <div data-testid="harness-cal-log">
        <h2 className="q-h3">Event log (newest first, last {LOG_CAP})</h2>
        {log.length === 0 ? (
          <p>No commits yet — drag, resize, select a slot, or attempt to drag a locked event.</p>
        ) : (
          <ol>
            {log.map((entry) => (
              <li key={entry.id}>
                {entry.source} · {entry.eventId} · {entry.startText} → {entry.endText}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
