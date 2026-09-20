/**
 * #219 (PR A) stage 2, step 2 — `gantt-bar.tsx`'s keyboard move/resize: the chords, `aria-
 * keyshortcuts`, the live-region announcement, and focus retention across the remount a move /
 * resize-start nudge causes (see that file's header for why the remount happens at all).
 *
 * `KeyedBarHost` reproduces the ONE piece of `gantt-view.tsx` this needs — a wrapping element keyed
 * on `segment.occurrence.key`, which embeds the occurrence's own start time — using the REAL
 * occurrence from the store (`instance.api.getOccurrences()`), not a hand-rolled key. Rendering the
 * full `<GanttView>` would pull in ResizeObserver-driven layout this test has no need of; this is
 * the minimal faithful reproduction of the actual remount hazard.
 *
 * Guard F (`test-seam.guard.test.ts`, issue #92): the live region is found by `[aria-live="polite"]`
 * (a standard ARIA attribute, not `data-slot`) rather than the vendor's own `[data-slot=gantt-
 * announcer]`. Bars are found by their accessible name (the aria-label `formatEventTime` composes,
 * matched via a substring of the event title) via a plain title-text query — role/name, not a
 * vendored `data-slot`.
 */
import { act, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gantt, useGantt, useGanttSelector } from "@/components/reui/gantt/gantt";
import { GanttBar } from "@/components/reui/gantt/gantt-bar";
import type { GanttEvent, GanttSegment } from "@/components/reui/gantt/gantt-types";

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

/** Focusing a bar opens the tooltip's own focus-driven state — wrap it so React sees the update. */
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

/** Reproduces gantt-view.tsx's own `<div key={segment.occurrence.key}><GanttBar .../></div>`. */
function KeyedBarHost({
  eventId,
  onKeyDown,
}: {
  eventId: string;
  /** Forwarded straight to `<GanttBar>` to exercise its consumer `onKeyDown` composition. */
  onKeyDown?: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
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
      <GanttBar segment={segment} onKeyDown={onKeyDown} />
    </div>
  );
}

function findBarByTitle(title: string): HTMLButtonElement {
  const bar = [...host.querySelectorAll("button")].find((el) => el.textContent?.includes(title));
  if (!bar) throw new Error(`no bar found for title ${title}`);
  return bar;
}

function announcerText(): string | null {
  return host.querySelector<HTMLElement>('[aria-live="polite"]')?.textContent ?? null;
}

