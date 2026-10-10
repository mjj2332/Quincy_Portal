import { aOf, bOf, compareDomain, driftDecision, medianOfLastThree, offsetBounds, phase, type Rational, type SidePhase } from "@quincy/shared";
import type { VideoFrameClock } from "./video-frame-clock";
import { offsetOf, type CompareSideId, type CompareStore } from "./video-compare-store";

/**
 * Two frame clocks driven as one (#741 7b): the shared position, paired seeks, drift correction, stalls and the gesture rules.
 *
 * Invariants. Each is enforced at one choke point; a new code path that needs the thing goes through it, not around it.
 *  I1. A side is started only by `startSide(side)`: it refuses an ended side and one that is not `live` at the shared position, and it
 *      seeks the side to its mapped frame BEFORE starting it, so the clock's restart-at-end can never fire. Play, phase entry and every
 *      stall recovery start sides this way.
 *  I2. While playing forward the shared position never decreases (`onMasterFrame`): a presentation that maps earlier, such as a new
 *      master lagging after a handoff, is ignored until it catches up. A handoff never rewinds and never replays a parked side.
 *  I3. A stall has two exits, whatever its kind: the stalled side's `playing` event or a new presented frame on it (`recoverStall`). The
 *      held side is realigned through I1.
 *  I4. Every master change goes through `reselectMaster`, which clears drift history and both trims (`resetSamples`).
 */

export type CompareTransportSide = {
  clock: VideoFrameClock;
  video: HTMLVideoElement;
  fps: Rational;
  frameCount: number;
  hasAudio: boolean;
};

export type CompareBlock = "gesture" | "recovery";

export type CompareTransportState = Readonly<{
  /** The shared position: A's local frame index. It lies outside A's range while A is parked. */
  frame: number;
  playing: boolean;
  /** Signed: negative is the emulated reverse. */
  rate: number;
  master: CompareSideId;
  phases: Readonly<Record<CompareSideId, SidePhase>>;
  /** The side that is buffering (the other is held until it plays again), or null. */
  stalled: CompareSideId | null;
  /** Why playback stopped without the reviewer asking: the browser wanted a gesture, or recovery failed twice. */
  blocked: CompareBlock | null;
  domain: Readonly<{ start: number; end: number }>;
  offset: number;
}>;

export type CompareTransportOptions = {
  a: CompareTransportSide;
  b: CompareTransportSide;
  store: CompareStore;
  /** The shared position to start at (A's frame). Defaults to where A's clock is, or will first seek to. */
  initialA?: number;
  now?: () => number;
  /** Where `visibilitychange` is heard. Defaults to `document`. */
  document?: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;
};

export const WATCHDOG_FLOOR_MS = 750;
/** Two failed recoveries inside this window stop playback with a notice. */
export const RECOVERY_WINDOW_MS = 10_000;
/** A stall this soon after a resume means the resume did not hold. */
export const RECOVERY_GRACE_MS = 2_000;

const SIDES: readonly CompareSideId[] = ["a", "b"];
const other = (side: CompareSideId): CompareSideId => (side === "a" ? "b" : "a");

type Runtime = { ended: boolean; prevPlaying: boolean; prevFrame: number; samples: number[]; trimmed: number; detach: Array<() => void> };
type Reverse = { base: number; startedAt: number; speed: number; final: boolean; timer: ReturnType<typeof setTimeout> | null };

export class CompareTransport {
  private readonly sides: Record<CompareSideId, CompareTransportSide>;
  private readonly runtime: Record<CompareSideId, Runtime>;
  private readonly store: CompareStore;
  private readonly now: () => number;
  private readonly doc: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState"> | null;
  private readonly listeners = new Set<() => void>();
  private state: CompareTransportState;
  private a: number;
  private playing = false;
  private rate = 1;
  private master: CompareSideId = "a";
  private stall: CompareSideId | null = null;
  private blocked: CompareBlock | null = null;
  /** >0 while this class is the one stopping or moving a clock, so the clock's own state change is not read as an unexpected stop. */
  private issuing = 0;
  private lastResumeAt: number | null = null;
  /** The frame the stalled side showed when it stalled: a different presented frame is progress. */
  private stallFrame = -1;
  private failures: number[] = [];
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private reverseRun: Reverse | null = null;
  private disposed = false;

