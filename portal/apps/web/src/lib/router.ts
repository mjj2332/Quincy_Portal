import { dashboardSearchOf, parseStaffLocation, parseStaffPathname, projectNotificationRoute, safeStaffDestination, staffPathFor, type DashboardCalendarFacetRoute, type DashboardViewRoute, type DashboardRoute, type StaffRoute } from "@quincy/shared";

export { dashboardSearchOf, parseStaffLocation, parseStaffPathname, projectNotificationRoute, safeStaffDestination, staffPathFor, type DashboardCalendarFacetRoute, type DashboardViewRoute, type DashboardRoute, type StaffRoute };

export type HistorySource = {
  location: Pick<Location, "pathname" | "search">;
  // `state` and `go` are optional so the many fakes that only exercise push/replace still
  // type-check; the real `window` supplies both.
  history: Pick<History, "pushState" | "replaceState"> & Partial<Pick<History, "state" | "go">>;
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
};

/**
 * #366: the Project sheet's bookkeeping, written into `history.state` (never the URL, so
 * `?collaboration=open` and every other spelling stays byte-exact). `backdrop` is the Dashboard
 * location the sheet floats over, `depth` how many sheet entries sit above the backdrop entry (so
 * closing can `history.go(-depth)`), `prev` the location the push came from. Only the adapter
 * writes it; everything read back is validated, because a reload or a hostile page can put
 * anything in `history.state`.
 */
export type SheetEntryState = { v: 1; backdrop: string; depth: number; prev: string };

export function readSheetEntryState(state: unknown): SheetEntryState | null {
  if (typeof state !== "object" || state === null) return null;
  const sheet = (state as { quincySheet?: unknown }).quincySheet;
  if (typeof sheet !== "object" || sheet === null) return null;
  const { v, backdrop, depth, prev } = sheet as Record<string, unknown>;
  if (v !== 1 || typeof depth !== "number" || !Number.isInteger(depth) || depth < 1) return null;
  if (typeof backdrop !== "string" || safeStaffDestination(backdrop) === null || parseStaffLocation(backdrop).kind !== "dashboard") return null;
  if (typeof prev !== "string" || safeStaffDestination(prev) === null) return null;
  return { v: 1, backdrop, depth, prev };
}

/** A Project location (the workspace, or its edit form — #374) floats over the Dashboard as a sheet. */
export function isSheetLocation(location: string): boolean {
  const kind = parseStaffLocation(location).kind;
  return kind === "project" || kind === "edit-project";
}

/** A location that renders inside the pathless Dashboard layer: the Dashboard itself or a sheet over it. */
export function isDashboardLayerLocation(location: string): boolean {
  const kind = parseStaffLocation(location).kind;
  return kind === "dashboard" || kind === "project" || kind === "edit-project";
}

/**
 * The `history.state` a push to `destination` writes. Only a push INTO a sheet carries state:
 * from a Dashboard view it starts the bookkeeping (`depth: 1`), from a sheet that already has valid
 * state it deepens it. A cold-linked sheet (no state) stays stateless — nothing below it is
 * provably ours, and closing it falls back to a `replace`.
 */
export function nextPushState(current: string, currentState: unknown, destination: string): { quincySheet: SheetEntryState } | null {
  if (!isSheetLocation(destination)) return null;
  const currentKind = parseStaffLocation(current).kind;
  if (currentKind === "dashboard") return { quincySheet: { v: 1, backdrop: current, depth: 1, prev: current } };
  if (currentKind === "project" || currentKind === "edit-project") {
    const existing = readSheetEntryState(currentState);
    return existing ? { quincySheet: { ...existing, depth: existing.depth + 1, prev: current } } : null;
  }
  return null;
}

export function createHistoryAdapter(source: HistorySource) {
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  // #367: counts navigations (push, popstate), never replace. A tab-naming URL is no longer
  // stripped, so an identical-URL push/popstate is invisible to a location-string diff; the shell
  // reads this to keep "an identical history arrival is a fresh signal".
  let epoch = 0;
  const onPopState = () => { epoch++; notify(); };

  return {
    getLocation: () => `${source.location.pathname}${source.location.search}`,
    getNavigationEpoch: () => epoch,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) source.addEventListener("popstate", onPopState);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) source.removeEventListener("popstate", onPopState);
      };
    },
    push(location: string) {
      const destination = safeStaffDestination(location) ?? "/";
      source.history.pushState(nextPushState(`${source.location.pathname}${source.location.search}`, source.history.state ?? null, destination), "", destination);
      epoch++;
      notify();
    },
    replace(location: string) {
      const destination = safeStaffDestination(location) ?? "/";
      // A replace keeps the sheet bookkeeping only sheet-to-sheet (the Workspace's own tab writes);
      // anything else drops it.
      const keep = isSheetLocation(`${source.location.pathname}${source.location.search}`) && isSheetLocation(destination);
      source.history.replaceState(keep ? (source.history.state ?? null) : null, "", destination);
      notify();
    },
    /** Traversal. No notify: the resulting popstate reaches the subscription by itself. */
    go(delta: number) {
      source.history.go?.(delta);
    },
  };
}

