/**
 * The staff application's route tree (#52) — code-based, ported 1:1 from the hand-rolled
 * `route.kind` switch that used to live in `App.tsx`.
 *
 * ## Who decides what
 *
 * TanStack Router decides **which screen component mounts**. `parseStaffLocation` decides
 * **whether the location is valid at all, and what its parameters mean**. That division is
 * deliberate and it is the reason this port does not weaken the URL contract:
 *
 * TanStack's matcher is permissive by design — `/projects/$projectId` happily matches an
 * uppercase UUID, and `$` matches anything. Quincy's parser is not: it rejects non-canonical UUID
 * casing, percent-encoded spellings of static segments, `//`, trailing slashes, `.`/`..`, control
 * characters, reserved namespaces and every non-canonical query spelling. So every leaf below
 * consults the parser before rendering, and renders the same "not available" view the app has
 * always shown when the parser disagrees. Because that check is uniform across every leaf, the
 * matcher and the parser cannot drift apart into a hole: a location the parser rejects renders
 * not-found no matter which leaf the matcher happened to pick.
 *
 * This is why the route tree is not decorative. Delete a leaf and its screen stops mounting.
 *
 * ## Why the raw location, not `router.state.location`
 *
 * `@tanstack/history`'s `parseHref` runs its own `sanitizePath`, which strips control characters
 * and collapses a leading `//`. Feeding that laundered href to `parseStaffLocation` would let a
 * hostile location arrive as something the parser might accept. The Shell therefore subscribes to
 * the history adapter directly and parses the untouched `pathname + search`, exactly as it did
 * before this migration.
 *
 * ## Why screens do not use router hooks
 *
 * `Dashboard`, `Admin`, `ImpersonationBanner` and `PrincipalFreshnessBoundary` are each rendered
 * standalone by their own DOM tests, with `createRoot` and no provider of any kind, and those
 * tests may not be edited. `useRouter`/`useNavigate` throw without a `RouterProvider`, so those
 * components keep navigating through `locationStore()`. The adapter subscription in
 * `staff-history.ts` is how the router hears about the writes they make.
 */
