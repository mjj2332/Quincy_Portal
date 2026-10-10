import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aOf, bOf, frameSeekSeconds, type Rational } from "@quincy/shared";
import { installVideoElementStub, type VideoElementStub } from "../testing/video-element";
import { VideoFrameClock } from "./video-frame-clock";
import { CompareTransport, RECOVERY_WINDOW_MS } from "./video-compare-transport";
import { createCompareStore, type CompareStore } from "./video-compare-store";

const F25: Rational = { num: 25, den: 1 };
const F50: Rational = { num: 50, den: 1 };

let stub: VideoElementStub;
let transport: CompareTransport | null = null;
let clocks: VideoFrameClock[] = [];

type Rig = { va: HTMLVideoElement; vb: HTMLVideoElement; ca: VideoFrameClock; cb: VideoFrameClock; store: CompareStore; t: CompareTransport; fpsA: Rational; fpsB: Rational; doc: FakeDoc };
type FakeDoc = EventTarget & { visibilityState: "visible" | "hidden" };

/** Two stubbed elements, each landed on frame 0, and a transport over them. */
function rig(opts: { fpsA?: Rational; fpsB?: Rational; nA?: number; nB?: number; offset?: number; audible?: "a" | "b"; muted?: boolean } = {}): Rig {
  const fpsA = opts.fpsA ?? F25;
  const fpsB = opts.fpsB ?? F25;
  const nA = opts.nA ?? 100;
  const nB = opts.nB ?? 100;
  stub = installVideoElementStub({ rvfc: true });
  const va = document.createElement("video");
  const vb = document.createElement("video");
  const ca = new VideoFrameClock(va, { fps: fpsA, frameCount: nA });
  const cb = new VideoFrameClock(vb, { fps: fpsB, frameCount: nB });
  clocks = [ca, cb];
  for (const [v, f, n] of [[va, fpsA, nA], [vb, fpsB, nB]] as const) {
    stub.loadMetadata(v, { duration: (n * f.den) / f.num, videoWidth: 1920, videoHeight: 1080 });
    stub.setReadyState(v, 4);
    stub.finishSeek(v);
    stub.presentFrame(v, 0);
  }
  const store = createCompareStore("t");
  store.setPair("A", "B", opts.audible ?? "a");
  if (opts.offset) store.setOffset(opts.offset);
  if (opts.muted) store.setMuted(true);
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as "visible" | "hidden" });
  const t = new CompareTransport({ a: { clock: ca, video: va, fps: fpsA, frameCount: nA, hasAudio: true }, b: { clock: cb, video: vb, fps: fpsB, frameCount: nB, hasAudio: true }, store, now: () => Date.now(), document: doc });
  transport = t;
  stub.writes.length = 0;
  return { va, vb, ca, cb, store, t, fpsA, fpsB, doc };
}
/** Lands a pending seek and presents the frame, the way the browser does. */
function land(v: HTMLVideoElement, frame: number, fps: Rational) {
  stub.finishSeek(v);
  stub.presentFrame(v, (frame * fps.den) / fps.num);
}
const show = (v: HTMLVideoElement, frame: number, fps: Rational = F25) => { stub.presentFrame(v, (frame * fps.den) / fps.num); };
const seekAt = (frame: number, fps: Rational = F25) => frameSeekSeconds(frame, fps);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  transport?.dispose(); transport = null;
  for (const c of clocks) c.dispose();
  clocks = [];
  stub.dispose();
  vi.useRealTimers();
});