const browserHistory = typeof window === "undefined" ? null : createHistoryAdapter(window);

export function locationStore() {
  if (!browserHistory) throw new Error("Browser history is unavailable.");
  return browserHistory;
}

/**
 * #217 fix round 5, item 3 (Sol re-review, BLOCKER). Explicit sign-out (`NavigationRail.tsx`'s own
 * `handleSignOut`) leaves the URL alone: `App.tsx` hands that same URL to `SignIn`, and
 * `lib/auth.ts`'s `beginSignIn` preserves it as the OAuth callback / sign-in return path, so
 * signing out at `/?q=smith` and signing in as ANYONE re-applies `smith` (`Dashboard.tsx`'s
 * `committedQuery` is derived straight from the route at render, `dashboardSearchOf(parsedRoute)`
 * -- #217 build step 4 -- so it shows for a genuine deep link exactly the same way it would here).
 * Deep links must keep working — a shared `/?q=smith` URL opened while signed OUT should
 * still apply after sign-in — so this is deliberately NOT a parse-level or sign-in-time strip; only
 * the explicit sign-out ACTION scrubs the CURRENT location's own Dashboard search, through the
 * shared route parse/serialize (never string surgery, so it can never drift from what the parser
 * itself considers the search field on each shape): `q` on the bare/List/Kanban/Calendar-intent
 * arms, the facet's own `search` on the canonical Calendar URL. A location that isn't a Dashboard
 * route (nothing here carries a search) is returned unchanged.
 */
export function stripDashboardSearchFromLocation(location: string): string {
  const route = parseStaffLocation(location);
  if (route.kind !== "dashboard") return location;
  // #217 build, step 2: `dashboardSearchOf` is the one accessor for "what committed search does
  // this route carry" — reading through it, rather than reaching into `route.calendar.search`
  // directly a second way, is what keeps this in step with every other render-time reader of a
  // route. Already-empty is a real, safe no-op here (unlike the non-calendar arm just below):
  // `route` came from parsing `location` itself, so re-serialising an ALREADY-`""` calendar search
  // back through `staffPathFor` reproduces the exact same canonical string `location` already is —
  // this only skips a redundant round trip, it does not change what gets returned.
  if ("calendar" in route) {
    if (dashboardSearchOf(route) === "") return location;
    return staffPathFor({ kind: "dashboard", calendar: { ...route.calendar, search: "" } });
  }
  // #217 fix round 6, item 2 (Sol re-review, NIT). Always re-serialises from the PARSED route,
  // never the raw input string — a whitespace-only `q` (`/?q=+++`) normalises to NO search at
  // parse time (#217 fix round 5, item 4), so `route.search` is already `undefined` here and an
  // early "already stripped, return `location` unchanged" path handed back the literal `q=+++`
  // param untouched. `staffPathFor` on the searchless route is what actually removes it.
  const { search: _search, ...rest } = route;
  return staffPathFor(rest);
}

export type LinkClick = {
  button: number;
  detail: number;
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  currentTarget: { href: string; target: string; download: string };
};

/**
 * An unmodified primary activation — pointer or keyboard — becomes an SPA push; modified clicks,
 * other buttons, `target`, `download` and non-staff destinations keep native behaviour. (#366:
 * keyboard Enter used to be excluded via `detail === 0`; it is now intercepted, and
 * Ctrl/Meta/Shift/Alt+Enter still carry modifier flags so they still open natively.)
 */
export function shouldInterceptInternalLink(event: LinkClick, origin: string): boolean {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const anchor = event.currentTarget;
  if (anchor.target || anchor.download) return false;
  try {
    const url = new URL(anchor.href, origin);
    return url.origin === origin && safeStaffDestination(`${url.pathname}${url.search}`) !== null;
  } catch {
    return false;
  }
}
