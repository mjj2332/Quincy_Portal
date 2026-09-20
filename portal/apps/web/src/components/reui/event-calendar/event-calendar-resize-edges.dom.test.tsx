/**
 * #219 (PR B) stage 3 — the per-edge resize veto's DOM consequence, event-calendar's own copy of
 * the same owner decision the Gantt already carries for #215 (`gantt-bar-resize-grips.dom.test.tsx`,
 * which this file mirrors structurally): a locked-start shoot date must draw no start grip AND must
 * refuse a resize attempted on that edge even when a consumer calls `gestures.beginResize` directly,
 * bypassing the grip entirely. `event-calendar-types.tsx`'s `resizableEdges` doc comment states the
 * contract verbatim; this is what proves it.
 *
 * Cases 1-7 render `<EventCalendarEvent>` directly inside a bare `<EventCalendar>` provider (plus
 * the raw `EventCalendarViewContext` the chip also reads, since that context has no default and is
 * normally supplied by a real view component we are deliberately not rendering) with a hand-built
 * `EventCalendarSegment` fixture — the grip count depends only on the chip, exactly the Gantt
 * precedent's own reasoning for skipping the full view composition.
 *
 * Case 8 (enforcement) needs an actual resize PROPOSAL to materialize, not just a grip to render, so
 * it borrows the geometry-mocking technique from `gantt-dnd-refusal-announce.dom.test.tsx`'s own
 * `GeometryHost`: one synthetic `[data-ec-day]` time column with a stubbed `getBoundingClientRect`
 * (1px = 1 minute, matching that file's own axis convention) dropped into the tree so
 * `event-calendar-dnd.tsx`'s `collectSurface`/`computeProposal` have real geometry to read. The
 * observable signal is `EventCalendarInstance.getState().drag`: a real resize gesture writes
 * `{ kind: "resize-end", ... }` there via `internals.setDrag` the moment a valid proposal computes,
 * and nothing else in this tree can produce that value. A refused resize (`beginBlockedGesture`)
 * never calls `setDrag` at all — checking `state.drag` after an equivalent pointer sequence proves
 * the refusal is real, not just that a grip happened not to render. `onDragBlocked` corroborates the
 * refusal on the calendar's own public callback surface.
 *
 * Guard F (`test-seam.guard.test.ts`, issue #92) forbids a DOM test from selecting `[data-slot="X"]`
 * where only a `components/reui/` file authors `X` — a version bump could rename or drop it with no
 * Quincy file to keep it stable. The grips carry `data-slot="event-calendar-resize-handle"` (vendor-
 * authored, un-selectable here) but ALSO a `data-testid` (`event-calendar-resize-handle-start` /
 * `-end`) added in `event-calendar-event.tsx` for exactly this, mirroring the Gantt's own
 * `gantt-resize-handle-start`/`-end` precedent and its file header's note on why the vendor file is
 * the honest place to hang it.
 */
import { act, useEffect, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TZDate } from "@date-fns/tz";
import {
  EventCalendar,
  EventCalendarViewContext,
  useEventCalendar,
  type EventCalendarInstance,
} from "@/components/reui/event-calendar/event-calendar";
import { EventCalendarEvent } from "@/components/reui/event-calendar/event-calendar-event";
import { useEventCalendarGestures } from "@/components/reui/event-calendar/event-calendar-dnd";
import type {
  CalendarEvent,
  EventCalendarOccurrence,
  EventCalendarSegment,
} from "@/components/reui/event-calendar/event-calendar-types";

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
const START = new TZDate(2026, 2, 10, 9, 0, 0, 0, TZ); // 09:00 Sydney
const END = new TZDate(2026, 2, 10, 10, 0, 0, 0, TZ); // 10:00 Sydney — a plain 1h timed block

type TData = unknown;

function makeSegment(event: CalendarEvent<TData>): EventCalendarSegment<TData> {
  const occurrence: EventCalendarOccurrence<TData> = {
    key: `${event.id}::${event.start.toISOString()}`,
    eventId: event.id,
    event,
    start: event.start,
    end: event.end,
    allDay: false,
    isRecurring: false,
  };
  return {
    occurrence,
    day: DAY,
    isStart: true,
    isEnd: true,
    continuesBefore: false,
    continuesAfter: false,
    startMin: 9 * 60,
    endMin: 10 * 60,
  };
}

