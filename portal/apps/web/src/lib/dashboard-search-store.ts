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
 * #217 build, step 5: the URL is the ONLY committed Dashboard search — this store no longer keeps
 * a `query` copy of it at all (it used to; `Dashboard.tsx` now derives `committedQuery` straight
 * from the currently governing route, `@quincy/shared`'s `dashboardSearchOf`, at render). What
 * remains here is exactly what the design calls "not in the URL": `draft`, the debounce timer, IME
 * composing state, and the owning principal. Committing is a URL write through the registered
 * writer (replace while typing) — with no writer registered (off-Dashboard) a timer fire is simply
 * dropped; nothing local is left for it to update instead.
 *
 * The Back/Forward race this store exists to close: a debounced commit and a popstate landing in
 * the same tick must never let the debounce win. `syncDashboardSearchDraftFromLocation` cancels the
 * pending timer FIRST, then syncs the draft — so a keystroke typed just before Back is never
 * written back out over the destination the user actually navigated to.
 */
import { sanitizeDashboardCalendarSearch } from "../screens/dashboard-helpers";
import { normalizeDashboardSearchText } from "@quincy/shared";

export const DASHBOARD_SEARCH_DEBOUNCE_MS = 300;

export type DashboardSearchSnapshot = { draft: string; principalId: string };

let draft = "";
let principalId = "";
let timer: ReturnType<typeof setTimeout> | null = null;
// The principal the ARMED timer was set for — captured at arm time, checked at fire time. A
// principal switch between those two moments (#217 fix round 4, item 3) must drop the commit
// entirely, not run it against whichever principal happens to be current when it fires.
let timerOwner = "";
let writer: ((query: string) => void) | null = null;
let snapshot: DashboardSearchSnapshot = { draft, principalId };
// A stable reference PER viewer id for the "wrong owner" render-time snapshot — `useSyncExternalStore`
// requires `getSnapshot()` to return the SAME reference across repeated calls within a render pass
// whenever nothing has changed, or React treats it as tearing and can loop. Recomputed only when
// either the mismatched viewer or the store's own state actually changes (`notify()` below).
let mismatchCache: { viewer: string; snapshot: DashboardSearchSnapshot } | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  snapshot = { draft, principalId };
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
 * id disagrees with the store's current owner, the OLD owner's draft/timer are cleared first — a
 * write by a new principal must never land on top of a previous principal's in-flight state.
 * Guarded (a same-id call is a no-op) so a normal keystroke burst from the SAME principal never
 * clears itself; `resetDashboardSearchForPrincipal` below shares this same guard for the same
 * reason (Dashboard's own mount effect, `dashboard-search-store.test.ts`'s "a principal change
 * clears the store" test).
 */
function ensureOwner(viewerId: string): void {
  if (viewerId !== principalId) resetDashboardSearchForPrincipal(viewerId);
}

/**
 * #217 build, step 5: no internal committed copy left to update or compare against — a commit is
 * purely "cancel the pending timer, then hand the registered writer the normalised draft". With no
 * writer registered (off-Dashboard, or after this component's own unmount) the write is simply
 * dropped: there is nothing local left for it to fall back to, and nothing off-Dashboard ever reads
 * a "committed" value from this store in the first place (the rail's hrefs and an off-Dashboard
 * Enter both carry the normalised DRAFT instead — see `takeDashboardSearchForNavigation` below and
 * `ShellSearch.tsx`'s own Enter handler).
 */
function commit(): void {
  clearTimer();
  const normalized = normalizeDashboardSearchText(draft);
  writer?.(normalized);
}

export function subscribeDashboardSearch(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * TEST-ONLY. Unscoped: returns the store's raw state regardless of who is asking. RENDER code must
 * never use this — production code reads exclusively through `getDashboardSearchSnapshotForPrincipal`,
 * which this file deliberately does not also export unscoped under any other name.
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
  mismatchCache = { viewer: viewerId, snapshot: { draft: "", principalId: viewerId } };
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
 * The stateless draft-from-URL sync (#217 build, step 3) — one call, in `ShellRoute`'s own
 * `useLayoutEffect` keyed on location + principal, and the ONLY adoption path this store has left
 * (#217 build, step 5 drops the older URL-adoption function this file used to also export, which
 * existed only to keep a committed-query copy in step; there is no such copy left to keep in step).
 * `routeQuery` is the CALLER's own
 * `dashboardSearchOf(route)` for the CURRENTLY governing route -- this function does not parse a
 * route itself, and does not special-case a non-Dashboard route: the caller is responsible for not
 * calling this at all when `route.kind !== "dashboard"` (its lack of a `q` is not authoritative
 * off-Dashboard -- an Enter on the rail must still navigate with whatever the Staff member typed).
 *
 * Ownership first (`ensureOwner`), then the timer is cancelled UNCONDITIONALLY -- the Back/Forward
 * race fix, generalised: a location change (typed navigation, rail click, Back/Forward, or this
 * component's OWN debounced write landing) must never let an in-flight debounce fire after the fact
 * and overwrite whatever the URL now says.
 *
 * The draft itself is compared NORMALISED against `routeQuery ?? ""` before it is ever overwritten
 * -- this is what keeps the store's own debounced write from fighting the very typing that produced
 * it: that write emits exactly `normalizeDashboardSearchText(draft)` (`commit()` above), so once the
 * resulting URL lands back here, `normalize(draft) === (routeQuery ?? "")` and the raw draft (a
 * trailing space, mid-collapse whitespace) is left alone. Only a location that carries a GENUINELY
 * different committed search (a rail click to a different q, Back/Forward, a pasted deep link)
 * ever overwrites the draft.
 */
export function syncDashboardSearchDraftFromLocation(routeQuery: string | undefined, viewerId: string): void {
  ensureOwner(viewerId);
  clearTimer();
  const nextDraft = routeQuery ?? "";
  if (normalizeDashboardSearchText(draft) !== nextDraft) {
    draft = nextDraft;
    notify();
  }
}

/**
 * Off-Dashboard Enter, and every navigation site that used to flush-then-read `commitDashboardSearchNow`
 * + `getDashboardSearchSnapshotForPrincipal(...).query` as a pair (#217 build, step 3 adds this;
 * step 4 replaces those call sites; step 5 removes the `.query` this docblock used to describe
 * reading, since nothing local holds a committed copy any more). Cancels the pending timer -- the
 * write this function's caller is about to make (a `history.push`/`replace`) IS the commit, so there
 * is nothing left for a debounce to redundantly re-fire -- and returns the draft normalised exactly
 * the way the store's own `commit()` would, so a caller building a URL from this return value can
 * never disagree with what the store itself would have written.
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
 * (nulling `writer` then calling `commit()`) settled the committed value internally but the writer
 * was already gone, so the value was silently never written.
 *
 * The fix is at the class, not any one call site: unregistering NEVER touches the pending timer or
 * `draft` — only the `writer` reference itself, guarded so an out-of-order call can't null a writer
 * a NEWER registration already installed. A pending debounce keeps ticking across any number of
 * re-registrations and fires `commit()` against whichever writer is registered when it elapses,
 * which is exactly "keep the pending value in the store across unregister and commit it through
 * the next registered writer".
 *
 * #217 build, step 6: `Dashboard.tsx`'s own writer-registration effect no longer needs the
 * `writerGenerationRef` / `queueMicrotask` StrictMode dance this docblock used to describe working
 * around -- a fire with no writer registered is now simply dropped (there is no local `query` copy
 * left for it to update either), so an unmount's cleanup can unregister unconditionally without a
 * deferred check for whether a same-tick StrictMode replay already reclaimed ownership.
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
  principalId = "";
  timerOwner = "";
  writer = null;
  mismatchCache = null;
  notify();
}
