import { useSyncExternalStore } from "react";

/** An inline note form the guest has open: a reply (`noteId` null) or an edit of one note of the thread (`noteId`). `rev` moves on every change, so a completion can tell whether the draft it sent is still the draft on show. */
export type NoteDraft = { noteId: string | null; text: string; baseRevision: number | null; rev: number };

export type GuestDrafts = {
  get: (key: string) => NoteDraft | null;
  set: (key: string, draft: Omit<NoteDraft, "rev">) => void;
  clear: (key: string) => void;
  /** Clears the draft only if it is still the one with this `rev` (a completion for a draft that was edited since leaves the newer text alone). */
  clearIf: (key: string, rev: number) => void;
  subscribe: (listener: () => void) => () => void;
};

/**
 * The guest's inline reply and reply-edit drafts (#741 13c). Created by `GuestApp`, so it lives as long as the link's page does, not as long as the notes list: closing the phone drawer or a
 * re-verification unmounts the list, and a draft kept in component state went with it (docs/lessons.md, "Form lifetime is not component lifetime"). Keys are `reply:<thread id>` and
 * `edit:<thread id>`; a draft is removed only by Cancel or a successful submit. One link per page load, so there is nothing to retire when the session is refreshed.
 */
export function createGuestDrafts(): GuestDrafts {
  const drafts = new Map<string, NoteDraft>();
  const listeners = new Set<() => void>();
  let counter = 0;
  const emit = () => { for (const listener of [...listeners]) listener(); };
  return {
    get: (key) => drafts.get(key) ?? null,
    set: (key, draft) => { counter += 1; drafts.set(key, { ...draft, rev: counter }); emit(); },
    clear: (key) => { if (drafts.delete(key)) emit(); },
    clearIf: (key, rev) => { if (drafts.get(key)?.rev === rev) { drafts.delete(key); emit(); } },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export function useNoteDraft(drafts: GuestDrafts, key: string): NoteDraft | null {
  return useSyncExternalStore(drafts.subscribe, () => drafts.get(key), () => null);
}
