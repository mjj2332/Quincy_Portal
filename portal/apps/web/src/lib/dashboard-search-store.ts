/**
 * The single Dashboard search store — #217. A module-level singleton, `useSyncExternalStore`
 * shape (same idiom as `lib/toast-store.ts`): no React context, no provider, one source of truth
 * read by the rail's `ShellSearch` and by `Dashboard.tsx` alike.
 *
 * This module imports nothing from `lib/router.ts` and nothing from TanStack — that is how it
 * passes `lib/routing-transport.guard.test.ts` by construction, not by exemption. The URL write is
 * injected via `setDashboardSearchUrlWriter`, so the store itself never touches history; the
 * Dashboard screen (which already owns `lib/router.ts`'s `history.replace`/`navigateCalendar`)
 * supplies the writer.
 *
 * The Back/Forward race this store exists to close: a debounced commit and a popstate landing in
 * the same tick must never let the debounce win. `adoptDashboardSearchFromUrl` cancels the pending
 * timer FIRST, then adopts — so a keystroke typed just before Back is never written back out over
 * the destination the user actually navigated to.
 */
import { sanitizeDashboardCalendarSearch, normalizeDashboardCalendarSearch } from "../screens/dashboard-helpers";
import { DASHBOARD_SEARCH_MAX_CHARS } from "@quincy/shared";

export const DASHBOARD_SEARCH_DEBOUNCE_MS = 300;

export type DashboardSearchSnapshot = { draft: string; query: string; principalId: string };

let draft = "";
let query = "";
let lastWritten = "";
let principalId = "";
let timer: ReturnType<typeof setTimeout> | null = null;
let writer: ((query: string) => void) | null = null;
let snapshot: DashboardSearchSnapshot = { draft, query, principalId };
const listeners = new Set<() => void>();

function notify(): void {
  snapshot = { draft, query, principalId };
  for (const listener of listeners) listener();
}

function truncate(value: string): string {
  const chars = [...value];
  return chars.length > DASHBOARD_SEARCH_MAX_CHARS ? chars.slice(0, DASHBOARD_SEARCH_MAX_CHARS).join("") : value;
}

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function commit(): void {
  clearTimer();
  const normalized = truncate(normalizeDashboardCalendarSearch(draft));
  if (normalized === query && normalized === lastWritten) return;
  query = normalized;
  notify();
  if (writer && normalized !== lastWritten) {
    lastWritten = normalized;
    writer(normalized);
  }
}

export function subscribeDashboardSearch(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDashboardSearchSnapshot(): DashboardSearchSnapshot {
  return snapshot;
}

export function setDashboardSearchDraft(value: string): void {
  draft = sanitizeDashboardCalendarSearch(value);
  notify();
  clearTimer();
  timer = setTimeout(commit, DASHBOARD_SEARCH_DEBOUNCE_MS);
}

/** Enter: cancel the timer, commit now. */
export function commitDashboardSearchNow(): void {
  commit();
}

/** Escape / chip x: draft "" and immediate commit. */
export function clearDashboardSearch(): void {
  draft = "";
  notify();
  commit();
}

/** Navigation / unmount: drop a pending debounce without committing it. */
export function cancelPendingDashboardSearchWrite(): void {
  clearTimer();
}

/**
 * popstate + mount. Cancels the timer FIRST — the Back/Forward race fix: a pending debounce can
 * never clobber a popstate landing in the same tick.
 */
export function adoptDashboardSearchFromUrl(value: string): void {
  clearTimer();
  draft = value;
  query = value;
  lastWritten = value;
  notify();
}

export function resetDashboardSearchForPrincipal(id: string): void {
  if (id === principalId) return;
  clearTimer();
  draft = "";
  query = "";
  lastWritten = "";
  principalId = id;
  notify();
}

/**
 * Returns an unregister function that nulls the writer and FLUSHES (not cancels) any pending
 * write (#217 fix round 1, item 3). `writer` is nulled first, so `commit()`'s own `if (writer
 * && ...)` check never fires the writer that is about to be torn down — this settles `query`/
 * `lastWritten` state only, a safety net for a re-registration this module cannot see coming
 * (a `view`/Calendar-facet change re-runs Dashboard.tsx's writer-registration effect, which
 * previously cancelled a pending commit outright and silently dropped it, Sol's diff review).
 * It does not, by itself, put the flushed value into a new URL: a caller that builds its OWN URL
 * synchronously for a reason other than typing (`selectView`, `reconcileAppliedCalendarFilters`)
 * still has to flush explicitly and read the fresh value into that URL itself, since this
 * teardown callback runs strictly after such a caller's own synchronous `history` write already
 * happened (effects run after render, not during the click handler) — firing the old writer here
 * would rewrite the URL with the OLD (pre-transition) view/facet a moment later, wrong.
 */
export function setDashboardSearchUrlWriter(nextWriter: ((query: string) => void) | null): () => void {
  writer = nextWriter;
  return () => {
    writer = null;
    commit();
  };
}

export function __resetDashboardSearchStoreForTest(): void {
  clearTimer();
  draft = "";
  query = "";
  lastWritten = "";
  principalId = "";
  writer = null;
  notify();
}
