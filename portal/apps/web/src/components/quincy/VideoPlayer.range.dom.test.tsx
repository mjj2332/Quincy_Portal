import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { installLocalStorageShim } from "../../testing/local-storage";
import { resetUiPrefMemory } from "../../lib/ui-prefs";
import { TIME_FORMAT_KEY } from "../../lib/time-format-prefs";
import { VideoPlayer, type VideoPlayerVersion } from "./VideoPlayer";
import type { NoteMarks } from "../../lib/video-note-marks";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FPS_25 = { num: 25, den: 1 };
// 101 frames over a 112px scrubber with a 6px thumb half: one frame per px, frame f centred at x = 6 + f.
const versionOf = (over: Partial<VideoPlayerVersion> = {}): VideoPlayerVersion => ({
  streamUrl: "/media/video/77777777-7777-4777-8777-777777777777", fps: FPS_25, frameCount: 101, width: 1920, height: 1080,
  tcNominalFps: 25, tcDropFrame: false, startTimecodeFrames: null, hasAudio: true, ...over,
});
const NONE: NoteMarks = { in: null, out: null };

let stub: VideoElementStub;
let root: Root | null = null;
let host: HTMLElement;
let shim: ReturnType<typeof installLocalStorageShim>;
type Props = Partial<React.ComponentProps<typeof VideoPlayer>>;
let current: Props = {};
let currentVersion = versionOf();
const video = () => host.querySelector("video")!;
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const readout = () => byTestId("video-readout")!.textContent;
const rangeButton = () => byTestId("video-range-button");
const handle = (kind: "in" | "out") => byTestId(`video-range-${kind}`);
const flush = async (n = 3) => { for (let i = 0; i < n; i += 1) await act(async () => { await Promise.resolve(); }); };

const draw = () => { root!.render(<VideoPlayer version={currentVersion} title="Main walkthrough" {...current} />); };
async function mount(props: Props = {}, version = versionOf()) {
  current = props; currentVersion = version;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { draw(); });
  await act(async () => { stub.loadMetadata(video(), { duration: 4.04, videoWidth: 1920, videoHeight: 1080 }); });
  await act(async () => { stub.finishSeek(video()); stub.presentFrame(video(), 0); });
  stubTrack();
}
async function update(props: Props) { current = { ...current, ...props }; await act(async () => { draw(); }); stubTrack(); }
function stubTrack() {
  const track = byTestId("video-range-handles");
  if (track) track.getBoundingClientRect = () => ({ left: 0, top: 0, width: 112, height: 12, right: 112, bottom: 12, x: 0, y: 0, toJSON: () => ({}) });
}
const present = (frame: number) => act(async () => { stub.presentFrame(video(), frame / 25); });
async function key(k: string, init: KeyboardEventInit = {}, target: Element = byTestId("video-player")!) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })); });
}
type PointerInit = { clientX: number; button?: number; isPrimary?: boolean; pointerId?: number; pointerType?: string };
async function pointer(type: string, target: Element, { clientX, button = 0, isPrimary = true, pointerId = 1, pointerType = "mouse" }: PointerInit) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 4, button });
  Object.defineProperties(event, { pointerId: { value: pointerId }, isPrimary: { value: isPrimary }, pointerType: { value: pointerType } });
  await act(async () => { target.dispatchEvent(event); });
}
const centre = (frame: number) => 6 + frame;

const noopRange = (marks: NoteMarks, over: Partial<NonNullable<Props["range"]>> = {}): NonNullable<Props["range"]> => ({ marks, locked: false, clear: () => undefined, ...over });

beforeEach(() => { stub = installVideoElementStub(); shim = installLocalStorageShim(); resetUiPrefMemory(); });
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; stub.dispose(); shim.restore(); resetUiPrefMemory(); vi.unstubAllGlobals(); document.body.replaceChildren();
});

describe("VideoPlayer range: handles and keys, no button (#861, #927)", () => {
  it("without a range prop there is no handle", async () => {
    await mount({ onMark: vi.fn() });
    expect(handle("in")).toBeNull();
  });

  it("has no range button in any state: the composer owns in and out, the player keeps the handles and the I / O keys", async () => {
    await mount({ onMark: vi.fn(), range: noopRange(NONE) });
    expect(rangeButton()).toBeNull();
    await update({ range: noopRange({ in: 10, out: 20 }) });
    expect(rangeButton()).toBeNull();
    await update({ range: noopRange({ in: 10, out: 20 }, { locked: true, hint: "Add a note to mark a range" }) });
    expect(rangeButton()).toBeNull();
    expect(byTestId("video-range-tip")).toBeNull();
    expect(host.querySelector('[aria-label="Set in point"], [aria-label="Set out point"], [aria-label="Clear in and out"]')).toBeNull();
    expect(handle("in")).not.toBeNull();
  });

  it("the I key marks the frame on screen", async () => {
    const onMark = vi.fn();
    await mount({ onMark, range: noopRange(NONE) });
    await present(5);
    await key("i");
    expect(onMark).toHaveBeenCalledWith("in", 5);
  });

  it("keeps the I O in/out hint in the key legend", async () => {
    await mount({ onMark: vi.fn(), range: noopRange(NONE) });
    expect(byTestId("video-key-legend")!.textContent).toContain("in/out");
  });
});

