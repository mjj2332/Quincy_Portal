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
import { createContext, use, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { roleHasCapability, type DashboardCalendarState, type Role } from "@quincy/shared";
import { locationStore, parseStaffLocation, staffPathFor, type StaffRoute } from "./router";
import { createStaffRouterHistory, parseStaffSearch, stringifyStaffSearch } from "./staff-history";
import { useCapabilities } from "./capabilities";
import { buildStaffNavigation } from "./staff-navigation";
import { DASHBOARD_VIEW_KEY, readRememberedDashboardView } from "../screens/dashboard-helpers";
import { consumeSignInDestination } from "./auth";
import { Topbar } from "../components/Topbar";
import { InternalLink } from "../components/InternalLink";
import { Dashboard } from "../screens/Dashboard";
import { ProjectWorkspace } from "../screens/ProjectWorkspace";
import { Admin } from "../screens/Admin";
import { CreateProject } from "../screens/CreateProject";
import { EditProject } from "../screens/EditProject";
import { NotificationPreferences } from "../screens/NotificationPreferences";
import { buttonClasses } from "../components/quincy/Button";

export type SessionUser = { id: string; name?: string | null; email?: string | null; role: Role; authorizationEpoch: number };
type Notice = { path: string; message: string } | null;

/** Identity and impersonation, supplied by `App` outside the router and read by the root route. */
const ShellIdentityContext = createContext<{ user: SessionUser; impersonating: boolean } | null>(null);

export function ShellIdentityProvider({ user, impersonating, children }: { user: SessionUser; impersonating: boolean; children: ReactNode }) {
  const value = useMemo(() => ({ user, impersonating }), [user, impersonating]);
  return <ShellIdentityContext value={value}>{children}</ShellIdentityContext>;
}

/** Everything the root route computes once and the leaves below it consume. */
type ShellState = {
  user: SessionUser;
  route: StaffRoute;
  pathname: string;
  notice: Notice;
  navigate: (path: string, message?: string, replace?: boolean) => void;
  clearNotice: () => void;
  dashboardCalendar: DashboardCalendarState | null;
  collaborationIntent: { projectId: string; signal: number } | null;
  acknowledgeCollaborationSignal: (projectId: string, signal: number) => void;
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
  const lastObservedIntentLocationRef = useRef<string | null>(null);
  const collaborationSignalRef = useRef(0);
  const [collaborationIntent, setCollaborationIntent] = useState<{ projectId: string; signal: number } | null>(null);
  const { can } = useCapabilities();
  const canAccessAdmin = can("adminBackend");
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
    if (route.kind === "project" && route.collaboration === "open") {
      if (lastObservedIntentLocationRef.current !== completeLocation) {
        lastObservedIntentLocationRef.current = completeLocation;
        const signal = ++collaborationSignalRef.current;
        setCollaborationIntent({ projectId: route.projectId, signal });
      }
      return;
    }
    lastObservedIntentLocationRef.current = null;
    setCollaborationIntent(null);
  }, [completeLocation, route]);

  const acknowledgeCollaborationSignal = (projectId: string, signal: number) => {
    if (route.kind !== "project" || route.projectId !== projectId || route.collaboration !== "open" || collaborationIntent?.projectId !== projectId || collaborationIntent.signal !== signal) return;
    lastObservedIntentLocationRef.current = null;
    history.replace(staffPathFor({ kind: "project", projectId }));
  };

  useEffect(() => {
    if (blocked) history.replace("/");
  }, [blocked, history]);

  useEffect(() => {
    if (calendarBlocked) history.replace("/");
  }, [calendarBlocked, history]);

  function navigate(path: string, message?: string, replace = false) {
    if (message) setNotice({ path, message });
    else setNotice(null);
    if (replace) history.replace(path); else history.push(path);
  }

  // The navigation model replaces `viewFor` (#111). It is computed here, once, from the route the
  // shell already parsed — the Topbar reads its coarse `activeSectionId` today, and the rail behind
  // the flag reads the whole tree. Re-resolved on every location change rather than snapshotted:
  // the Dashboard writes the view preference and then navigates, so a mount-time read goes stale.
  const navigation = useMemo(() => buildStaffNavigation(
    route,
    readRememberedDashboardView({ read: () => window.localStorage.getItem(DASHBOARD_VIEW_KEY) }),
    { adminBackend: canAccessAdmin, viewProductionCalendar: roleHasCapability(user.role, "viewProductionCalendar") },
  ), [canAccessAdmin, route, user.role]);
  const activeView = navigation.activeSectionId;
  const dashboardCalendar = route.kind === "dashboard" && "calendar" in route && !calendarBlocked ? route.calendar : null;
  const shell: ShellState = {
    user, route, pathname, notice, navigate,
    clearNotice: () => setNotice(null),
    dashboardCalendar, collaborationIntent, acknowledgeCollaborationSignal,
  };

  return (
    <div className={impersonating ? "app app--impersonating" : "app"}>
      <Topbar activeView={activeView} canAccessAdmin={canAccessAdmin} user={user} />
      {blocked
        ? <main className="page"><div className="empty" role="status"><span className="serif">Returning to dashboard.</span></div></main>
        : <ShellStateContext value={shell}><Outlet /></ShellStateContext>}
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
    const { route, notice, pathname, clearNotice, collaborationIntent, acknowledgeCollaborationSignal } = useShell();
    if (route.kind !== "project") return <NotAvailable />;
    return <ProjectWorkspace
      key={route.projectId}
      projectId={route.projectId}
      notice={notice?.path === pathname ? notice.message : null}
      onNoticeShown={clearNotice}
      collaborationOpenSignal={collaborationIntent?.projectId === route.projectId ? collaborationIntent.signal : undefined}
      onCollaborationOpenSignalConsumed={(signal) => acknowledgeCollaborationSignal(route.projectId, signal)}
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

const notificationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/notifications",
  component: function NotificationsLeaf() {
    const { route } = useShell();
    if (route.kind !== "notifications") return <NotAvailable />;
    return <NotificationPreferences />;
  },
});

// Everything else — an unroutable path, or a reserved delivery or backend namespace — is handled
// by the root's `notFoundComponent`. An explicit "$" catch-all leaf was tried here first and
// removed: deleting it changed no test, because the root already renders the same view inside the
// same chrome. A route that cannot be observed to do anything is decoration, not defence.
const routeTree = rootRoute.addChildren([
  dashboardRoute, createProjectRoute, projectRoute, editProjectRoute, adminRoute, notificationsRoute,
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
  const { history, connect } = createStaffRouterHistory(adapter);
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
