/**
 * The state of a Version compare that must outlive the compare view (#741 7b): which pair is open, the frame offset of every pair
 * looked at, the layout, the wipe, which side is audible, mute, whether the notes column is open and which side's notes it shows.
 * One store per person and Project, held beside the note forms in the Video collection and retired with them (docs/lessons.md
 * "Form lifetime is not component lifetime"), so switching a side to another Version and back finds its offset where it was left.
 * It is `useSyncExternalStore`-compatible and imports nothing: the transport and the view both read it.
 */

export type CompareSideId = "a" | "b";
export type CompareMode = "side-by-side" | "wipe";
export type ComparePair = Readonly<{ a: string; b: string }>;

export type CompareState = Readonly<{
  pair: ComparePair | null;
  /** B frames, signed: positive means B starts that many frames later. Keyed `${a}:${b}`. */
  offsets: Readonly<Record<string, number>>;
  mode: CompareMode;
  /** The wipe position, 0..1 of the picture width. */
  wipe: number;
  audible: CompareSideId;
  muted: boolean;
  notesOpen: boolean;
  activeTab: CompareSideId;
}>;

export const pairKey = (pair: ComparePair): string => `${pair.a}:${pair.b}`;

/** The offset of the pair now open (0 for a pair never looked at, and when none is open). */
export const offsetOf = (state: CompareState): number => (state.pair ? (state.offsets[pairKey(state.pair)] ?? 0) : 0);

const INITIAL: CompareState = { pair: null, offsets: {}, mode: "side-by-side", wipe: 0.5, audible: "a", muted: false, notesOpen: false, activeTab: "a" };

export function createCompareStore(key: string) {
  let state: CompareState = INITIAL;
  let dead = false;
  const listeners = new Set<() => void>();
  const write = (next: Partial<CompareState>) => {
    if (dead) return;
    const merged = { ...state, ...next };
    if ((Object.keys(merged) as Array<keyof CompareState>).every((k) => merged[k] === state[k])) return;
    state = merged;
    for (const listener of [...listeners]) listener();
  };

  return {
    key,
    getState: (): CompareState => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Opens a pair. Its offset is whatever it was last left at (0 for a new pair). `audible` is the side to hear first. */
    setPair(a: string, b: string, audible: CompareSideId = "a") {
      if (state.pair && state.pair.a === a && state.pair.b === b) return;
      write({ pair: Object.freeze({ a, b }), audible, activeTab: "a" });
    },
    clearPair() { write({ pair: null }); },
    /** Stores the offset of the open pair. The transport has already checked it against `offsetBounds`. */
    setOffset(offset: number) {
      if (!state.pair || !Number.isInteger(offset)) return;
      write({ offsets: { ...state.offsets, [pairKey(state.pair)]: offset } });
    },
    setMode(mode: CompareMode) { write({ mode }); },
    setWipe(wipe: number) { if (Number.isFinite(wipe)) write({ wipe: Math.min(1, Math.max(0, wipe)) }); },
    setAudible(audible: CompareSideId) { write({ audible }); },
    setMuted(muted: boolean) { write({ muted }); },
    setNotesOpen(notesOpen: boolean) { write({ notesOpen }); },
    setActiveTab(activeTab: CompareSideId) { write({ activeTab }); },
    /** The Project tab is gone: drop everything and ignore later writes. */
    retire() { dead = true; state = INITIAL; listeners.clear(); },
  };
}

export type CompareStore = ReturnType<typeof createCompareStore>;