describe("CompareTransport: play (#741 7b)", () => {
  it("calls play() on both live sides synchronously, before any await", () => {
    const r = rig();
    r.t.play();
    expect(stub.callsOf(r.va)).toEqual(["play"]);
    expect(stub.callsOf(r.vb)).toEqual(["play"]);
    expect(r.t.getState()).toMatchObject({ playing: true, rate: 1, master: "a" });
  });

  it("never plays a side that has not started, and starts it when its window opens", () => {
    const r = rig({ offset: 10 }); // B starts 10 frames later
    r.t.play();
    expect(stub.callsOf(r.va)).toEqual(["play"]);
    expect(stub.callsOf(r.vb)).toEqual([]);
    expect(r.t.getState().phases).toEqual({ a: "live", b: "before" });
    show(r.va, 9);
    expect(stub.callsOf(r.vb)).toEqual([]);
    show(r.va, 10);
    expect(stub.callsOf(r.vb)).toEqual(["play"]);
    expect(r.t.getState().phases.b).toBe("live");
  });

  it("never plays a side that is on its last frame or past it", () => {
    const r = rig({ nA: 100, nB: 150 });
    r.t.seekTo(120);
    land(r.va, 99, F25); land(r.vb, 120, F25);
    expect(r.t.getState().phases).toEqual({ a: "after", b: "live" });
    r.t.play();
    expect(stub.callsOf(r.va).filter((c) => c === "play")).toEqual([]);
    expect(stub.callsOf(r.vb)).toContain("play");
    expect(r.va.currentTime).toBe(seekAt(99));
  });

  it("starts the side that is live when the other is before its start (negative offset)", () => {
    const r = rig({ offset: -10 }); // B is 10 frames ahead: the domain starts at -10 with A not yet started
    r.t.home();
    expect(r.t.getState().frame).toBe(-10);
    expect(r.t.getState().phases).toEqual({ a: "before", b: "live" });
    land(r.va, 0, F25); land(r.vb, 0, F25);
    r.t.play();
    expect(stub.callsOf(r.va)).toEqual([]);
    expect(stub.callsOf(r.vb)).toEqual(["play"]);
    expect(r.t.getState().master).toBe("b");
  });

  it("a parked side entering its window with too little data stalls: A is held, B is left to buffer", () => {
    const r = rig({ offset: 10 });
    r.t.play();
    stub.setReadyState(r.vb, 2);
    show(r.va, 10);
    expect(r.t.getState().stalled).toBe("b");
    expect(r.va.paused).toBe(true);
    expect(r.vb.paused).toBe(false);
  });

  it("stops at the shared end and plays again from the domain start", () => {
    const r = rig();
    r.t.play();
    show(r.va, 50); show(r.vb, 50);
    show(r.va, 99);
    expect(r.t.getState()).toMatchObject({ playing: false, frame: 99 });
    expect(r.va.paused).toBe(true);
    expect(r.vb.paused).toBe(true);
    land(r.va, 99, F25); land(r.vb, 99, F25);
    stub.writes.length = 0;
    r.t.play();
    expect(r.t.getState()).toMatchObject({ playing: true, frame: 0 });
    expect(r.va.currentTime).toBe(seekAt(0));
    expect(r.vb.currentTime).toBe(seekAt(0));
    expect(r.va.paused).toBe(false);
    expect(r.vb.paused).toBe(false);
  });
});

describe("CompareTransport: paired seeks (#741 7b)", () => {
  it("a paired step is exact: A advances one frame, B lands on the frame that A frame maps to (25 vs 50 fps)", () => {
    const r = rig({ fpsB: F50, nB: 200 });
    r.t.step(1);
    expect(r.va.currentTime).toBe(seekAt(1, F25));
    expect(r.vb.currentTime).toBe(seekAt(bOf(1, 0, F25, F50), F50));
    expect(bOf(1, 0, F25, F50)).toBe(3);
    land(r.va, 1, F25); land(r.vb, 3, F50);
    r.t.step(1);
    expect(bOf(2, 0, F25, F50)).toBe(5);
    expect(r.vb.currentTime).toBe(seekAt(5, F50));
    expect(r.t.getState().frame).toBe(2);
  });

  it("step is clamped to the domain", () => {
    const r = rig();
    r.t.step(-1);
    expect(r.t.getState().frame).toBe(0);
    expect(stub.writes).toEqual([]);
    r.t.end();
    expect(r.t.getState().frame).toBe(99);
  });

  it("home and end go to the domain edges, which lie outside a side that starts later", () => {
    const r = rig({ offset: 10, nA: 100, nB: 100 });
    r.t.end();
    expect(r.t.getState().frame).toBe(109);
    expect(r.t.getState().phases).toEqual({ a: "after", b: "last" });
    expect(r.va.currentTime).toBe(seekAt(99));
    expect(r.vb.currentTime).toBe(seekAt(99));
    land(r.va, 99, F25); land(r.vb, 99, F25);
    r.t.home();
    expect(r.t.getState().frame).toBe(0);
    expect(r.t.getState().phases.b).toBe("before");
    expect(r.vb.currentTime).toBe(seekAt(0));
  });

  it("seekSide lands that side exactly and maps the other", () => {
    const r = rig({ fpsB: F50, nB: 200 });
    r.t.seekSide("b", 7);
    expect(r.vb.currentTime).toBe(seekAt(7, F50));
    expect(r.va.currentTime).toBe(seekAt(aOf(7, 0, F25, F50), F25));
    expect(r.t.getState().frame).toBe(aOf(7, 0, F25, F50));
    land(r.vb, 7, F50); land(r.va, aOf(7, 0, F25, F50), F25);
    r.t.seekSide("a", 40);
    expect(r.va.currentTime).toBe(seekAt(40));
    expect(r.vb.currentTime).toBe(seekAt(bOf(40, 0, F25, F50), F50));
  });

  it("pause lands both sides on the frames the shared position maps to", () => {
    const r = rig();
    r.t.play();
    show(r.va, 20); show(r.vb, 21); // B drifted a frame ahead
    stub.writes.length = 0;
    r.t.pause();
    expect(r.t.getState()).toMatchObject({ playing: false, frame: 20 });
    expect(r.va.paused).toBe(true);
    expect(r.vb.paused).toBe(true);
    expect(r.vb.currentTime).toBe(seekAt(20));
  });
});

