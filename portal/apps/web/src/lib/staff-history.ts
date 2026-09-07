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
 * ## Why the router's history is read-only
 *
 * The router observes the URL; it never writes it. Every navigation in this application already
 * goes through `locationStore()` — the Shell's capability redirects, Dashboard's view and calendar
 * changes, Admin, ImpersonationBanner, and `InternalLink` — so the adapter remains the single
 * writer, and `safeStaffDestination` still runs on every one of those navigations.
 *
 * Making the writes no-ops is not a shortcut, it is required. `@tanstack/react-router`'s
 * `Transitioner` canonicalises the URL on mount, unconditionally and with no option to disable it:
 * it rebuilds the location from the *decoded* pathname and issues a `replace` when the result
 * differs from what arrived. Quincy's parser rejects percent-encoded spellings of static segments
 * on purpose — `/%61dmin` and `/projects/%6eew` are `not-found`, with dedicated tests — so letting
 * that replace through rewrote `/%61dmin` to `/admin` and mounted the real Admin screen from a URL
 * the contract refuses. That is a security regression, not a cosmetic one.
 *
 * The suppression is provably free of collateral damage. A canonicalising replace can only fire
 * when the pathname contains a percent-escape that decodes to something else, and *every* such
 * pathname is one `parseStaffPathname` rejects, because canonical staff paths contain no escapes.
 * So the writes being dropped are exactly the writes that must not happen; no valid navigation
 * reaches this code path at all.
 *
 * What keeps this honest over time is `routing-transport.guard.test.ts`, which fails if anything
 * outside this module starts navigating through TanStack. Without that guard a future
 * `router.navigate` would silently do nothing.
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
  const history = createHistory({
    // Raw, unsanitised. See the module comment: this is the arrival path.
    getLocation: () => parseHref(adapter.getLocation(), undefined),
    getLength: () => (typeof window === "undefined" ? 1 : window.history.length),
    // The router does not own the URL in this application; the adapter does. See the note below.
    pushState: () => {},
    replaceState: () => {},
    // Traversal delegates to the real browser history. The resulting popstate comes back through
    // the adapter's subscription below, so no history entry is created here.
    go: (n) => { if (typeof window !== "undefined") window.history.go(n); },
    back: () => { if (typeof window !== "undefined") window.history.back(); },
    forward: () => { if (typeof window !== "undefined") window.history.forward(); },
    createHref: (path) => path,
  });

  const unsubscribe = adapter.subscribe(() => {
    // "REPLACE" describes the router's bookkeeping, not the browser operation that happened: the
    // entry already exists by the time we hear about it, so the router must adopt the new location
    // without creating another one. The action type only feeds scroll restoration, which is off.
    history.notify({ type: "REPLACE" });
  });

  return { history, dispose: unsubscribe };
}
