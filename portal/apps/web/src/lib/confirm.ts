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
    // Wire up abort handling (and the listener-removing resolve wrapper) *before* the request is
    // published below. `emit()` calls every store subscriber synchronously, and a subscriber can
    // re-enter this module from inside that call — aborting the signal, or calling
    // `confirmStore.resolve` directly — before `confirm()` gets a chance to keep running. If the
    // abort listener weren't attached yet, a synchronous abort during `emit()` would fire with no
    // one listening and be lost forever, leaving the promise unsettled. And if the resolve
    // wrapper weren't installed yet, a synchronous `confirmStore.resolve` during `emit()` would
    // settle through the raw resolver, so the abort listener attached afterwards would never get
    // removed — a leak on an already-settled request.
    if (signal) {
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
    }
    // A signal that aborted between installing the listener above and publishing below has
    // already settled this request (via `onAbort`, whose `queue.indexOf` miss resolves false
    // without touching the queue) — don't resurrect it into the queue now.
    if (request.settled) return;
    queue.push(request);
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