  constructor(options: CompareTransportOptions) {
    this.sides = { a: options.a, b: options.b };
    this.store = options.store;
    this.now = options.now ?? (() => performance.now());
    this.doc = options.document ?? (typeof document === "undefined" ? null : document);
    const startState = options.a.clock.getState();
    this.a = options.initialA ?? options.a.clock.pendingInitialFrame() ?? startState.targetFrame ?? startState.frame;
    this.runtime = { a: this.newRuntime(), b: this.newRuntime() };
    for (const side of SIDES) this.attach(side);
    if (this.doc) {
      const onVisibility = () => { if (this.doc?.visibilityState === "hidden" && (this.playing || this.reverseRun)) this.pause(); };
      this.doc.addEventListener("visibilitychange", onVisibility);
      this.runtime.a.detach.push(() => { this.doc?.removeEventListener("visibilitychange", onVisibility); });
    }
    this.applyAudio();
    this.master = this.pickMaster();
    this.state = this.build();
  }

  getState = (): CompareTransportState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  // --- commands ---

  /**
   * Plays both live sides forward at `rate`. Call it from the click or key handler: every `play()` runs synchronously in here, before any
   * await, because Safari honours it only inside the gesture. From the shared end it restarts at the domain start. A side that has not
   * started, or has finished, is parked and never played.
   */
  play(rate = 1): void {
    if (this.disposed) return;
    this.endReverse();
    const domain = this.domain();
    // From the end, or from a tail where every side is on its last frame or past it (nothing left to play): start over.
    if (this.a >= domain.end || this.a < domain.start || !SIDES.some((side) => this.phaseOf(side, this.a) === "live")) this.a = domain.start;
    const startable = SIDES.some((side) => this.phaseOf(side, this.a) === "live");
    this.blocked = null;
    this.stall = null;
    if (!startable) {
      // Nothing can play (a one-frame pair): report paused rather than a playing state no element backs.
      this.halt();
      this.land(this.a);
      this.refresh();
      return;
    }
    this.playing = true;
    this.rate = rate;
    this.resetSamples();
    this.master = this.pickMaster();
    this.applyAudio();
    this.act(() => {
      for (const side of SIDES) {
        if (this.startSide(side)) continue;
        const { clock } = this.sides[side];
        const parked = this.parkedFrame(side, this.localFrame(side, this.a));
        if (this.shownFrame(side) !== parked || clock.getState().playing) clock.seekToFrame(parked);
      }
    });
    this.armWatchdog();
    this.refresh();
  }

  /** Pauses both sides on the frames the shared position maps to. */
  pause(): void {
    if (this.disposed) return;
    this.endReverse();
    this.seekTo(this.a);
  }

  /** Both sides to the frames that shared position `a` (A's frame) maps to, pausing playback. */
  seekTo(a: number): void {
    if (this.disposed) return;
    this.endReverse();
    this.halt();
    const domain = this.domain();
    this.a = Math.min(domain.end, Math.max(domain.start, Math.trunc(a)));
    this.land(this.a);
    this.refresh();
  }

  /** Moves `delta` A-frames. Each side lands on the frame its own rate maps that position to. */
  step(delta: number): void { this.seekTo(this.a + delta); }

  home(): void { this.seekTo(this.domain().start); }

  end(): void { this.seekTo(this.domain().end); }

  /** A note or marker on `side`: that side lands exactly on its `frame`, the other by mapping. */
  seekSide(side: CompareSideId, frame: number): void {
    if (this.disposed) return;
    this.endReverse();
    this.halt();
    const mine = Math.min(this.lastFrame(side), Math.max(0, Math.trunc(frame)));
    const domain = this.domain();
    const shared = side === "a" ? mine : aOf(mine, this.offset(), this.sides.a.fps, this.sides.b.fps);
    this.a = Math.min(domain.end, Math.max(domain.start, shared));
    const mapped = this.localFrame(other(side), this.a);
    this.act(() => {
      this.sides[side].clock.seekToFrame(mine);
      this.sides[other(side)].clock.seekToFrame(this.parkedFrame(other(side), mapped));
    });
    this.refresh();
  }