describe("CompareTransport: offset (#741 7b)", () => {
  it("keeps A still and re-seeks only B, paused", () => {
    const r = rig();
    r.t.seekTo(30);
    land(r.va, 30, F25); land(r.vb, 30, F25);
    stub.writes.length = 0;
    expect(r.t.setOffset(5)).toBe(true);
    expect(stub.writes).toEqual([seekAt(25)]);
    expect(r.va.currentTime).toBe(seekAt(30));
    expect(r.vb.currentTime).toBe(seekAt(25));
    expect(r.t.getState()).toMatchObject({ frame: 30, offset: 5 });
    expect(r.store.getState().offsets).toEqual({ "A:B": 5 });
  });

  it("pauses a playing pair, and A stays on the frame it shows", () => {
    const r = rig();
    r.t.play();
    show(r.va, 12); show(r.vb, 12);
    expect(r.t.setOffset(-3)).toBe(true);
    expect(r.t.getState()).toMatchObject({ playing: false, frame: 12 });
    expect(r.va.paused).toBe(true);
    expect(r.vb.paused).toBe(true);
    expect(r.va.currentTime).toBe(seekAt(12));
    expect(r.vb.currentTime).toBe(seekAt(15));
  });

  it("refuses a fractional offset and one beyond the bounds, changing nothing", () => {
    const r = rig();
    expect(r.t.offsetBounds()).toEqual({ min: -99, max: 99 });
    expect(r.t.setOffset(100)).toBe(false);
    expect(r.t.setOffset(-100)).toBe(false);
    expect(r.t.setOffset(1.5)).toBe(false);
    expect(r.store.getState().offsets).toEqual({});
    expect(r.t.setOffset(99)).toBe(true);
  });
});

describe("CompareTransport: master and audio (#741 7b)", () => {
  it("the audible live side is the master; when it runs out the other takes over", () => {
    const r = rig({ nA: 100, nB: 150 });
    r.t.play();
    expect(r.t.getState().master).toBe("a");
    show(r.va, 98);
    show(r.va, 99); // A is on its last frame: parked, B takes over
    expect(r.t.getState()).toMatchObject({ master: "b", playing: true });
    expect(r.va.paused).toBe(true);
    expect(r.vb.paused).toBe(false);
    show(r.vb, 100);
    expect(r.t.getState()).toMatchObject({ frame: 100 });
    expect(r.t.getState().phases.a).toBe("after");
    expect(stub.callsOf(r.va).filter((c) => c === "play")).toEqual(["play"]);
  });

  it("muted: A is master while live", () => {
    const r = rig({ audible: "b", muted: true });
    r.t.play();
    expect(r.t.getState().master).toBe("a");
  });

  it("with B audible B is the master, and the audible switch flips muted synchronously", () => {
    const r = rig();
    expect(r.va.muted).toBe(false);
    expect(r.vb.muted).toBe(true);
    r.t.play();
    r.t.setAudible("b");
    expect(r.va.muted).toBe(true);
    expect(r.vb.muted).toBe(false);
    expect(r.t.getState().master).toBe("b");
    expect(r.store.getState().audible).toBe("b");
    r.t.setMuted(true);
    expect(r.vb.muted).toBe(true);
  });

  it("an audible side that is parked by the offset starts with sound when its window opens", () => {
    const r = rig({ offset: 10, audible: "b" });
    r.t.play();
    expect(r.vb.muted).toBe(false);
    expect(r.t.getState().master).toBe("a");
    show(r.va, 10);
    expect(r.vb.paused).toBe(false);
    expect(r.t.getState().master).toBe("b");
  });
});

