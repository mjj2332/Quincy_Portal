/**
 * #219 PR A fix (Sol re-review round 2, HIGH #4) — pointer vs keyboard ownership of `state.drag`.
 * Before this fix, nothing stopped a keyboard Adjust session (`gantt.tsx`'s `beginAdjust`) from
 * opening WHILE a pointer gesture was pending or active (mouse down, not yet released), and each
 * of the three call sites in `gantt-bar.tsx` that cancelled Adjust on a pointer-down repeated the
 * same check independently.
 *
 * Two fixes, both centralized instead of per-call-site:
 * 1. `gantt.tsx`'s `beginAdjust` now refuses (returns `false`, opens nothing) while
 *    `gantt-lib.tsx`'s `isGanttGestureInFlight()` is true - the SAME page-wide registry
 *    `gantt-dnd.tsx`'s `beginGesture` has always populated for its own `cancelActiveGanttGestures`
 *    (relocated here so `gantt.tsx` can read it too, without a `gantt.tsx` <-> `gantt-dnd.tsx`
 *    import cycle - see that file's own header comment on the move).
 * 2. `gantt-dnd.tsx`'s `beginGesture` now cancels an active Adjust session on the SAME occurrence
 *    at its own single entry point (was three copies of the identical check in `gantt-bar.tsx`).
 *
 * Together the two rules are structurally mutually exclusive: a pointer gesture can never start
 * while Adjust is active on the SAME bar (rule 2), and Adjust can never start while a pointer
 * gesture — on ANY bar — is in flight (rule 1). `GanttDragState.source` ("pointer" | "keyboard",
 * `gantt-types.tsx`) tags which input produced a given ghost, checked defensively by
 * `gantt-dnd.tsx`'s own `onPointerUp` before it commits — belt-and-suspenders once the two rules
 * above already make the interleaving unreachable in practice.
 */
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelActiveGanttGestures,
  registerGanttGesture,
  unregisterGanttGesture,
} from "@/components/reui/gantt/gantt-lib";
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

async function pointerEvent(target: EventTarget, type: string, init: PointerEventInit) {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
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
  // Any pointer gesture this file itself started (pointerdown with no matching pointerup) must not
  // leak its window-level listeners, or the shared page-wide registry, into the NEXT test.
  cancelActiveGanttGestures();
  if (root) {
    await act(async () => {
      root!.unmount();
      await Promise.resolve();
    });
  }
  root = null;
  host.remove();
});

const START = new Date("2026-03-02T00:00:00.000Z");
const END = new Date("2026-03-02T01:00:00.000Z"); // 1 hour

/**
 * Reproduces gantt-view.tsx's own axis/row DOM (`data-gantt-axis` with its dataset range/snap,
 * `data-gantt-row`) inside a `data-slot="gantt-view"` root, plus the `[data-slot=gantt]` /
 * `[data-slot=gantt-announcer]` wrapper `gantt-bar.tsx`'s own `announce()` queries for - the
 * minimum real geometry `gantt-dnd.tsx`'s `beginGesture`/`computeProposal` needs to turn a real
 * pointer drag into a real accepted proposal. The axis rect is mocked 1px = 1 minute (`right:
 * 1440` for a 1440-minute/24-hour range) so `surfaceMinutesAt` needs no further translation.
 */
