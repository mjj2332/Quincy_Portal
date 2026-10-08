/**
 * 2026-10-08, #727 (PR2 of #722) - the Timeline has ONE native scroller. The tree is a sticky
 * start-0 column inside it, so tree rows and bars share a single scrollTop and cannot drift. The
 * splitter, the zoom/chip lane overlay and the reorder-indicator tree overlay live OUTSIDE the
 * scroller, so their rects keep meaning "the visible pane".
 *
 * happy-dom has no layout: this pins the DOM shape, the class contracts and the splitter's write to
 * `--gantt-tree-inset`; pixel behaviour is checked in a browser pass. Selected by `data-testid` and
 * `data-gantt-scroller` (test-seam guard F). `getAnimations` polyfill: see
 * `gantt-adjust-ghost-marker.dom.test.tsx`'s header.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gantt } from "@/components/reui/gantt/gantt";
import { GanttView } from "@/components/reui/gantt/gantt-view";
import { GANTT_HEADER_PX } from "@/components/reui/gantt/gantt-track-geometry";

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

const START = new Date("2026-03-02T00:00:00.000Z");
const RESOURCES = [
  { id: "r1", title: "Row 1" },
  { id: "r2", title: "Row 2" },
];

async function mount(scrollbars: "custom" | "native", treePanel?: { width?: number; minWidth?: number; minWidthHard?: boolean }) {
  await render(
    <Gantt
      resources={RESOURCES}
      events={[]}
      date={START}
      scale="day"
      timeZone="UTC"
      scrollbars={scrollbars}
      treePanel={treePanel}
    >
      <GanttView />
    </Gantt>,
  );
}

const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe.each(["custom", "native"] as const)("single scroller (%s scrollbars)", (scrollbars) => {
  it("renders exactly one scroll viewport, holding both columns", async () => {
    await mount(scrollbars);
    const scrollers = host.querySelectorAll<HTMLElement>("[data-gantt-scroller]");
    expect(scrollers).toHaveLength(1);
    const scroller = scrollers[0]!;
    expect(scroller.contains(byTestId("gantt-tree-column"))).toBe(true);
    expect(scroller.contains(byTestId("gantt-timeline-column"))).toBe(true);
    expect(scroller.contains(byTestId("gantt-tree-name-header"))).toBe(true);
  });

  it("keeps the splitter, lane overlay and tree overlay outside the scroller", async () => {
    await mount(scrollbars);
    const scroller = host.querySelector<HTMLElement>("[data-gantt-scroller]")!;
    for (const id of ["gantt-splitter", "gantt-lane-overlay", "gantt-tree-overlay"]) {
      const el = byTestId(id);
      expect(el, id).not.toBeNull();
      expect(scroller.contains(el), id).toBe(false);
    }
    // the zoom control rides the lane overlay, not the scrolled content
    expect(byTestId("gantt-lane-overlay")!.contains(byTestId("gantt-zoom"))).toBe(true);
  });

  it("pins the tree column (sticky, inline-start 0, clipped) and isolates the timeline column", async () => {
    await mount(scrollbars);
    const tree = byTestId("gantt-tree-column")!.className.split(/\s+/);
    expect(tree).toEqual(expect.arrayContaining(["sticky", "start-0", "overflow-x-clip"]));
    // clip, not hidden: hidden would make the column its own scroll container (lessons.md)
    expect(tree.filter((c) => /^overflow(-[xy])?-(hidden|auto|scroll)$/.test(c))).toEqual([]);
    expect(byTestId("gantt-timeline-column")!.className.split(/\s+/)).toContain("isolate");
  });

  it("reserves scroll-padding for the sticky header and the tree inset", async () => {
    await mount(scrollbars);
    const scroller = host.querySelector<HTMLElement>("[data-gantt-scroller]")!;
    expect(scroller.style.getPropertyValue("scroll-padding-top")).toBe(`${GANTT_HEADER_PX}px`);
    expect(scroller.style.getPropertyValue("scroll-padding-inline-start")).toBe("var(--gantt-tree-inset)");
  });
});

describe("--gantt-tree-inset", () => {
  it("starts at the clamped tree width", async () => {
    await mount("custom", { width: 400 });
    expect(byTestId("gantt-body")!.style.getPropertyValue("--gantt-tree-inset")).toBe("400px");
  });

  it("is written by a splitter drag, live, with one write to the shared variable", async () => {
    await mount("custom", { width: 400 });
    const splitter = byTestId("gantt-splitter")!;
    const body = byTestId("gantt-body")!;
    await act(async () => {
      splitter.dispatchEvent(
        new PointerEvent("pointerdown", { button: 0, clientX: 400, pointerId: 1, bubbles: true, cancelable: true }),
      );
    });
    await act(async () => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 450, pointerId: 1 }));
    });
    expect(body.style.getPropertyValue("--gantt-tree-inset")).toBe("450px");
    await act(async () => {
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: 450, pointerId: 1 }));
    });
    expect(body.style.getPropertyValue("--gantt-tree-inset")).toBe("450px");
  });
});

describe("tree floor and overlay stacking (Sol review on #727)", () => {
  async function insetAtContainer(container: number, treePanel: { width?: number; minWidth?: number; minWidthHard?: boolean }) {
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => container });
    try {
      await mount("custom", treePanel);
      return byTestId("gantt-body")!.style.getPropertyValue("--gantt-tree-inset");
    } finally {
      if (desc) Object.defineProperty(HTMLElement.prototype, "clientWidth", desc);
      else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    }
  }

  it("keeps the tree at a hard minWidth when the container is too narrow to spare it", async () => {
    expect(await insetAtContainer(596, { width: 396, minWidth: 396, minWidthHard: true })).toBe("396px");
  });

  it("still yields a soft minWidth to the timeline's minimum (phones keep the vendor clamp)", async () => {
    // 358px phone body: ceiling = 358 - MIN_TIMELINE_WIDTH - 1; the soft floor caps at it, not at minWidth.
    expect(await insetAtContainer(358, { width: 180 })).not.toBe("180px");
  });

  it("does not make the tree overlay a stacking context, so the reorder indicator (z 110) can clear the body-mounted carry overlay (z 100)", async () => {
    await mount("custom");
    const overlay = byTestId("gantt-tree-overlay")!;
    const trapping = /^(isolate|z-\d+|z-\[.*\]|transform|will-change-.*)$/;
    for (let el: HTMLElement | null = overlay; el && el !== host; el = el.parentElement) {
      expect(el.className.split(/\s+/).filter((c) => trapping.test(c)), el.getAttribute("data-testid") ?? el.tagName).toEqual(
        el === overlay ? [] : el.getAttribute("data-testid") === "gantt-timeline-column" ? ["isolate"] : [],
      );
    }
    // the scrollbar rail keeps its own z so it still covers the scroller's bottom strip
    expect(byTestId("gantt-tree-scrollbar-rail")!.className).toContain("z-30");
  });
});

describe("scroll intent from the tree column (#727)", () => {
  afterEach(() => vi.restoreAllMocks());

  // The scroller has no layout in happy-dom: give it a wide track so a scroll at the start edge reads as
  // "asked to grow the range before".
  async function mountScrollable() {
    // intent is "within 1200ms of a stamp initialised to 0": start the clock well past that so only a
    // real gesture can open the window (a fresh test process is under 1.2s old)
    vi.spyOn(performance, "now").mockReturnValue(60_000);
    await mount("custom");
    const scroller = host.querySelector<HTMLElement>("[data-gantt-scroller]")!;
    Object.defineProperty(scroller, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(scroller, "scrollWidth", { value: 3000, configurable: true });
    let left = 0;
    Object.defineProperty(scroller, "scrollLeft", { get: () => left, set: (v: number) => (left = v), configurable: true });
    const axis = () => scroller.querySelector<HTMLElement>("[data-gantt-axis]")!.dataset.ganttRangeStart;
    return { scroller, axis, before: axis() };
  }
  async function scrollAfter(scroller: HTMLElement, gesture: (tree: HTMLElement) => void) {
    await act(async () => {
      gesture(byTestId("gantt-tree-column")!);
      scroller.dispatchEvent(new Event("scroll"));
      await Promise.resolve();
    });
  }

  it("a pointerdown or keydown inside the tree column is not scroll intent", async () => {
    for (const gesture of [
      (tree: HTMLElement) => tree.dispatchEvent(new Event("pointerdown", { bubbles: true })),
      (tree: HTMLElement) => tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    ]) {
      const { scroller, axis, before } = await mountScrollable();
      await scrollAfter(scroller, gesture);
      expect(axis()).toBe(before);
      await act(async () => root!.unmount());
      host.remove();
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
    }
  });

  it("a wheel inside the tree column still is (it scrolls the timeline)", async () => {
    const { scroller, axis, before } = await mountScrollable();
    await scrollAfter(scroller, (tree) => tree.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 40 })));
    expect(axis()).not.toBe(before);
  });
});

describe("tree width follows a tree-panel config swap (#734)", () => {
  const readInset = () => {
    const el = host.querySelector<HTMLElement>('[style*="--gantt-tree-inset"]')!;
    return el.style.getPropertyValue("--gantt-tree-inset");
  };
  it("re-seeds to the new config's width and back", async () => {
    await mount("native", { width: 396, minWidth: 396, minWidthHard: true });
    expect(readInset()).toBe("396px");
    await mount("native", { width: 288, minWidth: 120 });
    expect(readInset()).toBe("288px");
    await mount("native", { width: 396, minWidth: 396, minWidthHard: true });
    expect(readInset()).toBe("396px");
  });
});