describe("CompareTransport: drift (#741 7b)", () => {
  it("trims the follower's rate 5% when it runs ahead, and releases once it is back inside tol / 2", () => {
    const r = rig();
    r.t.play();
    show(r.vb, 5, F25); stub.presentFrame(r.vb, 0.2); // B shows 0.2 s while A is at 0.04..0.12
    show(r.va, 1); show(r.va, 2);
    expect(r.vb.playbackRate).toBe(1);
    show(r.va, 3);
    expect(r.vb.playbackRate).toBeCloseTo(0.95);
    expect(r.t.getState().rate).toBe(1);
    // B comes back: three samples near zero
    for (const f of [4, 5, 6]) { stub.presentFrame(r.vb, f / 25); show(r.va, f); }
    expect(r.vb.playbackRate).toBe(1);
  });

  it("trims up when the follower is behind", () => {
    const r = rig();
    r.t.play();
    for (const f of [10, 11, 12]) { stub.presentFrame(r.vb, (f - 4) / 25); show(r.va, f); }
    expect(r.vb.playbackRate).toBeCloseTo(1.05);
  });

  it("hard-seeks the follower without pausing it when it is beyond 0.5 s", () => {
    const r = rig();
    r.t.play();
    stub.callsOf(r.vb).length = 0;
    for (const f of [20, 21, 22]) { stub.presentFrame(r.vb, 0.1); show(r.va, f); }
    expect(r.vb.currentTime).toBe(seekAt(22));
    expect(stub.callsOf(r.vb)).toEqual([]);
    expect(r.vb.paused).toBe(false);
    expect(r.vb.playbackRate).toBe(1);
  });

  it("measures drift in time across the offset: B is 10 frames late and exactly in step", () => {
    const r = rig({ offset: 10 });
    r.t.play();
    show(r.va, 10);
    for (const f of [11, 12, 13, 14]) { stub.presentFrame(r.vb, (f - 10) / 25); show(r.va, f); }
    expect(r.vb.playbackRate).toBe(1);
    expect(stub.callsOf(r.vb)).toEqual(["play"]);
  });
});

describe("CompareTransport: buffering (#741 7b)", () => {
  it("B stalling freezes the position, pauses A, leaves B un-paused, and resumes A on B's playing", () => {
    const r = rig();
    r.t.play();
    show(r.va, 10); show(r.vb, 10);
    stub.setReadyState(r.vb, 2);
    stub.fireWaiting(r.vb);
    expect(r.t.getState()).toMatchObject({ stalled: "b", playing: true, frame: 10 });
    expect(r.va.paused).toBe(true);
    expect(r.vb.paused).toBe(false);
    expect(stub.callsOf(r.vb)).toEqual(["play"]);
    show(r.va, 12);
    expect(r.t.getState().frame).toBe(10);
    stub.setReadyState(r.vb, 4);
    stub.firePlaying(r.vb);
    expect(r.t.getState().stalled).toBeNull();
    expect(r.va.paused).toBe(false);
    expect(stub.callsOf(r.va).at(-1)).toBe("play");
  });

  it("A (the master) stalling holds B and resumes it the same way", () => {
    const r = rig();
    r.t.play();
    show(r.va, 10);
    stub.fireWaiting(r.va);
    expect(r.t.getState().stalled).toBe("a");
    expect(r.vb.paused).toBe(true);
    expect(r.va.paused).toBe(false);
    stub.firePlaying(r.va);
    expect(r.vb.paused).toBe(false);
  });

  it("Pause during a stall pauses both and cancels the resume", () => {
    const r = rig();
    r.t.play();
    show(r.va, 10);
    stub.fireWaiting(r.vb);
    r.t.pause();
    expect(r.va.paused).toBe(true);
    expect(r.vb.paused).toBe(true);
    expect(r.t.getState()).toMatchObject({ playing: false, stalled: null });
    const playsBefore = stub.callsOf(r.va).filter((c) => c === "play").length;
    stub.firePlaying(r.vb);
    expect(stub.callsOf(r.va).filter((c) => c === "play").length).toBe(playsBefore);
    expect(r.va.paused).toBe(true);
  });

  it("the watchdog treats a master that presents nothing for max(750 ms, 3 frame periods / rate) as a stall", () => {
    const r = rig();
    r.t.play();
    show(r.va, 5);
    vi.advanceTimersByTime(749);
    expect(r.t.getState().stalled).toBeNull();
    vi.advanceTimersByTime(2);
    expect(r.t.getState().stalled).toBe("a");
    expect(r.vb.paused).toBe(true);
  });

  it("the watchdog period grows for a slow film: 3 frame periods at 5 fps is 600 ms (floor wins), at 2 fps 1500 ms", () => {
    const slow: Rational = { num: 2, den: 1 };
    const r = rig({ fpsA: slow, fpsB: slow, nA: 20, nB: 20 });
    r.t.play();
    vi.advanceTimersByTime(1400);
    expect(r.t.getState().stalled).toBeNull();
    vi.advanceTimersByTime(150);
    expect(r.t.getState().stalled).toBe("a");
  });

  it("bounded recovery: two failed recoveries within 10 s stop playback with a notice", () => {
    const r = rig();
    r.t.play();
    show(r.va, 3);
    vi.advanceTimersByTime(800);             // failure 1: stall on A
    expect(r.t.getState().stalled).toBe("a");
    stub.firePlaying(r.va);                  // resumes
    expect(r.t.getState().stalled).toBeNull();
    expect(r.vb.paused).toBe(false);
    vi.advanceTimersByTime(800);             // failure 2 inside the window
    expect(r.t.getState()).toMatchObject({ playing: false, blocked: "recovery", stalled: null });
    expect(r.va.paused).toBe(true);
    expect(r.vb.paused).toBe(true);
  });

  it("a stall right after a resume counts as a failed recovery; a stall long after does not", () => {
    const r = rig();
    r.t.play();
    show(r.va, 3);
    stub.fireWaiting(r.va);                  // first stall: not a failure
    stub.firePlaying(r.va);
    vi.advanceTimersByTime(100);
    stub.fireWaiting(r.va);                  // failure 1
    expect(r.t.getState().stalled).toBe("a");
    stub.firePlaying(r.va);
    vi.advanceTimersByTime(100);
    show(r.va, 4);
    stub.fireWaiting(r.va);                  // failure 2
    expect(r.t.getState()).toMatchObject({ blocked: "recovery", playing: false });
  });

  it("failures older than the window are forgotten", () => {
    const r = rig({ nA: 1000, nB: 1000 });
    r.t.play();
    show(r.va, 3);
    vi.advanceTimersByTime(800);             // watchdog failure 1
    stub.firePlaying(r.va);
    for (let f = 4; f < 4 + 110; f++) { show(r.va, f); show(r.vb, f); vi.advanceTimersByTime(100); } // healthy playback for 11 s
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(r.t.getState().blocked).toBeNull();
    expect(RECOVERY_WINDOW_MS).toBe(10_000);
    show(r.va, 200);
    vi.advanceTimersByTime(800);
    expect(r.t.getState()).toMatchObject({ blocked: null, stalled: "a", playing: true });
  });
});

