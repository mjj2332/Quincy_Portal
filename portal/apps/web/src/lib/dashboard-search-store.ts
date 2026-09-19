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
import { capDashboardSearchText } from "@quincy/shared";

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

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function commit(): void {
  clearTimer();
  // #217 fix round 3, item 4 (Sol's whole-branch review): the cap is `@quincy/shared`'s own
  // `capDashboardSearchText` now, the same one `staffPathFor`/`calendarPathFor`
  // (`staff-routes.ts`) and the worker's `/api/projects?q=` matcher (`routes/projects.ts`) use --
  // one definition, so the 200-char cap can never drift between the three.
  const normalized = capDashboardSearchText(normalizeDashboardCalendarSearch(draft));
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
 * Returns an unregister function. #217 fix round 2, item 1 (Sol's diff review): a re-registration
 * must not strand a search mid-debounce, REGARDLESS of which call site triggered it. The earlier
 * fix (flush-on-unregister, round 1 item 3) only covered the two call sites that happened to flush
 * for themselves before their own synchronous URL write; it did NOT cover a re-registration caused
 * by something ELSE re-rendering with no URL write of its own to catch the flushed value — e.g.
 * `viewingArchived` flipping while already on List recreates `navigateCalendar` (its own dep
 * list includes `viewingArchived`) purely as a side effect, tearing the writer down and back up
 * with no corresponding `history` call anywhere to carry a pending "smith" into. Flushing there
 * (nulling `writer` then calling `commit()`) settled `query` internally but the writer was already
 * gone, so the value was silently never written.
 *
 * The fix is at the class, not any one call site: unregistering NEVER touches the pending timer or
 * `draft` — only the `writer` reference itself, guarded so an out-of-order call can't null a writer
 * a NEWER registration already installed. A pending debounce keeps ticking across any number of
 * re-registrations and fires `commit()` against whichever writer is registered when it elapses,
 * which is exactly "keep the pending value in the store across unregister and commit it through
 * the next registered writer". `adoptDashboardSearchFromUrl`'s own `clearTimer()` (the Back/Forward
 * race fix) is unaffected — that is a deliberate, unrelated cancellation of a DIFFERENT kind.
 */
export function setDashboardSearchUrlWriter(nextWriter: ((query: string) => void) | null): () => void {
  writer = nextWriter;
  return () => {
    if (writer === nextWriter) writer = null;
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
