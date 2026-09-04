import { useId, useRef, useSyncExternalStore, type JSX } from "react";
import { confirmStore, type ActiveConfirm, type ConfirmOptions } from "../lib/confirm";
import { Modal } from "./Modal";
import { buttonClasses } from "./ui/button";

export type ConfirmDialogProps = ConfirmOptions & {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({ open, title, message, content, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false, onConfirm, onCancel }: ConfirmDialogProps): JSX.Element {
  const messageId = `confirm-modal-message-${useId()}`;
  return <Modal open={open} title={title} onClose={onCancel} initialFocus={0} testId="confirm-modal" describedBy={messageId} footer={<>
    <button className={buttonClasses("secondary")} type="button" data-testid="confirm-modal-cancel" onClick={onCancel}>{cancelLabel}</button>
    <button className={buttonClasses(danger ? "danger" : "primary")} type="button" data-testid="confirm-modal-confirm" onClick={onConfirm}>{confirmLabel}</button>
  </>}>
    <p id={messageId}>{message}</p>
    {content}
  </Modal>;
}

export function ConfirmModalHost(): JSX.Element | null {
  const active = useSyncExternalStore(confirmStore.subscribe, confirmStore.getSnapshot, () => null);
  // Retain the last request's options for the 120ms close transition (§6.0) — the promise still
  // resolves immediately (via `confirmStore.resolve`, called by the button handlers unchanged);
  // only the visual unmount is delayed. `key={shown.id}` still forces a fresh dialog per request,
  // so a queued second `confirm()` cannot inherit the first's focus or DOM state.
  const last = useRef<ActiveConfirm | null>(null);
  if (active) last.current = active;
  const shown = active ?? last.current;
  if (!shown) return null;
  return <ConfirmDialog key={shown.id} open={active !== null} {...shown.options} onConfirm={() => confirmStore.resolve(true)} onCancel={() => confirmStore.resolve(false)} />;
}
