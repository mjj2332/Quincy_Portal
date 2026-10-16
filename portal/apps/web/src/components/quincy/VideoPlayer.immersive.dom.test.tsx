import { act, createRef } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import "../../testing/dom-polyfills";
import { mockViewport, type MockViewport } from "../../testing/viewport";
import { VideoPlayer, type VideoImmersiveHost, type VideoPlayerControl, type VideoPlayerVersion } from "./VideoPlayer";
import type { TimelineMarker } from "./VideoTimelineMarkers";
import { PROMPT_MS } from "../../lib/immersive";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const version: VideoPlayerVersion = {
  streamUrl: "/media/video/77777777-7777-4777-8777-777777777777", fps: { num: 25, den: 1 }, frameCount: 3000, width: 1920, height: 1080,
  tcNominalFps: 25, tcDropFrame: false, startTimecodeFrames: null, hasAudio: true,
};
const markers: TimelineMarker[] = [{ id: "n1", startFrame: 1500, endFrame: null, tone: "public", selected: false }];

let stub: VideoElementStub;
let root: Root | null = null;
let host: HTMLElement;
let viewport: MockViewport | null = null;
const video = () => host.querySelector("video")!;
const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === name) ?? null;
const hostOf = (over: Partial<VideoImmersiveHost> = {}): VideoImmersiveHost => ({ on: true, onToggle: vi.fn(), heading: "Main walkthrough · v2", ...over });
type Props = Partial<React.ComponentProps<typeof VideoPlayer>>;

async function mount(props: Props = {}) {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<VideoPlayer version={version} title="Main walkthrough" {...props} />); });
  await act(async () => { stub.loadMetadata(video(), { duration: 3000 / 25, videoWidth: 1920, videoHeight: 1080 }); });
  await act(async () => { stub.finishSeek(video()); stub.presentFrame(video(), 0); });
  stub.writes.length = 0; stub.calls.length = 0;
}
const rerender = (props: Props) => act(async () => { root!.render(<VideoPlayer version={version} title="Main walkthrough" {...props} />); });
const chrome = () => byTestId("video-player")!.dataset.chrome;
const play = () => act(async () => { button("Play")!.click(); });
const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });
const tapStage = () => act(async () => { byTestId("video-stage")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

beforeEach(() => { stub = installVideoElementStub(); });
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; stub.dispose(); viewport?.restore(); viewport = null; vi.useRealTimers(); vi.unstubAllGlobals();
  delete (document as unknown as Record<string, unknown>).fullscreenEnabled; delete (HTMLElement.prototype as unknown as Record<string, unknown>).requestFullscreen;
  document.body.replaceChildren();
});

