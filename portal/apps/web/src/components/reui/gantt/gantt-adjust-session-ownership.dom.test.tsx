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
 * `gantt-bar.tsx`'s own new effect (gated on `localTeardownRef`, set immediately before every
 * LOCAL cancel/commit call this file already had) announces the cancellation exactly once when
 * the session dies with NO local handler in the loop — never re-announcing "cancelled" over a
 * cancel/commit branch's own message (the same stale-overwrite race the file's header already
 * documents for blur).
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
import { Gantt, useGantt, useGanttSelector, type GanttApi, type GanttInternals } from "@/components/reui/gantt/gantt";
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

  it("controlled: replacing the events prop from the parent mid-session clears the session (store level, via a real controlled re-render)", async () => {
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

    // The PARENT re-renders with a new events array carrying a replaced object for this id — the
    // controlled-mode path (`setOptions`), never `setField`.
    const replaced: GanttEvent = { ...event, title: "Ctrl Owned (edited)" };
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

  it("a LOCAL commit is never double-announced by the owner-death effect (regression guard on localTeardownRef)", async () => {
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
    // from the new owner-death effect reacting to the SAME true -> false `adjusting` transition.
    expect(announcerText(host)).toContain("Adjusted to");
    expect(announcerText(host)).not.toBe("Adjustment cancelled.");
  });
});
