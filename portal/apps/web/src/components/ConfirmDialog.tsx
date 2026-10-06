import { useRef, useSyncExternalStore, type JSX } from "react";
import { confirmStore, type ActiveConfirm, type ConfirmOptions } from "../lib/confirm";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/reui/alert-dialog";

export type ConfirmDialogProps = ConfirmOptions & {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * #625: the one confirm look — the shared ReUI AlertDialog, like `ConfirmDeleteDialog` and
 * EditProject's Restore dialog. Standard alert-dialog behaviour, deliberately adopted: role
 * `alertdialog`, Cancel takes initial focus, Escape / Cancel answer false, and a scrim press does
 * not dismiss (the confirm demands an explicit answer). Popovers that raised the
 * confirm treat a press on it as the dialog's (`lib/alert-dialog-press.ts`).
 */
export function ConfirmDialog({ open, title, message, content, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false, onConfirm, onCancel }: ConfirmDialogProps): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return <AlertDialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
    <AlertDialogContent size="default" initialFocus={cancelRef} data-testid="confirm-modal">
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription data-testid="confirm-modal-message" className="text-foreground-secondary">{message}</AlertDialogDescription>
      </AlertDialogHeader>
      {content}
      <AlertDialogFooter>
        <AlertDialogCancel ref={cancelRef} data-testid="confirm-modal-cancel">{cancelLabel}</AlertDialogCancel>
        <AlertDialogAction variant={danger ? "destructive" : "default"} data-testid="confirm-modal-confirm" onClick={onConfirm}>{confirmLabel}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

export function ConfirmModalHost(): JSX.Element | null {
  const active = useSyncExternalStore(confirmStore.subscribe, confirmStore.getSnapshot, () => null);
  // Retain the last request's options for the close transition — the promise still resolves
  // immediately (via `confirmStore.resolve`, called by the button handlers unchanged); only the
  // visual unmount is delayed. `key={shown.id}` still forces a fresh dialog per request, so a
  // queued second `confirm()` cannot inherit the first's focus or DOM state.
  const last = useRef<ActiveConfirm | null>(null);
  if (active) last.current = active;
  const shown = active ?? last.current;
  if (!shown) return null;
  return <ConfirmDialog key={shown.id} open={active !== null} {...shown.options} onConfirm={() => confirmStore.resolve(true)} onCancel={() => confirmStore.resolve(false)} />;
}
