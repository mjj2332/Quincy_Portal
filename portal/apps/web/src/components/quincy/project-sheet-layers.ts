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
 * This PR ships the modal arms. #375 adds the popover / menu / mention arms at the marked point.
 */
const MODAL_DIALOG = '[role="dialog"][aria-modal="true"]';

export function hasOpenInnerLayer(popup: HTMLElement | null, _slot: HTMLElement | null, doc: Document): boolean {
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
  // EXTENSION POINT (#375): open popover / menu / mention layers inside `_slot` join here.
  return false;
}