describe("GanttBar keyboard move/resize (#219 stage 2)", () => {
  it("Alt+ArrowRight moves the bar later, keeps focus on it, and announces the new range", async () => {
    const onEventsChange = vi.fn();
    const event: GanttEvent = { id: "kb-move", title: "Keyboard Move", start: START, end: END };
    await render(
      <Gantt events={[event]} onEventsChange={onEventsChange} date={START} timeZone="UTC">
        <KeyedBarHost eventId="kb-move" />
      </Gantt>,
    );
    const bar = findBarByTitle("Keyboard Move");
    await focusBar(bar);
    expect(document.activeElement).toBe(bar);

    await keydown(bar, { key: "ArrowRight", altKey: true });

    expect(onEventsChange).toHaveBeenCalledTimes(1);
    const [updated] = onEventsChange.mock.calls[0]![0] as GanttEvent[];
    expect(updated!.start.getTime()).toBe(START.getTime() + 15 * 60000);
    expect(updated!.end.getTime()).toBe(END.getTime() + 15 * 60000);

    // The bar was remounted under a new occurrence key (its start changed) - the OLD `bar` node
    // is gone; focus must be on the bar that replaced it, not dropped to <body>.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.tagName).toBe("BUTTON");
    expect(document.activeElement?.textContent).toContain("Keyboard Move");

    expect(announcerText()).toContain("Keyboard Move");
  });

  it("announces the NEW range in genuinely controlled mode (sol1 item 7 - the old re-fetch read stale state)", async () => {
    // A REAL controlled wrapper: `events` comes from this component's own state, fed by
    // `onEventsChange`, the same as any real consumer. `nudgeEvent`'s commit and the live-region
    // announcement both happen SYNCHRONOUSLY inside the keydown handler, before React processes
    // the `setEvents` update this wrapper schedules - so a correct implementation must announce
    // from the value `nudgeEvent` itself computed and accepted, not a `getEvent` re-fetch (which,
    // under `events` being controlled, reads back the OLD prop value that this render closed over).
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
    await keydown(bar, { key: "ArrowRight", altKey: true });
    // moved 09:00 -> 09:15 UTC; the announcement must carry the NEW start, not the old one.
    expect(announcerText()).toContain("9:15 AM");
    expect(announcerText()).not.toContain("9:00 AM");
  });

  it("Alt+ArrowLeft moves the bar earlier", async () => {
    const onEventsChange = vi.fn();
    const event: GanttEvent = { id: "kb-move-left", title: "Move Left", start: START, end: END };
    await render(
      <Gantt events={[event]} onEventsChange={onEventsChange} date={START} timeZone="UTC">
        <KeyedBarHost eventId="kb-move-left" />
      </Gantt>,
    );
    const bar = findBarByTitle("Move Left");
    await focusBar(bar);
    await keydown(bar, { key: "ArrowLeft", altKey: true });
    const [updated] = onEventsChange.mock.calls[0]![0] as GanttEvent[];
    expect(updated!.start.getTime()).toBe(START.getTime() - 15 * 60000);
    expect(updated!.end.getTime()).toBe(END.getTime() - 15 * 60000);
  });

  it("Shift+Alt+ArrowRight resizes the END edge only, and keeps focus (the key does not change)", async () => {
    const onEventsChange = vi.fn();
    const event: GanttEvent = { id: "kb-resize-end", title: "Resize End", start: START, end: END };
    await render(
      <Gantt events={[event]} onEventsChange={onEventsChange} date={START} timeZone="UTC">
        <KeyedBarHost eventId="kb-resize-end" />
      </Gantt>,
    );
    const bar = findBarByTitle("Resize End");
    await focusBar(bar);
    await keydown(bar, { key: "ArrowRight", altKey: true, shiftKey: true });
    const [updated] = onEventsChange.mock.calls[0]![0] as GanttEvent[];
    expect(updated!.start.getTime()).toBe(START.getTime());
    expect(updated!.end.getTime()).toBe(END.getTime() + 15 * 60000);
    // same occurrence key (start unchanged) - the ORIGINAL node should still be the one focused
    expect(document.activeElement).toBe(bar);
  });

  it("Ctrl+Alt+ArrowLeft resizes the START edge only", async () => {
    const onEventsChange = vi.fn();
    const event: GanttEvent = { id: "kb-resize-start", title: "Resize Start", start: START, end: END };
    await render(
      <Gantt events={[event]} onEventsChange={onEventsChange} date={START} timeZone="UTC">
        <KeyedBarHost eventId="kb-resize-start" />
      </Gantt>,
    );
    const bar = findBarByTitle("Resize Start");
    await focusBar(bar);
    await keydown(bar, { key: "ArrowLeft", altKey: true, ctrlKey: true });
    const [updated] = onEventsChange.mock.calls[0]![0] as GanttEvent[];
    expect(updated!.start.getTime()).toBe(START.getTime() - 15 * 60000);
    expect(updated!.end.getTime()).toBe(END.getTime());
  });

  it("a locked start edge omits the start chord from aria-keyshortcuts, and the chord no-ops", async () => {
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
    const shortcuts = bar.getAttribute("aria-keyshortcuts");
    expect(shortcuts).toContain("Alt+ArrowLeft");
    expect(shortcuts).toContain("Shift+Alt+ArrowRight");
    expect(shortcuts).not.toContain("Control+Alt+");

    await focusBar(bar);
    await keydown(bar, { key: "ArrowLeft", altKey: true, ctrlKey: true });
    expect(onEventsChange).not.toHaveBeenCalled();
    expect(announcerText()).toBe("That can't be changed.");
    // the chord was still ours - preventDefault fired, focus never left the bar
    expect(document.activeElement).toBe(bar);
  });

  it("a non-draggable event omits the move chord from aria-keyshortcuts", async () => {
    const event: GanttEvent = { id: "kb-fixed", title: "Fixed Bar", start: START, end: END, draggable: false };
    await render(
      <Gantt events={[event]} date={START} timeZone="UTC">
        <KeyedBarHost eventId="kb-fixed" />
      </Gantt>,
    );
    const bar = findBarByTitle("Fixed Bar");
    const shortcuts = bar.getAttribute("aria-keyshortcuts");
    expect(shortcuts).not.toContain("Alt+ArrowLeft Alt+ArrowRight");
    // Alt+Arrow without Shift/Ctrl IS the move chord specifically
    expect(shortcuts?.split(" ")).not.toContain("Alt+ArrowLeft");
  });

  it("onEventUpdate rejecting the nudge announces the rejected reason and applies nothing", async () => {
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
    await keydown(bar, { key: "ArrowRight", altKey: true });
    expect(onEventsChange).not.toHaveBeenCalled();
    expect(announcerText()).toBe("That change was rejected.");
  });

  it("respects RTL the way the splitter's key handler does: Alt+ArrowRight moves EARLIER under direction: rtl", async () => {
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
    await keydown(bar, { key: "ArrowRight", altKey: true });
    const [updated] = onEventsChange.mock.calls[0]![0] as GanttEvent[];
    // mirrored: physically-right ArrowRight reads as the EARLIER logical direction under RTL
    expect(updated!.start.getTime()).toBe(START.getTime() - 15 * 60000);
    expect(updated!.end.getTime()).toBe(END.getTime() - 15 * 60000);
  });

  it("a recurring occurrence's bar advertises no keyboard chords, and a would-be-matching chord is left alone (sol1 item 2)", async () => {
    const onEventsChange = vi.fn();
    const event: GanttEvent = {
      id: "kb-recurring",
      title: "Recurring",
      start: START,
      end: END,
      recurrence: { freq: "daily" },
    };
    await render(
      <Gantt events={[event]} onEventsChange={onEventsChange} date={START} timeZone="UTC">
        <KeyedBarHost eventId="kb-recurring" />
      </Gantt>,
    );
    const bar = findBarByTitle("Recurring");
    expect(bar.getAttribute("aria-keyshortcuts")).toBeNull();

    await focusBar(bar);
    const nativeEvent = await keydown(bar, { key: "ArrowRight", altKey: true });
    expect(onEventsChange).not.toHaveBeenCalled();
    // Not ours to act on: never claimed via preventDefault either, so a page-level Alt+Arrow
    // fallback (or the browser's own) still runs - this bar did not silently swallow the key.
    expect(nativeEvent.defaultPrevented).toBe(false);
  });

  it("a chord that is not ours (plain ArrowRight, no Alt) is left alone: not prevented, not nudged, and the consumer's own onKeyDown still fires", async () => {
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
    // #219 PR A fix (Sol review, sol1 item 9): a chord that is not ours must leave
    // `defaultPrevented` false (not just "no nudge committed") ...
    expect(nativeEvent.defaultPrevented).toBe(false);
    // ... and gantt-bar.tsx's mergeProps composition (never replacement) of a consumer's own
    // onKeyDown must still run, exactly once, with that same un-prevented event.
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect((onKeyDown.mock.calls[0]![0] as ReactKeyboardEvent).defaultPrevented).toBe(false);
  });

  it("a chord that IS ours still composes the consumer's onKeyDown (never replaces it), on an event it prevented", async () => {
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
    const nativeEvent = await keydown(bar, { key: "ArrowRight", altKey: true });
    expect(onEventsChange).toHaveBeenCalledTimes(1);
    expect(nativeEvent.defaultPrevented).toBe(true);
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });
});
