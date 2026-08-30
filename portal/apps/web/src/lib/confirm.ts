import type { ReactNode } from "react";

export type ConfirmOptions = {
  title: string;
  message: string;
  content?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type PendingConfirm = {
  id: number;
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
  settled: boolean;
};

export type ActiveConfirm = Readonly<{ id: number; options: ConfirmOptions }>;

const queue: PendingConfirm[] = [];
const listeners = new Set<() => void>();
let nextId = 1;
let active: ActiveConfirm | null = null;

function emit() {
  for (const listener of listeners) listener();
}

function updateActive() {
  const request = queue[0];
  active = request ? { id: request.id, options: request.options } : null;
}

export function confirm(options: ConfirmOptions): Promise<boolean> {
  const normalized: ConfirmOptions = {
    ...options,
    confirmLabel: options.confirmLabel ?? "Confirm",
    cancelLabel: options.cancelLabel ?? "Cancel",
    danger: options.danger ?? false,
  };
  return new Promise<boolean>((resolve) => {
    queue.push({ id: nextId++, options: normalized, resolve, settled: false });
    if (queue.length === 1) {
      updateActive();
      emit();
    }
  });
}

export const confirmStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): ActiveConfirm | null {
    return active;
  },
  resolve(value: boolean) {
    const request = queue.shift();
    if (!request) return;
    if (!request.settled) {
      request.settled = true;
      request.resolve(value);
    }
    updateActive();
    emit();
  },
};
