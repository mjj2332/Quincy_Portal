/**
 * #219 (PR A) stage 2, step 2 — `gantt.tsx`'s new `nudgeEvent` instance API method: the keyboard
 * equivalent of a pointer move/resize gesture, callable directly (no bar, no keydown) via
 * `<Gantt apiRef>`. DOM suite (`vitest.dom.config.ts`) only because `apiRef` is populated in a
 * `useEffect`, which needs a real React commit; nothing here selects DOM elements at all.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gantt } from "@/components/reui/gantt/gantt";
import type { GanttApi } from "@/components/reui/gantt/gantt";
import type { GanttEvent, GanttProposedUpdate } from "@/components/reui/gantt/gantt-types";

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

function apiRefOf() {
  return { current: null as GanttApi | null };
}

describe("GanttApi.nudgeEvent (#219 stage 2)", () => {
  it("a locked resize edge answers { applied: false, reason: 'locked' } and never calls onEventUpdate", async () => {
    const apiRef = apiRefOf();
    const onEventsChange = vi.fn();
    const onEventUpdate = vi.fn(() => true);
    const event: GanttEvent = {
      id: "e-locked-edge",
      title: "Locked start",
      start: START,
      end: END,
      resizableEdges: { start: false },
    };
    await render(
      <Gantt
        apiRef={apiRef}
        events={[event]}
        onEventsChange={onEventsChange}
        onEventUpdate={onEventUpdate}
        timeZone="UTC"
      />,
    );
    const result = apiRef.current!.nudgeEvent("e-locked-edge", "resize-start", -1);
    expect(result).toEqual({ applied: false, reason: "locked" });
    expect(onEventUpdate).not.toHaveBeenCalled();
    expect(onEventsChange).not.toHaveBeenCalled();
  });

  it("readOnly locks a move", async () => {
    const apiRef = apiRefOf();
    const event: GanttEvent = { id: "e-readonly", title: "Read only", start: START, end: END, readOnly: true };
    await render(<Gantt apiRef={apiRef} events={[event]} timeZone="UTC" />);
    expect(apiRef.current!.nudgeEvent("e-readonly", "move", 1)).toEqual({ applied: false, reason: "locked" });
  });

  it("draggable: false locks a move but leaves resize alone", async () => {
    const apiRef = apiRefOf();
    const onEventsChange = vi.fn();
    const event: GanttEvent = { id: "e-not-draggable", title: "Fixed", start: START, end: END, draggable: false };
    await render(<Gantt apiRef={apiRef} events={[event]} onEventsChange={onEventsChange} timeZone="UTC" />);
    expect(apiRef.current!.nudgeEvent("e-not-draggable", "move", 1)).toEqual({ applied: false, reason: "locked" });
    expect(apiRef.current!.nudgeEvent("e-not-draggable", "resize-end", 1)).toEqual({ applied: true });
  });

  it("an unknown event id answers { applied: false, reason: 'not-found' }", async () => {
    const apiRef = apiRefOf();
    await render(<Gantt apiRef={apiRef} events={[]} timeZone="UTC" />);
    expect(apiRef.current!.nudgeEvent("does-not-exist", "move", 1)).toEqual({
      applied: false,
      reason: "not-found",
    });
  });

  it("canDropEvent false WITH enforceCanDrop blocks the commit", async () => {
    const apiRef = apiRefOf();
    const onEventsChange = vi.fn();
    const canDropEvent = vi.fn(() => false);
    const event: GanttEvent = { id: "e-enforced", title: "Blocked", start: START, end: END };
    await render(
      <Gantt
        apiRef={apiRef}
        events={[event]}
        onEventsChange={onEventsChange}
        canDropEvent={canDropEvent}
        enforceCanDrop
        timeZone="UTC"
      />,
    );
    const result = apiRef.current!.nudgeEvent("e-enforced", "move", 1);
    expect(result).toEqual({ applied: false, reason: "rejected" });
    expect(canDropEvent).toHaveBeenCalled();
    expect(onEventsChange).not.toHaveBeenCalled();
  });

  it("canDropEvent false WITHOUT enforceCanDrop is advisory only — the nudge still applies", async () => {
    const apiRef = apiRefOf();
    const onEventsChange = vi.fn();
    const canDropEvent = vi.fn(() => false);
    const event: GanttEvent = { id: "e-advisory", title: "Advisory", start: START, end: END };
    await render(
      <Gantt apiRef={apiRef} events={[event]} onEventsChange={onEventsChange} canDropEvent={canDropEvent} timeZone="UTC" />,
    );
    const result = apiRef.current!.nudgeEvent("e-advisory", "move", 1);
    expect(result).toEqual({ applied: true });
    expect(onEventsChange).toHaveBeenCalledTimes(1);
  });

  it("onEventUpdate returning false rejects the nudge and emits nothing", async () => {
    const apiRef = apiRefOf();
    const onEventsChange = vi.fn();
    const onEventUpdate = vi.fn(() => false);
    const event: GanttEvent = { id: "e-vetoed", title: "Vetoed", start: START, end: END };
    await render(
      <Gantt apiRef={apiRef} events={[event]} onEventsChange={onEventsChange} onEventUpdate={onEventUpdate} timeZone="UTC" />,
    );
    const result = apiRef.current!.nudgeEvent("e-vetoed", "move", 1);
    expect(result).toEqual({ applied: false, reason: "rejected" });
    expect(onEventsChange).not.toHaveBeenCalled();
  });

  it("the emitted proposed update carries source: 'keyboard'", async () => {
    const apiRef = apiRefOf();
    const onEventUpdate = vi.fn((_update: GanttProposedUpdate) => true);
    const event: GanttEvent = { id: "e-sourced", title: "Sourced", start: START, end: END };
    await render(<Gantt apiRef={apiRef} events={[event]} onEventUpdate={onEventUpdate} timeZone="UTC" />);
    apiRef.current!.nudgeEvent("e-sourced", "move", 1);
    expect(onEventUpdate).toHaveBeenCalledTimes(1);
    const update = onEventUpdate.mock.calls[0]![0] as GanttProposedUpdate;
    expect(update.source).toBe("keyboard");
    expect(update.occurrence).toBeNull();
  });

  it("a successful move commits the exact proposed range (default day scale, 15-minute step)", async () => {
    const apiRef = apiRefOf();
    const onEventsChange = vi.fn();
    const event: GanttEvent = { id: "e-moved", title: "Moved", start: START, end: END };
    await render(<Gantt apiRef={apiRef} events={[event]} onEventsChange={onEventsChange} timeZone="UTC" />);
    const result = apiRef.current!.nudgeEvent("e-moved", "move", 1);
    expect(result).toEqual({ applied: true });
    const [next] = onEventsChange.mock.calls[0]![0] as GanttEvent[];
    expect(next!.start.getTime()).toBe(START.getTime() + 15 * 60000);
    expect(next!.end.getTime()).toBe(END.getTime() + 15 * 60000);
  });

  it("the overlap 'reject' policy blocks a nudge that would overlap a sibling on the same resource", async () => {
    const apiRef = apiRefOf();
    const onEventsChange = vi.fn();
    const a: GanttEvent = { id: "e-a", title: "A", start: START, end: END, resourceId: "r1" };
    // A moved forward one 15-minute step becomes 09:15-10:15; B (10:00-11:00) overlaps that.
    const b: GanttEvent = { id: "e-b", title: "B", start: END, end: new Date(END.getTime() + 60 * 60000), resourceId: "r1" };
    // nudgeEvent's overlap check reads api.getOccurrences() with no range, exactly like
    // beginGesture's own getNeighbours() in gantt-dnd.tsx - both are scoped to whatever the store's
    // CURRENT visibleRange is, so the fixture's own day must be the visible one.
    await render(
      <Gantt apiRef={apiRef} events={[a, b]} onEventsChange={onEventsChange} overlap="reject" date={START} timeZone="UTC" />,
    );
    const result = apiRef.current!.nudgeEvent("e-a", "move", 1);
    expect(result).toEqual({ applied: false, reason: "rejected" });
    expect(onEventsChange).not.toHaveBeenCalled();
  });
});
