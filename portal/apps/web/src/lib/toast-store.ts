/**
 * Toast store — issue #110. A single module-level `Toast[]` and a single 3600ms expiry, read by
 * `useSyncExternalStore` from `ToastViewport`. No React context, no provider: a module store needs
 * none, so a screen rendered standalone with `createRoot` (no provider of any kind — see the
 * module header of `lib/app-router.tsx`) behaves identically to a shell-mounted one.
 *
 * `pushToast`'s signature matches what was `Dashboard.tsx`'s own `toast()` exactly, so every call
 * site migrates with `import { pushToast as toast } from "../lib/toast-store";` and zero edits to
 * the call itself.
 *
 * `announcedElsewhere` keeps a toast OUT of the viewport's live region, for the case where the same
 * event was already announced in a screen's own live region. Without it a screen reader hears the
 * event twice. It is opt-IN per call, deliberately: the viewport stays live, so a toast added later
 * without a paired announcement still speaks. Silence has to be asked for. #99.
 *
 * #221: `ttlMs` overrides the expiry per toast (an Undo toast lives longer), and `pauseToast` /
 * `resumeToast` freeze and restart a toast's remaining time while the viewport has hover or focus
 * inside it. `"caution"` is an advisory tone (a warning about a write that still succeeded).
 */

export type ToastTone = "success" | "error" | "caution";
export type ToastAction = { label: string; onAction: () => void };
export type Toast = { id: number; message: string; tone: ToastTone; announcedElsewhere?: boolean; action?: ToastAction };

export const TOAST_TTL_MS = 3600;

let snapshot: Toast[] = [];
let nextId = 0;
let viewportCount = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
/** When each running timer fires (epoch ms), so a pause can compute what remains. */
const expiresAt = new Map<number, number>();
/** Remaining ms of each paused toast; presence means "paused". */
const pausedRemaining = new Map<number, number>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function startTimer(id: number, ms: number): void {
  expiresAt.set(id, Date.now() + ms);
  timers.set(id, setTimeout(() => dismissToast(id), ms));
}

export function pushToast(message: string, tone: ToastTone = "success", options?: { announcedElsewhere?: boolean; action?: ToastAction; ttlMs?: number }): number {
  const id = nextId++;
  const toast: Toast = { id, message, tone, announcedElsewhere: options?.announcedElsewhere, action: options?.action };
  snapshot = [...snapshot, toast];
  startTimer(id, options?.ttlMs ?? TOAST_TTL_MS);
  if (mountedToastViewports() === 0) {
    // Deferred to a microtask, and re-checked when it runs, rather than discarded here: a screen's
    // effects run child-first, so a push from the screen itself (e.g. a route `notice`) fires before
    // its sibling ToastViewport's own registration effect. By the time this microtask runs, that
    // registration has happened in the same commit and the toast is kept (#110 fix round item 1,
    // Sol's P1). If nothing registers by then — the last viewport already unmounted and nothing is
    // coming — the toast is discarded instead of leaking into whichever screen mounts next (Luna's
    // finding 2). This mirrors the per-screen `useState` this store replaced, where `setToasts`
    // after unmount was a no-op: a toast raised by a screen that is gone was discarded, never
    // carried forward.
    queueMicrotask(() => {
      if (mountedToastViewports() > 0) return; // a viewport mounted in this same commit — keep it
      // Guarded: import.meta.env is undefined in this file's own node-environment test.
      if (import.meta.env?.DEV) {
        console.warn(`pushToast: no toast viewport is mounted — "${message}" will not be visible.`);
      }
      dismissToast(id);
    });
  }
  notify();
  return id;
}

/** Stops a live toast's expiry and remembers the time it had left. Idempotent. */
export function pauseToast(id: number): void {
  if (pausedRemaining.has(id) || !snapshot.some((item) => item.id === id)) return;
  const timer = timers.get(id);
  if (!timer) return;
  clearTimeout(timer);
  timers.delete(id);
  pausedRemaining.set(id, Math.max(0, (expiresAt.get(id) ?? Date.now()) - Date.now()));
  expiresAt.delete(id);
}

/** Restarts a paused toast's expiry with the time it had left. A no-op unless paused. */
export function resumeToast(id: number): void {
  const remaining = pausedRemaining.get(id);
  if (remaining === undefined) return;
  pausedRemaining.delete(id);
  if (!snapshot.some((item) => item.id === id)) return;
  startTimer(id, remaining);
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer) { clearTimeout(timer); timers.delete(id); }
  expiresAt.delete(id);
  pausedRemaining.delete(id);
  if (!snapshot.some((item) => item.id === id)) return;
  snapshot = snapshot.filter((item) => item.id !== id);
  notify();
}

export function clearToasts(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  expiresAt.clear();
  pausedRemaining.clear();
  snapshot = [];
  notify();
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToasts(): readonly Toast[] {
  return snapshot;
}

export function registerToastViewport(): () => void {
  viewportCount++;
  let unregistered = false;
  return () => {
    if (unregistered) return;
    unregistered = true;
    viewportCount--;
    if (viewportCount === 0) {
      // Deferred a microtask so StrictMode's mount→unmount→remount, and a screen-to-screen
      // handoff, do not wipe live toasts: if a viewport registers before this runs, the count
      // check below is false and clearToasts() is skipped.
      queueMicrotask(() => {
        if (viewportCount === 0) clearToasts();
      });
    }
  };
}

export function mountedToastViewports(): number {
  return viewportCount;
}