describe("VideoPlayer Full screen button (#880)", () => {
  it("shows with a host that offers Full screen even where the browser has no element full screen (iPhone), and presses through to the host", async () => {
    const onToggle = vi.fn(); const request = vi.fn(() => Promise.resolve());
    (HTMLElement.prototype as unknown as { requestFullscreen: () => Promise<void> }).requestFullscreen = request;
    expect(document.fullscreenEnabled).not.toBe(true);
    await mount({ immersive: hostOf({ on: false, onToggle }) });
    await act(async () => { button("Full screen")!.click(); });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });

  it("is absent without a host and without browser support, exactly as before (Compare, any other host)", async () => {
    await mount();
    expect(button("Full screen")).toBeNull();
  });

  it("in full screen it is replaced by a top-bar Exit full screen with the title; the dock drops it", async () => {
    const onToggle = vi.fn();
    await mount({ immersive: hostOf({ onToggle }) });
    expect(byTestId("video-player")!.hasAttribute("data-immersive")).toBe(true);
    expect(button("Full screen")).toBeNull();
    expect(byTestId("video-immersive-bar")!.textContent).toContain("Main walkthrough · v2");
    await act(async () => { button("Exit full screen")!.click(); });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("is not in full screen unless the host says so: no data-immersive, no top bar, no auto-hide", async () => {
    await mount({ immersive: hostOf({ on: false }) });
    expect(byTestId("video-player")!.hasAttribute("data-immersive")).toBe(false);
    expect(byTestId("video-immersive-bar")).toBeNull();
    expect(chrome()).toBeUndefined();
  });
});

describe("VideoPlayer controls auto-hide (#880, D13)", () => {
  it("hides 3000ms after playback starts and shows again on a key", async () => {
    await mount({ immersive: hostOf() });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    expect(chrome()).toBe("shown");
    await play();
    await advance(2900);
    expect(chrome()).toBe("shown");
    await advance(200);
    expect(chrome()).toBe("hidden");
    expect(byTestId("video-immersive-dock")!.hasAttribute("inert")).toBe(true);
    expect(byTestId("video-immersive-dock")!.className).toContain("opacity-0");
    const control = createRef<VideoPlayerControl>();
    await rerender({ immersive: hostOf(), controlRef: control });
    await act(async () => { control.current!.handleKeyDown(new KeyboardEvent("keydown", { key: "ArrowRight" })); });
    expect(chrome()).toBe("shown");
    expect(byTestId("video-immersive-dock")!.hasAttribute("inert")).toBe(false);
  });

  it("stays up while paused", async () => {
    await mount({ immersive: hostOf() });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await advance(10_000);
    expect(chrome()).toBe("shown");
  });

  it("stays up while Add note is open, a card is showing or the pen is down, however long it plays", async () => {
    await mount({ immersive: hostOf({ addNote: { pressed: true, onToggle: () => undefined } }) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await play();
    await advance(10_000);
    expect(chrome()).toBe("shown");
    await rerender({ immersive: hostOf({ card: <div>A note</div> }) });
    await advance(10_000);
    expect(chrome()).toBe("shown");
    await rerender({ immersive: hostOf(), transportLocked: true, transportReplacement: <div>Pen tools</div> });
    await advance(10_000);
    expect(chrome()).toBe("shown");
  });

  it("stays up while the keyboard has focus inside it", async () => {
    await mount({ immersive: hostOf() });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await play();
    const mute = button("Mute")!;
    // Keyboard focus: a key, then the focus it moves.
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); mute.focus(); });
    await advance(10_000);
    expect(chrome()).toBe("shown");
    await act(async () => { mute.blur(); });
    await advance(3100);
    expect(chrome()).toBe("hidden");
  });

  // Fix round 1, item 1: WebKit marks a scripted focus() :focus-visible unless the last focus came from a click, and an iOS tap never focuses a button. So the Exit focus
  // placed at entry, and the thumb focus Base UI places on a scrubber press, both matched :focus-visible and held the controls up for good.
  const pointerDown = (target: EventTarget) => { target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true })); };
  const pointerUp = (target: EventTarget) => { target.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true })); };

  it("hides 3000ms after play with nothing else happening, the entry focus on Exit and a tap on the centre Play included", async () => {
    viewport = mockViewport({ width: 390, height: 844, coarse: true });
    await mount({ immersive: hostOf() });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // The tap on ⤢, then the focus use-immersive places on Exit at entry.
    await act(async () => { pointerDown(document.body); pointerUp(document.body); button("Exit full screen")!.focus(); });
    const badge = byTestId("video-play-badge")!;
    await act(async () => { pointerDown(badge); pointerUp(badge); badge.click(); });
    expect(stub.calls).toContain("play");
    await advance(2900);
    expect(chrome()).toBe("shown");
    await advance(100);
    expect(chrome()).toBe("hidden");
  });

  it("focus a tap puts on a control does not hold the controls, and a key after it does", async () => {
    await mount({ immersive: hostOf() });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await play();
    const mute = button("Mute")!;
    await act(async () => { pointerDown(mute); mute.focus(); pointerUp(mute); });
    await advance(3000);
    expect(chrome()).toBe("hidden");
    await tapStage();
    expect(chrome()).toBe("shown");
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); button("Exit full screen")!.focus(); });
    await advance(10_000);
    expect(chrome()).toBe("shown");
  });

  it("a scrubber press whose pointerup lands in the same task releases the scrub hold", async () => {
    await mount({ immersive: hostOf() });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await play();
    const thumb = host.querySelector<HTMLInputElement>('[data-testid="video-scrubber"] input[type="range"]')!;
    // Base UI focuses the thumb from script on the press, as WebKit does.
    await act(async () => { pointerDown(thumb); thumb.focus(); pointerUp(thumb); });
    await advance(3000);
    expect(chrome()).toBe("hidden");
  });

  it("a scrub holds the controls until the pointer lifts", async () => {
    await mount({ immersive: hostOf() });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await play();
    const thumb = host.querySelector<HTMLInputElement>('[data-testid="video-scrubber"] input[type="range"]')!;
    await act(async () => { pointerDown(thumb); });
    await advance(10_000);
    expect(chrome()).toBe("shown");
    await act(async () => { pointerUp(window); });
    await advance(3000);
    expect(chrome()).toBe("hidden");
  });

  // Fix round 2: the staff viewer hosts the player in a modal dialog (role="dialog"). A popup hold that looked up past the player found that host, so every focus in the
  // player (the Exit focus at entry among them) held the controls for good.
  it("inside a dialog host, the entry focus on Exit does not hold the controls: they hide 3000ms after play", async () => {
    viewport = mockViewport({ width: 390, height: 844, coarse: true });
    const dialogHost = document.createElement("div"); dialogHost.setAttribute("role", "dialog"); document.body.appendChild(dialogHost);
    host = document.createElement("div"); dialogHost.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(<VideoPlayer version={version} title="Main walkthrough" immersive={hostOf()} />); });
    await act(async () => { stub.loadMetadata(video(), { duration: 3000 / 25, videoWidth: 1920, videoHeight: 1080 }); });
    await act(async () => { stub.finishSeek(video()); stub.presentFrame(video(), 0); });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => { button("Exit full screen")!.focus(); });
    const badge = byTestId("video-play-badge")!;
    await act(async () => { pointerDown(badge); pointerUp(badge); badge.click(); });
    await advance(2900);
    expect(chrome()).toBe("shown");
    await advance(100);
    expect(chrome()).toBe("hidden");
  });

  it("a menu of the player's own still holds the controls, in place or portalled out of the player, inside a dialog host or not", async () => {
    for (const portalled of [false, true]) {
      const dialogHost = document.createElement("div"); dialogHost.setAttribute("role", "dialog"); document.body.appendChild(dialogHost);
      host = document.createElement("div"); dialogHost.appendChild(host); root = createRoot(host);
      const menu = <div role="menu" data-testid="the-menu"><button type="button" role="menuitem" data-testid="the-item">Copy</button></div>;
      await act(async () => { root!.render(<VideoPlayer version={version} title="Main walkthrough" immersive={hostOf({ card: portalled ? createPortal(menu, document.body) : menu })} />); });
      await act(async () => { stub.loadMetadata(video(), { duration: 3000 / 25, videoWidth: 1920, videoHeight: 1080 }); });
      await act(async () => { stub.finishSeek(video()); stub.presentFrame(video(), 0); });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await play();
      await act(async () => { const item = document.querySelector<HTMLElement>('[data-testid="the-item"]')!; pointerDown(item); item.focus(); });
      await advance(10_000);
      expect(chrome(), portalled ? "portalled" : "in place").toBe("shown");
      vi.useRealTimers();
      await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    }
  });

  it("a tap on the film toggles the controls, even while paused, and does not play or pause", async () => {
    await mount({ immersive: hostOf() });
    expect(chrome()).toBe("shown");
    await tapStage();
    expect(chrome()).toBe("hidden");
    await tapStage();
    expect(chrome()).toBe("shown");
    expect(stub.calls).not.toContain("play");
    expect(stub.calls).not.toContain("pause");
  });

  it("a tap on the controls themselves is not a tap on the film", async () => {
    await mount({ immersive: hostOf() });
    await act(async () => { byTestId("video-immersive-dock")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(chrome()).toBe("shown");
  });

  it("a tap while the pen is down or Add note is open leaves the controls alone", async () => {
    await mount({ immersive: hostOf({ addNote: { pressed: true, onToggle: () => undefined } }) });
    await tapStage();
    expect(chrome()).toBe("shown");
  });

  it("a card opening shows hidden controls", async () => {
    await mount({ immersive: hostOf() });
    await tapStage();
    expect(chrome()).toBe("hidden");
    await rerender({ immersive: hostOf({ card: <div>A note</div> }) });
    expect(chrome()).toBe("shown");
  });

  it("the centre Play is P1's play badge (F1), a phone's only: it shows while paused, plays without toggling the controls, and goes while playing", async () => {
    viewport = mockViewport({ width: 390, height: 844, coarse: true });
    await mount({ immersive: hostOf() });
    expect(byTestId("video-immersive-play")).toBeNull();
    const centre = byTestId("video-play-badge")!;
    expect(centre).not.toBeNull();
    await act(async () => { centre.click(); });
    expect(stub.calls).toContain("play");
    expect(byTestId("video-player")!.dataset.chrome).toBe("shown");
    expect(byTestId("video-play-badge")).toBeNull();
  });

  it("a desktop's Full screen has no centre Play: Play stays in the controls row (owner decision, #880 review 10)", async () => {
    viewport = mockViewport({ width: 1400, height: 900, coarse: false });
    await mount({ immersive: hostOf() });
    expect(byTestId("video-play-badge")).toBeNull();
    expect(button("Play")).not.toBeNull();
  });
});

