import { useCallback, useEffect, useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";
import { STROKE_LIMITS, type FreehandPoint, type MarkupItem, type MarkupShapeKind } from "@quincy/shared";
import { canRedo, canUndo, clearAll, commit, createHistory, redo, undo, type MarkupHistory, type MarkupLimits, type MarkupStep } from "./markup-history";

/**
 * Pointer-to-markup capture and undo/redo for markup drawn over a picture (#741 slices 6a and 6s-ui). Data and commands
 * only: it knows nothing about auth, routes, permissions or where the picture is. The caller owns the committed list
 * (controlled), the tool, and the point mapping; the hook owns the one item being drawn (`active`) and the history.
 *
 * - The item in progress lives in `active` and is committed BY VALUE on pointer up (or pointer leave), so a shape previews
 *   live without flickering into the caller's list and every undo step is exact. The caller renders `strokes`, then `active`.
 * - A gesture follows ONE pointer: a second `pointerId` is ignored from down to up.
 * - `toPoint` is called at POINTER time, so a caller that reads a zoomed frame's live rect gets the live transform. A
 *   non-finite point (a zero-size frame) is ignored.
 * - preventDefault + stopPropagation run before anything async; pointer capture is taken after the gate, and only when the
 *   gate lets the gesture start. `beforeStart` may answer synchronously or with a promise; a promise of false consumes the
 *   gesture (the pointer was released while a modal was open), so the NEXT fresh pointer-down draws.
 * - Freehand: down starts `[p]`, moves append, up commits (a tap is a one-point dot). A shape: down starts `[p, p]`, moves
 *   set the end, up takes its position as the end and commits only when dragged at least 8 px (a rectangle 6 px a side).
 * - pointercancel and a lost capture DISCARD the unfinished item; pointerleave FINISHES it at the last valid point.
 * - Undo, redo and Clear go through `markup-history.ts`, are no-ops mid-gesture, and every commit or restore must fit
 *   `limits` (a gesture that would not is refused and the earlier draft kept).
 */
/** What a point mapper may read from a pointer event. */
export type PointerSample = Pick<PointerEvent, "clientX" | "clientY">;

export type MarkupToolKind = "freehand" | MarkupShapeKind;
export interface MarkupTool { kind: MarkupToolKind; color: string; width: number }

/** Smallest committed shape, in client pixels: a line or arrow's end-to-end length, and each side of a rectangle. */
export const MIN_SHAPE_LENGTH_PX = 8;
export const MIN_RECT_SIDE_PX = 6;

export interface UseMarkupOptions {
  /** False makes every handler a no-op (the photographer role never draws). */
  enabled: boolean;
  tool: MarkupTool;
  toPoint: (event: PointerSample) => FreehandPoint;
  /** The committed list. The history is valid only while this is the very array the hook last stored. */
  strokes: MarkupItem[];
  setStrokes: Dispatch<SetStateAction<MarkupItem[]>>;
  /** Return true to start now, or a promise of whether to start once a confirmation settles. */
  beforeStart?: (event: ReactPointerEvent<Element>) => boolean | Promise<boolean>;
  /** Caps a commit, undo or redo must fit. Defaults to the item cap and no byte cap. */
  limits?: MarkupLimits;
  /**
   * Controlled history: when given, the undo and redo steps live with the caller (a form store that outlives this component) instead of in the hook. `value` null = no steps yet.
   * Omitted = the hook keeps its own, exactly as before (the photo Lightbox).
   */
  history?: { value: MarkupHistory | null; set: (next: MarkupHistory) => void };
  /** Called when a gesture or a restore was refused for the limits. */
  onRefuse?: () => void;
}

export interface MarkupHandlers {
  onPointerDown: (event: ReactPointerEvent<Element>) => void | Promise<void>;
  onPointerMove: (event: ReactPointerEvent<Element>) => void;
  onPointerUp: (event: ReactPointerEvent<Element>) => void;
  onPointerCancel: (event: ReactPointerEvent<Element>) => void;
  onLostPointerCapture: (event: ReactPointerEvent<Element>) => void;
  onPointerLeave: (event: ReactPointerEvent<Element>) => void;
}

interface Gesture { pointerId: number; item: MarkupItem; startX: number; startY: number; lastX: number; lastY: number }

const isFinitePoint = (point: FreehandPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);
const DEFAULT_LIMITS: MarkupLimits = { items: STROKE_LIMITS.strokes, bytes: Number.POSITIVE_INFINITY };

function shapeLongEnough(item: MarkupItem, dx: number, dy: number): boolean {
  if (item.type === undefined) return true;
  if (item.type === "rectangle") return Math.abs(dx) >= MIN_RECT_SIDE_PX && Math.abs(dy) >= MIN_RECT_SIDE_PX;
  return Math.hypot(dx, dy) >= MIN_SHAPE_LENGTH_PX;
}

export function useMarkup({ enabled, tool, toPoint, strokes, setStrokes, beforeStart, limits = DEFAULT_LIMITS, onRefuse, history: external }: UseMarkupOptions) {
  const [active, setActiveState] = useState<MarkupItem | null>(null);
  const [ownHistory, setOwnHistory] = useState<MarkupHistory>(() => createHistory(strokes));
  const history = external ? external.value ?? createHistory(strokes) : ownHistory;
  const gestureRef = useRef<Gesture | null>(null);
  // A start waiting on an async gate: live until its pointer ends, the hook is cancelled or disabled, or it unmounts.
  const pendingRef = useRef<{ token: number; pointerId: number } | null>(null);
  const tokenRef = useRef(0);
  // Latest-value refs so two events dispatched before a re-render still see each other's result.
  const strokesRef = useRef(strokes); strokesRef.current = strokes;
  const historyRef = useRef(history); historyRef.current = history;
  // `setStrokes` is read from here too: undo, redo and Clear are stable callbacks, and a caller that retargets the list (another form) must be obeyed by them.
  const latest = useRef({ tool, toPoint, limits, onRefuse, enabled, setStrokes, setExternal: external?.set }); latest.current = { tool, toPoint, limits, onRefuse, enabled, setStrokes, setExternal: external?.set };
  const setHistoryState = (next: MarkupHistory) => { if (latest.current.setExternal) latest.current.setExternal(next); else setOwnHistory(next); };

  const setActive = (item: MarkupItem | null) => { setActiveState(item); };
  const apply = (result: MarkupStep) => {
    strokesRef.current = result.strokes; historyRef.current = result.history;
    latest.current.setStrokes(result.strokes); setHistoryState(result.history);
  };
  const discard = useCallback(() => { gestureRef.current = null; pendingRef.current = null; setActiveState(null); }, []);

  // Turning drawing off (a role change) abandons a gesture in flight.
  useEffect(() => { if (!enabled) discard(); }, [enabled, discard]);
  useEffect(() => discard, [discard]);

  const begin = (event: ReactPointerEvent<Element>, target: Element) => {
    const { tool: current, toPoint: mapPoint, limits: caps, onRefuse: refuse } = latest.current;
    const point = mapPoint(event);
    if (!isFinitePoint(point)) return;
    if (strokesRef.current.length >= caps.items) { refuse?.(); return; }
    const pair: [FreehandPoint, FreehandPoint] = [point, point];
    const item: MarkupItem = current.kind === "freehand"
      ? { color: current.color, width: current.width, points: [point] }
      : { type: current.kind, color: current.color, width: current.width, points: pair };
    gestureRef.current = { pointerId: event.pointerId, item, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY };
    setActive(item);
    try { target.setPointerCapture(event.pointerId); }
    catch { discard(); } // the pointer is already gone (released while a gate was open): abandon rather than wedge drawing
  };

  const onPointerDown = (event: ReactPointerEvent<Element>): void | Promise<void> => {
    if (!latest.current.enabled) return;
    event.preventDefault();
    event.stopPropagation();
    if (gestureRef.current || pendingRef.current) return; // one pointer per gesture
    const target = event.currentTarget;
    const gate = beforeStart ? beforeStart(event) : true;
    if (gate === true) { begin(event, target); return; }
    if (gate === false) return;
    const token = ++tokenRef.current;
    pendingRef.current = { token, pointerId: event.pointerId };
    const settle = () => { const live = pendingRef.current?.token === token && latest.current.enabled; if (live) pendingRef.current = null; return live; };
    return gate.then((proceed) => { if (settle() && proceed && !gestureRef.current) begin(event, target); }, (reason) => { settle(); throw reason; });
  };

  const onPointerMove = (event: ReactPointerEvent<Element>) => {
    const gesture = gestureRef.current;
    if (!latest.current.enabled || !gesture || event.pointerId !== gesture.pointerId) return;
    const point = latest.current.toPoint(event);
    if (!isFinitePoint(point)) return;
    const { item } = gesture;
    let next: MarkupItem;
    if (item.type === undefined) {
      if (item.points.length >= STROKE_LIMITS.points) return;
      next = { ...item, points: [...item.points, point] };
    } else {
      next = { ...item, points: [item.points[0], point] as [FreehandPoint, FreehandPoint] };
    }
    gestureRef.current = { ...gesture, item: next, lastX: event.clientX, lastY: event.clientY };
    setActive(next);
  };

  /** Commit the gesture's item by value, or drop it when it is a too-small shape or does not fit the budgets. */
  const finish = (x: number, y: number) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    setActive(null);
    if (!shapeLongEnough(gesture.item, x - gesture.startX, y - gesture.startY)) return;
    const result = commit(historyRef.current, strokesRef.current, [...strokesRef.current, gesture.item], latest.current.limits);
    if (!result) { latest.current.onRefuse?.(); return; }
    apply(result);
  };

  const endPending = (event: ReactPointerEvent<Element>) => { if (pendingRef.current?.pointerId === event.pointerId) pendingRef.current = null; };

  const onPointerUp = (event: ReactPointerEvent<Element>) => {
    endPending(event);
    const gesture = gestureRef.current;
    if (!latest.current.enabled || !gesture || event.pointerId !== gesture.pointerId) return;
    if (gesture.item.type !== undefined) {
      const point = latest.current.toPoint(event);
      if (isFinitePoint(point)) gestureRef.current = { ...gesture, item: { ...gesture.item, points: [gesture.item.points[0], point] as [FreehandPoint, FreehandPoint] } };
      finish(event.clientX, event.clientY);
    } else finish(event.clientX, event.clientY);
  };

  const onPointerLeave = (event: ReactPointerEvent<Element>) => {
    const gesture = gestureRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    finish(gesture.lastX, gesture.lastY); // the last valid point, not the leave position
  };

  const onPointerCancel = (event: ReactPointerEvent<Element>) => {
    endPending(event);
    const gesture = gestureRef.current;
    if (gesture && event.pointerId === gesture.pointerId) discard();
  };

  const refuseOr = (result: MarkupStep | null, refusable: boolean) => { if (result) apply(result); else if (refusable) latest.current.onRefuse?.(); };
  const idle = () => gestureRef.current === null;

  const undoStep = useCallback(() => { if (!idle()) return; refuseOr(undo(historyRef.current, strokesRef.current, latest.current.limits), true); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const redoStep = useCallback(() => { if (!idle()) return; refuseOr(redo(historyRef.current, strokesRef.current, latest.current.limits), true); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  /** Forgets every undo and redo step, keeping the strokes: for a caller whose steps can no longer be applied as they were (the frame under the list changed). */
  const resetHistory = useCallback(() => { const fresh = createHistory(strokesRef.current); historyRef.current = fresh; setHistoryState(fresh); }, []);
  const clear = useCallback(() => { if (!idle()) return; refuseOr(clearAll(historyRef.current, strokesRef.current, latest.current.limits), false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handlers: MarkupHandlers = { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onLostPointerCapture: onPointerCancel, onPointerLeave };
  return {
    handlers, active, undo: undoStep, redo: redoStep, clear, resetHistory, cancel: discard,
    canUndo: canUndo(history, strokes), canRedo: canRedo(history, strokes),
  };
}
