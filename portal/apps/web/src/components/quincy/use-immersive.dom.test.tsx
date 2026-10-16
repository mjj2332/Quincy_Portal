import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImmersiveState } from "../../lib/immersive";
import { useImmersive } from "./use-immersive";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let api!: ReturnType<typeof useImmersive>;
let setExternal!: (next: ImmersiveState) => void;
let current: ImmersiveState = null;

/** A screen in miniature: a root holding the two buttons the player renders, one at a time. */
function Harness() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<ImmersiveState>(null);
  current = state; setExternal = setState;
  api = useImmersive({ rootRef, state, setState });
  return <div ref={rootRef} data-testid="root">
    <button type="button" data-testid="before">Before</button>
    {state === null ? <button type="button" data-testid="video-fullscreen" onClick={api.toggle}>Full screen</button> : <button type="button" data-testid="video-exit-fullscreen" onClick={api.toggle}>Exit full screen</button>}
    <textarea data-testid="field" />
  </div>;
}
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
let fullscreenElement: Element | null = null;
let requestTarget: Element | null = null;
const request = vi.fn();
const exit = vi.fn();
const setFullscreen = (enabled: boolean) => Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: enabled });

beforeEach(() => {
  fullscreenElement = null; requestTarget = null; request.mockReset(); exit.mockReset();
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement });
  (document as unknown as { exitFullscreen: () => Promise<void> }).exitFullscreen = () => { exit(); fullscreenElement = null; document.dispatchEvent(new Event("fullscreenchange")); return Promise.resolve(); };
  (HTMLElement.prototype as unknown as { requestFullscreen: () => Promise<void> }).requestFullscreen = function (this: Element) { requestTarget = this; request(); fullscreenElement = this; document.dispatchEvent(new Event("fullscreenchange")); return Promise.resolve(); };
  setFullscreen(true);
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  for (const key of ["fullscreenEnabled", "fullscreenElement", "exitFullscreen"]) delete (document as unknown as Record<string, unknown>)[key];
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).requestFullscreen;
  document.body.replaceChildren();
});
async function mount() { const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); await act(async () => { root!.render(<Harness />); }); }
const press = (id: string) => act(async () => { q(id)!.focus(); q(id)!.click(); });

describe("useImmersive (#880, D12)", () => {
  it("the button enters, asks the whole page for element full screen, and moves focus to Exit full screen", async () => {
    await mount();
    await press("video-fullscreen");
    expect(current).toBe("button");
    expect(request).toHaveBeenCalledTimes(1);
    expect(requestTarget).toBe(document.documentElement);
    expect(document.activeElement).toBe(q("video-exit-fullscreen"));
  });

  it("where the browser has no element full screen (iPhone) the in-app layer alone is the full screen", async () => {
    setFullscreen(false);
    await mount();
    await press("video-fullscreen");
    expect(current).toBe("button");
    expect(request).not.toHaveBeenCalled();
  });

  it("a rejected request leaves the in-app layer working", async () => {
    (HTMLElement.prototype as unknown as { requestFullscreen: () => Promise<void> }).requestFullscreen = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
    await mount();
    await press("video-fullscreen");
    expect(current).toBe("button");
    await act(async () => { await Promise.resolve(); });
    expect(current).toBe("button");
  });

  it("Exit full screen leaves, leaves the browser's element full screen too, and puts focus back on Full screen", async () => {
    await mount();
    await press("video-fullscreen");
    await press("video-exit-fullscreen");
    expect(current).toBeNull();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(q("video-fullscreen"));
  });

  it("the browser's own Escape (fullscreenchange to nothing) leaves without a second exit", async () => {
    await mount();
    await press("video-fullscreen");
    await act(async () => { fullscreenElement = null; document.dispatchEvent(new Event("fullscreenchange")); });
    expect(current).toBeNull();
    expect(exit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(q("video-fullscreen"));
  });

  it("a turn enters the layer alone, never asks for element full screen, and leaves cleanly", async () => {
    await mount();
    q("before")!.focus();
    await act(async () => { setExternal("turn"); });
    expect(request).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(q("video-exit-fullscreen"));
    await act(async () => { setExternal(null); });
    expect(exit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(q("before"));
  });

  it("a turn made while typing leaves the field focused (the keyboard stays up)", async () => {
    await mount();
    q("field")!.focus();
    await act(async () => { setExternal("turn"); });
    expect(document.activeElement).toBe(q("field"));
  });

  it("a field left in Full screen is not given the focus back on the way out (#880 S5); one still typing in keeps it", async () => {
    await mount();
    q("field")!.focus();
    await act(async () => { setExternal("turn"); });
    await act(async () => { q("field")!.blur(); });
    await act(async () => { setExternal(null); });
    expect(document.activeElement).not.toBe(q("field"));
    expect(document.activeElement).toBe(q("video-fullscreen"));
    q("field")!.focus();
    await act(async () => { setExternal("turn"); });
    await act(async () => { setExternal(null); });
    expect(document.activeElement).toBe(q("field"));
  });

  it("the page's full screen is released if the screen goes away while it holds it", async () => {
    await mount();
    await press("video-fullscreen");
    await act(async () => { root!.unmount(); }); root = null;
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