/** Cases 1-7: just the chip, wrapped in the raw view context it reads directly. */
function Chip({ event }: { event: CalendarEvent<TData> }) {
  return (
    <EventCalendarViewContext.Provider value={{ view: "week" }}>
      <EventCalendarEvent segment={makeSegment(event)} />
    </EventCalendarViewContext.Provider>
  );
}

const startGripCount = () =>
  host.querySelectorAll('[data-testid="event-calendar-resize-handle-start"]').length;
const endGripCount = () =>
  host.querySelectorAll('[data-testid="event-calendar-resize-handle-end"]').length;

describe("EventCalendarEvent resize grips — per-edge veto (#219 PR B stage 3)", () => {
  it("an unlocked event renders both grips", async () => {
    const event: CalendarEvent<TData> = { id: "e1", title: "Unlocked", start: START, end: END };
    await render(
      <EventCalendar events={[event]} timeZone={TZ}>
        <Chip event={event} />
      </EventCalendar>,
    );
    expect(startGripCount()).toBe(1);
    expect(endGripCount()).toBe(1);
  });

  it("a start-locked event (stands in for #215's fixed shoot date) renders exactly one grip", async () => {
    const event: CalendarEvent<TData> = {
      id: "e2",
      title: "Start-locked",
      start: START,
      end: END,
      resizableEdges: { start: false },
    };
    await render(
      <EventCalendar events={[event]} timeZone={TZ}>
        <Chip event={event} />
      </EventCalendar>,
    );
    expect(startGripCount()).toBe(0);
    expect(endGripCount()).toBe(1);
  });

  it("an end-locked event renders exactly one grip, the start one", async () => {
    const event: CalendarEvent<TData> = {
      id: "e3",
      title: "End-locked",
      start: START,
      end: END,
      resizableEdges: { end: false },
    };
    await render(
      <EventCalendar events={[event]} timeZone={TZ}>
        <Chip event={event} />
      </EventCalendar>,
    );
    expect(startGripCount()).toBe(1);
    expect(endGripCount()).toBe(0);
  });

  it("both edges locked renders no grips", async () => {
    const event: CalendarEvent<TData> = {
      id: "e4",
      title: "Fully locked",
      start: START,
      end: END,
      resizableEdges: { start: false, end: false },
    };
    await render(
      <EventCalendar events={[event]} timeZone={TZ}>
        <Chip event={event} />
      </EventCalendar>,
    );
    expect(startGripCount()).toBe(0);
    expect(endGripCount()).toBe(0);
  });

  it("an explicit `true` edge behaves like an omitted one — both grips render", async () => {
    const event: CalendarEvent<TData> = {
      id: "e5",
      title: "Explicit true",
      start: START,
      end: END,
      resizableEdges: { start: true, end: true },
    };
    await render(
      <EventCalendar events={[event]} timeZone={TZ}>
        <Chip event={event} />
      </EventCalendar>,
    );
    expect(startGripCount()).toBe(1);
    expect(endGripCount()).toBe(1);
  });

  it("readOnly overrides a per-edge allow — no grips even with resizableEdges.start: true", async () => {
    const event: CalendarEvent<TData> = {
      id: "e6",
      title: "Read only",
      start: START,
      end: END,
      readOnly: true,
      resizableEdges: { start: true },
    };
    await render(
      <EventCalendar events={[event]} timeZone={TZ}>
        <Chip event={event} />
      </EventCalendar>,
    );
    expect(startGripCount()).toBe(0);
    expect(endGripCount()).toBe(0);
  });

  it("resizable: false overrides a per-edge allow — no grips even with resizableEdges.start: true", async () => {
    const event: CalendarEvent<TData> = {
      id: "e7",
      title: "Whole-event locked",
      start: START,
      end: END,
      resizable: false,
      resizableEdges: { start: true },
    };
    await render(
      <EventCalendar events={[event]} timeZone={TZ}>
        <Chip event={event} />
      </EventCalendar>,
    );
    expect(startGripCount()).toBe(0);
    expect(endGripCount()).toBe(0);
  });
});

/**
 * Case 8: enforcement, not just rendering. `beginResize` (`event-calendar-dnd.tsx`) is meant to
 * refuse a locked edge on its own, so a consumer calling it directly — not just clicking a grip
 * that happens not to exist — must be refused too.
 */
type Gestures = ReturnType<typeof useEventCalendarGestures<TData>>;

