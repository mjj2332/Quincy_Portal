/**
 * happy-dom cannot decode video, so the player tests drive a stand-in for the media element (#741 4d-ii).
 *
 * `installVideoElementStub()` replaces, on `HTMLVideoElement.prototype`, the members the frame clock and the
 * player read and write: `currentTime` (every write recorded and marks the element seeking), `paused`,
 * `play()`/`pause()`, `seeking`, `duration`, `videoWidth`/`videoHeight`, `muted`, `playbackRate` and, optionally,
 * `requestVideoFrameCallback`/`cancelVideoFrameCallback`. Nothing moves on its own: a test finishes a seek with
 * `finishSeek` (which fires `seeked`), presents a frame with `presentFrame` (which runs the registered
 * `requestVideoFrameCallback` callbacks), and ends playback with `endPlayback`. `dispose()` puts the prototype back.
 */
type FrameCallback = (now: number, metadata: { mediaTime: number }) => void;

type Slot = {
  currentTime: number;
  paused: boolean;
  seeking: boolean;
  duration: number;
  videoWidth: number;
  videoHeight: number;
  muted: boolean;
  playbackRate: number;
  readyState: number;
  ended: boolean;
  error: { code: number; message: string } | null;
  rejectPlay: string | null;
  calls: string[];
  writes: number[];
  callbacks: Map<number, FrameCallback>;
};

export type VideoElementStub = {
  /** Every `currentTime` write on any element, oldest first. */
  writes: number[];
  /** `play()` / `pause()` calls on any element, oldest first. */
  calls: string[];
  /** Ends the pending seek on `video` and fires `seeked`. */
  finishSeek(video: HTMLVideoElement): void;
  /** Runs `video`'s pending `requestVideoFrameCallback` callbacks with `mediaTime`. */
  presentFrame(video: HTMLVideoElement, mediaTime: number): void;
  /** Pending `requestVideoFrameCallback` registrations on `video`. */
  pendingFrameCallbacks(video: HTMLVideoElement): number;
  /** Sets the decoded size and duration and fires `loadedmetadata`. */
  loadMetadata(video: HTMLVideoElement, meta: { duration: number; videoWidth?: number; videoHeight?: number }): void;
  /** Moves the playhead without seeking (what playback does between frames). */
  advance(video: HTMLVideoElement, seconds: number): void;
  /** Marks the element ended and fires `ended`. */
  endPlayback(video: HTMLVideoElement): void;
  /** `play()` / `pause()` calls on `video` alone, oldest first. */
  callsOf(video: HTMLVideoElement): string[];
  /** A natural end as a browser reports it: `ended` becomes true, the element is paused, `pause` is dispatched and `ended` follows it. */
  endNaturally(video: HTMLVideoElement): void;
  /** Fires `waiting` (the element ran out of data). */
  fireWaiting(video: HTMLVideoElement): void;
  /** Fires `playing` (it has data again and advances). */
  firePlaying(video: HTMLVideoElement): void;
  /** Sets `readyState` (3 = enough data to play) without firing anything. */
  setReadyState(video: HTMLVideoElement, readyState: number): void;
  /** The next `play()` on `video` (any element when omitted) rejects with a DOMException named `name`, e.g. `NotAllowedError`, and does not start. */
  rejectNextPlay(name: string, video?: HTMLVideoElement): void;
  /** Sets `video.error` and fires `error` (`code` 4 = source not supported). */
  fireError(video: HTMLVideoElement, code?: number, message?: string): void;
  /** Delivers up to `count` queued media events (see `asyncEvents`), oldest first; only `video`'s when given. Returns how many ran. */
  deliverEvents(count?: number, video?: HTMLVideoElement): number;
  /** Events queued by `asyncEvents` and not yet delivered. */
  pendingEvents(video?: HTMLVideoElement): number;
  /** Whether `requestVideoFrameCallback` is installed. */
  rvfc: boolean;
  dispose(): void;
};

const MEMBERS = ["currentTime", "paused", "seeking", "duration", "videoWidth", "videoHeight", "muted", "playbackRate", "readyState", "ended", "error", "play", "pause", "requestVideoFrameCallback", "cancelVideoFrameCallback"] as const;

