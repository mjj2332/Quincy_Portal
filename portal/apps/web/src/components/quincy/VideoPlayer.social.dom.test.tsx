import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { installLocalStorageShim } from "../../testing/local-storage";
import { resetUiPrefMemory } from "../../lib/ui-prefs";
import { VideoPlayer, type VideoPlayerVersion } from "./VideoPlayer";
import type { SocialPreviewMode } from "./SocialPreviewControls";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const version: VideoPlayerVersion = {
  streamUrl: "/media/video/77777777-7777-4777-8777-777777777777", fps: { num: 25, den: 1 }, frameCount: 101, width: 1920, height: 1080,
  tcNominalFps: 25, tcDropFrame: false, startTimecodeFrames: null, hasAudio: true,
};
const A = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Reels safe zone", imageUrl: "/social-overlay-images/a/1" };
const B = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "TikTok safe zone", imageUrl: "/social-overlay-images/b/2" };
const socialOf = (over: Partial<SocialPreviewMode> = {}): SocialPreviewMode => ({ overlays: [A, B], currentId: A.id, onOverlay: () => undefined, fit: "fill", onFit: () => undefined, status: "ready", onRetry: () => undefined, ...over });

let stub: VideoElementStub;
let root: Root | null = null;
let host: HTMLElement;
let shim: ReturnType<typeof installLocalStorageShim>;
type Props = Partial<React.ComponentProps<typeof VideoPlayer>>;
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const flush = async () => { for (let i = 0; i < 3; i += 1) await act(async () => { await Promise.resolve(); }); };
async function mount(props: Props) {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<VideoPlayer version={version} title="Main walkthrough" {...props} />); });
  const video = host.querySelector("video")!;
  await act(async () => { stub.loadMetadata(video, { duration: 4.04, videoWidth: 1920, videoHeight: 1080 }); });
  await act(async () => { stub.finishSeek(video); stub.presentFrame(video, 0); });
}
beforeEach(() => { stub = installVideoElementStub(); shim = installLocalStorageShim(); resetUiPrefMemory(); });
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; stub.dispose(); shim.restore(); resetUiPrefMemory(); vi.unstubAllGlobals(); document.body.replaceChildren();
});

