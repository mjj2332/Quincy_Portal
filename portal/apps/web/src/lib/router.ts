import { parseStaffLocation, parseStaffPathname, projectNotificationRoute, safeStaffDestination, staffPathFor, type DashboardCalendarFacetRoute, type DashboardViewRoute, type DashboardRoute, type StaffRoute } from "@quincy/shared";

export { parseStaffLocation, parseStaffPathname, projectNotificationRoute, safeStaffDestination, staffPathFor, type DashboardCalendarFacetRoute, type DashboardViewRoute, type DashboardRoute, type StaffRoute };

export type HistorySource = {
  location: Pick<Location, "pathname" | "search">;
  history: Pick<History, "pushState" | "replaceState">;
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
};

export function createHistoryAdapter(source: HistorySource) {
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const onPopState = () => notify();

  return {
    getLocation: () => `${source.location.pathname}${source.location.search}`,
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
      source.history.pushState(null, "", destination);
      notify();
    },
    replace(location: string) {
      const destination = safeStaffDestination(location) ?? "/";
      source.history.replaceState(null, "", destination);
      notify();
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
 * signing out at `/?q=smith` and signing in as ANYONE re-applies `smith` (`Dashboard.tsx`'s own
 * route-reconciliation effect adopts it from the route, exactly as it would for a genuine deep
 * link). Deep links must keep working — a shared `/?q=smith` URL opened while signed OUT should
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
  if ("calendar" in route) return staffPathFor({ kind: "dashboard", calendar: { ...route.calendar, search: "" } });
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

/** Keyboard-generated anchor clicks have detail 0 and must retain native behavior. */
export function shouldInterceptInternalLink(event: LinkClick, origin: string): boolean {
  if (event.defaultPrevented || event.button !== 0 || event.detail === 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const anchor = event.currentTarget;
  if (anchor.target || anchor.download) return false;
  try {
    const url = new URL(anchor.href, origin);
    return url.origin === origin && safeStaffDestination(`${url.pathname}${url.search}`) !== null;
  } catch {
    return false;
  }
}
