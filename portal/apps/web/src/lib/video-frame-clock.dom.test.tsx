import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frameSeekSeconds } from "@quincy/shared";
import { installVideoElementStub, type VideoElementStub } from "../testing/video-element";
import { VideoFrameClock } from "./video-frame-clock";

const FPS_25 = { num: 25, den: 1 } as const;
let stub: VideoElementStub;
let clock: VideoFrameClock | null = null;

function setup(opts: { rvfc?: boolean; fps?: { num: number; den: number }; frameCount?: number; now?: () => number } = {}) {
  stub = installVideoElementStub({ rvfc: opts.rvfc ?? true });
  const video = document.createElement("video");
  clock = new VideoFrameClock(video, { fps: opts.fps ?? FPS_25, frameCount: opts.frameCount ?? 100 }, opts.now ? { now: opts.now } : {});
  return video;
}
/** Lands the first frame the way `loadedmetadata` does, so a test starts from a settled frame 0. */
function settleAtZero(video: HTMLVideoElement, duration = 4) {
  stub.loadMetadata(video, { duration, videoWidth: 1920, videoHeight: 1080 });
  stub.finishSeek(video);
  if (stub.rvfc) stub.presentFrame(video, 0);
  stub.writes.length = 0;
}
const seekTo = (frame: number, fps = FPS_25) => frameSeekSeconds(frame, fps);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { clock?.dispose(); clock = null; stub.dispose(); vi.useRealTimers(); });

