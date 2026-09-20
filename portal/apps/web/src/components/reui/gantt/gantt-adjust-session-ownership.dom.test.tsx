/**
 * #219 PR A fix (Sol re-review round 2, HIGH #3) — an Adjust session must die WITH its owner.
 * Before this fix, `internal.adjust`/`internal.drag` survived an owning event being deleted or
 * replaced from outside, or the view's date/scale changing mid-session — the stale session could
 * write over newer external state on the next Enter, and nothing ever cleared it, so a bar that
 * later remounts under the SAME occurrence key (e.g. an undone edit reverting the event to the
 * exact start the session was keyed on) could resurrect `role="application"` on mount without the
 * user ever pressing Space again.
 *
 * `gantt.tsx`'s `killAdjustSessionIfOrphaned` is the fix, called from both `setOptions`
 * (controlled `events`/`date`/`scale` props) and `setField` (the uncontrolled equivalent, which
 * never flows back through `setOptions` at all): the session's event is looked up by id in the
 * incoming events list; gone, or present under a NEW object reference (any source — a controlled
 * prop, an uncontrolled `api.*` mutator, or a consumer's own `onEventUpdate` racing this session),
 * or the date/scale changed — any of those clears `adjust` AND `drag` together, atomically.
 *
 * Announcing this teardown originally lived on `gantt-bar.tsx` as a per-bar effect gated on a
 * `localTeardownRef` set immediately before every LOCAL cancel/commit call. Round 3 (Sol HIGH #5)
 * moved it to `gantt.tsx`'s `<Gantt>` root instead — a per-bar effect can only announce when ITS
 * OWN bar survives the teardown (a replaced resource/timing, or a date/scale change: same
 * occurrence key, same bar node), and a DELETED event's bar unmounts before any such effect could
 * ever fire. `<Gantt>` now subscribes to a `getAdjustCancelledVersion()` counter that `cancelAdjust`
 * and `killAdjustSessionIfOrphaned` bump (never `commitAdjust` — see that method's own doc comment
 * for why), so the "exactly once, never over a different message" guarantee no longer needs a
 * per-bar ref at all: a successful commit's own distinct message simply never bumps the counter the
 * root is watching, and every CANCELLED-outcome path — local (blur/Escape/pointerdown-elsewhere/a
 * pointer gesture starting mid-session) or external (deletion/replacement/date-scale-anchor
 * changes) — now announces through the same single place.
 *
 * Round 3 fix (Sol's round-3 review, HIGH #3): `killAdjustSessionIfOrphaned` used to compare
 * `stillPresent !== session.occurrence.event` — OBJECT IDENTITY, not value. A controlled consumer
 * produces a fresh `events` array (and fresh event objects) on every render as a matter of course,
 * so a harmless clone — or a title/colour-only edit — orphaned the session even though nothing
 * about the SCHEDULE changed. This file used to bless that as correct (the "controlled: replacing
 * the events prop..." test below, now rewritten). The fix compares the tracked fields
 * (`start`/`end`/`allDay`/`resourceId`/`recurrence`), snapshotted from `session.occurrence.event`
 * at `beginAdjust` (never updated by a retarget — see `GanttAdjustState`'s own doc comment), against
 * the CURRENT event with the same id: the session dies only when one of those actually differs, the
 * event is gone, or the date/scale changed. The two "edge locks are checked" tests in
 * `gantt-adjust-internals.dom.test.tsx` used to pass VACUOUSLY under the old identity check (their
 * own `api.updateEvent(event.id, { draggable: false })` replaced the object reference and killed
 * the session before `commitAdjust` ever reached the lock re-validation they claim to exercise) —
 * both now assert Adjust is still active immediately before Enter, proving the lock check itself is
 * what refuses the commit.
 *
 * Store-level tests below use `gantt-adjust-internals.dom.test.tsx`'s own `setup`/`occurrenceOf`
 * pattern (uncontrolled `defaultEvents`, `internals`/`getState`/`api` grabbed via a probe). Bar-
 * level tests use `gantt-bar-adjust-keyboard.dom.test.tsx`'s own `KeyedBarHost` pattern (mirrors
 * `gantt-view.tsx`'s own `<div key={segment.occurrence.key}><GanttBar .../></div>`), because
 * "restore role" and "announce once" are only observable through the real DOM/render cycle.
 */