function GeometryHost({
  event,
  instanceRef,
  gesturesRef,
}: {
  event: CalendarEvent<TData>;
  instanceRef: { current: EventCalendarInstance<TData> | null };
  gesturesRef: { current: Gestures | null };
}) {
  const instance = useEventCalendar<TData>();
  useEffect(() => {
    instanceRef.current = instance;
  });
  const gestures = useEventCalendarGestures<TData>();
  useEffect(() => {
    gesturesRef.current = gestures;
  });
  // 1px = 1 minute from Sydney midnight, same convention as
  // `gantt-dnd-refusal-announce.dom.test.tsx`'s own axis mock, so a synthetic pointer client
  // coordinate maps straight onto `event-calendar-dnd.tsx`'s minute math with no extra scaling.
  const columnRef = (el: HTMLDivElement | null) => {
    if (!el) return;
    el.getBoundingClientRect = () =>
      ({ left: 0, right: 100, top: 0, bottom: 1440, width: 100, height: 1440, x: 0, y: 0, toJSON() {} }) as DOMRect;
  };
  return (
    <EventCalendarViewContext.Provider value={{ view: "week" }}>
      <div ref={columnRef} data-ec-day={DAY.getTime()} data-ec-bounds-start={0} data-ec-bounds-end={1440} />
      <EventCalendarEvent segment={makeSegment(event)} />
    </EventCalendarViewContext.Provider>
  );
}

describe("EventCalendarEvent resize enforcement — a locked edge refuses beginResize itself (#219 PR B stage 3)", () => {
  it("the end grip (allowed) starts a real resize gesture; beginResize on the locked start edge never does", async () => {
    const onDragBlocked = vi.fn();
    const event: CalendarEvent<TData> = {
      id: "enforce",
      title: "Start-locked",
      start: START,
      end: END,
      resizableEdges: { start: false },
    };
    const instanceRef: { current: EventCalendarInstance<TData> | null } = { current: null };
    const gesturesRef: { current: Gestures | null } = { current: null };

    await render(
      <EventCalendar events={[event]} timeZone={TZ} onDragBlocked={onDragBlocked}>
        <GeometryHost event={event} instanceRef={instanceRef} gesturesRef={gesturesRef} />
      </EventCalendar>,
    );

    // --- allowed edge: a real pointerdown+pointermove on the rendered END grip ---
    const endGrip = host.querySelector<HTMLElement>('[data-testid="event-calendar-resize-handle-end"]');
    expect(endGrip).not.toBeNull();
    expect(instanceRef.current!.getState().drag).toBeNull();

    await pointerEvent(endGrip!, "pointerdown", { pointerId: 1, button: 0, clientX: 50, clientY: 10 * 60 });
    // drag to 11:00 (minute 660 on the 1px = 1 minute axis)
    await pointerEvent(window, "pointermove", { pointerId: 1, clientX: 50, clientY: 11 * 60 });

    const drag = instanceRef.current!.getState().drag;
    expect(drag).not.toBeNull();
    expect(drag!.kind).toBe("resize-end");
    expect(onDragBlocked).not.toHaveBeenCalled();

    await pointerEvent(window, "pointerup", { pointerId: 1, clientX: 50, clientY: 11 * 60 });
    expect(instanceRef.current!.getState().drag).toBeNull();

    // --- disallowed edge: no grip renders, so call gestures.beginResize directly, exactly the
    //     bypass path the type's own doc comment calls out ---
    expect(host.querySelector('[data-testid="event-calendar-resize-handle-start"]')).toBeNull();
    const segment = makeSegment(event);
    const startNativeEvent = new PointerEvent("pointerdown", {
      pointerId: 2,
      clientX: 50,
      clientY: 9 * 60,
      bubbles: true,
    });
    await act(async () => {
      gesturesRef.current!.beginResize(
        {
          button: 0,
          currentTarget: endGrip as unknown as EventTarget,
          nativeEvent: startNativeEvent,
          stopPropagation() {},
          preventDefault() {},
        } as unknown as React.PointerEvent,
        segment,
        "start",
      );
      await Promise.resolve();
    });

    // move past the activation threshold so the refusal broadcasts, exactly as a genuine drag
    // attempt on a locked edge would in the browser
    await pointerEvent(window, "pointermove", { pointerId: 2, clientX: 50, clientY: 9 * 60 + 20 });

    expect(instanceRef.current!.getState().drag).toBeNull();
    expect(onDragBlocked).toHaveBeenCalledTimes(1);
    expect(onDragBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ key: segment.occurrence.key }),
      expect.objectContaining({ gesture: "resize" }),
    );

    await pointerEvent(window, "pointerup", { pointerId: 2, clientX: 50, clientY: 9 * 60 + 20 });
  });
});
