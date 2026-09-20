/**
 * #219 stage 1 harness content — the module `src/harness/reui-scheduling/main.tsx` lazy-imports.
 * Quincy-owned (not a ReUI vendored file). Renders the vendored `components/reui/gantt/` tree
 * against local fixture data ONLY: no `lib/use-scheduling-commands`, no `lib/scheduling-policy`,
 * no API client. This is the one file under `src/harness/` allowed to import
 * `components/reui/gantt` — see `src/harness/harness-reachability.guard.test.ts`.
 */
import { useState } from "react";
import { Gantt } from "@/components/reui/gantt/gantt";
import { GanttNav, GanttToolbar } from "@/components/reui/gantt/gantt-nav";
import { GanttView } from "@/components/reui/gantt/gantt-view";
import type { GanttEvent, GanttResource } from "@/components/reui/gantt/gantt-types";

const today = new Date();
const daysFromNow = (days: number): Date => {
  const date = new Date(today);
  date.setDate(date.getDate() + days);
  return date;
};

/** A parent resource with two children, per the spec's fixture shape. */
const FIXTURE_RESOURCES: GanttResource[] = [
  {
    id: "team-alpha",
    title: "Team Alpha",
    children: [
      { id: "shoot-auckland", title: "Auckland Shoot" },
      { id: "shoot-wellington", title: "Wellington Shoot" },
    ],
  },
];

const FIXTURE_EVENTS: GanttEvent[] = [
  {
    id: "edit-pass",
    title: "Photo Edit Pass",
    start: daysFromNow(0),
    end: daysFromNow(3),
    resourceId: "shoot-auckland",
  },
  {
    id: "client-signoff",
    title: "Client Sign-off",
    // A milestone: start === end.
    start: daysFromNow(5),
    end: daysFromNow(5),
    resourceId: "shoot-wellington",
  },
  {
    id: "portal-upload",
    title: "Upload to Client Portal",
    start: daysFromNow(-3),
    end: daysFromNow(-1),
    resourceId: "shoot-auckland",
    progress: 100,
  },
];

export default function GanttPreview() {
  // Local fixture state only, per the stage-1 spec — no scheduling-commands hook, no API client.
  const [events, setEvents] = useState<GanttEvent[]>(FIXTURE_EVENTS);

  return (
    <Gantt
      resources={FIXTURE_RESOURCES}
      events={events}
      onEventsChange={setEvents}
      timeZone="Australia/Sydney"
      className="h-[32rem]"
    >
      <GanttNav />
      <GanttToolbar />
      <GanttView />
    </Gantt>
  );
}