  /**
   * Sets the offset (B frames). Out of range or fractional values are refused (returns false) so the caller can show the bounds.
   * Playback pauses, A stays on the frame it shows and only B is re-seeked.
   */
  setOffset(offset: number): boolean {
    if (this.disposed || !Number.isInteger(offset)) return false;
    const bounds = this.bounds();
    if (offset < bounds.min || offset > bounds.max) return false;
    this.endReverse();
    const wasA = this.phaseOf("a", this.a);
    const clockA = this.sides.a.clock;
    this.halt();
    this.act(() => { clockA.pause(); });
    const shown = clockA.getState().targetFrame ?? clockA.getState().frame;
    const anchor = wasA === "live" || wasA === "last" ? shown : this.a;
    this.store.setOffset(offset);
    const domain = this.domain();
    this.a = Math.min(domain.end, Math.max(domain.start, anchor));
    this.act(() => {
      if (this.a !== anchor) clockA.seekToFrame(this.parkedFrame("a", this.a));
      this.sides.b.clock.seekToFrame(this.parkedFrame("b", this.localFrame("b", this.a)));
    });
    this.refresh();
    return true;
  }

  /** The offsets that keep one frame of overlap, for the field's bounds message. */
  offsetBounds(): { min: number; max: number } { return this.bounds(); }

  /** Chooses the side that is heard. Mutes flip synchronously, inside the caller's gesture. */
  setAudible(side: CompareSideId): void {
    if (this.disposed) return;
    this.store.setAudible(side);
    this.applyAudio();
    if (this.playing) this.reselectMaster();
    this.refresh();
  }

  setMuted(muted: boolean): void {
    if (this.disposed) return;
    this.store.setMuted(muted);
    this.applyAudio();
    if (this.playing) this.reselectMaster();
    this.refresh();
  }

  /**
   * Emulated reverse at `speed` (1, 2, 4, 8) for the pair: both sides are muted and seeked backward together, one seek at a time, each step
   * waiting until both clocks have landed. It stops at the domain start; sound is restored when it ends.
   */
  reverse(speed: number): void {
    if (this.disposed) return;
    const domain = this.domain();
    const base = this.a;
    if (base <= domain.start) return;
    if (!this.reverseRun) {
      this.halt();
      this.land(base);
      this.act(() => { for (const side of SIDES) this.sides[side].clock.setMuted(true); });
    }
    this.clearReverseTimer();
    this.stall = null;
    this.blocked = null;
    this.playing = true;
    this.rate = -speed;
    this.reverseRun = { base, startedAt: this.now(), speed, final: false, timer: null };
    this.reverseStep();
    this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.endReverse();
    this.clearWatchdog();
    this.act(() => {
      for (const side of SIDES) {
        const { clock, video } = this.sides[side];
        if (clock.getState().playing || !video.paused) clock.pause();
        clock.clearRateTrim();
      }
    });
    this.disposed = true;
    this.playing = false;
    for (const side of SIDES) for (const remove of this.runtime[side].detach) remove();
    this.listeners.clear();
  }

  // --- geometry ---

  private offset(): number { return offsetOf(this.store.getState()); }

  private lastFrame(side: CompareSideId): number { return this.sides[side].clock.lastFrame(); }

  /** Each side's length as the clock sees it, for the mapping maths. */
  private descriptor(side: CompareSideId) { return { fps: this.sides[side].fps, frameCount: this.lastFrame(side) + 1 }; }

  private domain(): { start: number; end: number } { return compareDomain(this.descriptor("a"), this.descriptor("b"), this.offset()); }

  private bounds(): { min: number; max: number } { return offsetBounds(this.descriptor("a"), this.descriptor("b")); }

