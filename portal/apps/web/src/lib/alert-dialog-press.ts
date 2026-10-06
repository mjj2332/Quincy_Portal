import { createContext } from "react";

/**
 * Is this event target inside an open alert dialog (its panel or its scrim)? (#625)
 *
 * Why this exists: `reui/alert-dialog` portals its overlay and focus guards beside the panel, and
 * Base UI marks those `data-base-ui-inert`. A popover's outside-press check ignores presses on
 * elements "injected after it opened" only when the pressed element's body-level ancestor holds no
 * inert marker — so a press on an alert dialog raised FROM a popover (the global confirm, or
 * `ConfirmDeleteDialog`) used to dismiss that popover and discard its draft. Popovers consult this
 * to treat such a press as the dialog's, never as an outside press.
 */
// The portal covers the overlay AND the sibling focus guards Base UI adds (`data-base-ui-focus-guard`):
// Shift+Tab from Cancel or Tab past Confirm wraps focus onto a guard, which is not the popover
// beneath losing focus to something else.
export const ALERT_DIALOG_PRESS_SELECTOR = "[role='alertdialog'], [data-slot='alert-dialog-portal']";

export function isAlertDialogPress(target: EventTarget | null | undefined): boolean {
  return target instanceof Element && target.closest(ALERT_DIALOG_PRESS_SELECTOR) !== null;
}

/**
 * Is an alert dialog open right now? Escape belongs to it (it is the topmost layer), not to the
 * popover beneath: Base UI dismisses every open floating element on Escape unless they are
 * React-nested, and the global confirm never is.
 */
export function hasOpenAlertDialog(doc: Document = document): boolean {
  return doc.querySelector("[role='alertdialog'][data-open]") !== null;
}

/**
 * Is an alert dialog mounted at all, open or still animating closed? Focus moving into the dialog
 * (and back out as it closes) is not the popover losing focus to something else.
 */
export function hasMountedAlertDialog(doc: Document = document): boolean {
  return doc.querySelector("[role='alertdialog']") !== null;
}

/**
 * True inside an alert dialog's React subtree (`reui/alert-dialog`'s Content provides it). A popover
 * opened FROM an alert dialog (the Calendar's Move Deadline date/time popup) is above the dialog,
 * so it keeps Base UI's ordinary dismissal; only a popover BENEATH an alert dialog is exempted.
 */
export const InsideAlertDialogContext = createContext(false);

type DismissalDetails = { reason: string; event?: Event; cancel(): void };

/**
 * The one place a Base UI popup beneath an alert dialog decides to stay open (#625). Call it first
 * in a Root's `onOpenChange`; when it returns true the dismissal has been cancelled and the caller
 * must not forward it. Cancels `outside-press` on the dialog, `escape-key` while one is open, and
 * `focus-out` while one is mounted — but never for a popup rendered inside an alert dialog
 * (`insideAlertDialog`, from `InsideAlertDialogContext`), which sits above it.
 */
export function keepOpenBehindAlertDialog(open: boolean, details: DismissalDetails, insideAlertDialog: boolean): boolean {
  if (insideAlertDialog || open) return false;
  const keep =
    (details.reason === "outside-press" && isAlertDialogPress(details.event?.target)) ||
    (details.reason === "escape-key" && hasOpenAlertDialog()) ||
    (details.reason === "focus-out" && hasMountedAlertDialog());
  if (keep) details.cancel();
  return keep;
}
