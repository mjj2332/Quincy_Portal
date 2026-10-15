import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { releaseVelocity, settleSheet, sheetStops, type SheetStop, type SheetStops } from "../../lib/review-pane-geometry";

/**
 * The phone review sheet (#879), Quincy-owned: the notes pane under the film with three stops. It is not a dialog and portals nothing: it is the review split's own pane `<div>`, sized by
 * the stop, so the film above shrinks and keeps playing (D2) and the viewer's Escape and key routing never see it (lesson "Escape needs an order…"). The pane's children keep their
 * parents across stops, modes and the 721px crossing: a screen marks the parts of what it already renders with `data-sheet-part="head" | "body" | "composer"` and the sheet only
 * toggles `inert` on them (hidden, never unmounted), so the player, the composer and the editor are the same nodes throughout (lesson "A collapsed or mode-hidden pane must stay mounted").
 *
 * - collapsed: the head (tab row) and the composer show; the body is `inert`.
 * - half / full: all three show.
 * - compose (the editor has focus, the keyboard is up) and draw (the picture is the canvas): only the composer shows; the sheet takes its own height.
 *
 * The stop is the screen's state (`useReviewSheet`), opens at half every time and is never persisted (D6). The numbers live in `lib/review-pane-geometry.ts` (#881 adds the rail clamp there).
 */
export type SheetMode = "browse" | "compose" | "draw";

export type ReviewSheetControl = {
  stop: SheetStop;
  onStop: (next: SheetStop) => void;
  mode: SheetMode;
  /** The editor has focus (the keyboard is up): what the screen sizes its root to the visual viewport for. */
  composing: boolean;
  onComposing: (composing: boolean) => void;
  /** Width / height of the film on show, for the stops (portrait films take 65% of the space, D7). */
  filmAspect: number;
  /** Names the grabber: "Notes". */
  label: string;
};

/** The screen's sheet state: opens at half, never persisted, and `mode` follows drawing and the editor's focus. */
export function useReviewSheet({ drawing, filmAspect, label = "Notes" }: { drawing: boolean; filmAspect: number; label?: string }): ReviewSheetControl {
  const [stop, setStop] = useState<SheetStop>("half");
  const [composing, setComposing] = useState(false);
  const onStop = useCallback((next: SheetStop) => { setStop(next); }, []);
  const onComposing = useCallback((next: boolean) => { setComposing(next); }, []);
  return { stop, onStop, mode: drawing ? "draw" : composing ? "compose" : "browse", composing, onComposing, filmAspect, label };
}

export const SHEET_COLLAPSED_MIN = 127;
const PART = "[data-sheet-part]";
const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const DOUBLE_TAP_MS = 300;
const TAP_SLOP = 6;
const ORDER: SheetStop[] = ["collapsed", "half", "full"];

const setInert = (element: Element, on: boolean) => { if (on) element.setAttribute("inert", ""); else element.removeAttribute("inert"); };

/** What the sheet measured of the split: the room under the header, the width, and the transport block under the picture. */
export type SheetRoom = { available: number; width: number; transport: number; collapsed: number };

/**
 * Wires a pane `<div>` as the sheet: its stops, the live height while dragging, and the inert toggling of the screen's marked parts. `enabled` is the phone layout; off, every value is inert
 * and the pane is exactly the desktop pane.
 */
export function useSheetPane({ enabled, control, room, paneRef }: { enabled: boolean; control: ReviewSheetControl | undefined; room: SheetRoom; paneRef: RefObject<HTMLDivElement | null> }) {
  const active = enabled && control !== undefined;
  const stop = control?.stop ?? "half";
  const mode = control?.mode ?? "browse";
  const stops: SheetStops = sheetStops({ available: room.available, collapsed: Math.max(SHEET_COLLAPSED_MIN, room.collapsed), filmAspect: control?.filmAspect ?? 16 / 9, width: room.width, transport: room.transport });
  const [drag, setDrag] = useState<number | null>(null);
  const measured = room.available > 0;
  const height = !active || mode !== "browse" || !measured ? undefined : drag ?? stops[stop];

  // Hide the parts the current stop or mode takes away: `inert` keeps them mounted but out of reach (and, via the sheet's classes, out of sight).
  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    for (const element of pane.querySelectorAll(PART)) {
      const part = element.getAttribute("data-sheet-part");
      const hide = active && ((part === "body" && (stop === "collapsed" || mode !== "browse")) || (part === "head" && mode !== "browse"));
      setInert(element, hide);
    }
  });
  return { active, stop, mode, stops, drag, setDrag, height };
}

