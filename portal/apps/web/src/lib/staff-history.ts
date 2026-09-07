/**
 * The transport that lets TanStack Router drive Quincy's existing history layer (#52).
 *
 * The whole migration turns on one asymmetry, so it is stated here rather than discovered:
 *
 * - **Reads are raw.** `getLocation` hands TanStack `window.location.pathname + search`
 *   unchanged. A location that *arrives* — initial load, popstate, a bookmark, a shared link —
 *   is preserved byte for byte and merely renders the not-found view if the parser rejects it.
 * - **Writes are sanitised.** Every write goes through `createHistoryAdapter`'s `push`/`replace`,
 *   which already collapse to `/` when `safeStaffDestination` rejects the destination.
 *
 * That split is not a stylistic choice; it is what the shipped behaviour already does, and the
 * DOM suite pins both halves. `App.dom.test.tsx` renders at
 * `/?view=list&detail=<uuid>` — a `not-found` location — and asserts the URL is still exactly
 * that afterwards, while a Photographer arriving at a calendar URL *is* sent to `/` because
 * `App.tsx`'s capability effect calls `history.replace`, i.e. the write path. Sanitising on read
 * would break the first; not sanitising on write would break the second and lose a security
 * property besides.
 *
 * Because TanStack reaches the browser through exactly one door — the adapter — `navigate`,
 * `redirect` and history restoration are all sanitised by construction rather than by a rule
 * someone has to remember. `@tanstack/history`'s own `notify()` re-reads `getLocation()` *after*
 * calling `pushState`, so when the adapter collapses a rejected destination to `/`, the router
 * observes the real committed location and never the rejected candidate.
 */
import { createHistory, parseHref, type RouterHistory } from "@tanstack/history";
import type { createHistoryAdapter } from "./router";

type HistoryAdapter = ReturnType<typeof createHistoryAdapter>;

/**
 * Search is carried opaquely, as the raw query string.
 *
 * Quincy's query contract is closed and byte-exact: `parseStaffLocation` rejects any spelling
 * other than the one `URLSearchParams` itself emits, and `staffPathFor` -> `parseStaffLocation`
 * is a deliberate fixed point. TanStack's default search handling would re-serialise the query
 * and rewrite `layers=project%2Cchecklist` and `q=smith+street`, which the DOM suite asserts on
 * verbatim. Parsing to `{ raw }` and stringifying straight back makes the round trip an identity,
 * so the router never becomes a second, competing opinion about what a query means.
 *
 * Validation deliberately does NOT live here. `parseStaffLocation` remains the sole authority.
 */
export function parseStaffSearch(search: string): Record<string, unknown> {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  return raw === "" ? {} : { raw };
}

export function stringifyStaffSearch(search: Record<string, unknown>): string {
  const raw = search["raw"];
  return typeof raw === "string" && raw !== "" ? `?${raw}` : "";
}

/**
 * Wraps an existing history adapter as a TanStack `RouterHistory`.
 *
 * `adapter` is the app's singleton in production (`locationStore()`), which matters: components
 * that render outside the `RouterProvider` — Dashboard, Admin, ImpersonationBanner,
 * PrincipalFreshnessBoundary, InternalLink — keep navigating through that same adapter, and the
 * subscription below is how the router learns about the writes they make.
 */
export function createStaffRouterHistory(adapter: HistoryAdapter): { history: RouterHistory; dispose: () => void } {
  // True only while TanStack is performing its own write. `@tanstack/history` notifies its
  // subscribers itself immediately after `pushState`/`replaceState` returns, so forwarding the
  // adapter's notification for the same write would deliver it twice. External writes — a
  // provider-free component calling `locationStore().push`, or a popstate — are still forwarded.
  let writing = false;

  const history = createHistory({
    // Raw, unsanitised. See the module comment: this is the arrival path.
    getLocation: () => parseHref(adapter.getLocation(), undefined),
    getLength: () => (typeof window === "undefined" ? 1 : window.history.length),
    pushState: (path) => {
      writing = true;
      try { adapter.push(path); } finally { writing = false; }
    },
    replaceState: (path) => {
      writing = true;
      try { adapter.replace(path); } finally { writing = false; }
    },
    // Traversal delegates to the real browser history. The resulting popstate comes back through
    // the adapter's subscription below, so no history entry is created here.
    go: (n) => { if (typeof window !== "undefined") window.history.go(n); },
    back: () => { if (typeof window !== "undefined") window.history.back(); },
    forward: () => { if (typeof window !== "undefined") window.history.forward(); },
    createHref: (path) => path,
  });

  const unsubscribe = adapter.subscribe(() => {
    if (writing) return;
    // "REPLACE" describes the router's bookkeeping, not the browser operation that happened: the
    // entry already exists by the time we hear about it, so the router must adopt the new location
    // without creating another one. The action type only feeds scroll restoration, which is off.
    history.notify({ type: "REPLACE" });
  });

  return { history, dispose: unsubscribe };
}