describe("VideoPlayer full screen controls (#880, D13)", () => {
  it("keeps the Add note button, with its state, and the host's card in the controls", async () => {
    const onToggle = vi.fn();
    await mount({ immersive: hostOf({ addNote: { pressed: false, onToggle }, card: <div data-testid="the-card">A note</div> }) });
    const add = button("Add note")!;
    expect(add.getAttribute("aria-pressed")).toBe("false");
    await act(async () => { add.click(); });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(byTestId("video-immersive-bar")!.parentElement!.contains(byTestId("the-card"))).toBe(true);
  });

  it("the card is at most F3's 420px, through the named token (--note-card-width in tokens/spacing.css), never a raw width", async () => {
    await mount({ immersive: hostOf({ card: <div data-testid="the-card">A note</div> }) });
    const box = byTestId("the-card")!.parentElement!;
    expect(box.className).toContain("max-w-[var(--note-card-width)]");
    expect(box.className).not.toMatch(/max-w-\[\d/);
  });

  it("a marker press goes to the host's marker tap, with the lane in touch mode on a phone; outside full screen it is the ordinary select", async () => {
    viewport = mockViewport({ width: 390, height: 844, coarse: true });
    const onMarkerTap = vi.fn(); const onMarkerSelect = vi.fn();
    await mount({ markers, onMarkerSelect, immersive: hostOf({ onMarkerTap }) });
    const lane = byTestId("video-marker-lane")!;
    expect(lane.dataset.touch).toBe("true");
    lane.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 12, right: 1000, bottom: 12, x: 0, y: 0, toJSON: () => ({}) });
    await act(async () => { lane.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 6 + (988 * 1500) / 2999 })); });
    expect(onMarkerTap).toHaveBeenCalledWith("n1");
    expect(onMarkerSelect).not.toHaveBeenCalled();
    await rerender({ markers, onMarkerSelect, immersive: hostOf({ on: false, onMarkerTap }) });
    const plain = byTestId("video-marker-lane")!;
    expect(plain.dataset.touch).toBeUndefined();
    plain.getBoundingClientRect = lane.getBoundingClientRect;
    await act(async () => { plain.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 6 + (988 * 1500) / 2999 })); });
    expect(onMarkerSelect).toHaveBeenCalledWith("n1");
    expect(onMarkerTap).toHaveBeenCalledTimes(1);
  });

  it("a phone leaves frame step, the time format and the key legend out of full screen; a desktop keeps them", async () => {
    viewport = mockViewport({ width: 844, height: 390, coarse: true });
    await mount({ immersive: hostOf() });
    for (const name of ["Previous frame", "Next frame"]) expect(button(name), name).toBeNull();
    expect(byTestId("video-key-legend")).toBeNull();
    expect(host.querySelector('[aria-label="Time format"], [data-testid="video-time-format"]')).toBeNull();
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren(); viewport.restore();
    viewport = mockViewport({ width: 1400, height: 900, coarse: false });
    await mount({ immersive: hostOf() });
    for (const name of ["Previous frame", "Next frame"]) expect(button(name), name).not.toBeNull();
    expect(byTestId("video-key-legend")).not.toBeNull();
  });

  it("a sideways phone's dock clears the home bar: its bottom padding is at least --space-5, or the safe area; portrait keeps --space-2 (landscape fix 1)", async () => {
    const PORTRAIT_PB = "pb-[max(var(--space-2),env(safe-area-inset-bottom))]";
    const SIDEWAYS_PB = "pb-[max(var(--space-5),env(safe-area-inset-bottom))]";
    viewport = mockViewport({ width: 844, height: 390, coarse: true });
    await mount({ immersive: hostOf() });
    let classes = byTestId("video-immersive-dock")!.className.split(/\s+/);
    expect(classes).toContain(SIDEWAYS_PB);
    expect(classes).not.toContain(PORTRAIT_PB);
    // The sides stay the safe area's, with --space-3 at least.
    expect(classes).toContain("pl-[max(var(--space-3),env(safe-area-inset-left))]");
    expect(classes).toContain("pr-[max(var(--space-3),env(safe-area-inset-right))]");
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren(); viewport.restore();
    for (const size of [{ width: 390, height: 844, coarse: true }, { width: 1400, height: 900, coarse: false }]) {
      viewport = mockViewport(size);
      await mount({ immersive: hostOf() });
      classes = byTestId("video-immersive-dock")!.className.split(/\s+/);
      expect(classes, `${size.width}`).toContain(PORTRAIT_PB);
      expect(classes, `${size.width}`).not.toContain(SIDEWAYS_PB);
      await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren(); viewport.restore();
    }
    viewport = null;
  });

  it("a hidden control is not reachable: hidden controls are inert", async () => {
    await mount({ immersive: hostOf() });
    await tapStage();
    for (const id of ["video-immersive-bar", "video-immersive-dock"]) expect(byTestId(id)!.hasAttribute("inert"), id).toBe(true);
  });
});