  private localFrame(side: CompareSideId, a: number): number {
    return side === "a" ? a : bOf(a, this.offset(), this.sides.a.fps, this.sides.b.fps);
  }

  private phaseOf(side: CompareSideId, a: number): SidePhase { return phase(this.localFrame(side, a), this.lastFrame(side)); }

  /** The frame a side shows for a local frame that may lie outside its range: before it starts frame 0, after it ends its last. */
  private parkedFrame(side: CompareSideId, local: number): number { return Math.min(this.lastFrame(side), Math.max(0, local)); }

  private shownFrame(side: CompareSideId): number {
    const state = this.sides[side].clock.getState();
    return state.targetFrame ?? state.frame;
  }

  private sharedFrom(side: CompareSideId, frame: number): number {
    return side === "a" ? frame : aOf(frame, this.offset(), this.sides.a.fps, this.sides.b.fps);
  }

  // --- state ---

  private newRuntime(): Runtime { return { ended: false, prevPlaying: false, prevFrame: -1, samples: [], trimmed: 1, detach: [] }; }

  private build(): CompareTransportState {
    return {
      frame: this.a,
      playing: this.playing,
      rate: this.reverseRun ? this.rate : this.playing ? this.rate : 0,
      master: this.master,
      phases: { a: this.phaseOf("a", this.a), b: this.phaseOf("b", this.a) },
      stalled: this.stall,
      blocked: this.blocked,
      domain: this.domain(),
      offset: this.offset(),
    };
  }