describe("VideoPlayer Social preview (#871)", () => {
  it("frames the film 9:16 with Fill, and Fit switches the object-fit", async () => {
    await mount({ social: socialOf() });
    expect(byTestId("video-stage")!.dataset.social).toBe("fill");
    expect(host.querySelector("video")!.className).toContain("object-cover");
    await act(async () => { root!.render(<VideoPlayer version={version} title="Main walkthrough" social={socialOf({ fit: "fit" })} />); });
    expect(byTestId("video-stage")!.dataset.social).toBe("fit");
    expect(host.querySelector("video")!.className).toContain("object-contain");
  });

  it("toggling Social and Fit keeps the same <video> element (no remount)", async () => {
    await mount({});
    const before = host.querySelector("video");
    const render = (social?: SocialPreviewMode) => act(async () => { root!.render(<VideoPlayer version={version} title="Main walkthrough" {...(social ? { social } : {})} />); });
    await render(socialOf());
    expect(host.querySelector("video")).toBe(before);
    await render(socialOf({ fit: "fit" }));
    expect(host.querySelector("video")).toBe(before);
    await render();
    expect(host.querySelector("video")).toBe(before);
    expect(byTestId("video-stage")!.dataset.social).toBeUndefined();
  });

  it("draws the current overlay over the whole frame, inert and hidden from assistive tech, and never the timecode chip", async () => {
    await mount({ social: socialOf() });
    const img = byTestId("video-social-overlay") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(A.imageUrl);
    expect(img.getAttribute("aria-hidden")).toBe("true");
    expect(img.getAttribute("alt")).toBe("");
    expect(img.className).toContain("pointer-events-none");
    expect(byTestId("video-timecode-chip")).toBeNull();
  });

  it("a failed overlay image says so instead of passing the unframed film off as a preview", async () => {
    await mount({ social: socialOf() });
    await act(async () => { byTestId("video-social-overlay")!.dispatchEvent(new Event("error")); });
    expect(document.body.textContent).toContain("Overlay unavailable");
  });

  it("clears the failure when the image loads, and on a new attempt", async () => {
    await mount({ social: socialOf() });
    await act(async () => { byTestId("video-social-overlay")!.dispatchEvent(new Event("error")); });
    expect(document.body.textContent).toContain("Overlay unavailable");
    await act(async () => { byTestId("video-social-overlay")!.dispatchEvent(new Event("load")); });
    expect(document.body.textContent).not.toContain("Overlay unavailable");
    await act(async () => { byTestId("video-social-overlay")!.dispatchEvent(new Event("error")); });
    await act(async () => { root!.render(<VideoPlayer version={version} title="x" social={socialOf({ currentId: B.id })} />); });
    expect(document.body.textContent).not.toContain("Overlay unavailable");
    await act(async () => { root!.render(<VideoPlayer version={version} title="x" social={socialOf({ currentId: A.id })} />); });
    expect(document.body.textContent).not.toContain("Overlay unavailable");
  });

  it("lists the resolved overlays by name and reports a pick; a single overlay shows its name with no select", async () => {
    const onOverlay = vi.fn();
    await mount({ social: socialOf({ onOverlay }) });
    const trigger = byTestId("video-social-overlay-select")!;
    expect(trigger.textContent).toContain(A.name);
    await act(async () => { trigger.click(); });
    await flush();
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.map((o) => o.textContent)).toEqual([A.name, B.name]);
    await act(async () => { options[1]!.click(); });
    expect(onOverlay).toHaveBeenCalledWith(B.id);
  });

  it("one overlay: its name as text, no select", async () => {
    await mount({ social: socialOf({ overlays: [A] }) });
    expect(byTestId("video-social-overlay-select")).toBeNull();
    expect(byTestId("video-social-overlay-name")!.textContent).toBe(A.name);
  });

  it("Fill / Fit reports the pick", async () => {
    const onFit = vi.fn();
    await mount({ social: socialOf({ onFit }) });
    await act(async () => { byTestId("video-social-fit")!.click(); });
    expect(onFit).toHaveBeenCalledWith("fit");
  });

  it("loading, failed (Retry) and empty library each say so, and the film stays framed", async () => {
    await mount({ social: socialOf({ status: "loading", overlays: [], currentId: null }) });
    expect(host.querySelector('[role="status"]')!.textContent).toContain("Loading overlays");
    expect(byTestId("video-social-overlay")).toBeNull();
    const onRetry = vi.fn();
    await act(async () => { root!.render(<VideoPlayer version={version} title="x" social={socialOf({ status: "error", overlays: [], currentId: null, onRetry })} />); });
    await act(async () => { byTestId("video-social-retry")!.click(); });
    expect(onRetry).toHaveBeenCalledTimes(1);
    await act(async () => { root!.render(<VideoPlayer version={version} title="x" social={socialOf({ overlays: [], currentId: null })} />); });
    expect(document.body.textContent).toContain("No overlay available");
    expect(byTestId("video-stage")!.dataset.social).toBe("fill");
  });

  it("ignores markers, range, marks, draw and the markup overlay while it is on; playback keys still work", async () => {
    const onMark = vi.fn();
    await mount({
      social: socialOf(), onMark, markers: [{ id: "m", startFrame: 5, endFrame: null, tone: "open" } as never], pendingRange: { startFrame: 1, endFrame: 3 },
      range: { marks: { in: null, out: null }, locked: false, clear: () => undefined },
      transportActions: <button data-testid="draw-slot" type="button">Draw</button>, overlay: <div data-testid="markup-slot" />,
    });
    expect(byTestId("video-marker-lane")).toBeNull();
    expect(byTestId("video-pending-band")).toBeNull();
    expect(byTestId("video-range-button")).toBeNull();
    expect(byTestId("video-range-handles")).toBeNull();
    expect(byTestId("draw-slot")).toBeNull();
    expect(byTestId("markup-slot")).toBeNull();
    await act(async () => { byTestId("video-player")!.dispatchEvent(new KeyboardEvent("keydown", { key: "i", bubbles: true, cancelable: true })); });
    expect(onMark).not.toHaveBeenCalled();
    expect(byTestId("video-key-legend")!.textContent).not.toContain("in/out");
    await act(async () => { byTestId("video-player")!.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })); });
    expect(byTestId("video-scrubber")).not.toBeNull();
  });
});

describe("VideoPlayer watermark slot (#872)", () => {
  // The `<video>` fills a 400x700 frame; its 1920x1080 picture contained in it is 400x225, centred at top 237.5.
  const stubOffsets = () => {
    for (const [prop, value] of [["offsetWidth", 400], ["offsetHeight", 700], ["offsetLeft", 0], ["offsetTop", 0]] as const) Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
  };
  afterEach(() => { for (const prop of ["offsetWidth", "offsetHeight", "offsetLeft", "offsetTop"] as const) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop]; });
  const mark = (box: { left: number; top: number; width: number; height: number }) => <div data-testid="wm" data-box={`${box.left},${box.top},${box.width},${box.height}`} />;

  it("draws the watermark over the picture box when Social is off", async () => {
    stubOffsets();
    await mount({ watermark: mark });
    expect(byTestId("wm")).not.toBeNull();
    expect(byTestId("video-social-frame")!.contains(byTestId("wm"))).toBe(false);
    expect(byTestId("wm")!.dataset.box).toBe("0,237.5,400,225");
  });

  it("keeps the watermark inside the Social frame, sized to the frame in Fill and to the picture in Fit, while overlay is still dropped", async () => {
    stubOffsets();
    await mount({ social: socialOf(), watermark: mark, overlay: <div data-testid="markup-slot" /> });
    expect(byTestId("video-social-frame")!.contains(byTestId("wm"))).toBe(true);
    expect(byTestId("wm")!.dataset.box).toBe("0,0,400,700");
    expect(byTestId("markup-slot")).toBeNull();
    await act(async () => { root!.render(<VideoPlayer version={version} title="Main walkthrough" social={socialOf({ fit: "fit" })} watermark={mark} />); });
    expect(byTestId("video-social-frame")!.contains(byTestId("wm"))).toBe(true);
    expect(byTestId("wm")!.dataset.box).toBe("0,237.5,400,225");
  });
});
