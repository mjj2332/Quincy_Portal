import { defaultAnimateLayoutChanges, type AnimateLayoutChanges } from "@dnd-kit/sortable";

/**
 * The Board's reorder animation (#304). Its misclick guard is `lib/star-click-guard.ts`.
 *
 * A same-column reorder outside a drag — a Priority re-sort from the optimistic overlay (#232),
 * the ↑/↓ arrows, a same-Stage Move to…, a rollback — used to paint in one frame: the card jumped
 * one or more card heights, leaving the pointer. dnd-kit's own layout animation does not cover
 * this (see `boardAnimateLayoutChanges`), so the Board plays a FLIP on a wrapper it owns inside
 * each `KanbanItem`: read every card's position before the commit, read it again after, start each
 * moved card at its old position and ease it to the new one.
 */

/** A card's viewport position, and the column it sat in when measured. */
export type FlipRect = { column: string; left: number; top: number };
export type FlipSnapshot = Map<string, FlipRect>;
export type FlipDelta = { id: string; dx: number; dy: number };

/** Below this a delta is layout rounding, not a move. */
const FLIP_MIN_DELTA_PX = 0.5;

/**
 * The inverse offset for every card that moved within its own column, in `after` order. A card
 * that changed column, or was not there before, is skipped: a cross-Stage move remounts the card
 * in another column, and flying it across the Board is not this animation's job.
 */
export function flipDeltas(before: FlipSnapshot, after: FlipSnapshot): FlipDelta[] {
  const deltas: FlipDelta[] = [];
  for (const [id, next] of after) {
    const previous = before.get(id);
    if (!previous || previous.column !== next.column) continue;
    const dx = previous.left - next.left;
    const dy = previous.top - next.top;
    if (Math.abs(dx) < FLIP_MIN_DELTA_PX && Math.abs(dy) < FLIP_MIN_DELTA_PX) continue;
    deltas.push({ id, dx, dy });
  }
  return deltas;
}

/**
 * Plays one card's FLIP and returns a cancel. A CSS transition, never `element.animate`: the global
 * reduced-motion rule in `styles/app.css` can only reach CSS motion (see
 * `ProductionEventCalendar.focus-motion.guard.test.ts`), and the Board also skips the FLIP outright
 * under reduced motion. The forced reflow is what separates the inverted frame from the eased one;
 * without it the browser coalesces both writes and nothing moves.
 *
 * `z-index` lifts the flying card over the neighbours it passes; the wrapper is `relative`.
 */
export function playFlip(element: HTMLElement, dx: number, dy: number): () => void {
  const { style } = element;
  const clear = () => {
    element.removeEventListener("transitionend", onEnd);
    style.transition = "";
    style.transform = "";
    style.zIndex = "";
  };
  function onEnd() { clear(); }
  style.transition = "none";
  style.transform = `translate(${dx}px, ${dy}px)`;
  style.zIndex = "1";
  element.getBoundingClientRect();
  style.transition = "transform var(--dur-base) var(--ease-standard)";
  style.transform = "";
  element.addEventListener("transitionend", onEnd);
  return clear;
}

/**
 * `KanbanItem`'s layout-animation predicate on this Board. The vendored default forces
 * `wasDragging: true`, and outside a drag dnd-kit's `newIndex` is whatever the LAST drag left
 * behind (`@dnd-kit/sortable` `useSortable`: it is only written while sorting), so a non-drag
 * reorder either paints in one frame or is offset from a stale droppable rect — and it would stack
 * with the Board's FLIP on the same card. Outside a drag and dnd-kit's own 50ms settle window, the
 * FLIP owns the motion; inside them the vendor's behaviour is unchanged.
 */
export const boardAnimateLayoutChanges: AnimateLayoutChanges = (args) => {
  if (!args.isSorting && !args.wasDragging) return false;
  return defaultAnimateLayoutChanges({ ...args, wasDragging: true });
};
