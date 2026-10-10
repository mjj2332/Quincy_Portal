import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
  /** True while the element is un-paused but starved of data (`waiting`), until it plays again. */
  stalled: boolean;
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
  private state: FrameClockState = { frame: 0, targetFrame: null, confirmed: false, playing: false, rate: 0, stalled: false };
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
  /** The rate the caller last asked for: the element's `playbackRate` may be trimmed by compare and is never read back. */
  private requestedRate = 1;
  private trim = 1;
  /** The presentation time of the last frame the browser composited, or null before one (or when `requestVideoFrameCallback` is missing). */
  private presentedTime: number | null = null;
  /** The frame the first seek goes to (compare opens a side mid-film); consumed once. */
  private initialFrame: number;
  private initialConsumed = false;
  private readonly rejectListeners = new Set<(error: unknown) => void>();
  private readonly confirmListeners = new Set<() => void>();
  private readonly confirmedListeners = new Set<(frame: number) => void>();
  /** An explicit seek or step has been issued: metadata arriving must not replace its target with `initialFrame` (or 0). */
  private commanded = false;

  constructor(private readonly video: HTMLVideoElement, version: FrameClockVersion, options: { now?: () => number; initialFrame?: number } = {}) {
    this.initialFrame = options.initialFrame !== undefined && Number.isFinite(options.initialFrame) ? Math.max(0, Math.trunc(options.initialFrame)) : 0;
    this.fps = version.fps;
    this.frameCount = version.frameCount;
    this.now = options.now ?? (() => performance.now());
    this.hasRvfc = typeof (video as FrameVideo).requestVideoFrameCallback === "function";
    for (const [name, handler] of this.handlers) video.addEventListener(name, handler);
    if (this.hasRvfc) this.register();
    if (video.readyState >= 1) this.seek(this.takeInitialFrame(), true);
  }

  getState = (): FrameClockState => this.state;

  /** The frame the first seek will go to, or null once it has gone (compare reads it before metadata, when `state.frame` is still 0). */
  pendingInitialFrame(): number | null { return this.initialConsumed ? null : this.initialFrame; }

  /** An explicit seek/step cancels the pending initial frame. */
  private command(): void {
    this.commanded = true;
    this.initialFrame = 0;
    this.initialConsumed = true;
  }

  private takeInitialFrame(): number {
    const frame = this.initialFrame;
    this.initialFrame = 0;
    this.initialConsumed = true;
    return frame;
  }

  /** The last frame this clock can show: the film's length, cut to what the element says it has. */
  lastFrame(): number {
    let last = this.frameCount - 1;
    const duration = this.video.duration;
    // Audio and video lengths can differ: never seek past what the element says it has.
    if (Number.isFinite(duration) && duration > 0) last = Math.min(last, Math.ceil((duration * this.fps.num) / this.fps.den - 1e-6) - 1);
    return Math.max(0, last);
  }

  /** Seconds of the last frame the browser presented (drift is measured on these), else the playhead. */
  mediaTime(): number { return this.presentedTime ?? this.video.currentTime; }

  /** True while the element is advancing forward on its own: un-paused, playing, not in the emulated reverse. */
  isLive(): boolean { return this.state.playing && this.state.rate > 0 && !this.reverseState && !this.video.paused; }

  /** Nudges the forward rate to `requested rate x factor` without touching the requested rate (compare's drift correction). */
  setRateTrim(factor: number): void {
    this.trim = factor;
    this.applyTrim();
  }

  clearRateTrim(): void { this.setRateTrim(1); }

  private applyTrim(): void {
    if (this.disposed || !this.state.playing || this.state.rate <= 0 || this.reverseState) return;
    this.video.playbackRate = this.state.rate * this.trim;
  }

  /** Seeks without stopping: the element keeps playing and lands on `frame` (a hard drift correction). */
  seekWhilePlaying(frame: number): void { this.command(); this.seek(frame, true, true); }

  /** Tells `listener` whenever `awaitConfirmedFrame()` is asked for, after any playback it stops: a note post is about to anchor to this clock's frame. */
  onConfirmRequest(listener: () => void): () => void {
    this.confirmListeners.add(listener);
    return () => { this.confirmListeners.delete(listener); };
  }

  /** Tells `listener` the frame each `awaitConfirmedFrame()` is resolved with, as it resolves (so the other half of a pair can follow it). */
  onConfirmed(listener: (frame: number) => void): () => void {
    this.confirmedListeners.add(listener);
    return () => { this.confirmedListeners.delete(listener); };
  }

  private notifyConfirmed(frame: number): void {
    for (const listener of [...this.confirmedListeners]) listener(frame);
  }

  /** Tells `listener` when the browser refused or failed a `play()` (anything but the AbortError a pause causes). Returns the remover. */
  onPlayRejected(listener: (error: unknown) => void): () => void {
    this.rejectListeners.add(listener);
    return () => { this.rejectListeners.delete(listener); };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Seeks to `frame` (clamped to the film), stopping any playback. */
  seekToFrame(frame: number): void { this.command(); this.seek(frame, false); }

  /** Moves `delta` frames from the frame on its way, or the one on screen. Stepping past either end does nothing. */
  step(delta: number): void {
    this.command();
    const base = this.state.targetFrame ?? this.state.frame;
    const target = this.clamp(base + delta);
    if (target === base) return;
    this.seek(target, false);
  }

  /** Pauses (if playing) and resolves with the frame once the browser has shown it: what a note or a drawing must anchor to. */
  awaitConfirmedFrame(): Promise<number> {
    if (this.state.playing) this.pause();
    for (const listener of [...this.confirmListeners]) listener();
    if (this.state.confirmed && this.target === null && !this.video.seeking) {
      this.notifyConfirmed(this.state.frame);
      return Promise.resolve(this.state.frame);
    }
    return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }); });
  }

  /** Plays forward at 1x; from the last frame, restarts from frame 0. */
  play(): void { this.setRate(1); }

  /** Plays forward at `rate` (1, 2, 4, 8). */
  setRate(rate: number): void {
    this.endReverse();
    this.requestedRate = rate;
    this.trim = 1;
    // Judge the restart by the frame a pending seek is bringing, not the one still on screen.
    if ((this.state.targetFrame ?? this.state.frame) >= this.lastFrame()) {
      this.target = 0; this.issued = 0; this.presented = false;
      this.video.currentTime = this.seekSeconds(0);
      this.state = { ...this.state, frame: 0, targetFrame: 0, confirmed: false };
    }
    this.video.playbackRate = rate;
    // play() must run inside the user's gesture (Safari / iOS refuse it later). Before metadata it stays pending; `initialize` positions frame 0 without pausing, so it is never aborted.
    this.startPlayback();
    this.set({ playing: true, rate });
    this.startRaf();
  }

  private startPlayback(): void {
    const started = this.video.play() as Promise<void> | undefined;
    // An AbortError means a pause or a newer load superseded this play(): the state already says so. Anything else (NotAllowedError) means it never started.
    if (started && typeof started.catch === "function") started.catch((error: unknown) => {
      if (this.disposed || (error as { name?: string } | null)?.name === "AbortError") return;
      // Listeners first: a compare transport must see a refused play() as that, before the clock's own stop reads as an unexpected one.
      for (const listener of [...this.rejectListeners]) listener(error);
      this.set({ playing: false, rate: 0 });
    });
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
    ["seeked", () => { if (this.video.readyState >= 3) this.set({ stalled: false }); this.onSeeked(); }],
    ["waiting", () => { if (!this.disposed && !this.video.paused) this.set({ stalled: true }); }],
    ["playing", () => { if (this.video.readyState >= 3) this.set({ stalled: false }); }],
    ["timeupdate", () => { if (!this.hasRvfc && this.target === null && !this.video.seeking && !this.reverseState) this.set({ frame: this.timeFrame() }); }],
    ["ended", () => { this.onEnded(); }],
    // Media events arrive after the call that caused them: read the element as it is NOW. A `pause` from a stop that has since been
    // followed by a play() (or a `play` after a later pause) is history, not news.
    ["pause", () => { if (this.disposed) return; if (this.video.paused && this.state.playing && !this.reverseState) this.set({ playing: false, rate: 0 }); if (this.video.readyState >= 3) this.set({ stalled: false }); }],
    ["play", () => { if (!this.state.playing && !this.reverseState && !this.disposed && !this.video.paused) { this.set({ playing: true, rate: this.requestedRate || 1 }); this.startRaf(); } }],
  ];

  private set(next: Partial<FrameClockState>): void {
    const merged = { ...this.state, ...next };
    if (merged.frame === this.state.frame && merged.targetFrame === this.state.targetFrame && merged.confirmed === this.state.confirmed && merged.playing === this.state.playing && merged.rate === this.state.rate && merged.stalled === this.state.stalled) return;
    this.state = merged;
    for (const listener of [...this.listeners]) listener();
  }

  private clamp(frame: number): number {
    if (!Number.isFinite(frame)) return 0;
    return Math.min(this.lastFrame(), Math.max(0, Math.trunc(frame)));
  }

  private timeFrame(): number { return this.clamp(frameContainingTime(this.video.currentTime, this.fps)); }

  private seek(frame: number, force: boolean, keepPlaying = false): void {
    const target = this.clamp(frame);
    const wasMoving = this.state.playing;
    if (!keepPlaying) this.halt();
    if (!force && !wasMoving && target === this.state.frame && this.state.confirmed && this.target === null && !this.video.seeking) return;
    this.target = target;
    this.set({ targetFrame: target, confirmed: false });
    // A seek already in flight just has its target moved; `seeked` issues the one that matters.
    if (!this.video.seeking) this.issue();
  }

  /**
   * Metadata arrived: paint frame 0. A Play asked for before the element could seek is already pending on the element: it must not
   * be paused (that aborts the play() promise), so frame 0 is reached without `halt()`, and not at all when the playhead is there.
   */
  private initialize(): void {
    const { playing, rate } = this.state;
    // A seek or step issued before metadata keeps its target; otherwise the first seek goes to the initial frame.
    const goal = (): number => (this.commanded ? (this.target ?? this.state.frame) : this.takeInitialFrame());
    if (!(playing && rate > 0 && !this.reverseState)) { this.seek(goal(), true); return; }
    if (this.disposed) return;
    this.video.playbackRate = rate * this.trim;
    const initial = goal();
    if (this.video.currentTime !== 0 || this.target !== null || initial !== 0) this.seek(initial, true, true);
    this.startRaf();
  }

  private issue(): void {
    if (this.target === null) return;
    this.issued = this.target;
    // Presentation evidence belongs to one seek: a frame shown before this write says nothing about the one it asks for.
    this.presented = false;
    this.video.currentTime = this.seekSeconds(this.target);
  }

  /** The middle of `frame`, kept strictly inside a finite element duration (the last frame's midpoint can lie past it). */
  private seekSeconds(frame: number): number {
    const seconds = frameSeekSeconds(frame, this.fps);
    const duration = this.video.duration;
    return Number.isFinite(duration) && duration > 0 ? Math.min(seconds, duration - 0.001) : seconds;
  }

  /** Stops playback and any reverse, leaving no seek of its own behind. */
  private halt(): void {
    if (this.state.playing && !this.video.paused) this.video.pause();
    this.endReverse();
    this.trim = 1;
    this.set({ playing: false, rate: 0, stalled: false });
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
    if (waiters.length > 0) this.notifyConfirmed(this.state.frame);
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
    if (waiters.length > 0) this.notifyConfirmed(this.state.frame);
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
    this.presentedTime = metadata.mediaTime;
    // A composited frame is proof the element is not starved, whether or not a `playing` event is ever delivered.
    const wasStalled = this.state.stalled;
    const frame = this.clamp(frameAtPresentationTime(metadata.mediaTime, this.fps));
    if (wasStalled && !this.video.paused) this.set({ stalled: false });
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
  /** The clock object itself (null until the element mounts), for siblings that subscribe on their own: see `useFrameClockSelector`. */
  instance: VideoFrameClock | null;
  seekToFrame(frame: number): void;
  step(delta: number): void;
  awaitConfirmedFrame(): Promise<number>;
  play(): void;
  pause(): void;
  setRate(rate: number): void;
  reverse(speed: number): void;
  setMuted(muted: boolean): void;
};