describe("VideoFrameClock, requestVideoFrameCallback path (#741 4d-ii)", () => {
  it("paints frame 0 on loadedmetadata and confirms it from the presented frame", () => {
    const video = setup();
    stub.loadMetadata(video, { duration: 4 });
    expect(stub.writes).toEqual([seekTo(0)]);
    expect(clock!.getState()).toMatchObject({ frame: 0, targetFrame: 0, confirmed: false });
    stub.finishSeek(video);
    stub.presentFrame(video, 0);
    expect(clock!.getState()).toMatchObject({ frame: 0, targetFrame: null, confirmed: true, playing: false });
  });

  it("a step seeks to the middle of the next frame and confirms only when that frame is presented", () => {
    const video = setup(); settleAtZero(video);
    clock!.step(1);
    expect(stub.writes).toEqual([seekTo(1)]);
    expect(clock!.getState()).toMatchObject({ targetFrame: 1, confirmed: false });
    stub.finishSeek(video);
    expect(clock!.getState().confirmed).toBe(false);
    stub.presentFrame(video, 1 / 25);
    expect(clock!.getState()).toMatchObject({ frame: 1, targetFrame: null, confirmed: true });
  });

  it("the presented mediaTime, not the seek target, says which frame is on screen", () => {
    const video = setup(); settleAtZero(video);
    stub.presentFrame(video, 10 / 25);
    expect(clock!.getState().frame).toBe(10);
  });

  it("rapid steps coalesce: one seek in flight, then exactly one more for the final target", () => {
    const video = setup(); settleAtZero(video);
    clock!.step(1); clock!.step(1); clock!.step(1);
    expect(stub.writes).toEqual([seekTo(1)]);
    expect(clock!.getState().targetFrame).toBe(3);
    stub.finishSeek(video);
    expect(stub.writes).toEqual([seekTo(1), seekTo(3)]);
    expect(clock!.getState().confirmed).toBe(false);
    stub.finishSeek(video);
    stub.presentFrame(video, 3 / 25);
    expect(clock!.getState()).toMatchObject({ frame: 3, targetFrame: null, confirmed: true });
    expect(stub.writes).toHaveLength(2);
  });

  it("a late frame callback from an intermediate seek does not settle the coalesced target, so the next step goes to 4", () => {
    const video = setup(); settleAtZero(video);
    clock!.step(1); clock!.step(1); clock!.step(1);
    stub.finishSeek(video);
    expect(stub.writes).toEqual([seekTo(1), seekTo(3)]);
    stub.finishSeek(video);
    stub.presentFrame(video, 1 / 25);
    expect(clock!.getState()).toMatchObject({ targetFrame: 3, confirmed: false });
    stub.presentFrame(video, 3 / 25);
    expect(clock!.getState()).toMatchObject({ frame: 3, targetFrame: null, confirmed: true });
    clock!.step(1);
    expect(stub.writes.at(-1)).toBe(seekTo(4));
  });

  it("a late intermediate frame resolves awaitConfirmedFrame only with the frame that was asked for", async () => {
    const video = setup(); settleAtZero(video);
    clock!.step(1); clock!.step(1); clock!.step(1);
    const settled = vi.fn();
    const pending = clock!.awaitConfirmedFrame().then(settled);
    stub.finishSeek(video); stub.finishSeek(video);
    stub.presentFrame(video, 1 / 25);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    stub.presentFrame(video, 3 / 25);
    await pending;
    expect(clock!.getState().frame).toBe(3);
  });

  it("presentation evidence is per seek: frames shown while playing do not confirm a later pause seek", () => {
    const video = setup(); settleAtZero(video);
    clock!.play();
    stub.presentFrame(video, 5 / 25);
    clock!.pause();
    expect(clock!.getState()).toMatchObject({ targetFrame: 5, confirmed: false });
    stub.finishSeek(video);
    expect(clock!.getState()).toMatchObject({ targetFrame: 5, confirmed: false });
    stub.presentFrame(video, 5 / 25);
    expect(clock!.getState()).toMatchObject({ frame: 5, targetFrame: null, confirmed: true });
  });

  it("a Play requested before loadedmetadata is still playing once the metadata arrives", () => {
    const video = setup();
    clock!.play();
    expect(clock!.getState().playing).toBe(true);
    stub.loadMetadata(video, { duration: 4, videoWidth: 1920, videoHeight: 1080 });
    expect(clock!.getState()).toMatchObject({ playing: true, rate: 1 });
    expect(stub.calls.at(-1)).toBe("play");
    expect(video.paused).toBe(false);
  });

  it("a Play requested before loadedmetadata survives the way a real element settles it: pause() aborts the early play() promise, and the pause event arrives late", async () => {
    const video = setup();
    // Chrome: pause() rejects the pending play() promise with AbortError and fires `pause` in a later task.
    const pending: Array<(reason: unknown) => void> = [];
    const realPlay = video.play.bind(video); const realPause = video.pause.bind(video);
    Object.defineProperty(video, "play", { configurable: true, value: () => { void realPlay(); return new Promise<void>((_resolve, reject) => { pending.push(reject); }); } });
    Object.defineProperty(video, "pause", { configurable: true, value: () => { realPause(); for (const reject of pending.splice(0)) queueMicrotask(() => { reject(new DOMException("interrupted", "AbortError")); }); } });
    clock!.play();
    stub.loadMetadata(video, { duration: 4, videoWidth: 1920, videoHeight: 1080 });
    await Promise.resolve(); await Promise.resolve();
    expect(clock!.getState()).toMatchObject({ playing: true, rate: 1 });
    expect(video.paused).toBe(false);
  });

  it("falls back to the playhead when no frame is presented after a settled seek", () => {
    const video = setup(); settleAtZero(video);
    clock!.step(1);
    stub.finishSeek(video);
    vi.advanceTimersByTime(400);
    expect(clock!.getState()).toMatchObject({ frame: 1, targetFrame: null, confirmed: true });
  });

  it("awaitConfirmedFrame resolves with the frame once it is on screen", async () => {
    const video = setup(); settleAtZero(video);
    clock!.seekToFrame(7);
    let resolved: number | null = null;
    void clock!.awaitConfirmedFrame().then((frame) => { resolved = frame; });
    await Promise.resolve();
    expect(resolved).toBeNull();
    stub.finishSeek(video);
    stub.presentFrame(video, 7 / 25);
    await Promise.resolve();
    expect(resolved).toBe(7);
  });

  it("awaitConfirmedFrame on a settled, paused clock resolves at once", async () => {
    const video = setup(); settleAtZero(video);
    await expect(clock!.awaitConfirmedFrame()).resolves.toBe(0);
  });

  it("awaitConfirmedFrame while playing pauses and resolves with the frame left on screen", async () => {
    const video = setup(); settleAtZero(video);
    clock!.play();
    stub.presentFrame(video, 12 / 25);
    expect(clock!.getState()).toMatchObject({ playing: true, frame: 12 });
    const pending = clock!.awaitConfirmedFrame();
    expect(video.paused).toBe(true);
    expect(clock!.getState().playing).toBe(false);
    stub.finishSeek(video);
    stub.presentFrame(video, 12 / 25);
    await expect(pending).resolves.toBe(12);
  });

  it("stepping back from frame 0 and forward from the last frame is a no-op (no seek)", () => {
    const video = setup(); settleAtZero(video);
    clock!.step(-1);
    expect(stub.writes).toEqual([]);
    clock!.seekToFrame(99);
    stub.finishSeek(video); stub.presentFrame(video, 99 / 25);
    stub.writes.length = 0;
    clock!.step(1);
    expect(stub.writes).toEqual([]);
    expect(clock!.getState()).toMatchObject({ frame: 99, targetFrame: null, confirmed: true });
  });

  it("clamps a seek into [0, frameCount - 1]", () => {
    const video = setup(); settleAtZero(video);
    clock!.seekToFrame(-5); expect(stub.writes).toEqual([]);
    clock!.seekToFrame(500);
    expect(stub.writes).toEqual([seekTo(99)]);
    expect(clock!.getState().targetFrame).toBe(99);
    void video;
  });

  it("clamps below an element duration shorter than the frame count says", () => {
    const video = setup(); settleAtZero(video, 3);
    clock!.seekToFrame(99);
    expect(stub.writes).toEqual([seekTo(74)]);
    void video;
  });

  it("ended parks on the last frame, paused", () => {
    const video = setup(); settleAtZero(video);
    clock!.play();
    stub.endPlayback(video);
    expect(clock!.getState()).toMatchObject({ frame: 99, playing: false, rate: 0 });
  });

  it("play at the last frame restarts from frame 0", () => {
    const video = setup(); settleAtZero(video);
    clock!.seekToFrame(99); stub.finishSeek(video); stub.presentFrame(video, 99 / 25);
    stub.writes.length = 0; stub.calls.length = 0;
    clock!.play();
    expect(stub.writes).toEqual([seekTo(0)]);
    expect(stub.calls).toContain("play");
    expect(clock!.getState()).toMatchObject({ playing: true, rate: 1 });
  });

  it("setRate plays forward at that rate; pause stops", () => {
    const video = setup(); settleAtZero(video);
    clock!.setRate(4);
    expect(video.playbackRate).toBe(4);
    expect(video.paused).toBe(false);
    expect(clock!.getState()).toMatchObject({ playing: true, rate: 4 });
    clock!.pause();
    expect(video.paused).toBe(true);
    expect(clock!.getState()).toMatchObject({ playing: false, rate: 0 });
  });

  it("dispose cancels the frame callback and ignores later events", () => {
    const video = setup(); settleAtZero(video);
    expect(stub.pendingFrameCallbacks(video)).toBe(1);
    clock!.dispose();
    expect(stub.pendingFrameCallbacks(video)).toBe(0);
    stub.presentFrame(video, 5 / 25);
    video.dispatchEvent(new Event("seeked"));
    expect(clock!.getState().frame).toBe(0);
  });
});