describe("VideoPlayer Full screen dock (#880 S2)", () => {
  const slider = () => host.querySelector<HTMLElement>('[data-testid="video-scrubber"] [role="slider"]');
  it("is one wrapper around the replacement and the transport: the pen down neither swaps the dock nor remounts the slider", async () => {
    await mount({ immersive: hostOf() });
    const dock = byTestId("video-immersive-dock")!; const thumb = slider()!;
    await rerender({ immersive: hostOf(), transportReplacement: <div data-testid="pen-tools">Pen</div> });
    expect(byTestId("video-immersive-dock")).toBe(dock);
    expect(dock.contains(byTestId("pen-tools"))).toBe(true);
    expect(slider()).toBe(thumb);
    await rerender({ immersive: hostOf() });
    expect(byTestId("video-immersive-dock")).toBe(dock);
    expect(slider()).toBe(thumb);
  });
  it("publishes --immersive-controls-h from the wrapper, with the replacement inside it", async () => {
    const split = document.createElement("div"); split.setAttribute("data-testid", "video-review-split"); document.body.appendChild(split);
    host = document.createElement("div"); split.appendChild(host); root = createRoot(host);
    const heights = new WeakMap<Element, number>();
    const spy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return heights.get(this) ?? 0; });
    await act(async () => { root!.render(<VideoPlayer version={version} title="Main walkthrough" immersive={hostOf()} transportReplacement={<div>Pen</div>} />); });
    heights.set(byTestId("video-immersive-dock")!, 132);
    await act(async () => { root!.render(<VideoPlayer version={version} title="Main walkthrough" immersive={hostOf()} />); });
    expect(split.style.getPropertyValue("--immersive-controls-h")).toBe("132px");
    spy.mockRestore();
  });
  it("publishes the controls' height without the scrim's top padding, so the composer sits a space above the scrubber (fix round 1, item 3)", async () => {
    const split = document.createElement("div"); split.setAttribute("data-testid", "video-review-split"); document.body.appendChild(split);
    host = document.createElement("div"); split.appendChild(host); root = createRoot(host);
    const heights = new WeakMap<Element, number>();
    const spy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return heights.get(this) ?? 0; });
    await act(async () => { root!.render(<VideoPlayer version={version} title="Main walkthrough" immersive={hostOf()} transportReplacement={<div>Pen</div>} />); });
    const dock = byTestId("video-immersive-dock")!;
    heights.set(dock, 132); dock.style.paddingTop = "40px";
    await act(async () => { root!.render(<VideoPlayer version={version} title="Main walkthrough" immersive={hostOf()} />); });
    expect(split.style.getPropertyValue("--immersive-controls-h")).toBe("92px");
    spy.mockRestore();
  });

  it("while Add note is open the dock's scrim reaches up behind the composer (its published height) (fix round 1, item 3)", async () => {
    await mount({ immersive: hostOf() });
    const dock = byTestId("video-immersive-dock")!;
    expect(dock.className).toContain("pt-[var(--space-6)]");
    await rerender({ immersive: hostOf({ addNote: { pressed: true, onToggle: () => undefined } }) });
    expect(dock.className).toContain("pt-[calc(var(--space-6)+var(--immersive-composer-h,0px)+var(--space-2))]");
    expect(dock.className).not.toContain("pt-[var(--space-6)]");
  });

  it("F1 and F2 draw no frame chip on the film: Full screen leaves it out, watching or composing; outside Full screen it is the stage's as before (landscape fix 1)", async () => {
    // A laid-out film, so the stage has a picture box to draw the chip in.
    const spies = (["offsetWidth", "offsetHeight"] as const).map((prop) => vi.spyOn(HTMLElement.prototype, prop, "get").mockReturnValue(800));
    await mount({ immersive: hostOf({ on: false }) });
    expect(byTestId("video-timecode-chip")).not.toBeNull();
    await rerender({ immersive: hostOf() });
    expect(byTestId("video-timecode-chip")).toBeNull();
    await rerender({ immersive: hostOf({ addNote: { pressed: true, onToggle: () => undefined } }) });
    expect(byTestId("video-timecode-chip")).toBeNull();
    await rerender({ immersive: hostOf({ on: false }) });
    expect(byTestId("video-timecode-chip")).not.toBeNull();
    for (const spy of spies) spy.mockRestore();
  });

  it("outside Full screen the wrapper lays out as nothing (display: contents) and has no dock id", async () => {
    await mount({ immersive: hostOf({ on: false }) });
    expect(byTestId("video-immersive-dock")).toBeNull();
    expect(byTestId("video-transport-dock")!.className).toContain("contents");
  });
});

