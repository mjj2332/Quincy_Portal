import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReresolveOnResize } from "./use-reresolve-on-resize";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** #602: a popup's collision padding is read at open; a viewport resize while it is open re-reads it, once per frame. */
let root: Root;
let host: HTMLElement;
let frames: FrameRequestCallback[];

beforeEach(() => {
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.push(cb); return frames.length; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const flushFrames = async () => { await act(async () => { const run = frames; frames = []; run.forEach((cb) => cb(0)); }); };

function Probe({ open, resolve }: { open: boolean; resolve: () => number }) {
  const [value, setValue] = useState<number | undefined>(undefined);
  useReresolveOnResize(open, resolve, setValue);
  return <output>{value ?? "none"}</output>;
}

describe("useReresolveOnResize (#602)", () => {
  it("re-reads on resize while open, coalescing a burst into one read per frame", async () => {
    let n = 0;
    const resolve = vi.fn(() => ++n);
    await act(async () => { root.render(<Probe open resolve={resolve} />); });
    expect(resolve).not.toHaveBeenCalled(); // the open edge is the caller's; the hook only follows resizes
    await act(async () => { window.dispatchEvent(new Event("resize")); window.dispatchEvent(new Event("resize")); window.dispatchEvent(new Event("resize")); });
    expect(resolve).not.toHaveBeenCalled(); // waits for the frame
    await flushFrames();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(host.querySelector("output")!.textContent).toBe("1");
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    await flushFrames();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("does nothing while closed, and stops listening when it closes", async () => {
    const resolve = vi.fn(() => 1);
    await act(async () => { root.render(<Probe open={false} resolve={resolve} />); });
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    await flushFrames();
    expect(resolve).not.toHaveBeenCalled();
    await act(async () => { root.render(<Probe open resolve={resolve} />); });
    await act(async () => { root.render(<Probe open={false} resolve={resolve} />); });
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    await flushFrames();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("uses the latest resolve without re-subscribing", async () => {
    const first = vi.fn(() => 1);
    const second = vi.fn(() => 2);
    await act(async () => { root.render(<Probe open resolve={first} />); });
    await act(async () => { root.render(<Probe open resolve={second} />); });
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    await flushFrames();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
