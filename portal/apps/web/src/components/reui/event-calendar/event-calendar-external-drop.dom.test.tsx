/**
 * #219 (PR B) stage 3 — the external-drop gesture's DOM consequence (`useEventCalendarExternalDrop`
 * in `event-calendar-dnd.tsx`). Mirrors `event-calendar-resize-edges.dom.test.tsx`'s structure and
 * its `GeometryHost` technique (itself borrowed from `gantt-dnd-refusal-announce.dom.test.tsx`) for
 * stubbing `getBoundingClientRect` on a synthetic `[data-ec-day]` node so `collectSurface` /
 * `resolveExternalDropTarget` have real geometry to read without rendering a full time-grid view.
 *
 * `begin` is called directly (not via a rendered tray row's `onPointerDown`) — same "call the hook's
 * returned function directly" pattern the resize test's case 8 uses for `gestures.beginResize` — so
 * the origin element can be a bare div with no chip semantics at all. `begin`'s own window listeners
 * do not filter by `pointerId` (unlike `beginGesture`'s), so synthetic events omit it.
 *
 * Observable per case:
 *   a. `instance.getState().slotDraft` after the pointer settles on the stubbed column, then
 *      `onDrop`'s own call count/args on release.
 *   b. `slotDraft` stays `null` when `canDrop` refuses, and `onDrop` is never called; `onCancel` is.
 *   c. `slotDraft` clears and `onCancel` fires on a window `keydown` Escape mid-drag.
 *   d. see the code comment on that case below — the vendor's actual `onPointerUp` behaviour for a
 *      release that never crossed the activation threshold does NOT match the letter of this spec
 *      item, and is left as an explicit finding rather than an edited assertion.
 *   e. AGENDA no-op: a `GeometryHost` variant with no `[data-ec-day]` node at all (neither a minute
 *      column nor a day cell) never produces a target — `slotDraft` stays `null` throughout, and
 *      release calls `onCancel`, never `onDrop`.
 *   f. `cancelActiveEventCalendarGestures()` (imported straight from the module, not a wrapper)
 *      mid-drag clears `slotDraft` and fires `onCancel`, proving the gesture is registered in the
 *      module's own `activeGestureCancels` registry rather than some parallel bookkeeping.
 */
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TZDate } from "@date-fns/tz";
import {
  EventCalendar,
  useEventCalendar,
  type EventCalendarInstance,
} from "@/components/reui/event-calendar/event-calendar";
import {
  cancelActiveEventCalendarGestures,
  useEventCalendarExternalDrop,
  wasRecentChipPress,
  wasRecentDrag,
} from "@/components/reui/event-calendar/event-calendar-dnd";
import type {
  EventCalendarExternalDropOptions,
} from "@/components/reui/event-calendar/event-calendar-dnd";

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

