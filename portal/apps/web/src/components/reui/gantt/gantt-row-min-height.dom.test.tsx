/**
 * #916 / #919 — `GanttResource.minRowHeight` (additive): a per-node floor on the row's height, read
 * beside the view's `metrics.minRowHeight` (the larger wins). The Dashboard Timeline (frame 3a) sets
 * Project rows to 3rem (48px) and Subtask rows to 2.5rem (40px); a coarse pointer raises the view
 * floor to 2.75rem (44px), which lifts a 40px Subtask row and leaves a 48px Project row as it is.
 *
 * The tree row and the timeline row share one height (both carry `data-gantt-row-id`), so both are
 * read. happy-dom has no layout, so this pins the inline height. `getAnimations` polyfill: see
 * `gantt-adjust-ghost-marker.dom.test.tsx`'s header.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Gantt, type GanttMetrics } from "@/components/reui/gantt/gantt";
import { GanttView } from "@/components/reui/gantt/gantt-view";
import type { GanttEvent, GanttResource } from "@/components/reui/gantt/gantt-types";

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

const DATE = new Date("2026-03-02T00:00:00.000Z");
const RESOURCES: GanttResource[] = [
  { id: "project", title: "12 Ocean Street", minRowHeight: 3, children: [{ id: "task", title: "Retouch", minRowHeight: 2.5 }] },
  { id: "plain", title: "No floor of its own" },
];
const EVENTS: GanttEvent[] = [
  { id: "bar", title: "Retouch", start: new Date("2026-03-02T09:00:00.000Z"), end: new Date("2026-03-02T15:00:00.000Z"), resourceId: "task" },
];

/** Every element drawing this row (tree and timeline), with its inline height. */
function rowHeights(id: string): string[] {
  const rows = [...host.querySelectorAll<HTMLElement>(`[data-gantt-row-id="${id}"]`)];
  expect(rows.length, `rows for ${id}`).toBeGreaterThanOrEqual(2);
  return rows.map((row) => row.style.height);
}

async function renderWith(metrics?: GanttMetrics) {
  await render(
    <Gantt resources={RESOURCES} events={EVENTS} date={DATE} scale="day" timeZone="UTC" metrics={metrics}>
      <GanttView />
    </Gantt>,
  );
}

describe("gantt per-node minRowHeight (#919)", () => {
  it("a Project row is 48px and a Subtask row 40px under 28px bars", async () => {
    await renderWith({ laneHeight: 1.75, rowPadding: 0.375 });
    expect(new Set(rowHeights("project"))).toEqual(new Set(["3rem"]));
    expect(new Set(rowHeights("task"))).toEqual(new Set(["2.5rem"]));
  });

  it("a coarse-pointer view floor of 44px lifts the Subtask row and leaves the Project row at 48px", async () => {
    await renderWith({ laneHeight: 1.75, rowPadding: 0.375, minRowHeight: 2.75 });
    expect(new Set(rowHeights("project"))).toEqual(new Set(["3rem"]));
    expect(new Set(rowHeights("task"))).toEqual(new Set(["2.75rem"]));
  });

  it("a node with no floor of its own keeps the view's (default config unchanged)", async () => {
    await renderWith();
    expect(new Set(rowHeights("plain"))).toEqual(new Set(["2.5rem"]));
  });
});