describe("CompareTransport: gestures, visibility and unexpected stops (#741 7b)", () => {
  it("a NotAllowedError on a non-gesture play pauses both and sets blocked", async () => {
    const r = rig({ offset: 10 });
    r.t.play();
    stub.rejectNextPlay("NotAllowedError", r.vb);
    show(r.va, 10);                          // B enters its window: a non-gesture play()
    await vi.advanceTimersByTimeAsync(0);
    expect(r.t.getState()).toMatchObject({ playing: false, blocked: "gesture" });
    expect(r.va.paused).toBe(true);
    expect(r.vb.paused).toBe(true);
    // Play again (a gesture) clears it
    r.t.play();
    expect(r.t.getState()).toMatchObject({ playing: true, blocked: null });
  });

  it("a NotAllowedError on a stall resume blocks as well", async () => {
    const r = rig();
    r.t.play();
    show(r.va, 10);
    stub.fireWaiting(r.vb);
    stub.rejectNextPlay("NotAllowedError", r.va);
    stub.firePlaying(r.vb);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.t.getState()).toMatchObject({ playing: false, blocked: "gesture" });
  });

  it("an AbortError is not a block", async () => {
    const r = rig({ offset: 10 });
    r.t.play();
    stub.rejectNextPlay("AbortError", r.vb);
    show(r.va, 10);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.t.getState().blocked).toBeNull();
  });

  it("a hidden document pauses both and leaves them paused on return", () => {
    const r = rig();
    r.t.play();
    show(r.va, 8);
    r.doc.visibilityState = "hidden";
    r.doc.dispatchEvent(new Event("visibilitychange"));
    expect(r.t.getState()).toMatchObject({ playing: false, frame: 8 });
    expect(r.va.paused).toBe(true);
    expect(r.vb.paused).toBe(true);
    r.doc.visibilityState = "visible";
    r.doc.dispatchEvent(new Event("visibilitychange"));
    expect(r.va.paused).toBe(true);
    expect(r.t.getState().playing).toBe(false);
  });

  it("a note post confirming a frame on A pauses and realigns B and never seeks A", async () => {
    const r = rig({ offset: 5 });
    r.t.play();
    show(r.va, 20); land(r.vb, 15, F25);
    stub.writes.length = 0;
    const confirmed = r.ca.awaitConfirmedFrame();
    expect(r.t.getState()).toMatchObject({ playing: false, frame: 20 });
    expect(r.vb.paused).toBe(true);
    // A: only the clock's own confirmation seek. B: realigned to the mapped frame.
    expect(stub.writes.filter((w) => w === seekAt(20))).toHaveLength(1);
    expect(r.vb.currentTime).toBe(seekAt(15));
    expect(stub.writes).toHaveLength(2);
    land(r.va, 20, F25);
    await expect(confirmed).resolves.toBe(20);
    expect(r.t.getState().playing).toBe(false);
  });

  it("the same on B: A is paused and realigned, B is not seeked by the transport", () => {
    const r = rig({ offset: 5 });
    r.t.play();
    show(r.va, 20); land(r.vb, 15, F25);
    stub.writes.length = 0;
    r.cb.awaitConfirmedFrame().catch(() => {});
    expect(r.va.paused).toBe(true);
    expect(r.va.currentTime).toBe(seekAt(20));
    expect(stub.writes.filter((w) => w === seekAt(15))).toHaveLength(1);
    expect(stub.writes).toHaveLength(2);
  });

  it("the transport's own stops are not taken for unexpected ones", () => {
    const r = rig();
    r.t.play();
    show(r.va, 20); show(r.vb, 20);
    stub.writes.length = 0;
    r.t.pause();
    expect(stub.writes.filter((w) => w === seekAt(20))).toHaveLength(2);
    expect(stub.writes).toHaveLength(2);
    expect(r.t.getState().blocked).toBeNull();
  });
});