import { createContext, use, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { dashboardSearchOf, roleHasCapability, type DashboardCalendarState, type Role, type WorkspaceTab } from "@quincy/shared";
import { locationStore, parseStaffLocation, staffPathFor, type StaffRoute } from "./router";
import { createStaffRouterHistory, parseStaffSearch, stringifyStaffSearch } from "./staff-history";
import { useCapabilities } from "./capabilities";
import { buildStaffNavigation, type StaffNavigation, type StaffNavigationItem } from "./staff-navigation";
import { DASHBOARD_VIEW_KEY, readRememberedDashboardView } from "../screens/dashboard-helpers";
import { readDashboardView, subscribeDashboardView } from "./dashboard-view-store";
import { getDashboardSearchSnapshotForPrincipal, subscribeDashboardSearch, syncDashboardSearchDraftFromLocation } from "./dashboard-search-store";
import { consumeSignInDestination } from "./auth";
import { cn } from "./utils";
import { RailedShell } from "../components/quincy/RailedShell";
import { InternalLink } from "../components/InternalLink";
import { Dashboard } from "../screens/Dashboard";
import { ProjectWorkspace } from "../screens/ProjectWorkspace";
import { Admin } from "../screens/Admin";
import { CreateProject } from "../screens/CreateProject";
import { EditProject } from "../screens/EditProject";
import { NotificationPreferences } from "../screens/NotificationPreferences";
import { NoticeBoardPage } from "../screens/NoticeBoardPage";
import { Notifications } from "../screens/Notifications";
import { buttonClasses } from "../components/quincy/Button";

export type SessionUser = { id: string; name?: string | null; email?: string | null; role: Role; authorizationEpoch: number };
type Notice = { path: string; message: string } | null;

/** Identity and impersonation, supplied by `App` outside the router and read by the root route. */
const ShellIdentityContext = createContext<{ user: SessionUser; impersonating: boolean } | null>(null);

export function ShellIdentityProvider({ user, impersonating, children }: { user: SessionUser; impersonating: boolean; children: ReactNode }) {
  const value = useMemo(() => ({ user, impersonating }), [user, impersonating]);
  return <ShellIdentityContext value={value}>{children}</ShellIdentityContext>;
}

/** #337/#367: a Project route's Workspace-tab arrival: a push, popstate or external replace that
 * names a tab (`?tab=<kind>` / `?collaboration=open`), numbered so a repeat arrival at an identical
 * URL is still a fresh signal. The Workspace's own tab `replace` is not an arrival. */
type ArrivalIntent = { projectId: string; tab: WorkspaceTab; signal: number; location: string };

/** Everything the root route computes once and the leaves below it consume. */
type ShellState = {
  user: SessionUser;
  route: StaffRoute;
  pathname: string;
  notice: Notice;
  navigate: (path: string, message?: string, replace?: boolean) => void;
  clearNotice: () => void;
  dashboardCalendar: DashboardCalendarState | null;
  arrivalIntent: ArrivalIntent | null;
  acknowledgeArrivalSignal: (projectId: string, signal: number) => void;
  syncProjectTab: (projectId: string, tab: WorkspaceTab) => void;
};

const ShellStateContext = createContext<ShellState | null>(null);

function useShell(): ShellState {
  const value = use(ShellStateContext);
  if (!value) throw new Error("Shell state is unavailable outside the staff router.");
  return value;
}

function NotAvailable() {
  return (
    <main className="page">
      <div className="empty" role="status">
        <span className="serif">That page is not available.</span>
        <InternalLink className={buttonClasses("secondary", {})} to="/">Return to dashboard</InternalLink>
      </div>
    </main>
  );
}

/** `staff-navigation.ts`'s own Dashboard child ids, mapped back onto the view they mean — kept
 * here rather than exported from that module, since ids are its own implementation detail. */
const DASHBOARD_CHILD_VIEW: Record<string, "list" | "kanban" | "calendar"> = {
  "dashboard-list": "list",
  "dashboard-kanban": "kanban",
  "dashboard-calendar": "calendar",
};

/**
 * #217 fix round 3, item 1 (Sol's whole-branch review). `staff-navigation.ts` stays pure — no
 * search-store or route-serializer knowledge — so this is where the rail's Dashboard child hrefs
 * get the LIVE search grafted back on, after the pure model has already built them. Reads
 * `draft`, not `query`: the input already renders the draft directly, and building the href from
 * the same value means a rail click mid-debounce (before the 300ms commit) still carries the
 * in-progress text, with no separate "flush before navigating" step needed here (unlike
 * `selectView`'s in-app switch, which must flush because it reads the draft, normalised, to build
 * its `history.push` synchronously — URL-authoritative committed query; the store holds
 * draft/timer/owner only).
 *
 * List/Kanban map the search onto `q` directly, through `staffPathFor`. Calendar does too now
 * (#217 fix round 4, item 1, BLOCKER): the bare intent became a legal spelling for `q`
 * (`staff-routes.ts`'s `DashboardCalendarIntentRoute`) specifically because a native navigation —
 * keyboard Enter (`InternalLink`'s own `shouldInterceptInternalLink` only claims a genuine
 * left-click), cmd/middle-click, "open in new tab", a reload — loads `href` as a fresh document
 * with a COLD, empty search store, and the old bare-intent href lost the search on every one of
 * those paths. When `dashboardCalendar` is non-null (the CURRENT route is already a calendar facet
 * with known date/subview/filters), the href stays the full facet URL, mapping the search onto its
 * `search` field the same way `selectView` does when switching INTO Calendar. Resolving those
 * date/subview preferences here for the general case (arriving at Calendar from List/Kanban/
 * elsewhere, no facet state to carry forward) was rejected for the same reason `staff-routes.ts`'s
 * own docblock gives: it would put that preference-resolution logic in two places — `Dashboard.tsx`'s
 * own canonicaliser is still what owns the one full-facet rewrite for THAT case, reading the search
 * this href now carries on the intent itself.
 *
 * Neither branch pre-normalises `query` before handing it to `staffPathFor`/`calendarPathFor`
 * (#217 fix round 4, item 2, do-with-1): both now run every `search` through the one shared
 * `normalizeDashboardSearchText` themselves, so a raw, not-yet-committed draft (`"  smith   street
 * "`) reaches the URL exactly as normalised as a commit through the store would write it — no
 * caller-side pre-processing left to get out of sync with it. URL-authoritative committed query;
 * the store holds draft/timer/owner only.
 */
function withLiveDashboardSearch(navigation: StaffNavigation, query: string, dashboardCalendar: DashboardCalendarState | null): StaffNavigation {
  function hrefFor(child: StaffNavigationItem): string {
    const view = DASHBOARD_CHILD_VIEW[child.id];
    if (view === "list" || view === "kanban") return staffPathFor({ kind: "dashboard", dashboardView: view, ...(query ? { search: query } : {}) });
    if (view === "calendar") {
      if (dashboardCalendar) return staffPathFor({ kind: "dashboard", calendar: { ...dashboardCalendar, search: query } });
      return staffPathFor({ kind: "dashboard", dashboardView: "calendar", ...(query ? { search: query } : {}) });
    }
    return child.href;
  }
  // #217 fix round 8, Sol review, item 1 (HIGH). The top-level "Dashboard" item
  // (`staff-navigation.ts`'s `id: "dashboard"`) is itself a real, clickable rail link
  // (`NavigationRail.tsx`), not just a container for the children `hrefFor` above already covers.
  // Left bare `/`, clicking it from off-Dashboard landed on a q-less URL that `ShellRoute`'s own
  // sync then treated as authoritative and used to clear an in-progress draft that had never been
  // committed anywhere else. Built with the same `staffPathFor` the List/Kanban children use, so an
  // empty draft still yields the bare `/` this link has always had.
  return {
    ...navigation,
    groups: navigation.groups.map((group) => ({
      ...group,
      items: group.items.map((item) => !item.children ? item : {
        ...item,
        ...(item.id === "dashboard" ? { href: staffPathFor({ kind: "dashboard", ...(query ? { search: query } : {}) }) } : {}),
        children: item.children.map((child) => ({ ...child, href: hrefFor(child) })),
      }),
    })),
  };
}

/**
 * The application shell: chrome, cross-cutting navigation state, and the capability redirects.
 * Ported verbatim from the former `Shell` component in `App.tsx`; the only structural change is
 * that the `route.kind` render chain became the route tree, reached through `<Outlet />`.
 */
function ShellRoute() {
  const identity = use(ShellIdentityContext);
  if (!identity) throw new Error("Shell identity is unavailable.");
  const { user, impersonating } = identity;

  const history = locationStore();
  // Raw location, deliberately not `router.state.location` — see the module comment.
  const completeLocation = useSyncExternalStore(history.subscribe, history.getLocation, () => "/");
  const pathname = completeLocation.split("?", 1)[0]!;
  const route = useMemo(() => parseStaffLocation(completeLocation), [completeLocation]);
  const [notice, setNotice] = useState<Notice>(null);
  const restored = useRef(false);
  const navigationEpoch = useSyncExternalStore(history.subscribe, history.getNavigationEpoch, () => 0);
  const lastObservedRef = useRef<{ location: string; epoch: number } | null>(null);
  const selfWriteRef = useRef<string | null>(null);
  const arrivalSignalRef = useRef(0);
  const [arrivalIntent, setArrivalIntent] = useState<ArrivalIntent | null>(null);
  const { can } = useCapabilities();
  const canAccessAdmin = can("adminBackend");
  const canViewNoticeBoard = can("viewNoticeBoard");
  const canCreateProject = can("createProject");
  const canEditProject = can("editProject");
  const blocked = (route.kind === "admin" && !canAccessAdmin)
    || (route.kind === "create-project" && !canCreateProject)
    || (route.kind === "edit-project" && !canEditProject);
  // Both Calendar spellings are gated identically: the parameterised facet, and #111's bare
  // `/?view=calendar` intent the navigation rail links to. Gating only the facet would leave the
  // intent as an unguarded way into the Calendar for a role without the capability — it reaches
  // the Dashboard, which canonicalises it to the facet URL before the guard ever sees one.
  const wantsCalendar = route.kind === "dashboard"
    && ("calendar" in route || ("dashboardView" in route && route.dashboardView === "calendar"));
  const calendarBlocked = wantsCalendar && !roleHasCapability(user.role, "viewProductionCalendar");

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const destination = consumeSignInDestination();
    if (destination !== null && destination !== completeLocation) history.replace(destination);
  }, [completeLocation, history]);

  useEffect(() => {
    if (route.kind === "project" && route.arrivalTab !== undefined) {
      const last = lastObservedRef.current;
      const changed = !last || last.location !== completeLocation || last.epoch !== navigationEpoch;
      if (!changed) return;
      const selfWrite = selfWriteRef.current === completeLocation && last?.epoch === navigationEpoch;
      selfWriteRef.current = null;
      lastObservedRef.current = { location: completeLocation, epoch: navigationEpoch };
      if (selfWrite) { setArrivalIntent(null); return; } // the Workspace's own tab write is not an arrival
      const signal = ++arrivalSignalRef.current;
      setArrivalIntent({ projectId: route.projectId, tab: route.arrivalTab, signal, location: completeLocation });
      return;
    }
    lastObservedRef.current = null;
    selfWriteRef.current = null;
    setArrivalIntent(null);
  }, [completeLocation, navigationEpoch, route]);

  // The intent observed for the CURRENT location only. Between a location change and the effect above
  // observing it, the stored intent still describes the previous URL; it is neither handed to the
  // Workspace nor acknowledgeable then, so a stale acknowledgement can never strip a newer arrival.
  const currentArrivalIntent = route.kind === "project" && route.arrivalTab !== undefined && arrivalIntent?.location === completeLocation && arrivalIntent.projectId === route.projectId && arrivalIntent.tab === route.arrivalTab ? arrivalIntent : null;
  const acknowledgeArrivalSignal = (projectId: string, signal: number) => {
    if (currentArrivalIntent?.projectId !== projectId || currentArrivalIntent.signal !== signal) return;
    // #367: the tab stays in the URL; acknowledging only spends the signal.
    setArrivalIntent(null);
  };
  // #367: the Workspace tells the shell which tab it is showing; the URL follows by `replace`.
  const syncProjectTab = (projectId: string, tab: WorkspaceTab) => {
    if (route.kind !== "project" || route.projectId !== projectId) return;
    // A tab-naming location this shell has not observed yet is an arrival still to be handed over (the
    // Workspace's effects run before the shell's): it must land first, never be overwritten by the tab shown before it.
    if (route.arrivalTab !== undefined) {
      const observed = lastObservedRef.current;
      if (!observed || observed.location !== completeLocation || observed.epoch !== navigationEpoch) return;
    }
    const target = staffPathFor({ kind: "project", projectId, arrivalTab: tab });
    if (target === completeLocation) return;
    selfWriteRef.current = target;
    history.replace(target);
  };

  useEffect(() => {
    if (blocked) history.replace("/");
  }, [blocked, history]);

  // #217 build, step 3: the ONE draft-from-URL sync call, replacing every render-side adoption
  // path `Dashboard.tsx` used to own (step 4 deletes that machinery). `useLayoutEffect`, not
  // `useEffect` -- same reasoning `ShellSearch.tsx`'s own ownership-claim effect already documents:
  // React flushes every layout effect in a commit, tree-wide, before any passive effect in that
  // same commit, so the draft is never one paint behind the URL that governs it. Keyed on
  // `completeLocation` (not just `route`, though the two always change together here) and
  // `user.id` -- the exact two inputs `syncDashboardSearchDraftFromLocation` itself takes -- so a
  // location OR a principal change (impersonation start/stop; `App.tsx` remounts this component's
  // whole subtree for a principal change via its own `key`, but the layout effect ordering
  // guarantee is what matters for a location change alone) both run it. A non-Dashboard route's
  // lack of `q` is not authoritative (an Enter on the rail must still navigate with whatever text
  // is showing, `ShellSearch.tsx`'s own off-Dashboard Enter path) -- this only calls the store when
  // `route.kind === "dashboard"`, never unconditionally.
  useLayoutEffect(() => {
    if (route.kind !== "dashboard") return;
    syncDashboardSearchDraftFromLocation(dashboardSearchOf(route), user.id);
  }, [completeLocation, route, user.id]);

  // #217 fix round 5, item 5 (Sol re-review, SHOULD-FIX). Calendar itself stays inaccessible
  // either way, but the redirect used to drop straight to "/", discarding whatever `q` the blocked
  // URL carried -- unlike every OTHER q-carrying redirect in this app. `route` already has the
  // parsed search on either Calendar shape (`calendar` in route: the facet's own `search` field;
  // `dashboardView === "calendar"`: the intent's own optional `search`), so this reads it from
  // there rather than re-parsing anything.
  useEffect(() => {
    if (!calendarBlocked || route.kind !== "dashboard") return;
    const search = "calendar" in route ? route.calendar.search : "dashboardView" in route ? route.search : undefined;
    history.replace(staffPathFor({ kind: "dashboard", ...(search ? { search } : {}) }));
  }, [calendarBlocked, history, route]);

  function navigate(path: string, message?: string, replace = false) {
    if (message) setNotice({ path, message });
    else setNotice(null);
    if (replace) history.replace(path); else history.push(path);
  }

  // The navigation model replaces `viewFor` (#111). It reads the route the shell already parsed,
  // and — #119 — the view the Dashboard itself is actually rendering, published through
  // `lib/dashboard-view-store.ts` rather than re-derived here: see `staff-navigation.ts`'s own
  // header for why a second derivation drifted (archive scope, a Back past an explicit switch) and
  // must not come back. The remembered preference remains the pre-mount fallback, for the single
  // frame before any Dashboard instance has published.
  const publishedDashboardView = useSyncExternalStore(subscribeDashboardView, readDashboardView, () => null);
  const dashboardCalendar = route.kind === "dashboard" && "calendar" in route && !calendarBlocked ? route.calendar : null;
  // #217 fix round 3, item 1: the rail's own Dashboard child links, read here (not inside
  // `staff-navigation.ts`, which stays pure) so a rail click carries the live search the same way
  // the in-Dashboard view switcher already does. `ShellSearch` reads the identical store, so the
  // input and every rail href this produces can never disagree about what "the current q" is.
  // #217 fix round 5, item 1 (Sol re-review, BLOCKER): principal-scoped -- an unscoped read here
  // could serialise the PREVIOUS principal's draft into the rail's own hrefs for a render pass
  // (worst on the narrow layout with the Sheet closed, where no `ShellSearch` instance is even
  // mounted to make the layout-effect ownership claim).
  const dashboardSearchDraft = useSyncExternalStore(
    subscribeDashboardSearch,
    () => getDashboardSearchSnapshotForPrincipal(user.id),
    () => getDashboardSearchSnapshotForPrincipal(user.id),
  ).draft;
  const navigation = useMemo(() => withLiveDashboardSearch(buildStaffNavigation(
    route,
    readRememberedDashboardView({ read: () => window.localStorage.getItem(DASHBOARD_VIEW_KEY) }),
    { adminBackend: canAccessAdmin, viewProductionCalendar: roleHasCapability(user.role, "viewProductionCalendar"), viewNoticeBoard: canViewNoticeBoard },
    publishedDashboardView,
  ), dashboardSearchDraft, dashboardCalendar), [canAccessAdmin, canViewNoticeBoard, dashboardCalendar, dashboardSearchDraft, publishedDashboardView, route, user.role]);
  const shell: ShellState = {
    user, route, pathname, notice, navigate,
    clearNotice: () => setNotice(null),
    dashboardCalendar, arrivalIntent: currentArrivalIntent, acknowledgeArrivalSignal, syncProjectTab,
  };

  const routedContent = blocked
    ? <main className="page"><div className="empty" role="status"><span className="serif">Returning to dashboard.</span></div></main>
    : <ShellStateContext value={shell}><Outlet /></ShellStateContext>;

  return (
    <div className={cn("app", impersonating && "app--impersonating", "app--railed")}>
      <RailedShell navigation={navigation} user={user} principalId={user.id}>{routedContent}</RailedShell>
    </div>
  );
}