/** The grabber: a horizontal window splitter between the picture and the sheet. */
export function SheetGrabber({ control, stops, getHeight, onDrag }: {
  control: ReviewSheetControl;
  stops: SheetStops;
  /** The sheet's height right now (the stop's, or the one being dragged to). */
  getHeight: () => number;
  /** A live height while dragging, `null` once released. */
  onDrag: (height: number | null) => void;
}) {
  const { stop, onStop, label } = control;
  const gesture = useRef<{ startY: number; startHeight: number; samples: Array<{ y: number; t: number }>; moved: boolean } | null>(null);
  const lastTap = useRef<number | null>(null);
  const index = ORDER.indexOf(stop);
  const toggle = () => { onStop(stop === "collapsed" ? "half" : "collapsed"); };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let next: SheetStop | null = null;
    if (event.key === "ArrowUp") next = ORDER[Math.min(2, index + 1)]!;
    else if (event.key === "ArrowDown") next = ORDER[Math.max(0, index - 1)]!;
    else if (event.key === "Home") next = "collapsed";
    else if (event.key === "End") next = "full";
    else if (event.key === "Enter") next = stop === "collapsed" ? "half" : "collapsed";
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    onStop(next);
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== undefined && event.button !== 0) return;
    const startHeight = getHeight();
    gesture.current = { startY: event.clientY, startHeight, samples: [{ y: event.clientY, t: event.timeStamp }], moved: false };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* no capture in this runtime: the move events still arrive */ }
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) return;
    if (Math.abs(event.clientY - g.startY) > TAP_SLOP) g.moved = true;
    g.samples.push({ y: event.clientY, t: event.timeStamp });
    if (g.samples.length > 2) g.samples.shift();
    if (g.moved) onDrag(Math.max(stops.collapsed, Math.min(stops.full, g.startHeight + (g.startY - event.clientY))));
  };
  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    onDrag(null);
    if (!g.moved) {
      // A tap: two within 300ms toggle collapsed and half (D6, story 8).
      if (lastTap.current !== null && event.timeStamp - lastTap.current <= DOUBLE_TAP_MS) { lastTap.current = null; toggle(); } else lastTap.current = event.timeStamp;
      return;
    }
    lastTap.current = null;
    // The release is itself a sample: a pause before lifting makes the last interval long and the velocity small.
    g.samples.push({ y: event.clientY, t: event.timeStamp });
    if (g.samples.length > 2) g.samples.shift();
    const [from, to] = [g.samples[0]!, g.samples[g.samples.length - 1]!];
    const velocity = releaseVelocity(from, to);
    const height = Math.max(stops.collapsed, Math.min(stops.full, g.startHeight + (g.startY - to.y)));
    onStop(settleSheet({ stops, height, velocity }));
  };

  return <div
    role="separator"
    tabIndex={0}
    aria-orientation="horizontal"
    aria-label={`Resize ${label.toLowerCase()}`}
    aria-valuemin={0}
    aria-valuemax={2}
    aria-valuenow={index}
    aria-valuetext={`${label}: ${stop}`}
    data-testid="review-sheet-grabber"
    onKeyDown={onKeyDown}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={finish}
    onPointerCancel={finish}
    className={`relative flex h-6 flex-none ${control.mode !== "browse" ? "hidden " : ""} cursor-row-resize touch-none items-center justify-center before:absolute before:inset-x-0 before:-top-2 before:bottom-0 before:content-[''] focus-visible:outline-2 -outline-offset-2 focus-visible:!-outline-offset-2 focus-visible:outline-ring`}
  ><span aria-hidden="true" className="block h-1 w-10 rounded-full bg-border" /></div>;
}

/** Whether a focus event target is the composer's editable field (what puts the sheet in compose mode). */
export function isComposerField(target: EventTarget | null): boolean {
  return target instanceof Element && target.matches(EDITABLE) && target.closest('[data-sheet-part="composer"]') !== null;
}
