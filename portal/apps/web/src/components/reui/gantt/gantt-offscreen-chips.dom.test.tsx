/**
 * 2026-10-08, #734 - an offscreen edge chip appears only once the bar AND its external label have left
 * the visible lane. happy-dom has no layout, so this stubs the scroller's geometry and the rects the
 * chip measurement reads; whether the chip paints over readable text is checked in a browser pass.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gantt } from "@/components/reui/gantt/gantt";
import type { GanttEvent } from "@/components/reui/gantt/gantt-types";
import { GanttView } from "@/components/reui/gantt/gantt-view";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;
let frames: FrameRequestCallback[] = [];
const TRACK = 2000;
const VISIBLE = 500;

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => (frames.push(cb), frames.length));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const START = new Date("2026-03-02T00:00:00.000Z");
const flushFrames = async () => {
  await act(async () => {
    const run = frames;
    frames = [];
    run.forEach((cb) => cb(0));
    await Promise.resolve();
  });
};

interface Setup { scroller: HTMLElement; startPx: number; endPx: number; label: HTMLElement; setScroll: (left: number) => Promise<void> }

/** Mounts one row with an external label and lays it out in a 2000px track seen through a 500px lane. */
async function mount(event: Pick<GanttEvent, "start" | "end">, overhang: number, dir: "ltr" | "rtl" = "ltr"): Promise<Setup> {
  await act(async () => {
    root!.render(
      <div dir={dir}>
        <Gantt resources={[{ id: "r1", title: "Row 1" }]} events={[{ id: "e1", title: "Task one", resourceId: "r1", ...event }]} date={START} scale="week" timeZone="UTC" barLabel="outside">
          <GanttView />
        </Gantt>
      </div>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  const scroller = host.querySelector<HTMLElement>("[data-gantt-scroller]")!;
  const row = host.querySelector<HTMLElement>("[data-gantt-row]")!;
  const label = host.querySelector<HTMLElement>('[data-testid="gantt-bar-label"]')!;
  const wrapper = label.parentElement!;
  const pane = host.querySelector<HTMLElement>('[data-testid="gantt-lane-overlay"]')!;
  const placement = label.dataset.placement;
  const startPx = parseFloat(row.dataset.ganttBarMin!) * TRACK;
  const endPx = parseFloat(row.dataset.ganttBarMax!) * TRACK;
  scroller.style.setProperty("--gantt-tree-inset", "0px");
  scroller.style.direction = dir; // happy-dom does not derive the computed direction from the dir attribute
  Object.defineProperty(scroller, "clientWidth", { configurable: true, value: VISIBLE });
  Object.defineProperty(scroller, "scrollWidth", { configurable: true, value: TRACK });
  let scrollLeft = 0;
  Object.defineProperty(scroller, "scrollLeft", { configurable: true, get: () => scrollLeft });
  const rect = (left: number, right: number, top = 0, height = 20) => ({ left, right, top, bottom: top + height, width: right - left, height, x: left, y: top, toJSON() {} }) as DOMRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === pane) return rect(0, VISIBLE, 0, 600);
    if (this === row) return rect(0, TRACK, 100, 40);
    // rects live in viewport x: track inline offsets minus the scrolled distance, mirrored in RTL
    const place = (x: number, y: number) => {
      const from = Math.abs(scrollLeft);
      return dir === "rtl" ? rect(VISIBLE - (y - from), VISIBLE - (x - from)) : rect(x - from, y - from);
    };
    if (this === wrapper) return place(startPx, endPx);
    if (this === label) return placement === "before" ? place(startPx - overhang, startPx) : place(endPx, endPx + overhang);
    return rect(0, 0);
  });
  const setScroll = async (left: number) => {
    scrollLeft = left;
    await act(async () => { scroller.dispatchEvent(new Event("scroll")); await Promise.resolve(); });
    await flushFrames();
  };
  return { scroller, startPx, endPx, label, setScroll };
}

const chips = () => Array.from(host.querySelectorAll<HTMLElement>('[data-testid="gantt-offscreen-chip"]'));

describe("GanttOffscreenChips measure the external label (#734)", () => {
  it("an after-label still in the lane keeps the start chip away; the chip appears once the label has gone too", async () => {
    const s = await mount({ start: new Date("2026-03-02T09:00:00Z"), end: new Date("2026-03-02T12:00:00Z") }, 200);
    expect(s.label.dataset.placement).toBe("after");
    await s.setScroll(s.endPx + 100); // bar gone, label (200px) still reaches 100px into the lane
    expect(chips()).toHaveLength(0);
    await s.setScroll(s.endPx + 250); // label gone as well
    expect(chips().map((c) => c.dataset.side)).toEqual(["start"]);
  });

  it("a before-label still in the lane keeps the end chip away", async () => {
    const s = await mount({ start: new Date("2026-03-07T09:00:00Z"), end: new Date("2026-03-07T20:00:00Z") }, 200);
    expect(s.label.dataset.placement).toBe("before");
    await s.setScroll(s.startPx - VISIBLE - 100 + 0); // visibleEnd = startPx - 100: bar offscreen right, label begins 100px inside
    expect(chips()).toHaveLength(0);
    await s.setScroll(s.startPx - VISIBLE - 250);
    expect(chips().map((c) => c.dataset.side)).toEqual(["end"]);
  });

  it("a label that overhangs by 0 (inside) adds nothing: the chip shows as soon as the bar is gone", async () => {
    const s = await mount({ start: new Date("2026-03-02T09:00:00Z"), end: new Date("2026-03-02T12:00:00Z") }, 0);
    await s.setScroll(s.endPx + 10);
    expect(chips().map((c) => c.dataset.side)).toEqual(["start"]);
  });

  it("measures the overhang in both text directions", async () => {
    const s = await mount({ start: new Date("2026-03-02T09:00:00Z"), end: new Date("2026-03-02T12:00:00Z") }, 200, "rtl");
    await s.setScroll(s.endPx + 100);
    expect(chips()).toHaveLength(0);
    await s.setScroll(s.endPx + 250);
    expect(chips().map((c) => c.dataset.side)).toEqual(["start"]);
  });
});