describe("VideoPlayer Full screen marker band (#880 S3)", () => {
  it("on a phone the lane's touch band grows up into the scrim, inside the band and clear of the track's centre; the slider still seeks", async () => {
    viewport = mockViewport({ width: 390, height: 844, coarse: true });
    await mount({ immersive: hostOf({ onMarkerTap: vi.fn() }), markers });
    const lane = byTestId("video-marker-lane")!;
    expect(lane.dataset.touch).toBe("true");
    expect(lane.className).toContain("before:bottom-0");
    expect(lane.className).not.toContain("mb-[var(--space-6)]");
    // The lane is the band's top 12px (`top-0`, `h-3`); the track runs through the band's middle, so a press there is the slider's.
    expect(lane.className).toContain("top-0");
    const thumb = host.querySelector<HTMLInputElement>('[data-testid="video-scrubber"] input[type="range"]')!;
    expect(lane.contains(thumb)).toBe(false);
    await act(async () => { thumb.focus(); thumb.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })); });
    expect(stub.writes.length).toBeGreaterThan(0);
  });
  it("a desktop keeps the click lane: no touch band, no reserved room, and a press still goes to the host's marker tap", async () => {
    viewport = mockViewport({ width: 1200, height: 800 });
    const onMarkerTap = vi.fn();
    await mount({ immersive: hostOf({ onMarkerTap }), markers });
    const lane = byTestId("video-marker-lane")!;
    expect(lane.dataset.touch).toBeUndefined();
    expect(lane.className).not.toContain("before:h-11");
    expect(lane.className).not.toContain("mb-[var(--space-6)]");
    lane.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 12, right: 1000, bottom: 12, x: 0, y: 0, toJSON: () => ({}) });
    await act(async () => { lane.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 6 + (988 * 1500) / 2999 })); });
    expect(onMarkerTap).toHaveBeenCalledWith("n1");
  });
});

