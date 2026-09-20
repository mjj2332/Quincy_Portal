/**
 * #219 (PR A) stage 2, step 1 — the per-edge resize veto's DOM consequence. Owner decision on
 * #215: a project bar's shoot (start) edge is fixed and must draw no grip; only the deadline (end)
 * edge drags. `gantt-resize-edges.test.ts` covers the `canResize` predicate itself (node suite);
 * this covers what actually renders.
 *
 * Renders `<GanttBar>` directly inside a bare `<Gantt>` provider (both contexts `GanttBar` needs:
 * `useGantt`/`useGanttViewConfig`) rather than the full `<GanttView>` composition — the grip count
 * depends only on the bar, and a hand-built `GanttSegment` fixture is cheap.
 *
 * Guard F (`test-seam.guard.test.ts`, issue #92) forbids a DOM test from selecting
 * `[data-slot="X"]` where only a `components/reui/` file authors `X` — a version bump could rename
 * or drop it with no Quincy file to keep it stable. The grips carry `data-slot="gantt-resize-handle"`
 * (vendor-authored, un-selectable here) but ALSO a `data-testid` (`gantt-resize-handle-start` /
 * `-end`) added in `gantt-bar.tsx` for exactly this: a minimal additive hook, not `data-slot`, so
 * Guard F does not govern it either way. There is no Quincy component composing this deep inside
 * the vendor's render tree to hang the testid on instead (`<GanttBar>`'s own consumer props reach
 * only the outer `<button>`), so the vendor file is the honest place for it — see that file's
 * header for the same note.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Gantt } from "@/components/reui/gantt/gantt";
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

const START = new Date("2026-02-01T00:00:00.000Z");
const END = new Date("2026-02-04T00:00:00.000Z");

function makeSegment(event: GanttEvent): GanttSegment {
  const occurrence: GanttOccurrence = {
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
    day: event.start,
    isStart: true,
    isEnd: true,
    continuesBefore: false,
    continuesAfter: false,
  };
}

const startGripCount = () => host.querySelectorAll('[data-testid="gantt-resize-handle-start"]').length;
const endGripCount = () => host.querySelectorAll('[data-testid="gantt-resize-handle-end"]').length;

describe("GanttBar resize grips — per-edge veto (#219 stage 2)", () => {
  it("an unlocked bar renders both grips", async () => {
    const event: GanttEvent = { id: "e1", title: "Unlocked", start: START, end: END };
    await render(
      <Gantt events={[event]} timeZone="UTC">
        <GanttBar segment={makeSegment(event)} />
      </Gantt>,
    );
    expect(startGripCount()).toBe(1);
    expect(endGripCount()).toBe(1);
  });

  it("a start-locked bar (stands in for a project bar's fixed shoot edge) renders exactly one grip", async () => {
    const event: GanttEvent = {
      id: "e2",
      title: "Start-locked",
      start: START,
      end: END,
      resizableEdges: { start: false },
    };
    await render(
      <Gantt events={[event]} timeZone="UTC">
        <GanttBar segment={makeSegment(event)} />
      </Gantt>,
    );
    expect(startGripCount()).toBe(0);
    expect(endGripCount()).toBe(1);
  });

  it("an end-locked bar renders exactly one grip, the start one", async () => {
    const event: GanttEvent = {
      id: "e3",
      title: "End-locked",
      start: START,
      end: END,
      resizableEdges: { end: false },
    };
    await render(
      <Gantt events={[event]} timeZone="UTC">
        <GanttBar segment={makeSegment(event)} />
      </Gantt>,
    );
    expect(startGripCount()).toBe(1);
    expect(endGripCount()).toBe(0);
  });

  it("a fully non-resizable bar renders no grips", async () => {
    const event: GanttEvent = { id: "e4", title: "Locked", start: START, end: END, resizable: false };
    await render(
      <Gantt events={[event]} timeZone="UTC">
        <GanttBar segment={makeSegment(event)} />
      </Gantt>,
    );
    expect(startGripCount()).toBe(0);
    expect(endGripCount()).toBe(0);
  });
});