/**
 * Painted extent (#734b): the chip decision uses where the row is PAINTED (segment wrapper and external label, in track
 * coordinates), not the temporal bar bounds - a minimum-width bar or a centred milestone paints wider than it spans.
 * `temporal` is what the row's data attributes say; `wrapper` and `label` are track-space rects (inline-start, inline-end).
 */
async function mountPainted(opts: {
  track: number;
  temporal: [number, number];
  wrapper: [number, number];
  label: [number, number];
  dir?: "ltr" | "rtl";
}) {
  const dir = opts.dir ?? "ltr";
  await act(async () => {
    root!.render(
      <div dir={dir}>
        <Gantt resources={[{ id: "r1", title: "Row 1" }]} events={[{ id: "e1", title: "Task one", resourceId: "r1", start: new Date("2026-03-02T09:00:00Z"), end: new Date("2026-03-02T12:00:00Z") }]} date={START} scale="week" timeZone="UTC" barLabel="outside">
          <GanttView />
        </Gantt>
      </div>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  const scroller = host.querySelector<HTMLElement>("[data-gantt-scroller]")!;
  const row = host.querySelector<HTMLElement>("[data-gantt-row]")!;
  const label = host.querySelector<HTMLElement>('[data-testid="gantt-bar-label"]')!;
  const wrapper = label.parentElement!;
  const pane = host.querySelector<HTMLElement>('[data-testid="gantt-lane-overlay"]')!;
  row.dataset.ganttBarMin = String(opts.temporal[0] / opts.track);
  row.dataset.ganttBarMax = String(opts.temporal[1] / opts.track);
  scroller.style.setProperty("--gantt-tree-inset", "0px");
  scroller.style.direction = dir; // happy-dom does not derive the computed direction from the dir attribute
  Object.defineProperty(scroller, "clientWidth", { configurable: true, value: VISIBLE });
  Object.defineProperty(scroller, "scrollWidth", { configurable: true, value: opts.track });
  let scrollLeft = 0;
  Object.defineProperty(scroller, "scrollLeft", { configurable: true, get: () => scrollLeft });
  const rect = (left: number, right: number, top = 0, height = 20) => ({ left, right, top, bottom: top + height, width: right - left, height, x: left, y: top, toJSON() {} }) as DOMRect;
  // track inline offsets -> viewport x. The lane shows track offsets [visibleStart, visibleStart + VISIBLE].
  const place = ([a, b]: [number, number]) => {
    const visibleStart = Math.abs(scrollLeft);
    return dir === "rtl" ? rect(VISIBLE - (b - visibleStart), VISIBLE - (a - visibleStart)) : rect(a - visibleStart, b - visibleStart);
  };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === pane) return rect(0, VISIBLE, 0, 600);
    if (this === row) return rect(0, VISIBLE, 100, 40);
    if (this === wrapper) return place(opts.wrapper);
    if (this === label) return place(opts.label);
    return rect(0, 0);
  });
  const setScroll = async (left: number) => {
    scrollLeft = dir === "rtl" ? -left : left;
    await act(async () => { scroller.dispatchEvent(new Event("scroll")); await Promise.resolve(); });
    await flushFrames();
  };
  return { setScroll };
}

describe("GanttOffscreenChips use the painted extent, not the temporal bounds (#734b)", () => {
  for (const dir of ["ltr", "rtl"] as const) {
    it(`${dir}: a minimum-width bar (temporal 300-301, wrapper to 320, after-label to 428) holds the chip until the label is gone`, async () => {
      const s = await mountPainted({ track: 4000, temporal: [300, 301], wrapper: [300, 320], label: [320, 428], dir });
      await s.setScroll(410);
      expect(chips()).toHaveLength(0);
      await s.setScroll(430);
      expect(chips().map((c) => c.dataset.side)).toEqual(["start"]);
    });

    it(`${dir}: a centred milestone whose wrapper extends past its temporal point holds the start chip`, async () => {
      const s = await mountPainted({ track: 4000, temporal: [500, 500], wrapper: [480, 520], label: [520, 520], dir });
      await s.setScroll(515); // temporal end 500 is past, the painted wrapper (to 520) is still 5px in the lane
      expect(chips()).toHaveLength(0);
      await s.setScroll(530);
      expect(chips().map((c) => c.dataset.side)).toEqual(["start"]);
    });

    it(`${dir}: a centred milestone holds the end chip while its wrapper still reaches into the lane`, async () => {
      const s = await mountPainted({ track: 4000, temporal: [1500, 1500], wrapper: [1480, 1520], label: [1480, 1480], dir });
      await s.setScroll(1000 - VISIBLE); // lane ends at 1000, far from 1480
      expect(chips().map((c) => c.dataset.side)).toEqual(["end"]);
      await s.setScroll(1485 - VISIBLE); // lane ends at 1485: wrapper start 1480 is inside the lane
      expect(chips()).toHaveLength(0);
    });
  }
});
