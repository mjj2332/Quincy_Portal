import { useSyncExternalStore, type JSX } from "react";
import { confirmStore, type ConfirmOptions } from "../lib/confirm";
import { Modal } from "./Modal";

export type ConfirmDialogProps = ConfirmOptions & {
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({ title, message, content, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false, onConfirm, onCancel }: ConfirmDialogProps): JSX.Element {
  return <Modal title={title} onClose={onCancel} initialFocus={0} testId="confirm-modal" footer={<>
    <button className="button button--secondary" type="button" data-testid="confirm-modal-cancel" onClick={onCancel}>{cancelLabel}</button>
    <button className={`button${danger ? " button--danger" : ""}`} type="button" data-testid="confirm-modal-confirm" onClick={onConfirm}>{confirmLabel}</button>
  </>}>
    <p>{message}</p>
    {content}
  </Modal>;
}

export function ConfirmModalHost(): JSX.Element | null {
  const active = useSyncExternalStore(confirmStore.subscribe, confirmStore.getSnapshot, () => null);
  if (!active) return null;
  return <ConfirmDialog key={active.id} {...active.options} onConfirm={() => confirmStore.resolve(true)} onCancel={() => confirmStore.resolve(false)} />;
}
