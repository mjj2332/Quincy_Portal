/**
 * The rail's project search — #122 P3. A one-shot, latched focus request rather than a dialog or
 * an endpoint: the Dashboard already owns a real search field (`InputGroupInput
 * data-testid="dashboard-search-input"`), and this module's only job is telling it when to take
 * focus, from wherever the request originates — the rail's own control, or ⌘K from anywhere in
 * the app, including a screen the Dashboard has not mounted yet.
 *
 * `requestProjectSearchFocus`/`subscribeProjectSearchFocus`/`getProjectSearchFocusToken` are the
 * `useSyncExternalStore` shape `lib/router.ts`'s own history adapter already uses: a bumped token
 * is what tells a subscriber a NEW request landed, not merely that a re-render happened, and
 * subscribing costs nothing before the Dashboard exists — the request stays latched until
 * `consumeProjectSearchFocus` clears it, on whatever later render actually mounts the field. There
 * is no cancel: nothing in this build ever needs to withdraw a request once made.
 */
import { isShellShortcut, type RailShortcutEvent } from "./shell-rail";
import { locationStore, parseStaffLocation } from "./router";

let pending = false;
let token = 0;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

/** Latches a pending request and bumps the token so every subscriber's next read differs. */
export function requestProjectSearchFocus(): void {
  pending = true;
  token += 1;
  notify();
}

export function subscribeProjectSearchFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getProjectSearchFocusToken(): number {
  return token;
}

/**
 * Atomically reads and clears the pending request. A second call with no request in between
 * returns `false` — a re-render cannot replay a request the Dashboard already consumed.
 */
export function consumeProjectSearchFocus(): boolean {
  const wasPending = pending;
  pending = false;
  return wasPending;
}

/** ⌘K (Meta+K) or Ctrl+K, the search shortcut — `isRailShortcut`'s own predicate, keyed on K. */
export function isSearchShortcut(event: RailShortcutEvent): boolean {
  return isShellShortcut(event, "k");
}

/**
 * Activation: navigate to the Dashboard only when the current location is not already one of its
 * views (List/Kanban/Calendar and their query stay untouched otherwise), then latch a focus
 * request. The Dashboard mounts — or is already mounted — and consumes it on its next render.
 */
export function activateProjectSearch(dashboardHref: string): void {
  const history = locationStore();
  const route = parseStaffLocation(history.getLocation());
  if (route.kind !== "dashboard") history.push(dashboardHref);
  requestProjectSearchFocus();
}