const rootRoute = createRootRoute({ component: ShellRoute, notFoundComponent: NotAvailable });

// `/` — the dashboard, plus every non-canonical query spelling that lands on the same pathname.
const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: function DashboardLeaf() {
    const { route, user, dashboardCalendar } = useShell();
    if (route.kind !== "dashboard") return <NotAvailable />;
    return <Dashboard currentUserId={user.id} role={user.role} authorizationEpoch={user.authorizationEpoch} calendar={dashboardCalendar} />;
  },
});

const createProjectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/new",
  component: function CreateProjectLeaf() {
    const { route, navigate } = useShell();
    if (route.kind !== "create-project") return <NotAvailable />;
    return <CreateProject onNavigate={navigate} />;
  },
});

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
  component: function ProjectLeaf() {
    const { route, notice, pathname, clearNotice, arrivalIntent, acknowledgeArrivalSignal, syncProjectTab } = useShell();
    if (route.kind !== "project") return <NotAvailable />;
    return <ProjectWorkspace
      key={route.projectId}
      projectId={route.projectId}
      notice={notice?.path === pathname ? notice.message : null}
      onNoticeShown={clearNotice}
      arrivalSignal={arrivalIntent?.projectId === route.projectId ? arrivalIntent.signal : undefined}
      arrivalTab={arrivalIntent?.projectId === route.projectId ? arrivalIntent.tab : undefined}
      onArrivalConsumed={(signal) => acknowledgeArrivalSignal(route.projectId, signal)}
      urlTab={route.arrivalTab}
      onTabShown={(tab) => syncProjectTab(route.projectId, tab)}
    />;
  },
});

const editProjectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/edit",
  component: function EditProjectLeaf() {
    const { route, navigate } = useShell();
    if (route.kind !== "edit-project") return <NotAvailable />;
    return <EditProject key={route.projectId} projectId={route.projectId} onNavigate={navigate} />;
  },
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: function AdminLeaf() {
    const { route, user } = useShell();
    if (route.kind !== "admin") return <NotAvailable />;
    return <Admin currentUserId={user.id} />;
  },
});

// #334 — not in the shell's redirecting `blocked` set on purpose: an external editor stays at
// `/notices` and gets the standard unavailable view rather than a bounce to the Dashboard.
const noticesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/notices",
  component: function NoticesLeaf() {
    const { route, user } = useShell();
    const { can } = useCapabilities();
    if (route.kind !== "notices" || !can("viewNoticeBoard")) return <NotAvailable />;
    return <NoticeBoardPage currentUserId={user.id} />;
  },
});

const notificationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/notifications",
  component: function NotificationsLeaf() {
    const { route } = useShell();
    if (route.kind !== "notifications") return <NotAvailable />;
    return <Notifications />;
  },
});

// #115 — preferences moved off `/settings/notifications` (now the list) onto its own leaf.
const notificationPreferencesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/notifications/preferences",
  component: function NotificationPreferencesLeaf() {
    const { route } = useShell();
    if (route.kind !== "notification-preferences") return <NotAvailable />;
    return <NotificationPreferences />;
  },
});