describe("CompareTransport: reverse (#741 7b)", () => {
  it("mutes both, waits for both sides to land before the next seek, restores sound, and stops at the domain start", () => {
    const r = rig();
    r.t.seekTo(10);
    land(r.va, 10, F25); land(r.vb, 10, F25);
    stub.writes.length = 0;
    r.t.reverse(1);
    expect(r.t.getState()).toMatchObject({ playing: true, rate: -1 });
    expect(r.va.muted).toBe(true);
    expect(r.vb.muted).toBe(true);
    vi.advanceTimersByTime(40);
    expect(r.va.currentTime).toBe(seekAt(9));
    expect(r.vb.currentTime).toBe(seekAt(9));
    expect(stub.writes).toHaveLength(2);
    // only A lands: still waiting
    land(r.va, 9, F25);
    vi.advanceTimersByTime(400);
    expect(stub.writes).toHaveLength(2);
    land(r.vb, 9, F25);
    vi.advanceTimersByTime(40);
    expect(stub.writes.length).toBeGreaterThan(2);
    expect(r.va.currentTime).toBeLessThan(seekAt(9));
    // run it out
    for (let i = 0; i < 40 && r.t.getState().playing; i++) {
      land(r.va, Math.round(r.va.currentTime * 25 - 0.5), F25);
      land(r.vb, Math.round(r.vb.currentTime * 25 - 0.5), F25);
      vi.advanceTimersByTime(40);
    }
    expect(r.t.getState()).toMatchObject({ playing: false, frame: 0 });
    expect(r.va.currentTime).toBe(seekAt(0));
    expect(r.va.muted).toBe(false);
    expect(r.vb.muted).toBe(true);
  });

  it("does nothing at the domain start, and Pause ends a reverse and restores sound", () => {
    const r = rig();
    r.t.reverse(1);
    expect(r.t.getState().playing).toBe(false);
    r.t.seekTo(20);
    land(r.va, 20, F25); land(r.vb, 20, F25);
    r.t.reverse(2);
    expect(r.va.muted).toBe(true);
    r.t.pause();
    expect(r.t.getState()).toMatchObject({ playing: false, rate: 0 });
    expect(r.va.muted).toBe(false);
    expect(r.vb.muted).toBe(true);
  });
});

describe("CompareTransport: lifetime (#741 7b)", () => {
  it("dispose pauses both and removes every listener", () => {
    const r = rig();
    r.t.play();
    show(r.va, 5);
    const heard = vi.fn();
    r.t.subscribe(heard);
    r.t.dispose();
    expect(r.va.paused).toBe(true);
    expect(r.vb.paused).toBe(true);
    heard.mockClear();
    const calls = stub.callsOf(r.va).length + stub.callsOf(r.vb).length;
    show(r.va, 6);
    stub.fireWaiting(r.vb);
    stub.firePlaying(r.vb);
    r.doc.visibilityState = "hidden";
    r.doc.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(5000);
    expect(heard).not.toHaveBeenCalled();
    expect(stub.callsOf(r.va).length + stub.callsOf(r.vb).length).toBe(calls);
    r.t.play();
    expect(stub.callsOf(r.va).length + stub.callsOf(r.vb).length).toBe(calls);
  });

  it("notifies subscribers on change and returns a stable state otherwise", () => {
    const r = rig();
    const heard = vi.fn();
    const off = r.t.subscribe(heard);
    const before = r.t.getState();
    r.t.step(0);
    expect(r.t.getState()).toBe(before);
    r.t.step(1);
    expect(heard).toHaveBeenCalled();
    off();
  });
});

