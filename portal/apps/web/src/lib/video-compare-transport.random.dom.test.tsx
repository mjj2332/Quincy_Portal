import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Rational } from "@quincy/shared";
import { installVideoElementStub, type VideoElementStub } from "../testing/video-element";
import { VideoFrameClock } from "./video-frame-clock";
import { CompareTransport, type CompareTransportState } from "./video-compare-transport";
import { createCompareStore } from "./video-compare-store";

/** Seeded random event sequences against two stubbed elements (#741 7b): the invariants must hold after every event. */
function prng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const r25: Rational = { num: 25, den: 1 };
const r50: Rational = { num: 50, den: 1 };
const r60: Rational = { num: 60, den: 1 };
const r2997: Rational = { num: 30000, den: 1001 };
const CONFIGS = [
  { name: "25/100 vs 25/100", fpsA: r25, nA: 100, fpsB: r25, nB: 100, offset: 0 },
  { name: "25/100 vs 60/150, -3", fpsA: r25, nA: 100, fpsB: r60, nB: 150, offset: -3 },
  { name: "50/120 vs 25/60, +10", fpsA: r50, nA: 120, fpsB: r25, nB: 60, offset: 10 },
  { name: "25/100 vs 25/200", fpsA: r25, nA: 100, fpsB: r25, nB: 200, offset: 0 },
  { name: "29.97/80 vs 25/100, +5", fpsA: r2997, nA: 80, fpsB: r25, nB: 100, offset: 5 },
];
const SEEDS = 40;
const EVENTS = 140;

let stub: VideoElementStub;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { stub?.dispose(); vi.useRealTimers(); });

