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
import { createContext, use, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { dashboardSearchOf, roleHasCapability, type DashboardCalendarState, type Role, type WorkspaceTab } from "@quincy/shared";
import { pushToast } from "./toast-store";
import { canonicalLegacyDashboardLocation, dashboardFocusOf, isDashboardLayerLocation, isSheetLocation, locationStore, parseStaffLocation, readSheetEntryState, staffPathFor, type StaffRoute } from "./router";
import { createDashboardBackdropSource, DashboardLocationContext, type DashboardBackdropSource } from "./dashboard-location";
import { createStaffRouterHistory, parseStaffSearch, stringifyStaffSearch } from "./staff-history";
import { useCapabilities } from "./capabilities";
import { buildStaffNavigation, type StaffNavigation } from "./staff-navigation";
import { DASHBOARD_VIEW_KEY, readRememberedDashboardView } from "../screens/dashboard-helpers";
import { readDashboardView, subscribeDashboardView } from "./dashboard-view-store";
import { getDashboardSearchSnapshotForPrincipal, subscribeDashboardSearch, syncDashboardSearchDraftFromLocation, takeDashboardSearchForNavigation } from "./dashboard-search-store";
import { consumeSignInDestination } from "./auth";
import { cn } from "./utils";
import { RailedShell } from "../components/quincy/RailedShell";
import { ProjectSheet } from "../components/quincy/ProjectSheet";
import { InternalLink } from "../components/InternalLink";
import { Dashboard } from "../screens/Dashboard";
import { ProjectWorkspace } from "../screens/ProjectWorkspace";
import { Admin } from "../screens/Admin";
import { CreateProject } from "../screens/CreateProject";
import { EditProject } from "../screens/EditProject";
import { NotificationPreferences } from "../screens/NotificationPreferences";
import { ConnectedApps } from "../screens/ConnectedApps";
import { ConnectedAppConsent } from "../screens/ConnectedAppConsent";
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

/** #427: a ⌘K request to focus the Dashboard toolbar's search, for ONE Dashboard location. Same shape
 * as `ArrivalIntent` (#367): current only while `location` is the Dashboard layer's location, then
 * acknowledged by the field that took focus. Held here — not in the search store, not in a module
 * singleton — so it is scoped to this shell (and so to its principal: `App.tsx` remounts the shell
 * on a principal change). */
type SearchFocusRequest = { location: string; signal: number };

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
  /** #498: the Project whiteboard's link. Open pushes `?whiteboard=open`; close returns to `tab`. */
  openProjectWhiteboard: (projectId: string) => void;
  closeProjectWhiteboard: (projectId: string, tab: WorkspaceTab) => void;
  /** #427: the ⌘K request that is current for the Dashboard layer's location, or null. */
  searchFocusSignal: number | null;
  acknowledgeSearchFocus: (signal: number) => void;
  impersonating: boolean;
  /** #366: the Project route renders as a sheet floating over the live Dashboard. */
  isSheetRoute: boolean;
  /** The Dashboard location the sheet floats over (the remembered one), and its parse. */
  backdropLocation: string;
  backdropSource: DashboardBackdropSource;
  closeProjectSheet: () => void;
  /** #374: Save / Cancel / Archive / Restore from the edit form. Returns by traversal (see the impl). */
  returnToWorkspace: (projectId: string, message?: string) => void;
  /** #374: the project was permanently deleted from the edit form. */
  leaveDeletedProject: (projectId: string, message: string) => void;
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
 * #217 fix round 3, item 1 (Sol's whole-branch review), narrowed by #426 (ADR 0015).
 * `staff-navigation.ts` stays pure — no search-store or route-serializer knowledge — so this is
 * where the rail's Dashboard link gets the LIVE search grafted back on, after the pure model has
 * already built it. Reads `draft`, not `query`: the input already renders the draft directly, and
 * building the href from the same value means a rail click mid-debounce (before the 300ms commit)
 * still carries the in-progress text, with no separate "flush before navigating" step needed here
 * (unlike `selectView`'s in-app switch, which must flush because it reads the draft, normalised, to
 * build its `history.push` synchronously — URL-authoritative committed query; the store holds
 * draft/timer/owner only).
 *
 * The top-level "Dashboard" item (`staff-navigation.ts`'s `id: "dashboard"`) is a real, clickable
 * rail link, so it carries the search (#217 fix round 8, Sol review, item 1, HIGH): left bare `/`,
 * clicking it from off-Dashboard landed on a q-less URL that `ShellRoute`'s own sync then treated
 * as authoritative and used to clear an in-progress draft that had never been committed anywhere
 * else. Built with `staffPathFor`, so an empty draft still yields the bare `/` this link has always
 * had.
 *
 * The Dashboard VIEW child links (List/Kanban/Calendar, with their calendar-facet branch) are no
 * longer rewritten here: the rail renders no child links (ADR 0015) and the breadcrumb reads only
 * their labels and `active` flags, so their hrefs have no consumer. Views are chosen by the
 * Dashboard's own controls, which carry the search themselves (`selectView`).
 */
function withLiveDashboardSearch(navigation: StaffNavigation, query: string): StaffNavigation {
  return {
    ...navigation,
    groups: navigation.groups.map((group) => ({
      ...group,
      items: group.items.map((item) => item.id !== "dashboard" ? item : {
        ...item,
        href: staffPathFor({ kind: "dashboard", ...(query ? { search: query } : {}) }),
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
  // #366: what the Dashboard reads and writes through while the Project sheet floats over it.
  const [backdropSource] = useState(() => createDashboardBackdropSource(history, () => window.history.state));
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
  // #498: the location a whiteboard Close is about to land on. Returning from the board is not an arrival (nothing was navigated *to*),
  // so the observation of exactly that location is spent without a signal; otherwise the Workspace's arrival focus steals focus from the entry button.
  const whiteboardReturnRef = useRef<string | null>(null);
  const [arrivalIntent, setArrivalIntent] = useState<ArrivalIntent | null>(null);
  const searchFocusSignalRef = useRef(0);
  const [searchFocusRequest, setSearchFocusRequest] = useState<SearchFocusRequest | null>(null);
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
  // #366: at a Project URL the Dashboard underneath is the remembered one. `backdropLocation` is
  // sanitised the same way the real route is: a Calendar backdrop the role may not see falls back
  // to the default view (a reloaded `history.state` is only validated as "a Dashboard location").
  const isSheetRoute = route.kind === "project" || route.kind === "edit-project";
  const rememberedBackdrop = useSyncExternalStore(backdropSource.subscribe, backdropSource.getLocation, () => "/");
  const rememberedRoute = useMemo(() => parseStaffLocation(rememberedBackdrop), [rememberedBackdrop]);
  const backdropCalendarBlocked = rememberedRoute.kind === "dashboard"
    && ("calendar" in rememberedRoute || ("dashboardView" in rememberedRoute && rememberedRoute.dashboardView === "calendar"))
    && !roleHasCapability(user.role, "viewProductionCalendar");
  const backdropLocation = backdropCalendarBlocked ? "/" : rememberedBackdrop;
  const backdropRoute = useMemo(() => parseStaffLocation(backdropLocation), [backdropLocation]);
  // The Dashboard's own view of the world: the backdrop while a sheet is open, else the real route.
  const layerRoute = isSheetRoute ? backdropRoute : route;
  const layerLocation = isSheetRoute ? backdropLocation : completeLocation;

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
      if (whiteboardReturnRef.current === completeLocation) { whiteboardReturnRef.current = null; setArrivalIntent(null); return; } // #498: closing the board is not an arrival
      const signal = ++arrivalSignalRef.current;
      setArrivalIntent({ projectId: route.projectId, tab: route.arrivalTab, signal, location: completeLocation });
      return;
    }
    lastObservedRef.current = null;
    selfWriteRef.current = null;
    whiteboardReturnRef.current = null;
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
    // #498: the whiteboard is not a Workspace tab; the Workspace stays mounted beneath it and must not rewrite its URL.
    if (route.whiteboard) return;
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

  // #498: open is a push through the location store (never the router's navigate). Close returns to the
  // Workspace the way `returnToWorkspace` does: when the entry below is this project's workspace, step
  // back onto it; a cold whiteboard link has none, so replace with the tab the Workspace was showing.
  const openProjectWhiteboard = (projectId: string) => {
    if (route.kind !== "project" || route.projectId !== projectId || route.whiteboard) return;
    history.push(staffPathFor({ kind: "project", projectId, whiteboard: true }));
  };
  const closeProjectWhiteboard = (projectId: string, tab: WorkspaceTab) => {
    if (route.kind !== "project" || route.projectId !== projectId || !route.whiteboard) return;
    const prev = readSheetEntryState(window.history.state)?.prev;
    const below = prev === undefined ? null : parseStaffLocation(prev);
    if (below?.kind === "project" && below.projectId === projectId && !below.whiteboard) { whiteboardReturnRef.current = prev!; history.go(-1); }
    else { const target = staffPathFor({ kind: "project", projectId, arrivalTab: tab }); whiteboardReturnRef.current = target; history.replace(target); }
  };

  // #427: ⌘K. On the Dashboard it targets the current location; anywhere else it first moves to the
  // Dashboard (`locationStore()` push, carrying the live search the way every other push does) and
  // targets THAT location. The field takes focus when it mounts for the targeted location.
  const userId = user.id;
  const requestSearchFocus = useCallback(() => {
    let location = history.getLocation();
    if (parseStaffLocation(location).kind !== "dashboard" || isSheetLocation(location)) {
      history.push(staffPathFor({ kind: "dashboard", search: takeDashboardSearchForNavigation(userId) }));
      location = history.getLocation();
    }
    setSearchFocusRequest({ location, signal: ++searchFocusSignalRef.current });
  }, [history, userId]);
  const currentSearchFocusSignal = searchFocusRequest !== null && searchFocusRequest.location === layerLocation ? searchFocusRequest.signal : null;
  const acknowledgeSearchFocus = useCallback((signal: number) => {
    setSearchFocusRequest((request) => (request?.signal === signal ? null : request));
  }, []);

  useEffect(() => {
    if (blocked) history.replace("/");
  }, [blocked, history]);

  // #217 build, step 3: the ONE draft-from-URL sync call, replacing every render-side adoption
  // path `Dashboard.tsx` used to own (step 4 deletes that machinery). `useLayoutEffect`, not
  // `useEffect` -- same reasoning `DashboardSearch.tsx`'s own ownership-claim effect already documents:
  // React flushes every layout effect in a commit, tree-wide, before any passive effect in that
  // same commit, so the draft is never one paint behind the URL that governs it. Keyed on
  // `completeLocation` (not just `route`, though the two always change together here) and
  // `user.id` -- the exact two inputs `syncDashboardSearchDraftFromLocation` itself takes -- so a
  // location OR a principal change (impersonation start/stop; `App.tsx` remounts this component's
  // whole subtree for a principal change via its own `key`, but the layout effect ordering
  // guarantee is what matters for a location change alone) both run it. A non-Dashboard route's
  // lack of `q` is not authoritative (an Enter on the rail must still navigate with whatever text
  // is showing, the retired rail search's off-Dashboard Enter path) -- this only calls the store when
  // `route.kind === "dashboard"`, never unconditionally.
  // #366: keyed on the layer's location STRING, never the parsed `layerRoute` object -- opening a
  // sheet swaps `layerRoute` between separately parsed objects for the SAME Dashboard location, and
  // re-running the sync then would cancel the pending debounce and restore the old URL query.
  const layerRouteRef = useRef(layerRoute);
  layerRouteRef.current = layerRoute;
  useLayoutEffect(() => {
    // #366: under a sheet the Dashboard's location is the backdrop, so its search is too.
    const current = layerRouteRef.current;
    if (current.kind !== "dashboard") return;
    syncDashboardSearchDraftFromLocation(dashboardSearchOf(current), user.id);
  }, [layerLocation, user.id]);

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

  // #427: the Dashboard views were renamed (list/kanban/gantt -> table/board/timeline). An old
  // spelling PARSES to the new route, so the first render is already correct; this replaces the
  // address-bar spelling with the canonical one, Timeline facets and `q` carried. Keyed on the
  // pure predicate, NOT `staffPathFor(route) !== completeLocation`, which would also rewrite
  // Calendar's accepted parameter orders. A `replace` through `locationStore()`, never the router.
  useEffect(() => {
    const canonical = canonicalLegacyDashboardLocation(completeLocation);
    if (canonical !== null && canonical !== completeLocation) history.replace(canonical);
  }, [completeLocation, history]);

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
  const dashboardCalendar = layerRoute.kind === "dashboard" && "calendar" in layerRoute && !calendarBlocked && !backdropCalendarBlocked ? layerRoute.calendar : null;
  // #217 fix round 3, item 1: the rail's own Dashboard child links, read here (not inside
  // `staff-navigation.ts`, which stays pure) so a rail click carries the live search the same way
  // the in-Dashboard view switcher already does. `DashboardSearch` reads the identical store, so the
  // input and every rail href this produces can never disagree about what "the current q" is.
  // #217 fix round 5, item 1 (Sol re-review, BLOCKER): principal-scoped -- an unscoped read here
  // could serialise the PREVIOUS principal's draft into the rail's own hrefs for a render pass
  // (worst on the narrow layout with the Sheet closed, where no search field is even
  // mounted to make the layout-effect ownership claim).
  const dashboardSearchDraft = useSyncExternalStore(
    subscribeDashboardSearch,
    () => getDashboardSearchSnapshotForPrincipal(user.id),
    () => getDashboardSearchSnapshotForPrincipal(user.id),
  ).draft;
  const navigation = useMemo(() => withLiveDashboardSearch(buildStaffNavigation(
    layerRoute,
    readRememberedDashboardView({ read: () => window.localStorage.getItem(DASHBOARD_VIEW_KEY) }),
    { adminBackend: canAccessAdmin, viewProductionCalendar: roleHasCapability(user.role, "viewProductionCalendar"), viewNoticeBoard: canViewNoticeBoard },
    publishedDashboardView,
  ), dashboardSearchDraft), [canAccessAdmin, canViewNoticeBoard, dashboardSearchDraft, publishedDashboardView, layerRoute, user.role]);
  // #366: close = walk back over the entries the sheet's own pushes made, else replace with the
  // backdrop (a cold direct link has nothing provably ours beneath it). One-shot per location so a
  // double Esc before the popstate lands cannot walk back twice.
  const closingRef = useRef(false);
  const pendingBackdropRef = useRef<string | null>(null);
  useEffect(() => { closingRef.current = false; }, [completeLocation]);
  const closeImplRef = useRef<() => void>(() => undefined);
  closeImplRef.current = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    const entry = readSheetEntryState(window.history.state);
    if (entry) {
      // The Dashboard rewrote its own location in memory while it was a backdrop (never the URL):
      // land on the entry below, then carry that rewrite across with one replace.
      if (backdropSource.backdropRewritten()) pendingBackdropRef.current = backdropSource.backdrop();
      history.go(-entry.depth);
    } else {
      history.replace(backdropSource.backdrop());
    }
  };
  const closeProjectSheet = useCallback(() => closeImplRef.current(), []);
  useEffect(() => {
    if (route.kind !== "dashboard" || pendingBackdropRef.current === null) return;
    const pending = pendingBackdropRef.current;
    pendingBackdropRef.current = null;
    backdropSource.resetRewritten();
    if (pending !== completeLocation) history.replace(pending);
  }, [route, completeLocation, history, backdropSource]);

  // #374 (E2/E3). The edit form is a sheet child pushed on top of the workspace, so returning is a
  // traversal: when the entry below is this project's workspace, step back onto it (Back afterwards
  // closes the sheet, and the workspace re-lands the tab its URL named). Otherwise there is no
  // provable workspace entry below (a cold edit link, a stale state): replace with it.
  // Both read the CURRENT location at call time: a save that resolves after the sheet was closed
  // must not reopen it or walk history from the Dashboard (E3) — it only toasts.
  function stillEditing(projectId: string): boolean {
    const now = parseStaffLocation(history.getLocation());
    return now.kind === "edit-project" && now.projectId === projectId;
  }
  // One shared pending-departure guard (closingRef, set synchronously before ANY traversal from
  // close, cancel, save, archive, restore or delete; cleared when the location changes): a
  // completion that resolves after a departure was requested but before its popstate lands only
  // toasts — it never traverses a second time and overshoots past the Dashboard.
  function returnToWorkspace(projectId: string, message?: string) {
    if (closingRef.current || !stillEditing(projectId)) { if (message) pushToast(message); return; }
    closingRef.current = true;
    const workspace = `/projects/${encodeURIComponent(projectId)}`;
    const prev = readSheetEntryState(window.history.state)?.prev;
    const below = prev === undefined ? null : parseStaffLocation(prev);
    setNotice(message ? { path: workspace, message } : null);
    if (below?.kind === "project" && below.projectId === projectId) history.go(-1);
    else history.replace(workspace);
  }
  function leaveDeletedProject(projectId: string, message: string) {
    pushToast(message);
    if (closingRef.current || !stillEditing(projectId)) return;
    closeProjectSheet();
  }

  const shell: ShellState = {
    user, route, pathname, notice, navigate,
    clearNotice: () => setNotice(null),
    searchFocusSignal: currentSearchFocusSignal, acknowledgeSearchFocus,
    dashboardCalendar, arrivalIntent: currentArrivalIntent, acknowledgeArrivalSignal, syncProjectTab,
    openProjectWhiteboard, closeProjectWhiteboard,
    impersonating, isSheetRoute, backdropLocation, backdropSource, closeProjectSheet,
    returnToWorkspace, leaveDeletedProject,
  };

  const routedContent = blocked
    ? <main className="page"><div className="empty" role="status"><span className="serif">Returning to dashboard.</span></div></main>
    : <ShellStateContext value={shell}><Outlet /></ShellStateContext>;

  return (
    <div className={cn("app", impersonating && "app--impersonating", "app--railed")}>
      <RailedShell navigation={navigation} user={user} shortcutsSuspended={isSheetRoute} onSearchShortcut={requestSearchFocus} impersonating={impersonating}>{routedContent}</RailedShell>
    </div>
  );
}

const rootRoute = createRootRoute({ component: ShellRoute, notFoundComponent: NotAvailable });

/**
 * #366: the pathless layout route that owns `/` and `/projects/$projectId`. It renders the
 * Dashboard ONCE and, at a Project URL, a `ProjectSheet` around the `<Outlet />` — so a layout
 * match persists across Dashboard <-> Project and the Dashboard stays mounted, live, under the
 * sheet. (Sibling leaves would unmount each other.) `/projects/new` and `/projects/$id/edit` stay
 * root children: full pages, as today (#374 moves edit into the sheet).
 *
 * Fixed sibling positions below keep every element's identity across those changes.
 */
function DashboardLayer() {
  const { route, user, dashboardCalendar, searchFocusSignal, acknowledgeSearchFocus, impersonating, isSheetRoute, backdropLocation, backdropSource, closeProjectSheet } = useShell();
  const showDashboard = route.kind === "dashboard" || isSheetRoute;

  // The opener, captured the moment the location goes Dashboard -> sheet: the adapter notifies
  // synchronously inside the activated link's click, so `document.activeElement` is still that link.
  const openerRef = useRef<HTMLElement | null>(null);
  const projectIdRef = useRef<string | null>(null);
  // #464: set when the sheet is left for a Dashboard URL carrying `focus` (Show in ...). Remembered
  // at that moment: the landing strips `focus` from the URL before the sheet finishes closing.
  const leftForLandingRef = useRef(false);
  if (route.kind === "project" || route.kind === "edit-project") projectIdRef.current = route.projectId;
  useEffect(() => {
    const adapter = locationStore();
    let wasSheet = isSheetLocation(adapter.getLocation());
    return adapter.subscribe(() => {
      const isSheet = isSheetLocation(adapter.getLocation());
      if (isSheet) leftForLandingRef.current = false;
      else if (wasSheet) {
        const next = parseStaffLocation(adapter.getLocation());
        leftForLandingRef.current = next.kind === "dashboard" && dashboardFocusOf(next) !== undefined;
      }
      if (isSheet && !wasSheet) {
        const active = document.activeElement;
        openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
      }
      wasSheet = isSheet;
    });
  }, []);
  const finalFocus = useCallback((): HTMLElement | boolean => {
    // #464: Show in Calendar / Timeline closes the sheet by pushing a Dashboard URL carrying `focus`.
    // The view lands on the Project and moves focus itself; returning it to the opener first would
    // fight that (and the opener is usually the very row the view is about to scroll).
    if (leftForLandingRef.current) return false;
    const opener = openerRef.current;
    if (opener?.isConnected) return opener;
    // Safari does not focus a clicked link: fall back to the opener's row in the Dashboard.
    const id = projectIdRef.current;
    const row = id ? document.querySelector<HTMLElement>(`main a[href^="/projects/${id}"]`) : null;
    return row ?? true;
  }, []);

  return (
    <DashboardLocationContext value={backdropSource}>
      {showDashboard ? <Dashboard currentUserId={user.id} role={user.role} authorizationEpoch={user.authorizationEpoch} calendar={dashboardCalendar} searchFocusSignal={searchFocusSignal} onSearchFocusHandled={acknowledgeSearchFocus} /> : null}
      {showDashboard ? (
        <ProjectSheet
          open={isSheetRoute}
          kind={route.kind === "edit-project" ? "edit" : "project"}
          sheetKey={isSheetRoute && (route.kind === "project" || route.kind === "edit-project") ? `${route.kind}:${route.projectId}` : "closed"}
          backdropHref={backdropLocation}
          onRequestClose={closeProjectSheet}
          closeButton={!(route.kind === "project" && route.whiteboard === true)}
          impersonating={impersonating}
          finalFocus={finalFocus}
        >
          {isSheetRoute ? <Outlet /> : null}
        </ProjectSheet>
      ) : null}
      {isSheetRoute ? null : <Outlet />}
    </DashboardLocationContext>
  );
}

const dashboardLayerRoute = createRoute({ getParentRoute: () => rootRoute, id: "dashboard-layer", component: DashboardLayer });

// `/` — the dashboard, plus every non-canonical query spelling that lands on the same pathname. The
// Dashboard itself now renders in the layer above (it must outlive the Project sheet), so this leaf
// renders nothing for a real Dashboard location.
const dashboardRoute = createRoute({
  getParentRoute: () => dashboardLayerRoute,
  path: "/",
  component: function DashboardLeaf() {
    const { route } = useShell();
    if (route.kind !== "dashboard") return <NotAvailable />;
    return null;
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
  getParentRoute: () => dashboardLayerRoute,
  path: "/projects/$projectId",
  component: function ProjectLeaf() {
    const { route, notice, pathname, clearNotice, arrivalIntent, acknowledgeArrivalSignal, syncProjectTab, openProjectWhiteboard, closeProjectWhiteboard } = useShell();
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
      whiteboardOpen={route.whiteboard === true}
      onOpenWhiteboard={() => openProjectWhiteboard(route.projectId)}
      onCloseWhiteboard={(tab) => closeProjectWhiteboard(route.projectId, tab)}
    />;
  },
});

const editProjectRoute = createRoute({
  getParentRoute: () => dashboardLayerRoute,
  path: "/projects/$projectId/edit",
  component: function EditProjectLeaf() {
    const { route, returnToWorkspace, leaveDeletedProject } = useShell();
    if (route.kind !== "edit-project") return <NotAvailable />;
    return <EditProject key={route.projectId} projectId={route.projectId} onReturnToWorkspace={(message) => returnToWorkspace(route.projectId, message)} onDeleted={(message) => leaveDeletedProject(route.projectId, message)} />;
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

// #702 — Connected apps (AI clients acting as the user) and its OAuth consent page. The consent route is reached
// by a full-page redirect from `/oauth/authorize`; the page leaves with `window.location.assign`, never the router.
const connectedAppsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/connected-apps",
  component: function ConnectedAppsLeaf() {
    const { route } = useShell();
    if (route.kind !== "connected-apps") return <NotAvailable />;
    return <ConnectedApps />;
  },
});

const connectedAppConsentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/connected-apps/consent/$handle",
  component: function ConnectedAppConsentLeaf() {
    const { route, user } = useShell();
    if (route.kind !== "connected-app-consent") return <NotAvailable />;
    return <ConnectedAppConsent key={route.handle} handle={route.handle} isAdmin={user.role === "admin"} />;
  },
});

// Everything else — an unroutable path, or a reserved delivery or backend namespace — is handled
// by the root's `notFoundComponent`. An explicit "$" catch-all leaf was tried here first and
// removed: deleting it changed no test, because the root already renders the same view inside the
// same chrome. A route that cannot be observed to do anything is decoration, not defence.
const routeTree = rootRoute.addChildren([
  dashboardLayerRoute.addChildren([dashboardRoute, projectRoute, editProjectRoute]),
  createProjectRoute, adminRoute, noticesRoute, notificationsRoute,
  notificationPreferencesRoute, connectedAppsRoute, connectedAppConsentRoute,
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
    // #366: Dashboard <-> Project is a sheet opening or closing over a Dashboard that never
    // unmounts, so its scroll must survive; every other pathname change still lands at the top.
    beforeNotify: ({ pathnameChanged, from, to }) => { router._scroll.next = pathnameChanged && !(isDashboardLayerLocation(from) && isDashboardLayerLocation(to)); },
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
