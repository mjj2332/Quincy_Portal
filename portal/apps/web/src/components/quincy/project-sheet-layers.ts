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
 * Floating popups: a POSITIVE role list, not "anything with `data-open`" — tooltips carry
 * `data-open` too and must never block a close. Base UI's Popover popup is a non-modal
 * `role="dialog"`, menus are `role="menu"`, select/combobox lists `role="listbox"`; Quincy's own
 * `AnchoredPopover` may render without a role, so it opts in with `data-quincy-layer`.
 */
const OPEN_POPUP = '[data-open]:is([role="dialog"]:not([aria-modal="true"]), [role="menu"], [role="listbox"], [data-quincy-layer])';
const OPEN_LIST_HOST = '[data-open]:has([role="listbox"], [role="menu"])';
/** The rich-text editor's mention list is open while its combobox reports `aria-expanded`. */
const OPEN_MENTION_LIST = '[role="combobox"][aria-expanded="true"]';

export function hasOpenInnerLayer(popup: HTMLElement | null, slot: HTMLElement | null, doc: Document): boolean {
  if (!popup) return false;
  // In-place modal: the Lightbox lives inside the popup DOM. `querySelector` searches
  // descendants only, so the popup's own dialog role never counts.
  if (popup.querySelector(MODAL_DIALOG)) return true;
  // Global modal: `ConfirmModalHost` and in-tree `Modal`s portal to `body` and carry `data-open`
  // only while open (`Modal.tsx`), so a closing one does not block.
  for (const modal of doc.querySelectorAll<HTMLElement>(`${MODAL_DIALOG}[data-open]`)) {
    if (modal === popup || modal.contains(popup) || popup.contains(modal)) continue;
    return true;
  }
  // Floating popups portal into the overlay slot (or stay inside the popup); the slot is a sibling
  // of the popup's body, so both roots are searched.
  if (slot?.querySelector(OPEN_POPUP) || popup.querySelector(OPEN_POPUP)) return true;
  // Select / Combobox: `data-open` sits on the Positioner and Popup (`role="presentation"`), while
  // the `role="listbox"` inside carries none — so an open popup that CONTAINS a list counts too.
  // Scoped to the overlay slot: the sheet's own popup is `data-open` and contains everything.
  if (slot?.querySelector(OPEN_LIST_HOST)) return true;
  if (popup.querySelector(OPEN_MENTION_LIST)) return true;
  return false;
}
