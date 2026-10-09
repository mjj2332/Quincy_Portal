import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { frameAtPresentationTime, frameContainingTime, frameSeekSeconds, type Rational } from "@quincy/shared";

/** How long a settled seek waits for the browser to present the frame before the playhead is trusted instead. */
const CONFIRM_FALLBACK_MS = 250;

export type FrameClockVersion = Readonly<{ fps: Rational; frameCount: number }>;

/** What is on screen and what is on its way. `rate` is signed: 0 paused, negative the emulated reverse shuttle. */
export type FrameClockState = Readonly<{
  /** The last frame known to be on screen: reported by `requestVideoFrameCallback`, else derived from the playhead. */
  frame: number;
  /** A seek or step in flight, or null once `frame` is the one on screen. */
  targetFrame: number | null;
  /** True once the browser has shown the frame the last seek asked for. */
  confirmed: boolean;
  playing: boolean;
  rate: number;
}>;

type FrameMetadata = { mediaTime: number };
type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: FrameMetadata) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};
type Reverse = { base: number; startedAt: number; speed: number; final: boolean };

/**
 * A frame-accurate clock over one `<video>` (#741 4d-ii). The element only knows seconds; a reviewer works in frames, so every
 * seek goes to the MIDDLE of the wanted frame (`frameSeekSeconds`) and the frame on screen is read back from the presentation
 * time of the frame the browser actually composited (`requestVideoFrameCallback`), falling back to the playhead where that is
 * missing. Steps made while a seek is still in flight only move the target, so key repeat issues one seek per landing, never a
 * storm. Reverse play does not exist in browsers, so it is emulated by seeking backward, one seek at a time, muted.
 *
 * It is a plain object (not hook state) so the player, the shortcut handler and later slices (notes, markup, compare) share one
 * clock and tests drive it without React.
 */
export class VideoFrameClock {
  private state: FrameClockState = { frame: 0, targetFrame: null, confirmed: false, playing: false, rate: 0 };
  private readonly listeners = new Set<() => void>();
  private readonly hasRvfc: boolean;
  private readonly now: () => number;
  private readonly fps: Rational;
  private readonly frameCount: number;
  /** The frame the last seek was asked for, and the one actually written to `currentTime`. */
  private target: number | null = null;
  private issued: number | null = null;
  private presented = false;
  private reverseState: Reverse | null = null;
  private mutedPref: boolean | null = null;
  private waiters: Array<{ resolve: (frame: number) => void; reject: (reason: unknown) => void }> = [];
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  private reverseTimer: ReturnType<typeof setTimeout> | null = null;
  private rvfcHandle: number | null = null;
  private rafHandle: number | null = null;
  private disposed = false;

  constructor(private readonly video: HTMLVideoElement, version: FrameClockVersion, options: { now?: () => number } = {}) {
    this.fps = version.fps;
    this.frameCount = version.frameCount;
    this.now = options.now ?? (() => performance.now());
    this.hasRvfc = typeof (video as FrameVideo).requestVideoFrameCallback === "function";
    for (const [name, handler] of this.handlers) video.addEventListener(name, handler);
    if (this.hasRvfc) this.register();
    if (video.readyState >= 1) this.seek(0, true);
  }

  getState = (): FrameClockState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Seeks to `frame` (clamped to the film), stopping any playback. */
  seekToFrame(frame: number): void { this.seek(frame, false); }

  /** Moves `delta` frames from the frame on its way, or the one on screen. Stepping past either end does nothing. */
  step(delta: number): void {
    const base = this.state.targetFrame ?? this.state.frame;
    const target = this.clamp(base + delta);
    if (target === base) return;
    this.seek(target, false);
  }

