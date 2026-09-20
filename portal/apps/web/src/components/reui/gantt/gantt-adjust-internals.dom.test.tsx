/**
 * #219 PR A (Adjust mode) — `gantt.tsx`'s new `GanttInternals` methods (`beginAdjust`/
 * `stepAdjust`/`retargetAdjust`/`commitAdjust`/`cancelAdjust`) exercised directly at the store
 * level, before any bar/keyboard wiring exists. DOM suite only because `instance.internals` is
 * grabbed via a `useEffect` inside `<Gantt>` (the same pattern `gantt-bar-keyboard.dom.test.tsx`
 * uses for `claimKeyboardFocus`/`consumeKeyboardFocus`); nothing here queries the DOM.
 */
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gantt, useGantt, type GanttInternals } from "@/components/reui/gantt/gantt";
import type { GanttEvent, GanttOccurrence, GanttProposedUpdate } from "@/components/reui/gantt/gantt-types";

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

/** Grabs `instance.internals` and `instance.getState` onto refs a test can call directly. */
function InternalsProbe({
  internalsRef,
  getStateRef,
}: {
  internalsRef: { current: GanttInternals | null };
  getStateRef: { current: (() => ReturnType<ReturnType<typeof useGantt>["getState"]>) | null };
}) {
  const instance = useGantt();
  useEffect(() => {
    internalsRef.current = instance.internals;
    getStateRef.current = instance.getState;
  });
  return null;
}

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

async function setup(props: Record<string, unknown> = {}, event?: GanttEvent) {
  const theEvent = event ?? { id: "adj-1", title: "Adjust Me", start: START, end: END };
  const internalsRef: { current: GanttInternals | null } = { current: null };
  const getStateRef: {
    current: (() => ReturnType<ReturnType<typeof useGantt>["getState"]>) | null;
  } = { current: null };
  await render(
    <Gantt events={[theEvent]} date={START} timeZone="UTC" {...props}>
      <InternalsProbe internalsRef={internalsRef} getStateRef={getStateRef} />
    </Gantt>,
  );
  return { internals: internalsRef.current!, getState: getStateRef.current!, event: theEvent };
}

