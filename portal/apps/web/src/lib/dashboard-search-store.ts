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
import { sanitizeDashboardCalendarSearch } from "../screens/dashboard-helpers";
import { normalizeDashboardSearchText } from "@quincy/shared";

export const DASHBOARD_SEARCH_DEBOUNCE_MS = 300;

export type DashboardSearchSnapshot = { draft: string; query: string; principalId: string };

let draft = "";
let query = "";
let lastWritten = "";
let principalId = "";
let timer: ReturnType<typeof setTimeout> | null = null;
// The principal the ARMED timer was set for — captured at arm time, checked at fire time. A
// principal switch between those two moments (#217 fix round 4, item 3) must drop the commit
// entirely, not run it against whichever principal happens to be current when it fires.
let timerOwner = "";
let writer: ((query: string) => void) | null = null;
let snapshot: DashboardSearchSnapshot = { draft, query, principalId };
// A stable reference PER viewer id for the "wrong owner" render-time snapshot — `useSyncExternalStore`
// requires `getSnapshot()` to return the SAME reference across repeated calls within a render pass
// whenever nothing has changed, or React treats it as tearing and can loop. Recomputed only when
// either the mismatched viewer or the store's own state actually changes (`notify()` below).
let mismatchCache: { viewer: string; snapshot: DashboardSearchSnapshot } | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  snapshot = { draft, query, principalId };
  mismatchCache = null;
  for (const listener of listeners) listener();
}

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/**
 * Ownership switch used by every direct write path (draft/commit-now/clear): if the caller's own
 * id disagrees with the store's current owner, the OLD owner's draft/query/timer are cleared first
 * — a write by a new principal must never land on top of a previous principal's in-flight state.
 * Guarded (a same-id call is a no-op) so a normal keystroke burst from the SAME principal never
 * clears itself; `resetDashboardSearchForPrincipal` below shares this same guard for the same
 * reason (Dashboard's own mount effect, `dashboard-search-store.test.ts`'s "a principal change
 * clears the store" test).
 */
function ensureOwner(viewerId: string): void {
  if (viewerId !== principalId) resetDashboardSearchForPrincipal(viewerId);
}