describe("VideoPlayer Full screen prompt (#880, owner decision 2026-10-16)", () => {
  it("shows the host's prompt as a status notice for PROMPT_MS, again for each new press, and never outside Full screen", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await mount({ immersive: hostOf({ prompt: { key: 1, text: "Turn your phone upright to add a note." } }) });
    const prompt = () => byTestId("video-immersive-prompt");
    expect(prompt()!.textContent).toBe("Turn your phone upright to add a note.");
    expect(prompt()!.getAttribute("role")).toBe("status");
    expect(prompt()!.className).toContain("[font:var(--weight-regular)_var(--text-sm)");
    await advance(PROMPT_MS);
    expect(prompt()).toBeNull();
    await rerender({ immersive: hostOf({ prompt: { key: 2, text: "Turn your phone upright to add a note." } }) });
    expect(prompt()).not.toBeNull();
    await rerender({ immersive: hostOf({ on: false, prompt: { key: 2, text: "Turn your phone upright to add a note." } }) });
    expect(prompt()).toBeNull();
  });
});

describe("VideoPlayer Add note (#880 review 5)", () => {
  it("is the installed reui Toggle, as Mute is: pressed from the host, and a press calls the host's toggle", async () => {
    const onToggle = vi.fn();
    await mount({ immersive: hostOf({ addNote: { pressed: false, onToggle } }) });
    const add = () => byTestId("video-immersive-add-note")!;
    expect(add().className.split(/\s+/)).toContain("group/toggle");
    expect(add().getAttribute("aria-label")).toBe("Add note");
    expect(add().getAttribute("aria-pressed")).toBe("false");
    await act(async () => { add().click(); });
    expect(onToggle).toHaveBeenCalledTimes(1);
    await rerender({ immersive: hostOf({ addNote: { pressed: true, onToggle } }) });
    expect(add().getAttribute("aria-pressed")).toBe("true");
  });
});

