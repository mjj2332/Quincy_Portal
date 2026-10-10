import { useCallback, useRef, type Dispatch, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";
import type { FreehandPoint, MarkupItem } from "@quincy/shared";

/**
 * Pointer-to-stroke capture for freehand markup (#741 slice 6a, extracted from the photo Lightbox with no change in
 * behaviour). It is data and commands only: it knows nothing about auth, routes, permissions or where the picture is.
 * The caller owns the strokes (controlled), the pen, and the point mapping.
 *
 * The defaults are the Lightbox's, quirks included, and the characterisation tests pin them:
 * - `toPoint` is called at POINTER time, so a caller that reads a zoomed frame's live rect gets the live transform.
 * - A down appends a one-point stroke; a move extends the LAST stroke through the functional setter; an up or a
 *   pointer leave ends the gesture. There is no pointer-id filtering, so a second finger extends the newest stroke.
 * - preventDefault + stopPropagation run before anything async; pointer capture is taken after the gate, and only
 *   when the gate lets the gesture start.
 * - `beforeStart` may answer synchronously (the common path stays synchronous) or with a promise. A promise that
 *   resolves false ends the gesture without a stroke: the pointer was released while a modal was open, so the NEXT
 *   fresh pointer-down draws.
 */
/** What a point mapper may read from a pointer event. */
export type PointerSample = Pick<PointerEvent, "clientX" | "clientY">;

export interface UseFreehandMarkupOptions {
  /** False makes every handler a no-op (the photographer role never draws). */
  enabled: boolean;
  tool: { color: string; width: number };
  toPoint: (event: PointerSample) => FreehandPoint;
  setStrokes: Dispatch<SetStateAction<MarkupItem[]>>;
  /** Return true to start the stroke now, or a promise of whether to start it once a confirmation settles. */
  beforeStart?: (event: ReactPointerEvent<Element>) => boolean | Promise<boolean>;
}

export interface FreehandMarkupHandlers {
  onPointerDown: (event: ReactPointerEvent<Element>) => void | Promise<void>;
  onPointerMove: (event: ReactPointerEvent<Element>) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
}

export function useFreehandMarkup({ enabled, tool, toPoint, setStrokes, beforeStart }: UseFreehandMarkupOptions) {
  const drawingRef = useRef(false);

  const end = () => { drawingRef.current = false; };

  const begin = (event: ReactPointerEvent<Element>, target: Element) => {
    drawingRef.current = true;
    setStrokes((current) => [...current, { color: tool.color, width: tool.width, points: [toPoint(event)] }]);
    target.setPointerCapture(event.pointerId);
  };

  const onPointerDown = (event: ReactPointerEvent<Element>): void | Promise<void> => {
    if (!enabled) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    const gate = beforeStart ? beforeStart(event) : true;
    if (gate === true) { begin(event, target); return; }
    if (gate === false) return;
    return gate.then((proceed) => { if (proceed) begin(event, target); });
  };

  const onPointerMove = (event: ReactPointerEvent<Element>) => {
    if (!enabled || !drawingRef.current) return;
    const point = toPoint(event);
    setStrokes((current) => {
      if (!current.length) return current;
      const next = current.slice();
      const last = next[next.length - 1]!;
      if (last.type !== undefined) return current; // only the freehand stroke this hook began is extended; a preloaded shape is left alone
      next[next.length - 1] = { ...last, points: [...last.points, point] };
      return next;
    });
  };

  const undo = useCallback(() => setStrokes((current) => current.slice(0, -1)), [setStrokes]);
  const clear = useCallback(() => setStrokes([]), [setStrokes]);

  const handlers: FreehandMarkupHandlers = { onPointerDown, onPointerMove, onPointerUp: end, onPointerLeave: end };
  return { handlers, undo, clear };
}
