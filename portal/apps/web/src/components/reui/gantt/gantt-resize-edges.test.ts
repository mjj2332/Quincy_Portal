/**
 * #219 (PR A) stage 2, step 1 — the per-edge resize veto. Owner decision on #215: a project bar's
 * shoot (start) edge is fixed and must draw no grip; only the deadline (end) edge drags.
 *
 * Node suite (`vitest.config.ts`): exercises `gantt-dnd.tsx`'s extracted, React-free `canResize`
 * directly, with hand-built `GanttSegment` fixtures — no React, no store, no DOM. The DOM
 * consequence (a start-locked bar renders exactly one grip) is covered separately in
 * `gantt-bar-resize-grips.dom.test.tsx`.
 */
import { describe, expect, it } from "vitest";
import { canResize } from "@/components/reui/gantt/gantt-dnd";
import type { GanttEvent, GanttOccurrence, GanttSegment } from "@/components/reui/gantt/gantt-types";

const START = new Date("2026-01-05T00:00:00.000Z");
const END = new Date("2026-01-08T00:00:00.000Z");

function makeSegment(
  eventOverrides: Partial<GanttEvent> = {},
  range: { start: Date; end: Date } = { start: START, end: END },
): GanttSegment {
  const event: GanttEvent = {
    id: "evt-1",
    title: "Test event",
    start: range.start,
    end: range.end,
    ...eventOverrides,
  };
  const occurrence: GanttOccurrence = {
    key: `${event.id}::${range.start.toISOString()}`,
    eventId: event.id,
    event,
    start: range.start,
    end: range.end,
    allDay: false,
    isRecurring: false,
  };
  return {
    occurrence,
    day: range.start,
    isStart: true,
    isEnd: true,
    continuesBefore: false,
    continuesAfter: false,
  };
}

describe("canResize (#219 stage 2) — per-edge truth table", () => {
  it.each<[string, Partial<GanttEvent>, boolean, boolean, boolean]>([
    ["default (nothing set)", {}, true, true, true],
    ["resizable: false", { resizable: false }, false, false, false],
    ["resizableEdges omitted", { resizableEdges: {} }, true, true, true],
    ["start locked", { resizableEdges: { start: false } }, true, false, true],
    ["end locked", { resizableEdges: { end: false } }, true, true, false],
    ["both locked", { resizableEdges: { start: false, end: false } }, true, false, false],
    ["readOnly", { readOnly: true }, false, false, false],
  ])("%s", (_label, overrides, anyEdge, startEdge, endEdge) => {
    const segment = makeSegment(overrides);
    expect(canResize(segment)).toBe(anyEdge);
    expect(canResize(segment, "start")).toBe(startEdge);
    expect(canResize(segment, "end")).toBe(endEdge);
  });

  it("a milestone (start === end) never resizes, on any edge or none", () => {
    const segment = makeSegment({}, { start: START, end: START });
    expect(canResize(segment)).toBe(false);
    expect(canResize(segment, "start")).toBe(false);
    expect(canResize(segment, "end")).toBe(false);
  });

  it("interactions.resize off vetoes every edge, independent of the event", () => {
    const segment = makeSegment({});
    expect(canResize(segment, undefined, false)).toBe(false);
    expect(canResize(segment, "start", false)).toBe(false);
    expect(canResize(segment, "end", false)).toBe(false);
  });
});
