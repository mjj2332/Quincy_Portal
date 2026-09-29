import { defaultAnimateLayoutChanges, type AnimateLayoutChanges } from "@dnd-kit/sortable";

/**
 * The Board's reorder animation (#304) and the guard that goes with it.
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

/**
 * The misclick guard. The FLIP shows where a re-sorted card went, but a quick second click at the
 * same spot lands on whichever card slid under the pointer — a silent write to the wrong project's
 * priority. After a pointer star commit re-sorts the column, a pointer star commit on a DIFFERENT
 * card within `STAR_GUARD_RADIUS_PX` of the first, inside `STAR_GUARD_WINDOW_MS`, is dropped.
 * Keyboard commits are never pointer commits, so they are untouched; moving the pointer away
 * disarms it.
 */
export const STAR_GUARD_RADIUS_PX = 16;
/** `--dur-base` (220ms) of flight plus a double-click interval. */
export const STAR_GUARD_WINDOW_MS = 700;
/** How long after a pointer commit a re-sort still counts as that commit's. */
const STAR_GUARD_ARM_LATENCY_MS = 1_000;

export type StarPointerCommit = { projectId: string; x: number; y: number; at: number };
export type StarClickGuard = { projectId: string; x: number; y: number; until: number } | null;

export function armStarClickGuard(commit: StarPointerCommit | null, now: number): StarClickGuard {
  if (!commit || now - commit.at > STAR_GUARD_ARM_LATENCY_MS) return null;
  return { projectId: commit.projectId, x: commit.x, y: commit.y, until: now + STAR_GUARD_WINDOW_MS };
}

function within(guard: NonNullable<StarClickGuard>, point: { x: number; y: number }) {
  return Math.hypot(point.x - guard.x, point.y - guard.y) <= STAR_GUARD_RADIUS_PX;
}

export function shouldSwallowStarClick(guard: StarClickGuard, click: { projectId: string; x: number; y: number }, now: number): boolean {
  return guard !== null && now <= guard.until && click.projectId !== guard.projectId && within(guard, click);
}

export function guardAfterPointerMove(guard: StarClickGuard, point: { x: number; y: number }): StarClickGuard {
  return guard && within(guard, point) ? guard : null;
}
