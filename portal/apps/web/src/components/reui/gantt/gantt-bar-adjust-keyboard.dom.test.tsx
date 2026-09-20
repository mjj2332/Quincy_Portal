/**
 * #219 PR A (Adjust mode) — `gantt-bar.tsx`'s modal keyboard Adjust session wired end to end
 * (Space to enter, Arrow/Shift+Arrow to step, M/S/E to retarget, Enter/Space to commit, Escape to
 * cancel, blur / pointer-down elsewhere to cancel). REPLACES `gantt-bar-keyboard.dom.test.tsx`
 * (deleted in the same commit) - the old file pinned the Alt+Arrow / Shift+Alt+Arrow /
 * Ctrl+Alt+Arrow chord scheme that `matchGanttBarKeyChord` implemented; that matcher and every one
 * of those chords are gone (Opus and Sol both rejected them - Ctrl+Alt+Arrow is OS-intercepted on
 * some desktops, Alt+Arrow is browser Back/Forward). Old test -> new test mapping (every behaviour
 * the old file pinned is still pinned here, just driven through the new key scheme):
 *
 *   "Alt+ArrowRight moves the bar later, disconnects..."      -> "Space, ArrowRight, Enter moves the bar later..."
 *   "announces the NEW range in genuinely controlled mode"    -> "commit announces the NEW range in genuinely controlled mode"
 *   "Alt+ArrowLeft moves the bar earlier"                     -> "Space, ArrowLeft, Enter moves the bar earlier"
 *   "Shift+Alt+ArrowRight resizes the END edge only..."       -> "Space, E, ArrowRight, Enter resizes the END edge only..."
 *   "Ctrl+Alt+ArrowLeft resizes the START edge only"          -> "Space, S, ArrowLeft, Enter resizes the START edge only"
 *   "a locked start edge omits the start chord..., no-ops"    -> "a locked start edge: Space still enters (move); S is refused and announced, target unchanged"
 *   "onEventUpdate rejecting the nudge announces rejected..." -> "onEventUpdate rejecting the COMMIT announces rejected and applies nothing"
 *   "a clipped start edge neither advertises nor executes..." -> "a clipped start edge: Space still enters (move); S is refused even though the EVENT allows it"
 *   "a non-draggable event omits the move chord..."           -> "a non-draggable event: Space still enters via the first resizable edge; M is refused"
 *   "a recurring occurrence's bar advertises no chords..."    -> "a recurring occurrence: aria-keyshortcuts is null; Space does not enter, left un-prevented"
 *   "a chord that is not ours (plain ArrowRight) left alone"  -> "a plain ArrowRight while idle is left alone"
 *   "a chord that IS ours still composes onKeyDown..."        -> "Space still composes the consumer's onKeyDown, on an event it prevented"
 *   "two Gantt instances with the SAME event id..."           -> unchanged (exercises `internals` directly, not a chord)
 *   "a stale claimed token..."                                -> unchanged (exercises `internals` directly, not a chord)
 *   "StrictMode's double-invoked effects land focus once..."  -> "StrictMode... via Space/ArrowRight/Enter"
 *   "a consumer-supplied ref still receives the DOM node..."  -> "a consumer-supplied ref... via Space/ArrowRight/Enter"
 *   "respects RTL... Alt+ArrowRight moves EARLIER under rtl"  -> "respects RTL: ArrowRight while adjusting moves EARLIER under rtl"
 *
 * Plus new Adjust-mode-only coverage: role/data-adjusting/aria-describedby + instructions on entry,
 * a step applying ZERO onEventUpdate calls (preview only) while driving `state.drag` the SAME shape
 * a pointer gesture would (the ghost-preview path, per this PR's preference (a) - see `gantt.tsx`'s
 * `GanttInternals.stepAdjust` header), Escape/blur/pointer-elsewhere cancel paths, a fully-locked
 * bar never entering, and the shared overlap policy refusing a step with the preview left untouched.
 */
import {
  act,
  StrictMode,
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gantt, useGantt, useGanttSelector, type GanttInternals } from "@/components/reui/gantt/gantt";
import { GanttBar } from "@/components/reui/gantt/gantt-bar";
import type { GanttEvent, GanttOccurrence, GanttSegment } from "@/components/reui/gantt/gantt-types";

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

/** Returns the dispatched native event so a caller can inspect `defaultPrevented` afterward. */
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