describe("VideoPlayer F key (#880)", () => {
  it("F toggles Full screen through the player's keys, and is not the player's without a host", async () => {
    const onToggle = vi.fn(); const control = createRef<VideoPlayerControl>();
    await mount({ controlRef: control, keyboard: "host", immersive: hostOf({ on: false, onToggle }) });
    const press = (key: string) => act(async () => { control.current!.handleKeyDown(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
    await press("f");
    expect(onToggle).toHaveBeenCalledTimes(1);
    await press("m");
    expect(onToggle).toHaveBeenCalledTimes(1);
    await rerender({ controlRef: control, keyboard: "host" });
    await press("f");
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("lists F in the key legend on a desktop only", async () => {
    viewport = mockViewport({ width: 1400, height: 900, coarse: false });
    await mount({ immersive: hostOf({ on: false }) });
    expect(byTestId("video-key-legend")!.textContent).toContain("full screen");
    await rerender({});
    expect(byTestId("video-key-legend")!.textContent).not.toContain("full screen");
  });
});

describe("VideoPlayer native player (#880, D15)", () => {
  it("prefers webkitEnterFullscreen on the video element, inside the press", async () => {
    const control = createRef<VideoPlayerControl>();
    await mount({ controlRef: control, immersive: hostOf({ on: false }) });
    const webkit = vi.fn(); const standard = vi.fn(() => Promise.resolve());
    Object.assign(video(), { webkitEnterFullscreen: webkit, requestFullscreen: standard });
    expect(control.current!.nativePlayerSupported!()).toBe(true);
    await act(async () => { control.current!.openSystemPlayer!(); });
    expect(webkit).toHaveBeenCalledTimes(1);
    expect(standard).not.toHaveBeenCalled();
  });

  // iOS, measured in the Simulator (#880 finding A): before the film has data (readyState 0 or 1: iOS loads at most the metadata before a play), webkitEnterFullscreen neither
  // throws nor shows anything. It fires webkitbeginfullscreen and reports itself displaying, and no player ever appears. A play() inside the same press, first, makes it present.
  it("a film with no data yet is played inside the press, before the native player is entered", async () => {
    const control = createRef<VideoPlayerControl>();
    await mount({ controlRef: control });
    stub.setReadyState(video(), 1);
    stub.calls.length = 0;
    Object.assign(video(), { webkitEnterFullscreen: vi.fn(() => { stub.calls.push("enter"); }) });
    await act(async () => { control.current!.openSystemPlayer!(); });
    expect(stub.calls).toEqual(["play", "enter"]);
  });
  it("a film that has data is entered without playing it", async () => {
    const control = createRef<VideoPlayerControl>();
    await mount({ controlRef: control });
    stub.setReadyState(video(), 4);
    stub.calls.length = 0;
    Object.assign(video(), { webkitEnterFullscreen: vi.fn(() => { stub.calls.push("enter"); }) });
    await act(async () => { control.current!.openSystemPlayer!(); });
    expect(stub.calls).toEqual(["enter"]);
  });
  it("back from the system player, a film that was paused before the hand-off is paused again", async () => {
    const control = createRef<VideoPlayerControl>();
    await mount({ controlRef: control });
    stub.setReadyState(video(), 1);
    Object.assign(video(), { webkitEnterFullscreen: vi.fn() });
    await act(async () => { control.current!.openSystemPlayer!(); });
    expect(video().paused).toBe(false);
    stub.calls.length = 0;
    await act(async () => { video().dispatchEvent(new Event("webkitendfullscreen")); });
    expect(stub.calls).toContain("pause");
    expect(video().paused).toBe(true);
  });
  it("a film that was playing before the hand-off is left to the system player's own state on return", async () => {
    const control = createRef<VideoPlayerControl>();
    await mount({ controlRef: control });
    await act(async () => { byTestId("video-player")!.querySelector<HTMLButtonElement>('button[aria-label="Play"]')!.click(); });
    expect(video().paused).toBe(false);
    stub.setReadyState(video(), 4);
    Object.assign(video(), { webkitEnterFullscreen: vi.fn() });
    await act(async () => { control.current!.openSystemPlayer!(); });
    stub.calls.length = 0;
    await act(async () => { video().dispatchEvent(new Event("webkitendfullscreen")); });
    expect(stub.calls).not.toContain("pause");
  });
  it("says so in a visible notice when the device refuses", async () => {
    const control = createRef<VideoPlayerControl>();
    await mount({ controlRef: control });
    Object.assign(video(), { webkitEnterFullscreen: () => { throw new Error("no metadata"); } });
    await act(async () => { control.current!.openSystemPlayer!(); });
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("system player");
  });
  it("the refusal notice clears after PROMPT_MS, as the upright prompt does, so it never holds the transport down for good (#880 review 3)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const control = createRef<VideoPlayerControl>();
    await mount({ controlRef: control });
    Object.assign(video(), { webkitEnterFullscreen: () => { throw new Error("no metadata"); } });
    await act(async () => { control.current!.openSystemPlayer!(); });
    expect(byTestId("video-native-failed")).not.toBeNull();
    await advance(PROMPT_MS - 1);
    expect(byTestId("video-native-failed")).not.toBeNull();
    await advance(1);
    expect(byTestId("video-native-failed")).toBeNull();
  });
  it("the refusal notice clears on leaving Full screen (#880 review 3)", async () => {
    const control = createRef<VideoPlayerControl>();
    await mount({ controlRef: control, immersive: hostOf() });
    Object.assign(video(), { webkitEnterFullscreen: () => { throw new Error("no metadata"); } });
    await act(async () => { control.current!.openSystemPlayer!(); });
    expect(byTestId("video-native-failed")).not.toBeNull();
    await rerender({ controlRef: control, immersive: hostOf({ on: false }) });
    expect(byTestId("video-native-failed")).toBeNull();
  });
});

describe("VideoPlayer AirPlay through the system player (#880 S7, owner decision 3)", () => {
  const restricted = (element: HTMLVideoElement) => element.hasAttribute("disableremoteplayback") && element.getAttribute("controlslist") === "nodownload noremoteplayback";
  const lifted = (element: HTMLVideoElement) => !element.hasAttribute("disableremoteplayback") && element.getAttribute("controlslist") === "nodownload";
  let seen: { lifted: boolean; pip: boolean } | null = null;
  const enterSpy = () => vi.fn(function (this: HTMLVideoElement) { seen = { lifted: lifted(video()), pip: video().hasAttribute("disablepictureinpicture") }; });
  beforeEach(() => { seen = null; });

  it("is restricted at rest, and lifted (remote playback only: no download and no PiP stay) before the hand-off, inside the press", async () => {
    const control = createRef<VideoPlayerControl>();
    await mount({ controlRef: control });
    expect(restricted(video())).toBe(true);
    Object.assign(video(), { webkitEnterFullscreen: enterSpy() });
    await act(async () => { control.current!.openSystemPlayer!(); });
    expect(seen).toEqual({ lifted: true, pip: true });
    expect(lifted(video())).toBe(true);
  });
  it("is restored when the iPhone player closes (webkitendfullscreen)", async () => {
    const control = createRef<VideoPlayerControl>();
    await mount({ controlRef: control });
    Object.assign(video(), { webkitEnterFullscreen: enterSpy() });
    await act(async () => { control.current!.openSystemPlayer!(); });
    await act(async () => { video().dispatchEvent(new Event("webkitendfullscreen")); });
    expect(restricted(video())).toBe(true);
  });
  it("is restored when the element full screen ends (fullscreenchange away from the film), not when it starts", async () => {
    const control = createRef<VideoPlayerControl>();
    await mount({ controlRef: control });
    let element: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => element });
    try {
      Object.assign(video(), { requestFullscreen: () => { element = video(); document.dispatchEvent(new Event("fullscreenchange")); return Promise.resolve(); } });
      await act(async () => { control.current!.openSystemPlayer!(); });
      expect(lifted(video())).toBe(true);
      await act(async () => { element = null; document.dispatchEvent(new Event("fullscreenchange")); });
      expect(restricted(video())).toBe(true);
    } finally { delete (document as unknown as Record<string, unknown>).fullscreenElement; }
  });
  it("is restored when the device refuses", async () => {
    const control = createRef<VideoPlayerControl>();
    await mount({ controlRef: control });
    Object.assign(video(), { webkitEnterFullscreen: () => { throw new Error("no metadata"); } });
    await act(async () => { control.current!.openSystemPlayer!(); });
    expect(host.querySelector('[data-testid="video-native-failed"]')).not.toBeNull();
    expect(restricted(video())).toBe(true);
  });
  it("is restored when the player goes (unmount, or a Version change: the screens key the player by Version)", async () => {
    const control = createRef<VideoPlayerControl>();
    await mount({ controlRef: control });
    const film = video();
    Object.assign(film, { webkitEnterFullscreen: enterSpy() });
    await act(async () => { control.current!.openSystemPlayer!(); });
    expect(lifted(film)).toBe(true);
    await act(async () => { root!.render(<VideoPlayer key="v3" version={{ ...version, streamUrl: "/media/video/66666666-6666-4666-8666-666666666666" }} title="Main walkthrough" />); });
    expect(restricted(film)).toBe(true);
  });
});

