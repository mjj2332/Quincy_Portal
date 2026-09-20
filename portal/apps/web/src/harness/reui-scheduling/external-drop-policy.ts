/**
 * #219 stage 3 (PR B) — the POLICY half of the external drop. Quincy-owned (not a ReUI vendored
 * file). Pure, React-free, no DOM (so this module runs in the plain node vitest config, exactly
 * like `fixtures.ts` above it).
 *
 * This lives OUTSIDE the vendored tree deliberately, for a reason the vendor module's own header
 * (`event-calendar-dnd.tsx`, "QUINCY ADDITION (#219 PR B stage 3) — external drop") already states:
 * turning a dropped payload into a `CalendarEvent` is Quincy's business, not the vendor's. And,
 * unlike a move or resize, the commit path here is NOT coupled to the vendor at all —
 * `applyProposedUpdate` maps over EXISTING events matching an id, so it can only ever UPDATE one; a
 * drop CREATES a brand new event, which happens through the public `api.addEvent`, an ordinary,
 * unprivileged call any consumer can make. Nothing in `event-calendar-dnd.tsx` needs to know this
 * module exists.
 *
 * `unscheduledItemToEvent` currently has exactly one caller (`CalendarPreview.tsx`'s tray), so this
 * file is expected to move to `lib/` the day a second, real (non-harness) consumer arrives — at
 * which point it stops being fixture-adjacent and becomes ordinary scheduling policy.
 */
import type { CalendarEvent } from "@/components/reui/event-calendar/event-calendar-types";
import type { EventCalendarExternalDropTarget } from "@/components/reui/event-calendar/event-calendar-dnd";
import { civilDaySpan, type UnscheduledItem } from "./fixtures";

/**
 * Turn a resolved drop target + the dragged tray item into a `CalendarEvent` ready for
 * `api.addEvent`. Never re-derives geometry: `target.start`/`target.end` already went through the
 * vendor's own snap-and-clamp (`resolveExternalDropTarget` in `event-calendar-dnd.tsx`) at the
 * moment the pointer was released, so snapping again here would silently re-quantize an already
 *-quantized instant — harmless most of the time, but a real bug on a DST transition day where a
 * second `snapMinutes` pass over an already-elapsed-minute value is not guaranteed to be a no-op
 * (the whole point of `elapsedMinutesAtWallClockHour` existing is that these days are not evenly
 * divisible the way an ordinary 1440-minute day is). The policy trusts the target as given.
 */
export function unscheduledItemToEvent(
  target: EventCalendarExternalDropTarget,
  item: UnscheduledItem,
): CalendarEvent {
  return {
    // Deterministic, derived from the tray item's own stable id — never `crypto.randomUUID()` or a
    // counter. A second drop of the same unscheduled item therefore REPLACES its prior scheduled
    // occurrence (same id going into `onEventsChange`/`api.addEvent`) rather than duplicating it,
    // which is the harness's own re-seed-on-scenario-switch behaviour extended to a single item:
    // "drop this thing" is idempotent in the id it produces, even though committing it is still the
    // caller's job.
    id: `scheduled-${item.id}`,
    title: item.title,
    color: item.color,
    start: target.start,
    end: target.end,
    allDay: target.allDay,
    ...(target.resourceId !== undefined ? { resourceId: target.resourceId } : {}),
    data: { done: false, fromUnscheduled: true },
  };
}

/** Refuses a target the harness should not accept. */
export function canDropUnscheduled(
  target: EventCalendarExternalDropTarget,
  // `item` is currently unused by either rule below, but kept in the signature (per spec) so a
  // future per-item rule — e.g. "this item may only land on its own resource lane" — does not
  // change the call sites that already pass it.
  _item: UnscheduledItem,
): boolean {
  // Rule 1: a resource column that somehow lost its id. `dayGranular === false` means the target
  // resolved from a minute-precise column (not a day cell), and the resource view's own columns are
  // always tagged with `data-ec-resource` (see `collectSurface`) — so a minute-precise target in
  // "resource" view with no `resourceId` indicates a malformed/untagged column, not a legitimate
  // "no resource" drop, and must be refused rather than silently scheduled off-lane.
  if (target.dayGranular === false && target.resourceId === undefined && target.view === "resource") {
    return false;
  }

  // Rule 2: a timed (non-all-day) target must not straddle a Sydney civil-day boundary. A drop is a
  // single user gesture over a single point on the grid, so a target reaching past midnight means
  // the duration overran the clamp the vendor already applies inside the day
  // (`resolveExternalDropTarget`'s own `Math.min(... col.boundsEndMin - durationMinutes)`) — which
  // can only happen for an all-day target (a deliberate whole-day-or-more block) or a bug. All-day
  // targets are explicitly exempted since they are meant to span calendar days.
  if (!target.allDay && civilDaySpan(target.start, target.end) !== 0) {
    return false;
  }

  return true;
}
