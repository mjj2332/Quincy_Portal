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

export type ConfirmRequest = ConfirmOptions & { signal?: AbortSignal };

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

// `signal` is destructured out and never stored: `ConfirmDialog.tsx` spreads `shown.options`
// straight onto the dialog, so a live `AbortSignal` left in there would land on a DOM component.
export function confirm({ signal, ...options }: ConfirmRequest): Promise<boolean> {
  const normalized: ConfirmOptions = {
    ...options,
    confirmLabel: options.confirmLabel ?? "Confirm",
    cancelLabel: options.cancelLabel ?? "Cancel",
    danger: options.danger ?? false,
  };
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const request: PendingConfirm = { id: nextId++, options: normalized, resolve, settled: false };
    queue.push(request);
    if (queue.length === 1) {
      updateActive();
      emit();
    }
    if (!signal) return;
    const onAbort = () => {
      // Already settled by `confirmStore.resolve` (or a previous abort) — nothing to do.
      if (request.settled) return;
      request.settled = true;
      const index = queue.indexOf(request);
      if (index !== -1) queue.splice(index, 1);
      request.resolve(false);
      if (index === 0) {
        updateActive();
        emit();
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // Removing the listener on every settlement path (not just abort) avoids leaking one per
    // confirm — `confirmStore.resolve` below is the normal-resolution path.
    const originalResolve = request.resolve;
    request.resolve = (value) => {
      signal.removeEventListener("abort", onAbort);
      originalResolve(value);
    };
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
