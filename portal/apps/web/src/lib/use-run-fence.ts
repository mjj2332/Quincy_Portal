import { useLayoutEffect, useRef } from "react";

export interface RunTicket {
  /** Mounted, no later begin()/invalidate(), and the fence key still equals the key at begin(). */
  isCurrent(): boolean;
}

export interface RunFence {
  begin(): RunTicket;
  /** Retire every outstanding ticket without starting a run. */
  invalidate(): void;
}

interface State {
  generation: number;
  mounted: boolean;
  key: string | number | undefined;
  fence: RunFence;
}

/**
 * Guards the local presentation of an async run (what to set, close or toast
 * once a late response lands). Committed results should still converge caches;
 * only UI work belongs behind `isCurrent()`.
 *
 * A ticket goes stale on unmount, on a later `begin()`, on `invalidate()` and
 * on a change of `key`. A key change bumps the generation, so a ticket begun
 * under A stays stale after A -> B -> A.
 *
 * Pass a `key` only where the component is re-keyed on that same key. A key
 * change without a remount strands any `pending` state whose `finally` is
 * skipped by the stale ticket, so never key a component on a value that its
 * own write changes (the review status pill must not be keyed on the Version).
 *
 * The key is recorded in a layout effect, never during render: React can
 * discard a render, and a ref written during it carries the abandoned value.
 */
export function useRunFence(key?: string | number): RunFence {
  const ref = useRef<State | null>(null);
  if (ref.current === null) {
    const state: State = {
      generation: 0,
      mounted: false,
      key,
      fence: null as unknown as RunFence,
    };
    state.fence = {
      begin() {
        const generation = ++state.generation;
        return { isCurrent: () => state.mounted && state.generation === generation };
      },
      invalidate() {
        state.generation += 1;
      },
    };
    ref.current = state;
  }
  const state = ref.current;

  useLayoutEffect(() => {
    if (state.key !== key) {
      state.key = key;
      state.generation += 1;
    }
  }, [state, key]);

  useLayoutEffect(() => {
    state.mounted = true;
    return () => {
      state.mounted = false;
      state.generation += 1;
    };
  }, [state]);

  return state.fence;
}