import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Gantt,
  useGantt,
  useGanttSelector,
  useGanttState,
  type GanttApi,
  type GanttInternals,
} from "@/components/reui/gantt/gantt";
import { GanttBar } from "@/components/reui/gantt/gantt-bar";
import type { GanttEvent, GanttOccurrence, GanttProposedUpdate, GanttSegment } from "@/components/reui/gantt/gantt-types";

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(value: ReactNode) {
  await act(async () => {
    root!.render(value);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function keydown(el: HTMLElement, init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    el.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

async function focusBar(el: HTMLElement) {
  await act(async () => {
    el.focus();
    await Promise.resolve();
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
      await Promise.resolve();
    });
  }
  root = null;
  host.remove();
});

const START = new Date("2026-03-02T09:00:00.000Z");
const END = new Date("2026-03-02T10:00:00.000Z"); // 1 hour

function occurrenceOf(event: GanttEvent): GanttOccurrence {
  return {
    key: `${event.id}::${event.start.toISOString()}`,
    eventId: event.id,
    event,
    start: event.start,
    end: event.end,
    allDay: event.allDay ?? false,
    isRecurring: false,
  };
}

/** Grabs `instance.internals`, `instance.getState`, and `instance.api` onto refs a test can call directly. */
function InternalsProbe({
  internalsRef,
  getStateRef,
  apiRef,
}: {
  internalsRef: { current: GanttInternals | null };
  getStateRef: { current: (() => ReturnType<ReturnType<typeof useGantt>["getState"]>) | null };
  apiRef: { current: GanttApi | null };
}) {
  const instance = useGantt();
  useEffect(() => {
    internalsRef.current = instance.internals;
    getStateRef.current = instance.getState;
    apiRef.current = instance.api;
  });
  return null;
}

async function setup(props: Record<string, unknown> = {}, event?: GanttEvent) {
  const theEvent = event ?? { id: "own-1", title: "Owned", start: START, end: END };
  const internalsRef: { current: GanttInternals | null } = { current: null };
  const getStateRef: {
    current: (() => ReturnType<ReturnType<typeof useGantt>["getState"]>) | null;
  } = { current: null };
  const apiRef: { current: GanttApi | null } = { current: null };
  // Uncontrolled (`defaultEvents`) — the uncontrolled-mode tests below mutate `events`/`date`/
  // `scale` via `api.*` calls and need those mutations to actually land on internal state, which
  // a controlled `events`/`date`/`scale` prop never does (see `gantt.tsx`'s `setField`).
  await render(
    <Gantt defaultEvents={[theEvent]} date={START} timeZone="UTC" {...props}>
      <InternalsProbe internalsRef={internalsRef} getStateRef={getStateRef} apiRef={apiRef} />
    </Gantt>,
  );
  return { internals: internalsRef.current!, getState: getStateRef.current!, api: apiRef.current!, event: theEvent };
}

describe("Adjust session dies with its owner — store level (Sol re-review round 2, HIGH #3)", () => {
  it("uncontrolled: deleting the owning event mid-session clears BOTH adjust and drag, atomically", async () => {
    const { internals, getState, api, event } = await setup();
    const occurrence = occurrenceOf(event);
    await act(async () => {
      internals.beginAdjust(event.id, occurrence, "move");
      internals.stepAdjust(1, "snap"); // drives state.drag too — must die WITH adjust, not separately
    });
    expect(getState().adjust).not.toBeNull();
    expect(getState().drag).not.toBeNull();
    await act(async () => {
      api.removeEvent(event.id);
    });
    const state = getState();
    expect(state.adjust).toBeNull();
    expect(state.drag).toBeNull();
  });

  it("uncontrolled: the owning event's timing replaced from outside mid-session clears the session", async () => {
    const { internals, getState, api, event } = await setup();
    const occurrence = occurrenceOf(event);
    await act(async () => {
      internals.beginAdjust(event.id, occurrence, "move");
    });
    await act(async () => {
      // No onEventUpdate registered — updateEvent's timing branch falls straight to the plain
      // setField("events", ...) path, still a NEW event object under the same id.
      api.updateEvent(event.id, { start: new Date(START.getTime() + 3600000), end: new Date(END.getTime() + 3600000) });
    });
    expect(getState().adjust).toBeNull();
  });

  it("uncontrolled: the owning event's resource replaced from outside mid-session clears the session (not just start/end)", async () => {
    const event: GanttEvent = { id: "own-resource", title: "Owned Resource", start: START, end: END, resourceId: "r1" };
    const { internals, getState, api } = await setup({}, event);
    const occurrence = occurrenceOf(event);
    await act(async () => {
      internals.beginAdjust(event.id, occurrence, "move");
    });
    await act(async () => {
      api.updateEvent(event.id, { resourceId: "r2" }); // non-timing patch — a different code path in updateEvent
    });
    expect(getState().adjust).toBeNull();
  });

  it("uncontrolled: navigating the view date mid-session clears the session", async () => {
    // `date` genuinely uncontrolled (`defaultDate`, not `date`) — `setup()`'s own controlled
    // `date={START}` prop (needed by every OTHER test in this file, and inherited from
    // `gantt-adjust-internals.dom.test.tsx`'s identical `setup()`) would make `api.goTo` a no-op
    // with no `onDateChange` registered, exercising nothing.
    const event: GanttEvent = { id: "own-date-nav", title: "Owned Date Nav", start: START, end: END };
    const internalsRef: { current: GanttInternals | null } = { current: null };
    const getStateRef: {
      current: (() => ReturnType<ReturnType<typeof useGantt>["getState"]>) | null;
    } = { current: null };
    const apiRef: { current: GanttApi | null } = { current: null };
    await render(
      <Gantt defaultEvents={[event]} defaultDate={START} timeZone="UTC">
        <InternalsProbe internalsRef={internalsRef} getStateRef={getStateRef} apiRef={apiRef} />
      </Gantt>,
    );
    const internals = internalsRef.current!;
    const getState = getStateRef.current!;
    const api = apiRef.current!;
    const occurrence = occurrenceOf(event);
    await act(async () => {
      internals.beginAdjust(event.id, occurrence, "move");
      internals.stepAdjust(1, "snap");
    });
    expect(getState().adjust).not.toBeNull();
    await act(async () => {
      api.goTo(new Date(START.getTime() + 24 * 3600000));
    });
    const state = getState();
    expect(state.adjust).toBeNull();
    expect(state.drag).toBeNull();
  });

  it("round 3, Sol HIGH #4a: extendRange sliding the anchor clears the session; growing the loaded window (anchor unchanged) does NOT", async () => {
    // `internals.extendRange` grows `rangeWindow` by whole periods until `maxRangeWindow` (here 0,
    // so the cap floors to 1 - see gantt.tsx's `Math.max(1, settings.maxRangeWindow ?? ...)`); once
    // at capacity, it SLIDES the anchor date one period instead. Only the slide changes the anchor
    // - see gantt.tsx's own `extendRange` for why a pure window grow must leave an active session
    // alone (its occurrence/preview mapping is untouched).
    const event: GanttEvent = { id: "own-extend", title: "Owned Extend", start: START, end: END };
    const internalsRef: { current: GanttInternals | null } = { current: null };
    const getStateRef: {
      current: (() => ReturnType<ReturnType<typeof useGantt>["getState"]>) | null;
    } = { current: null };
    await render(
      <Gantt defaultEvents={[event]} defaultDate={START} timeZone="UTC" maxRangeWindow={0}>
        <InternalsProbe internalsRef={internalsRef} getStateRef={getStateRef} apiRef={{ current: null }} />
      </Gantt>,
    );
    const internals = internalsRef.current!;
    const getState = getStateRef.current!;
    const occurrence = occurrenceOf(event);
    await act(async () => {
      internals.beginAdjust(event.id, occurrence, "move");
      internals.stepAdjust(1, "snap");
    });
    expect(getState().adjust).not.toBeNull();

    // First call GROWS the window (0 -> 1, the floor-1 cap) - the anchor does not move.
    await act(async () => {
      internals.extendRange("after");
    });
    expect(internals.didAnchorSlide()).toBe(false);
    expect(getState().adjust).not.toBeNull();

    // Second call is AT capacity - the anchor SLIDES instead, which must kill the session.
    await act(async () => {
      internals.extendRange("after");
    });
    expect(internals.didAnchorSlide()).toBe(true);
    const state = getState();
    expect(state.adjust).toBeNull();
    expect(state.drag).toBeNull();
  });

  it("uncontrolled: changing the view scale mid-session clears the session", async () => {
    const { internals, getState, api, event } = await setup();
    const occurrence = occurrenceOf(event);
    await act(async () => {
      internals.beginAdjust(event.id, occurrence, "move");
      internals.stepAdjust(1, "snap");
    });
    await act(async () => {
      api.setScale("week");
    });
    const state = getState();
    expect(state.adjust).toBeNull();
    expect(state.drag).toBeNull();
  });

  it("does NOT clear an active session when an UNRELATED event changes (no false-positive)", async () => {
    const owned: GanttEvent = { id: "own-safe", title: "Owned Safe", start: START, end: END };
    const other: GanttEvent = { id: "other-1", title: "Other", start: START, end: END };
    const internalsRef: { current: GanttInternals | null } = { current: null };
    const getStateRef: {
      current: (() => ReturnType<ReturnType<typeof useGantt>["getState"]>) | null;
    } = { current: null };
    const apiRef: { current: GanttApi | null } = { current: null };
    await render(
      <Gantt defaultEvents={[owned, other]} date={START} timeZone="UTC">
        <InternalsProbe internalsRef={internalsRef} getStateRef={getStateRef} apiRef={apiRef} />
      </Gantt>,
    );
    const internals = internalsRef.current!;
    const getState = getStateRef.current!;
    const api = apiRef.current!;
    const occurrence = occurrenceOf(owned);
    await act(async () => {
      internals.beginAdjust(owned.id, occurrence, "move");
      internals.stepAdjust(1, "snap");
    });
    await act(async () => {
      api.updateEvent(other.id, { title: "Other Renamed" });
    });
    const state = getState();
    expect(state.adjust).not.toBeNull();
    expect(state.adjust!.eventId).toBe(owned.id);
    expect(state.drag).not.toBeNull();
  });

  it("round 4, Sol HIGH: an in-place mutation of the SAME event object (not a new object reference) still cancels the session; an in-place title-only mutation does not", async () => {
    // `owner = session.occurrence.event` (pre-fix) aliased the mutable event: `stillPresent` -
    // found by id in `nextEvents` - is the LITERAL SAME object for an untouched entry (see the
    // "UNRELATED event" test above), so comparing `stillPresent.start` against
    // `session.occurrence.event.start` was comparing the SAME reference to itself, whatever
    // `owned.start`/`owned.end` were reassigned to in the meantime. The fix snapshots immutable
    // `startMs`/`endMs`/`allDay`/`resourceId`/`recurring` at `beginAdjust` instead - see
    // `GanttAdjustState.ownerSnapshot`'s own doc comment.
    const owned: GanttEvent = { id: "own-mutate", title: "Mutate Me", start: START, end: END };
    const other: GanttEvent = { id: "other-mutate", title: "Other", start: START, end: END };
    const internalsRef: { current: GanttInternals | null } = { current: null };
    const getStateRef: {
      current: (() => ReturnType<ReturnType<typeof useGantt>["getState"]>) | null;
    } = { current: null };
    const apiRef: { current: GanttApi | null } = { current: null };
    await render(
      <Gantt defaultEvents={[owned, other]} date={START} timeZone="UTC">
        <InternalsProbe internalsRef={internalsRef} getStateRef={getStateRef} apiRef={apiRef} />
      </Gantt>,
    );
    const internals = internalsRef.current!;
    const getState = getStateRef.current!;
    const api = apiRef.current!;
    const occurrence = occurrenceOf(owned);
    await act(async () => {
      internals.beginAdjust(owned.id, occurrence, "move");
      internals.stepAdjust(1, "snap");
    });
    expect(getState().adjust).not.toBeNull();
    const versionBeforeTitleMutation = internals.getAdjustCancelledVersion();

    // Title-only in-place mutation on the SAME object - no tracked field touched. The raw
    // mutation itself calls nothing; an unrelated `api.updateEvent` is what actually invokes
    // `killAdjustSessionIfOrphaned` (setField("events", ...) - see gantt.tsx).
    owned.title = "Mutate Me (renamed)";
    await act(async () => {
      api.updateEvent(other.id, { title: "Other renamed" });
    });
    expect(getState().adjust).not.toBeNull();
    expect(internals.getAdjustCancelledVersion()).toBe(versionBeforeTitleMutation);

    // A SCHEDULE mutation, still on the SAME object reference (never replaced) - this is what the
    // pre-fix identity-aliased comparison could never detect.
    owned.start = new Date(owned.start.getTime() + 3600000);
    owned.end = new Date(owned.end.getTime() + 3600000);
    await act(async () => {
      api.updateEvent(other.id, { title: "Other renamed again" });
    });
    const state = getState();
    expect(state.adjust).toBeNull();
    expect(state.drag).toBeNull();
    expect(internals.getAdjustCancelledVersion()).toBe(versionBeforeTitleMutation + 1);
  });

  it("commitAdjust's own write (the session's own event, cleared BEFORE the write per gantt.tsx) never self-triggers this teardown", async () => {
    // Regression guard: killAdjustSessionIfOrphaned fires from setField, which applyProposedUpdate
    // calls as part of a normal commit — if internal.adjust were still set at that point, a
    // commit would spuriously "orphan" its OWN in-flight session. gantt.tsx's commitAdjust already
    // clears internal.adjust before calling applyProposedUpdate; this pins that ordering.
    const onEventUpdate = vi.fn((_u: GanttProposedUpdate) => true);
    const { internals, getState, event } = await setup({ onEventUpdate });
    const occurrence = occurrenceOf(event);
    await act(async () => {
      internals.beginAdjust(event.id, occurrence, "move");
      internals.stepAdjust(1, "snap");
    });
    let result: ReturnType<GanttInternals["commitAdjust"]>;
    await act(async () => {
      result = internals.commitAdjust();
    });
    expect(result!.committed).toBe(true);
    expect(getState().adjust).toBeNull();
  });

  it("round 3, Sol HIGH #3: controlled — a harmless clone from the parent (same start/end/allDay/resourceId, different title) does NOT clear the session", async () => {
    // This corrects a WRONG expectation this test used to bless (round 2): it asserted a
    // controlled clone that only changed `title` cleared the session, because
    // killAdjustSessionIfOrphaned used to compare OBJECT IDENTITY
    // (`stillPresent !== session.occurrence.event`) — any new object reference for the same id
    // orphaned the session, even one carrying IDENTICAL start/end/allDay/resourceId. That is wrong:
    // a controlled consumer produces a fresh `events` array (and fresh event objects) on every
    // render as a matter of course (`{...event, title: "..."}`, a Redux/Zustand selector, …) — none
    // of that should cancel an in-progress keyboard Adjust session. The fix compares the tracked
    // FIELDS (start/end/allDay/resourceId/recurrence), snapshotted from `session.occurrence.event`
    // at `beginAdjust` — see `gantt.tsx`'s `killAdjustSessionIfOrphaned` for the real check, and the
    // next test below for the genuine-change case this one is deliberately NOT testing.
    const event: GanttEvent = { id: "ctrl-own-1", title: "Ctrl Owned", start: START, end: END };
    const internalsRef: { current: GanttInternals | null } = { current: null };
    const getStateRef: {
      current: (() => ReturnType<ReturnType<typeof useGantt>["getState"]>) | null;
    } = { current: null };
    function ControlledHost({ events }: { events: GanttEvent[] }) {
      return (
        <Gantt events={events} date={START} timeZone="UTC">
          <InternalsProbe internalsRef={internalsRef} getStateRef={getStateRef} apiRef={{ current: null }} />
        </Gantt>
      );
    }
    await render(<ControlledHost events={[event]} />);
    const internals = internalsRef.current!;
    const getState = getStateRef.current!;
    const occurrence = occurrenceOf(event);
    await act(async () => {
      internals.beginAdjust(event.id, occurrence, "move");
      internals.stepAdjust(1, "snap");
    });
    expect(getState().adjust).not.toBeNull();
    const dragBeforeClone = getState().drag;

    // The PARENT re-renders with a new events array carrying a NEW object reference for this id —
    // the controlled-mode path (`setOptions`), never `setField` — but every tracked field is
    // unchanged.
    const clone: GanttEvent = { ...event, title: "Ctrl Owned (edited)" };
    await render(<ControlledHost events={[clone]} />);

    const state = getState();
    expect(state.adjust).not.toBeNull();
    expect(state.adjust!.eventId).toBe(event.id);
    expect(state.drag).toBe(dragBeforeClone);
  });

  it("controlled: a GENUINE timing/resource change from the parent still clears the session (store level, via a real controlled re-render)", async () => {
    const event: GanttEvent = { id: "ctrl-own-2", title: "Ctrl Owned 2", start: START, end: END, resourceId: "r1" };
    const internalsRef: { current: GanttInternals | null } = { current: null };
    const getStateRef: {
      current: (() => ReturnType<ReturnType<typeof useGantt>["getState"]>) | null;
    } = { current: null };
    function ControlledHost({ events }: { events: GanttEvent[] }) {
      return (
        <Gantt events={events} date={START} timeZone="UTC">
          <InternalsProbe internalsRef={internalsRef} getStateRef={getStateRef} apiRef={{ current: null }} />
        </Gantt>
      );
    }
    await render(<ControlledHost events={[event]} />);
    const internals = internalsRef.current!;
    const getState = getStateRef.current!;
    const occurrence = occurrenceOf(event);
    await act(async () => {
      internals.beginAdjust(event.id, occurrence, "move");
      internals.stepAdjust(1, "snap");
    });
    expect(getState().adjust).not.toBeNull();

    // A REAL timing change this time — the controlled-mode path (`setOptions`) must still catch it.
    const replaced: GanttEvent = {
      ...event,
      start: new Date(START.getTime() + 3600000),
      end: new Date(END.getTime() + 3600000),
    };
    await render(<ControlledHost events={[replaced]} />);

    const state = getState();
    expect(state.adjust).toBeNull();
    expect(state.drag).toBeNull();
  });

  it("controlled: a parent-driven date change mid-session clears the session (store level)", async () => {
    const event: GanttEvent = { id: "ctrl-own-date", title: "Ctrl Owned Date", start: START, end: END };
    const internalsRef: { current: GanttInternals | null } = { current: null };
    const getStateRef: {
      current: (() => ReturnType<ReturnType<typeof useGantt>["getState"]>) | null;
    } = { current: null };
    function ControlledHost({ date }: { date: Date }) {
      return (
        <Gantt events={[event]} date={date} timeZone="UTC">
          <InternalsProbe internalsRef={internalsRef} getStateRef={getStateRef} apiRef={{ current: null }} />
        </Gantt>
      );
    }
    await render(<ControlledHost date={START} />);
    const internals = internalsRef.current!;
    const getState = getStateRef.current!;
    const occurrence = occurrenceOf(event);
    await act(async () => {
      internals.beginAdjust(event.id, occurrence, "move");
      internals.stepAdjust(1, "snap");
    });
    expect(getState().adjust).not.toBeNull();

    await render(<ControlledHost date={new Date(START.getTime() + 24 * 3600000)} />);

    const state = getState();
    expect(state.adjust).toBeNull();
    expect(state.drag).toBeNull();
  });
});

describe("Adjust session dies with its owner — DOM level (role restore + announce-once)", () => {
  /** Reproduces gantt-view.tsx's own `<div key={segment.occurrence.key}><GanttBar .../></div>`. */
  function KeyedBarHost({ eventId }: { eventId: string }) {
    const instance = useGantt();
    const occurrence = useGanttSelector(
      () => instance.api.getOccurrences().find((occ) => occ.eventId === eventId) ?? null,
    );
    if (!occurrence) return null;
    const segment: GanttSegment = {
      occurrence,
      day: occurrence.start,
      isStart: true,
      isEnd: true,
      continuesBefore: false,
      continuesAfter: false,
    };
    return (
      <div key={occurrence.key}>
        <GanttBar segment={segment} />
      </div>
    );
  }

  function findBar(host_: HTMLElement, title: string): HTMLButtonElement | undefined {
    return [...host_.querySelectorAll("button")].find((el) => el.textContent?.includes(title));
  }

  function announcerText(host_: HTMLElement): string | null {
    return host_.querySelector<HTMLElement>('[aria-live="polite"]')?.textContent ?? null;
  }

  it("controlled: deleting the owning event mid-session unmounts the bar; the SAME occurrence key returning later does NOT resurrect role=application", async () => {
    function DeleteHost({ setEventsRef }: { setEventsRef: { current: ((v: GanttEvent[]) => void) | null } }) {
      const [events, setEvents] = useState<GanttEvent[]>([
        { id: "res-1", title: "Resurrect Me", start: START, end: END },
      ]);
      useEffect(() => {
        setEventsRef.current = setEvents;
      }, []);
      return (
        <Gantt events={events} onEventsChange={setEvents} date={START} timeZone="UTC">
          <KeyedBarHost eventId="res-1" />
        </Gantt>
      );
    }
    const setEventsRef: { current: ((v: GanttEvent[]) => void) | null } = { current: null };
    await render(<DeleteHost setEventsRef={setEventsRef} />);
    const bar = findBar(host, "Resurrect Me")!;
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "ArrowRight" });
    expect(bar.getAttribute("data-adjusting")).not.toBeNull();

    // Deleted from outside — this bar disappears with it (gantt-view.tsx would drop the segment
    // the same way KeyedBarHost does above).
    await act(async () => {
      setEventsRef.current!([]);
      await Promise.resolve();
    });
    expect(findBar(host, "Resurrect Me")).toBeUndefined();

    // The exact same occurrence (same id, same start -> same occurrence.key) comes back, e.g. an
    // undo. Before the fix, `internal.adjust` was never cleared on deletion, so this fresh mount
    // would have matched the stale session and rendered role="application" with no Space pressed.
    const revivedEvent: GanttEvent = { id: "res-1", title: "Resurrect Me", start: START, end: END };
    await act(async () => {
      setEventsRef.current!([revivedEvent]);
      await Promise.resolve();
    });
    const revived = findBar(host, "Resurrect Me")!;
    expect(revived).toBeTruthy();
    expect(revived.getAttribute("role")).not.toBe("application");
    expect(revived.getAttribute("data-adjusting")).toBeNull();
  });

  it("round 3, Sol HIGH #5: deleting the owning event mid-session announces cancellation exactly once, from the still-mounted Gantt root, even though the bar itself unmounts", async () => {
    // Before the fix, the ONLY owner-death announcer lived on the bar being torn down — deletion
    // unmounts that exact bar before its own effect could ever observe the `adjusting` true ->
    // false transition, so cancellation went unannounced. The announcer div lives on `<Gantt>`
    // itself (`data-slot="gantt-announcer"`, rendered as a sibling of children, not inside any
    // bar), so it survives the deleted bar's unmount and is where the announcement now has to
    // come from.
    function DeleteHost({ setEventsRef }: { setEventsRef: { current: ((v: GanttEvent[]) => void) | null } }) {
      const [events, setEvents] = useState<GanttEvent[]>([
        { id: "del-announce", title: "Delete Announce", start: START, end: END },
      ]);
      useEffect(() => {
        setEventsRef.current = setEvents;
      }, []);
      return (
        <Gantt events={events} onEventsChange={setEvents} date={START} timeZone="UTC">
          <KeyedBarHost eventId="del-announce" />
        </Gantt>
      );
    }
    const setEventsRef: { current: ((v: GanttEvent[]) => void) | null } = { current: null };
    await render(<DeleteHost setEventsRef={setEventsRef} />);
    const bar = findBar(host, "Delete Announce")!;
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "ArrowRight" });
    expect(bar.getAttribute("data-adjusting")).not.toBeNull();
    expect(announcerText(host)).not.toBe("Adjustment cancelled.");

    await act(async () => {
      setEventsRef.current!([]);
      await Promise.resolve();
    });
    expect(findBar(host, "Delete Announce")).toBeUndefined();
    expect(announcerText(host)).toBe("Adjustment cancelled.");

    // Exactly once: a further notify with no NEW teardown (the session is already gone, so
    // `killAdjustSessionIfOrphaned` returns false and never bumps the version again) must not
    // re-announce. A naive "session is null -> always announce" implementation would fail this.
    await act(async () => {
      setEventsRef.current!([]);
      await Promise.resolve();
    });
    expect(announcerText(host)).toBe("Adjustment cancelled.");
  });

  it("controlled: replacing the owning event's resource mid-session (same occurrence key — the bar stays mounted) restores role/data-adjusting and announces cancellation exactly once", async () => {
    function ReplaceHost({ setEventsRef }: { setEventsRef: { current: ((v: GanttEvent[]) => void) | null } }) {
      const [events, setEvents] = useState<GanttEvent[]>([
        { id: "repl-1", title: "Replace Me", start: START, end: END, resourceId: "r1" },
      ]);
      useEffect(() => {
        setEventsRef.current = setEvents;
      }, []);
      return (
        <Gantt events={events} onEventsChange={setEvents} date={START} timeZone="UTC">
          <KeyedBarHost eventId="repl-1" />
        </Gantt>
      );
    }
    const setEventsRef: { current: ((v: GanttEvent[]) => void) | null } = { current: null };
    await render(<ReplaceHost setEventsRef={setEventsRef} />);
    const bar = findBar(host, "Replace Me")!;
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "ArrowRight" });
    expect(bar.getAttribute("role")).toBe("application");
    expect(bar.getAttribute("data-adjusting")).not.toBeNull();

    await act(async () => {
      setEventsRef.current!([
        { id: "repl-1", title: "Replace Me", start: START, end: END, resourceId: "r2" },
      ]);
      await Promise.resolve();
    });

    // Same occurrence key (id + start unchanged) — the SAME bar node stays mounted; this is what
    // makes the announcement directly observable (a deleted/remounted bar has nothing to announce
    // into, which is why the previous test only checks the STORE and the resurrection guard).
    const stillSameBar = findBar(host, "Replace Me");
    expect(stillSameBar).toBe(bar);
    expect(bar.getAttribute("role")).not.toBe("application");
    expect(bar.getAttribute("data-adjusting")).toBeNull();
    expect(announcerText(host)).toBe("Adjustment cancelled.");
  });

  it("uncontrolled: changing the view scale mid-session (same occurrence key stays mounted) restores role/data-adjusting and announces cancellation exactly once", async () => {
    const event: GanttEvent = { id: "scale-1", title: "Scale Me", start: START, end: END };
    const apiRef: { current: GanttApi | null } = { current: null };
    const internalsRef: { current: GanttInternals | null } = { current: null };
    const getStateRef: {
      current: (() => ReturnType<ReturnType<typeof useGantt>["getState"]>) | null;
    } = { current: null };
    await render(
      <Gantt defaultEvents={[event]} date={START} timeZone="UTC">
        <InternalsProbe internalsRef={internalsRef} getStateRef={getStateRef} apiRef={apiRef} />
        <KeyedBarHost eventId="scale-1" />
      </Gantt>,
    );
    const bar = findBar(host, "Scale Me")!;
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "ArrowRight" });
    expect(bar.getAttribute("data-adjusting")).not.toBeNull();

    await act(async () => {
      apiRef.current!.setScale("week");
      await Promise.resolve();
    });

    expect(findBar(host, "Scale Me")).toBe(bar); // same occurrence key -> same bar node
    expect(bar.getAttribute("role")).not.toBe("application");
    expect(bar.getAttribute("data-adjusting")).toBeNull();
    expect(announcerText(host)).toBe("Adjustment cancelled.");
  });

  it("a LOCAL commit is never double-announced by the root's owner-death announcer (round 3, Sol HIGH #5 — regression guard, moved from a `localTeardownRef` ref to the getAdjustCancelledVersion counter)", async () => {
    const onEventsChange = vi.fn();
    const event: GanttEvent = { id: "local-commit", title: "Local Commit", start: START, end: END };
    await render(
      <Gantt events={[event]} onEventsChange={onEventsChange} date={START} timeZone="UTC">
        <KeyedBarHost eventId="local-commit" />
      </Gantt>,
    );
    const bar = findBar(host, "Local Commit")!;
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "ArrowRight" });
    await keydown(bar, { key: "Enter" });
    // The commit's OWN success message must survive — not overwritten by "Adjustment cancelled."
    // from the root's owner-death effect reacting to the SAME true -> false `adjusting` transition.
    // `commitAdjust` clears `internal.adjust` directly, BEFORE its own write, through neither
    // `cancelAdjust` nor `killAdjustSessionIfOrphaned` (the only two things that bump
    // `getAdjustCancelledVersion`) — see that method's own doc comment.
    expect(announcerText(host)).toContain("Adjusted to");
    expect(announcerText(host)).not.toBe("Adjustment cancelled.");
  });

  it("round 3, Sol HIGH #4b: a hoisted calendar does not retain Adjust across <Gantt> unmount/remount", async () => {
    // `useGanttState` called in a PARENT that outlives `<Gantt calendar={...}>` - the "hoisted"
    // pattern `gantt.tsx`'s own `GanttProps.calendar` doc comment describes. `HoistedHost` itself
    // never unmounts across the three `render()` calls below (only its `mounted` prop changes, and
    // it is the SAME component instance both times), so React preserves the `useGanttState` store
    // untouched - the store, not the `<Gantt>` root, is what "hoisted" means here.
    const event: GanttEvent = { id: "hoisted-1", title: "Hoisted", start: START, end: END };
    function HoistedHost({ mounted }: { mounted: boolean }) {
      const calendar = useGanttState<unknown>({
        defaultEvents: [event],
        defaultDate: START,
        timeZone: "UTC",
      });
      if (!mounted) return null;
      return (
        <Gantt calendar={calendar}>
          <KeyedBarHost eventId={event.id} />
        </Gantt>
      );
    }
    await render(<HoistedHost mounted={true} />);
    const bar = findBar(host, "Hoisted")!;
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "ArrowRight" });
    expect(bar.getAttribute("role")).toBe("application");
    expect(bar.getAttribute("data-adjusting")).not.toBeNull();

    // Unmount the <Gantt> ROOT — before the fix, nothing ever cleared the hoisted instance's
    // `internal.adjust`/`internal.drag`, so it survived this gap untouched.
    await render(<HoistedHost mounted={false} />);
    expect(host.querySelector("button")).toBeNull();

    // Remount with the SAME hoisted `calendar` instance (same store, same occurrence key). Before
    // the fix, the stale session would resurrect `role="application"`/`data-adjusting`/the ghost
    // on this fresh bar node with no Space ever pressed on this mount.
    await render(<HoistedHost mounted={true} />);
    const revived = findBar(host, "Hoisted")!;
    expect(revived).toBeTruthy();
    expect(revived.getAttribute("role")).not.toBe("application");
    expect(revived.getAttribute("data-adjusting")).toBeNull();
    expect(host.querySelector('[data-testid="gantt-drag-ghost"]')).toBeNull();
  });
});
