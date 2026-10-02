/**
 * #463 — the menu a Production Calendar chip or Timeline bar opens: Open project, and Reschedule…
 * (a Deadline) or Edit schedule… (a checklist item). One host, shared by `ProductionEventCalendar` and
 * `ProductionGantt`, so the two surfaces cannot drift. It imports only `reui/dropdown-menu` — never
 * either vendor tree, so the "only app file that imports the vendor" guards still hold.
 *
 * Why a controlled host and not `reui/context-menu`, the Gantt's `renderEventMenu` or a ⋯ trigger:
 * the vendor chip and bar are already `<button>`s the vendor renders (nothing can wrap or nest in
 * them), `renderEventMenu` mounts one context-menu root per bar, and Base UI's 500ms touch long-press
 * would open over the 250ms touch drag on both trees (the Board hit the same trap in #432). Click,
 * Enter and right-click all open this one menu; a drag never does.
 *
 * - **Open state is the host's**, with no Trigger: the menu anchors to the item itself (a keyboard
 *   open) or to a virtual element at the pointer (a click or right-click), re-read live from the item
 *   so it follows scroll. The anchor is why `reui/dropdown-menu` gained its `anchor` passthrough.
 * - **Touch**: a tap opens the menu. There is no long-press menu: a touch-origin `contextmenu` is
 *   swallowed exactly as `board/card.tsx` does (long-press is the drag).
 * - **A drag never opens it**: the vendors already swallow the click after a real drag; `wrapperProps`
 *   adds a 4px pointer-travel guard (`ProjectCalendarAnchor`'s threshold) for the case they do not
 *   (a read-only Timeline bar has no gesture to suppress its click).
 * - **Focus**: Escape or an outside press returns focus to the item, resolved live (Safari does not
 *   focus a clicked button, and a re-keyed item is a new element). A picked row is a HAND-OFF: it only
 *   records the pick; once the menu has finished closing the host focuses the item and THEN runs the
 *   action, so the app router (Open project) and the dialogs (Reschedule…, Edit schedule…) capture the
 *   item as their opener and return focus to it. `finalFocus` is `false` while a hand-off is pending
 *   (lesson #432: that decision is made as the popup unmounts, after `onOpenChangeComplete`, so the
 *   pending flag is cleared on the next open, never in the completion callback). If a follow-on dialog
 *   closes and focus is lost (`<body>`, a disconnected or disabled element: #450, #452 — a re-keyed
 *   Timeline bar), the host re-resolves the item and focuses it.
 * - **Lifecycle**: the menu closes without running anything when its item leaves the data, `describe`
 *   stops knowing it, or `closeKey` changes (the controller's reset key, a lost access).
 *
 * Reuse ledger: menu — `reui/dropdown-menu` (`DropdownMenu`, `DropdownMenuContent` + its `anchor`,
 * `DropdownMenuGroup`, `DropdownMenuLabel`, `DropdownMenuItem`), surface class `quincy/menu-surface.ts`
 * shared with the Board card's menu. `reui/context-menu` / `c-context-menu-1` / the `gantt-1` and
 * `gantt-2` `renderEventMenu` blocks / `quincy/menu.tsx` were searched and do not fit: each needs a
 * trigger element or a per-bar root (above).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent } from "react";
import type { SchedulingItemAction, SchedulingItemActionId } from "../lib/scheduling-item-actions";
import { MENU_SURFACE_CLASS } from "./quincy/menu-surface";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel } from "./reui/dropdown-menu";

/** What the menu shows for one item: the strip's old context line, an optional caution, and the rows. */
export type SchedulingMenuContent = {
  label: string;
  /** The overlap caution the strip used to carry. */
  caution?: string | null;
  actions: SchedulingItemAction[];
};

export type UseSchedulingItemMenuOptions = {
  /** A live description of the item, or `null` once it left the data (which closes the menu). */
  describe: (key: string) => SchedulingMenuContent | null;
  /** Finds the item's element now (the chip or bar), or `null` if it is not drawn. */
  resolveElement: (key: string) => HTMLElement | null;
  /** Runs a picked row, after the menu has closed and focus is on the item. */
  onAction: (id: SchedulingItemActionId, key: string) => void;
  /** True while a dialog or sheet the menu handed off to is open. Its closing triggers the focus restore. */
  followOnOpen?: boolean;
  /** A change closes the menu without running anything (the controller's reset key, an access change). */
  closeKey?: string;
};

