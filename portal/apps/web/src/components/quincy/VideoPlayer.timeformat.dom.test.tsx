import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { installLocalStorageShim } from "../../testing/local-storage";
import { resetUiPrefMemory } from "../../lib/ui-prefs";
import { TIME_FORMAT_KEY } from "../../lib/time-format-prefs";
import { VideoPlayer, type VideoPlayerVersion } from "./VideoPlayer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FPS_25 = { num: 25, den: 1 };
const versionOf = (over: Partial<VideoPlayerVersion> = {}): VideoPlayerVersion => ({
  streamUrl: "/media/video/77777777-7777-4777-8777-777777777777", fps: FPS_25, frameCount: 100, width: 1920, height: 1080,
  tcNominalFps: 25, tcDropFrame: false, startTimecodeFrames: null, hasAudio: true, ...over,
});

let stub: VideoElementStub;
let root: Root | null = null;
let host: HTMLElement;
let shim: ReturnType<typeof installLocalStorageShim>;
const video = () => host.querySelector("video")!;
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const readout = () => byTestId("video-readout")!.textContent;
const flush = async (n = 3) => { for (let i = 0; i < n; i += 1) await act(async () => { await Promise.resolve(); }); };

async function mount(version = versionOf()) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<VideoPlayer version={version} title="Main walkthrough" />); });
}
async function load(duration = 4) {
  await act(async () => { stub.loadMetadata(video(), { duration, videoWidth: 1920, videoHeight: 1080 }); });
  await act(async () => { stub.finishSeek(video()); stub.presentFrame(video(), 0); });
}
const present = (frame: number, fps = FPS_25) => act(async () => { stub.presentFrame(video(), (frame * fps.den) / fps.num); });
const openMenu = async () => { await act(async () => { byTestId("video-time-format-trigger")!.click(); await Promise.resolve(); await Promise.resolve(); }); await flush(2); };
const pick = async (id: string) => { await openMenu(); await act(async () => { byTestId(`video-time-format-${id}`)!.click(); await Promise.resolve(); }); await flush(2); };

beforeEach(() => { stub = installVideoElementStub(); shim = installLocalStorageShim(); resetUiPrefMemory(); });
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; stub.dispose(); shim.restore(); resetUiPrefMemory(); vi.unstubAllGlobals(); document.body.replaceChildren();
});

describe("VideoPlayer time format menu (#860)", () => {
  it("defaults to Timecode: the trigger says so and the readout is today's SMPTE, start timecode included", async () => {
    await mount(versionOf({ startTimecodeFrames: 90000 }));
    expect(byTestId("video-time-format-trigger")!.getAttribute("aria-label")).toBe("Time format: Timecode");
    expect(readout()).toBe("01:00:00:00 / 01:00:04:00");
  });

  it("keeps 29.97 drop-frame in Timecode", async () => {
    const fps = { num: 30000, den: 1001 };
    await mount(versionOf({ fps, tcNominalFps: 30, tcDropFrame: true, frameCount: 4000 }));
    await load(4000 * 1001 / 30000);
    await present(1800, fps);
    expect(readout()).toMatch(/^00:01:00;02 \//);
  });

  it("offers Timecode, Standard and Frames, with the current one checked", async () => {
    await mount();
    await openMenu();
    const ids = ["timecode", "standard", "frames"];
    expect(ids.map((id) => byTestId(`video-time-format-${id}`)?.textContent)).toEqual(["Timecode", "Standard", "Frames"]);
    expect(byTestId("video-time-format-timecode")!.getAttribute("aria-checked")).toBe("true");
    expect(byTestId("video-time-format-standard")!.getAttribute("aria-checked")).toBe("false");
  });

  it("Standard reads elapsed m:ss, ignoring the start timecode: readout and slider text follow", async () => {
    await mount(versionOf({ startTimecodeFrames: 90000 }));
    await load();
    await pick("standard");
    expect(readout()).toBe("0:00 / 0:04");
    expect(host.querySelector('input[aria-label="Timeline"]')!.getAttribute("aria-valuetext")).toBe("0:00");
    expect(byTestId("video-time-format-trigger")!.getAttribute("aria-label")).toBe("Time format: Standard");
  });

  it("Standard floors the rational rate: 29.97 frame 1798 is 0:59 and 1800 is 1:00; an hour reads h:mm:ss", async () => {
    const fps = { num: 30000, den: 1001 };
    await mount(versionOf({ fps, tcNominalFps: 30, tcDropFrame: true, frameCount: 4000 }));
    await load(4000 * 1001 / 30000);
    await pick("standard");
    await present(1798, fps);
    expect(readout()).toMatch(/^0:59 \//);
    await present(1800, fps);
    expect(readout()).toMatch(/^1:00 \//);
  });

  it("Standard past an hour reads 1:00:00", async () => {
    await mount(versionOf({ frameCount: 100000 }));
    await load(4000);
    await pick("standard");
    await present(90000);
    expect(readout()).toMatch(/^1:00:00 \//);
  });

  it("Frames reads the 0-based frame index", async () => {
    await mount();
    await load();
    await pick("frames");
    expect(readout()).toBe("0 / 100");
    await present(7);
    expect(readout()).toBe("7 / 100");
  });

  it("the choice persists in the browser, survives a remount and is shared under the one key", async () => {
    await mount();
    await pick("frames");
    expect(JSON.parse(shim.values.get(TIME_FORMAT_KEY)!)).toBe("frames");
    await act(async () => { root!.unmount(); });
    root = null; document.body.replaceChildren();
    await mount();
    expect(readout()).toBe("0 / 100");
  });

  it("a stored junk value falls back to Timecode", async () => {
    shim.values.set(TIME_FORMAT_KEY, JSON.stringify("sideways"));
    await mount();
    expect(byTestId("video-time-format-trigger")!.getAttribute("aria-label")).toBe("Time format: Timecode");
  });

  it("blocked storage still keeps the choice for the session", async () => {
    shim.restore();
    shim = installLocalStorageShim({ blockWrites: true });
    await mount();
    await pick("standard");
    expect(readout()).toBe("0:00 / 0:04");
  });

  it("keys typed inside the open menu do not move the frame", async () => {
    await mount();
    await load();
    await openMenu();
    const item = byTestId("video-time-format-standard")!;
    await act(async () => { item.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); });
    await act(async () => { item.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true, cancelable: true })); });
    expect(stub.calls.filter((c) => /seek|play/i.test(String(c))).length).toBe(0);
    expect(readout()).toMatch(/^00:00:00:00 \//);
  });

  it("in full screen the menu portals inside the player so it can be seen", async () => {
    await mount();
    await load();
    const player = byTestId("video-player")!;
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: player });
    try {
      await act(async () => { document.dispatchEvent(new Event("fullscreenchange")); });
      await openMenu();
      expect(player.contains(byTestId("video-time-format-standard"))).toBe(true);
    } finally { delete (document as unknown as Record<string, unknown>).fullscreenElement; }
  });
});