  /** Pauses (if playing) and resolves with the frame once the browser has shown it: what a note or a drawing must anchor to. */
  awaitConfirmedFrame(): Promise<number> {
    if (this.state.playing) this.pause();
    if (this.state.confirmed && this.target === null && !this.video.seeking) return Promise.resolve(this.state.frame);
    return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }); });
  }

  /** Plays forward at 1x; from the last frame, restarts from frame 0. */
  play(): void { this.setRate(1); }

  /** Plays forward at `rate` (1, 2, 4, 8). */
  setRate(rate: number): void {
    this.endReverse();
    if (this.state.frame >= this.lastFrame()) {
      this.target = 0; this.issued = 0; this.presented = false;
      this.video.currentTime = frameSeekSeconds(0, this.fps);
      this.state = { ...this.state, frame: 0, targetFrame: 0, confirmed: false };
    }
    this.video.playbackRate = rate;
    // Before metadata the element cannot play, and the initial seek's pause() would abort this play() (AbortError) and flip the state back: `initialize` starts it.
    if (this.video.readyState >= 1) this.startPlayback();
    this.set({ playing: true, rate });
    this.startRaf();
  }

  private startPlayback(): void {
    const started = this.video.play() as Promise<void> | undefined;
    // An AbortError means a pause or a newer load superseded this play(): the state already says so. Anything else (NotAllowedError) means it never started.
    if (started && typeof started.catch === "function") started.catch((error: unknown) => { if (!this.disposed && (error as { name?: string } | null)?.name !== "AbortError") this.set({ playing: false, rate: 0 }); });
  }

  /** Pauses and confirms the frame left on screen. */
  pause(): void {
    const moving = this.state.playing;
    const confirmFrame = this.reverseState ? (this.target ?? this.state.frame) : this.state.frame;
    this.halt();
    if (moving) this.seek(confirmFrame, true);
  }

  /** Emulated reverse at `speed` (1, 2, 4, 8): muted, serialized backward seeks, stopping at frame 0. */
  reverse(speed: number): void {
    const base = this.target ?? this.state.frame;
    if (base <= 0) return;
    if (!this.reverseState) {
      this.video.pause();
      this.mutedPref = this.video.muted;
      this.video.muted = true;
    }
    this.clearReverseTimer();
    this.reverseState = { base, startedAt: this.now(), speed, final: false };
    this.set({ playing: true, rate: -speed });
    this.scheduleTick();
  }

  /** The user's mute choice. While a reverse runs the element stays muted and the choice is applied when it ends. */
  setMuted(muted: boolean): void {
    if (this.reverseState) this.mutedPref = muted;
    else this.video.muted = muted;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [name, handler] of this.handlers) this.video.removeEventListener(name, handler);
    if (this.rvfcHandle !== null) (this.video as FrameVideo).cancelVideoFrameCallback?.(this.rvfcHandle);
    this.rvfcHandle = null;
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
    this.clearConfirmTimer();
    this.clearReverseTimer();
    if (this.mutedPref !== null) { this.video.muted = this.mutedPref; this.mutedPref = null; }
    this.reverseState = null;
    // A media element taken out of the page keeps playing (sound and all) until it is collected.
    if (!this.video.paused) this.video.pause();
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.reject(new DOMException("The frame clock was disposed", "AbortError"));
  }

  // --- internals ---

  private readonly handlers: ReadonlyArray<readonly [string, () => void]> = [
    ["loadedmetadata", () => { this.initialize(); }],
    ["seeked", () => { this.onSeeked(); }],
    ["timeupdate", () => { if (!this.hasRvfc && this.target === null && !this.video.seeking && !this.reverseState) this.set({ frame: this.timeFrame() }); }],
    ["ended", () => { this.onEnded(); }],
    ["pause", () => { if (this.state.playing && !this.reverseState && !this.disposed) this.set({ playing: false, rate: 0 }); }],
    ["play", () => { if (!this.state.playing && !this.reverseState && !this.disposed) { this.set({ playing: true, rate: this.video.playbackRate || 1 }); this.startRaf(); } }],
  ];

  private set(next: Partial<FrameClockState>): void {
    const merged = { ...this.state, ...next };
    if (merged.frame === this.state.frame && merged.targetFrame === this.state.targetFrame && merged.confirmed === this.state.confirmed && merged.playing === this.state.playing && merged.rate === this.state.rate) return;
    this.state = merged;
    for (const listener of [...this.listeners]) listener();
  }

  private lastFrame(): number {
    let last = this.frameCount - 1;
    const duration = this.video.duration;
    // Audio and video lengths can differ: never seek past what the element says it has.
    if (Number.isFinite(duration) && duration > 0) last = Math.min(last, Math.ceil((duration * this.fps.num) / this.fps.den - 1e-6) - 1);
    return Math.max(0, last);
  }

  private clamp(frame: number): number {
    if (!Number.isFinite(frame)) return 0;
    return Math.min(this.lastFrame(), Math.max(0, Math.trunc(frame)));
  }

  private timeFrame(): number { return this.clamp(frameContainingTime(this.video.currentTime, this.fps)); }

  private seek(frame: number, force: boolean): void {
    const target = this.clamp(frame);
    const wasMoving = this.state.playing;
    this.halt();
    if (!force && !wasMoving && target === this.state.frame && this.state.confirmed && this.target === null && !this.video.seeking) return;
    this.target = target;
    this.set({ targetFrame: target, confirmed: false });
    // A seek already in flight just has its target moved; `seeked` issues the one that matters.
    if (!this.video.seeking) this.issue();
  }

  /** Metadata arrived: paint frame 0, keeping a Play (or rate) asked for before the element could seek. */
  private initialize(): void {
    const { playing, rate } = this.state;
    const resume = playing && rate > 0 && !this.reverseState;
    this.seek(0, true);
    if (!resume || this.disposed) return;
    this.video.playbackRate = rate;
    this.startPlayback();
    this.set({ playing: true, rate });
    this.startRaf();
  }

  private issue(): void {
    if (this.target === null) return;
    this.issued = this.target;
    // Presentation evidence belongs to one seek: a frame shown before this write says nothing about the one it asks for.
    this.presented = false;
    this.video.currentTime = frameSeekSeconds(this.target, this.fps);
  }

  /** Stops playback and any reverse, leaving no seek of its own behind. */
  private halt(): void {
    if (this.state.playing && !this.video.paused) this.video.pause();
    this.endReverse();
    this.set({ playing: false, rate: 0 });
  }

  private onSeeked(): void {
    if (this.disposed) return;
    if (this.target !== null && this.issued !== this.target) { this.issue(); return; }
    if (this.reverseState) {
      if (!this.reverseState.final) { this.tick(); return; }
      this.endReverse();
    }
    if (this.target === null) { if (!this.hasRvfc) this.set({ frame: this.timeFrame() }); return; }
    if (!this.hasRvfc) { this.set({ frame: this.timeFrame() }); this.settle(); return; }
    if (this.presented && this.state.frame === this.target) { this.settle(); return; }
    this.clearConfirmTimer();
    this.confirmTimer = setTimeout(() => {
      this.confirmTimer = null;
      if (this.disposed || this.target === null || this.video.seeking) return;
      this.set({ frame: this.timeFrame() });
      this.settle();
    }, CONFIRM_FALLBACK_MS);
  }

  private settle(): void {
    this.clearConfirmTimer();
    this.target = null;
    this.set({ targetFrame: null, confirmed: true });
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.resolve(this.state.frame);
  }

  private onEnded(): void {
    if (this.disposed) return;
    this.endReverse();
    this.clearConfirmTimer();
    this.target = null;
    this.set({ frame: this.lastFrame(), targetFrame: null, confirmed: true, playing: false, rate: 0 });
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.resolve(this.state.frame);
  }

  private register(): void {
    const video = this.video as FrameVideo;
    this.rvfcHandle = video.requestVideoFrameCallback!((_now, metadata) => { this.onFrame(metadata); });
  }

  private onFrame(metadata: FrameMetadata): void {
    this.rvfcHandle = null;
    if (this.disposed) return;
    this.register();
    this.presented = true;
    const frame = this.clamp(frameAtPresentationTime(metadata.mediaTime, this.fps));
    // Only the frame the seek asked for settles it; a late callback from an intermediate seek just reports what is on screen.
    if (this.target !== null && this.issued === this.target && !this.video.seeking && !this.reverseState && frame === this.target) {
      this.set({ frame });
      this.settle();
      return;
    }
    this.set(this.target === null ? { frame, confirmed: true } : { frame });
  }

  private startRaf(): void {
    if (this.hasRvfc || this.rafHandle !== null) return;
    const loop = () => {
      this.rafHandle = null;
      if (this.disposed || !this.state.playing || this.reverseState) return;
      if (!this.video.seeking) this.set({ frame: this.timeFrame() });
      this.rafHandle = requestAnimationFrame(loop);
    };
    this.rafHandle = requestAnimationFrame(loop);
  }

  private clearConfirmTimer(): void {
    if (this.confirmTimer !== null) clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
  }

  private clearReverseTimer(): void {
    if (this.reverseTimer !== null) clearTimeout(this.reverseTimer);
    this.reverseTimer = null;
  }

  private endReverse(): void {
    if (!this.reverseState) return;
    this.clearReverseTimer();
    this.reverseState = null;
    if (this.mutedPref !== null) { this.video.muted = this.mutedPref; this.mutedPref = null; }
    this.set({ playing: false, rate: 0 });
  }

  private scheduleTick(): void {
    this.clearReverseTimer();
    this.reverseTimer = setTimeout(() => { this.reverseTimer = null; this.tick(); }, (1000 * this.fps.den) / this.fps.num);
  }

  /** One step of the reverse loop: seek to where the playhead would be by now, but only once the last seek has landed. */
  private tick(): void {
    const reverse = this.reverseState;
    if (!reverse || this.disposed || this.video.seeking) return;
    if (!this.hasRvfc) this.set({ frame: this.timeFrame() });
    const elapsed = this.now() - reverse.startedAt;
    const want = reverse.base - Math.round((reverse.speed * elapsed * this.fps.num) / (1000 * this.fps.den));
    const current = this.target ?? this.state.frame;
    if (want <= 0) {
      reverse.final = true;
      this.target = 0;
      this.set({ targetFrame: 0, confirmed: false });
      this.issue();
      return;
    }
    if (want < current) {
      this.target = want;
      this.set({ targetFrame: want, confirmed: false });
      this.issue();
      return;
    }
    this.scheduleTick();
  }
}

