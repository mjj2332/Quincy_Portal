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
  /** Whether `requestVideoFrameCallback` is installed. */
  rvfc: boolean;
  dispose(): void;
};

const MEMBERS = ["currentTime", "paused", "seeking", "duration", "videoWidth", "videoHeight", "muted", "playbackRate", "readyState", "play", "pause", "requestVideoFrameCallback", "cancelVideoFrameCallback"] as const;

export function installVideoElementStub(options: { rvfc?: boolean } = {}): VideoElementStub {
  const proto = HTMLVideoElement.prototype as unknown as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const name of MEMBERS) saved.set(name, Object.getOwnPropertyDescriptor(proto, name));
  const slots = new WeakMap<object, Slot>();
  const writes: number[] = [];
  const calls: string[] = [];
  let nextHandle = 1;

  const slot = (element: object): Slot => {
    let found = slots.get(element);
    if (!found) {
      found = { currentTime: 0, paused: true, seeking: false, duration: NaN, videoWidth: 0, videoHeight: 0, muted: false, playbackRate: 1, readyState: 0, writes: [], callbacks: new Map() };
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
      this.dispatchEvent(new Event("seeking"));
    },
  });
  for (const name of ["paused", "seeking", "duration", "videoWidth", "videoHeight", "readyState"] as const) define(name, { get(this: object) { return slot(this)[name]; } });
  for (const name of ["muted", "playbackRate"] as const) define(name, { get(this: object) { return slot(this)[name]; }, set(this: object, value: never) { (slot(this) as Record<string, unknown>)[name] = value; } });
  define("play", { value(this: HTMLVideoElement) { calls.push("play"); const s = slot(this); s.paused = false; this.dispatchEvent(new Event("play")); return Promise.resolve(); } });
  define("pause", { value(this: HTMLVideoElement) { calls.push("pause"); const s = slot(this); if (!s.paused) { s.paused = true; this.dispatchEvent(new Event("pause")); } } });

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
    advance(video, seconds) { slot(video).currentTime += seconds; },
    endPlayback(video) { const s = slot(video); s.paused = true; video.dispatchEvent(new Event("ended")); },
    dispose() {
      for (const name of MEMBERS) {
        const original = saved.get(name);
        if (original) Object.defineProperty(proto, name, original);
        else delete proto[name];
      }
    },
  };
}