  private refresh(): void {
    if (this.disposed) return;
    const next = this.build();
    const prev = this.state;
    if (next.frame === prev.frame && next.playing === prev.playing && next.rate === prev.rate && next.master === prev.master && next.phases.a === prev.phases.a && next.phases.b === prev.phases.b && next.stalled === prev.stalled && next.blocked === prev.blocked && next.domain.start === prev.domain.start && next.domain.end === prev.domain.end && next.offset === prev.offset) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  private act(work: () => void): void {
    this.issuing++;
    try { work(); } finally { this.issuing--; }
  }

  /** Stops playing in this class's books (the clocks are paused or seeked by the caller). */
  private halt(): void {
    this.playing = false;
    this.rate = 1;
    this.stall = null;
    this.clearWatchdog();
    this.resetSamples();
    for (const side of SIDES) this.runtime[side].ended = false;
  }

  /** Seeks both sides to the frames `a` maps to (each clamped to its own range). A seek halts a playing clock. */
  private land(a: number): void {
    this.act(() => {
      for (const side of SIDES) this.sides[side].clock.seekToFrame(this.parkedFrame(side, this.localFrame(side, a)));
    });
  }

  /** Forgets drift history and releases any trim actually applied to the elements. */
  private resetSamples(): void {
    for (const side of SIDES) { this.runtime[side].samples = []; this.runtime[side].trimmed = 1; }
    this.act(() => { for (const side of SIDES) this.sides[side].clock.clearRateTrim(); });
  }

  // --- audio ---

  /** One audible side; everything else muted. Not while a reverse runs: both stay muted until it ends. */
  private applyAudio(): void {
    if (this.reverseRun) return;
    const { audible, muted } = this.store.getState();
    for (const side of SIDES) this.sides[side].clock.setMuted(muted || side !== audible);
  }

  // --- master and drift ---

  /** The audible live side, else the other live side (A first when muted). With no live side the master stays as it was. */
  private pickMaster(): CompareSideId {
    // An ended element never advances again, whatever the frame mapping calls it.
    const live = SIDES.filter((side) => this.phaseOf(side, this.a) === "live" && !this.runtime[side].ended);
    if (live.length === 0) return this.master;
    const { audible, muted } = this.store.getState();
    if (!muted && live.includes(audible)) return audible;
    return live.includes("a") ? "a" : "b";
  }

  /** The one place the master changes: a new master means new drift history and no trim left on either element. */
  private reselectMaster(): void {
    const next = this.pickMaster();
    if (next === this.master) return;
    this.master = next;
    this.resetSamples();
  }

  /** I1: the only way a side is started. Returns false (and does nothing) for a side that must not play now. */
  private startSide(side: CompareSideId): boolean {
    if (!this.playing || this.runtime[side].ended || this.phaseOf(side, this.a) !== "live") return false;
    const { clock } = this.sides[side];
    const local = this.localFrame(side, this.a);
    this.act(() => {
      if (this.shownFrame(side) !== local) clock.seekToFrame(local);
      clock.setRate(this.rate);
    });
    return true;
  }

  private onMasterFrame(master: CompareSideId, frame: number): void {
    this.armWatchdog();
    const next = this.sharedFrom(master, frame);
    // I2: a presentation that maps behind the position already reached (a master that lags after a handoff) is not progress.
    if (next < this.a) return;
    this.a = next;
    this.syncPhases();
    if (this.playing && !this.stall) this.sampleDrift();
    this.refresh();
  }

  /** Starts a side that has entered its window, parks one that has run out, hands the master over, and stops at the shared end. */
  private syncPhases(): void {
    if (!this.playing) return;
    for (const side of SIDES) {
      const { clock, video } = this.sides[side];
      const ph = this.phaseOf(side, this.a);
      if (ph === "live") {
        if (!clock.getState().playing && !this.stall) {
          if (this.startSide(side) && video.readyState < 3) this.enterStall(side);
        }
      } else if (ph !== "before" && (clock.getState().playing || this.runtime[side].ended)) {
        this.act(() => { clock.seekToFrame(this.lastFrame(side)); });
      }
    }
    // Starting a side can stop everything (a refused play, a failed recovery): nothing more to reconcile then.
    if (!this.playing) return;
    const phases = SIDES.map((side) => this.phaseOf(side, this.a));
    const running = phases.some((ph) => ph === "live" || ph === "before");
    if (this.a >= this.domain().end || !running) { this.finish(); return; }
    this.reselectMaster();
  }

  /** Playback reached the shared end: stop and park both sides there. */
  private finish(): void {
    const end = this.domain().end;
    this.halt();
    this.a = Math.min(end, this.a);
    this.land(this.a);
  }

  private sampleDrift(): void {
    const masterSide = this.master;
    const followerSide = other(masterSide);
    const follower = this.sides[followerSide];
    const masterClock = this.sides[masterSide].clock;
    const run = this.runtime[followerSide];
    const fstate = follower.clock.getState();
    if (!follower.clock.isLive() || fstate.targetFrame !== null || fstate.stalled || this.phaseOf(followerSide, this.a) !== "live") return;
    const { fps } = this.sides.b;
    const offsetSeconds = (this.offset() * fps.den) / fps.num;
    const expected = masterClock.mediaTime() + (masterSide === "a" ? -offsetSeconds : offsetSeconds);
    run.samples.push(follower.clock.mediaTime() - expected);
    if (run.samples.length > 3) run.samples.shift();
    if (run.samples.length < 3) return;
    const decision = driftDecision({ driftSeconds: medianOfLastThree(run.samples), followerFps: follower.fps, rate: this.rate, trimmed: run.trimmed });
    this.act(() => {
      if (decision.action === "trim") { run.trimmed = decision.factor; follower.clock.setRateTrim(decision.factor); }
      else if (decision.action === "release") { run.trimmed = 1; follower.clock.clearRateTrim(); }
      else if (decision.action === "seek") {
        run.trimmed = 1;
        run.samples = [];
        follower.clock.clearRateTrim();
        follower.clock.seekWhilePlaying(this.parkedFrame(followerSide, this.localFrame(followerSide, this.a)));
      }
    });
  }

  // --- events ---

  private attach(side: CompareSideId): void {
    const { clock, video } = this.sides[side];
    const run = this.runtime[side];
    run.prevPlaying = clock.getState().playing;
    run.prevFrame = clock.getState().frame;
    run.detach.push(clock.subscribe(() => { this.onClock(side); }));
    const onPlaying = () => { this.onVideoPlaying(side); };
    video.addEventListener("playing", onPlaying);
    run.detach.push(() => { video.removeEventListener("playing", onPlaying); });
    run.detach.push(clock.onConfirmRequest(() => { this.onConfirmRequest(side); }));
    run.detach.push(clock.onPlayRejected((error) => { this.onPlayRejected(error); }));
  }

  private onClock(side: CompareSideId): void {
    if (this.disposed) return;
    const run = this.runtime[side];
    const state = this.sides[side].clock.getState();
    const wasPlaying = run.prevPlaying;
    const frameChanged = state.frame !== run.prevFrame;
    run.prevPlaying = state.playing;
    run.prevFrame = state.frame;
    if (this.reverseRun) { if (this.issuing === 0) this.reverseStep(); return; }
    if (!this.playing) return;
    if (wasPlaying && !state.playing && this.issuing === 0) { this.onUnexpectedStop(side); return; }
    if (state.stalled && state.playing && !this.stall && this.issuing === 0 && this.phaseOf(side, this.a) === "live") { this.enterStall(side); return; }
    // I3: a new presented frame on the stalled side is recovery, with or without a `playing` event.
    if (this.stall === side && this.issuing === 0 && frameChanged && state.frame !== this.stallFrame) { this.recoverStall(side, state.frame); return; }
    if (this.issuing > 0 || !frameChanged || this.master !== side || this.stall) return;
    // A frame shown on the way to a seek's target is not progress.
    if (state.targetFrame !== null && state.frame !== state.targetFrame) return;
    this.onMasterFrame(side, state.frame);
  }

  /**
   * A side stopped and this class did not stop it: a note post confirming a frame, the element ending, a failed play. A side that ran out
   * is only parked. Otherwise everything stops: the OTHER side is paused and realigned to the one that stopped, which is never seeked.
   */
  private onUnexpectedStop(side: CompareSideId): void {
    const state = this.sides[side].clock.getState();
    if (state.frame >= this.lastFrame(side) && state.targetFrame === null) {
      // The element ended: its terminal frame is the position now, and it is parked, never played again.
      this.runtime[side].ended = true;
      if (this.master === side) this.a = this.sharedFrom(side, this.lastFrame(side));
      this.syncPhases();
      this.refresh();
      return;
    }
    const shown = state.targetFrame ?? state.frame;
    const shared = this.sharedFrom(side, shown);
    this.halt();
    this.a = shared;
    const mate = other(side);
    this.act(() => { this.sides[mate].clock.seekToFrame(this.parkedFrame(mate, this.localFrame(mate, shared))); });
    this.refresh();
  }

  /**
   * A note post asked `side` to confirm its frame. Whatever the transport is doing (playing, reversing, buffering with a resume pending)
   * ends; the other side is paused and aligned to the confirming side, which is never seeked.
   */
  private onConfirmRequest(side: CompareSideId): void {
    if (this.disposed || (!this.playing && !this.reverseRun)) return;
    const state = this.sides[side].clock.getState();
    const shared = this.sharedFrom(side, state.targetFrame ?? state.frame);
    this.endReverse();
    this.halt();
    this.a = shared;
    const mate = other(side);
    this.act(() => { this.sides[mate].clock.seekToFrame(this.parkedFrame(mate, this.localFrame(mate, shared))); });
    this.refresh();
  }

  private onPlayRejected(error: unknown): void {
    if (this.disposed || !this.playing || this.reverseRun) return;
    if ((error as { name?: string } | null)?.name !== "NotAllowedError") return;
    this.block("gesture");
  }

  private block(kind: CompareBlock): void {
    const a = this.a;
    this.halt();
    this.land(a);
    this.blocked = kind;
    this.refresh();
  }

  // --- buffering ---

  /** Freezes the shared position, pauses the other side and leaves `side` un-paused so the browser keeps fetching for it. */
  private enterStall(side: CompareSideId, counted = false): void {
    if (this.stall || !this.playing || this.reverseRun) return;
    if (!counted && this.lastResumeAt !== null && this.now() - this.lastResumeAt < RECOVERY_GRACE_MS && this.recordFailure()) return;
    this.stall = side;
    this.stallFrame = this.sides[side].clock.getState().frame;
    this.clearWatchdog();
    this.resetSamples();
    const mate = this.sides[other(side)].clock;
    this.act(() => { mate.pause(); });
    this.refresh();
  }

  private onVideoPlaying(side: CompareSideId): void {
    if (this.disposed || this.stall !== side || !this.playing) return;
    this.recoverStall(side, null);
  }

  /** I3: leaves a stall. The held side is started again through I1 (realigned to the shared position first). */
  private recoverStall(side: CompareSideId, frame: number | null): void {
    this.stall = null;
    this.lastResumeAt = this.now();
    if (frame !== null) this.a = Math.max(this.a, this.sharedFrom(side, frame));
    // Not a gesture: a refusal comes back through onPlayRejected and blocks.
    this.startSide(other(side));
    // The stalled side may have moved past its end while it buffered: park it, hand over the master, or finish.
    this.syncPhases();
    this.armWatchdog();
    this.refresh();
  }

  /** Records a failed recovery; the second inside the window stops playback with a notice. Returns true when it stopped. */
  private recordFailure(): boolean {
    const at = this.now();
    this.failures = this.failures.filter((t) => at - t <= RECOVERY_WINDOW_MS);
    this.failures.push(at);
    if (this.failures.length < 2) return false;
    this.failures = [];
    this.block("recovery");
    return true;
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    if (!this.playing || this.stall || this.reverseRun || this.disposed) return;
    const fps = this.sides[this.master].fps;
    const period = Math.max(WATCHDOG_FLOOR_MS, (3 * 1000 * fps.den) / fps.num / Math.max(0.001, Math.abs(this.rate)));
    this.watchdog = setTimeout(() => { this.watchdog = null; this.onWatchdog(); }, period);
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  /** The master is un-paused and has presented nothing for a while: that is a stall the browser did not announce. */
  private onWatchdog(): void {
    if (this.disposed || !this.playing || this.stall || this.reverseRun) return;
    const master = this.master;
    if (this.sides[master].video.paused) return;
    if (this.recordFailure()) return;
    this.enterStall(master, true);
  }

  // --- reverse ---

  private bothLanded(): boolean {
    return SIDES.every((side) => { const s = this.sides[side].clock.getState(); return s.targetFrame === null && s.confirmed; });
  }

  private reverseStep(): void {
    const run = this.reverseRun;
    if (!run || this.disposed) return;
    this.clearReverseTimer();
    if (!this.bothLanded()) return;
    if (run.final) { this.endReverse(); this.refresh(); return; }
    const { fps } = this.sides.a;
    const want = run.base - Math.round((run.speed * (this.now() - run.startedAt) * fps.num) / (1000 * fps.den));
    const start = this.domain().start;
    if (want <= start) {
      run.final = true;
      this.a = start;
      this.land(start);
      // A landing that moved nothing sends no notification: finish here rather than wait for one.
      if (this.bothLanded()) this.endReverse();
      this.refresh();
      return;
    }
    if (want < this.a) {
      this.a = want;
      this.land(want);
      this.refresh();
      // Likewise a no-op seek: keep the ticks going.
      if (!this.bothLanded()) return;
    }
    run.timer = setTimeout(() => { run.timer = null; this.reverseStep(); }, (1000 * fps.den) / fps.num);
  }

  private clearReverseTimer(): void {
    if (this.reverseRun?.timer) clearTimeout(this.reverseRun.timer);
    if (this.reverseRun) this.reverseRun.timer = null;
  }

  /** Ends a reverse in progress: sound back to the reviewer's choice, position kept where the last seek went. */
  private endReverse(): void {
    if (!this.reverseRun) return;
    this.clearReverseTimer();
    this.reverseRun = null;
    this.playing = false;
    this.rate = 1;
    this.applyAudio();
    this.refresh();
  }
}
