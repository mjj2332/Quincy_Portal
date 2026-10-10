import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frameSeekSeconds } from "@quincy/shared";
import { installVideoElementStub, type VideoElementStub } from "../testing/video-element";
import { VideoFrameClock } from "./video-frame-clock";

const FPS_25 = { num: 25, den: 1 } as const;
let stub: VideoElementStub;
let clock: VideoFrameClock | null = null;

function setup(opts: { initialFrame?: number; frameCount?: number } = {}) {
  stub = installVideoElementStub({ rvfc: true });
  const video = document.createElement("video");
  clock = new VideoFrameClock(video, { fps: FPS_25, frameCount: opts.frameCount ?? 100 }, opts.initialFrame === undefined ? {} : { initialFrame: opts.initialFrame });
  return video;
}
function settle(video: HTMLVideoElement, frame = 0) {
  stub.loadMetadata(video, { duration: 4, videoWidth: 1920, videoHeight: 1080 });
  stub.setReadyState(video, 4);
  stub.finishSeek(video);
  stub.presentFrame(video, frame / 25);
  stub.writes.length = 0;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { clock?.dispose(); clock = null; stub.dispose(); vi.useRealTimers(); });

describe("VideoFrameClock compare API (#741 7b)", () => {
  it("initialFrame: the first seek goes there instead of frame 0", () => {
    const video = setup({ initialFrame: 40 });
    stub.loadMetadata(video, { duration: 4 });
    expect(stub.writes).toEqual([frameSeekSeconds(40, FPS_25)]);
    expect(clock!.getState().targetFrame).toBe(40);
    stub.finishSeek(video);
    stub.presentFrame(video, 40 / 25);
    expect(clock!.getState()).toMatchObject({ frame: 40, confirmed: true });
  });

  it("initialFrame is read once: a later metadata event seeks to 0", () => {
    const video = setup({ initialFrame: 40 });
    stub.loadMetadata(video, { duration: 4 });
    stub.finishSeek(video); stub.presentFrame(video, 40 / 25);
    stub.loadMetadata(video, { duration: 4 });
    expect(stub.writes.at(-1)).toBe(frameSeekSeconds(0, FPS_25));
  });

  it("initialFrame is clamped to the film", () => {
    const video = setup({ initialFrame: 500 });
    stub.loadMetadata(video, { duration: 4 });
    expect(clock!.getState().targetFrame).toBe(99);
  });

  it("exposes lastFrame() (cut to the element's duration) and mediaTime() (the last presented frame)", () => {
    const video = setup();
    expect(clock!.lastFrame()).toBe(99);
    settle(video);
    stub.loadMetadata(video, { duration: 2 });
    expect(clock!.lastFrame()).toBe(49);
    stub.presentFrame(video, 0.36);
    expect(clock!.mediaTime()).toBe(0.36);
  });

  it("a trimmed playbackRate does not leak into state.rate when the element fires play", () => {
    const video = setup(); settle(video);
    clock!.setRate(2);
    clock!.setRateTrim(0.95);
    expect(video.playbackRate).toBeCloseTo(1.9);
    expect(clock!.getState().rate).toBe(2);
    // the element is paused by the browser and plays again (a play event with the trimmed rate on the element)
    video.pause();
    expect(clock!.getState()).toMatchObject({ playing: false, rate: 0 });
    video.play();
    expect(clock!.getState()).toMatchObject({ playing: true, rate: 2 });
  });

  it("setRateTrim / clearRateTrim write playbackRate = rate x factor only while playing forward, leaving state alone", () => {
    const video = setup(); settle(video);
    clock!.setRateTrim(1.05);
    expect(video.playbackRate).toBe(1);
    clock!.play();
    clock!.setRateTrim(1.05);
    expect(video.playbackRate).toBeCloseTo(1.05);
    expect(clock!.getState().rate).toBe(1);
    clock!.clearRateTrim();
    expect(video.playbackRate).toBe(1);
  });

  it("seekWhilePlaying seeks without pausing or leaving the playing state", () => {
    const video = setup(); settle(video);
    clock!.play();
    stub.calls.length = 0;
    clock!.seekWhilePlaying(30);
    expect(stub.writes).toEqual([frameSeekSeconds(30, FPS_25)]);
    expect(stub.calls).not.toContain("pause");
    expect(video.paused).toBe(false);
    expect(clock!.getState()).toMatchObject({ playing: true, rate: 1, targetFrame: 30 });
    stub.finishSeek(video);
    stub.presentFrame(video, 30 / 25);
    expect(clock!.getState()).toMatchObject({ frame: 30, targetFrame: null, playing: true });
  });

  it("play after a pending seek to a frame before the end does not restart from 0 because the old frame was the last", () => {
    const video = setup(); settle(video, 99);
    clock!.seekToFrame(10);
    stub.writes.length = 0;
    clock!.play();
    expect(stub.writes).toEqual([]);
    expect(clock!.getState().targetFrame).toBe(10);
  });

  it("stalled: waiting while un-paused sets it; playing / pause / seeked with enough data clear it", () => {
    const video = setup(); settle(video);
    stub.fireWaiting(video);
    expect(clock!.getState().stalled).toBe(false); // paused: a seek's own waiting is not a stall
    clock!.play();
    stub.setReadyState(video, 2);
    stub.fireWaiting(video);
    expect(clock!.getState().stalled).toBe(true);
    stub.setReadyState(video, 4);
    stub.firePlaying(video);
    expect(clock!.getState().stalled).toBe(false);
    stub.setReadyState(video, 2);
    stub.fireWaiting(video);
    expect(clock!.getState().stalled).toBe(true);
    stub.setReadyState(video, 4);
    stub.finishSeek(video);
    expect(clock!.getState().stalled).toBe(false);
  });

  it("pausing the clock clears a stall", () => {
    const video = setup(); settle(video);
    clock!.play();
    stub.setReadyState(video, 2);
    stub.fireWaiting(video);
    clock!.pause();
    expect(clock!.getState().stalled).toBe(false);
  });

  it("isLive: un-paused, playing forward, not in reverse", () => {
    const video = setup(); settle(video);
    clock!.seekToFrame(10); stub.finishSeek(video); stub.presentFrame(video, 10 / 25);
    expect(clock!.isLive()).toBe(false);
    clock!.play();
    expect(clock!.isLive()).toBe(true);
    clock!.reverse(1);
    expect(clock!.isLive()).toBe(false);
    clock!.pause();
    expect(clock!.isLive()).toBe(false);
  });

  it("onPlayRejected hears a refused play() (not an AbortError) before the clock stops", async () => {
    const video = setup(); settle(video);
    const heard: Array<{ name: string; playing: boolean }> = [];
    clock!.onPlayRejected((error) => { heard.push({ name: (error as DOMException).name, playing: clock!.getState().playing }); });
    stub.rejectNextPlay("NotAllowedError", video);
    clock!.play();
    await vi.advanceTimersByTimeAsync(0);
    expect(heard).toEqual([{ name: "NotAllowedError", playing: true }]);
    expect(clock!.getState().playing).toBe(false);
  });
});
