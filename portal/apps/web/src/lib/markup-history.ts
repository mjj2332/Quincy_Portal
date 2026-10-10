import { strokesJsonBytes, type MarkupItem } from "@quincy/shared";

/**
 * Undo and redo for markup (#741 slice 6s-ui). Pure functions over reference snapshots of the item list: the hook that
 * hosts it (`use-markup.ts`) and the video form store (6b) both call these, so the rules are written once.
 *
 * The history is valid only while the live list IS its `anchor` (same reference). Any outside replacement of the list (a
 * save clearing the draft, an Edit-drawing preload, an asset change, Escape discarding the draft) breaks that identity and
 * the history is ignored from then on, so no caller has to remember to reset it.
 *
 * Every result is a new `{ strokes, history }` for the caller to store by value, or `null` when the step does not apply
 * or would break the budgets (so the earlier draft is kept).
 */
export const HISTORY_DEPTH = 100;

export interface MarkupLimits { items: number; bytes: number }
export interface MarkupHistory { anchor: readonly MarkupItem[]; past: MarkupItem[][]; future: MarkupItem[][] }
export interface MarkupStep { strokes: MarkupItem[]; history: MarkupHistory }

export function createHistory(anchor: readonly MarkupItem[]): MarkupHistory {
  return { anchor, past: [], future: [] };
}

/** The history to use for `current`: itself while it is still anchored there, an empty one otherwise. */
function valid(history: MarkupHistory, current: readonly MarkupItem[]): MarkupHistory {
  return history.anchor === current ? history : createHistory(current);
}

export function withinLimits(items: readonly MarkupItem[], limits: MarkupLimits): boolean {
  return items.length <= limits.items && strokesJsonBytes(items) <= limits.bytes;
}

/** Nothing to undo only when the list is empty and no earlier snapshot exists (a preloaded list can always be popped). */
export function canUndo(history: MarkupHistory, current: readonly MarkupItem[]): boolean {
  return current.length > 0 || valid(history, current).past.length > 0;
}

export function canRedo(history: MarkupHistory, current: readonly MarkupItem[]): boolean {
  return valid(history, current).future.length > 0;
}

function step(next: MarkupItem[], past: MarkupItem[][], future: MarkupItem[][]): MarkupStep {
  return { strokes: next, history: { anchor: next, past, future } };
}

/** A new list `next` replaces `current` (a finished draw, or a Clear). Empties redo. */
export function commit(history: MarkupHistory, current: MarkupItem[], next: MarkupItem[], limits: MarkupLimits): MarkupStep | null {
  if (!withinLimits(next, limits)) return null;
  const h = valid(history, current);
  return step(next, [...h.past, current].slice(-HISTORY_DEPTH), []);
}

/** Clear is a commit of the empty list, so one undo restores everything it removed. */
export function clearAll(history: MarkupHistory, current: MarkupItem[], limits: MarkupLimits): MarkupStep | null {
  return current.length === 0 ? null : commit(history, current, [], limits);
}

export function undo(history: MarkupHistory, current: MarkupItem[], limits?: MarkupLimits): MarkupStep | null {
  const h = valid(history, current);
  const previous = h.past[h.past.length - 1];
  if (previous) {
    if (limits && !withinLimits(previous, limits)) return null;
    return step(previous, h.past.slice(0, -1), [...h.future, current]);
  }
  if (current.length === 0) return null;
  // No snapshot (a preloaded list): pop the last item, which redo can bring back.
  const popped = current.slice(0, -1);
  return step(popped, [], [...h.future, current]);
}

export function redo(history: MarkupHistory, current: MarkupItem[], limits: MarkupLimits): MarkupStep | null {
  const h = valid(history, current);
  const following = h.future[h.future.length - 1];
  if (!following || !withinLimits(following, limits)) return null;
  return step(following, [...h.past, current].slice(-HISTORY_DEPTH), h.future.slice(0, -1));
}
