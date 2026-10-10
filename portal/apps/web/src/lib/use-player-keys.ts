import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { playerKeyAction, type PlayerKeyAction } from "./video-player-keys";
import { nextShuttleRate } from "./video-shuttle";

/**
 * What the player keys drive (#741 7a): one transport. The single player binds its frame clock; a compare transport (7c) can bind
 * both sides behind the same shape. Read at keydown, so `rate` and `markFrame` must be current when called.
 */
export type PlayerKeyTarget = {
  /** Signed shuttle rate: 0 paused, negative the emulated reverse. */
  readonly rate: number;
  play(): void;
  pause(): void;
  /** Plays forward at `rate` (1, 2, 4, 8). */
  setRate(rate: number): void;
  /** Emulated reverse at `speed` (1, 2, 4, 8). */
  reverse(speed: number): void;
  /** Moves `delta` frames. */
  step(delta: number): void;
  home(): void;
  end(): void;
  /** The frame on screen for an I / O mark: while playing the one last presented; paused, the one a seek in flight is bringing. */
  markFrame(): number;
};

/**
 * The player's keyboard (J / K / L shuttle, the K-held chord, Space, arrows, Home / End, I / O marks), bound to a `PlayerKeyTarget`.
 * Returns a stable keydown handler: true when the key was the player's (and has been prevented). Without `onMark`, I and O are not bound.
 *
 * K is down: J / L step a frame (the NLE chord). K pauses at once when playing; from paused it waits, so a K + J / K + L chord never
 * starts playback, and a lone K press toggles on keyup. Cleared by its keyup anywhere, and by losing focus (which never toggles).
 * `locked` (drawing, #741 6b-ui) hands every key back: nothing moves the frame under the pen, and a K already held is forgotten so its
 * keyup cannot restart playback.
 */
export function usePlayerKeys(target: PlayerKeyTarget, onMark?: (kind: "in" | "out", frame: number) => void, locked = false): (event: KeyboardEvent | ReactKeyboardEvent) => boolean {
  const targetRef = useRef(target);
  targetRef.current = target;
  const onMarkRef = useRef(onMark);
  onMarkRef.current = onMark;
  const marksBound = onMark !== undefined;
  const marksBoundRef = useRef(marksBound);
  marksBoundRef.current = marksBound;

  const apply = useCallback((action: PlayerKeyAction) => {
    const t = targetRef.current;
    switch (action.type) {
      case "toggle": if (nextShuttleRate(t.rate, "toggle") === 0) t.pause(); else t.play(); break;
      case "forward": {
        const next = nextShuttleRate(t.rate, "forward");
        if (next === 0) t.pause(); else if (next > 0) t.setRate(next); else t.reverse(-next);
        break;
      }
      case "reverse": {
        const next = nextShuttleRate(t.rate, "reverse");
        if (next === 0) t.pause(); else if (next < 0) t.reverse(-next); else t.setRate(next);
        break;
      }
      case "step": t.step(action.delta); break;
      case "home": t.home(); break;
      case "end": t.end(); break;
    }
  }, []);

  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const kHeld = useRef<{ fromPaused: boolean; chord: boolean } | null>(null);
  useEffect(() => { if (locked) kHeld.current = null; }, [locked]);
  useEffect(() => {
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "k" && event.key !== "K") return;
      const held = kHeld.current;
      kHeld.current = null;
      if (held && held.fromPaused && !held.chord) apply({ type: "toggle" });
    };
    const release = () => { kHeld.current = null; };
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", release);
    return () => { document.removeEventListener("keyup", onKeyUp); window.removeEventListener("blur", release); };
  }, [apply]);

  return useCallback((event: KeyboardEvent | ReactKeyboardEvent): boolean => {
    if (lockedRef.current) { kHeld.current = null; return false; }
    const t = targetRef.current;
    const native = "nativeEvent" in event ? event.nativeEvent : event;
    const action = playerKeyAction(native, { k: kHeld.current !== null, marks: marksBoundRef.current });
    if (!action) return false;
    event.preventDefault();
    if (action.type === "mark") {
      onMarkRef.current?.(action.kind, t.markFrame());
      return true;
    }
    const isK = native.key === "k" || native.key === "K";
    if (isK) {
      const playing = nextShuttleRate(t.rate, "toggle") === 0;
      kHeld.current = { fromPaused: !playing, chord: false };
      if (playing) apply(action);
      return true;
    }
    if (action.type === "step" && kHeld.current && (native.key === "j" || native.key === "J" || native.key === "l" || native.key === "L")) {
      kHeld.current.chord = true;
      t.pause();
    }
    apply(action);
    return true;
  }, [apply]);
}