/**
 * #219 PR A fix (Sol re-review round 2, LOW): a real browser's activation behaviour for Space on a
 * focused, un-prevented `<button>` is keydown, then (on keyup, per the HTML spec's button
 * activation behaviour) a synthetic `click`. Neither jsdom nor happy-dom (this suite's DOM
 * environment) synthesizes that click on its own - a test that only asserts
 * `keydown.defaultPrevented === false` proves this component did not BLOCK native activation, but
 * never actually proves activation still WORKS. This dispatches all three events, in that order,
 * the way a real browser would, and returns the click event so a caller can also assert its own
 * `defaultPrevented`.
 */
async function nativeSpaceActivate(el: HTMLElement): Promise<{ keydown: KeyboardEvent; click: MouseEvent }> {
  const keydownEvent = await keydown(el, { key: " " });
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: " " }));
    await Promise.resolve();
  });
  const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
  await act(async () => {
    el.dispatchEvent(clickEvent);
    await Promise.resolve();
  });
  return { keydown: keydownEvent, click: clickEvent };
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

/** Reproduces gantt-view.tsx's own `<div key={segment.occurrence.key}><GanttBar .../></div>`. */
function KeyedBarHost({
  eventId,
  onKeyDown,
  barRef,
}: {
  eventId: string;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
  barRef?: Ref<HTMLButtonElement>;
}) {
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
      <GanttBar segment={segment} onKeyDown={onKeyDown} ref={barRef} />
    </div>
  );
}

/** Exposes `instance.internals`/`getState` for assertions the DOM alone can't make (e.g. `state.drag`). */
function InternalsProbe({
  internalsRef,
  getStateRef,
}: {
  internalsRef: { current: GanttInternals | null };
  getStateRef?: { current: (() => ReturnType<ReturnType<typeof useGantt>["getState"]>) | null };
}) {
  const instance = useGantt();
  useEffect(() => {
    internalsRef.current = instance.internals;
    if (getStateRef) getStateRef.current = instance.getState;
  });
  return null;
}

function findBarByTitle(title: string): HTMLButtonElement {
  const bar = [...host.querySelectorAll("button")].find((el) => el.textContent?.includes(title));
  if (!bar) throw new Error(`no bar found for title ${title}`);
  return bar;
}

function announcerText(): string | null {
  return host.querySelector<HTMLElement>('[aria-live="polite"]')?.textContent ?? null;
}

