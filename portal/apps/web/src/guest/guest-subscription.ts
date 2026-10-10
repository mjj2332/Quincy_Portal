import { useSyncExternalStore } from "react";
import type { Skipped } from "./use-guest-writer";
import type { WriteResult } from "./guest-api";

/** `value` is the guest's own choice once they have made one (null: show what the session said); `pending` while a PUT is out; `failed` after one that did not land and was not a page-level refusal. */
export type SubscriptionState = { value: boolean | null; pending: boolean; failed: boolean };

export type GuestSubscription = {
  get: () => SubscriptionState;
  subscribe: (listener: () => void) => () => void;
  /** A fresh session body arrived: forget the local choice (the server's answer is newer), unless a PUT is out. */
  reseed: () => void;
  /** Flip to `next` at once, send it, and keep it on success or restore `previous` on any other answer. */
  toggle: (next: boolean, previous: boolean, send: () => Promise<WriteResult | Skipped>) => Promise<void>;
};

/**
 * The email-updates switch's state (#741 15b). Created by `GuestApp`, so it lives as long as the link's page does and not as long as the notes panel: closing the phone drawer unmounts the
 * switch, and a pending toggle kept in component state went with it (docs/lessons.md, "Form lifetime is not component lifetime"). The page-level refusals (verification lost, the link gone,
 * the Project archived) are run by the shared writer's effects; this store only restores the switch for them.
 */
export function createGuestSubscription(): GuestSubscription {
  let state: SubscriptionState = { value: null, pending: false, failed: false };
  const listeners = new Set<() => void>();
  const set = (next: SubscriptionState) => { state = next; for (const listener of [...listeners]) listener(); };
  return {
    get: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reseed: () => { if (!state.pending && (state.value !== null || state.failed)) set({ value: null, pending: false, failed: false }); },
    toggle: async (next, previous, send) => {
      if (state.pending) return;
      set({ value: next, pending: true, failed: false });
      const answered = await send();
      const result = answered.kind === "stale" ? answered.result : answered;
      if (result.kind === "ok") { set({ value: next, pending: false, failed: false }); return; }
      const refused = result.kind === "unverified" || result.kind === "gone" || result.kind === "archived";
      set({ value: previous, pending: false, failed: !refused });
    },
  };
}

export function useSubscription(store: GuestSubscription): SubscriptionState {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
