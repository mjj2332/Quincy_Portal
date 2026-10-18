/**
 * #916 / #921 (frame 3c) — `treePanel.placement: "inline"` (additive): no tree column. Each row draws its
 * label as a sticky line above its lanes, inside the one scroller ("Native scrolling needs one passive
 * scroller; the sticky tree lives inside it"), so the track gets the phone's full width. Two metrics go
 * with it: `inlineLabelHeight` (the label line, in rem) and `unitsPerLane` (that many units fill the
 * visible lane at zoom 1: the phone's Week shows seven days).
 *
 * happy-dom has no layout: the lane width is stubbed on `clientWidth`, and heights are read from the
 * inline styles the view writes. `getAnimations` polyfill: see `gantt-adjust-ghost-marker.dom.test.tsx`.
 * Guard F: found by `data-testid`, never by a vendor slot.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Gantt, type GanttMetrics, type GanttTreePanelConfig } from "@/components/reui/gantt/gantt";
import { GanttView } from "@/components/reui/gantt/gantt-view";
import type { GanttEvent, GanttInteractions, GanttResource } from "@/components/reui/gantt/gantt-types";

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LANE_PX = 357;
const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth")!;

async function render(value: ReactNode) {
  await act(async () => {
    root!.render(value);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  // The body's width is the lane's when there is no tree column.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("data-testid") === "gantt-body" ? LANE_PX : 0;
    },
  });
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
  Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
});

const DATE = new Date("2026-09-14T00:00:00.000Z");
const RESOURCES: GanttResource[] = [
  { id: "project", title: "12 Ocean Street", minRowHeight: 3, children: [{ id: "task", title: "Retouch", minRowHeight: 2.5 }] },
];
const EVENTS: GanttEvent[] = [
  { id: "p", title: "12 Ocean Street", start: new Date("2026-09-14T00:00:00.000Z"), end: new Date("2026-09-18T00:00:00.000Z"), resourceId: "project", readOnly: true },
  { id: "t", title: "Retouch", start: new Date("2026-09-15T00:00:00.000Z"), end: new Date("2026-09-17T00:00:00.000Z"), resourceId: "task" },
];
const METRICS: GanttMetrics = { laneHeight: 1.75, rowPadding: 0.375, inlineLabelHeight: 1.75, unitWidths: { week: 3.25 }, unitsPerLane: { week: 7 } };
const INLINE: GanttTreePanelConfig = { placement: "inline" };
const VIEW_ONLY: GanttInteractions = { drag: false, resize: false, selectSlot: false };

async function renderWith({ treePanel, metrics = METRICS, interactions }: { treePanel?: GanttTreePanelConfig; metrics?: GanttMetrics; interactions?: GanttInteractions } = {}) {
  await render(
    <Gantt
      resources={RESOURCES}
      events={EVENTS}
      date={DATE}
      scale="week"
      timeZone="UTC"
      metrics={metrics}
      treePanel={treePanel}
      interactions={interactions}
      renderResourceLabel={({ resource, isGroup }) => <span data-testid={`label-${resource.id}`}>{isGroup ? "Project" : "Task"}: {resource.title}</span>}
    >
      <GanttView />
    </Gantt>,
  );
}

const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const timelineRow = (id: string) => host.querySelector<HTMLElement>(`[data-testid="gantt-timeline-column"] [data-gantt-row-id="${id}"]`)!;
const bar = (title: string) => host.querySelector<HTMLElement>(`button[aria-label*="${title}"]`)!;

describe("gantt inline labels (#921)", () => {
  it("draws no tree column, splitter or tree overlay, and the tree inset is zero", async () => {
    await renderWith({ treePanel: INLINE });
    expect(byTestId("gantt-tree-column")).toBeNull();
    expect(byTestId("gantt-splitter")).toBeNull();
    expect(byTestId("gantt-tree-overlay")).toBeNull();
    expect(byTestId("gantt-body")!.style.getPropertyValue("--gantt-tree-inset")).toBe("0px");
    // every row is drawn once, in the timeline column
    expect(host.querySelectorAll('[data-gantt-row-id="project"]')).toHaveLength(1);
  });

  it("each row draws its label above its lanes, sticky at the lane's start and as wide as the visible lane", async () => {
    await renderWith({ treePanel: INLINE });
    for (const id of ["project", "task"]) {
      const row = timelineRow(id);
      const label = row.querySelector<HTMLElement>('[data-testid="gantt-inline-label"]')!;
      expect(label, id).not.toBeNull();
      expect(label.firstElementChild).toBe(row.querySelector(`[data-testid="label-${id}"]`));
      expect(label.style.position).toBe("sticky");
      expect(label.style.insetInlineStart).toBe("0");
      expect(label.style.height).toBe("1.75rem");
      expect(label.style.marginTop).toBe("0.375rem");
      expect(label.style.maxWidth).toBe("var(--gantt-inline-label-width)");
    }
    expect(byTestId("gantt-body")!.style.getPropertyValue("--gantt-inline-label-width")).toBe(`${LANE_PX}px`);
    expect(byTestId("label-project")!.textContent).toBe("Project: 12 Ocean Street");
    expect(byTestId("label-task")!.textContent).toBe("Task: Retouch");
  });

  it("a row is padding + label + padding + bar + padding, and the bar sits under the label", async () => {
    await renderWith({ treePanel: INLINE });
    // 0.375 + 1.75 + 0.375 + 1.75 + 0.375: taller than either node's own floor (3rem, 2.5rem)
    expect(timelineRow("project").style.height).toBe("4.625rem");
    expect(timelineRow("task").style.height).toBe("4.625rem");
    const wrapper = bar("Retouch").closest<HTMLElement>("[style*='top']")!;
    expect(wrapper.style.top).toBe("2.5rem");
  });

  it("the Week fits seven days to the visible lane", async () => {
    await renderWith({});
    // The same Week drawn with the side tree is `days` x 3.25rem (its configured unit), so the day count comes from there.
    const days = parseFloat(byTestId("gantt-timeline-column")!.style.minWidth) / 3.25;
    expect(Number.isInteger(days) && days > 0).toBe(true);
    await renderWith({ treePanel: INLINE });
    expect(parseFloat(byTestId("gantt-timeline-column")!.style.minWidth)).toBeCloseTo((days * LANE_PX) / 7 / 16, 5);
  });

  it("a bar no pointer gesture can start leaves the touch to the scroller; a draggable one keeps it", async () => {
    await renderWith({ treePanel: INLINE, interactions: VIEW_ONLY });
    expect(bar("Retouch").hasAttribute("data-native-pan")).toBe(true);
    await renderWith({ treePanel: INLINE });
    expect(bar("Retouch").hasAttribute("data-native-pan")).toBe(false);
    // the read-only Project bar has no gesture either way
    expect(bar("12 Ocean Street").hasAttribute("data-native-pan")).toBe(true);
  });

  it("unset, the tree column, its rows and the configured unit width are as before", async () => {
    await renderWith({ interactions: VIEW_ONLY });
    expect(byTestId("gantt-tree-column")).not.toBeNull();
    expect(host.querySelector('[data-testid="gantt-inline-label"]')).toBeNull();
    expect(timelineRow("project").style.height).toBe("3rem");
    expect(timelineRow("task").style.height).toBe("2.5rem");
    // inlineLabelHeight and unitsPerLane are the inline placement's; the side tree keeps unitWidths (whole days of 3.25rem)
    expect(Number.isInteger(parseFloat(byTestId("gantt-timeline-column")!.style.minWidth) / 3.25)).toBe(true);
    // and a read-only bar outside the inline placement keeps claiming the touch, as it always has
    expect(bar("Retouch").hasAttribute("data-native-pan")).toBe(false);
  });
});