export function installVideoElementStub(options: { rvfc?: boolean; asyncEvents?: boolean } = {}): VideoElementStub {
  const proto = HTMLVideoElement.prototype as unknown as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const name of MEMBERS) saved.set(name, Object.getOwnPropertyDescriptor(proto, name));
  const slots = new WeakMap<object, Slot>();
  const writes: number[] = [];
  const calls: string[] = [];
  let nextHandle = 1;
  let nextRejection: string | null = null;
  // With `asyncEvents` the events that `play()`, `pause()` and a `currentTime` write cause are queued, as in a browser, and arrive later.
  const queue: Array<{ video: HTMLVideoElement; type: string }> = [];
  const emit = (video: HTMLVideoElement, type: string) => {
    if (options.asyncEvents) queue.push({ video, type });
    else video.dispatchEvent(new Event(type));
  };

  const slot = (element: object): Slot => {
    let found = slots.get(element);
    if (!found) {
      found = { currentTime: 0, paused: true, seeking: false, duration: NaN, videoWidth: 0, videoHeight: 0, muted: false, playbackRate: 1, readyState: 0, ended: false, error: null, rejectPlay: null, calls: [], writes: [], callbacks: new Map() };
      slots.set(element, found);
    }
    return found;
  };
  const define = (name: string, descriptor: PropertyDescriptor) => Object.defineProperty(proto, name, { configurable: true, ...descriptor });

  define("currentTime", {
    get(this: object) { return slot(this).currentTime; },
    set(this: HTMLVideoElement, value: number) {
      const s = slot(this);
      s.currentTime = value; s.seeking = true; s.writes.push(value); writes.push(value);
      emit(this, "seeking");
    },
  });
  for (const name of ["paused", "seeking", "duration", "videoWidth", "videoHeight", "readyState", "error"] as const) define(name, { get(this: object) { return slot(this)[name]; } });
  // As in a browser: ended is a paused playhead at the end of the media.
  define("ended", { get(this: object) { const s = slot(this); return s.paused && Number.isFinite(s.duration) && s.duration > 0 && s.currentTime >= s.duration; } });
  for (const name of ["muted", "playbackRate"] as const) define(name, { get(this: object) { return slot(this)[name]; }, set(this: object, value: never) { (slot(this) as Record<string, unknown>)[name] = value; } });
  define("play", { value(this: HTMLVideoElement) {
    const s = slot(this);
    calls.push("play"); s.calls.push("play");
    const refusal = s.rejectPlay ?? nextRejection;
    if (refusal !== null) {
      s.rejectPlay = null; nextRejection = null;
      return Promise.reject(new DOMException("play() refused", refusal));
    }
    s.paused = false; emit(this, "play"); return Promise.resolve(); } });
  define("pause", { value(this: HTMLVideoElement) { calls.push("pause"); const s = slot(this); s.calls.push("pause"); if (!s.paused) { s.paused = true; emit(this, "pause"); } } });

  const rvfc = options.rvfc ?? true;
  if (rvfc) {
    define("requestVideoFrameCallback", { value(this: object, callback: FrameCallback) { const handle = nextHandle++; slot(this).callbacks.set(handle, callback); return handle; } });
    define("cancelVideoFrameCallback", { value(this: object, handle: number) { slot(this).callbacks.delete(handle); } });
  } else {
    delete proto.requestVideoFrameCallback;
    delete proto.cancelVideoFrameCallback;
  }

  return {
    writes,
    calls,
    rvfc,
    finishSeek(video) { slot(video).seeking = false; video.dispatchEvent(new Event("seeked")); },
    presentFrame(video, mediaTime) {
      const s = slot(video);
      const pending = [...s.callbacks.entries()];
      s.callbacks.clear();
      for (const [, callback] of pending) callback(0, { mediaTime });
    },
    pendingFrameCallbacks: (video) => slot(video).callbacks.size,
    loadMetadata(video, meta) {
      const s = slot(video);
      s.duration = meta.duration; s.videoWidth = meta.videoWidth ?? s.videoWidth; s.videoHeight = meta.videoHeight ?? s.videoHeight; s.readyState = 1;
      video.dispatchEvent(new Event("loadedmetadata"));
    },
    deliverEvents(count = Infinity, video) {
      let done = 0;
      for (let i = 0; i < queue.length && done < count;) {
        const entry = queue[i]!;
        if (video && entry.video !== video) { i++; continue; }
        queue.splice(i, 1);
        entry.video.dispatchEvent(new Event(entry.type));
        done++;
      }
      return done;
    },
    pendingEvents: (video) => (video ? queue.filter((e) => e.video === video).length : queue.length),
    callsOf: (video) => slot(video).calls,
    fireWaiting(video) { video.dispatchEvent(new Event("waiting")); },
    firePlaying(video) { video.dispatchEvent(new Event("playing")); },
    setReadyState(video, readyState) { slot(video).readyState = readyState; },
    rejectNextPlay(name, video) { if (video) slot(video).rejectPlay = name; else nextRejection = name; },
    fireError(video, code = 4, message = "MEDIA_ERR_SRC_NOT_SUPPORTED") { slot(video).error = { code, message }; video.dispatchEvent(new Event("error")); },
    advance(video, seconds) { slot(video).currentTime += seconds; },
    endPlayback(video) { const s = slot(video); s.paused = true; s.seeking = false; s.currentTime = s.duration; video.dispatchEvent(new Event("ended")); },
    endNaturally(video) { const s = slot(video); s.paused = true; s.seeking = false; s.currentTime = s.duration; emit(video, "pause"); emit(video, "ended"); },
    dispose() {
      queue.length = 0;
      for (const name of MEMBERS) {
        const original = saved.get(name);
        if (original) Object.defineProperty(proto, name, original);
        else delete proto[name];
      }
    },
  };
}
