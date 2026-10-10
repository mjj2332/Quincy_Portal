import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject } from "react";
import { bOf, compareDomain, phase, type Rational } from "@quincy/shared";
import { CompareTransport, type CompareTransportState } from "./video-compare-transport";
import { offsetOf, type CompareStore } from "./video-compare-store";
import type { VideoFrameClock } from "./video-frame-clock";

/** What one side hands up once its `<video>` and clock exist. */
export type CompareSideHandle = {
  video: HTMLVideoElement;
  clock: VideoFrameClock;
  fps: Rational;
  frameCount: number;
  hasAudio: boolean;
};

const noopSubscribe = () => () => {};

/**
 * Builds the `CompareTransport` over two sides (#741 7c) and re-renders on its state. It exists only while both sides do: a side that
 * is swapped for another Version (a new stage, a new clock) disposes the transport and builds a new one, which starts at the position
 * the old one reached and pauses (so the position is clamped into the new domain and both sides land on it). `position` carries that
 * position across, and the view reads it to place a stage that is mounting. Before the transport exists the state is a paused stand-in
 * on `position`, so the controls render.
 */
export function useCompareTransport({ a, b, store, position, fpsA, fpsB, countA, countB }: {
  a: CompareSideHandle | null;
  b: CompareSideHandle | null;
  store: CompareStore;
  /** The shared position (A's frame), read when a transport is built and written whenever it moves. */
  position: MutableRefObject<number>;
  fpsA: Rational;
  fpsB: Rational;
  countA: number;
  countB: number;
}): { transport: CompareTransport | null; state: CompareTransportState } {
  const [transport, setTransport] = useState<CompareTransport | null>(null);
  const builtOnce = useRef(false);
  useEffect(() => {
    if (!a || !b) { setTransport(null); return; }
    const made = new CompareTransport({
      a: { clock: a.clock, video: a.video, fps: a.fps, frameCount: a.frameCount, hasAudio: a.hasAudio },
      b: { clock: b.clock, video: b.video, fps: b.fps, frameCount: b.frameCount, hasAudio: b.hasAudio },
      store,
      initialA: position.current,
    });
    // A rebuilt transport (a side was swapped): clamp the position into the new domain and land both sides on it, paused.
    if (builtOnce.current) made.pause();
    builtOnce.current = true;
    position.current = made.getState().frame;
    const off = made.subscribe(() => { position.current = made.getState().frame; });
    setTransport(made);
    return () => { off(); position.current = made.getState().frame; made.dispose(); };
  }, [a, b, store, position]);

  const offset = useSyncExternalStore(store.subscribe, () => offsetOf(store.getState()));
  const standIn = useMemo<CompareTransportState>(() => {
    const domain = compareDomain({ fps: fpsA, frameCount: countA }, { fps: fpsB, frameCount: countB }, offset);
    const frame = Math.min(domain.end, Math.max(domain.start, position.current));
    return {
      frame, playing: false, rate: 0, master: "a", stalled: null, blocked: null, domain, offset,
      phases: { a: phase(frame, countA - 1), b: phase(bOf(frame, offset, fpsA, fpsB), countB - 1) },
    };
  }, [fpsA, fpsB, countA, countB, offset, position]);

  const state = useSyncExternalStore(transport?.subscribe ?? noopSubscribe, transport?.getState ?? (() => standIn), () => standIn);
  return { transport, state };
}
