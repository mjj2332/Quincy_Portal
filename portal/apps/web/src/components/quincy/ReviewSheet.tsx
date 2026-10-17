import { createContext, useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { releaseVelocity, settleSheet, sheetStops, type SheetStop, type SheetStops } from "../../lib/review-pane-geometry";
import { TAP_SLOP } from "../../lib/tap-slop";

/**
 * The phone review sheet (#879), Quincy-owned: the notes pane under the film with three stops. It is not a dialog and portals nothing: it is the review split's own pane `<div>`, sized by
 * the stop, so the film above shrinks and keeps playing (D2) and the viewer's Escape and key routing never see it (lesson "Escape needs an order…"). The pane's children keep their
 * parents across stops, modes and the 721px crossing: a screen marks the parts of what it already renders with `data-sheet-part="head" | "body" | "composer"` and the sheet only
 * toggles `inert` on them (hidden, never unmounted), so the player, the composer and the editor are the same nodes throughout (lesson "A collapsed or mode-hidden pane must stay mounted").
 *
 * - collapsed: the head (tab row) and the composer show; the body is `inert`.
 * - half / full: all three show.
 * - compose (the editor has focus, the keyboard is up) and draw (the picture is the canvas): only the composer shows; the sheet takes its own height.
 * - search (#879 PR 3b, F1: the notes search field has the focus, the keyboard is up): the head and the body show, the composer does not; the sheet takes the split less
 *   compose's film floor. The full stop cannot hold the field and a result above a keyboard (with the viewport at ~384pt the stop is the collapsed floor), so the film gives
 *   way as it does for compose. The composer is not composing: its field never had the focus.
 *
 * The mode is the one switch for the phone composer's layout too (#879 fix): `useReviewSheet` computes it from the field's focus and the composer's holds (its + tray is
 * open, a post is out), and `ReviewSplit` hands it to the composer through `SheetModeContext`. Nothing else decides whether the composer is the compose strip or the pill
 * at rest, so the sheet and the composer can never disagree (the bug where the composer stayed tall after the keyboard went and the tab row slid under the play bar).
 *
 * The stop is the screen's state (`useReviewSheet`), opens at half every time and is never persisted (D6). The numbers live in `lib/review-pane-geometry.ts` (#881 adds the rail clamp there).
 */
export type SheetMode = "browse" | "compose" | "draw" | "search";

export type ReviewSheetControl = {
  stop: SheetStop;
  onStop: (next: SheetStop) => void;
  mode: SheetMode;
  /** Compose mode: the editor has focus (the keyboard is up) or the composer holds it. What the screen sizes its root to the visual viewport for. */
  composing: boolean;
  /** The composer's field took or lost the focus. */
  onComposing: (composing: boolean) => void;
  /** Whether something other than the field's focus keeps compose mode on (the + tray, a post that is out). */
  held: boolean;
  /** Takes or releases a hold on compose mode, by name. */
  setHold: (reason: string, on: boolean) => void;
  /** Search mode: the notes search field has the focus (the keyboard is up). The screen sizes its root to the visual viewport for it too. */
  searching: boolean;
  /** The notes search field took or lost the focus (the screen hears it from `NotesFilterHead`'s "typing" state). */
  onSearching: (searching: boolean) => void;
  /** Width / height of the film on show, for the stops (portrait films take 65% of the space, D7). */
  filmAspect: number;
  /** Names the grabber: "Notes". */
  label: string;
};

/** The screen's sheet state: opens at half, never persisted, and `mode` follows drawing, the editor's focus and the composer's holds. */
export function useReviewSheet({ drawing, filmAspect, label = "Notes" }: { drawing: boolean; filmAspect: number; label?: string }): ReviewSheetControl {
  const [stop, setStop] = useState<SheetStop>("half");
  const [focused, setFocused] = useState(false);
  const [searching, setSearching] = useState(false);
  const onSearching = useCallback((next: boolean) => { setSearching(next); }, []);
  const [holds, setHolds] = useState<ReadonlySet<string>>(NO_HOLDS);
  const onStop = useCallback((next: SheetStop) => { setStop(next); }, []);
  const onComposing = useCallback((next: boolean) => { setFocused(next); }, []);
  const setHold = useCallback((reason: string, on: boolean) => {
    setHolds((held) => {
      if (held.has(reason) === on) return held;
      const next = new Set(held);
      if (on) next.add(reason); else next.delete(reason);
      return next;
    });
  }, []);
  const held = holds.size > 0;
  const composing = focused || held;
  return { stop, onStop, mode: drawing ? "draw" : composing ? "compose" : searching ? "search" : "browse", composing, onComposing, held, setHold, searching, onSearching, filmAspect, label };
}
const NO_HOLDS: ReadonlySet<string> = new Set();

/** What the phone composer reads of the sheet it sits in: the mode, and its own holds. Absent (null) outside a phone sheet: the composer is the desktop form. */
export type SheetModeValue = {
  mode: SheetMode; setHold: (reason: string, on: boolean) => void;
  /** A phone's Full screen compose only (#880 review 6): the strip floats over the film (F1), so Cancel ends the hint row instead of taking a row under the pill. */
  floating?: true;
  /** A phone's Full screen compose only (#880 fix round 1): the screen's close for the floating composer, the Add note toggle's own. Cancel calls it after discarding, since a blur
   *  there leaves the composer shown (the keyboard going away blurs the field too). Absent in the sheet, where Cancel's blur ends compose mode. */
  onCancel?: () => void;
};
export const SheetModeContext = createContext<SheetModeValue | null>(null);

export const SHEET_COLLAPSED_MIN = 127;
const PART = "[data-sheet-part]";
const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const DOUBLE_TAP_MS = 300;
const ORDER: SheetStop[] = ["collapsed", "half", "full"];

const setInert = (element: Element, on: boolean) => { if (on) element.setAttribute("inert", ""); else element.removeAttribute("inert"); };

/** What the sheet measured of the split: the room under the header, the width, and the transport block under the picture. */
export type SheetRoom = { available: number; width: number; transport: number; collapsed: number };

/**
 * Wires a pane `<div>` as the sheet: its stops, the live height while dragging, and the inert toggling of the screen's marked parts. `enabled` is the phone layout; off, every value is inert
 * and the pane is exactly the desktop pane.
 */
export function useSheetPane({ enabled, control, room, paneRef, immersive = "off" }: { enabled: boolean; control: ReviewSheetControl | undefined; room: SheetRoom; paneRef: RefObject<HTMLDivElement | null>; /** Full screen (#880): while composing, only the composer shows, on a phone and on a desktop width alike. */ immersive?: "off" | "watch" | "compose" }) {
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
      const typing = mode === "compose" || mode === "draw";
      const hide = (active && (part === "body" ? typing || (mode === "browse" && stop === "collapsed") : part === "head" ? typing : part === "composer" && mode === "search")) || (immersive === "compose" && (part === "body" || part === "head"));
      setInert(element, hide);
    }
  });
  return { active, stop, mode, stops, drag, setDrag, height };
}