export type FrameClock = FrameClockState & {
  seekToFrame(frame: number): void;
  step(delta: number): void;
  awaitConfirmedFrame(): Promise<number>;
  play(): void;
  pause(): void;
  setRate(rate: number): void;
  reverse(speed: number): void;
  setMuted(muted: boolean): void;
};

const IDLE: FrameClockState = { frame: 0, targetFrame: null, confirmed: false, playing: false, rate: 0 };
const noopSubscribe = () => () => {};
const getIdle = () => IDLE;

/**
 * The frame clock of `video` for one Version (the interface notes, markup and compare compose on). Pass the element as STATE
 * (a callback ref) so the clock is built when it mounts. Key the player by Version: a new Version is a new clock.
 */
export function useVideoFrameClock(video: HTMLVideoElement | null, version: FrameClockVersion): FrameClock {
  const { fps, frameCount } = version;
  const [clock, setClock] = useState<VideoFrameClock | null>(null);
  useEffect(() => {
    if (!video) { setClock(null); return; }
    const created = new VideoFrameClock(video, { fps: { num: fps.num, den: fps.den }, frameCount });
    setClock(created);
    return () => { created.dispose(); };
  }, [video, fps.num, fps.den, frameCount]);
  const state = useSyncExternalStore(clock?.subscribe ?? noopSubscribe, clock?.getState ?? getIdle, getIdle);
  const seekToFrame = useCallback((frame: number) => { clock?.seekToFrame(frame); }, [clock]);
  const step = useCallback((delta: number) => { clock?.step(delta); }, [clock]);
  const awaitConfirmedFrame = useCallback(() => clock ? clock.awaitConfirmedFrame() : Promise.reject(new Error("No video")), [clock]);
  const play = useCallback(() => { clock?.play(); }, [clock]);
  const pause = useCallback(() => { clock?.pause(); }, [clock]);
  const setRate = useCallback((rate: number) => { clock?.setRate(rate); }, [clock]);
  const reverse = useCallback((speed: number) => { clock?.reverse(speed); }, [clock]);
  const setMuted = useCallback((muted: boolean) => { clock?.setMuted(muted); }, [clock]);
  return useMemo(() => ({ ...state, seekToFrame, step, awaitConfirmedFrame, play, pause, setRate, reverse, setMuted }), [state, seekToFrame, step, awaitConfirmedFrame, play, pause, setRate, reverse, setMuted]);
}