describe("VideoFrameClock, fallback without requestVideoFrameCallback (#741 4d-ii)", () => {
  it("derives the frame from the playhead on seeked", () => {
    const video = setup({ rvfc: false }); settleAtZero(video);
    clock!.step(1);
    expect(clock!.getState()).toMatchObject({ targetFrame: 1, confirmed: false });
    stub.finishSeek(video);
    expect(clock!.getState()).toMatchObject({ frame: 1, targetFrame: null, confirmed: true });
  });

  it("follows the playhead while playing", () => {
    const video = setup({ rvfc: false }); settleAtZero(video);
    clock!.play();
    stub.advance(video, 0.5);
    vi.advanceTimersByTime(50);
    expect(clock!.getState().frame).toBe(Math.floor(((0.5 + seekTo(0)) * 25) + 1e-6));
  });

  it("coalesces rapid steps the same way", () => {
    const video = setup({ rvfc: false }); settleAtZero(video);
    clock!.step(1); clock!.step(1);
    expect(stub.writes).toEqual([seekTo(1)]);
    stub.finishSeek(video);
    expect(stub.writes).toEqual([seekTo(1), seekTo(2)]);
    stub.finishSeek(video);
    expect(clock!.getState()).toMatchObject({ frame: 2, confirmed: true });
  });
});