/** The film's floor in compose mode (#879 fix r9; the plan's K1 / K3 rows: film > 96px with the keyboard up and the tray open). */
export const SHEET_FILM_FLOOR = "var(--space-9)";
/** Marks the box in the composer that gives up height first (the pill's text, which scrolls), so the film keeps its floor. */
export const SHEET_TEXT_ATTR = "data-sheet-text";
/** The room the marked box may take, published on the pane in compose mode; the composer's clamp reads it (`var(--sheet-text-room, …)`). */
export const SHEET_TEXT_ROOM_VAR = "--sheet-text-room";

/**
 * Compose mode (#879 fix r9): the sheet takes its own height and the film flexes, so a tall strip (the tray open, a long draft) would squeeze
 * the film to a sliver. The text gives way first: the room it may take is the row's height, less the film's floor, less everything else in
 * the sheet (`pane.scrollHeight` minus the text box), published as a CSS variable the composer's clamp reads. Shrinking the box shrinks the
 * pane by the same amount, so the result is stable. The clamp keeps one line at least; below that the film yields.
 */
export function useSheetTextRoom(active: boolean, rowRef: RefObject<HTMLDivElement | null>, paneRef: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const pane = paneRef.current;
    const row = rowRef.current;
    if (!pane) return undefined;
    if (!active || !row) { pane.style.removeProperty(SHEET_TEXT_ROOM_VAR); return undefined; }
    const update = () => {
      const box = pane.querySelector<HTMLElement>(`[${SHEET_TEXT_ATTR}]`);
      if (!box) { pane.style.removeProperty(SHEET_TEXT_ROOM_VAR); return; }
      const rest = pane.scrollHeight - box.offsetHeight;
      const next = `calc(${row.clientHeight - rest}px - ${SHEET_FILM_FLOOR})`;
      if (pane.style.getPropertyValue(SHEET_TEXT_ROOM_VAR) !== next) pane.style.setProperty(SHEET_TEXT_ROOM_VAR, next);
    };
    update();
    if (typeof ResizeObserver === "undefined") return () => { pane.style.removeProperty(SHEET_TEXT_ROOM_VAR); };
    const observer = new ResizeObserver(update);
    observer.observe(row);
    observer.observe(pane);
    return () => { observer.disconnect(); pane.style.removeProperty(SHEET_TEXT_ROOM_VAR); };
  }, [active, rowRef, paneRef]);
}

/**
 * The grabber: a horizontal window splitter between the picture and the sheet. P1's `.grabber` is 22px (#879 PR 3a): `--space-5` less the bold border. Its touch band reaches up
 * through the transport's `--space-1` bottom gutter and stops there, where the control row's 44px hit areas end, so the two never overlap.
 */
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
    className={`relative flex h-[calc(var(--space-5)-var(--border-width-bold))] flex-none ${control.mode !== "browse" ? "hidden " : ""} cursor-row-resize touch-none items-center justify-center before:absolute before:inset-x-0 before:-top-1 before:bottom-0 before:content-[''] focus-visible:outline-2 -outline-offset-2 focus-visible:!-outline-offset-2 focus-visible:outline-ring`}
  ><span aria-hidden="true" className="block h-1 w-10 rounded-full bg-border" /></div>;
}

/** Whether a focus event target is the composer's editable field (what puts the sheet in compose mode). */
export function isComposerField(target: EventTarget | null): boolean {
  return target instanceof Element && target.matches(EDITABLE) && target.closest('[data-sheet-part="composer"]') !== null;
}

/** Whether a node is inside the composer part (its field, its + tray, Send, Cancel): focus moving there keeps compose mode. */
export function isInComposer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-sheet-part="composer"]') !== null;
}

/** Blurs the focused element when it is in the composer part: compose mode then ends through the pane's ordinary blur path (the keyboard-gone fallback, #879 fix). */
export function blurComposerField(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && isInComposer(active)) active.blur();
}
