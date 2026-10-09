import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frameSeekSeconds } from "@quincy/shared";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { VideoPlayer, type VideoPlayerControl, type VideoPlayerVersion } from "./VideoPlayer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FPS_25 = { num: 25, den: 1 };
const versionOf = (over: Partial<VideoPlayerVersion> = {}): VideoPlayerVersion => ({
  streamUrl: "/media/video/77777777-7777-4777-8777-777777777777", fps: FPS_25, frameCount: 3000, width: 1920, height: 1080,
  tcNominalFps: 25, tcDropFrame: false, startTimecodeFrames: null, hasAudio: true, ...over,
});

let stub: VideoElementStub;
let root: Root | null = null;
let host: HTMLElement;
const video = () => host.querySelector("video")!;
const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === name)!;

async function mount(version = versionOf(), props: Partial<React.ComponentProps<typeof VideoPlayer>> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<VideoPlayer version={version} title="Main walkthrough" {...props} />); });
}
/** Lands frame 0 the way a real load does, so the clock starts settled. */
async function load(duration = 3000 / 25) {
  await act(async () => { stub.loadMetadata(video(), { duration, videoWidth: 1920, videoHeight: 1080 }); });
  await act(async () => { stub.finishSeek(video()); stub.presentFrame(video(), 0); });
  stub.writes.length = 0; stub.calls.length = 0;
}
const present = (frame: number, fps = FPS_25) => act(async () => { stub.presentFrame(video(), (frame * fps.den) / fps.num); });
async function key(k: string, init: KeyboardEventInit = {}, target: Element = byTestId("video-player")!) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })); });
}

beforeEach(() => { stub = installVideoElementStub(); });
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; stub.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren();
});

describe("VideoPlayer element (#741 4d-ii)", () => {
  it("streams the Version with no native controls and no download, picture-in-picture or context-menu affordance", async () => {
    await mount();
    const el = video();
    expect(el.getAttribute("src")).toBe("/media/video/77777777-7777-4777-8777-777777777777");
    expect(el.hasAttribute("controls")).toBe(false);
    expect(el.getAttribute("controlslist")).toContain("nodownload");
    expect(el.hasAttribute("disablepictureinpicture")).toBe(true);
    expect(el.getAttribute("preload")).toBe("auto");
    expect(host.querySelector("a")).toBeNull();
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => { el.dispatchEvent(menu); });
    expect(menu.defaultPrevented).toBe(true);
  });

  it("an element error shows a notice in the stage and still offers no download", async () => {
    await mount();
    await act(async () => { video().dispatchEvent(new Event("error")); });
    const notice = host.querySelector('[role="alert"]');
    expect(notice?.textContent).toBe("This version can't play in this browser.");
    expect(byTestId("video-stage")!.contains(notice)).toBe(true);
    expect(host.querySelector("a")).toBeNull();
  });
});

