import { useCallback, useEffect, useRef, type MouseEvent, type PointerEvent } from "react";
import type { ProjectSummary } from "./kanban-interaction";

/**
 * The Board's misclick guard (#304). The reorder FLIP (`lib/kanban-flip.ts`) shows where a
 * re-sorted card went, but a quick second click at the same spot lands on whichever card slid under
 * the pointer — a silent write to the wrong project's priority. After a pointer star commit moves
 * its card (slid or, under reduced motion, jumped), a pointer star commit on a DIFFERENT card within `STAR_GUARD_RADIUS_PX` of the first,
 * inside `STAR_GUARD_WINDOW_MS`, is dropped. Keyboard commits are never pointer commits, so they are
 * untouched; moving the pointer away or scrolling anything disarms it.
 */
export const STAR_GUARD_RADIUS_PX = 16;
/** One `--dur-base` flight plus a double-click interval. */
export const STAR_GUARD_WINDOW_MS = 700;
/**
 * How long after a pointer commit its card's move still counts as that commit's. The optimistic
 * overlay (#232) re-sorts on the very next render, so this only has to outlast a slow frame.
 */
const STAR_GUARD_ARM_LATENCY_MS = 1_000;

export type Point = { x: number; y: number };
export type StarClick = Point & { projectId: string };
export type StarPointerCommit = StarClick & { at: number };
export type StarClickGuard = StarClick & { until: number };

/** Arms only when the move that just played carried the committed card itself. */
export function armStarClickGuard(commit: StarPointerCommit | null, movedIds: readonly string[], now: number): StarClickGuard | null {
  if (!commit || now - commit.at > STAR_GUARD_ARM_LATENCY_MS || !movedIds.includes(commit.projectId)) return null;
  return { projectId: commit.projectId, x: commit.x, y: commit.y, until: now + STAR_GUARD_WINDOW_MS };
}

function within(guard: StarClickGuard, point: Point) {
  return Math.hypot(point.x - guard.x, point.y - guard.y) <= STAR_GUARD_RADIUS_PX;
}

export function shouldSwallowStarClick(guard: StarClickGuard | null, click: StarClick, now: number): boolean {
  return guard !== null && now <= guard.until && click.projectId !== guard.projectId && within(guard, click);
}

export function guardAfterPointerMove(guard: StarClickGuard | null, point: Point): StarClickGuard | null {
  return guard && within(guard, point) ? guard : null;
}

/**
 * The guard as the Board wires it. A star commits on `click`, and only a click carries a point, so
 * the point is recorded in the capture phase and forgotten in the Board's own bubble-phase
 * `onClick`, which runs after the star's. Not in a microtask: React dispatches capture and bubble
 * from two separate native listeners, and on a real click the microtask queue drains between them —
 * the point would be gone before the star read it. A keydown also forgets it, so a click that some
 * inner handler stopped short of the Board can never make a later keyboard commit look like a
 * pointer one.
 */
export function useStarClickGuard(onPriorityChange: ((project: ProjectSummary, priority: number | null) => void) | undefined) {
  const clickPointRef = useRef<Point | null>(null);
  const lastPointerCommitRef = useRef<StarPointerCommit | null>(null);
  const guardRef = useRef<StarClickGuard | null>(null);

  // Any scroll — wheel, touch, the Board's scrollbar, the keyboard, the page — moves the cards under
  // a still pointer, so the armed spot no longer means the card it did.
  useEffect(() => {
    const disarm = () => { guardRef.current = null; };
    window.addEventListener("scroll", disarm, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", disarm, { capture: true });
  }, []);

  const forgetClickPoint = useCallback(() => { clickPointRef.current = null; }, []);
  const boardHandlers = {
    onClickCapture: useCallback((event: MouseEvent) => { clickPointRef.current = { x: event.clientX, y: event.clientY }; }, []),
    onClick: forgetClickPoint,
    onKeyDownCapture: forgetClickPoint,
    onPointerMoveCapture: useCallback((event: PointerEvent) => {
      if (guardRef.current) guardRef.current = guardAfterPointerMove(guardRef.current, { x: event.clientX, y: event.clientY });
    }, []),
  };

  const onCardsMoved = useCallback((movedIds: readonly string[]) => {
    const guard = armStarClickGuard(lastPointerCommitRef.current, movedIds, performance.now());
    if (!guard) return;
    guardRef.current = guard;
    lastPointerCommitRef.current = null;
  }, []);

  const handlePriorityChange = useCallback((project: ProjectSummary, priority: number | null) => {
    const click = clickPointRef.current;
    const now = performance.now();
    if (click) {
      if (shouldSwallowStarClick(guardRef.current, { projectId: project.id, ...click }, now)) return;
      lastPointerCommitRef.current = { projectId: project.id, ...click, at: now };
    } else {
      lastPointerCommitRef.current = null;
    }
    onPriorityChange?.(project, priority);
  }, [onPriorityChange]);

  return { boardHandlers, onCardsMoved, handlePriorityChange };
}