function GeometryHost({ eventId }: { eventId: string }) {
  const instance = useGantt();
  const occurrence = useGanttSelector(
    () => instance.api.getOccurrences().find((occ) => occ.eventId === eventId) ?? null,
  );
  const axisRef = (el: HTMLDivElement | null) => {
    if (!el) return;
    el.getBoundingClientRect = () =>
      ({ left: 0, right: 1440, width: 1440, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
  };
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
    <div data-slot="gantt">
      <div data-slot="gantt-announcer" aria-live="polite" />
      <div data-slot="gantt-view">
        <div
          ref={axisRef}
          data-gantt-axis=""
          data-gantt-range-start={START.getTime()}
          data-gantt-range-end={START.getTime() + 1440 * 60000}
          data-gantt-snap={15}
        />
        <div data-gantt-row="" data-gantt-resource="r1">
          <div key={occurrence.key}>
            <GanttBar segment={segment} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Grabs `instance.internals`/`getState`/`api` onto refs a test can call directly. */
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

function findBar(title: string): HTMLButtonElement {
  const bar = [...host.querySelectorAll("button")].find((el) => el.textContent?.includes(title));
  if (!bar) throw new Error(`no bar found for title ${title}`);
  return bar;
}

function announcerText(): string | null {
  return host.querySelector<HTMLElement>('[aria-live="polite"]')?.textContent ?? null;
}

describe("beginAdjust refuses while a pointer gesture is pending or active (Sol re-review round 2, HIGH #4)", () => {
  it("refuses while ANY gantt pointer gesture, anywhere on the page, is registered in flight", async () => {
    const event: GanttEvent = { id: "own-1", title: "Owned", start: START, end: END };
    const internalsRef: { current: GanttInternals | null } = { current: null };
    const getStateRef: {
      current: (() => ReturnType<ReturnType<typeof useGantt>["getState"]>) | null;
    } = { current: null };
    const apiRef: { current: GanttApi | null } = { current: null };
    await render(
      <Gantt defaultEvents={[event]} date={START} timeZone="UTC">
        <InternalsProbe internalsRef={internalsRef} getStateRef={getStateRef} apiRef={apiRef} />
      </Gantt>,
    );
    const internals = internalsRef.current!;
    const getState = getStateRef.current!;
    const occurrence = occurrenceOf(event);

    // A "pending" gesture: registered the moment beginGesture starts, BEFORE it ever activates
    // (moves past the 5px threshold) - the fake cancel below stands in for that registration.
    const fakeCancel = vi.fn();
    registerGanttGesture(fakeCancel);
    let entered: boolean | undefined;
    await act(async () => {
      entered = internals.beginAdjust(event.id, occurrence, "move");
    });
    expect(entered).toBe(false);
    expect(getState().adjust).toBeNull();

    // The gesture ends (pointerup/pointercancel) - beginAdjust succeeds again.
    unregisterGanttGesture(fakeCancel);
    await act(async () => {
      entered = internals.beginAdjust(event.id, occurrence, "move");
    });
    expect(entered).toBe(true);
    expect(getState().adjust).not.toBeNull();
  });
});

describe("a pointer-down on the session's own bar cancels Adjust first, centrally (gantt-dnd.tsx's beginGesture, not per-call-site)", () => {
  it("a pointerdown on the bar that is currently adjusting clears the session immediately, before any gesture geometry runs", async () => {
    const event: GanttEvent = { id: "same-bar", title: "Same Bar", start: START, end: END };
    const internalsRef: { current: GanttInternals | null } = { current: null };
    const getStateRef: {
      current: (() => ReturnType<ReturnType<typeof useGantt>["getState"]>) | null;
    } = { current: null };
    await render(
      <Gantt defaultEvents={[event]} date={START} timeZone="UTC">
        <InternalsProbe internalsRef={internalsRef} getStateRef={getStateRef} apiRef={{ current: null }} />
        <GeometryHost eventId="same-bar" />
      </Gantt>,
    );
    const bar = findBar("Same Bar");
    await focusBar(bar);
    await keydown(bar, { key: " " });
    expect(bar.getAttribute("data-adjusting")).not.toBeNull();
    expect(getStateRef.current!().adjust).not.toBeNull();

    // No geometry needed to observe the cancellation - it runs at beginGesture's very first line,
    // before collectSurface/activation. pointerId matches nothing later (no pointerup dispatched),
    // so this leaves one gesture registered; afterEach's cancelActiveGanttGestures() sweeps it.
    await pointerEvent(bar, "pointerdown", { pointerId: 99, button: 0, clientX: 10, clientY: 10 });

    expect(getStateRef.current!().adjust).toBeNull();
    expect(bar.getAttribute("role")).not.toBe("application");
    expect(bar.getAttribute("data-adjusting")).toBeNull();
    // The bar's OWN owner-death effect (#219 PR A fix, Sol re-review round 2, HIGH #3) announces
    // the cancellation - beginGesture's central check deliberately does not announce itself (see
    // that function's own comment) to avoid a second announcement path.
    expect(announcerText()).toBe("Adjustment cancelled.");
  });
});

describe("the named interleaving: pointer-down -> Space -> Arrow -> pointer-up => at most one update, with the right source, never two", () => {
  it("a real pointer move gesture wins: Space is refused mid-gesture, Arrow is a no-op, and release commits exactly once with source: 'drag'", async () => {
    const onEventUpdate = vi.fn((u: GanttProposedUpdate) => {
      void u;
      return true;
    });
    const onEventsChange = vi.fn();
    const event: GanttEvent = { id: "interleave", title: "Interleave Me", start: START, end: END };
    await render(
      <Gantt events={[event]} onEventUpdate={onEventUpdate} onEventsChange={onEventsChange} date={START} timeZone="UTC">
        <GeometryHost eventId="interleave" />
      </Gantt>,
    );
    const bar = findBar("Interleave Me");
    await focusBar(bar);

    // pointerdown, then a real pointermove past the 5px activation threshold - a genuine ACTIVE
    // pointer gesture, registered in the SAME page-wide registry beginAdjust checks.
    await pointerEvent(bar, "pointerdown", { pointerId: 7, button: 0, clientX: 100, clientY: 10 });
    await pointerEvent(window, "pointermove", { pointerId: 7, clientX: 300, clientY: 10 });

    // Space: refused. No session, no ghost, no announcement, no role/data-adjusting.
    await keydown(bar, { key: " " });
    expect(bar.getAttribute("role")).not.toBe("application");
    expect(bar.getAttribute("data-adjusting")).toBeNull();
    expect(onEventUpdate).not.toHaveBeenCalled();

    // Arrow: not adjusting (Space never entered), so matchGanttBarKey's idle table does not
    // recognize it either - a genuine no-op, not a second write path.
    await keydown(bar, { key: "ArrowRight" });
    expect(onEventUpdate).not.toHaveBeenCalled();

    // pointerup: the pointer gesture that WAS active all along commits, exactly once.
    await pointerEvent(window, "pointerup", { pointerId: 7, clientX: 300, clientY: 10 });

    expect(onEventUpdate).toHaveBeenCalledTimes(1);
    expect(onEventsChange).toHaveBeenCalledTimes(1);
    const update = onEventUpdate.mock.calls[0]![0] as GanttProposedUpdate;
    expect(update.source).toBe("drag");
    // never entered Adjust at any point in the sequence
    expect(bar.getAttribute("role")).not.toBe("application");
  });
});
