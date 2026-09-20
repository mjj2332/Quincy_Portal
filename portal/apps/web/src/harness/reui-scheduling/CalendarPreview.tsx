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
 * The unscheduled tray is now LIVE: each row is an external-drag source
 * (`useEventCalendarExternalDrop` from `event-calendar-dnd.tsx`), resolved through the calendar's
 * own hit-testing and committed via `external-drop-policy.ts`'s `unscheduledItemToEvent`/
 * `canDropUnscheduled`. There is still no keyboard layer (PR A's Gantt keyboard legend has no
 * calendar counterpart in this PR).
 */
import { useCallback, useState } from "react";
import { EventCalendar } from "@/components/reui/event-calendar/event-calendar";
import type { EventCalendarOccurrence } from "@/components/reui/event-calendar/event-calendar-types";
import { EventCalendarNav, EventCalendarToolbar } from "@/components/reui/event-calendar/event-calendar-nav";
import { EventCalendarContent } from "@/components/reui/event-calendar/event-calendar-content";
import { useEventCalendarExternalDrop } from "@/components/reui/event-calendar/event-calendar-dnd";
import type {
  CalendarEvent,
  CalendarView,
  EventCalendarProposedUpdate,
} from "@/components/reui/event-calendar/event-calendar-types";
import { buildCalendarScenario, formatZonedInstant, SCENARIOS, type ScenarioId, type UnscheduledItem } from "./fixtures";
import { canDropUnscheduled, unscheduledItemToEvent } from "./external-drop-policy";

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

/**
 * QUINCY (#219 PR B stage 3): the tray must render INSIDE `<EventCalendar>` because
 * `useEventCalendarExternalDrop` calls `useEventCalendar()`, whose context has no default and is
 * only provided by that component. Lifting the tray into this child (rendered as a sibling of
 * `<EventCalendarContent>`, inside the same provider) is simpler than threading the calendar
 * instance back out through a ref, and it keeps the provider boundary exactly where the vendor
 * file's own contract says it is.
 */
function UnscheduledTray({
  items,
  preferAllDay,
  onScheduled,
}: {
  items: UnscheduledItem[];
  preferAllDay: boolean;
  onScheduled: (item: UnscheduledItem, event: CalendarEvent) => void;
}) {
  const { begin } = useEventCalendarExternalDrop<unknown, UnscheduledItem>();

  return (
    <div data-testid="harness-cal-tray">
      <h2 className="q-h3">Unscheduled</h2>
      <ul>
        {items.map((item) => (
          <li
            key={item.id}
            data-testid={`harness-cal-tray-${item.id}`}
            className="harness-cal-tray-item"
            onPointerDown={(e) => {
              begin(e, {
                payload: item,
                durationMinutes: item.durationMinutes,
                preferAllDay,
                canDrop: canDropUnscheduled,
                onDrop: (target, payload) => {
                  const event = unscheduledItemToEvent(target, payload);
                  onScheduled(payload, event);
                },
              });
            }}
          >
            {item.title} · {item.durationMinutes} min
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * "Dimmed done tasks" (#219's re-skin line), supplied by the CONSUMER.
 *
 * The vendor deliberately has no concept of done — see the `eventClassName` doc on its
 * viewConfig. Completion is read from Quincy's own `event.data.done`, never from the vendor's
 * `data-past`, which is derived from the clock: a past meeting nobody actioned is not done, and
 * this fixture set contains a task that is done while still in the FUTURE precisely so the two
 * cannot be conflated.
 *
 * The dim is HUE-INDEPENDENT, and that is the whole point. #219 PR A shipped a per-hue alpha step
 * for completed Gantt bars (`bg-(--gantt-event-color)/10`) and the design reviewer measured it as
 * a failure (dr-219a MEDIUM #5): a 10% wash of a naturally dark, saturated stage colour can read
 * LOUDER than a 20% wash of a naturally light one, so "reduced emphasis" did not guarantee
 * "reduced loudness". PR A's fix was the fixed `--border` token every stage shares. This does the
 * same thing rather than repeating the mistake in a second tree — and `future-and-done` uses
 * `--signal-positive`, one of the most saturated stage colours, so it is the worst case.
 *
 * `cn()` is tailwind-merge, so `bg-border/…` replaces the chip's own `bg-(--ec-event-color)/15`
 * rather than layering over it.
 */
const dimDoneChip = (occurrence: EventCalendarOccurrence<unknown>): string | undefined =>
  (occurrence.event.data as { done?: boolean } | undefined)?.done
    ? "bg-border/25 hover:bg-border/35 inset-ring-border/25 text-muted-foreground"
    : undefined;

export default function CalendarPreview() {
  const [scenarioId, setScenarioId] = useState<ScenarioId>("today");
  const [view, setView] = useState<CalendarView>("week");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [preferAllDay, setPreferAllDay] = useState(false);

  const fixture = buildCalendarScenario(scenarioId);
  // Local fixture state only (per the stage-1/PR-A precedent — no scheduling-commands hook, no API
  // client), re-seeded whenever the scenario switches; `date` stays controlled too so a scenario
  // switch forces the anchor back to the fixture's own month even after the user has panned away.
  const [events, setEvents] = useState<CalendarEvent[]>(fixture.events);
  const [date, setDate] = useState<Date>(fixture.date);
  // Ids of unscheduled items already dropped onto the calendar this scenario — removed from the
  // tray so a scheduled item cannot be dropped a second time as a fresh row (re-dropping the SAME
  // tray row is still possible via `unscheduledItemToEvent`'s deterministic id; this state is only
  // about what the tray itself still offers).
  const [scheduledIds, setScheduledIds] = useState<ReadonlySet<string>>(new Set());
  const [activeScenarioId, setActiveScenarioId] = useState<ScenarioId>(scenarioId);
  if (activeScenarioId !== scenarioId) {
    // Scenario switch: adopt the new fixture (React 19 render-phase state adjustment, not an
    // effect — the switch must be visible in THIS commit, not one tick later).
    setActiveScenarioId(scenarioId);
    setEvents(fixture.events);
    setDate(fixture.date);
    setScheduledIds(new Set());
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

  const handleScheduled = useCallback(
    (item: UnscheduledItem, event: CalendarEvent) => {
      setEvents((previous) => [...previous.filter((candidate) => candidate.id !== event.id), event]);
      setScheduledIds((previous) => new Set(previous).add(item.id));
      pushLog({
        source: "externalDrop",
        eventId: event.id,
        startText: formatZonedInstant(event.start),
        endText: formatZonedInstant(event.end),
      });
    },
    [pushLog],
  );

  const trayItems = fixture.unscheduled.filter((item) => !scheduledIds.has(item.id));

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

      <button
        type="button"
        data-testid="harness-cal-tray-allday"
        aria-pressed={preferAllDay}
        onClick={() => setPreferAllDay((previous) => !previous)}
      >
        Prefer all-day drop: {preferAllDay ? "on" : "off"}
      </button>

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
        eventClassName={dimDoneChip}
        className="h-[40rem]"
      >
        <EventCalendarNav />
        <EventCalendarToolbar />
        <EventCalendarContent />
        <UnscheduledTray items={trayItems} preferAllDay={preferAllDay} onScheduled={handleScheduled} />
      </EventCalendar>

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
          <p>No commits yet — drag, resize, select a slot, drop a tray item, or attempt to drag a locked event.</p>
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
