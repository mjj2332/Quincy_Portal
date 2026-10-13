import { useCallback, useRef, useSyncExternalStore } from "react";

/**
 * Per-browser UI preferences (#859): a layout choice a viewer makes once and expects to find again (the review notes pane's width, #860's
 * readout), kept in `localStorage` as JSON under `quincy:ui:<name>`. One key per browser, never per principal: a Review-link guest has no
 * principal, and "per browser" is the settled scope. Storage is injected, in the shape of `Pick<Storage, ...>`, so the pure half stays testable;
 * the accessor itself can throw (blocked site data), so every read and write sits in a try/catch and the in-memory choice stands for the session.
 *
 * Guest-safe on purpose: it imports React and nothing else (see `guest/guest-boundary.guard.test.ts`).
 */
export type UiPrefStorage = Pick<Storage, "getItem" | "setItem">;

export const uiPrefKey = (name: string): string => `quincy:ui:${name}`;

const browserStorage = (): UiPrefStorage | null => { try { return window.localStorage; } catch { return null; } };

/** Choices whose write failed (storage blocked): the session keeps them. A successful write removes the entry. */
const memory = new Map<string, string>();
export function resetUiPrefMemory(): void { memory.clear(); }

function readRaw(key: string, storage: UiPrefStorage | null): string | null {
  const kept = memory.get(key);
  if (kept !== undefined) return kept;
  try { return storage ? storage.getItem(key) : null; } catch { return null; }
}

function parse<T>(raw: string | null, normalize: (raw: unknown) => T): T {
  if (raw === null) return normalize(undefined);
  try { return normalize(JSON.parse(raw)); } catch { return normalize(undefined); }
}

export function readUiPref<T>(key: string, normalize: (raw: unknown) => T, storage: UiPrefStorage | null = browserStorage()): T {
  return parse(readRaw(key, storage), normalize);
}

export function writeUiPref<T>(key: string, value: T, normalize: (raw: unknown) => T, storage: UiPrefStorage | null = browserStorage()): void {
  const raw = JSON.stringify(normalize(value));
  try {
    if (!storage) throw new Error("no storage");
    storage.setItem(key, raw);
    memory.delete(key);
  } catch {
    // A per-viewer convenience: the choice stands in memory for this session.
    memory.set(key, raw);
  }
}

const listeners = new Map<string, Set<() => void>>();
const notify = (key: string) => { listeners.get(key)?.forEach((listener) => { listener(); }); };

/**
 * The value under `key`, normalised, plus a setter that persists it and re-renders every reader of the key in this tab (so two components share one value).
 * `normalize` must be a stable function (module level). The setter is inert once `key` has changed since it was handed out (the #431 rule for per-user keys).
 */
export function useUiPref<T>(key: string, normalize: (raw: unknown) => T): [T, (next: T) => void] {
  const cache = useRef<{ key: string; raw: string | null; value: T } | null>(null);
  const snapshot = useCallback((): T => {
    const raw = readRaw(key, browserStorage());
    const held = cache.current;
    if (held && held.key === key && held.raw === raw) return held.value;
    const value = parse(raw, normalize);
    cache.current = { key, raw, value };
    return value;
  }, [key, normalize]);
  const subscribe = useCallback((onChange: () => void) => {
    let set = listeners.get(key);
    if (!set) { set = new Set(); listeners.set(key, set); }
    set.add(onChange);
    const onStorage = (event: StorageEvent) => { if (event.key === key || event.key === null) onChange(); };
    window.addEventListener("storage", onStorage);
    return () => { set.delete(onChange); window.removeEventListener("storage", onStorage); };
  }, [key]);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  const live = useRef(key);
  live.current = key;
  const set = useCallback((next: T) => {
    if (live.current !== key) return;
    writeUiPref(key, next, normalize);
    notify(key);
  }, [key, normalize]);
  return [value, set];
}