describe("VideoPlayer range handles (#861)", () => {
  it("one handle for an In-only mark, two for a range, named In point / Out point", async () => {
    await mount({ onMark: vi.fn(), range: noopRange({ in: 10, out: null }) });
    expect(handle("in")!.getAttribute("aria-label")).toBe("In point");
    expect(handle("out")).toBeNull();
    await update({ range: noopRange({ in: 10, out: 20 }) });
    expect(handle("out")!.getAttribute("aria-label")).toBe("Out point");
    expect(handle("in")!.getAttribute("role")).toBe("slider");
    expect(handle("in")!.getAttribute("aria-valuenow")).toBe("10");
    expect(handle("in")!.getAttribute("aria-valuemax")).toBe("20");
    expect(handle("out")!.getAttribute("aria-valuemin")).toBe("10");
  });

  it("labels the value in the chosen time format", async () => {
    shim.values.set(TIME_FORMAT_KEY, JSON.stringify("frames"));
    resetUiPrefMemory();
    await mount({ onMark: vi.fn(), range: noopRange({ in: 10, out: 20 }) });
    expect(handle("in")!.getAttribute("aria-valuetext")).toBe("10");
  });

  it("dragging rounds to the nearest frame, marks it, and seeks the paused playhead there", async () => {
    const onMark = vi.fn();
    await mount({ onMark, range: noopRange({ in: 10, out: 60 }) });
    const grip = handle("in")!;
    await pointer("pointerdown", grip, { clientX: centre(10) });
    await pointer("pointermove", grip, { clientX: 46.4 });
    expect(onMark).toHaveBeenLastCalledWith("in", 40);
    await pointer("pointermove", grip, { clientX: 46.6 });
    expect(onMark).toHaveBeenLastCalledWith("in", 41);
    await pointer("pointerup", grip, { clientX: 46.6 });
    await act(async () => { stub.finishSeek(video()); stub.presentFrame(video(), 41 / 25); });
    expect(readout()).toContain("00:00:01:16");
  });

  it("a drag cannot cross the other handle: In stops at Out and Out stops at In, without moving the other end", async () => {
    const onMark = vi.fn();
    await mount({ onMark, range: noopRange({ in: 10, out: 60 }) });
    await pointer("pointerdown", handle("in")!, { clientX: centre(10) });
    await pointer("pointermove", handle("in")!, { clientX: centre(90) });
    await pointer("pointerup", handle("in")!, { clientX: centre(90) });
    expect(onMark.mock.calls.every(([kind, frame]) => kind === "in" && frame <= 60)).toBe(true);
    expect(onMark).toHaveBeenLastCalledWith("in", 60);
    onMark.mockClear();
    await pointer("pointerdown", handle("out")!, { clientX: centre(60) });
    await pointer("pointermove", handle("out")!, { clientX: centre(2) });
    await pointer("pointerup", handle("out")!, { clientX: centre(2) });
    expect(onMark).toHaveBeenLastCalledWith("out", 10);
  });

  it("dragging past the ends of the track clamps to the first and last frame", async () => {
    const onMark = vi.fn();
    await mount({ onMark, range: noopRange({ in: 10, out: null }) });
    await pointer("pointerdown", handle("in")!, { clientX: centre(10) });
    await pointer("pointermove", handle("in")!, { clientX: -300 });
    expect(onMark).toHaveBeenLastCalledWith("in", 0);
    await pointer("pointermove", handle("in")!, { clientX: 900 });
    expect(onMark).toHaveBeenLastCalledWith("in", 100);
  });

  it("a press that grabs the handle off-centre does not jump", async () => {
    const onMark = vi.fn();
    await mount({ onMark, range: noopRange({ in: 10, out: null }) });
    await pointer("pointerdown", handle("in")!, { clientX: centre(10) + 3 });
    await pointer("pointermove", handle("in")!, { clientX: centre(10) + 3 });
    expect(onMark).not.toHaveBeenCalled();
    await pointer("pointermove", handle("in")!, { clientX: centre(25) + 3 });
    expect(onMark).toHaveBeenLastCalledWith("in", 25);
  });

  it("ignores a secondary button and a non-primary pointer", async () => {
    const onMark = vi.fn();
    await mount({ onMark, range: noopRange({ in: 10, out: null }) });
    await pointer("pointerdown", handle("in")!, { clientX: centre(10), button: 2 });
    await pointer("pointermove", handle("in")!, { clientX: centre(50) });
    await pointer("pointerdown", handle("in")!, { clientX: centre(10), isPrimary: false, pointerId: 7 });
    await pointer("pointermove", handle("in")!, { clientX: centre(50) });
    expect(onMark).not.toHaveBeenCalled();
  });

  it("a touch pointer never starts a drag, even where the primary pointer is fine", async () => {
    const onMark = vi.fn();
    await mount({ onMark, range: noopRange({ in: 10, out: null }) });
    await pointer("pointerdown", handle("in")!, { clientX: centre(10), pointerType: "touch" });
    await pointer("pointermove", handle("in")!, { clientX: centre(50), pointerType: "touch" });
    expect(onMark).not.toHaveBeenCalled();
  });

  it("pointercancel ends the drag: later moves change nothing", async () => {
    const onMark = vi.fn();
    await mount({ onMark, range: noopRange({ in: 10, out: null }) });
    await pointer("pointerdown", handle("in")!, { clientX: centre(10) });
    await pointer("pointermove", handle("in")!, { clientX: centre(20) });
    await pointer("pointercancel", handle("in")!, { clientX: centre(20) });
    onMark.mockClear();
    await pointer("pointermove", handle("in")!, { clientX: centre(50) });
    expect(onMark).not.toHaveBeenCalled();
  });

  it("locking mid-gesture ends it", async () => {
    const onMark = vi.fn();
    await mount({ onMark, range: noopRange({ in: 10, out: null }) });
    await pointer("pointerdown", handle("in")!, { clientX: centre(10) });
    await update({ range: noopRange({ in: 10, out: null }, { locked: true }) });
    await pointer("pointermove", handle("in")!, { clientX: centre(50) });
    expect(onMark).not.toHaveBeenCalled();
  });

  it("a locked handle ignores the pointer and the keys and says so", async () => {
    const onMark = vi.fn();
    await mount({ onMark, range: noopRange({ in: 10, out: null }, { locked: true }) });
    expect(handle("in")!.getAttribute("aria-disabled")).toBe("true");
    await pointer("pointerdown", handle("in")!, { clientX: centre(10) });
    await pointer("pointermove", handle("in")!, { clientX: centre(50) });
    await key("ArrowRight", {}, handle("in")!);
    expect(onMark).not.toHaveBeenCalled();
  });

  it("an uncovered press on the track still seeks the playhead", async () => {
    await mount({ onMark: vi.fn(), range: noopRange({ in: 10, out: null }) });
    expect(byTestId("video-range-handles")!.className).toContain("pointer-events-none");
  });

  it("handle keys: the arrow moves the handle one frame, not the playhead; Shift+Arrow, Home and End jump to the bounds", async () => {
    const onMark = vi.fn();
    await mount({ onMark, range: noopRange({ in: 10, out: 60 }) });
    await present(50);
    await key("ArrowRight", {}, handle("in")!);
    expect(onMark).toHaveBeenLastCalledWith("in", 11);
    // The playhead follows the handle (it seeks to frame 11), it does not take the arrow as its own step (frame 51).
    expect(video().currentTime).toBeCloseTo(11.5 / 25, 2);
    await key("ArrowLeft", {}, handle("in")!);
    expect(onMark).toHaveBeenLastCalledWith("in", 9);
    await key("ArrowRight", { shiftKey: true }, handle("in")!);
    expect(onMark).toHaveBeenLastCalledWith("in", 35);
    await key("End", {}, handle("in")!);
    expect(onMark).toHaveBeenLastCalledWith("in", 60);
    await key("Home", {}, handle("out")!);
    expect(onMark).toHaveBeenLastCalledWith("out", 10);
    await key("Home", {}, handle("in")!);
    expect(onMark).toHaveBeenLastCalledWith("in", 0);
  });

  it("a one-frame film still gets a button and a handle on frame 0", async () => {
    await mount({ onMark: vi.fn(), range: noopRange({ in: 0, out: 0 }) }, versionOf({ frameCount: 1 }));
    expect(handle("in")!.getAttribute("aria-valuenow")).toBe("0");
    expect(handle("out")!.getAttribute("aria-valuemax")).toBe("0");
  });
});
