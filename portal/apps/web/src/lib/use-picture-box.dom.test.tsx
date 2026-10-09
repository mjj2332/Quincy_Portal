import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installVideoElementStub, type VideoElementStub } from "../testing/video-element";
import { usePictureBox } from "./use-picture-box";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(private readonly callback: () => void) { FakeResizeObserver.instances.push(this); }
  observe(element: Element) { this.observed.push(element); }
  unobserve() {}
  disconnect() { this.disconnected = true; }
  fire() { this.callback(); }
}

type Dims = { width: number; height: number; left: number; top: number };
let dims: Dims;
let stub: VideoElementStub;
let root: Root | null = null;
let host: HTMLElement;
let videoEl: HTMLVideoElement | null = null;

function Harness({ fallback }: { fallback: { width: number; height: number } }) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const box = usePictureBox(video, fallback);
  return <div>
    <video ref={(element) => {
      if (element) {
        for (const [prop, key] of [["offsetWidth", "width"], ["offsetHeight", "height"], ["offsetLeft", "left"], ["offsetTop", "top"]] as const) Object.defineProperty(element, prop, { configurable: true, get: () => dims[key] });
        videoEl = element;
      }
      setVideo(element);
    }} />
    <output data-testid="box">{box ? JSON.stringify(box) : "none"}</output>
  </div>;
}
const boxText = () => host.querySelector('[data-testid="box"]')!.textContent!;
async function mount(fallback = { width: 1920, height: 1080 }) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness fallback={fallback} />); });
}

beforeEach(() => { FakeResizeObserver.instances = []; vi.stubGlobal("ResizeObserver", FakeResizeObserver); stub = installVideoElementStub(); });
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; videoEl = null; stub.dispose(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe("usePictureBox (#741 4d-ii)", () => {
  it("letterboxes a 1920x1080 picture in an 800x800 element", async () => {
    dims = { width: 800, height: 800, left: 0, top: 0 };
    await mount();
    expect(JSON.parse(boxText())).toEqual({ left: 0, top: 175, width: 800, height: 450 });
  });

  it("pillarboxes a 1080x1920 picture in a 1600x900 element, in the offsetParent's coordinates", async () => {
    dims = { width: 1600, height: 900, left: 10, top: 20 };
    await mount({ width: 1080, height: 1920 });
    const box = JSON.parse(boxText()) as { left: number; top: number; width: number; height: number };
    expect(box.height).toBe(900);
    expect(box.width).toBeCloseTo(506.25, 5);
    expect(box.left).toBeCloseTo(10 + (1600 - 506.25) / 2, 5);
    expect(box.top).toBe(20);
  });

  it("prefers the decoded size over the stored one once metadata loads (a rotated file reports swapped dimensions)", async () => {
    dims = { width: 800, height: 800, left: 0, top: 0 };
    await mount({ width: 1920, height: 1080 });
    await act(async () => { stub.loadMetadata(videoEl!, { duration: 4, videoWidth: 1080, videoHeight: 1920 }); });
    expect(JSON.parse(boxText())).toEqual({ left: 175, top: 0, width: 450, height: 800 });
  });

  it("recomputes when the element is resized", async () => {
    dims = { width: 800, height: 800, left: 0, top: 0 };
    await mount();
    expect(FakeResizeObserver.instances[0]!.observed).toContain(videoEl);
    dims = { width: 1600, height: 900, left: 0, top: 0 };
    await act(async () => { FakeResizeObserver.instances[0]!.fire(); });
    expect(JSON.parse(boxText())).toEqual({ left: 0, top: 0, width: 1600, height: 900 });
  });

  it("recomputes on a window resize (full screen changes the stage)", async () => {
    dims = { width: 800, height: 800, left: 0, top: 0 };
    await mount();
    dims = { width: 960, height: 540, left: 0, top: 0 };
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    expect(JSON.parse(boxText())).toEqual({ left: 0, top: 0, width: 960, height: 540 });
  });

  it("reports no box before the element is laid out, and stops observing on unmount", async () => {
    dims = { width: 0, height: 0, left: 0, top: 0 };
    await mount();
    expect(boxText()).toBe("none");
    await act(async () => { root!.unmount(); });
    root = null;
    expect(FakeResizeObserver.instances[0]!.disconnected).toBe(true);
  });
});
