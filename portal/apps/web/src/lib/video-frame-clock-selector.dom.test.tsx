import { act, memo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installVideoElementStub, type VideoElementStub } from "../testing/video-element";
import { useFrameClockSelector, useVideoFrameClock, type VideoFrameClock } from "./video-frame-clock";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const VERSION = { fps: { num: 25, den: 1 }, frameCount: 100 };
let stub: VideoElementStub; let root: Root; let host: HTMLElement;
beforeEach(() => { stub = installVideoElementStub({ rvfc: true }); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root.unmount(); }); stub.dispose(); document.body.replaceChildren(); });

describe("useVideoFrameClock instance and useFrameClockSelector (#741 5b)", () => {
  it("hands out the clock instance once the element mounts, and a selector re-renders only when its value changes", async () => {
    const video = document.createElement("video");
    let instance: VideoFrameClock | null = null;
    let selectorRenders = 0;
    let shown = -1;
    function Probe() {
      const clock = useVideoFrameClock(video, VERSION);
      instance = clock.instance;
      return <Reader clock={clock.instance} />;
    }
    // memo: the parent re-renders with every clock state change; the reader must re-render only through its own selector.
    const Reader = memo(function Reader({ clock }: { clock: VideoFrameClock | null }) {
      shown = useFrameClockSelector(clock, (state) => state.frame, 0);
      selectorRenders += 1;
      return <span data-testid="frame">{shown}</span>;
    });
    await act(async () => { root.render(<Probe />); });
    expect(instance).not.toBeNull();
    await act(async () => { stub.loadMetadata(video, { duration: 4 }); stub.finishSeek(video); stub.presentFrame(video, 0); });
    const before = selectorRenders;
    // Playing flips state without changing the frame: the selector's value is the same, so the reader does not re-render.
    await act(async () => { instance!.play(); });
    expect(selectorRenders).toBe(before);
    await act(async () => { stub.presentFrame(video, 7 / 25); });
    expect(shown).toBe(7);
    expect(host.querySelector("[data-testid=frame]")!.textContent).toBe("7");
  });

  it("a null clock reads the fallback", async () => {
    let shown = -1;
    function Reader() { shown = useFrameClockSelector(null, (state) => state.frame, 42); return null; }
    await act(async () => { root.render(<Reader />); });
    expect(shown).toBe(42);
  });
});