describe("CompareTransport: sol review round 1 (#741 7b)", () => {
  it("an ended master finishes or hands off from its terminal frame; it is never replayed", () => {
    const r = rig({ nA: 100, nB: 150 });
    r.t.play();
    show(r.va, 98);
    stub.endPlayback(r.va); // the element ends before the last frame is ever reported by rVFC
    expect(stub.callsOf(r.va).filter((c) => c === "play")).toHaveLength(1);
    expect(r.va.paused).toBe(true);
    expect(r.t.getState()).toMatchObject({ playing: true, master: "b", frame: 99 });
    expect(r.t.getState().phases.a).toBe("last");
    show(r.vb, 100);
    expect(stub.callsOf(r.va).filter((c) => c === "play")).toHaveLength(1);
  });

  it("an ended master that is also the shared end stops the transport", () => {
    const r = rig();
    r.t.play();
    show(r.va, 98);
    stub.endPlayback(r.va);
    expect(r.t.getState()).toMatchObject({ playing: false, frame: 99 });
    expect(r.vb.paused).toBe(true);
  });

  it("a master change releases the actual rate trim, not only the bookkeeping", () => {
    const r = rig();
    r.t.play();
    for (const f of [1, 2, 3]) { stub.presentFrame(r.vb, 0.2); show(r.va, f); }
    expect(r.vb.playbackRate).toBeCloseTo(0.95);
    r.t.setAudible("b");
    expect(r.t.getState().master).toBe("b");
    expect(r.vb.playbackRate).toBe(1);
    expect(r.va.playbackRate).toBe(1);
  });

  it("a frame confirmation during reverse stops the reverse and never seeks the confirming side", () => {
    const r = rig({ offset: 5 });
    r.t.seekTo(10);
    land(r.va, 10, F25); land(r.vb, 5, F25);
    r.t.reverse(1);
    stub.writes.length = 0;
    r.ca.awaitConfirmedFrame().catch(() => {});
    expect(r.t.getState()).toMatchObject({ playing: false, rate: 0, frame: 10 });
    expect(r.va.muted).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(stub.writes).toEqual([]);
    expect(r.t.getState().frame).toBe(10);
  });

  it("confirming an already paused side during the other side's stall cancels the auto-resume and aligns only the other side", () => {
    const r = rig({ offset: 5 });
    r.t.play();
    show(r.va, 10);
    land(r.vb, 5, F25);
    stub.fireWaiting(r.vb);
    expect(r.t.getState().stalled).toBe("b");
    land(r.va, 10, F25);
    stub.writes.length = 0;
    r.ca.awaitConfirmedFrame().catch(() => {});
    expect(r.t.getState()).toMatchObject({ playing: false, stalled: null, frame: 10 });
    expect(stub.writes.filter((w) => w === seekAt(10))).toEqual([]);
    expect(r.vb.paused).toBe(true);
    const plays = stub.callsOf(r.va).filter((c) => c === "play").length;
    stub.firePlaying(r.vb);
    expect(stub.callsOf(r.va).filter((c) => c === "play")).toHaveLength(plays);
    expect(r.va.paused).toBe(true);
    expect(r.t.getState().playing).toBe(false);
  });

  it("one watchdog trip after a recovery counts once: it does not block; two within 10 s do", () => {
    const r = rig();
    r.t.play();
    show(r.va, 3);
    stub.fireWaiting(r.va);        // a stall that is not yet a failure
    stub.firePlaying(r.va);        // recovered
    vi.advanceTimersByTime(800);   // one watchdog trip, inside the resume grace window
    expect(r.t.getState()).toMatchObject({ blocked: null, stalled: "a", playing: true });
    stub.firePlaying(r.va);
    vi.advanceTimersByTime(800);   // a second failed recovery inside 10 s
    expect(r.t.getState()).toMatchObject({ blocked: "recovery", playing: false });
  });
});