// Everything else — an unroutable path, or a reserved delivery or backend namespace — is handled
// by the root's `notFoundComponent`. An explicit "$" catch-all leaf was tried here first and
// removed: deleting it changed no test, because the root already renders the same view inside the
// same chrome. A route that cannot be observed to do anything is decoration, not defence.
const routeTree = rootRoute.addChildren([
  dashboardRoute, createProjectRoute, projectRoute, editProjectRoute, adminRoute, noticesRoute, notificationsRoute,
  notificationPreferencesRoute,
]);

/**
 * Builds a router over a supplied history adapter.
 *
 * No `loader`, no `beforeLoad`, no `pendingComponent`, no lazy route component, and preloading
 * off — all four deliberately. The DOM suite renders `<App />` inside `act()` and settles with two
 * `Promise.resolve()` ticks and no `waitFor`, and it may not be edited, so the first paint has to
 * be synchronous. A loader-free match resolves before `router.load()`'s first await; adding any
 * async route work would paint blank and fail the suite.
 */
export function createStaffRouter(adapter: ReturnType<typeof locationStore>) {
  // #266: TanStack scrolls to the top after every render it is notified of (its `onRendered`
  // subscriber runs even with `scrollRestoration` off). `_scroll.next` is the flag its own
  // `resetScroll: false` navigation option sets; our navigations never pass through the router, so
  // the history sets it instead — a query-only change keeps the scroll position, a new pathname
  // lands at the top. `_scroll` is internal: `app-router-scroll.dom.test.tsx` pins it across upgrades.
  const { history, connect } = createStaffRouterHistory(adapter, {
    beforeNotify: ({ pathnameChanged }) => { router._scroll.next = pathnameChanged; },
  });
  const router = createRouter({
    routeTree,
    history,
    defaultPreload: false,
    // Quincy's parser treats a trailing slash as not-found; TanStack's default would rewrite the
    // URL to strip it, which would both mask the error and edit a location on arrival.
    trailingSlash: "preserve",
    parseSearch: parseStaffSearch,
    stringifySearch: stringifyStaffSearch,
    defaultNotFoundComponent: NotAvailable,
  });
  router.load();
  return { router, connect };
}

/**
 * Mounts the staff router.
 *
 * The router is built **per mount**, not once per module, and this is load-bearing rather than
 * tidiness. `@tanstack/history` reads the location when it is created and thereafter only when
 * something notifies it, so a module-level router outlives the location it was built for: a fresh
 * mount at a different URL would keep matching the previous one. Every screen would still render,
 * because the Shell parses the live location itself — which is exactly how a route tree rots into
 * decoration while the suite stays green. Building per mount keeps the matched leaf and the parsed
 * route answering for the same URL.
 */
export function StaffRouter() {
  const [{ router, connect }] = useState(() => createStaffRouter(locationStore()));
  // Subscribe inside the effect, not at construction: StrictMode double-invokes this, and a
  // subscription made once would be torn down by the first cleanup and never rebuilt.
  useEffect(() => connect(), [connect]);
  return <RouterProvider router={router} />;
}