async function pointerEvent(target: EventTarget, type: string, init: PointerEventInit) {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

async function keyEvent(target: EventTarget, type: string, init: KeyboardEventInit) {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
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

const TZ = "Australia/Sydney";
const DAY = new TZDate(2026, 2, 10, 0, 0, 0, 0, TZ); // Sydney civil midnight, 2026-03-10
// 1px = 1 minute from Sydney midnight, same convention as the resize test's own column mock.
const EXPECTED_START = new TZDate(2026, 2, 10, 9, 0, 0, 0, TZ); // clientY 540 -> minute 540 -> 09:00

type TData = unknown;
interface Payload {
  id: string;
}
const PAYLOAD: Payload = { id: "unsched-scout" };
const DURATION_MINUTES = 90;

type Begin = (
  e: React.PointerEvent,
  options: EventCalendarExternalDropOptions<Payload>,
) => void;

/**
 * Renders inside `<EventCalendar>` (required: `useEventCalendarExternalDrop` calls
 * `useEventCalendar()`, whose context has no default), exposing the instance and `begin` via refs
 * so the test can drive both directly, plus a bare origin div and — when `withColumn` — one
 * synthetic minute column. `withColumn={false}` (case e) renders neither a column nor a day cell,
 * which is exactly what an AGENDA view's own DOM looks like to `collectSurface`.
 */
function GeometryHost({
  instanceRef,
  beginRef,
  withColumn,
}: {
  instanceRef: { current: EventCalendarInstance<TData> | null };
  beginRef: { current: Begin | null };
  withColumn: boolean;
}) {
  const instance = useEventCalendar<TData>();
  useEffect(() => {
    instanceRef.current = instance;
  });
  const { begin } = useEventCalendarExternalDrop<TData, Payload>();
  useEffect(() => {
    beginRef.current = begin;
  });

  const columnRef = (el: HTMLDivElement | null) => {
    if (!el) return;
    el.getBoundingClientRect = () =>
      ({ left: 0, right: 100, top: 0, bottom: 1440, width: 100, height: 1440, x: 0, y: 0, toJSON() {} }) as DOMRect;
  };

  return (
    <>
      {withColumn && (
        <div ref={columnRef} data-ec-day={DAY.getTime()} data-ec-bounds-start={0} data-ec-bounds-end={1440} />
      )}
      <div data-testid="tray-origin" />
    </>
  );
}

function makePointerDownEvent(overrides: Partial<React.PointerEvent> = {}): React.PointerEvent {
  const origin = host.querySelector<HTMLElement>('[data-testid="tray-origin"]')!;
  return {
    button: 0,
    pointerType: "mouse",
    clientX: 50,
    clientY: 500,
    currentTarget: origin,
    ...overrides,
  } as unknown as React.PointerEvent;
}

async function setup(withColumn: boolean) {
  const instanceRef: { current: EventCalendarInstance<TData> | null } = { current: null };
  const beginRef: { current: Begin | null } = { current: null };
  await render(
    <EventCalendar events={[]} timeZone={TZ}>
      <GeometryHost instanceRef={instanceRef} beginRef={beginRef} withColumn={withColumn} />
    </EventCalendar>,
  );
  return { instanceRef, beginRef };
}

/**
 * Both click-suppression flags in `event-calendar-dnd.tsx` are module-level and expire 250ms
 * after the last gesture, measured on `performance.now()` — which fake timers do not move. The
 * only honest way to observe them from a fresh baseline is to let that window really elapse.
 */
async function waitForGestureFlagsToSettle(): Promise<void> {
  const deadline = performance.now() + 1000;
  while ((wasRecentDrag() || wasRecentChipPress()) && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

describe("useEventCalendarExternalDrop — DOM (#219 PR B stage 3)", () => {
  it("a. pointerdown + pointermove past the 5px threshold sets a slot draft; pointerup calls onDrop exactly once with the stubbed target", async () => {
    const { instanceRef, beginRef } = await setup(true);
    const onDrop = vi.fn();
    const onCancel = vi.fn();

    await act(async () => {
      beginRef.current!(makePointerDownEvent(), {
        payload: PAYLOAD,
        durationMinutes: DURATION_MINUTES,
        onDrop,
        onCancel,
      });
    });
    expect(instanceRef.current!.getState().slotDraft).toBeNull();

    // Crosses the 5px activation threshold (dy = 10) but is not yet the final target position.
    await pointerEvent(window, "pointermove", { clientX: 50, clientY: 510 });
    expect(instanceRef.current!.getState().slotDraft).not.toBeNull();

    // Settle on the exact target: minute 540 (09:00), aligned to the default 15-minute snap.
    await pointerEvent(window, "pointermove", { clientX: 50, clientY: 540 });
    const draft = instanceRef.current!.getState().slotDraft;
    expect(draft).not.toBeNull();
    expect(draft!.start.getTime()).toBe(EXPECTED_START.getTime());
    expect(draft!.allDay).toBe(false);

    await pointerEvent(window, "pointerup", { clientX: 50, clientY: 540 });
    expect(instanceRef.current!.getState().slotDraft).toBeNull();
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    const [target, payload] = onDrop.mock.calls[0]!;
    expect(target.start.getTime()).toBe(EXPECTED_START.getTime());
    expect(payload).toBe(PAYLOAD);
  });

  it("b. canDrop returning false: no slot draft, onDrop not called on release, onCancel is", async () => {
    const { instanceRef, beginRef } = await setup(true);
    const onDrop = vi.fn();
    const onCancel = vi.fn();

    await act(async () => {
      beginRef.current!(makePointerDownEvent(), {
        payload: PAYLOAD,
        durationMinutes: DURATION_MINUTES,
        canDrop: () => false,
        onDrop,
        onCancel,
      });
    });

    await pointerEvent(window, "pointermove", { clientX: 50, clientY: 510 });
    await pointerEvent(window, "pointermove", { clientX: 50, clientY: 540 });
    expect(instanceRef.current!.getState().slotDraft).toBeNull();

    await pointerEvent(window, "pointerup", { clientX: 50, clientY: 540 });
    expect(onDrop).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("c. Escape mid-drag clears the slot draft, never calls onDrop, and calls onCancel", async () => {
    const { instanceRef, beginRef } = await setup(true);
    const onDrop = vi.fn();
    const onCancel = vi.fn();

    await act(async () => {
      beginRef.current!(makePointerDownEvent(), {
        payload: PAYLOAD,
        durationMinutes: DURATION_MINUTES,
        onDrop,
        onCancel,
      });
    });
    await pointerEvent(window, "pointermove", { clientX: 50, clientY: 510 });
    await pointerEvent(window, "pointermove", { clientX: 50, clientY: 540 });
    expect(instanceRef.current!.getState().slotDraft).not.toBeNull();

    await keyEvent(window, "keydown", { key: "Escape" });
    expect(instanceRef.current!.getState().slotDraft).toBeNull();
    expect(onDrop).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);

    // The gesture is fully torn down: a release after Escape must not re-fire anything.
    await pointerEvent(window, "pointerup", { clientX: 50, clientY: 540 });
    expect(onDrop).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  /**
   * d. FINDING, not a weakened assertion — see this file's header. The task spec for this case
   * reads: "A drag that never passes the 5px threshold: no draft, no onDrop, and onCancel fires on
   * release." The first two hold. The third does not, by design of the code as written:
   * `useEventCalendarExternalDrop`'s own `onPointerUp` (`event-calendar-dnd.tsx`) is
   *
   *   function onPointerUp(up: PointerEvent) {
   *     if (!active) {
   *       teardown()
   *       return
   *     }
   *     ...
   *   }
   *
   * — when the pointer never activated (never crossed the threshold), release calls ONLY
   * `teardown()` and returns; `onCancel` is never invoked. This reads as intentional: an
   * unactivated press-and-release is indistinguishable from an ordinary click on the tray row (the
   * user never attempted to drag), so the calendar treats it as a no-op rather than a "cancelled
   * drag" worth reporting — the same distinction `beginGesture`'s own activation gating draws
   * elsewhere in this file. Reported per the task's own instruction ("if any of these cannot be
   * made to work, REPORT IT — do not weaken an assertion or delete a case") rather than either
   * editing the vendored block (out of scope here) or asserting a call that does not happen.
   */
  it("d. a drag that never passes the 5px threshold: no draft, no onDrop — and (see comment above) no onCancel either", async () => {
    const { instanceRef, beginRef } = await setup(true);
    const onDrop = vi.fn();
    const onCancel = vi.fn();

    await act(async () => {
      beginRef.current!(makePointerDownEvent({ clientX: 50, clientY: 500 }), {
        payload: PAYLOAD,
        durationMinutes: DURATION_MINUTES,
        onDrop,
        onCancel,
      });
    });

    // dx = 2, dy = 2 — both under the 5px activation threshold.
    await pointerEvent(window, "pointermove", { clientX: 52, clientY: 502 });
    expect(instanceRef.current!.getState().slotDraft).toBeNull();

    await pointerEvent(window, "pointerup", { clientX: 52, clientY: 502 });
    expect(instanceRef.current!.getState().slotDraft).toBeNull();
    expect(onDrop).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("d2. a non-activated press leaves the module-wide click suppression alone", async () => {
    // Regression. `teardown()` used to call `markChipPress()` and stamp `lastGestureEndedAt`
    // unconditionally, so merely CLICKING a tray row (never crossing the activation threshold)
    // swallowed that row's own trailing click — and, because both flags are module-level, also
    // suppressed chip clicks across the entire calendar for the next 250ms. Found while writing
    // case (d): the spec expected `onCancel` there, the code did not call it, and chasing why
    // surfaced this. A press that never became a drag must leave no trace at all.
    const { instanceRef, beginRef } = await setup(true);
    const onDrop = vi.fn();
    const onCancel = vi.fn();

    // `lastGestureEndedAt` / `lastChipPressAt` are MODULE-level and decay on a 250ms real-time
    // window, so an earlier case in this file (which run milliseconds apart) would otherwise
    // still be inside it and this assertion would read their state instead of ours. Wait them
    // out rather than relaxing the assertion — the flags being module-wide is precisely the
    // thing under test.
    await waitForGestureFlagsToSettle();
    expect(wasRecentDrag()).toBe(false);
    expect(wasRecentChipPress()).toBe(false);

    await act(async () => {
      beginRef.current!(makePointerDownEvent({ clientX: 50, clientY: 500 }), {
        payload: PAYLOAD,
        durationMinutes: DURATION_MINUTES,
        onDrop,
        onCancel,
      });
    });
    await pointerEvent(window, "pointermove", { clientX: 51, clientY: 501 });
    await pointerEvent(window, "pointerup", { clientX: 51, clientY: 501 });

    expect(instanceRef.current!.getState().slotDraft).toBeNull();
    expect(onDrop).not.toHaveBeenCalled();
    expect(wasRecentDrag()).toBe(false);
    expect(wasRecentChipPress()).toBe(false);
  });

  it("e. AGENDA no-op: a surface with no [data-ec-day] at all resolves no target — release calls onCancel, never onDrop", async () => {
    const { instanceRef, beginRef } = await setup(false);
    const onDrop = vi.fn();
    const onCancel = vi.fn();

    await act(async () => {
      beginRef.current!(makePointerDownEvent(), {
        payload: PAYLOAD,
        durationMinutes: DURATION_MINUTES,
        onDrop,
        onCancel,
      });
    });

    await pointerEvent(window, "pointermove", { clientX: 50, clientY: 510 });
    expect(instanceRef.current!.getState().slotDraft).toBeNull();
    await pointerEvent(window, "pointermove", { clientX: 50, clientY: 540 });
    expect(instanceRef.current!.getState().slotDraft).toBeNull();

    await pointerEvent(window, "pointerup", { clientX: 50, clientY: 540 });
    expect(onDrop).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("f. cancelActiveEventCalendarGestures() mid-drag clears the draft and fires onCancel", async () => {
    const { instanceRef, beginRef } = await setup(true);
    const onDrop = vi.fn();
    const onCancel = vi.fn();

    await act(async () => {
      beginRef.current!(makePointerDownEvent(), {
        payload: PAYLOAD,
        durationMinutes: DURATION_MINUTES,
        onDrop,
        onCancel,
      });
    });
    await pointerEvent(window, "pointermove", { clientX: 50, clientY: 510 });
    await pointerEvent(window, "pointermove", { clientX: 50, clientY: 540 });
    expect(instanceRef.current!.getState().slotDraft).not.toBeNull();

    await act(async () => {
      cancelActiveEventCalendarGestures();
      await Promise.resolve();
    });

    expect(instanceRef.current!.getState().slotDraft).toBeNull();
    expect(onDrop).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);

    // Torn down: a subsequent release does nothing further.
    await pointerEvent(window, "pointerup", { clientX: 50, clientY: 540 });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
