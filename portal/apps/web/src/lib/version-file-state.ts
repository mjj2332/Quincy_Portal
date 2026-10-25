import { useCallback, useSyncExternalStore } from "react";

/**
 * A file offered as a film's next Version (#939, settled plan S12): whether it is still being checked, and the reason it was refused. Kept per film in one store the Video
 * collection panel owns, not in the component that took the file: a Video row's "⋯" menu (which shows "Checking…"), its drop target and its upload line live in different
 * grid cells, and the tile and the row must read the same state. A film with nothing to say is not in the store.
 */
export type VersionFileState = { readonly checking: boolean; readonly message: string | null };
export type VersionFileStore = {
  /** One film's state; the same object until it changes. */
  get: (videoId: string) => VersionFileState;
  /** Every film that is checking or was refused; a new map on every change. */
  all: () => ReadonlyMap<string, VersionFileState>;
  subscribe: (listener: () => void) => () => void;
  /** Clears the film's last refusal and checks the file: `check` resolves `null` once the server holds the upload, else the reason it was refused. Only the newest send writes. */
  send: (videoId: string, check: () => Promise<string | null>) => void;
};

export const IDLE_VERSION_FILE: VersionFileState = Object.freeze({ checking: false, message: null });

export function createVersionFileState(): VersionFileStore {
  let states: ReadonlyMap<string, VersionFileState> = new Map();
  const sends = new Map<string, number>();
  const listeners = new Set<() => void>();
  const write = (videoId: string, next: VersionFileState) => {
    const copy = new Map(states);
    if (!next.checking && next.message === null) copy.delete(videoId); else copy.set(videoId, next);
    states = copy;
    for (const listener of [...listeners]) listener();
  };
  return {
    get: (videoId) => states.get(videoId) ?? IDLE_VERSION_FILE,
    all: () => states,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    send: (videoId, check) => {
      const send = (sends.get(videoId) ?? 0) + 1;
      sends.set(videoId, send);
      const newest = () => sends.get(videoId) === send;
      write(videoId, { checking: true, message: null });
      let answered = false;
      void check()
        .then((message) => { answered = true; if (newest()) write(videoId, { checking: false, message }); })
        // A check that throws refuses nothing it can name: the film is idle again (as the tile always was), and the rejection still surfaces.
        .finally(() => { if (!answered && newest()) write(videoId, IDLE_VERSION_FILE); });
    },
  };
}

/** One film's state, for its tile. */
export function useVersionFile(store: VersionFileStore, videoId: string): VersionFileState {
  const get = useCallback(() => store.get(videoId), [store, videoId]);
  return useSyncExternalStore(store.subscribe, get, get);
}

/** Every film's state, for the Video rows, which map all films at once. */
export function useVersionFiles(store: VersionFileStore): ReadonlyMap<string, VersionFileState> {
  return useSyncExternalStore(store.subscribe, store.all, store.all);
}