async function run(config: (typeof CONFIGS)[number], seed: number) {
  const rand = prng(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  // Odd seeds deliver the events play() / pause() / a seek cause later, interleaved with everything else, as a browser does.
  stub = installVideoElementStub({ rvfc: true, asyncEvents: seed % 2 === 1 });
  const videos = { a: document.createElement("video"), b: document.createElement("video") };
  const fps = { a: config.fpsA, b: config.fpsB };
  const counts = { a: config.nA, b: config.nB };
  const clocks = {
    a: new VideoFrameClock(videos.a, { fps: config.fpsA, frameCount: config.nA }),
    b: new VideoFrameClock(videos.b, { fps: config.fpsB, frameCount: config.nB }),
  };
  for (const side of ["a", "b"] as const) {
    stub.loadMetadata(videos[side], { duration: (counts[side] * fps[side].den) / fps[side].num });
    stub.setReadyState(videos[side], 4);
    stub.finishSeek(videos[side]);
    stub.presentFrame(videos[side], 0);
  }
  const store = createCompareStore("rand");
  store.setPair("A", "B");
  store.setOffset(config.offset);
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as const });
  const t = new CompareTransport({ a: { clock: clocks.a, video: videos.a, fps: config.fpsA, frameCount: config.nA, hasAudio: true }, b: { clock: clocks.b, video: videos.b, fps: config.fpsB, frameCount: config.nB, hasAudio: true }, store, now: () => Date.now(), document: doc });

  const log: string[] = [];
  const present = (side: "a" | "b", frame: number) => stub.presentFrame(videos[side], (frame * fps[side].den) / fps[side].num);
  type Kind = { name: string; passive: boolean; run: () => void };
  const kinds: Kind[] = [
    { name: "tick", passive: true, run: () => {
      const side = pick(["a", "b"] as const);
      const v = videos[side];
      if (v.paused) return;
      if (v.seeking) { stub.finishSeek(v); present(side, clocks[side].getState().targetFrame ?? clocks[side].getState().frame); return; }
      const jitter = pick([0, 1, 1, 1, 2, -1]);
      const frame = Math.max(0, Math.min(clocks[side].lastFrame(), clocks[side].getState().frame + jitter));
      present(side, frame);
    } },
    { name: "land", passive: true, run: () => {
      for (const side of ["a", "b"] as const) {
        const v = videos[side];
        if (v.seeking) { stub.finishSeek(v); present(side, clocks[side].getState().targetFrame ?? clocks[side].getState().frame); }
      }
    } },
    { name: "oldFrame", passive: true, run: () => {
      // A late presentation of the OLD position while a seek is still in flight.
      const side = pick(["a", "b"] as const);
      const v = videos[side];
      if (!v.seeking) return;
      present(side, Math.max(0, Math.min(clocks[side].lastFrame(), clocks[side].getState().frame + pick([-1, 0, 1, 2]))));
    } },
    { name: "deliver", passive: true, run: () => { stub.deliverEvents(pick([1, 2, 3, 100]), rand() < 0.5 ? videos[pick(["a", "b"] as const)] : undefined); } },
    { name: "finishSide", passive: true, run: () => {
      const side = pick(["a", "b"] as const);
      const v = videos[side];
      if (v.paused || v.seeking) return;
      present(side, clocks[side].lastFrame());
      stub.endPlayback(v);
    } },
    { name: "error", passive: true, run: () => {
      const side = pick(["a", "b"] as const);
      stub.fireError(videos[side]);
      videos[side].pause();
    } },
    { name: "reverse", passive: false, run: () => { t.reverse(pick([1, 2])); } },
    { name: "waiting", passive: true, run: () => { stub.fireWaiting(videos[pick(["a", "b"] as const)]); } },
    { name: "playing", passive: true, run: () => { const s = pick(["a", "b"] as const); stub.setReadyState(videos[s], 4); stub.firePlaying(videos[s]); } },
    { name: "readyState", passive: true, run: () => { stub.setReadyState(videos[pick(["a", "b"] as const)], pick([1, 2, 4])); } },
    { name: "ended", passive: true, run: () => {
      const side = pick(["a", "b"] as const);
      const v = videos[side];
      if (v.paused || v.seeking || clocks[side].getState().frame < clocks[side].lastFrame() - 1) return;
      present(side, clocks[side].lastFrame());
      stub.endPlayback(v);
    } },
    { name: "wait", passive: true, run: () => { vi.advanceTimersByTime(pick([50, 300, 800, 1200])); } },
    { name: "audible", passive: false, run: () => { t.setAudible(pick(["a", "b"] as const)); } },
    { name: "mute", passive: false, run: () => { t.setMuted(rand() < 0.5); } },
    { name: "play", passive: false, run: () => { t.play(pick([1, 1, 2])); } },
    { name: "pause", passive: false, run: () => { t.pause(); } },
    { name: "step", passive: false, run: () => { t.step(pick([-3, -1, 1, 1, 5])); } },
    { name: "seekTo", passive: false, run: () => { const d = t.getState().domain; t.seekTo(d.start + Math.floor(rand() * (d.end - d.start + 1))); } },
    { name: "seekSide", passive: false, run: () => { const side = pick(["a", "b"] as const); t.seekSide(side, Math.floor(rand() * counts[side])); } },
    { name: "rejectPlay", passive: false, run: () => { stub.rejectNextPlay("NotAllowedError"); } },
  ];
  const weights = [10, 6, 2, 4, 1, 1, 1, 2, 3, 1, 2, 3, 1, 1, 3, 1, 1, 1, 1, 1];

  let prev: CompareTransportState = t.getState();
  for (let i = 0; i < EVENTS; i++) {
    let n = rand() * weights.reduce((x, y) => x + y, 0);
    let kind = kinds[0]!;
    for (let k = 0; k < kinds.length; k++) { n -= weights[k]!; if (n < 0) { kind = kinds[k]!; break; } }
    log.push(kind.name);
    kind.run();
    await vi.advanceTimersByTimeAsync(0);
    const now = t.getState();
    const where = `${config.name} seed ${seed} event ${i} (${log.slice(-8).join(", ")}) state ${JSON.stringify(now)}`;
    if (now.playing && now.rate > 0) {
      for (const side of ["a", "b"] as const) {
        if (now.phases[side] !== "live" && now.stalled !== side) expect(videos[side].paused, `${side} is ${now.phases[side]} but un-paused: ${where}`).toBe(true);
      }
      // A native stop whose event has not arrived yet cannot be known to the transport.
      if (stub.pendingEvents() === 0) expect(videos.a.paused && videos.b.paused && now.stalled === null, `playing with nothing running: ${where}`).toBe(false);
    }
    if (!now.playing) expect(videos.a.paused && videos.b.paused, `not playing but an element runs: ${where}`).toBe(true);
    expect([videos.a, videos.b].filter((v) => !v.muted).length, `more than one unmuted: ${where}`).toBeLessThanOrEqual(1);
    if (kind.passive && prev.playing && now.playing && prev.rate > 0 && now.rate > 0) expect(now.frame, `position went back: ${where}`).toBeGreaterThanOrEqual(prev.frame);
    prev = now;
  }
  t.dispose();
  clocks.a.dispose(); clocks.b.dispose();
  stub.dispose();
}

describe("CompareTransport invariants under random event sequences (#741 7b)", () => {
  for (const config of CONFIGS) {
    it(config.name, async () => {
      for (let seed = 1; seed <= SEEDS; seed++) await run(config, seed);
    });
  }
});