describe("VideoPlayer timecode (#741 4d-ii)", () => {
  it("reads the Version's stored start timecode: 90000 frames at 25 fps is 01:00:00:00 at frame 0, with the end label beside it", async () => {
    await mount(versionOf({ startTimecodeFrames: 90000, frameCount: 100 }));
    expect(byTestId("video-readout")!.textContent).toBe("01:00:00:00 / 01:00:04:00");
  });

  it("shows the timecode of the frame the browser presented, with the frame number", async () => {
    await mount(versionOf({ startTimecodeFrames: 90000 }));
    await load();
    await present(1063);
    expect(byTestId("video-readout")!.textContent).toMatch(/^01:00:42:13 \//);
  });

  it("23.976 non-drop: frame 1000 is 00:00:41:16", async () => {
    const fps = { num: 24000, den: 1001 };
    await mount(versionOf({ fps, tcNominalFps: 24, frameCount: 4000 }));
    await load(4000 * 1001 / 24000);
    await present(1000, fps);
    expect(byTestId("video-readout")!.textContent).toMatch(/^00:00:41:16 \//);
  });

  it("29.97 drop-frame: frame 1799 is 00:00:59;29 and the next frame skips to 00:01:00;02", async () => {
    const fps = { num: 30000, den: 1001 };
    await mount(versionOf({ fps, tcNominalFps: 30, tcDropFrame: true, frameCount: 4000 }));
    await load(4000 * 1001 / 30000);
    await present(1799, fps);
    expect(byTestId("video-readout")!.textContent).toMatch(/^00:00:59;29 \//);
    await present(1800, fps);
    expect(byTestId("video-readout")!.textContent).toMatch(/^00:01:00;02 \//);
  });

  it("the Timeline thumb carries the keyboard focus ring: the input sits inside the thumb that paints it on :focus-visible", async () => {
    await mount(versionOf());
    await load();
    const slider = host.querySelector<HTMLInputElement>('input[aria-label="Timeline"]')!;
    const thumb = slider.parentElement!;
    expect(thumb.getAttribute("role")).toBeNull();
    expect(thumb.className).toContain("has-[:focus-visible]:outline-solid");
    expect(thumb.className).toContain("has-[:focus-visible]:outline-offset-2");
  });

  it("sizing: the video is out of flow so the stage takes the free height; phone stage is capped; readout aligns on phones", async () => {
    await mount(versionOf());
    await load();
    const video = host.querySelector("video")!;
    expect(video.className).toContain("absolute");
    expect(video.className).toContain("inset-0");
    const stage = byTestId("video-stage")!;
    expect(stage.className).toContain("relative");
    expect(stage.className).toContain("max-[721px]:max-h-[55dvh]");
    expect(stage.className).not.toContain("min-h-[45dvh]");
    expect(byTestId("video-readout")!.className).toContain("max-[721px]:px-0");
  });

  it("the scrubber is a slider named Timeline whose value text is the timecode", async () => {
    await mount(versionOf({ startTimecodeFrames: 90000 }));
    await load();
    await present(1063);
    const slider = host.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(slider.getAttribute("aria-label")).toBe("Timeline");
    expect(slider.getAttribute("aria-valuetext")).toBe("01:00:42:13");
    expect(slider.getAttribute("aria-valuenow")).toBe("1063");
    expect(slider.getAttribute("max")).toBe("2999");
  });

  it("announces politely only while paused", async () => {
    await mount();
    await load();
    expect(byTestId("video-readout")!.getAttribute("aria-live")).toBe("polite");
    await key(" ");
    expect(byTestId("video-readout")!.getAttribute("aria-live")).toBe("off");
  });
});

describe("VideoPlayer picture box (#741 4d-ii)", () => {
  it("places the timecode chip inside the picture, not in the letterbox band", async () => {
    const original = Object.getOwnPropertyDescriptors(HTMLElement.prototype);
    for (const [prop, value] of [["offsetWidth", 800], ["offsetHeight", 800], ["offsetLeft", 0], ["offsetTop", 0]] as const) Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
    try {
      await mount(versionOf({ startTimecodeFrames: 90000 }));
      await load();
      await present(1063);
      const picture = byTestId("video-picture-box")!;
      expect(picture.style.top).toBe("175px");
      expect(picture.style.height).toBe("450px");
      expect(picture.style.width).toBe("800px");
      const chip = byTestId("video-timecode-chip")!;
      expect(picture.contains(chip)).toBe(true);
      expect(chip.textContent).toBe("01:00:42:13 · frame 1063");
      expect(chip.getAttribute("aria-hidden")).toBe("true");
    } finally {
      for (const prop of ["offsetWidth", "offsetHeight", "offsetLeft", "offsetTop"] as const) {
        const d = original[prop];
        if (d) Object.defineProperty(HTMLElement.prototype, prop, d); else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
      }
    }
  });
});

async function withLayout(width: number, height: number, run: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptors(HTMLElement.prototype);
  for (const [prop, value] of [["offsetWidth", width], ["offsetHeight", height], ["offsetLeft", 0], ["offsetTop", 0]] as const) Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
  try { await run(); } finally {
    for (const prop of ["offsetWidth", "offsetHeight", "offsetLeft", "offsetTop"] as const) {
      const d = original[prop];
      if (d) Object.defineProperty(HTMLElement.prototype, prop, d); else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    }
  }
}

describe("VideoPlayer layout (#741 4d-ii design review)", () => {
  it("sizes the stage from the height left over on desktop, and from the film's own shape when stacked", async () => {
    await mount(versionOf({ width: 1080, height: 1920 }));
    const stage = byTestId("video-stage")!;
    expect(stage.className).not.toContain("aspect-video");
    expect(stage.className).toContain("flex-1");
    expect(stage.className).toContain("min-h-0");
    expect(stage.className).toContain("max-[721px]:max-h-[55dvh]");
    expect(stage.className).toContain("max-[721px]:[aspect-ratio:var(--stage-ratio)]");
    expect(stage.style.getPropertyValue("--stage-ratio")).toBe("1080/1920");
    expect(byTestId("video-player")!.className).toContain("min-h-0");
  });

  it("keeps the timecode chip on one line and drops the frame number when the picture is too narrow for it", async () => {
    await withLayout(800, 800, async () => {
      await mount();
      await load();
      expect(byTestId("video-timecode-chip")!.className).toContain("whitespace-nowrap");
      expect(byTestId("video-timecode-chip")!.className).toContain("max-w-[calc(100%-var(--space-4))]");
      expect(byTestId("video-timecode-chip")!.textContent).toBe("00:00:00:00 · frame 0");
    });
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    await withLayout(120, 120, async () => {
      await mount();
      await load();
      expect(byTestId("video-timecode-chip")!.textContent).toBe("00:00:00:00");
    });
  });

  it("hides the key legend on touch and narrow screens, and paints its chips with the Lightbox's readable shortcut skin", async () => {
    await mount();
    const legend = byTestId("video-key-legend")!;
    expect(legend.className).toContain("pointer-coarse:hidden");
    expect(legend.className).toContain("max-[721px]:hidden");
    for (const kbd of legend.querySelectorAll("kbd:not(:has(kbd))")) {
      expect(kbd.className).toContain("bg-secondary");
      expect(kbd.className).toContain("text-foreground");
    }
  });

  it("makes Mute and Full screen the same borderless icon size as the other buttons", async () => {
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
    try {
      await mount();
      for (const name of ["Mute", "Full screen"]) {
        expect(button(name).className, name).not.toContain("border-input");
        expect(button(name).className, name).not.toContain("h-7");
      }
      expect(button("Mute").className).toContain("size-8");
      expect(button("Full screen").className).toContain("size-8");
    } finally { delete (document as unknown as Record<string, unknown>).fullscreenEnabled; }
  });
});

describe("VideoPlayer keyboard (#741 4d-ii)", () => {
  it("Space and K toggle play and pause", async () => {
    await mount(); await load();
    await key(" "); expect(video().paused).toBe(false); expect(button("Pause")).toBeDefined();
    await key(" "); expect(video().paused).toBe(true); expect(button("Play")).toBeDefined();
    await key("k"); await act(async () => { document.dispatchEvent(new KeyboardEvent("keyup", { key: "k", bubbles: true })); });
    expect(video().paused).toBe(false);
    await key("K"); expect(video().paused).toBe(true);
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keyup", { key: "K", bubbles: true })); });
    expect(video().paused).toBe(true);
  });

  it("L plays forward and climbs 1x, 2x, 4x, 8x", async () => {
    await mount(); await load();
    const rates: number[] = [];
    for (let i = 0; i < 5; i += 1) { await key("l"); rates.push(video().playbackRate); }
    expect(rates).toEqual([1, 2, 4, 8, 8]);
    await key("j"); expect(video().playbackRate).toBe(4);
  });

  it("the arrows step one frame, to the middle of that frame, and stop at both ends", async () => {
    await mount(); await load();
    await key("ArrowLeft"); expect(stub.writes).toEqual([]);
    await key("ArrowRight"); expect(stub.writes).toEqual([frameSeekSeconds(1, FPS_25)]);
    await act(async () => { stub.finishSeek(video()); stub.presentFrame(video(), 1 / 25); });
    await key("ArrowLeft"); expect(stub.writes.at(-1)).toBe(frameSeekSeconds(0, FPS_25));
    await key("End"); await act(async () => { stub.finishSeek(video()); });
    expect(stub.writes.at(-1)).toBe(frameSeekSeconds(2999, FPS_25));
    await key("Home"); await act(async () => { stub.finishSeek(video()); });
    expect(stub.writes.at(-1)).toBe(frameSeekSeconds(0, FPS_25));
  });

  it("three quick right-arrows make one seek in flight and one more for the final frame", async () => {
    await mount(); await load();
    await key("ArrowRight"); await key("ArrowRight"); await key("ArrowRight");
    expect(stub.writes).toEqual([frameSeekSeconds(1, FPS_25)]);
    await act(async () => { stub.finishSeek(video()); });
    expect(stub.writes).toEqual([frameSeekSeconds(1, FPS_25), frameSeekSeconds(3, FPS_25)]);
  });

  it("J runs backward muted, one seek per landing, and Space stops it and restores sound", async () => {
    vi.useFakeTimers();
    await mount(); await load();
    await key("End"); await act(async () => { stub.finishSeek(video()); stub.presentFrame(video(), 2999 / 25); });
    stub.writes.length = 0;
    await key("j");
    expect(video().muted).toBe(true);
    expect(button("Pause")).toBeDefined();
    await act(async () => { vi.advanceTimersByTime(40); });
    expect(stub.writes).toEqual([frameSeekSeconds(2998, FPS_25)]);
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(stub.writes).toHaveLength(1);
    await act(async () => { stub.finishSeek(video()); });
    expect(stub.writes).toHaveLength(2);
    expect(stub.writes[1]!).toBeLessThan(frameSeekSeconds(2998, FPS_25));
    await key(" ");
    expect(video().muted).toBe(false);
    expect(button("Play")).toBeDefined();
  });

  it("J stops at frame 0", async () => {
    vi.useFakeTimers();
    await mount(); await load();
    await key("ArrowRight"); await act(async () => { stub.finishSeek(video()); stub.presentFrame(video(), 1 / 25); });
    stub.writes.length = 0;
    await key("j");
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(stub.writes).toEqual([frameSeekSeconds(0, FPS_25)]);
    await act(async () => { stub.finishSeek(video()); });
    expect(button("Play")).toBeDefined();
    expect(video().muted).toBe(false);
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(stub.writes).toHaveLength(1);
  });

  it("ignores keys typed into a field inside the player, modified keys, and IME composition", async () => {
    await mount(); await load();
    const field = document.createElement("textarea");
    byTestId("video-player")!.appendChild(field);
    await key(" ", {}, field); await key("ArrowRight", {}, field); await key("k", {}, field);
    await key("ArrowRight", { ctrlKey: true }); await key("ArrowRight", { metaKey: true }); await key("k", { isComposing: true });
    expect(stub.writes).toEqual([]);
    expect(stub.calls).toEqual([]);
  });

  it("Space on a focused button leaves it to the button, while the arrows still step", async () => {
    await mount(); await load();
    await key(" ", {}, button("Next frame"));
    expect(stub.calls).toEqual([]);
    await key("ArrowRight", {}, button("Next frame"));
    expect(stub.writes).toEqual([frameSeekSeconds(1, FPS_25)]);
  });

  it("I and O are not bound (reserved for in/out points)", async () => {
    await mount(); await load();
    await key("i"); await key("o");
    expect(stub.writes).toEqual([]);
    expect(stub.calls).toEqual([]);
  });

  it("lets a host take the keys: no listener of its own, and the control handles an event on request", async () => {
    const control = createRef<VideoPlayerControl>();
    await mount(versionOf(), { keyboard: "host", controlRef: control });
    await load();
    await key(" ");
    expect(stub.calls).toEqual([]);
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    host.dispatchEvent(event);
    let handled = false;
    await act(async () => { handled = control.current!.handleKeyDown(event); });
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(stub.calls).toEqual(["play"]);
  });
});

describe("VideoPlayer transport (#741 4d-ii)", () => {
  it("the frame buttons step and the play button plays", async () => {
    await mount(); await load();
    await act(async () => { button("Next frame").click(); });
    expect(stub.writes).toEqual([frameSeekSeconds(1, FPS_25)]);
    await act(async () => { stub.finishSeek(video()); stub.presentFrame(video(), 1 / 25); });
    await act(async () => { button("Previous frame").click(); });
    expect(stub.writes.at(-1)).toBe(frameSeekSeconds(0, FPS_25));
    await act(async () => { button("Play").click(); });
    expect(video().paused).toBe(false);
  });

  it("mute toggles the element", async () => {
    await mount(); await load();
    const mute = button("Mute");
    expect(mute.getAttribute("aria-pressed")).toBe("false");
    await act(async () => { mute.click(); });
    expect(video().muted).toBe(true);
    expect(button("Mute").getAttribute("aria-pressed")).toBe("true");
  });

  it("every transport control meets the coarse-pointer tap target", async () => {
    await mount();
    for (const name of ["Previous frame", "Play", "Next frame", "Mute"]) {
      expect(button(name).className, name).toContain("pointer-coarse:min-h-11");
      expect(button(name).className, name).toContain("max-[721px]:min-h-11");
    }
  });

  it("the full screen button shows only where the browser allows it, and fullscreens a wrapper holding the stage and the controls", async () => {
    await mount();
    expect(host.querySelector('button[aria-label="Full screen"]')).toBeNull();
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
    try {
      await mount();
      const request = vi.fn(() => Promise.resolve());
      const player = byTestId("video-player")!;
      let target: Element | null = null;
      (HTMLElement.prototype as unknown as { requestFullscreen: () => Promise<void> }).requestFullscreen = function (this: Element) { target = this; return request(); };
      await act(async () => { button("Full screen").click(); });
      expect(request).toHaveBeenCalledTimes(1);
      expect(target).toBe(player);
      expect(player.contains(byTestId("video-stage"))).toBe(true);
      expect(player.contains(byTestId("video-scrubber"))).toBe(true);
      expect(player.contains(button("Next frame"))).toBe(true);
    } finally { delete (document as unknown as Record<string, unknown>).fullscreenEnabled; delete (HTMLElement.prototype as unknown as Record<string, unknown>).requestFullscreen; }
  });

  it("lists the shortcuts with Kbd", async () => {
    await mount();
    const legend = byTestId("video-key-legend")!;
    expect([...legend.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(expect.arrayContaining(["J", "K", "L", "←", "→", "Space"]));
  });
});

describe("VideoPlayer K chords (#741 4d-ii Sol final)", () => {
  const keyup = (k: string) => act(async () => { document.dispatchEvent(new KeyboardEvent("keyup", { key: k, bubbles: true })); });

  it("held K + L steps one frame forward and held K + J one frame back", async () => {
    await mount(); await load();
    await key("k");
    await key("l");
    expect(stub.writes).toEqual([frameSeekSeconds(1, FPS_25)]);
    expect(video().paused).toBe(true);
    await act(async () => { stub.finishSeek(video()); stub.presentFrame(video(), 1 / 25); });
    await key("j");
    expect(stub.writes.at(-1)).toBe(frameSeekSeconds(0, FPS_25));
    expect(video().paused).toBe(true);
  });

  describe("K held from paused does not start playback before the chord", () => {
    it("paused frame 0: K down, J, K up stays paused at frame 0 and never plays", async () => {
      await mount(); await load();
      await key("k"); await key("j"); await keyup("k");
      expect(video().paused).toBe(true);
      expect(stub.calls.filter((c) => c === "play")).toEqual([]);
      expect(stub.writes).toEqual([]);
      expect(button("Play")).toBeDefined();
    });

    it("paused at the last frame: K down, L, K up stays paused there, no restart from 0", async () => {
      await mount(versionOf({ frameCount: 75 })); await load(75 / 25);
      await key("End");
      await act(async () => { stub.finishSeek(video()); stub.presentFrame(video(), 74 / 25); });
      stub.writes.length = 0; stub.calls.length = 0;
      await key("k"); await key("l"); await keyup("k");
      expect(video().paused).toBe(true);
      expect(stub.calls.filter((c) => c === "play")).toEqual([]);
      expect(stub.writes).toEqual([]);
    });

    it("paused mid-file: K down, L, L, K up lands two frames later, still paused", async () => {
      await mount(); await load();
      await key("k"); await key("l");
      await act(async () => { stub.finishSeek(video()); stub.presentFrame(video(), 1 / 25); });
      await key("l");
      await act(async () => { stub.finishSeek(video()); stub.presentFrame(video(), 2 / 25); });
      await keyup("k");
      expect(stub.writes.at(-1)).toBe(frameSeekSeconds(2, FPS_25));
      expect(video().paused).toBe(true);
      expect(stub.calls.filter((c) => c === "play")).toEqual([]);
    });

    it("a standalone K press from paused plays on keyup, not on keydown", async () => {
      await mount(); await load();
      await key("k");
      expect(video().paused).toBe(true);
      await keyup("k");
      expect(video().paused).toBe(false);
    });

    it("K down while playing pauses at once, and its keyup does not resume", async () => {
      await mount(); await load();
      await key(" "); expect(video().paused).toBe(false);
      await key("k"); expect(video().paused).toBe(true);
      await keyup("k"); expect(video().paused).toBe(true);
    });

    it("window blur while K is held releases it without toggling", async () => {
      await mount(); await load();
      await key("k");
      await act(async () => { window.dispatchEvent(new Event("blur")); });
      await keyup("k");
      expect(video().paused).toBe(true);
    });
  });

  it("releasing K restores the normal J / L shuttle", async () => {
    await mount(); await load();
    await key("k"); await key("k", { repeat: true });
    await keyup("k");
    stub.writes.length = 0;
    await key("l");
    expect(stub.writes).toEqual([]);
    expect(video().paused).toBe(false);
    expect(video().playbackRate).toBe(2);
  });

  it("losing focus (window blur) releases K", async () => {
    await mount(); await load();
    await key("k");
    await act(async () => { window.dispatchEvent(new Event("blur")); });
    stub.writes.length = 0;
    await key("l");
    expect(stub.writes).toEqual([]);
    expect(video().paused).toBe(false);
    expect(video().playbackRate).toBe(1);
  });
});

describe("VideoPlayer notes seams (#741 5b)", () => {
  it("I and O mark the frame on screen when the host takes marks, and do nothing without onMark", async () => {
    const onMark = vi.fn();
    await mount(versionOf(), { onMark });
    await load();
    await present(12);
    await key("i");
    expect(onMark).toHaveBeenLastCalledWith("in", 12);
    await key("o");
    expect(onMark).toHaveBeenLastCalledWith("out", 12);
    onMark.mockClear();
    await key("i", { repeat: true });
    expect(onMark).not.toHaveBeenCalled();
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    await mount(versionOf());
    await load();
    await key("i");
    expect(byTestId("video-player")).not.toBeNull();
  });

  it("while a seek is in flight a mark takes the frame on its way, not the old one", async () => {
    const onMark = vi.fn();
    await mount(versionOf(), { onMark });
    await load();
    await key("ArrowRight");
    await key("ArrowRight");
    await key("o");
    expect(onMark).toHaveBeenCalledWith("out", 2);
  });

  it("the key legend gains in / out only with onMark", async () => {
    await mount(versionOf());
    expect(byTestId("video-key-legend")!.textContent).not.toContain("in/out");
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    await mount(versionOf(), { onMark: () => {} });
    expect(byTestId("video-key-legend")!.textContent).toContain("in/out");
  });

  it("draws markers under the track and the pending band before the slider so the thumb paints over it; a marker click reports its id", async () => {
    const onMarkerSelect = vi.fn();
    await mount(versionOf(), {
      markers: [{ id: "n1", startFrame: 100, endFrame: null, tone: "internal", selected: false }],
      pendingRange: { startFrame: 10, endFrame: 20 },
      onMarkerSelect,
    });
    const scrubber = byTestId("video-scrubber")!;
    const band = scrubber.querySelector("[data-testid=video-pending-band]")!;
    const slider = scrubber.querySelector("input[type=range]")!;
    const lane = scrubber.querySelector<HTMLElement>("[data-testid=video-marker-lane]")!;
    expect(band.compareDocumentPosition(slider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(slider.compareDocumentPosition(lane) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    lane.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 12, right: 1000, bottom: 12, x: 0, y: 0, toJSON: () => ({}) });
    await act(async () => { lane.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 6 + (988 * 100) / 2999 })); });
    expect(onMarkerSelect).toHaveBeenCalledWith("n1");
  });

  it("finding 10: the pending band is laid out against the slider track alone, never the marker lane (it would sit 6px below the track)", async () => {
    await mount(versionOf(), {
      markers: [{ id: "n1", startFrame: 100, endFrame: null, tone: "internal", selected: false }],
      pendingRange: { startFrame: 10, endFrame: 20 },
    });
    const band = byTestId("video-pending-band")!;
    const slider = byTestId("video-scrubber")!.querySelector("input[type=range]")!;
    const lane = byTestId("video-marker-lane")!;
    const wrapper = band.parentElement!;
    expect(wrapper.contains(slider)).toBe(true);
    expect(wrapper.contains(lane)).toBe(false);
    expect(wrapper).not.toBe(byTestId("video-scrubber"));
  });

  it("hands the clock up once the element is ready, and null when the player goes away", async () => {
    const onClockChange = vi.fn();
    await mount(versionOf(), { onClockChange });
    const clocks = onClockChange.mock.calls.map(([clock]) => clock);
    expect(clocks.some((clock) => clock !== null && typeof clock.awaitConfirmedFrame === "function")).toBe(true);
    await act(async () => { root!.unmount(); }); root = null;
    expect(onClockChange.mock.calls.at(-1)![0]).toBeNull();
  });
});