const IDLE: FrameClockState = { frame: 0, targetFrame: null, confirmed: false, playing: false, rate: 0, stalled: false };
const noopSubscribe = () => () => {};
const getIdle = () => IDLE;

/**
 * The frame clock of `video` for one Version (the interface notes, markup and compare compose on). Pass the element as STATE
 * (a callback ref) so the clock is built when it mounts. Key the player by Version: a new Version is a new clock.
 */
export function useVideoFrameClock(video: HTMLVideoElement | null, version: FrameClockVersion, options: { initialFrame?: number } = {}): FrameClock {
  const { fps, frameCount } = version;
  // Read once, when the clock is built: a later change of the option must not rebuild the clock.
  const initialFrame = useRef(options.initialFrame);
  const [clock, setClock] = useState<VideoFrameClock | null>(null);
  useEffect(() => {
    if (!video) { setClock(null); return; }
    const created = new VideoFrameClock(video, { fps: { num: fps.num, den: fps.den }, frameCount }, initialFrame.current === undefined ? {} : { initialFrame: initialFrame.current });
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
  return useMemo(() => ({ ...state, instance: clock, seekToFrame, step, awaitConfirmedFrame, play, pause, setRate, reverse, setMuted }), [state, clock, seekToFrame, step, awaitConfirmedFrame, play, pause, setRate, reverse, setMuted]);
}

/**
 * One primitive out of a clock's state, for a component that is not the player (the notes composer's frame chip). It re-renders only
 * when the selected value changes, so playback does not re-render the note list 25-60 times a second. `select` must return a
 * primitive; `fallback` is what a null clock reads.
 */
export function useFrameClockSelector<T extends string | number | boolean | null>(clock: VideoFrameClock | null, select: (state: FrameClockState) => T, fallback: T): T {
  return useSyncExternalStore(clock?.subscribe ?? noopSubscribe, () => (clock ? select(clock.getState()) : fallback), () => fallback);
}