describe("GanttInternals Adjust-mode methods (#219 PR A)", () => {
  it("beginAdjust opens a session with entry === preview and does NOT drive state.drag", async () => {
    const { internals, getState, event } = await setup();
    const occurrence = occurrenceOf(event);
    await act(async () => {
      internals.beginAdjust(event.id, occurrence, "move");
    });
    const state = getState();
    expect(state.adjust).not.toBeNull();
    expect(state.adjust!.eventId).toBe(event.id);
    expect(state.adjust!.target).toBe("move");
    expect(state.adjust!.entry).toEqual({ start: START, end: END, allDay: false });
    expect(state.adjust!.preview).toEqual({ start: START, end: END, allDay: false });
    // No ghost yet — the committed bar's own position IS the preview until the first accepted step.
    expect(state.drag).toBeNull();
  });

  it("stepAdjust('snap') on move accumulates by the base nudge step and drives state.drag to match the preview", async () => {
    const { internals, getState, event } = await setup();
    const occurrence = occurrenceOf(event);
    await act(async () => {
      internals.beginAdjust(event.id, occurrence, "move");
    });
    let result: ReturnType<GanttInternals["stepAdjust"]>;
    await act(async () => {
      result = internals.stepAdjust(1, "snap");
    });
    expect(result!).toEqual({
      applied: true,
      start: new Date(START.getTime() + 15 * 60000),
      end: new Date(END.getTime() + 15 * 60000),
      allDay: false,
    });
    const state = getState();
    expect(state.adjust!.preview).toEqual({
      start: new Date(START.getTime() + 15 * 60000),
      end: new Date(END.getTime() + 15 * 60000),
      allDay: false,
    });
    expect(state.drag).toEqual({
      kind: "move",
      occurrence,
      proposedStart: new Date(START.getTime() + 15 * 60000),
      proposedEnd: new Date(END.getTime() + 15 * 60000),
      proposedAllDay: false,
      proposedResourceId: undefined,
      valid: true,
    });

    // A second step accumulates on the CURRENT preview, not the original entry.
    await act(async () => {
      result = internals.stepAdjust(1, "snap");
    });
    expect(result!).toEqual({
      applied: true,
      start: new Date(START.getTime() + 30 * 60000),
      end: new Date(END.getTime() + 30 * 60000),
      allDay: false,
    });
  });

  it("stepAdjust('large') at the default day scale (sub-hour snap) steps by one hour", async () => {
    const { internals, getState, event } = await setup();
    const occurrence = occurrenceOf(event);
    await act(async () => {
      internals.beginAdjust(event.id, occurrence, "move");
    });
    await act(async () => {
      internals.stepAdjust(1, "large");
    });
    const state = getState();
    // default scale is "day" -> baseNudgeStepMinutes() is the 15-minute snapDuration (< 60), so
    // resolveAdjustLargerStepMinutes maps it to one hour, per the sub-day branch of the rule.
    expect(state.adjust!.preview.start.getTime()).toBe(START.getTime() + 60 * 60000);
    expect(state.adjust!.preview.end.getTime()).toBe(END.getTime() + 60 * 60000);
  });

  it("stepAdjust('large') at a day scale with a >=60min snapDuration steps by one civil day", async () => {
    const { internals, getState, event } = await setup({ snapDuration: 60 });
    const occurrence = occurrenceOf(event);
    await act(async () => {
      internals.beginAdjust(event.id, occurrence, "move");
    });
    await act(async () => {
      internals.stepAdjust(1, "large");
    });
    const state = getState();
    expect(state.adjust!.preview.start.getTime()).toBe(START.getTime() + 24 * 60 * 60000);
    expect(state.adjust!.preview.end.getTime()).toBe(END.getTime() + 24 * 60 * 60000);
  });

  it("stepAdjust('large') at a whole-day scale (week) steps by 7 civil days", async () => {
    const { internals, getState, event } = await setup({ scale: "week" });
    const occurrence = occurrenceOf(event);
    await act(async () => {
      internals.beginAdjust(event.id, occurrence, "move");
    });
    await act(async () => {
      internals.stepAdjust(1, "large");
    });
    const state = getState();
    expect(state.adjust!.preview.start.getTime()).toBe(START.getTime() + 7 * 24 * 60 * 60000);
    expect(state.adjust!.preview.end.getTime()).toBe(END.getTime() + 7 * 24 * 60 * 60000);
  });

  it("a refused step (locked edge) leaves the preview AND state.drag untouched", async () => {
    const event: GanttEvent = {
      id: "adj-locked",
      title: "Locked",
      start: START,
      end: END,
      resizableEdges: { start: false },
    };
    const { internals, getState } = await setup({}, event);
    const occurrence = occurrenceOf(event);
    await act(async () => {
      internals.beginAdjust(event.id, occurrence, "move");
    });
    await act(async () => {
      internals.stepAdjust(1, "snap"); // moves the preview once, sets state.drag
    });
    const afterMove = getState();
    let result: ReturnType<GanttInternals["stepAdjust"]>;
    await act(async () => {
      internals.retargetAdjust("resize-start");
      result = internals.stepAdjust(-1, "snap"); // start edge is locked
    });
    expect(result!).toEqual({ applied: false, reason: "locked" });
    const afterRefusal = getState();
    expect(afterRefusal.adjust!.preview).toEqual(afterMove.adjust!.preview);
    expect(afterRefusal.drag).toEqual(afterMove.drag);
  });

  it("stepAdjust honours the shared overlap 'reject' policy (sol1 item 3's shared helper)", async () => {
    const a: GanttEvent = { id: "adj-a", title: "A", start: START, end: END, resourceId: "r1" };
    const b: GanttEvent = {
      id: "adj-b",
      title: "B",
      start: END,
      end: new Date(END.getTime() + 60 * 60000),
      resourceId: "r1",
    };
    const internalsRef: { current: GanttInternals | null } = { current: null };
    const getStateRef: {
      current: (() => ReturnType<ReturnType<typeof useGantt>["getState"]>) | null;
    } = { current: null };
    await render(
      <Gantt events={[a, b]} date={START} timeZone="UTC" overlap="reject">
        <InternalsProbe internalsRef={internalsRef} getStateRef={getStateRef} />
      </Gantt>,
    );
    const internals = internalsRef.current!;
    const getState = getStateRef.current!;
    const occurrence = occurrenceOf(a);
    await act(async () => {
      internals.beginAdjust(a.id, occurrence, "move");
    });
    let result: ReturnType<GanttInternals["stepAdjust"]>;
    await act(async () => {
      result = internals.stepAdjust(1, "snap");
    });
    expect(result!).toEqual({ applied: false, reason: "rejected" });
    expect(getState().adjust!.preview).toEqual({ start: START, end: END, allDay: false });
  });

  it("retargetAdjust switches the target and keeps the accumulated preview", async () => {
    const { internals, getState, event } = await setup();
    const occurrence = occurrenceOf(event);
    await act(async () => {
      internals.beginAdjust(event.id, occurrence, "move");
      internals.stepAdjust(1, "snap");
    });
    const movedPreview = getState().adjust!.preview;
    await act(async () => {
      internals.retargetAdjust("resize-end");
    });
    expect(getState().adjust!.target).toBe("resize-end");
    expect(getState().adjust!.preview).toEqual(movedPreview);
  });

  it("commitAdjust with a net change commits through applyProposedUpdate with source: 'keyboard', then clears the session", async () => {
    const onEventUpdate = vi.fn((_u: GanttProposedUpdate) => true);
    const onEventsChange = vi.fn();
    const { internals, getState, event } = await setup({ onEventUpdate, onEventsChange });
    const occurrence = occurrenceOf(event);
    await act(async () => {
      internals.beginAdjust(event.id, occurrence, "move");
      internals.stepAdjust(1, "snap");
    });
    let result: ReturnType<GanttInternals["commitAdjust"]>;
    await act(async () => {
      result = internals.commitAdjust();
    });
    expect(result!).toEqual({
      committed: true,
      start: new Date(START.getTime() + 15 * 60000),
      end: new Date(END.getTime() + 15 * 60000),
      allDay: false,
    });
    expect(onEventUpdate).toHaveBeenCalledTimes(1);
    const update = onEventUpdate.mock.calls[0]![0] as GanttProposedUpdate;
    expect(update.source).toBe("keyboard");
    expect(onEventsChange).toHaveBeenCalledTimes(1);
    const state = getState();
    expect(state.adjust).toBeNull();
    expect(state.drag).toBeNull();
  });

  it("commitAdjust with NO net change (no steps taken) commits nothing and reports noChange", async () => {
    const onEventUpdate = vi.fn((_u: GanttProposedUpdate) => true);
    const { internals, getState, event } = await setup({ onEventUpdate });
    const occurrence = occurrenceOf(event);
    await act(async () => {
      internals.beginAdjust(event.id, occurrence, "move");
    });
    let result: ReturnType<GanttInternals["commitAdjust"]>;
    await act(async () => {
      result = internals.commitAdjust();
    });
    expect(result!).toEqual({ committed: false, noChange: true });
    expect(onEventUpdate).not.toHaveBeenCalled();
    expect(getState().adjust).toBeNull();
  });

  it("commitAdjust with a net change that onEventUpdate rejects reports committed: false and emits nothing", async () => {
    const onEventUpdate = vi.fn((_u: GanttProposedUpdate) => false);
    const onEventsChange = vi.fn();
    const { internals, getState, event } = await setup({ onEventUpdate, onEventsChange });
    const occurrence = occurrenceOf(event);
    await act(async () => {
      internals.beginAdjust(event.id, occurrence, "move");
      internals.stepAdjust(1, "snap");
    });
    let result: ReturnType<GanttInternals["commitAdjust"]>;
    await act(async () => {
      result = internals.commitAdjust();
    });
    expect(result!).toEqual({ committed: false });
    expect(onEventsChange).not.toHaveBeenCalled();
    expect(getState().adjust).toBeNull();
  });

  it("commitAdjust with no active session is a no-op that reports committed: false", async () => {
    const { internals, getState } = await setup();
    let result: ReturnType<GanttInternals["commitAdjust"]>;
    await act(async () => {
      result = internals.commitAdjust();
    });
    expect(result!).toEqual({ committed: false });
    expect(getState().adjust).toBeNull();
  });

  it("cancelAdjust discards the preview, emits nothing, and clears the session (and any ghost)", async () => {
    const onEventUpdate = vi.fn((_u: GanttProposedUpdate) => true);
    const onEventsChange = vi.fn();
    const { internals, getState, event } = await setup({ onEventUpdate, onEventsChange });
    const occurrence = occurrenceOf(event);
    await act(async () => {
      internals.beginAdjust(event.id, occurrence, "move");
      internals.stepAdjust(1, "snap");
    });
    expect(getState().drag).not.toBeNull();
    await act(async () => {
      internals.cancelAdjust();
    });
    expect(onEventUpdate).not.toHaveBeenCalled();
    expect(onEventsChange).not.toHaveBeenCalled();
    const state = getState();
    expect(state.adjust).toBeNull();
    expect(state.drag).toBeNull();
  });

  it("cancelAdjust with no active session is a no-op", async () => {
    const { internals, getState } = await setup();
    await act(async () => {
      internals.cancelAdjust();
    });
    expect(getState().adjust).toBeNull();
  });
});