export type SchedulingItemMenu = {
  /** The vendor's `onEventClick`: opens for a plain click, ignores a click that was really a drag. */
  openFromClick: (event: ReactMouseEvent, key: string) => void;
  /** The vendor's `onEventContextMenu`: opens at the pointer; a touch-origin one is swallowed. */
  openFromContextMenu: (event: ReactMouseEvent, key: string) => void;
  /** True while this item's menu is open (`aria-expanded`). */
  isOpenFor: (key: string) => boolean;
  /** Spread on the surface's root: records where a press began, for the travel guard and touch detection. */
  wrapperProps: { onPointerDownCapture: (event: ReactPointerEvent) => void; onTouchStartCapture: (event: ReactTouchEvent) => void };
  /** The menu itself; render it once, anywhere under the surface. */
  menu: JSX.Element;
};

type OpenState = { key: string; element: HTMLElement; mode: "keyboard" | "pointer"; offsetX: number };
type Pending = { id: SchedulingItemActionId; key: string; ran: boolean };

/** `ProjectCalendarAnchor`'s threshold: any gesture a drag could recognise must never also open the menu. */
const TRAVEL_PX = 4;
/** Base UI's own touch contextmenu window, as `board/card.tsx` reads it. */
const TOUCH_CONTEXTMENU_MS = 1000;
/**
 * A follow-on dialog is retained through its close animation and returns focus as it unmounts, so the
 * "was focus lost?" check runs again after it; each run is idempotent.
 */
const RESTORE_CHECK_DELAYS_MS = [0, 200, 500];
const ROW_CLASS = "max-[641px]:min-h-11 pointer-coarse:min-h-11";

function focusLost(): boolean {
  const active = document.activeElement;
  if (!active || active === document.body || !active.isConnected) return true;
  return active instanceof HTMLElement && active.matches(":disabled");
}