describe("CompareTransport: sol review round 2 (#741 7b)", () => {
  it("an ended side is never the master even where the frame mapping still labels it live (25 fps A, 60 fps audible B)", () => {
    const F60: Rational = { num: 60, den: 1 };
    const r = rig({ fpsB: F60, nB: 60, audible: "b" });
    r.t.play();
    expect(r.t.getState().master).toBe("b");
    show(r.vb, 58, F60);
    stub.endPlayback(r.vb);
    expect(r.t.getState()).toMatchObject({ master: "a", playing: true });
    expect(r.vb.paused).toBe(true);
    show(r.va, 30);
    expect(r.t.getState().frame).toBe(30);
    expect(stub.callsOf(r.vb).filter((c) => c === "play")).toHaveLength(1);
  });

  for (const order of ["transport before metadata", "transport after metadata"] as const) {
    it(`entry position survives: A opens at frame 40 (${order})`, () => {
      stub = installVideoElementStub({ rvfc: true });
      const va = document.createElement("video");
      const vb = document.createElement("video");
      const ca = new VideoFrameClock(va, { fps: F25, frameCount: 100 }, { initialFrame: 40 });
      const cb = new VideoFrameClock(vb, { fps: F25, frameCount: 100 }, { initialFrame: 40 });
      clocks = [ca, cb];
      const store = createCompareStore("t");
      store.setPair("A", "B");
      const build = () => new CompareTransport({ a: { clock: ca, video: va, fps: F25, frameCount: 100, hasAudio: true }, b: { clock: cb, video: vb, fps: F25, frameCount: 100, hasAudio: true }, store, now: () => Date.now(), document: Object.assign(new EventTarget(), { visibilityState: "visible" as const }) });
      if (order === "transport before metadata") transport = build();
      for (const v of [va, vb]) { stub.loadMetadata(v, { duration: 4 }); stub.setReadyState(v, 4); stub.finishSeek(v); stub.presentFrame(v, 40 / 25); }
      if (order === "transport after metadata") transport = build();
      expect(transport!.getState().frame).toBe(40);
      stub.writes.length = 0;
      transport!.play();
      expect(stub.writes).toEqual([]);
      expect(va.currentTime).toBe(seekAt(40));
      expect(transport!.getState().frame).toBe(40);
    });
  }

  it("an explicit initialA wins over a clock that has not reported yet", () => {
    stub = installVideoElementStub({ rvfc: true });
    const va = document.createElement("video");
    const vb = document.createElement("video");
    const ca = new VideoFrameClock(va, { fps: F25, frameCount: 100 });
    const cb = new VideoFrameClock(vb, { fps: F25, frameCount: 100 });
    clocks = [ca, cb];
    const store = createCompareStore("t");
    store.setPair("A", "B");
    transport = new CompareTransport({ a: { clock: ca, video: va, fps: F25, frameCount: 100, hasAudio: true }, b: { clock: cb, video: vb, fps: F25, frameCount: 100, hasAudio: true }, store, initialA: 33, now: () => Date.now(), document: Object.assign(new EventTarget(), { visibilityState: "visible" as const }) });
    expect(transport.getState().frame).toBe(33);
  });

  it("muting promotes the other master and releases the follower's trim at the ladder rate", () => {
    const r = rig({ audible: "b" });
    r.t.play(2);
    expect(r.t.getState().master).toBe("b");
    for (const f of [1, 2, 3]) { stub.presentFrame(r.va, 0.2 + f / 25); show(r.vb, f); } // A (the follower) runs ahead
    expect(r.va.playbackRate).toBeCloseTo(1.9);
    r.t.setMuted(true);
    expect(r.t.getState().master).toBe("a");
    expect(r.va.playbackRate).toBe(2);
    expect(r.vb.playbackRate).toBe(2);
  });
});

describe("CompareTransport: sol review round 3 (#741 7b)", () => {
  it("Home then Play with a 25 fps A, a 60 fps B and offset -1 starts something", () => {
    const F60: Rational = { num: 60, den: 1 };
    const r = rig({ fpsB: F60, nB: 240, offset: -1 });
    r.t.home();
    land(r.va, 0, F25); land(r.vb, 0, F60);
    expect(Object.values(r.t.getState().phases)).toContain("live");
    r.t.play();
    expect(r.t.getState().playing).toBe(true);
    expect(r.va.paused && r.vb.paused).toBe(false);
  });

  it("play() with no live side stays paused instead of reporting playing", () => {
    const r = rig({ nA: 1, nB: 1 });
    r.t.play();
    expect(r.t.getState().playing).toBe(false);
    expect(r.va.paused && r.vb.paused).toBe(true);
  });

  it("reverse keeps advancing when a paired seek is a no-op (50 fps A, 25 fps B, offset -10)", () => {
    const F50b: Rational = { num: 50, den: 1 };
    const r = rig({ fpsA: F50b, fpsB: F25, nA: 100, nB: 50, offset: -10 });
    r.t.seekTo(-17);
    land(r.va, 0, F50b); land(r.vb, 1, F25);
    expect(r.t.getState().frame).toBe(-17);
    r.t.reverse(1);
    vi.advanceTimersByTime(60); // -18 maps to the same frames: nothing to land
    expect(r.t.getState().frame).toBeLessThan(-17);
    vi.advanceTimersByTime(60);
    expect(r.t.getState().frame).toBeLessThan(-18);
  });

  it("reverse ends at once when the final landing at the domain start is a no-op", () => {
    const F50b: Rational = { num: 50, den: 1 };
    const r = rig({ fpsA: F50b, fpsB: F25, nA: 100, nB: 50, offset: -10 });
    const start = r.t.getState().domain.start;
    r.t.seekTo(start + 1);
    land(r.va, 0, F50b); land(r.vb, 0, F25);
    stub.writes.length = 0;
    r.t.reverse(1);
    vi.advanceTimersByTime(100);
    expect(stub.writes).toEqual([]);
    expect(r.t.getState()).toMatchObject({ playing: false, rate: 0, frame: start });
    expect(r.va.muted).toBe(false);
  });
});