describe("GanttBar Adjust mode (#219 PR A)", () => {
  it("Space, ArrowRight, Enter moves the bar later, disconnects the OLD node, and hands focus to its replacement", async () => {
    function ControlledHost() {
      const [events, setEvents] = useState<GanttEvent[]>([
        { id: "kb-move", title: "Keyboard Move", start: START, end: END },
      ]);
      return (
        <Gantt events={events} onEventsChange={setEvents} date={START} timeZone="UTC">
          <KeyedBarHost eventId="kb-move" />
        </Gantt>
      );
    }
    await render(<ControlledHost />);
    const bar = findBarByTitle("Keyboard Move");
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "ArrowRight" });
    await keydown(bar, { key: "Enter" });

    expect(bar.isConnected).toBe(false);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).not.toBe(bar);
    expect(document.activeElement?.tagName).toBe("BUTTON");
    expect(document.activeElement?.textContent).toContain("Keyboard Move");
    expect((document.activeElement as HTMLButtonElement).isConnected).toBe(true);
    expect(announcerText()).toContain("Adjusted to");
  });

  it("commit announces the NEW range in genuinely controlled mode (reads the accepted result, not a stale re-fetch)", async () => {
    function ControlledHost() {
      const [events, setEvents] = useState<GanttEvent[]>([
        { id: "kb-controlled", title: "Controlled Move", start: START, end: END },
      ]);
      return (
        <Gantt events={events} onEventsChange={setEvents} date={START} timeZone="UTC">
          <KeyedBarHost eventId="kb-controlled" />
        </Gantt>
      );
    }
    await render(<ControlledHost />);
    const bar = findBarByTitle("Controlled Move");
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "ArrowRight" });
    await keydown(bar, { key: "Enter" });
    // moved 09:00 -> 09:15 UTC; the announcement must carry the NEW start, not the old one.
    expect(announcerText()).toContain("9:15 AM");
    expect(announcerText()).not.toContain("9:00 AM");
  });

  it("Space, ArrowLeft, Enter moves the bar earlier", async () => {
    const onEventsChange = vi.fn();
    const event: GanttEvent = { id: "kb-move-left", title: "Move Left", start: START, end: END };
    await render(
      <Gantt events={[event]} onEventsChange={onEventsChange} date={START} timeZone="UTC">
        <KeyedBarHost eventId="kb-move-left" />
      </Gantt>,
    );
    const bar = findBarByTitle("Move Left");
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "ArrowLeft" });
    await keydown(bar, { key: "Enter" });
    const [updated] = onEventsChange.mock.calls[0]![0] as GanttEvent[];
    expect(updated!.start.getTime()).toBe(START.getTime() - 15 * 60000);
    expect(updated!.end.getTime()).toBe(END.getTime() - 15 * 60000);
  });

  it("Space, E, ArrowRight, Enter resizes the END edge only, and keeps focus (the key does not change)", async () => {
    const onEventsChange = vi.fn();
    const event: GanttEvent = { id: "kb-resize-end", title: "Resize End", start: START, end: END };
    await render(
      <Gantt events={[event]} onEventsChange={onEventsChange} date={START} timeZone="UTC">
        <KeyedBarHost eventId="kb-resize-end" />
      </Gantt>,
    );
    const bar = findBarByTitle("Resize End");
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "e" });
    await keydown(bar, { key: "ArrowRight" });
    await keydown(bar, { key: "Enter" });
    const [updated] = onEventsChange.mock.calls[0]![0] as GanttEvent[];
    expect(updated!.start.getTime()).toBe(START.getTime());
    expect(updated!.end.getTime()).toBe(END.getTime() + 15 * 60000);
    // same occurrence key (start unchanged) - the ORIGINAL node should still be the one focused
    expect(document.activeElement).toBe(bar);
  });

  it("Space, S, ArrowLeft, Enter resizes the START edge only", async () => {
    const onEventsChange = vi.fn();
    const event: GanttEvent = { id: "kb-resize-start", title: "Resize Start", start: START, end: END };
    await render(
      <Gantt events={[event]} onEventsChange={onEventsChange} date={START} timeZone="UTC">
        <KeyedBarHost eventId="kb-resize-start" />
      </Gantt>,
    );
    const bar = findBarByTitle("Resize Start");
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "s" });
    await keydown(bar, { key: "ArrowLeft" });
    await keydown(bar, { key: "Enter" });
    const [updated] = onEventsChange.mock.calls[0]![0] as GanttEvent[];
    expect(updated!.start.getTime()).toBe(START.getTime() - 15 * 60000);
    expect(updated!.end.getTime()).toBe(END.getTime());
  });

  it("a locked start edge: Space still enters (move available); S is refused and announced, target stays move", async () => {
    const onEventsChange = vi.fn();
    const event: GanttEvent = {
      id: "kb-locked-start",
      title: "Locked Start",
      start: START,
      end: END,
      resizableEdges: { start: false },
    };
    await render(
      <Gantt events={[event]} onEventsChange={onEventsChange} date={START} timeZone="UTC">
        <KeyedBarHost eventId="kb-locked-start" />
      </Gantt>,
    );
    const bar = findBarByTitle("Locked Start");
    // aria-keyshortcuts is now binary: "Space" (move is still available), never the old per-chord list.
    expect(bar.getAttribute("aria-keyshortcuts")).toBe("Space");

    await focusBar(bar);
    await keydown(bar, { key: " " });
    const nativeEvent = await keydown(bar, { key: "s" });
    expect(nativeEvent.defaultPrevented).toBe(true); // "handled" - refused, not ignored
    expect(announcerText()).toBe("That target can't be adjusted.");
    expect(onEventsChange).not.toHaveBeenCalled();
    // the target is still "move" (S never took effect) - ArrowLeft moves the WHOLE bar
    await keydown(bar, { key: "ArrowLeft" });
    await keydown(bar, { key: "Enter" });
    const [updated] = onEventsChange.mock.calls[0]![0] as GanttEvent[];
    expect(updated!.start.getTime()).toBe(START.getTime() - 15 * 60000);
    expect(updated!.end.getTime()).toBe(END.getTime() - 15 * 60000);
  });

  it("onEventUpdate rejecting the COMMIT announces the rejected reason and applies nothing", async () => {
    const onEventsChange = vi.fn();
    const onEventUpdate = vi.fn(() => false);
    const event: GanttEvent = { id: "kb-rejected", title: "Rejected", start: START, end: END };
    await render(
      <Gantt events={[event]} onEventsChange={onEventsChange} onEventUpdate={onEventUpdate} date={START} timeZone="UTC">
        <KeyedBarHost eventId="kb-rejected" />
      </Gantt>,
    );
    const bar = findBarByTitle("Rejected");
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "ArrowRight" });
    expect(onEventUpdate).not.toHaveBeenCalled(); // preview-only step - no onEventUpdate yet
    await keydown(bar, { key: "Enter" });
    expect(onEventUpdate).toHaveBeenCalledTimes(1);
    expect(onEventsChange).not.toHaveBeenCalled();
    expect(announcerText()).toBe("That change was rejected.");
  });

  it("a clipped start edge (segment.isStart false): Space still enters (move); S is refused even though the EVENT itself allows it", async () => {
    const onEventsChange = vi.fn();
    const event: GanttEvent = { id: "kb-clipped", title: "Clipped", start: START, end: END };
    const occurrence: GanttOccurrence = {
      key: `${event.id}::${event.start.toISOString()}`,
      eventId: event.id,
      event,
      start: event.start,
      end: event.end,
      allDay: false,
      isRecurring: false,
    };
    const segment: GanttSegment = {
      occurrence,
      day: event.start,
      isStart: false,
      isEnd: true,
      continuesBefore: true,
      continuesAfter: false,
    };
    await render(
      <Gantt events={[event]} onEventsChange={onEventsChange} date={START} timeZone="UTC">
        <GanttBar segment={segment} />
      </Gantt>,
    );
    const bar = findBarByTitle("Clipped");
    expect(bar.getAttribute("aria-keyshortcuts")).toBe("Space");
    await focusBar(bar);
    await keydown(bar, { key: " " });
    const nativeEvent = await keydown(bar, { key: "s" });
    expect(nativeEvent.defaultPrevented).toBe(true);
    expect(announcerText()).toBe("That target can't be adjusted.");
    expect(onEventsChange).not.toHaveBeenCalled();
  });

  it("a non-draggable event: Space still enters via the first resizable edge; M is refused", async () => {
    const event: GanttEvent = { id: "kb-fixed", title: "Fixed Bar", start: START, end: END, draggable: false };
    await render(
      <Gantt events={[event]} date={START} timeZone="UTC">
        <KeyedBarHost eventId="kb-fixed" />
      </Gantt>,
    );
    const bar = findBarByTitle("Fixed Bar");
    expect(bar.getAttribute("aria-keyshortcuts")).toBe("Space");
    await focusBar(bar);
    await keydown(bar, { key: " " });
    expect(announcerText()).toContain("start"); // default target: first resizable edge (start)
    const nativeEvent = await keydown(bar, { key: "m" });
    expect(nativeEvent.defaultPrevented).toBe(true);
    expect(announcerText()).toBe("That target can't be adjusted.");
  });

  it("a fully locked, non-recurring bar: aria-keyshortcuts is null; Space does not enter, and NATIVE ACTIVATION (keydown+keyup+click, as a browser does for Space on a button) still opens the event exactly once", async () => {
    const onEventClick = vi.fn();
    const event: GanttEvent = {
      id: "kb-fully-locked",
      title: "Fully Locked",
      start: START,
      end: END,
      draggable: false,
      resizableEdges: { start: false, end: false },
    };
    await render(
      <Gantt events={[event]} onEventClick={onEventClick} date={START} timeZone="UTC">
        <KeyedBarHost eventId="kb-fully-locked" />
      </Gantt>,
    );
    const bar = findBarByTitle("Fully Locked");
    expect(bar.getAttribute("aria-keyshortcuts")).toBeNull();
    await focusBar(bar);
    const { keydown: nativeEvent, click } = await nativeSpaceActivate(bar);
    expect(nativeEvent.defaultPrevented).toBe(false);
    expect(click.defaultPrevented).toBe(false);
    expect(bar.getAttribute("data-adjusting")).toBeNull();
    expect(bar.getAttribute("role")).not.toBe("application");
    // The actual proof "native activate still available" was only asserted by implication before
    // (Sol re-review round 2, LOW) - this is the open itself, exactly once.
    expect(onEventClick).toHaveBeenCalledTimes(1);
  });

  it("a recurring occurrence: aria-keyshortcuts is null; Space does not enter Adjust mode, and NATIVE ACTIVATION (keydown+keyup+click) still opens the event exactly once", async () => {
    const onEventsChange = vi.fn();
    const onEventClick = vi.fn();
    const event: GanttEvent = {
      id: "kb-recurring",
      title: "Recurring",
      start: START,
      end: END,
      recurrence: { freq: "daily" },
    };
    await render(
      <Gantt events={[event]} onEventsChange={onEventsChange} onEventClick={onEventClick} date={START} timeZone="UTC">
        <KeyedBarHost eventId="kb-recurring" />
      </Gantt>,
    );
    const bar = findBarByTitle("Recurring");
    expect(bar.getAttribute("aria-keyshortcuts")).toBeNull();
    await focusBar(bar);
    const { keydown: nativeEvent, click } = await nativeSpaceActivate(bar);
    expect(onEventsChange).not.toHaveBeenCalled();
    expect(nativeEvent.defaultPrevented).toBe(false);
    expect(click.defaultPrevented).toBe(false);
    expect(bar.getAttribute("data-adjusting")).toBeNull();
    expect(onEventClick).toHaveBeenCalledTimes(1);
  });

  it("a plain ArrowRight while idle is left alone: not prevented, not entering Adjust mode, and the consumer's own onKeyDown still fires", async () => {
    const onEventsChange = vi.fn();
    const onKeyDown = vi.fn();
    const event: GanttEvent = { id: "kb-plain-arrow", title: "Plain Arrow", start: START, end: END };
    await render(
      <Gantt events={[event]} onEventsChange={onEventsChange} date={START} timeZone="UTC">
        <KeyedBarHost eventId="kb-plain-arrow" onKeyDown={onKeyDown} />
      </Gantt>,
    );
    const bar = findBarByTitle("Plain Arrow");
    await focusBar(bar);
    const nativeEvent = await keydown(bar, { key: "ArrowRight" });
    expect(onEventsChange).not.toHaveBeenCalled();
    expect(nativeEvent.defaultPrevented).toBe(false);
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect((onKeyDown.mock.calls[0]![0] as ReactKeyboardEvent).defaultPrevented).toBe(false);
    expect(bar.getAttribute("data-adjusting")).toBeNull();
  });

  it("Space still composes the consumer's onKeyDown (never replaces it), on an event it prevented", async () => {
    const onEventsChange = vi.fn();
    const onKeyDown = vi.fn();
    const event: GanttEvent = { id: "kb-composed", title: "Composed", start: START, end: END };
    await render(
      <Gantt events={[event]} onEventsChange={onEventsChange} date={START} timeZone="UTC">
        <KeyedBarHost eventId="kb-composed" onKeyDown={onKeyDown} />
      </Gantt>,
    );
    const bar = findBarByTitle("Composed");
    await focusBar(bar);
    const nativeEvent = await keydown(bar, { key: " " });
    expect(nativeEvent.defaultPrevented).toBe(true);
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    await keydown(bar, { key: "ArrowRight" });
    await keydown(bar, { key: "Enter" });
    expect(onEventsChange).toHaveBeenCalledTimes(1);
  });

  it("respects RTL the way the splitter's key handler does: ArrowRight while adjusting moves EARLIER under direction: rtl", async () => {
    const onEventsChange = vi.fn();
    const event: GanttEvent = { id: "kb-rtl", title: "RTL Move", start: START, end: END };
    await render(
      <Gantt events={[event]} onEventsChange={onEventsChange} date={START} timeZone="UTC">
        <KeyedBarHost eventId="kb-rtl" />
      </Gantt>,
    );
    const bar = findBarByTitle("RTL Move");
    bar.style.direction = "rtl";
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "ArrowRight" });
    await keydown(bar, { key: "Enter" });
    const [updated] = onEventsChange.mock.calls[0]![0] as GanttEvent[];
    // mirrored: physically-right ArrowRight reads as the EARLIER logical direction under RTL
    expect(updated!.start.getTime()).toBe(START.getTime() - 15 * 60000);
    expect(updated!.end.getTime()).toBe(END.getTime() - 15 * 60000);
  });

  // #219 PR A fix (Sol review, sol1 item 6) - the focus hand-off. Unchanged from the old file:
  // these exercise `internals.claimKeyboardFocus`/`consumeKeyboardFocus` directly, not a chord.

  it("two Gantt instances with the SAME event id never steal focus from each other", async () => {
    const eventA: GanttEvent = { id: "shared-id", title: "Instance A", start: START, end: END };
    const eventB: GanttEvent = { id: "shared-id", title: "Instance B", start: START, end: END };
    const internalsA: { current: GanttInternals | null } = { current: null };

    function InstanceA() {
      const instance = useGantt();
      useEffect(() => {
        internalsA.current = instance.internals;
      });
      return <KeyedBarHost eventId="shared-id" />;
    }

    const host2 = document.createElement("div");
    document.body.appendChild(host2);
    const root2 = createRoot(host2);
    await act(async () => {
      root!.render(
        <Gantt events={[eventA]} date={START} timeZone="UTC">
          <InstanceA />
        </Gantt>,
      );
      root2.render(
        <Gantt events={[eventB]} date={START} timeZone="UTC">
          <KeyedBarHost eventId="shared-id" />
        </Gantt>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const key = `shared-id::${START.toISOString()}`;
    await act(async () => {
      internalsA.current!.claimKeyboardFocus({ eventId: "shared-id", targetKey: key });
    });

    await act(async () => {
      root2.render(<div key="remount-b" />);
      await Promise.resolve();
    });
    await act(async () => {
      root2.render(
        <Gantt events={[eventB]} date={START} timeZone="UTC">
          <KeyedBarHost eventId="shared-id" />
        </Gantt>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const barB = [...host2.querySelectorAll("button")].find((el) => el.textContent?.includes("Instance B"));
    expect(barB).toBeTruthy();
    expect(document.activeElement).not.toBe(barB);

    await act(async () => {
      root2.unmount();
      await Promise.resolve();
    });
    host2.remove();
  });

  it("a stale claimed token (nothing ever mounts to consume it) does not steal focus from a LATER, unrelated mount of a bar for the same event id + key (#219 PR A, Sol re-review round 2, MEDIUM #6: expires after exactly ONE subsequent notify, not two)", async () => {
    const event: GanttEvent = { id: "stale-ev", title: "Stale", start: START, end: END };
    const internalsHolder: { current: GanttInternals | null } = { current: null };
    const setMountedHolder: { current: ((v: boolean) => void) | null } = { current: null };

    function Host({ mounted }: { mounted: boolean }) {
      const instance = useGantt();
      useEffect(() => {
        internalsHolder.current = instance.internals;
      });
      if (!mounted) return null;
      return <KeyedBarHost eventId="stale-ev" />;
    }

    function Wrapper() {
      const [mounted, setMounted] = useState(false);
      useEffect(() => {
        setMountedHolder.current = setMounted;
      }, []);
      return (
        <Gantt events={[event]} date={START} timeZone="UTC">
          <Host mounted={mounted} />
        </Gantt>
      );
    }

    await render(<Wrapper />);
    const internals = internalsHolder.current!;
    const key = `stale-ev::${START.toISOString()}`;

    await act(async () => {
      internals.claimKeyboardFocus({ eventId: "stale-ev", targetKey: key });
    });
    // Exactly ONE subsequent, unrelated notify() is now enough to expire an unconsumed token -
    // see `gantt.tsx`'s `notify()` doc comment.
    await act(async () => {
      internals.setViewportCenter(new Date(START.getTime() + 1000));
    });

    await act(async () => {
      setMountedHolder.current!(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    const bar = findBarByTitle("Stale");
    expect(document.activeElement).not.toBe(bar);
  });

  it("StrictMode's double-invoked effects still land focus on the replacement bar exactly once, with no error", async () => {
    function ControlledHost() {
      const [events, setEvents] = useState<GanttEvent[]>([
        { id: "kb-strict", title: "Strict Move", start: START, end: END },
      ]);
      return (
        <StrictMode>
          <Gantt events={events} onEventsChange={setEvents} date={START} timeZone="UTC">
            <KeyedBarHost eventId="kb-strict" />
          </Gantt>
        </StrictMode>
      );
    }
    await render(<ControlledHost />);
    const bar = findBarByTitle("Strict Move");
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "ArrowRight" });
    await keydown(bar, { key: "Enter" });
    expect(bar.isConnected).toBe(false);
    expect(document.activeElement?.tagName).toBe("BUTTON");
    expect(document.activeElement?.textContent).toContain("Strict Move");
    expect((document.activeElement as HTMLButtonElement).isConnected).toBe(true);
  });

  it("a consumer-supplied ref on <GanttBar> still receives the DOM node across a commit's remount", async () => {
    const consumerRef = { current: null as HTMLButtonElement | null };
    function ControlledHost() {
      const [events, setEvents] = useState<GanttEvent[]>([
        { id: "kb-ref", title: "Ref Target", start: START, end: END },
      ]);
      return (
        <Gantt events={events} onEventsChange={setEvents} date={START} timeZone="UTC">
          <KeyedBarHost eventId="kb-ref" barRef={consumerRef} />
        </Gantt>
      );
    }
    await render(<ControlledHost />);
    const bar = findBarByTitle("Ref Target");
    expect(consumerRef.current).toBe(bar);

    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "ArrowRight" });
    await keydown(bar, { key: "Enter" });
    expect(bar.isConnected).toBe(false);
    expect(consumerRef.current).not.toBeNull();
    expect(consumerRef.current!.isConnected).toBe(true);
    expect(document.activeElement).toBe(consumerRef.current);
  });

  // ---- New Adjust-mode-only coverage (not present in the old chord-scheme file) ----

  it("Space sets role=application, data-adjusting, aria-describedby, and announces the instructions plus the current range", async () => {
    const event: GanttEvent = { id: "adj-enter", title: "Enter Adjust", start: START, end: END };
    await render(
      <Gantt events={[event]} date={START} timeZone="UTC">
        <KeyedBarHost eventId="adj-enter" />
      </Gantt>,
    );
    const bar = findBarByTitle("Enter Adjust");
    await focusBar(bar);
    await keydown(bar, { key: " " });
    expect(bar.getAttribute("role")).toBe("application");
    expect(bar.getAttribute("data-adjusting")).not.toBeNull();
    const describedBy = bar.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const instructions = host.querySelector(`#${describedBy}`);
    expect(instructions?.textContent).toContain("Adjust mode");
    expect(instructions?.className).toContain("sr-only");
    expect(announcerText()).toContain("Adjust mode");
    expect(announcerText()).toContain("9:00 AM");
  });

  it("ArrowRight x2 while adjusting applies ZERO onEventUpdate calls and drives state.drag with the SAME shape a pointer gesture would", async () => {
    const onEventUpdate = vi.fn(() => true);
    const internalsRef: { current: GanttInternals | null } = { current: null };
    const getStateRef: {
      current: (() => ReturnType<ReturnType<typeof useGantt>["getState"]>) | null;
    } = { current: null };
    const event: GanttEvent = {
      id: "adj-preview",
      title: "Preview Only",
      start: START,
      end: END,
      color: "#ff0000",
    };
    await render(
      <Gantt events={[event]} onEventUpdate={onEventUpdate} date={START} timeZone="UTC">
        <InternalsProbe internalsRef={internalsRef} getStateRef={getStateRef} />
        <KeyedBarHost eventId="adj-preview" />
      </Gantt>,
    );
    const bar = findBarByTitle("Preview Only");
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "ArrowRight" });
    await keydown(bar, { key: "ArrowRight" });
    expect(onEventUpdate).not.toHaveBeenCalled();

    // Two accepted 15-minute steps: the preview (and the ghost-feeding state.drag it drives) is
    // 30 minutes past START/END, in the EXACT shape gantt-dnd.tsx's own applyProposal produces -
    // this is what feeds gantt-view.tsx's existing ghost-preview render path unchanged.
    const state = getStateRef.current!();
    expect(state.adjust?.preview).toEqual({
      start: new Date(START.getTime() + 30 * 60000),
      end: new Date(END.getTime() + 30 * 60000),
      allDay: false,
    });
    expect(state.drag).toEqual({
      kind: "move",
      occurrence: expect.objectContaining({ eventId: "adj-preview" }),
      proposedStart: new Date(START.getTime() + 30 * 60000),
      proposedEnd: new Date(END.getTime() + 30 * 60000),
      proposedAllDay: false,
      proposedResourceId: undefined,
      valid: true,
      source: "keyboard", // #219 PR A fix (Sol re-review round 2, HIGH #4)
    });
  });

  it("Escape cancels: zero updates, range equals the entry snapshot, role/data-adjusting cleared, cancellation announced", async () => {
    const onEventsChange = vi.fn();
    const onEventUpdate = vi.fn(() => true);
    const event: GanttEvent = { id: "adj-escape", title: "Escape Me", start: START, end: END };
    await render(
      <Gantt events={[event]} onEventsChange={onEventsChange} onEventUpdate={onEventUpdate} date={START} timeZone="UTC">
        <KeyedBarHost eventId="adj-escape" />
      </Gantt>,
    );
    const bar = findBarByTitle("Escape Me");
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "ArrowRight" });
    await keydown(bar, { key: "ArrowRight" });
    await keydown(bar, { key: "Escape" });
    expect(onEventUpdate).not.toHaveBeenCalled();
    expect(onEventsChange).not.toHaveBeenCalled();
    expect(bar.getAttribute("role")).not.toBe("application");
    expect(bar.getAttribute("data-adjusting")).toBeNull();
    expect(announcerText()).toBe("Adjustment cancelled.");
    // the model never moved
    expect(bar.getAttribute("aria-label")).toContain("9:00");
  });

  it("blur cancels: zero updates, cancellation announced, session cleared", async () => {
    const onEventsChange = vi.fn();
    const event: GanttEvent = { id: "adj-blur", title: "Blur Me", start: START, end: END };
    // Appended to document.body, NOT `host` - `host` is React's own createRoot container
    // (exclusively owned by this test's root), and inserting an untracked sibling into it BEFORE
    // React has rendered confuses React's reconciliation on the NEXT commit (it unmounts the whole
    // tree) - a real bug this test tripped over, not a real assertion about GanttBar itself.
    const other = document.createElement("button");
    document.body.appendChild(other);
    await render(
      <Gantt events={[event]} onEventsChange={onEventsChange} date={START} timeZone="UTC">
        <KeyedBarHost eventId="adj-blur" />
      </Gantt>,
    );
    const bar = findBarByTitle("Blur Me");
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "ArrowRight" });
    // A real focus move (not a synthetic "blur" event, which does not bubble and would need to be
    // "focusout" to reach React's delegated listener) - `other.focus()` blurs `bar` natively.
    await act(async () => {
      other.focus();
      await Promise.resolve();
    });
    expect(onEventsChange).not.toHaveBeenCalled();
    expect(announcerText()).toBe("Adjustment cancelled.");
    expect(bar.getAttribute("data-adjusting")).toBeNull();
    other.remove();
  });

  it("a pointer-down elsewhere in the document cancels the session", async () => {
    const onEventsChange = vi.fn();
    const event: GanttEvent = { id: "adj-pointer-elsewhere", title: "Pointer Elsewhere", start: START, end: END };
    // Appended to document.body, not `host` - see the blur test's own comment above.
    const elsewhere = document.createElement("div");
    document.body.appendChild(elsewhere);
    await render(
      <Gantt events={[event]} onEventsChange={onEventsChange} date={START} timeZone="UTC">
        <KeyedBarHost eventId="adj-pointer-elsewhere" />
      </Gantt>,
    );
    const bar = findBarByTitle("Pointer Elsewhere");
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "ArrowRight" });
    expect(bar.getAttribute("data-adjusting")).not.toBeNull();
    await act(async () => {
      elsewhere.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await Promise.resolve();
    });
    expect(onEventsChange).not.toHaveBeenCalled();
    expect(announcerText()).toBe("Adjustment cancelled.");
    expect(bar.getAttribute("data-adjusting")).toBeNull();
    elsewhere.remove();
  });

  it("the shared overlap 'reject' policy refuses a step; the announcer names the reason and nothing commits", async () => {
    const onEventsChange = vi.fn();
    const a: GanttEvent = { id: "adj-a", title: "A", start: START, end: END, resourceId: "r1" };
    const b: GanttEvent = { id: "adj-b", title: "B", start: END, end: new Date(END.getTime() + 60 * 60000), resourceId: "r1" };
    await render(
      <Gantt events={[a, b]} onEventsChange={onEventsChange} overlap="reject" date={START} timeZone="UTC">
        <KeyedBarHost eventId="adj-a" />
      </Gantt>,
    );
    const bar = findBarByTitle("A");
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "ArrowRight" });
    expect(announcerText()).toBe("That change was rejected.");
    await keydown(bar, { key: "Enter" });
    // no net change (the refused step never moved the preview) - the session just closes
    expect(announcerText()).toBe("No change made.");
    expect(onEventsChange).not.toHaveBeenCalled();
  });
});
