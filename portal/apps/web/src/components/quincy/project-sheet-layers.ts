/**
 * Is a layer above the Project sheet's own content open right now? (#366, decision D8.)
 *
 * The sheet's Esc and outside-press dismissal must not fire while something inside or above it
 * owns that gesture: the Lightbox (rendered in place, inside the popup DOM) or a confirm/Modal
 * (portalled to `body`). Base UI's dialog Esc handler runs on `document` and calls
 * `stopPropagation()`, so it would swallow the key before the Lightbox's own `window` listener ever
 * saw it — the sheet closes AND the Lightbox never does. `ProjectSheet` snapshots this predicate at
 * window-capture time (before any of those handlers run) and consults the snapshot in its
 * `onOpenChange`.
 *
 * Pure over the nodes it is handed, so it can be tested without the sheet.
 *
 * Arms: in-place and global modals (#366); floating popups and the mention list (#375). A layer
 * counts only while open, so the gate never blocks a close on something already closing.
 */
const MODAL_DIALOG = '[role="dialog"][aria-modal="true"]';
/**
 * An open modal dialog. Base UI's Dialog popup sets no `aria-modal` (a non-modal Popover popup is also `role="dialog"`), so the registry
 * dialog is recognised by its slot as well: `reui/dialog`'s content carries `data-slot="dialog-content"`.
 */
const OPEN_MODAL = `${MODAL_DIALOG}[data-open], [data-slot="dialog-content"][data-open]`;
/** #625: the global confirm is an alert dialog (Base UI sets no `aria-modal` on it) — its own arm. */
const ALERT_DIALOG = '[role="alertdialog"][data-open]';
/**
 * Floating popups: a POSITIVE role list, not "anything with `data-open`" — tooltips carry
 * `data-open` too and must never block a close. Base UI's Popover popup is a non-modal
 * `role="dialog"`, menus are `role="menu"`, select/combobox lists `role="listbox"`; Quincy's own
 * `AnchoredPopover` may render without a role, so it opts in with `data-quincy-layer`.
 */
const OPEN_POPUP = '[data-open]:is([role="dialog"]:not([aria-modal="true"]), [role="menu"], [role="listbox"], [data-quincy-layer])';
const OPEN_LIST_HOST = '[data-open]:has([role="listbox"], [role="menu"])';
/** The rich-text editor's mention list is open while its combobox reports `aria-expanded`. */
const OPEN_MENTION_LIST = '[role="combobox"][aria-expanded="true"]';

/** #498: the Project whiteboard owns Esc (it cancels a tool or a selection), so Esc inside it never closes the sheet. */
const OPEN_WHITEBOARD = "[data-quincy-whiteboard]";

/**
 * Is a floating popup (menu, popover, select list, Quincy anchored popover) open in `popup` or its overlay `slot`? Shared with the
 * video review viewer (#741 5b), whose Escape must close such a popup before it does anything else.
 */
export function hasOpenFloatingPopup(popup: HTMLElement | null, slot: HTMLElement | null): boolean {
  // Floating popups portal into the overlay slot (or stay inside the popup); the slot is a sibling
  // of the popup's body, so both roots are searched.
  if (slot?.querySelector(OPEN_POPUP) || popup?.querySelector(OPEN_POPUP)) return true;
  // Select / Combobox: `data-open` sits on the Positioner and Popup (`role="presentation"`), while
  // the `role="listbox"` inside carries none — so an open popup that CONTAINS a list counts too.
  // Scoped to the overlay slot: the sheet's own popup is `data-open` and contains everything.
  return Boolean(slot?.querySelector(OPEN_LIST_HOST));
}

/**
 * Is a modal dialog open above `popup` (`OPEN_MODAL`): one opened after it, portalled beside it or rendered inside it? (#741 5c-ui.) A modal under it (the
 * Project sheet the viewer opened from) comes earlier in the document and never counts. Modal dialogs are
 * deliberately not in `OPEN_POPUP`, so `hasOpenFloatingPopup` never sees the notes paste dialog, which portals to `body` beside the viewer:
 * without this, the viewer's window-capture Escape handler spent the notes form's first Escape and Base UI closed the viewer along with it.
 * Alert dialogs have their own arm (`hasOpenAlertDialog`). A closing modal no longer carries `data-open`, so it does not count.
 */
export function hasOpenModalAbove(popup: HTMLElement | null, doc: Document): boolean {
  if (!popup) return false;
  for (const modal of doc.querySelectorAll<HTMLElement>(OPEN_MODAL)) {
    if (modal === popup || modal.contains(popup)) continue;
    if (popup.compareDocumentPosition(modal) & (Node.DOCUMENT_POSITION_FOLLOWING | Node.DOCUMENT_POSITION_CONTAINED_BY)) return true;
  }
  return false;
}

export function hasOpenInnerLayer(popup: HTMLElement | null, slot: HTMLElement | null, doc: Document): boolean {
  if (!popup) return false;
  // In-place modal: the Lightbox lives inside the popup DOM. `querySelector` searches
  // descendants only, so the popup's own dialog role never counts.
  if (popup.querySelector(MODAL_DIALOG)) return true;
  // Global modal: `ConfirmModalHost` and in-tree `Modal`s portal to `body` and carry `data-open`
  // only while open (`Modal.tsx`), so a closing one does not block.
  // A registry dialog (`reui/dialog`: the Review links dialog, the Gantt deadline dialog) counts too: Base UI sets no `aria-modal` on it, so it is
  // recognised by its slot, as `hasOpenModalAbove` does. Without that arm the sheet's Escape closed the sheet along with the dialog.
  for (const modal of doc.querySelectorAll<HTMLElement>(OPEN_MODAL)) {
    if (modal === popup || modal.contains(popup) || popup.contains(modal)) continue;
    return true;
  }
  // The global confirm (`ConfirmModalHost`): an alert dialog, so Escape on it must not also close the sheet.
  if (doc.querySelector(ALERT_DIALOG)) return true;
  if (hasOpenFloatingPopup(popup, slot)) return true;
  if (popup.querySelector(OPEN_MENTION_LIST)) return true;
  if (popup.querySelector(OPEN_WHITEBOARD)) return true;
  return false;
}
