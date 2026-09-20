/**
 * #219 stage 1 harness content — the module `src/harness/reui-scheduling/main.tsx` lazy-imports.
 * Quincy-owned (not a ReUI vendored file). Renders the vendored `components/reui/gantt/` tree
 * against local fixture data ONLY: no `lib/use-scheduling-commands`, no `lib/scheduling-policy`,
 * no API client. This is the one file under `src/harness/` allowed to import
 * `components/reui/gantt` — see `src/harness/harness-reachability.guard.test.ts`.
 *
 * #219 stage 3 (PR A) rewrite: turns this from a single static fixture into an acceptance surface
 * a human or agent can drive in a real browser — a scenario switcher (`fixtures.ts`'s `today` /
 * `dst-spring` / `dst-autumn`), a read-only event log for every `onEventUpdate`, and an
 * `enforceCanDrop` toggle against a fixed-deadline `canDropEvent` fixture. `date`/`scale`/
 * `resources`/`events` are all CONTROLLED (see the `<Gantt>` props below) so switching scenarios
 * swaps the whole board in one render, the same pattern `onEventsChange` already used here.
 *
 * #219 PR A: the on-screen "Keyboard" legend below tracks gantt-bar.tsx's Adjust-mode scheme
 * (matchGanttBarKey in gantt-lib.tsx) -- Space enters/exits, not the old Alt+Arrow / Ctrl+Alt+Arrow
 * chords those replaced.
 */
import { useCallback, useState } from "react";
import { Gantt } from "@/components/reui/gantt/gantt";
import { GanttNav, GanttToolbar } from "@/components/reui/gantt/gantt-nav";
import { GanttView } from "@/components/reui/gantt/gantt-view";
import type { GanttEvent, GanttProposedUpdate, GanttScale } from "@/components/reui/gantt/gantt-types";
import { buildScenario, civilDaySpan, formatZonedInstant, SCENARIOS, type ScenarioId } from "./fixtures";

const LOG_CAP = 20;

interface LogEntry {
  id: number;
  source: GanttProposedUpdate["source"];
  eventId: string;
  startText: string;
  endText: string;
  civilDays: number;
}

let nextLogId = 0;

export default function GanttPreview() {
  const [scenarioId, setScenarioId] = useState<ScenarioId>("today");
  const [enforceCanDrop, setEnforceCanDrop] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);

  const fixture = buildScenario(scenarioId);
  // Local fixture state only (per the stage-1 spec — no scheduling-commands hook, no API client),
  // re-seeded whenever the scenario switches; every subsequent drag/resize/nudge/nav mutates from
  // here. `date`/`scale` stay controlled too (not left to defaultDate/defaultScale) so a scenario
  // switch can force the anchor back to the fixture's own month even after the user has panned
  // away with GanttNav's Prev/Next/Today — onDateChange/onScaleChange below keep that nav usable.
  const [events, setEvents] = useState<GanttEvent[]>(fixture.events);
  const [date, setDate] = useState<Date>(fixture.date);
  const [scale, setScale] = useState<GanttScale>(fixture.scale);
  const [activeScenarioId, setActiveScenarioId] = useState<ScenarioId>(scenarioId);
  if (activeScenarioId !== scenarioId) {
    // Scenario switch: adopt the new fixture (React 19 render-phase state adjustment, not an
    // effect — the switch must be visible in THIS commit, not one tick later).
    setActiveScenarioId(scenarioId);
    setEvents(fixture.events);
    setDate(fixture.date);
    setScale(fixture.scale);
  }

  const handleEventUpdate = useCallback((update: GanttProposedUpdate) => {
    setLog((previous) => [
      {
        id: nextLogId++,
        source: update.source,
        eventId: update.event.id,
        startText: formatZonedInstant(update.start),
        endText: formatZonedInstant(update.end),
        civilDays: civilDaySpan(update.start, update.end),
      },
      ...previous,
    ].slice(0, LOG_CAP));
    // Advisory-by-default: onEventUpdate itself always accepts. enforceCanDrop (below) is the
    // knob that makes canDropEvent's verdict binding instead of merely styling the drop ghost.
    return true;
  }, []);

  const canDropEvent = useCallback(
    (update: GanttProposedUpdate) => update.end.getTime() <= fixture.deadline.getTime(),
    [fixture.deadline],
  );

  return (
    <div className="grid gap-4 p-4">
      <div role="group" aria-label="Scenario" className="flex flex-wrap items-center gap-2">
        {SCENARIOS.map((scenario) => (
          <button
            key={scenario.id}
            type="button"
            data-testid={`harness-scenario-${scenario.id}`}
            aria-pressed={scenarioId === scenario.id}
            onClick={() => setScenarioId(scenario.id)}
          >
            {scenario.label}
          </button>
        ))}
        <button type="button" data-testid="harness-enforce-toggle" onClick={() => setEnforceCanDrop((value) => !value)}>
          {enforceCanDrop ? "Switch to advisory" : "Switch to enforced"}
        </button>
        <span data-testid="harness-enforce-mode">
          canDropEvent is {enforceCanDrop ? "ENFORCED (invalid drops revert)" : "ADVISORY (styles the ghost only)"} —
          deadline {formatZonedInstant(fixture.deadline)}
        </span>
      </div>

      <Gantt
        resources={fixture.resources}
        events={events}
        onEventsChange={setEvents}
        onEventUpdate={handleEventUpdate}
        canDropEvent={canDropEvent}
        enforceCanDrop={enforceCanDrop}
        date={date}
        onDateChange={setDate}
        scale={scale}
        onScaleChange={setScale}
        timeZone="Australia/Sydney"
        className="h-[32rem]"
      >
        <GanttNav />
        <GanttToolbar />
        <GanttView />
      </Gantt>

      <div data-testid="harness-key-help">
        <h2 className="q-h3">Keyboard</h2>
        <ul>
          <li>Enter on a focused bar — open the event.</li>
          <li>Space on a focused, non-recurring, adjustable bar — enter Adjust mode.</li>
          <li>Arrow — step the current target by one snap unit (Shift+Arrow — one larger unit).</li>
          <li>M / S / E — target the whole bar / start edge / end edge.</li>
          <li>Enter or Space — commit and exit. Escape, blur, or a click elsewhere — cancel and exit.</li>
        </ul>
      </div>

      <div data-testid="harness-event-log">
        <h2 className="q-h3">Event log (newest first, last {LOG_CAP})</h2>
        {log.length === 0 ? (
          <p>No commits yet — drag, resize, or keyboard-nudge a bar.</p>
        ) : (
          <ol>
            {log.map((entry) => (
              <li key={entry.id}>
                {entry.source} · {entry.eventId} · {entry.startText} → {entry.endText} · {entry.civilDays} civil day
                {entry.civilDays === 1 ? "" : "s"}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