describe("VideoFrameClock reverse shuttle (#741 4d-ii)", () => {
  function reverseSetup() {
    let now = 0;
    const video = setup({ now: () => now });
    settleAtZero(video);
    clock!.seekToFrame(50); stub.finishSeek(video); stub.presentFrame(video, 50 / 25);
    stub.writes.length = 0;
    return { video, at: (ms: number) => { now = ms; } };
  }

  it("mutes while reversing, seeks backward only after the previous seek landed, and restores the mute", () => {
    const { video, at } = reverseSetup();
    clock!.reverse(1);
    expect(video.muted).toBe(true);
    expect(video.paused).toBe(true);
    expect(clock!.getState()).toMatchObject({ playing: true, rate: -1 });
    at(40); vi.advanceTimersByTime(40);
    expect(stub.writes).toEqual([seekTo(49)]);
    at(200); vi.advanceTimersByTime(200);
    expect(stub.writes).toEqual([seekTo(49)]);
    stub.finishSeek(video);
    expect(stub.writes).toEqual([seekTo(49), seekTo(45)]);
    clock!.pause();
    expect(video.muted).toBe(false);
    expect(clock!.getState()).toMatchObject({ playing: false, rate: 0 });
  });

  it("keeps a mute the user chose", () => {
    const { video } = reverseSetup();
    video.muted = true;
    clock!.reverse(1);
    clock!.pause();
    expect(video.muted).toBe(true);
  });

  it("runs faster at a higher speed", () => {
    const { video, at } = reverseSetup();
    clock!.reverse(4);
    at(250); vi.advanceTimersByTime(250);
    expect(stub.writes).toEqual([seekTo(50 - 25)]);
    void video;
  });

  it("stops at frame 0, never seeking below it, and confirms frame 0", () => {
    const { video, at } = reverseSetup();
    clock!.reverse(8);
    at(1000); vi.advanceTimersByTime(1000);
    expect(stub.writes).toEqual([seekTo(0)]);
    stub.finishSeek(video);
    expect(clock!.getState()).toMatchObject({ playing: false, rate: 0 });
    expect(video.muted).toBe(false);
    stub.presentFrame(video, 0);
    expect(clock!.getState()).toMatchObject({ frame: 0, confirmed: true, targetFrame: null });
    at(5000); vi.advanceTimersByTime(5000);
    expect(stub.writes).toEqual([seekTo(0)]);
  });

  it("a step during a reverse stops it and steps from the frame it reached", () => {
    const { video, at } = reverseSetup();
    clock!.reverse(1);
    at(40); vi.advanceTimersByTime(40);
    clock!.step(-1);
    expect(video.muted).toBe(false);
    expect(clock!.getState()).toMatchObject({ playing: false, rate: 0, targetFrame: 48 });
    stub.finishSeek(video);
    expect(stub.writes.at(-1)).toBe(seekTo(48));
  });
});

describe("VideoFrameClock, Play inside the user's gesture (#741 4d-ii Sol final)", () => {
  /** Chrome: pause() rejects every pending play() promise with AbortError. */
  function chromePromises(video: HTMLVideoElement) {
    const pending: Array<(reason: unknown) => void> = [];
    const realPlay = video.play.bind(video); const realPause = video.pause.bind(video);
    Object.defineProperty(video, "play", { configurable: true, value: () => { void realPlay(); return new Promise<void>((_resolve, reject) => { pending.push(reject); }); } });
    Object.defineProperty(video, "pause", { configurable: true, value: () => { realPause(); for (const reject of pending.splice(0)) queueMicrotask(() => { reject(new DOMException("interrupted", "AbortError")); }); } });
  }

  it("calls video.play() synchronously in the setRate call, before any metadata, and the initial positioning never pauses", async () => {
    const video = setup(); chromePromises(video);
    clock!.setRate(2);
    expect(stub.calls).toEqual(["play"]);
    stub.loadMetadata(video, { duration: 4, videoWidth: 1920, videoHeight: 1080 });
    await Promise.resolve(); await Promise.resolve();
    expect(stub.calls).not.toContain("pause");
    expect(clock!.getState()).toMatchObject({ playing: true, rate: 2 });
    expect(video.paused).toBe(false);
  });

  it("when the playhead is not at 0 on metadata, it is moved to frame 0 without pausing", async () => {
    const video = setup(); chromePromises(video);
    clock!.play();
    stub.advance(video, 1);
    stub.loadMetadata(video, { duration: 4, videoWidth: 1920, videoHeight: 1080 });
    await Promise.resolve(); await Promise.resolve();
    expect(stub.writes).toEqual([seekTo(0)]);
    expect(stub.calls).not.toContain("pause");
    expect(clock!.getState()).toMatchObject({ playing: true, rate: 1 });
  });

  it("an AbortError from a play() that a newer load superseded does not flip the state", async () => {
    const video = setup();
    Object.defineProperty(video, "play", { configurable: true, value: () => Promise.reject(new DOMException("interrupted", "AbortError")) });
    clock!.play();
    await Promise.resolve(); await Promise.resolve();
    expect(clock!.getState()).toMatchObject({ playing: true, rate: 1 });
  });
});

describe("VideoFrameClock, seeks stay inside the element's real duration (#741 4d-ii Sol final)", () => {
  it("seeking the last frame of a 3.01 s film at 25 fps targets a time strictly below the duration", () => {
    const video = setup(); settleAtZero(video, 3.01);
    clock!.seekToFrame(75);
    expect(stub.writes).toHaveLength(1);
    expect(stub.writes[0]!).toBeLessThan(3.01);
    expect(stub.writes[0]!).toBeGreaterThan(3.0);
  });

  it("the restart-from-the-last-frame path is clamped too", () => {
    const video = setup(); settleAtZero(video, 0.01);
    clock!.play();
    expect(stub.writes).toHaveLength(1);
    expect(stub.writes[0]!).toBeLessThan(0.01);
  });
});