function commit(): void {
  clearTimer();
  // #217 fix round 3, item 4 / round 4, item 2 (Sol's whole-branch review / re-review): the FULL
  // normaliser now -- `@quincy/shared`'s own `normalizeDashboardSearchText` (strip, collapse
  // whitespace, trim, cap) -- the same one `staffPathFor`/`calendarPathFor` (`staff-routes.ts`) and
  // the worker's `/api/projects?q=` matcher (`routes/projects.ts`, cap only there) share, so a
  // committed `query` can never disagree with what a URL built from the same raw draft normalises
  // to. Re-stripping an already-`sanitizeDashboardCalendarSearch`d draft here is redundant but
  // harmless (idempotent).
  const normalized = normalizeDashboardSearchText(draft);
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

/**
 * TEST-ONLY (#217 fix round 5, item 1, BLOCKER). Unscoped: returns the store's raw state
 * regardless of who is asking. RENDER code must never use this -- `Dashboard.tsx`'s own render
 * (`~197`) and `lib/app-router.tsx`'s rail-href derivation (`~252`) both used to, and on A→B while
 * still parked on those screens, a render pass could consume A's `query`/`draft` and serialise it
 * into the rail's own hrefs or the project query, worst on the narrow layout with the Sheet closed
 * (no `ShellSearch` instance mounted there to make the layout-effect ownership claim). This export
 * exists only so a test can assert the store's raw internal state directly without knowing which
 * principal "owns" it at that point in the test; production code reads exclusively through
 * `getDashboardSearchSnapshotForPrincipal`, which this file deliberately does not also export
 * unscoped under any other name.
 */
export function __getDashboardSearchSnapshotForTest(): DashboardSearchSnapshot {
  return snapshot;
}

/**
 * Principal-scoped read (#217 fix round 4, item 3, BLOCKER) — for a component (`ShellSearch`) that
 * renders on EVERY staff route and must never show one principal's text during another's render
 * pass. Compares the CALLER's own, render-time-current `viewerId` against the store's recorded
 * `principalId` DURING RENDER: if they disagree, this returns an empty snapshot regardless of
 * whether any reset effect has run yet — there is no flash and no dependence on effect ordering,
 * because the comparison itself, not a prior side effect, is what keeps A and B apart. Stable
 * per-viewer reference (`mismatchCache`) so `useSyncExternalStore` never sees a "changed" snapshot
 * on repeated same-render calls it makes to detect tearing.
 */
export function getDashboardSearchSnapshotForPrincipal(viewerId: string): DashboardSearchSnapshot {
  if (viewerId === principalId) return snapshot;
  if (mismatchCache && mismatchCache.viewer === viewerId) return mismatchCache.snapshot;
  mismatchCache = { viewer: viewerId, snapshot: { draft: "", query: "", principalId: viewerId } };
  return mismatchCache.snapshot;
}

/**
 * `viewerId` is REQUIRED (#217 fix round 5, item 2, SHOULD-FIX) — an earlier version defaulted an
 * omitted id to the store's OWN current owner, which made the ownership check tautological: a
 * caller that forgot to pass one silently always "agreed" with whatever the store already thought,
 * closing none of the isolation gap the check exists for. Every call site now threads the
 * render-time-current principal through explicitly; a write from a DIFFERENT principal than the
 * store's recorded owner first clears the old owner's state (`ensureOwner`) before applying.
 */
export function setDashboardSearchDraft(value: string, viewerId: string): void {
  ensureOwner(viewerId);
  draft = sanitizeDashboardCalendarSearch(value);
  notify();
  clearTimer();
  // The owner this timer is armed FOR — re-checked at fire time below, so a principal switch
  // between arming and firing drops the commit instead of running it against whoever is current.
  timerOwner = principalId;
  timer = setTimeout(() => {
    timer = null;
    if (timerOwner !== principalId) return;
    commit();
  }, DASHBOARD_SEARCH_DEBOUNCE_MS);
}

/**
 * The IME composition path (#217 design-fix round 3, item 3). Updates the draft exactly the same
 * way `setDashboardSearchDraft` does -- same ownership check, same sanitize, same notify -- but
 * arms NO commit timer. Without this, every INTERMEDIATE composition update re-armed the 300ms
 * debounce, so a long composition could commit and rewrite the URL with a half-formed composed
 * character mid-composition. The caller (`ShellSearch.tsx`) is responsible for cancelling any
 * timer already armed BEFORE the composition began (`cancelPendingDashboardSearchWrite` on
 * `compositionstart`) and for scheduling the eventual commit exactly once, through the normal
 * `setDashboardSearchDraft` path, on `compositionend`.
 */
export function setDashboardSearchDraftDuringComposition(value: string, viewerId: string): void {
  ensureOwner(viewerId);
  draft = sanitizeDashboardCalendarSearch(value);
  notify();
}

/** Enter: cancel the timer, commit now. `viewerId` required -- see `setDashboardSearchDraft`. */
export function commitDashboardSearchNow(viewerId: string): void {
  ensureOwner(viewerId);
  commit();
}

/** Escape / chip x: draft "" and immediate commit. `viewerId` required -- see
 * `setDashboardSearchDraft`. */
export function clearDashboardSearch(viewerId: string): void {
  ensureOwner(viewerId);
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
 * never clobber a popstate landing in the same tick. `viewerId` required (#217 fix round 5, item 2)
 * and unconditionally becomes the store's recorded owner: adopting a URL's search is itself an
 * ownership-establishing write, not merely a value update, so a caller adopting on behalf of a
 * DIFFERENT principal than the store's current owner does not silently keep the old one recorded.
 */
export function adoptDashboardSearchFromUrl(value: string, viewerId: string): void {
  clearTimer();
  principalId = viewerId;
  draft = value;
  query = value;
  lastWritten = value;
  notify();
}

/**
 * The stateless draft-from-URL sync (#217 build, step 3) — one call, in `ShellRoute`'s own
 * `useLayoutEffect` keyed on location + principal, replacing every OTHER adoption path this store
 * used to need (`adoptDashboardSearchFromUrl` stays for now, unused by the caller this replaces,
 * until step 4 deletes the render-side machinery that called it). `routeQuery` is the CALLER's own
 * `dashboardSearchOf(route)` for the CURRENTLY governing route -- this function does not parse a
 * route itself, and does not special-case a non-Dashboard route: the caller is responsible for not
 * calling this at all when `route.kind !== "dashboard"` (its lack of a `q` is not authoritative
 * off-Dashboard -- an Enter on the rail must still navigate with whatever the Staff member typed).
 *
 * Ownership first (`ensureOwner`), then the timer is cancelled UNCONDITIONALLY -- this is itself
 * the Back/Forward race fix `adoptDashboardSearchFromUrl`'s own docblock describes, generalised:
 * a location change (typed navigation, rail click, Back/Forward, or this component's OWN debounced
 * write landing) must never let an in-flight debounce fire after the fact and overwrite whatever
 * the URL now says.
 *
 * The draft itself is compared NORMALISED against `routeQuery ?? ""` before it is ever overwritten
 * -- this is what keeps the store's own debounced write from fighting the very typing that produced
 * it: that write emits exactly `normalizeDashboardSearchText(draft)` (`commit()` below), so once the
 * resulting URL lands back here, `normalize(draft) === (routeQuery ?? "")` and the raw draft (a
 * trailing space, mid-collapse whitespace) is left alone. Only a location that carries a GENUINELY
 * different committed search (a rail click to a different q, Back/Forward, a pasted deep link)
 * ever overwrites the draft.
 *
 * #217 build, step 4 (found while wiring `Dashboard.tsx`'s render-time `committedQuery`, not a
 * design change of its own): `query`/`lastWritten` are ALSO brought into step with `routeQuery`
 * here, in the SAME branch that already updates `draft` (not on every call). Once step 4 deletes
 * every render-side path that used to keep `query` current (`adoptDashboardSearchFromUrl`'s own
 * callers), this function -- called on every location change `Dashboard` is mounted under -- is the
 * only thing left that ever touches it, and `commit()`'s own no-op guard below still compares
 * against both fields. Leaving them at their cold-module `""` default after landing on a URL that
 * already carries a `q` made `commit()` silently no-op the FIRST clear (an empty draft normalises
 * to `""`, coincidentally matching that stale default) -- the chip's × visibly did nothing. Scoped
 * to the draft-changed branch, not unconditionally: `query`/`lastWritten` go stale only when
 * `draft` itself is being seeded from `""` on a fresh/reset principal -- the one case a real
 * `commit()` never had a chance to keep them current for. When `draft` already matches (this
 * function's own "stable no-op" case, `dashboard-search-store.test.ts`), `query`/`lastWritten` were
 * already kept correct by whatever `commit()` call put `draft` there in the first place, and this
 * stays a true no-op, exactly as before. `query`/`lastWritten` themselves are already slated for
 * deletion in step 5, alongside a `commit()` rewritten not to need them; this keeps them correct in
 * the meantime rather than shipping that regression for one commit.
 */
export function syncDashboardSearchDraftFromLocation(routeQuery: string | undefined, viewerId: string): void {
  ensureOwner(viewerId);
  clearTimer();
  const nextDraft = routeQuery ?? "";
  if (normalizeDashboardSearchText(draft) !== nextDraft) {
    draft = nextDraft;
    query = nextDraft;
    lastWritten = nextDraft;
    notify();
  }
}

/**
 * Off-Dashboard Enter, and every navigation site that used to flush-then-read `commitDashboardSearchNow`
 * + `getDashboardSearchSnapshotForPrincipal(...).query` as a pair (#217 build, step 3 adds this;
 * step 4 is what actually replaces those call sites). Cancels the pending timer -- the write this
 * function's caller is about to make (a `history.push`/`replace`) IS the commit, so there is nothing
 * left for a debounce to redundantly re-fire -- and returns the draft normalised exactly the way the
 * store's own `commit()` would, so a caller building a URL from this return value can never disagree
 * with what the store itself would have written.
 */
export function takeDashboardSearchForNavigation(viewerId: string): string {
  ensureOwner(viewerId);
  clearTimer();
  return normalizeDashboardSearchText(draft);
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
 * Unconditional — unlike `resetDashboardSearchForPrincipal` above (guarded, so a caller that fires
 * redundantly with the ALREADY-current id, e.g. Dashboard's own per-render-dependency-change mount
 * effect, never clobbers an in-progress search), this ALWAYS clears and drops ownership entirely
 * (`principalId` back to `""`, "no owner"). #217 fix round 4, item 3 (BLOCKER): sign-out unmounts
 * `PrincipalFreshnessBoundary` with no principal change to reset FOR (there is no next principal
 * yet), so the guarded reset above can't be the mechanism — and signing back in as the SAME id
 * afterwards must not hit that same guard and keep the signed-out principal's old search. This is
 * the boundary's unmount cleanup; the guarded reset stays its mount-time call.
 */
export function dropDashboardSearchOwnership(): void {
  clearTimer();
  draft = "";
  query = "";
  lastWritten = "";
  principalId = "";
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
  timerOwner = "";
  writer = null;
  mismatchCache = null;
  notify();
}
