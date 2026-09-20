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
    // sol1 item 7: a successful nudge's result now also carries the accepted range.
    expect(apiRef.current!.nudgeEvent("e-not-draggable", "resize-end", 1)).toEqual({
      applied: true,
      start: START,
      end: new Date(END.getTime() + 15 * 60000),
      allDay: false,
    });
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
    expect(result).toEqual({
      applied: true,
      start: new Date(START.getTime() + 15 * 60000),
      end: new Date(END.getTime() + 15 * 60000),
      allDay: false,
    });
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
    expect(result).toEqual({
      applied: true,
      start: new Date(START.getTime() + 15 * 60000),
      end: new Date(END.getTime() + 15 * 60000),
      allDay: false,
    });
    const [next] = onEventsChange.mock.calls[0]![0] as GanttEvent[];
    expect(next!.start.getTime()).toBe(START.getTime() + 15 * 60000);
    expect(next!.end.getTime()).toBe(END.getTime() + 15 * 60000);
  });

  it("refuses on a recurring event's master — no action ever nudges the SERIES, per event.recurrence (sol1 item 2)", async () => {
    const apiRef = apiRefOf();
    const onEventsChange = vi.fn();
    const event: GanttEvent = {
      id: "e-recurring",
      title: "Recurring",
      start: START,
      end: END,
      recurrence: { freq: "daily" },
    };
    await render(<Gantt apiRef={apiRef} events={[event]} onEventsChange={onEventsChange} timeZone="UTC" />);
    expect(apiRef.current!.nudgeEvent("e-recurring", "move", 1)).toEqual({ applied: false, reason: "locked" });
    expect(apiRef.current!.nudgeEvent("e-recurring", "resize-start", -1)).toEqual({ applied: false, reason: "locked" });
    expect(apiRef.current!.nudgeEvent("e-recurring", "resize-end", 1)).toEqual({ applied: false, reason: "locked" });
    expect(onEventsChange).not.toHaveBeenCalled();
  });

  it("the overlap 'reject' policy blocks a nudge that would overlap a sibling on the same resource", async () => {
    const apiRef = apiRefOf();
    const onEventsChange = vi.fn();
    const a: GanttEvent = { id: "e-a", title: "A", start: START, end: END, resourceId: "r1" };
    // A moved forward one 15-minute step becomes 09:15-10:15; B (10:00-11:00) overlaps that.
    const b: GanttEvent = { id: "e-b", title: "B", start: END, end: new Date(END.getTime() + 60 * 60000), resourceId: "r1" };
    await render(
      <Gantt apiRef={apiRef} events={[a, b]} onEventsChange={onEventsChange} overlap="reject" date={START} timeZone="UTC" />,
    );
    const result = apiRef.current!.nudgeEvent("e-a", "move", 1);
    expect(result).toEqual({ applied: false, reason: "rejected" });
    expect(onEventsChange).not.toHaveBeenCalled();
  });

  // #219 PR A fix (Sol review, sol1 item 3) — nudgeEvent now shares gantt-dnd.tsx's overlap
  // policy/clamp helpers, honours the caller's viewScheduleMode, and queries a range wide enough
  // to see a same-resource neighbour outside the current viewport.
  it("the overlap 'clamp' policy stops the nudge at the neighbour's edge instead of ignoring it (previously ignored entirely)", async () => {
    const apiRef = apiRefOf();
    const onEventsChange = vi.fn();
    const a: GanttEvent = { id: "e-a", title: "A", start: START, end: END, resourceId: "r1" };
    // Neighbour sits 5 minutes past A's end: a 15-minute move step would overlap it by 10 minutes.
    const bStart = new Date(END.getTime() + 5 * 60000);
    const b: GanttEvent = { id: "e-b", title: "B", start: bStart, end: new Date(bStart.getTime() + 60 * 60000), resourceId: "r1" };
    await render(
      <Gantt apiRef={apiRef} events={[a, b]} onEventsChange={onEventsChange} overlap="clamp" date={START} timeZone="UTC" />,
    );
    const result = apiRef.current!.nudgeEvent("e-a", "move", 1);
    // Parked against the neighbour's start, duration preserved (1h), NOT the raw 09:15-10:15 step -
    // and the result itself (sol1 item 7) reports this CLAMPED range, not the raw proposal.
    const clampedEnd = bStart;
    const clampedStart = new Date(bStart.getTime() - (END.getTime() - START.getTime()));
    expect(result).toEqual({ applied: true, start: clampedStart, end: clampedEnd, allDay: false });
    const [next] = onEventsChange.mock.calls[0]![0] as GanttEvent[];
    expect(next!.end.getTime()).toBe(clampedEnd.getTime());
    expect(next!.start.getTime()).toBe(clampedStart.getTime());
  });

  it("without a passed-in viewScheduleMode, overlap 'allow' (the default) lets a same-resource nudge through", async () => {
    const apiRef = apiRefOf();
    const onEventsChange = vi.fn();
    const a: GanttEvent = { id: "e-a", title: "A", start: START, end: END, resourceId: "r1" };
    const b: GanttEvent = { id: "e-b", title: "B", start: END, end: new Date(END.getTime() + 60 * 60000), resourceId: "r1" };
    await render(<Gantt apiRef={apiRef} events={[a, b]} onEventsChange={onEventsChange} date={START} timeZone="UTC" />);
    expect(apiRef.current!.nudgeEvent("e-a", "move", 1)).toEqual({
      applied: true,
      start: new Date(START.getTime() + 15 * 60000),
      end: new Date(END.getTime() + 15 * 60000),
      allDay: false,
    });
    expect(onEventsChange).toHaveBeenCalledTimes(1);
  });

  it("an explicit viewScheduleMode='single' rejects the SAME nudge that 'allow' (no scheduleMode passed) would accept", async () => {
    const apiRef = apiRefOf();
    const onEventsChange = vi.fn();
    const a: GanttEvent = { id: "e-a", title: "A", start: START, end: END, resourceId: "r1" };
    const b: GanttEvent = { id: "e-b", title: "B", start: END, end: new Date(END.getTime() + 60 * 60000), resourceId: "r1" };
    // overlap defaults to "allow" - no scheduleMode override on the node either; only the CALLER
    // passing the view's "single" default (what a bar inside <Gantt scheduleMode="single"> does)
    // makes this reject - this is the view-level parity gap sol1 item 3 closes.
    await render(<Gantt apiRef={apiRef} events={[a, b]} onEventsChange={onEventsChange} date={START} timeZone="UTC" />);
    const rejected = apiRef.current!.nudgeEvent("e-a", "move", 1, "single");
    expect(rejected).toEqual({ applied: false, reason: "rejected" });
    expect(onEventsChange).not.toHaveBeenCalled();
  });

  it("the overlap lookup sees a same-resource neighbour outside the current viewport (Sol MEDIUM, same fix)", async () => {
    const apiRef = apiRefOf();
    const onEventsChange = vi.fn();
    // date scale defaults to "day": visibleRange is exactly [2026-03-02T00:00Z, 2026-03-03T00:00Z).
    // A ends inside that day; the neighbour starts just after midnight on the NEXT day, entirely
    // outside the visible day, but a resize-end step lands the proposal's end 5 minutes into it.
    const aEnd = new Date("2026-03-02T23:50:00.000Z");
    const a: GanttEvent = { id: "e-a", title: "A", start: START, end: aEnd, resourceId: "r1" };
    const bStart = new Date("2026-03-03T00:00:00.000Z");
    const b: GanttEvent = { id: "e-b", title: "B", start: bStart, end: new Date("2026-03-03T01:00:00.000Z"), resourceId: "r1" };
    await render(
      <Gantt apiRef={apiRef} events={[a, b]} onEventsChange={onEventsChange} overlap="reject" date={START} timeZone="UTC" />,
    );
    const result = apiRef.current!.nudgeEvent("e-a", "resize-end", 1);
    expect(result).toEqual({ applied: false, reason: "rejected" });
    expect(onEventsChange).not.toHaveBeenCalled();
  });
});