export function useSchedulingItemMenu({ describe, resolveElement, onAction, followOnOpen = false, closeKey }: UseSchedulingItemMenuOptions): SchedulingItemMenu {
  const [state, setState] = useState<OpenState | null>(null);
  const [open, setOpen] = useState(false);

  // Always the latest closures: the completion callback runs after renders the click handler never saw.
  const latest = useRef({ describe, resolveElement, onAction });
  latest.current = { describe, resolveElement, onAction };
  const stateRef = useRef<OpenState | null>(null);
  stateRef.current = state;

  const pendingRef = useRef<Pending | null>(null);
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  const touchAtRef = useRef(0);
  const lastPointerTypeRef = useRef<string>("");
  const popupRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<{ armed: boolean; sawFollowOn: boolean; key: string | null }>({ armed: false, sawFollowOn: false, key: null });
  const restoreTimers = useRef<number[]>([]);

  const clearRestoreTimers = useCallback(() => {
    for (const timer of restoreTimers.current) window.clearTimeout(timer);
    restoreTimers.current = [];
  }, []);
  useEffect(() => clearRestoreTimers, [clearRestoreTimers]);

  /** The item's element now: the one the menu opened from while it is drawn, else a fresh lookup. */
  const liveElement = useCallback((key: string, element: HTMLElement | null): HTMLElement | null => {
    if (element?.isConnected) return element;
    return latest.current.resolveElement(key);
  }, []);

  const begin = useCallback((event: ReactMouseEvent, key: string, mode: "keyboard" | "pointer") => {
    const element = event.currentTarget as HTMLElement;
    const rect = element.getBoundingClientRect();
    const offsetX = mode === "pointer" ? Math.min(Math.max(event.clientX - rect.left, 0), rect.width) : 0;
    pendingRef.current = null;
    restoreRef.current = { armed: false, sawFollowOn: false, key: null };
    clearRestoreTimers();
    setState({ key, element, mode, offsetX });
    setOpen(true);
  }, [clearRestoreTimers]);

  const openFromClick = useCallback((event: ReactMouseEvent, key: string) => {
    const press = pressRef.current;
    pressRef.current = null;
    // A keyboard click has `detail` 0 and no pointer position; only a real pointer click can have travelled.
    if (event.detail > 0 && press && Math.hypot(event.clientX - press.x, event.clientY - press.y) >= TRAVEL_PX) return;
    begin(event, key, event.detail > 0 ? "pointer" : "keyboard");
  }, [begin]);

  const openFromContextMenu = useCallback((event: ReactMouseEvent, key: string) => {
    const native = event.nativeEvent as MouseEvent & { pointerType?: string };
    const fromTouch = native.pointerType === "touch" || lastPointerTypeRef.current === "touch" || Date.now() - touchAtRef.current < TOUCH_CONTEXTMENU_MS;
    // Long-press is the drag on both trees, and iOS fires no contextmenu at all: swallow it, open nothing.
    event.preventDefault();
    if (fromTouch) return;
    begin(event, key, "pointer");
  }, [begin]);

  const wrapperProps = useMemo(() => ({
    onPointerDownCapture: (event: ReactPointerEvent) => {
      pressRef.current = { x: event.clientX, y: event.clientY };
      lastPointerTypeRef.current = event.pointerType;
      if (event.pointerType === "touch") touchAtRef.current = Date.now();
    },
    onTouchStartCapture: () => { touchAtRef.current = Date.now(); },
  }), []);

  // The item left the data, `describe` forgot it, or the element is gone: close without running anything.
  const content = state ? describe(state.key) : null;
  useEffect(() => {
    if (!open || !state) return;
    if (!content || !liveElement(state.key, state.element)) setOpen(false);
  });
  useEffect(() => { setOpen(false); }, [closeKey]);

  // The follow-on dialog closing (after it opened) is the cue to check that focus did not fall to the page.
  useEffect(() => {
    const restore = restoreRef.current;
    if (!restore.armed) return;
    if (followOnOpen) { restore.sawFollowOn = true; return; }
    if (!restore.sawFollowOn || !restore.key) return;
    const key = restore.key;
    restore.armed = false;
    restore.sawFollowOn = false;
    clearRestoreTimers();
    restoreTimers.current = RESTORE_CHECK_DELAYS_MS.map((delay) => window.setTimeout(() => {
      if (focusLost()) latest.current.resolveElement(key)?.focus({ preventScroll: true });
    }, delay));
  }, [followOnOpen, clearRestoreTimers]);

  const focusFirstRow = useCallback(() => {
    const popup = popupRef.current;
    if (!popup) return;
    if (document.activeElement !== popup && popup.contains(document.activeElement)) return;
    popup.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus({ preventScroll: true });
  }, []);
  // A programmatic open focuses the popup, not its first row; Enter-to-open needs the first row.
  useEffect(() => {
    if (!open || state?.mode !== "keyboard") return;
    const timer = window.setTimeout(focusFirstRow, 0);
    return () => window.clearTimeout(timer);
  }, [open, state?.mode, state?.key, focusFirstRow]);

  const finalFocus = useCallback(() => {
    if (pendingRef.current) return false;
    const current = stateRef.current;
    return current ? liveElement(current.key, current.element) ?? false : false;
  }, [liveElement]);

  const afterClose = useCallback(() => {
    const current = stateRef.current;
    const pending = pendingRef.current;
    if (current && pending && !pending.ran) {
      pending.ran = true;
      // The item holds focus when the action runs: the router and the dialogs capture it as their opener.
      liveElement(current.key, current.element)?.focus({ preventScroll: true });
      if (pending.id !== "open-project") restoreRef.current = { armed: true, sawFollowOn: false, key: current.key };
      latest.current.onAction(pending.id, pending.key);
    }
    // `state` is deliberately kept: `finalFocus` is decided as the popup unmounts, AFTER this runs
    // (lesson #432), and needs the item. The next open replaces it.
  }, [liveElement]);

  const anchor = useMemo(() => {
    if (!state) return undefined;
    if (state.mode === "keyboard") return state.element;
    const { element, offsetX } = state;
    // Horizontally at the pointer's offset inside the item, vertically the item's own height; re-read
    // live so the menu follows the item when a scroll container moves it.
    return {
      contextElement: element,
      getBoundingClientRect: () => {
        const rect = element.getBoundingClientRect();
        const left = rect.left + offsetX;
        return { x: left, y: rect.top, top: rect.top, bottom: rect.bottom, left, right: left, width: 0, height: rect.height, toJSON: () => ({}) } as DOMRect;
      },
    };
  }, [state]);

  const isOpenFor = useCallback((key: string) => open && state?.key === key, [open, state?.key]);

  const menu = (
    <DropdownMenu
      open={open && content !== null}
      onOpenChange={(next) => { if (!next) setOpen(false); }}
      onOpenChangeComplete={(isOpen) => { if (isOpen) focusFirstRow(); else afterClose(); }}
    >
      {state && content && (
        <DropdownMenuContent ref={popupRef} anchor={anchor} side="bottom" align="start" className={MENU_SURFACE_CLASS} finalFocus={finalFocus}>
          <DropdownMenuGroup>
            <DropdownMenuLabel className="break-words">
              {content.label}
              {content.caution && <span className="block text-signal-caution-text">{content.caution}</span>}
            </DropdownMenuLabel>
            {content.actions.map((action) => (
              <DropdownMenuItem key={action.id} disabled={action.disabled} className={ROW_CLASS} onClick={() => { pendingRef.current = { id: action.id, key: state.key, ran: false }; }}>
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );

  return { openFromClick, openFromContextMenu, isOpenFor, wrapperProps, menu };
}
