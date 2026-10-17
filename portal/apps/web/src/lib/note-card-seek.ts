import { useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { TAP_SLOP } from "./tap-slop";

/**
 * The whole note card seeks to its frame (#901): a click on a card's text, header or reply goes where its timecode button goes. Shared by the staff
 * thread (`VideoNoteThread`) and the guest thread (`GuestThreadItem`), so this file imports nothing staff-side (guest-boundary guard, ADR 0021).
 *
 * The card takes no `role` and no `tabIndex`: the timecode button stays the keyboard and screen-reader way to seek. This is a pointer shortcut only.
 * It is a `.ts` file on purpose: the selector strings below would trip the ui-primitive ratchet's widget-role scan in a `.tsx`.
 */

/** Anything inside the card that does its own thing on a click: those clicks never seek (the timecode button seeks through its own handler). */
const INTERACTIVE = [
  "a[href]", "button", "input", "textarea", "select", "label", "summary", "video", "audio", "form",
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="checkbox"]',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * A seekable card's look: the pointer, and a hover that is half the muted fill (on the inverse surface `--muted` is the timecode chip's own ink-700, so
 * a full fill would swallow the chip). Gated on `data-selected="false"` so a selected card's `border-foreground` always wins. Tailwind 4 emits `hover:`
 * under `@media (hover: hover)`, so a phone tap leaves no stuck fill.
 */
const NOTE_CARD_SEEKABLE = "cursor-pointer data-[selected=false]:hover:bg-muted/50 data-[selected=false]:hover:border-border-hover";

/** What the card saw at `pointerdown`, read again at `click`. */
export type CardGesture = {
  x: number;
  y: number;
  /** A `pointercancel` (the browser took the touch for a scroll) or a second pointer. */
  cancelled: boolean;
  /** The pointer went past the tap slop at some point, even if it came back: a drag, not a tap. */
  moved: boolean;
  /** The card's own "⋯" menu was open: this press only dismisses it. */
  menuOpen: boolean;
  /** Every scroll position from the card up to the page, so a list that scrolled under the finger does not count as a tap. */
  scroll: readonly number[];
};

/** The scroll offsets of the card's ancestors and the window, in a fixed order. */
export function scrollSnapshot(card: Element): number[] {
  const out: number[] = [];
  for (let node = card.parentElement; node !== null; node = node.parentElement) out.push(node.scrollTop, node.scrollLeft);
  const view = card.ownerDocument.defaultView;
  out.push(view?.scrollX ?? 0, view?.scrollY ?? 0);
  return out;
}

type ClickLike = Pick<MouseEvent, "defaultPrevented" | "button" | "detail" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "clientX" | "clientY"> & { target: EventTarget | null };

/**
 * Whether a click on `card` should seek. False for anything that is not a plain, single, primary tap on the card's own non-interactive content:
 * a prevented or modified click; a double click's second click (it selects a word); a click React bubbled up from a portal (the "⋯" items, the guest
 * delete dialog, a tooltip), which is in the card's React tree but not inside its element; a click on a control; a click that ends a text selection
 * in the card; a gesture that moved past the grabber's tap slop, was cancelled, scrolled a list, or only dismissed the card's open menu.
 */
export function isCardSeekClick(event: ClickLike, card: Element, gesture: CardGesture | null, selection: Selection | null): boolean {
  if (event.defaultPrevented || event.button !== 0 || event.detail > 1) return false;
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false;
  const target = event.target;
  if (!(target instanceof Element) || !card.contains(target)) return false;
  const control = target.closest(INTERACTIVE);
  if (control !== null && card.contains(control)) return false;
  if (selection !== null && !selection.isCollapsed && selectionTouches(selection, card)) return false;
  if (gesture !== null) {
    if (gesture.cancelled || gesture.moved || gesture.menuOpen) return false;
    if (pastSlop(gesture, event)) return false;
    const now = scrollSnapshot(card);
    if (now.length !== gesture.scroll.length || now.some((value, index) => value !== gesture.scroll[index])) return false;
  }
  return true;
}

function pastSlop(gesture: CardGesture, point: Pick<MouseEvent, "clientX" | "clientY">): boolean {
  return Math.max(Math.abs(point.clientX - gesture.x), Math.abs(point.clientY - gesture.y)) > TAP_SLOP;
}

function selectionTouches(selection: Selection, card: Element): boolean {
  const { anchorNode, focusNode } = selection;
  if ((anchorNode !== null && card.contains(anchorNode)) || (focusNode !== null && card.contains(focusNode))) return true;
  for (let index = 0; index < selection.rangeCount; index += 1) if (selection.getRangeAt(index).intersectsNode(card)) return true;
  return false;
}

export type NoteCardSeekProps = {
  onPointerDownCapture?: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMoveCapture?: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancelCapture?: (event: ReactPointerEvent<HTMLElement>) => void;
  onClick?: (event: ReactMouseEvent<HTMLElement>) => void;
};

/** What the card spreads on its root (`props`) and adds to its class list (`className`). */
export type NoteCardSeek = { props: NoteCardSeekProps; className: string | undefined };

/**
 * The card's seek. A general note (`startFrame` null) has no frame, so it gets no handler, no cursor and no hover.
 * `isMenuOpen` is read at `pointerdown`: whether the card's own "⋯" menu is open right now. The capture phase runs before Base UI's outside-press
 * listener (which fires on the target), so the menu is still open when this reads it. Nothing here prevents a default or captures the pointer:
 * a swipe on a card still scrolls the list.
 */
export function useNoteCardSeek(startFrame: number | null, seek: () => void, isMenuOpen: () => boolean = () => false): NoteCardSeek {
  const gesture = useRef<CardGesture | null>(null);
  if (startFrame === null) return { props: {}, className: undefined };
  return {
    className: NOTE_CARD_SEEKABLE,
    props: {
      onPointerDownCapture: (event) => {
        if (!event.isPrimary) { if (gesture.current) gesture.current.cancelled = true; return; }
        gesture.current = { x: event.clientX, y: event.clientY, cancelled: false, moved: false, menuOpen: isMenuOpen(), scroll: scrollSnapshot(event.currentTarget) };
      },
      onPointerMoveCapture: (event) => {
        const seen = gesture.current;
        if (seen !== null && event.isPrimary && !seen.moved && pastSlop(seen, event)) seen.moved = true;
      },
      onPointerCancelCapture: () => { if (gesture.current) gesture.current.cancelled = true; },
      onClick: (event) => {
        const seen = gesture.current;
        gesture.current = null;
        const card = event.currentTarget;
        if (!isCardSeekClick(event.nativeEvent, card, seen, card.ownerDocument.getSelection())) return;
        seek();
      },
    },
  };
}
