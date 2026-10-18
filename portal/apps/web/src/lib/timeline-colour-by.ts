/**
 * #916 / #920: the Dashboard Timeline's "Colour by" (glossary **Colour by**), frame 3b
 * (`design/prototypes/dashboard-views`, "Dashboard views v3"). Stage paints each bar in its Project's
 * Stage tone (frame 3a); People paints each Subtask in its assignee's colour and turns Project bars
 * neutral (frame 3b). Timeline only.
 *
 * The choice is a per-browser viewer preference, best-effort like the last Dashboard view
 * (`DASHBOARD_VIEW_KEY`): `quincy:ui:dashboard:timeline:colour-by`, read through `useUiPref`, which
 * survives blocked storage for the session and re-renders every reader in the tab. So the desktop
 * switch (`ProductionGanttNav`) and the phone Key drawer (#921) can each read the hook, or share one
 * reading through the controlled `TimelineColourBySwitch` (`components/ProductionGanttColourBy.tsx`).
 *
 * The People-mode copy the bars and the key row show lives here too: every rule about WHO (tone,
 * colour, initials) is `dashboard-appearance.ts`'s; this only words and counts it.
 */
import { personColor, personInitials } from "./dashboard-appearance";
import { sydneyDayKey } from "./date-format";
import { uiPrefKey, useUiPref } from "./ui-prefs";

export type ColourBy = "stage" | "people";

export const TIMELINE_COLOUR_BY_KEY = uiPrefKey("dashboard:timeline:colour-by");

/** Module level (stable for `useUiPref`). Anything but "people" is the default, Stage. */
export function normalizeColourBy(raw: unknown): ColourBy {
  return raw === "people" ? "people" : "stage";
}

/** The remembered choice and its setter. Every reader in the tab re-renders on a change. */
export function useTimelineColourBy(): [ColourBy, (next: ColourBy) => void] {
  return useUiPref(TIMELINE_COLOUR_BY_KEY, normalizeColourBy);
}

/* ------------------------------------------------------------------ Project bar label */

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "Mon 14", or "today": a Sydney civil day, from its day key (never the device's zone). */
function civilDayShort(instant: Date, todayKey: string): string {
  const key = sydneyDayKey(instant);
  if (key === todayKey) return "today";
  const [year, month, day] = key.split("-").map(Number);
  return `${WEEKDAY[new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay()]} ${day}`;
}

/**
 * Frame 3b's neutral Project bar label, shoot to Deadline: "Mon 14 → Fri 18", "Mon 14 → today".
 * A Project with no shoot date (its bar starts at its creation, `hollowStart`) names only the Deadline:
 * "Due Fri 18".
 */
export function peopleProjectSpanLabel(span: { start: Date; end: Date; hollowStart: boolean; todayKey: string }): string {
  const due = civilDayShort(span.end, span.todayKey);
  return span.hollowStart ? `Due ${due}` : `${civilDayShort(span.start, span.todayKey)} → ${due}`;
}

/* ------------------------------------------------------------------ Key row */

export type PeopleKeyEntry = { personId: string; label: string; initials: string; color: string; open: number };

/**
 * Frame 3b's key row: every named assignee of a drawn Subtask with how many of their Subtasks are open
 * (a shared Subtask counts for each named assignee), busiest first, then by name; and how many open
 * Subtasks have nobody. A hidden assignee (an External Editor's view) is counted for nobody and never
 * makes a Subtask unassigned. Display-only (owner decision D6): the chips write no filter.
 */
export function peopleKeyEntries(
  subtasks: Iterable<{ assignees: readonly { id: string; name: string }[]; otherAssigneeCount: number; done: boolean }>,
): { people: PeopleKeyEntry[]; unassignedOpen: number } {
  const byId = new Map<string, PeopleKeyEntry>();
  let unassignedOpen = 0;
  for (const subtask of subtasks) {
    if (subtask.assignees.length === 0 && subtask.otherAssigneeCount === 0) {
      if (!subtask.done) unassignedOpen += 1;
      continue;
    }
    for (const person of subtask.assignees) {
      let entry = byId.get(person.id);
      if (!entry) {
        entry = { personId: person.id, label: person.name.trim() || "Assignee (name unavailable)", initials: personInitials(person.name) ?? "?", color: personColor(person.id), open: 0 };
        byId.set(person.id, entry);
      }
      if (!subtask.done) entry.open += 1;
    }
  }
  const people = [...byId.values()].sort((a, b) => b.open - a.open || a.label.localeCompare(b.label) || (a.personId < b.personId ? -1 : 1));
  return { people, unassignedOpen };
}
