/**
 * The Dashboard-view publication store — issue #119, following `lib/toast-store.ts` (#110)'s own
 * module-level precedent. `Dashboard` mounts standalone in its own DOM tests with no provider of
 * any kind (`lib/app-router.tsx`'s module header), so this cannot be React context — a provider
 * the shell supplied would simply not exist there. A module-level store needs no provider at all,
 * so a screen mounted standalone behaves identically to a shell-mounted one.
 *
 * Pure module: no `window`, no React import, so this stays a node test the same way `staff-
 * navigation.ts` and `toast-store.ts` do.
 *
 * ## The owner rule
 *
 * `owner` is an opaque object identity (`Dashboard`'s own `useRef({})`), not a boolean or a
 * counter, so a stale instance's `releaseDashboardView` cannot clear a live publication out from
 * under the instance actually mounted — StrictMode's double-invoked effects (mount → cleanup →
 * mount again), or a remount whose new instance publishes before the old instance's own cleanup
 * has run. Only the CURRENT owner's release does anything; every other owner's release is a no-op.
 * The last `publishDashboardView` call always wins and becomes owner, matching how only one
 * `Dashboard` is ever mounted at a time in production.
 *
 * `null` means no Dashboard is currently mounted — the shell's own fallback, the route/remembered-
 * view derivation in `staff-navigation.ts`, covers that first frame and nothing else. `"none"` is a
 * different thing published by a MOUNTED Dashboard: none of its own render branches match the
 * current `view`/`viewingArchived` (`screens/Dashboard.tsx`'s own `renderedView`), so nothing is
 * showing that a nav child could correctly claim as current.
 */
import type { DashboardView } from "../screens/dashboard-helpers";

let owner: object | null = null;
let publishedView: DashboardView | "none" | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** Publishing the same owner and view again notifies nobody — the guard against a render loop
 * from a `useLayoutEffect` that runs every time its owning component renders. */
export function publishDashboardView(nextOwner: object, nextView: DashboardView | "none"): void {
  if (owner === nextOwner && publishedView === nextView) return;
  owner = nextOwner;
  publishedView = nextView;
  notify();
}

export function releaseDashboardView(releasingOwner: object): void {
  if (owner !== releasingOwner) return; // a stale owner's release is a no-op
  owner = null;
  publishedView = null;
  notify();
}

export function readDashboardView(): DashboardView | "none" | null {
  return publishedView;
}

export function subscribeDashboardView(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test-only: isolates one test's owner/view/listener state from the next. */
export function resetDashboardViewStoreForTests(): void {
  owner = null;
  publishedView = null;
  listeners.clear();
}
