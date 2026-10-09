import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoPendingRangeBand, VideoTimelineMarkers, type TimelineMarker } from "./VideoTimelineMarkers";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null; let host: HTMLElement;
async function render(node: React.ReactNode) {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(node); });
}
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren(); });
const markers: TimelineMarker[] = [
  { id: "p", startFrame: 0, endFrame: null, tone: "public", selected: false },
  { id: "i", startFrame: 150, endFrame: null, tone: "internal", selected: true },
  { id: "r", startFrame: 200, endFrame: 251, tone: "internal", selected: false },
];
const marker = (id: string) => host.querySelector<HTMLElement>(`[data-marker-id="${id}"]`)!;
const lane = () => host.querySelector<HTMLElement>("[data-testid=video-marker-lane]")!;

describe("VideoTimelineMarkers (#741 5b)", () => {
  it("draws public as a dot, internal as a diamond and a range as a bar, and says which is selected", async () => {
    await render(<VideoTimelineMarkers markers={markers} frameCount={300} />);
    expect(marker("p").dataset.shape).toBe("dot"); expect(marker("p").dataset.tone).toBe("public");
    expect(marker("i").dataset.shape).toBe("diamond"); expect(marker("i").dataset.tone).toBe("internal");
    expect(marker("r").dataset.shape).toBe("bar");
    expect(marker("i").dataset.selected).toBe("true"); expect(marker("p").dataset.selected).toBe("false");
  });

  it("positions by frame fraction, a range from start to end - 1", async () => {
    await render(<VideoTimelineMarkers markers={markers} frameCount={300} />);
    expect(marker("p").style.getPropertyValue("--f")).toBe("0");
    expect(Number(marker("i").style.getPropertyValue("--f"))).toBeCloseTo(150 / 299, 6);
    expect(Number(marker("r").style.getPropertyValue("--f"))).toBeCloseTo(200 / 299, 6);
    expect(Number(marker("r").style.getPropertyValue("--f2"))).toBeCloseTo(250 / 299, 6);
  });

  it("pins the thumb-centre coordinate system: 6px half-thumb, 8px on a coarse pointer, left = half + (100% - 2 half) * f", async () => {
    await render(<VideoTimelineMarkers markers={markers} frameCount={300} />);
    expect(lane().className).toContain("[--thumb-half:6px]");
    expect(lane().className).toContain("pointer-coarse:[--thumb-half:8px]");
    expect(marker("i").className).toContain("left-[calc(var(--thumb-half)+(100%-2*var(--thumb-half))*var(--f))]");
  });

  it("is hidden from assistive tech and inert on touch (the list is the accessible path)", async () => {
    await render(<VideoTimelineMarkers markers={markers} frameCount={300} />);
    expect(lane().getAttribute("aria-hidden")).toBe("true");
    expect(lane().className).toContain("pointer-coarse:pointer-events-none");
    expect(lane().className).toContain("max-[721px]:pointer-events-none");
    expect(lane().querySelector("button, a, input, [role]")).toBeNull();
  });

  it("a pointer-down near a marker selects it; far from every marker does nothing", async () => {
    const onSelect = vi.fn();
    await render(<VideoTimelineMarkers markers={markers} frameCount={300} onSelect={onSelect} />);
    lane().getBoundingClientRect = () => ({ left: 100, top: 0, width: 1000, height: 12, right: 1100, bottom: 12, x: 100, y: 0, toJSON: () => ({}) });
    const down = async (clientX: number) => act(async () => { lane().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX })); });
    await down(100 + 6 + (988 * 150) / 299 + 4);
    expect(onSelect).toHaveBeenCalledWith("i");
    onSelect.mockClear();
    await down(100 + 6 + (988 * 80) / 299);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("with no onSelect the lane has no handler to run", async () => {
    await render(<VideoTimelineMarkers markers={markers} frameCount={300} />);
    lane().getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 12, right: 1000, bottom: 12, x: 0, y: 0, toJSON: () => ({}) });
    await act(async () => { lane().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 6 })); });
    expect(host.querySelector("[data-testid=video-marker-lane]")).not.toBeNull();
  });
});

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  constructor(private readonly callback: (entries: Array<{ contentRect: { width: number } }>) => void) { FakeResizeObserver.instances.push(this); }
  observe() {}
  unobserve() {}
  disconnect() {}
  fire(width: number) { this.callback([{ contentRect: { width } }]); }
}
describe("VideoTimelineMarkers clustering (#741 5b, round 2)", () => {
  beforeEach(() => { FakeResizeObserver.instances = []; vi.stubGlobal("ResizeObserver", FakeResizeObserver); });
  afterEach(() => { vi.unstubAllGlobals(); });
  const close: TimelineMarker[] = [
    { id: "a", startFrame: 100, endFrame: null, tone: "public", selected: false, createdAt: "2026-10-10T00:00:01.000Z" },
    { id: "b", startFrame: 101, endFrame: null, tone: "internal", selected: false, createdAt: "2026-10-10T00:00:02.000Z" },
    { id: "far", startFrame: 120, endFrame: null, tone: "public", selected: false, createdAt: "2026-10-10T00:00:03.000Z" },
  ];
  const resize = async (width: number) => { lane().getBoundingClientRect = () => ({ left: 0, top: 0, width, height: 12, right: width, bottom: 12, x: 0, y: 0, toJSON: () => ({}) }); await act(async () => { FakeResizeObserver.instances.forEach((o) => { o.fire(width); }); }); };

  it("merges markers closer than one marker width into one cluster marker that shows a count, and recomputes on resize", async () => {
    await render(<VideoTimelineMarkers markers={close} frameCount={300} />);
    await resize(1000);
    const cluster = host.querySelector<HTMLElement>("[data-cluster-count]")!;
    expect(cluster.dataset.clusterCount).toBe("2");
    expect(cluster.dataset.markerId).toBe("a");
    expect(cluster.textContent).toBe("2");
    expect(host.querySelector('[data-marker-id="b"]')).toBeNull();
    expect(host.querySelector('[data-marker-id="far"]')).not.toBeNull();
    await resize(60);
    expect(host.querySelector<HTMLElement>("[data-cluster-count]")!.dataset.clusterCount).toBe("3");
  });

  it("a cluster shows as selected when any of its notes is, and a press on it selects its earliest note", async () => {
    const onSelect = vi.fn();
    await render(<VideoTimelineMarkers markers={close.map((m) => (m.id === "b" ? { ...m, selected: true } : m))} frameCount={300} onSelect={onSelect} />);
    await resize(1000);
    expect(host.querySelector<HTMLElement>("[data-cluster-count]")!.dataset.selected).toBe("true");
    await act(async () => { lane().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 6 + (988 * 100) / 299 + 2 })); });
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("unmeasured (no width yet) draws every marker as it is", async () => {
    await render(<VideoTimelineMarkers markers={close} frameCount={300} />);
    expect(host.querySelector("[data-cluster-count]")).toBeNull();
    expect(host.querySelector('[data-marker-id="b"]')).not.toBeNull();
  });
});

describe("VideoPendingRangeBand (#741 5b)", () => {
  it("draws the composer's marks over the track, never catching the pointer", async () => {
    await render(<VideoPendingRangeBand range={{ startFrame: 10, endFrame: 21 }} frameCount={300} />);
    const band = host.querySelector<HTMLElement>("[data-testid=video-pending-band]")!;
    expect(band.className).toContain("pointer-events-none");
    expect(Number(band.style.getPropertyValue("--f"))).toBeCloseTo(10 / 299, 6);
    expect(Number(band.style.getPropertyValue("--f2"))).toBeCloseTo(20 / 299, 6);
  });

  it("a single mark is a one-frame band, and no marks draws nothing", async () => {
    await render(<VideoPendingRangeBand range={{ startFrame: 10, endFrame: null }} frameCount={300} />);
    const band = host.querySelector<HTMLElement>("[data-testid=video-pending-band]")!;
    expect(band.style.getPropertyValue("--f")).toBe(band.style.getPropertyValue("--f2"));
    await act(async () => { root!.render(<VideoPendingRangeBand range={null} frameCount={300} />); });
    expect(host.querySelector("[data-testid=video-pending-band]")).toBeNull();
  });
});
