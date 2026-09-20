import { lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { dashboardSearchOf, formatSydneyCivil, roleHasCapability, type DashboardCalendarState, type DashboardRoute, type DashboardViewRoute as SharedDashboardViewRoute, type MoveProjectStageRequest, type MoveProjectStageResponse, type ProductionCalendarFilters, type StageKey } from "@quincy/shared";
import { QueryClient, QueryClientContext, QueryClientProvider, type Query } from "@tanstack/react-query";
import { StatusBadge } from "../components/atoms";
import { LazyImage } from "../components/LazyImage";
import { ApiError, apiPost } from "../lib/api";
import { confirmStore } from "../lib/confirm";
import { useCapabilities } from "../lib/capabilities";
import { useStages } from "../lib/stages";
import { DASHBOARD_CALENDAR_LAST_DATE_KEY, DASHBOARD_CALENDAR_SUBVIEW_KEY, focusTargetAfterClearingSearch, formatDashboardDate, initializeDashboardCalendarState, initializeDashboardView, initializeKanbanSortMode, type DashboardView, type KanbanSortMode } from "./dashboard-helpers";
import { publishDashboardView, releaseDashboardView } from "../lib/dashboard-view-store";
import { InternalLink } from "../components/InternalLink";
import { NoticeBoard } from "../components/NoticeBoard";
import { pushToast as toast } from "../lib/toast-store";
import { ToastViewport } from "../components/quincy/ToastViewport";
import { Button, buttonClasses } from "../components/quincy/Button";
import { Eyebrow } from "../components/quincy/Eyebrow";
import { Select, type SelectOption } from "../components/quincy/Select";
import { SEGMENT_GROUP, SEGMENT_BUTTON } from "../components/quincy/segment";
import { Skeleton } from "../components/reui/skeleton";
import { Badge } from "../components/reui/badge";
import { XIcon } from "lucide-react";
import { EmptyState } from "../components/quincy/EmptyState";
import { Notice } from "../components/quincy/Notice";
import { cn } from "../lib/utils";
import { CALENDAR_STATE_BOX } from "../components/production-calendar-classes";
import { invalidateProjectSurfaces, useOptionalProjectQueryClient } from "../lib/project-data";
import { createDashboardBoardInvalidatedMessage, getProjectQueryRuntime } from "../lib/project-query-sync";
import { dashboardProjectsKey, useDashboardProjectSearch, useDashboardProjects } from "../lib/dashboard-projects";
import { submitStageMoveWithConfirmation } from "../lib/stage-move";

import {
  adjacentBoardGap,
  announce,
  applyOptimisticOverlay,
  boardGapChangesOrder,
  buildMoveRequest,
  focusDescriptorFor,
  focusTargetAfter,
  isSameStagePlacementChange,
  optimismSafeBeforeResponse,
  reconcileAuthoritativeResponse,
  reorderIntentFromGap,
  sortKanbanProjects,
  type BoardInteractionState,
  type BoardModel,
  type FocusDescriptor,
  type ProjectSummary,
  type SemanticGap,
} from "../lib/kanban-interaction";
import { ProjectKanbanBoard2 } from "../components/kanban2/board";
// Code-split: FullCalendar + its deps (~84 kB gzip) load only when a capable
// principal opens the Calendar view, never on the sign-in screen or a
// Photographer dashboard.
const ProductionCalendar = lazy(() => import("../components/ProductionCalendar").then((module) => ({ default: module.ProductionCalendar })));
import { locationStore, parseStaffLocation, staffPathFor } from "../lib/router";
import {
  clearDashboardSearch,
  getDashboardSearchSnapshotForPrincipal,
  resetDashboardSearchForPrincipal,
  setDashboardSearchUrlWriter,
  subscribeDashboardSearch,
  takeDashboardSearchForNavigation,
} from "../lib/dashboard-search-store";
import type { CalendarSettleState } from "../lib/production-calendar-interaction";

export { adjacentBoardGap, adjacentBoardPlacement, cardDropPlacement, sortKanbanProjects } from "../lib/kanban-interaction";
export type { ProjectSummary } from "../lib/kanban-interaction";

type ProjectScope = "active" | "archived";
type BoardOverlay = { key: string; baseline: ProjectSummary[]; model: ProjectSummary[]; movingProjectId: string };
type FocusRestore = { key: string | null; x: number; y: number; fallbackStageKey?: StageKey };
type MovementRecovery = { model: BoardModel; projectId: string; project: ProjectSummary; settledStageKey: StageKey };
const noRuntimeSubscribe = () => () => undefined;
const zeroRuntimeSnapshot = () => 0;

function focusKeyForControl(control: FocusDescriptor["control"], projectId: string): string {
  if (control === "handle") return `move-handle:${projectId}`;
  if (control === "move-to") return `move-to:${projectId}`;
  if (control === "rail-stage") return `rail-stage:${projectId}`;
  return `${control}:${projectId}`;
}

function postSuccessRefetchFailureAnnouncement(recovery: MovementRecovery | null, sort: KanbanSortMode, terminal: boolean): string | undefined {
  if (!recovery) return announce({ type: "post-success-refetch-failure" }, { terminal });
  const targetColumn = sortKanbanProjects(
    recovery.model.projects.filter((project) => canonicalStageKey(project.stageKey) === recovery.settledStageKey),
    sort,
  );
  const index = targetColumn.findIndex((project) => project.id === recovery.projectId);
  return announce({ type: "post-success-refetch-failure" }, {
    terminal,
    street: recovery.project.street,
    position: index < 0 ? targetColumn.length : index + 1,
    count: targetColumn.length,
  });
}

function CoverMedia({ project, className = "", inlinePlaceholder = false, retryToken, onFailedChange }: { project: ProjectSummary; className?: string; inlinePlaceholder?: boolean; retryToken?: number; onFailedChange?: (failed: boolean) => void }) {
  if (project.coverAssetId) return <LazyImage className={className} preload="background" assetId={project.coverAssetId} alt={`Preview of ${project.street}`} retryToken={retryToken} onFailedChange={onFailedChange} />;
  const content = project.street.trim().charAt(0).toUpperCase() || "Q";
  return inlinePlaceholder ? <span className={`project-cover-placeholder ${className}`} aria-hidden="true">{content}</span> : <div className={`project-cover-placeholder ${className}`} aria-hidden="true">{content}</div>;
}

function location(project: ProjectSummary) { return [project.suburb, project.postcode].filter(Boolean).join(" · ") || "Location pending"; }

function canonicalStageKey(stageKey: ProjectSummary["stageKey"]): StageKey {
  return stageKey === "editing" ? "editing_autohdr" : stageKey;
}

function boardModelFromProjects(projects: ProjectSummary[]): BoardModel {
  const authorizedBoardOrder = projects.find((project) => project.authorizedBoardOrder !== undefined)?.authorizedBoardOrder;
  return authorizedBoardOrder ? { projects: [...projects], authorizedBoardOrder } : { projects: [...projects] };
}

// TB8-01 §8.1 — shared List grid; header and body rows share the same column template so cells
// line up. `minmax(0, …)` on every fractional track lets long addresses shrink instead of forcing
// the grid wider than its container at 1024.
const PROW_GRID = "[display:grid] grid-cols-[72px_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)_96px] " +
  "items-center gap-[var(--space-4)] px-[var(--space-5)] py-[var(--space-3)] " +
  "max-[721px]:grid-cols-[56px_1fr_84px] max-[721px]:py-[var(--space-4)]";
const PROW_ROW = PROW_GRID + " w-full border-0 [border-top-style:solid] border-t-[length:var(--border-width-hair)] " +
  "border-t-border first:border-t-0 text-inherit text-left bg-transparent cursor-pointer " +
  "no-underline transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:bg-secondary " +
  "active:bg-surface-sunken focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:-outline-offset-2";

function ProjectListRow({ project, projectHref }: { project: ProjectSummary; projectHref: string }) {
  const [coverFailed, setCoverFailed] = useState(false); const [coverRetry, setCoverRetry] = useState(0);
  return <div>
    <InternalLink className={cn(PROW_ROW)} data-testid="project-list-row" to={projectHref}>
      <CoverMedia project={project} className="prow__thumb" inlinePlaceholder retryToken={coverRetry} onFailedChange={setCoverFailed} />
      <span>
        <span className="block font-[family-name:var(--font-display)] text-[length:var(--text-md)] tracking-[var(--tracking-tight)]">{project.street}</span>
        <Eyebrow className="block mt-[var(--space-1)]">{location(project)}</Eyebrow>
      </span>
      <span className="text-[length:var(--text-sm)] max-[721px]:hidden">{project.agencyName || "Agency pending"}<span className="block mt-[var(--space-1)] text-[length:var(--text-xs)] text-muted-foreground">{project.agentName || "Agent pending"}</span></span>
      <span className="text-[length:var(--text-sm)] max-[721px]:hidden">{formatDashboardDate(project.shootDate)}</span>
      <span className="max-[721px]:hidden"><StatusBadge stageKey={project.stageKey} /></span>
      <span className="text-right tabular-nums text-[length:var(--text-sm)]" data-testid="project-list-row-raw">{project.receivedCount}</span>
    </InternalLink>
    {coverFailed && <Button type="button" variant="secondary" className="mt-[var(--space-2)]" onClick={() => { setCoverFailed(false); setCoverRetry((current) => current + 1); }}>Retry cover image</Button>}
  </div>;
}

type DashboardProps = { currentUserId: string; role?: Parameters<typeof dashboardProjectsKey>[1]; authorizationEpoch?: number; calendar?: DashboardCalendarState | null };

type DashboardRouteArm = Extract<DashboardRoute, { kind: "dashboard" }>;

// Re-exported from `@quincy/shared` rather than re-derived with `Extract`: #111 added
// `"calendar"` to the shared `dashboardView` union, and an `Extract` pinned to the old two
// literals silently collapses to `never` instead of failing loudly at the source of the change.
type DashboardViewRoute = SharedDashboardViewRoute;
type DashboardCalendarRoute = Extract<DashboardRouteArm, { calendar: DashboardCalendarState }>;

function isDashboardViewRoute(route: DashboardRouteArm): route is DashboardViewRoute {
  return "dashboardView" in route;
}

function isDashboardCalendarRoute(route: DashboardRouteArm): route is DashboardCalendarRoute {
  return "calendar" in route;
}

function DashboardContent({ currentUserId, role = "photographer", authorizationEpoch = 0, calendar: routeCalendar = null }: DashboardProps) {
  const queryClient = useOptionalProjectQueryClient();
  const { can } = useCapabilities();
  const { stages } = useStages();
  const canCreateProject = can("createProject");
  const canMoveStagesCapability = can("moveProjectStage");
  const canPrioritize = can("prioritizeProjects");
  const canViewArchived = can("adminBackend");
  const canViewNoticeBoard = can("viewNoticeBoard");
  const canViewProductionCalendar = roleHasCapability(role, "viewProductionCalendar");
  const history = locationStore();
  const currentLocation = useSyncExternalStore(history.subscribe, history.getLocation, () => "/");
  const parsedRoute = useMemo(() => parseStaffLocation(currentLocation), [currentLocation]);
  const currentDashboardRoute = parsedRoute.kind === "dashboard" ? parsedRoute : null;
  const locationHasCalendar = Boolean(currentDashboardRoute && isDashboardCalendarRoute(currentDashboardRoute));
  const routeDashboardView = currentDashboardRoute && isDashboardViewRoute(currentDashboardRoute) ? currentDashboardRoute.dashboardView : null;
  // #217 fix round 4, item 1 (Sol re-review, BLOCKER): every non-facet Dashboard route arm now
  // carries an optional `search` (the Calendar INTENT arm gained one -- `staff-routes.ts`'s own
  // `DashboardCalendarIntentRoute` docblock has why), read here once for the two Calendar
  // canonicalisers below. `undefined` when the route itself carries none (`isDashboardCalendarRoute`
  // excludes the one arm -- the facet -- that has no `search` field at all).
  const routeDashboardSearch = currentDashboardRoute && !isDashboardCalendarRoute(currentDashboardRoute) ? currentDashboardRoute.search : undefined;
  const effectiveRouteCalendar = currentDashboardRoute && isDashboardCalendarRoute(currentDashboardRoute) ? currentDashboardRoute.calendar : routeCalendar;
  const calendarStorage = {
    read: (key: string) => window.localStorage.getItem(key),
    write: (key: string, value: string) => window.localStorage.setItem(key, value),
  };
  const [projectScope, setProjectScope] = useState<ProjectScope>("active");
  // #217: the single Dashboard search store — the rail's `ShellSearch` is the one search input
  // now, so there is no local field or focus latch here to own.
  // #217 fix round 5, item 1 (Sol re-review, BLOCKER): principal-scoped, not the unscoped reader --
  // on A→B while parked ON the Dashboard, an unscoped read could still consume A's `query`/`draft`
  // for a render pass, serialising A's search into the rail hrefs `withLiveDashboardSearch` builds
  // and querying with A's text. See `getDashboardSearchSnapshotForPrincipal`'s own docblock.
  const search = useSyncExternalStore(
    subscribeDashboardSearch,
    () => getDashboardSearchSnapshotForPrincipal(currentUserId),
    () => getDashboardSearchSnapshotForPrincipal(currentUserId),
  );
  // #217 build, step 4: the URL is the ONLY committed Dashboard search. `dashboardSearchOf` is the
  // one accessor (`@quincy/shared`, #217 build step 2) for "what committed search does the
  // currently governing parsed route carry" -- already normalised by `parseStaffLocation`
  // (`staff-routes.ts`'s `parseDashboardSearch`/calendar `rawSearch` both run every accepted `q`
  // through `normalizeDashboardSearchText` before returning it), so this never re-normalises and
  // never reads the store. Derived at RENDER, from the route alone -- there is no adoption effect
  // left to lag a commit behind, and no store copy left to disagree with the URL for even one
  // render: a role without Calendar capability, a Back/Forward to a q-less URL, and a cold deep
  // link all resolve correctly on their very first commit. Every render-time consumer below reads
  // this ONE value instead of the store: the projects query, the search-counts query,
  // `searchActive` (and everything gated on it -- the chip, the stats strip, the Kanban movement
  // gates), the chip's own text, and the Calendar (`calendar={calendarState && { ...calendarState,
  // search: committedQuery }}` further down -- `calendarState.search` itself stays for
  // URL-serialisation bookkeeping, e.g. `JSON.stringify` equality checks and
  // `takeDashboardSearchForNavigation`-sourced URL builds, but is never read for what to DISPLAY).
  const committedQuery = dashboardSearchOf(parsedRoute) ?? "";
  const [view, setView] = useState<DashboardView>(() => {
    // A route's own explicit "calendar" gets the same capability check the stored preference
    // already gets below — otherwise a role without it landed here with `view` already "calendar"
    // and `calendarState` already `null` (that init is gated correctly), so no render branch
    // matched anything until the reconciliation effect caught up.
    if (routeDashboardView && (routeDashboardView !== "calendar" || canViewProductionCalendar)) return routeDashboardView;
    if (effectiveRouteCalendar && canViewProductionCalendar) return "calendar";
    const stored = initializeDashboardView({
      read: () => window.localStorage.getItem("quincy:dashboard:view"),
      write: (next) => window.localStorage.setItem("quincy:dashboard:view", next),
    });
    return !canViewProductionCalendar && stored === "calendar" ? "kanban" : stored;
  });
  // Captured once at mount, before any explicit List/Kanban selection can overwrite
  // localStorage — the value a fresh bare-route "/" load would show. Restoring TO this fixed
  // snapshot (not live localStorage) on a Back/Forward arrival back at bare "/" is what makes
  // the browser's native Back button actually undo an explicit view switch, since D2 made
  // List/Kanban selection push its own history entry.
  const bareRouteFallbackViewRef = useRef(view);
  const [calendarState, setCalendarState] = useState<DashboardCalendarState | null>(() => {
    if (effectiveRouteCalendar && canViewProductionCalendar) return effectiveRouteCalendar;
    if (!canViewProductionCalendar) return null;
    const initial = initializeDashboardCalendarState({ kind: "dashboard" }, calendarStorage, { now: Date.now(), isPhone: window.matchMedia?.("(max-width: 720px)").matches ?? false });
    // #217 design-fix round 2, item 1: when THIS render already resolves to Calendar (the
    // explicit `?view=calendar` intent, or a bare "/" landing on a remembered Calendar
    // preference -- both already decided by `view`'s own initializer above), seed the initial
    // state's `search` from whatever `q` is already known: the route's own (authoritative when
    // the URL carries one) or the live draft otherwise -- the SAME fallback order the
    // reconciliation effect below already uses once it runs. Without this, the FIRST
    // `/api/production-calendar` request the initial mount fires carries no search at all (a
    // wasted request, and an unfiltered flash), and only a SECOND commit -- after that effect
    // corrects `calendarState` -- carries `q`.
    return view === "calendar" ? { ...initial, search: routeDashboardSearch ?? search.draft } : initial;
  });
  const [kanbanSort, setKanbanSort] = useState<KanbanSortMode>(() => initializeKanbanSortMode({
    read: () => window.localStorage.getItem("quincy:dashboard:kanbanSort"),
    write: (next) => window.localStorage.setItem("quincy:dashboard:kanbanSort", next),
  }));
  const [boardInteraction, setBoardInteraction] = useState<BoardInteractionState>({ activeId: undefined, proposal: null });
  const [pendingMoves, setPendingMoves] = useState<Set<string>>(new Set());
  const [pendingOrdering, setPendingOrdering] = useState<Set<string>>(new Set());
  const [boardOverlay, setBoardOverlay] = useState<BoardOverlay | null>(null);
  const [movementSettlePending, setMovementSettlePending] = useState(false);
  const [calendarInteractionBlocked, setCalendarInteractionBlocked] = useState(false);
  const [calendarSettle, setCalendarSettle] = useState<CalendarSettleState>({ pending: false, recoveryReason: null });
  const [recoveryReason, setRecoveryReason] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [boardUnavailableReason, setBoardUnavailableReason] = useState<string | null>(null);
  const [, setDocumentActivityVersion] = useState(0);
  useEffect(() => {
    const notify = () => setDocumentActivityVersion((version) => version + 1);
    document.addEventListener("visibilitychange", notify);
    window.addEventListener("focus", notify);
    window.addEventListener("blur", notify);
    return () => {
      document.removeEventListener("visibilitychange", notify);
      window.removeEventListener("focus", notify);
      window.removeEventListener("blur", notify);
    };
  }, []);
  useEffect(() => {
    if (canViewProductionCalendar) return;
    try {
      if (window.localStorage.getItem("quincy:dashboard:view") === "calendar") {
        window.localStorage.setItem("quincy:dashboard:view", "kanban");
      }
    } catch { /* Storage can be disabled. */ }
  }, [canViewProductionCalendar]);
  const viewingArchived = projectScope === "archived";
  const identity = { principalId: currentUserId, role, authorizationEpoch } as const;
  const projectsQuery = useDashboardProjects(viewingArchived, identity, committedQuery);
  const searchCountsQuery = useDashboardProjectSearch(viewingArchived, identity, committedQuery);
  // #230: widened to carry `committedQuery` as the fifth argument -- ONE q-aware key, not a second
  // "scope identity" alongside it. `updateProjects`'s optimistic/confirmed/rollback writes
  // (`setProjectPriority`'s only caller, below) `setQueryData` this exact key, so they now land in
  // the SAME cache entry `useDashboardProjects` above actually reads while a search is active,
  // instead of an unfiltered entry nobody is looking at. `acceptedProjects`/`boardOverlay`, both
  // keyed off `dashboardKeyString` too (see their own state below), inherit the fix the same way: a
  // committedQuery change now makes their stamped key stop matching, same as an archived-scope
  // toggle already did, so `projects` (~:370) falls back to `queryProjects` for that key instead of
  // painting the previous search's data (or a movement overlay computed against it) over the new
  // one. That fallback is NOT necessarily fresh, though: `queryProjects` can itself be react-query's
  // own PLACEHOLDER data for the new key (the previous committed query's rows, kept by
  // `keepPreviousData` in `useDashboardProjects`'s `placeholderData` while the new fetch is still in
  // flight) -- Sol review round 1, item 2 is what keeps that placeholder from ever being STAMPED into
  // `acceptedProjects` under the new key as though it were that key's own confirmed result (the
  // accept effect, ~:672, gates on `projectsQuery.isPlaceholderData`); this fallback is simply what
  // renders it in the meantime.
  const dashboardKey = dashboardProjectsKey(currentUserId, role, authorizationEpoch, viewingArchived, committedQuery);
  const dashboardKeyString = JSON.stringify(dashboardKey);
  // #230 Sol review round 2, item 1: `setProjectPriority`'s sibling predicate (below, ~:1153) needs
  // the key ACTIVE at CONFIRMATION time, not the one its own closure captured at click time --
  // `setProjectPriority` is a plain function recreated every render, so the instance a click actually
  // reaches is whichever render was current when the click landed. Updated on every render; read
  // only AFTER the POST resolves.
  const dashboardKeyStringRef = useRef(dashboardKeyString);
  dashboardKeyStringRef.current = dashboardKeyString;
  // #217: resets the shared search store when the principal this scope belongs to changes -- a
  // no-op (the store's own `principalId === id` guard) on every render this effect reruns for.
  // Declared BEFORE the Calendar route-reconciliation effect below (React commits effects in
  // hook-declaration order): on a fresh mount the store's `principalId` starts `""`, genuinely
  // different from any real `currentUserId`, so this must run and settle first or a stale draft
  // could still be showing when that effect's own canonicalising URL write lands. URL-authoritative
  // committed query; the store holds draft/timer/owner only -- there is no URL-search adoption left
  // for either effect to race.
  //
  // #230: depends on `currentUserId` alone now, not `dashboardKeyString` -- `dashboardKey` just
  // above was widened to carry `committedQuery`, so keeping it in this effect's deps would re-run
  // `resetDashboardSearchForPrincipal` on every keystroke's committed-query change (the archived
  // toggle and role/epoch changes already did this too, before #230, since they were also part of
  // `dashboardKeyString`). The guard inside `resetDashboardSearchForPrincipal` makes every one of
  // those a same-principal no-op regardless, but the ordering contract this comment documents only
  // ever needed `currentUserId` to be current when this effect runs -- it never needed to re-fire on
  // a scope or search change at all, only a principal change.
  //
  // #217 fix round 3, item 2 (Sol's whole-branch review): `PrincipalFreshnessBoundary` now ALSO
  // calls `resetDashboardSearchForPrincipal` on every principal change, at shell level -- it wraps
  // every staff route, not only this one, which is what closes the real gap this effect alone
  // could never cover (a search typed here outliving the principal while parked on `/admin` or a
  // project route, where no Dashboard is mounted to run this effect at all). This effect stays,
  // deliberately not removed: on a COLD mount landing directly on a Dashboard route, both mount in
  // the same commit, and child effects (this component's) run before the parent's (React's
  // bottom-up commit order) -- this is what sets the store's `principalId` to `currentUserId`
  // BEFORE the boundary's own reset runs and finds it already current, a guaranteed no-op, rather
  // than a race that could otherwise leave a stale draft showing momentarily.
  useEffect(() => {
    resetDashboardSearchForPrincipal(currentUserId);
  }, [currentUserId]);
  const queryProjects = projectsQuery.data;
  const queryDataUpdatedAt = projectsQuery.dataUpdatedAt;
  const [acceptedProjects, setAcceptedProjects] = useState<{ key: string; projects: ProjectSummary[] }>();
  const queryRuntime = queryClient ? getProjectQueryRuntime(queryClient) : undefined;
  const runtimeVersion = useSyncExternalStore(queryRuntime?.subscribe ?? noRuntimeSubscribe, queryRuntime?.getSnapshot ?? zeroRuntimeSnapshot, queryRuntime?.getSnapshot ?? zeroRuntimeSnapshot);
  const activeConfirm = useSyncExternalStore(confirmStore.subscribe, confirmStore.getSnapshot, () => null);
  // Calendar owns its accept/settle barriers separately. Board interactionBlocked
  // remains the TB5B state machine and never incorporates either Calendar gate.
  // `searchActive` (#217 fix round 1) is deliberately NOT folded in here anymore: `interactionBlocked`
  // means "a Board interaction is in flight" (queue refreshes, disable the view switcher) -- a
  // search is not that, and the accept effect below only ever queues while `interactionBlocked` is
  // true, so a searched `queryProjects` was never being accepted (Sol's diff review, blocker 1).
  // Search still has to block Board reorder/stage-move drag specifically (positions computed
  // against a filtered column are wrong) -- that gating is explicit now, at `canMoveStages` /
  // `sameStageReorderEnabled` / `movementDisabled` / `runBoardMovement`'s own guard, not smuggled
  // in through this flag.
  // #217 build, step 4: `committedQuery`, the render-derived route accessor -- see that
  // constant's own comment above. Everything gated on `searchActive` (the chip, the stats strip,
  // the Kanban movement gates below) inherits the fix through this one flag.
  const searchActive = committedQuery !== "";
  const interactionBlocked = Boolean(boardInteraction.activeId || boardInteraction.proposal || pendingMoves.size > 0 || pendingOrdering.size > 0 || activeConfirm);
  const interactionBlockedRef = useRef(interactionBlocked);
  interactionBlockedRef.current = interactionBlocked;
  const lastNonCalendarViewRef = useRef<"list" | "kanban">("list");
  const calendarFallbackLocationRef = useRef(!effectiveRouteCalendar && !routeDashboardView && view === "calendar" && canViewProductionCalendar);
  // The location this reconciliation effect itself last processed — not merely "is the location
  // currently non-List" — so an intermediate render mid-transition (entering archived pushes its
  // own canonical URL in the same handler) is never mistaken for a fresh arrival at a stale one.
  const lastReconciledLocationRef = useRef(currentLocation);
  const movementSettlePendingRef = useRef(false);
  movementSettlePendingRef.current = movementSettlePending;
  const movementBusyRef = useRef(false);
  const queuedRefreshRef = useRef(false);
  const focusRestoreRef = useRef<FocusRestore | null>(null);
  const movementRecoveryRef = useRef<MovementRecovery | null>(null);
  // Sol review round 2, item 3: `{ key, updatedAt }`, not a bare timestamp -- two different keys'
  // results can carry the identical millisecond `dataUpdatedAt` (system clock resolution, or two
  // fetches racing to resolve in the same tick), which a bare-timestamp dedupe would confuse for
  // "already accepted", silently dropping a genuinely new key's own first-ever result.
  const acceptedQueryUpdatedAtRef = useRef<{ key: string; updatedAt: number } | null>(null);
  const projects = boardOverlay?.key === dashboardKeyString
    ? boardOverlay.model
    : acceptedProjects?.key === dashboardKeyString
      ? acceptedProjects.projects
      : queryProjects ?? [];
  const boardContractEnabled = projects.some((project) => project.boardContractEnabled === true);
  const hasAuthorizedBoardMap = projects.some((project) => project.boardMapPresent === true || project.boardRank !== undefined || project.authorizedBoardOrder?.[project.stageKey] !== undefined);
  const effectiveKanbanSort: KanbanSortMode = !canPrioritize && kanbanSort === "priority" ? "board" : kanbanSort;
  const boardContractDisabled = projects.some((project) => project.boardContractEnabled === false);
  const boardUnavailableMessage = recoveryReason ?? boardUnavailableReason ?? (boardContractDisabled ? "Board interactions are temporarily unavailable while the Board contract is disabled." : null);
  const boardMutationEnabled = boardContractEnabled && !boardUnavailableMessage;
  // #217 fix round 1, item 2: explicit now that `searchActive` no longer rides along inside
  // `interactionBlocked`. Board positions computed against a filtered column are wrong, so
  // cross-Stage moves, same-Stage reorder and the Move-to menu are all disabled the same way a
  // disabled Board contract already disables them -- see `movementDisabled`/
  // `sameStageReorderEnabled` below, and `runBoardMovement`'s own guard as the last line of defence.
  const canMoveStages = boardMutationEnabled && canMoveStagesCapability && !searchActive;
  const isLoading = projectsQuery.isPending && !projectsQuery.data;
  const hasAcceptedDashboard = acceptedProjects?.key === dashboardKeyString;
  const error = !hasAcceptedDashboard && !queryProjects
    ? projectsQuery.error instanceof Error ? projectsQuery.error.message : projectsQuery.error ? "Projects could not be loaded." : undefined
    : undefined;
  // `canViewProductionCalendar`, not just `calendarState !== null`: a mounted instance re-rendered
  // with a role that has since lost the capability keeps its existing non-null `calendarState`
  // (nothing resets it on a role change short of a remount), so without this a Staff member who
  // loses the capability mid-session would still be shown Calendar content for one commit before
  // the reconciliation effect below moves `view` off it.
  const isCalendarView = view === "calendar" && !viewingArchived && calendarState !== null && canViewProductionCalendar;
  // Published for the rail (#119), mirroring the branch selection above and below (List ~1092,
  // Kanban ~1106) instead of re-deriving `view`/`viewingArchived` a second time, so the two cannot
  // drift: Calendar only when `isCalendarView` itself is true (so a `view` of "calendar" with no
  // `calendarState` yet is never claimed), List while archived or explicitly selected, Kanban only
  // when neither of those apply, and "none" — no rail child should claim to be current — when
  // `view` matches nothing that actually renders. `useLayoutEffect`, not `useEffect`, so the rail
  // updates in the same paint as the screen; see `lib/dashboard-view-store.ts` for the owner rule.
  const renderedView: DashboardView | "none" = isCalendarView ? "calendar"
    : viewingArchived || view === "list" ? "list"
    : !viewingArchived && view === "kanban" ? "kanban"
    : "none";
  const dashboardViewOwnerRef = useRef({});
  useLayoutEffect(() => {
    publishDashboardView(dashboardViewOwnerRef.current, renderedView);
  }, [renderedView]);
  useLayoutEffect(() => () => releaseDashboardView(dashboardViewOwnerRef.current), []);
  // Priority is deliberately the only Dashboard path that still writes this query cache.
  const updateProjects = useCallback((update: (current: ProjectSummary[]) => ProjectSummary[]) => {
    queryClient?.setQueryData<ProjectSummary[]>(dashboardKey, (current) => update(current ?? []));
  }, [dashboardKey, queryClient]);

  // #230: the CONFIRMED response only, never the optimistic write or the rollback -- those stay
  // EXACT-KEY (`updateProjects` above), so an unconfirmed value never lands in a cache entry nobody
  // is looking at. `queueDashboardRefresh` (below) refetches only the ACTIVE observer's own key, and
  // `invalidateProjectSurfaces(..., producer: "dashboard")` deliberately skips the in-tab Dashboard
  // scan -- so without this, a q-less entry loaded before the search (or any other scope's entry)
  // keeps the stale value and shows it the moment the search is cleared or the scope changes back.
  // `setQueriesData` on the principal-scoped prefix (precedent: `removeProjectFromDashboardQueries`,
  // `lib/dashboard-projects.ts` ~:128-136) only touches entries that ALREADY EXIST in the cache --
  // it must never manufacture an empty entry for a scope nobody has loaded yet.
  const updateAllProjectScopes = useCallback((update: (current: ProjectSummary[]) => ProjectSummary[]) => {
    queryClient?.setQueriesData<ProjectSummary[]>({ queryKey: ["dashboard-projects", currentUserId] }, (current) => current ? update(current) : current);
  }, [currentUserId, queryClient]);

  const captureFocusForRefresh = useCallback((fallbackStageKey?: StageKey, descriptor?: FocusDescriptor) => {
    if (focusRestoreRef.current) return;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusRestoreRef.current = {
      key: descriptor ? focusKeyForControl(descriptor.control, descriptor.projectId) : active?.getAttribute("data-focus-key") ?? null,
      x: window.scrollX,
      y: window.scrollY,
      fallbackStageKey: descriptor?.sourceStageKey ?? fallbackStageKey,
    };
  }, []);

  const setFocusFallbackStage = useCallback((stageKey: StageKey) => {
    if (focusRestoreRef.current) focusRestoreRef.current.fallbackStageKey = stageKey;
  }, []);

  const replaceAcceptedProjects = useCallback((next: ProjectSummary[]) => {
    captureFocusForRefresh();
    setAcceptedProjects({ key: dashboardKeyString, projects: next });
  }, [captureFocusForRefresh, dashboardKeyString]);

  const captureFocusTarget = useCallback((outcome: Parameters<typeof focusTargetAfter>[0], descriptor: FocusDescriptor, model: BoardModel, settledStageKey?: StageKey) => {
    const target = focusTargetAfter(outcome, descriptor, model, settledStageKey);
    const fallbackStageKey = outcome !== "stale-move-to"
      ? settledStageKey ?? descriptor.sourceStageKey
      : undefined;

    const next: FocusRestore = {
      key: "control" in target ? focusKeyForControl(target.control, target.projectId) : null,
      x: window.scrollX,
      y: window.scrollY,
      fallbackStageKey,
    };
    if (focusRestoreRef.current) {
      focusRestoreRef.current.key = next.key;
      focusRestoreRef.current.fallbackStageKey = next.fallbackStageKey;
    } else {
      focusRestoreRef.current = next;
    }
  }, []);

  useEffect(() => {
    if ((view === "list" || view === "kanban") && !viewingArchived) lastNonCalendarViewRef.current = view;
  }, [view, viewingArchived]);

  useEffect(() => {
    // Reconciles the route's EXPLICIT intent against local view state, including archive scope:
    // the rail keeps offering Kanban and Calendar while archived (see `lib/dashboard-view-store.ts`
    // for how it learns what actually rendered), so landing on one of those addresses is read as
    // LEAVING archived rather than an intent the archived screen silently drops.
    // `arrivedAtNewLocation` compares against the location THIS effect itself last reconciled, not
    // merely "is the location non-List" — `selectProjectScope("archived")` sets scope and pushes
    // its own `/?view=list` in the same handler, and an intermediate render still holding the OLD
    // explicit URL must not immediately bounce the Staff member back out of archived.
    const arrivedAtNewLocation = currentLocation !== lastReconciledLocationRef.current;
    lastReconciledLocationRef.current = currentLocation;
    // `locationHasCalendar`, not `effectiveRouteCalendar !== null` — the latter falls back to the
    // `calendar` PROP whenever the URL itself carries no facet, and that prop can outlive the URL
    // that produced it (a direct-mount caller that never re-renders it away, `Dashboard-calendar.
    // dom.test.tsx`'s own harness among them). Only the location itself is a fact about what the
    // Staff member is currently pointed at.
    const explicitNonListLocation = routeDashboardView === "kanban" || routeDashboardView === "calendar" || locationHasCalendar;
    if (viewingArchived && explicitNonListLocation) {
      if (arrivedAtNewLocation) setProjectScope("active");
      return;
    }
    if (!canViewProductionCalendar) {
      calendarFallbackLocationRef.current = false;
      if (view === "calendar") setView("list");
      return;
    }
    if (routeDashboardView) {
      calendarFallbackLocationRef.current = false;
      // #111's bare `/?view=calendar` intent carries no facet parameters — the rail links to it
      // precisely so that the remembered subview and last date resolve in one place, here, rather
      // than a second time in the rail. `calendarState` already holds them: it is initialised from
      // `initializeDashboardCalendarState`, which reads both from storage with the phone/desktop
      // and Sydney-today fallbacks. So this is the same canonicalising replace the stale-bare-
      // arrival case below already performs, reached by a different route.
      if (routeDashboardView === "calendar") {
        // #217 fix round 4, item 1 (Sol re-review, BLOCKER): reads `q` FROM THE ROUTE first now --
        // the rail's Calendar link carries its own `q` (`app-router.tsx`), and the intent itself is
        // now a legal spelling for one (`staff-routes.ts`'s `DashboardCalendarIntentRoute`), so a
        // native navigation (keyboard Enter, cmd/middle-click, a reload) that never touches the
        // in-memory store still canonicalises correctly. Falls back to `search.draft` only when the
        // route itself carries no `q` at all -- an intercepted SPA click whose href predates a
        // keystroke still in flight, mirroring `selectView`'s own entering-Calendar mapping.
        if (calendarState) history.replace(staffPathFor({ kind: "dashboard", calendar: { ...calendarState, search: routeDashboardSearch ?? search.draft } }));
        if (view !== "calendar") setView("calendar");
        return;
      }
      if (view !== routeDashboardView) setView(routeDashboardView);
      return;
    }
    if (effectiveRouteCalendar) {
      calendarFallbackLocationRef.current = false;
      setCalendarState(effectiveRouteCalendar);
      setView("calendar");
      return;
    }
    if (locationHasCalendar) return;
    if (calendarFallbackLocationRef.current) {
      // Same route-first, draft-fallback fix as the bare-intent canonicaliser above (#217 fix
      // round 4, item 1). `currentDashboardRoute` here is the genuinely bare route (no
      // `dashboardView`, no facet) -- its own `?q=`, if any, is `routeDashboardSearch`.
      if (calendarState) {
        history.replace(staffPathFor({ kind: "dashboard", calendar: { ...calendarState, search: routeDashboardSearch ?? search.draft } }));
      }
      calendarFallbackLocationRef.current = false;
      return;
    }
    // Genuinely bare "/" with no calendar involvement: restore the fixed per-document snapshot
    // rather than leaving `view` at whatever an earlier explicit push left it — this is what
    // makes Back actually undo an explicit List/Kanban switch (D2 gave each one its own history
    // entry), not just the pre-existing "leaving Calendar via a stale bare arrival" case.
    if (view !== bareRouteFallbackViewRef.current) setView(bareRouteFallbackViewRef.current);
    // `search.draft` (#217 fix round 3, item 1): the two Calendar canonicalisers above read it.
    // Every OTHER branch this effect can take is a cheap no-op on a keystroke-driven rerun (the
    // two canonicalisers themselves only ever fire while genuinely arriving at their respective
    // locations, not on every draft change), so this does not turn typing into a per-keystroke
    // URL-rewrite storm.
  }, [calendarState, canViewProductionCalendar, currentDashboardRoute, currentLocation, effectiveRouteCalendar, history, locationHasCalendar, routeDashboardSearch, routeDashboardView, search.draft, view, viewingArchived]);

  const navigateCalendar = useCallback((next: DashboardCalendarState, replace = false) => {
    if (!canViewProductionCalendar || viewingArchived || calendarInteractionBlocked) return;
    // #217 fix round 1, item 3 / #217 build step 4: flush and override `next.search` with the
    // just-flushed value -- every direct Calendar-facet change (Unassigned, a date/subview
    // change, ...) goes through `ProductionCalendarFilters`'s own `onChange` -> `onNavigate` ->
    // here, building `next` from its OWN `calendar` prop snapshot, which is the last COMMITTED
    // search, not necessarily whatever is still mid-debounce right as the facet changes. One
    // override point here covers every caller (this one, `selectView`'s calendar branch, and the
    // store's own writer) instead of each having to remember to flush for itself.
    // `takeDashboardSearchForNavigation` cancels the pending debounce and returns the normalised
    // draft in one call -- this history write IS the commit, so there is nothing left for the
    // debounce to redundantly re-fire (#217 build, step 4).
    const withCurrentSearch: DashboardCalendarState = { ...next, search: takeDashboardSearchForNavigation(currentUserId) };
    const built = staffPathFor({ kind: "dashboard", calendar: withCurrentSearch });
    setCalendarState(withCurrentSearch);
    try {
      calendarStorage.write(DASHBOARD_CALENDAR_SUBVIEW_KEY, withCurrentSearch.subview);
      calendarStorage.write(DASHBOARD_CALENDAR_LAST_DATE_KEY, withCurrentSearch.date);
    } catch { /* Calendar fallback storage is best effort. */ }
    if (replace) history.replace(built); else history.push(built);
  }, [calendarInteractionBlocked, canViewProductionCalendar, history, viewingArchived]);

  // #217: the single store's own debounce timer replaces this effect's bespoke one. Registers the
  // URL write the store calls once a debounced (or Enter-committed) query settles -- Calendar
  // replaces its own facet URL (never floods history while typing, same as the effect this
  // replaces); every other view replaces the bare/List/Kanban URL through `staffPathFor`.
  //
  // #217 fix round 3, item 2 (Sol's whole-branch review): registered through a STABLE closure over
  // a ref, in an effect with an EMPTY dependency list, so `setDashboardSearchUrlWriter` runs
  // exactly once per Dashboard MOUNT -- never on every `view`/`calendarState`/`history`/
  // `navigateCalendar` identity change, which used to tear the writer down and re-register it on
  // every one of those (view switches, Calendar facet changes, `viewingArchived` flipping...).
  // That mattered because it conflated two different events the store needs to tell apart: a
  // RE-REGISTRATION (the writer's identity churns, but a Dashboard is still mounted and a pending
  // debounce must survive it -- f40b19d, kept exactly as it was, in `dashboard-search-store.ts`)
  // and an actual UNMOUNT (this Dashboard instance is going away -- there is no Dashboard left to
  // receive a later URL write, and the store is a singleton with no way to route one anywhere
  // sane). Registering once per mount makes unmount the ONLY unregister this component ever
  // triggers. The `draft` itself is deliberately left alone: it is what lets an off-Dashboard
  // Enter (the rail's `ShellSearch`, mounted everywhere) still navigate with whatever text is
  // showing.
  //
  // #217 fix round 4, item 4 (SHOULD-FIX) used to need a `writerGenerationRef`/`queueMicrotask`
  // dance here, deferring the cleanup's own `cancelPendingDashboardSearchWrite()` call so a
  // same-tick `<StrictMode>` replay (mount, cleanup, mount again, all synchronous in one commit)
  // could back off before it cancelled a debounce armed off-Dashboard that was, once the replay
  // settled, still going to have a live Dashboard to receive it. #217 build, step 5 removes the
  // reason that dance was needed: `commit()` now simply drops a fire with no writer registered --
  // there is no local committed copy left for it to update either -- so the cleanup below can
  // unregister unconditionally with no deferred check. Both scenarios the dance used to
  // distinguish now fall out of that alone: a StrictMode replay re-registers a writer before the
  // timer can fire (still commits); a real unmount never re-registers one (never commits) --
  // `Dashboard-search-interaction.dom.test.tsx`'s own StrictMode suite covers both, unchanged in
  // outcome.
  const writerContextRef = useRef({ view, calendarState, history, navigateCalendar });
  writerContextRef.current = { view, calendarState, history, navigateCalendar };
  useEffect(() => {
    const unregister = setDashboardSearchUrlWriter((q) => {
      const { view: currentView, calendarState: currentCalendarState, history: currentHistory, navigateCalendar: currentNavigateCalendar } = writerContextRef.current;
      if (currentView === "calendar" && currentCalendarState) currentNavigateCalendar({ ...currentCalendarState, search: q, view: "calendar" }, true);
      else currentHistory.replace(staffPathFor({ kind: "dashboard", dashboardView: currentView === "calendar" ? "list" : currentView, search: q }));
    });
    return unregister;
  }, []);

  const reconcileAppliedCalendarFilters = useCallback((filters: ProductionCalendarFilters) => {
    if (!calendarState || !canViewProductionCalendar || viewingArchived || calendarInteractionBlocked) return;
    // #217 fix round 1, item 3 / #217 build step 4: flush BEFORE reading the search to carry, same
    // reasoning as `selectView` -- `calendarState.search` alone can be the last COMMITTED value,
    // stale against whatever is still mid-debounce right as this facet change fires.
    const currentSearch = takeDashboardSearchForNavigation(currentUserId);
    const next: DashboardCalendarState = { ...calendarState, ...filters, search: currentSearch, view: "calendar" };
    if (JSON.stringify(next) === JSON.stringify(calendarState)) return;
    const built = staffPathFor({ kind: "dashboard", calendar: next });
    setCalendarState(next);
    history.replace(built);
  }, [calendarInteractionBlocked, calendarState, canViewProductionCalendar, history, viewingArchived]);

  const acceptDashboardProjects = useCallback((next: ProjectSummary[], dataUpdatedAt?: number) => {
    if (queryRuntime?.principalTerminal) return;
    // Sol review round 2, item 3: dedupe on key AND updatedAt together -- `dashboardKeyString` here
    // is the key this specific call is stamping under (this closure's own, same as
    // `replaceAcceptedProjects` below uses), so a match requires both the SAME key and the SAME
    // millisecond, not just a coincidentally-equal timestamp from an unrelated key's own result.
    const lastAccepted = acceptedQueryUpdatedAtRef.current;
    if (dataUpdatedAt !== undefined && lastAccepted !== null && lastAccepted.key === dashboardKeyString && lastAccepted.updatedAt === dataUpdatedAt) return;
    const safeProjects = queryRuntime ? next.filter((project) => !queryRuntime.isProjectRemoved(project.id)) : next;
    if (dataUpdatedAt !== undefined) acceptedQueryUpdatedAtRef.current = { key: dashboardKeyString, updatedAt: dataUpdatedAt };
    if (safeProjects.every((project) => project.boardContractEnabled !== false)) setBoardUnavailableReason(null);
    replaceAcceptedProjects(safeProjects);
  }, [dashboardKeyString, queryRuntime, replaceAcceptedProjects]);

  useLayoutEffect(() => {
    if (pendingMoves.size > 0 || pendingOrdering.size > 0 || (movementSettlePending && !recoveryReason)) return;
    const restore = focusRestoreRef.current;
    if (!restore) return;
    focusRestoreRef.current = null;
    window.scrollTo(restore.x, restore.y);
    // A refresh that was never tied to a known Board control has no business moving focus. #98:
    // `setProjectPriority` queues a refresh whose `captureFocusForRefresh()` takes no arguments, so
    // a user editing Priority (a control that carries no `data-focus-key`) recorded
    // `{ key: null, fallbackStageKey: undefined }` — and tier 3 below then pulled focus off the star
    // row onto the Board root. Scroll is still restored; focus is left exactly where the user put it.
    if (restore.key === null && restore.fallbackStageKey === undefined) return;
    const target = restore.key ? [...document.querySelectorAll<HTMLElement>("[data-focus-key]")].find((element) => element.getAttribute("data-focus-key") === restore.key) : undefined;
    // `preventScroll` on every Board restore: the scroll position is restored explicitly by the
    // `window.scrollTo` above, so letting focus ALSO scroll just fights it. Measured live (#98
    // probe rounds 3/4): without this, restoring focus to a handle outside the viewport drove the
    // Board's horizontal scroll to 0 — `preventScroll: true` suppressed it completely on both Boards.
    if (target && !target.hasAttribute("disabled")) { target.focus({ preventScroll: true }); return; }
    const fallback = restore.fallbackStageKey
      ? document.querySelector<HTMLElement>(`[data-focus-key="stage-heading:${restore.fallbackStageKey}"]`)
      : null;
    (fallback ?? document.querySelector<HTMLElement>('[data-focus-key="board"]'))?.focus({ preventScroll: true });
  }, [acceptedProjects, announcement, boardOverlay, boardUnavailableMessage, dashboardKeyString, movementSettlePending, pendingMoves, pendingOrdering, projects, recoveryReason]);

  // Sol review round 1, item 2: `projectsQuery.isPlaceholderData` -- react-query serves the
  // PREVIOUS committed-query's dataset as `queryProjects` (`keepPreviousData`,
  // `lib/dashboard-projects.ts`'s `placeholderData`) while a NEW committed-query's fetch is still in
  // flight. Accepting that placeholder under the NEW `dashboardKeyString` would stamp it as though it
  // were that key's own confirmed result; `hasAcceptedDashboard` would then suppress the error state
  // if the fetch went on to fail, leaving the WRONG query's rows on screen as though they were
  // correct. `projects` (~:370) already falls back to `queryProjects` directly whenever
  // `acceptedProjects` doesn't match the current key, so refusing to accept here costs no loading/
  // empty flash -- the placeholder rows still render, just never get stamped as this key's own.
  useEffect(() => {
    if (!queryProjects || projectsQuery.isPlaceholderData || queryRuntime?.principalTerminal) return;
    if (interactionBlocked) {
      queuedRefreshRef.current = true;
      return;
    }
    if (queuedRefreshRef.current) return;
    acceptDashboardProjects(queryProjects, queryDataUpdatedAt);
    if (movementSettlePendingRef.current) {
      movementSettlePendingRef.current = false;
      setMovementSettlePending(false);
      setRecoveryReason(null);
      movementRecoveryRef.current = null;
    }
  }, [acceptDashboardProjects, interactionBlocked, projectsQuery.isPlaceholderData, queryDataUpdatedAt, queryProjects, queryRuntime]);

  useEffect(() => {
    if (interactionBlocked || !queuedRefreshRef.current) return;
    queuedRefreshRef.current = false;
    // Sol review round 2, item 2: snapshot the key this refetch is FOR, same as item 1's
    // `currentKeyAtConfirm` above -- `QueryObserver#fetch()`'s own `.then()` reads
    // `this.#currentResult` AFTER the underlying fetch settles, which is the observer's CURRENT
    // result for whatever key is active THEN, not necessarily this one. This closure's own
    // `acceptDashboardProjects`/`replaceAcceptedProjects` are bound to dashboardKeyString as of
    // THIS render (the key below), so accepting a result for a since-changed key would stamp it
    // under this stale one.
    const refreshKey = dashboardKeyStringRef.current;
    void projectsQuery.refetch().then((result) => {
      const settling = movementSettlePendingRef.current;
      // ABA fix (diagnosed via instrumentation, ~24/24 repro runs): `result` is
      // `QueryObserver#fetch()`'s own resolved value, which reads `this.#currentResult` AFTER the
      // underlying fetch settles -- the OBSERVER's CURRENT result for whatever key is active THEN,
      // not necessarily `refreshKey`. If the committed search goes A -> B -> A while this refetch
      // (issued for A, `refreshKey`) is still in flight, `result` can by then be back on A too
      // (`dashboardKeyStringRef.current === refreshKey` below would pass) while still carrying B's
      // rows, because the observer's own current result was computed while ITS current query was
      // still B -- `result.isPlaceholderData` is false in that case (B's data is real, not a
      // placeholder), so the old key-string + isPlaceholderData guard alone let it through. Trusting
      // `result`'s PAYLOAD at all, for either branch, is the vulnerability -- query identity, not
      // payload shape, is what actually distinguishes refreshKey's own outcome. Read provenance
      // from the cache entry for `refreshKey` itself instead: `queryClient.getQueryState` returns
      // that key's own persisted status/data, which is what the real underlying fetch (the one this
      // promise settling proves already ran) actually wrote, regardless of what the observer's
      // `result` currently shows.
      const refreshState = queryClient?.getQueryState<ProjectSummary[]>(JSON.parse(refreshKey) as readonly unknown[]);
      if (refreshState?.status === "error") {
        if (settling) {
          const message = "The move was saved, but the latest Board could not be loaded. Refresh to continue.";
          setRecoveryReason(message);
          const recoveryMessage = postSuccessRefetchFailureAnnouncement(movementRecoveryRef.current, effectiveKanbanSort, Boolean(queryRuntime?.principalTerminal));
          if (recoveryMessage !== undefined) setAnnouncement(recoveryMessage);
        } else if (interactionBlockedRef.current) {
          queuedRefreshRef.current = true;
        }
        return;
      }
      if (refreshState?.status !== "success" || !refreshState.data) {
        // Not (yet) a confirmed outcome for refreshKey -- no cache entry, or still pending/fetching.
        // In practice this should not happen (the underlying fetch settling is what resolved this
        // promise in the first place, and it writes refreshKey's own cache entry inline before
        // settling), but if it ever does, do nothing harmful: this is neither a confirmed success
        // (nothing to accept) nor a confirmed error (no reason to show the recovery/error state for
        // a fetch that, for all this closure knows, never actually failed) -- only re-arm the queued
        // refresh so a future pass gets another chance, same as the old "unusable result" branch did.
        if (interactionBlockedRef.current) queuedRefreshRef.current = true;
        return;
      }
      if (interactionBlockedRef.current) {
        queuedRefreshRef.current = true;
        return;
      }
      if (queryRuntime?.principalTerminal) return;
      // The committed search moved on while this refetch was in flight -- refreshKey's own confirmed
      // result still exists in the cache (accepted above via `refreshState`), but it is no longer
      // the ACTIVE key: refuse to stamp it under refreshKey. The primary accept effect (above)
      // already owns accepting the current key's own data once it's real, under its own (current,
      // non-stale) closure.
      if (dashboardKeyStringRef.current !== refreshKey) return;
      acceptDashboardProjects(refreshState.data, refreshState.dataUpdatedAt);
      // Keep this release outside acceptDashboardProjects; its acceptedQueryUpdatedAtRef/dataUpdatedAt dedupe guard could otherwise strand movementSettlePending.
      if (settling) {
        movementSettlePendingRef.current = false;
        setMovementSettlePending(false);
        setRecoveryReason(null);
        movementRecoveryRef.current = null;
      }
    }).catch(() => {
      if (movementSettlePendingRef.current) {
        const message = "The move was saved, but the latest Board could not be loaded. Refresh to continue.";
        setRecoveryReason(message);
        const recoveryMessage = postSuccessRefetchFailureAnnouncement(movementRecoveryRef.current, effectiveKanbanSort, Boolean(queryRuntime?.principalTerminal));
        if (recoveryMessage !== undefined) setAnnouncement(recoveryMessage);
      } else if (interactionBlockedRef.current) {
        queuedRefreshRef.current = true;
      }
    });
  }, [acceptDashboardProjects, effectiveKanbanSort, interactionBlocked, projectsQuery.refetch, queryClient, queryRuntime]);

  useEffect(() => {
    if (!queryRuntime) return;
    if (queryRuntime.principalTerminal) {
      queuedRefreshRef.current = false;
      movementBusyRef.current = false;
      movementSettlePendingRef.current = false;
      setBoardOverlay(null);
      setMovementSettlePending(false);
      setRecoveryReason(null);
      movementRecoveryRef.current = null;
      focusRestoreRef.current = null;
      setBoardInteraction({ activeId: undefined, proposal: null });
      setPendingMoves(new Set());
      setPendingOrdering(new Set());
      setAnnouncement("");
      setAcceptedProjects((current) => current?.key === dashboardKeyString && current.projects.length === 0 ? current : { key: dashboardKeyString, projects: [] });
      return;
    }
    const current = acceptedProjects?.key === dashboardKeyString ? acceptedProjects.projects : undefined;
    const overlayRemoved = boardOverlay?.key === dashboardKeyString && boardOverlay.model.some((project) => queryRuntime.isProjectRemoved(project.id));
    if (!current?.some((project) => queryRuntime.isProjectRemoved(project.id)) && !overlayRemoved) return;
    setBoardOverlay(null);
    movementBusyRef.current = false;
    movementSettlePendingRef.current = false;
    setMovementSettlePending(false);
    setRecoveryReason(null);
    queuedRefreshRef.current = false;
    focusRestoreRef.current = null;
    setBoardInteraction({ activeId: undefined, proposal: null });
    setPendingMoves(new Set());
    setPendingOrdering(new Set());
    setAnnouncement("");
    if (!current) return;
    const filtered = current.filter((project) => !queryRuntime.isProjectRemoved(project.id));
    setAcceptedProjects((previous) => previous?.key === dashboardKeyString && previous.projects.length === filtered.length ? previous : { key: dashboardKeyString, projects: filtered });
  }, [acceptedProjects, boardOverlay, dashboardKeyString, queryRuntime, runtimeVersion]);

  useEffect(() => {
    if (!(projectsQuery.error instanceof ApiError) || (projectsQuery.error.status !== 401 && projectsQuery.error.status !== 403)) return;
    queuedRefreshRef.current = false;
    movementBusyRef.current = false;
    movementSettlePendingRef.current = false;
    setBoardOverlay(null);
    setMovementSettlePending(false);
    setRecoveryReason(null);
    focusRestoreRef.current = null;
    setBoardInteraction({ activeId: undefined, proposal: null });
    setPendingMoves(new Set());
    setPendingOrdering(new Set());
    setAnnouncement("");
    setAcceptedProjects({ key: dashboardKeyString, projects: [] });
  }, [dashboardKeyString, projectsQuery.error]);

  const queueDashboardRefresh = useCallback(() => {
    queuedRefreshRef.current = true;
    if (!interactionBlockedRef.current) {
      queuedRefreshRef.current = false;
      void projectsQuery.refetch();
    }
  }, [projectsQuery.refetch]);

  const activeCount = projects.filter((project) => project.stageKey !== "delivered").length;
  const needsReviewCount = projects.filter((project) => project.stageKey === "raw_review" || project.stageKey === "edited_review").length;
  const deliveredCount = projects.filter((project) => project.stageKey === "delivered").length;
  const activeStages = stages.filter((stage) => stage.active);
  const kanbanSortOptions: SelectOption<KanbanSortMode>[] = useMemo(() => {
    const options: SelectOption<KanbanSortMode>[] = [{ value: "board", label: "Board order" }];
    if (canPrioritize && hasAuthorizedBoardMap) options.push({ value: "priority", label: "Priority" });
    options.push({ value: "shootDate-asc", label: "Shoot date ↑" }, { value: "shootDate-desc", label: "Shoot date ↓" });
    return options;
  }, [canPrioritize, hasAuthorizedBoardMap]);

  const handleCalendarAccessLoss = useCallback(() => {
    setCalendarInteractionBlocked(false);
    setCalendarSettle({ pending: false, recoveryReason: null });
    calendarFallbackLocationRef.current = false;
    setView("list");
    lastNonCalendarViewRef.current = "list";
    try { window.localStorage.setItem("quincy:dashboard:view", "list"); } catch { /* Storage can be disabled by the browser. */ }
    // #217 fix round 8, Sol review, item 3 (MEDIUM). A bare `history.push("/")` dropped any
    // committed `q` the Calendar facet URL carried -- a Calendar mutation returning 401/403 while
    // parked at `/?view=calendar&...&q=smith` landed on the bare `/`, and `ShellRoute`'s own sync
    // then read that q-less arrival as authoritative and cleared the draft too. Built with
    // `staffPathFor`/`takeDashboardSearchForNavigation` the same way every other navigation site in
    // this file already carries a committed-or-mid-debounce search across a route change.
    if (view === "calendar" || routeCalendar !== null || locationHasCalendar) {
      const currentSearch = takeDashboardSearchForNavigation(currentUserId);
      history.push(staffPathFor({ kind: "dashboard", ...(currentSearch ? { search: currentSearch } : {}) }));
    }
    window.setTimeout(() => document.querySelector<HTMLElement>('[data-focus-key="dashboard-view-list"]')?.focus(), 0);
  }, [currentUserId, history, locationHasCalendar, routeCalendar, view]);

  const projectHrefFor = useCallback((projectId: string) => `/projects/${encodeURIComponent(projectId)}`, []);

  const openCalendarProject = useCallback((projectId: string) => {
    if (calendarInteractionBlocked || calendarSettle.pending || !canViewProductionCalendar || viewingArchived) return;
    history.push(projectHrefFor(projectId));
  }, [calendarInteractionBlocked, calendarSettle.pending, canViewProductionCalendar, history, projectHrefFor, viewingArchived]);

  function selectView(next: DashboardView) {
    if (interactionBlockedRef.current || calendarInteractionBlocked) return;
    if (next === "calendar") {
      if (!canViewProductionCalendar || viewingArchived) return;
      const nextCalendar = calendarState ?? initializeDashboardCalendarState({ kind: "dashboard" }, calendarStorage, { now: Date.now(), isPhone: window.matchMedia?.("(max-width: 720px)").matches ?? false });
      calendarFallbackLocationRef.current = false;
      setView("calendar");
      try { window.localStorage.setItem("quincy:dashboard:view", "calendar"); } catch { /* Storage can be disabled by the browser. */ }
      // #217 fix round 8, Sol review, item 2 (MEDIUM). No Calendar-state search read here any
      // more, and no `setDashboardSearchDraft` call to clobber the draft with it: reading
      // `effectiveRouteCalendar.search`/`calendarState.search` (the last COMMITTED `q`) and
      // writing it back into the store, one line before `navigateCalendar` reads the draft back
      // out via `takeDashboardSearchForNavigation`, discarded whatever the user had typed SINCE
      // that commit -- a click on the already-active Calendar control while mid-debounce restored
      // stale text instead of carrying the in-progress one. `navigateCalendar` already flushes and
      // reads the current draft itself; `search` here is inert (overwritten there unconditionally)
      // but keeps `nextCalendar`'s own shape.
      navigateCalendar({ ...nextCalendar, view: "calendar" });
      return;
    }
    const alreadyAtView = routeDashboardView === next;
    const shouldPushViewRoute = !alreadyAtView || currentDashboardRoute?.kind === "dashboard" && !routeDashboardView;
    setView(next);
    lastNonCalendarViewRef.current = next;
    try { window.localStorage.setItem("quincy:dashboard:view", next); } catch { /* Storage can be disabled by the browser. */ }
    if (shouldPushViewRoute) {
      setCalendarSettle({ pending: false, recoveryReason: null });
      calendarFallbackLocationRef.current = false;
      // #217 fix round 1, item 3 / #217 build step 4: flush BEFORE building this push. The
      // writer-registration effect's own cleanup does NOT flush a pending debounce (#217 fix
      // round 3, item 2 -- `dashboard-search-store.ts`'s unregister callback only ever nulls the
      // `writer` reference on a re-registration, and only an actual Dashboard UNMOUNT cancels the
      // timer outright, never commits it), and it would run too late for this push either way --
      // AFTER this synchronous handler returns and React re-renders. Reading the just-flushed
      // value directly, here, is what carries a committed OR still-debouncing search across a
      // view switch instead of silently dropping it.
      const currentSearch = takeDashboardSearchForNavigation(currentUserId);
      history.push(staffPathFor({ kind: "dashboard", dashboardView: next, ...(currentSearch ? { search: currentSearch } : {}) }));
    }
  }

  function selectProjectScope(next: ProjectScope) {
    if (interactionBlockedRef.current || calendarInteractionBlocked) return;
    setProjectScope(next);
    if (next === "archived" && view !== "list") {
      const leavingCalendar = view === "calendar";
      if (leavingCalendar) setCalendarSettle({ pending: false, recoveryReason: null });
      setView("list");
      lastNonCalendarViewRef.current = "list";
      try { window.localStorage.setItem("quincy:dashboard:view", "list"); } catch { /* Storage can be disabled by the browser. */ }
      calendarFallbackLocationRef.current = false;
      if (leavingCalendar || routeCalendar !== null || locationHasCalendar || routeDashboardView !== "list") {
        // Same flush-then-read as `selectView` above.
        const currentSearch = takeDashboardSearchForNavigation(currentUserId);
        history.push(staffPathFor({ kind: "dashboard", dashboardView: "list", ...(currentSearch ? { search: currentSearch } : {}) }));
      }
    }
  }

  function selectKanbanSort(next: KanbanSortMode) {
    if (interactionBlockedRef.current) return;
    if (next === "priority" && (!canPrioritize || !hasAuthorizedBoardMap)) return;
    setKanbanSort(next);
    try { window.localStorage.setItem("quincy:dashboard:kanbanSort", next); } catch { /* Storage can be disabled by the browser. */ }
  }

  type BoardMovementIntent = {
    projectId: string;
    gap: SemanticGap;
    kind: "cross" | "same";
    origin: FocusDescriptor["path"];
    focusDescriptor: FocusDescriptor;
  };

  const stageLabelFor = (stageKey: StageKey) => stages.find((stage) => canonicalStageKey(stage.key) === stageKey)?.label ?? stageKey;

  const movementAnnouncement = useCallback((
    event: Parameters<typeof announce>[0],
    model: BoardModel,
    project: ProjectSummary,
    targetStageKey: StageKey = canonicalStageKey(project.stageKey),
  ) => {
    const targetColumn = sortKanbanProjects(
      model.projects.filter((item) => canonicalStageKey(item.stageKey) === targetStageKey),
      effectiveKanbanSort,
    );
    const position = targetColumn.findIndex((item) => item.id === project.id);
    const message = announce(event, {
      terminal: Boolean(queryRuntime?.principalTerminal || queryRuntime?.isProjectRemoved(project.id)),
      street: project.street,
      stageLabel: stageLabelFor(targetStageKey),
      sourceStageLabel: stageLabelFor(canonicalStageKey(project.stageKey)),
      position: position < 0 ? targetColumn.length : position + 1,
      count: targetColumn.length,
    });
    if (message !== undefined) setAnnouncement(message);
    return message;
  }, [effectiveKanbanSort, queryRuntime, stages]);

  const isMovementTerminal = useCallback((projectId: string) => Boolean(queryRuntime?.principalTerminal || queryRuntime?.isProjectRemoved(projectId)), [queryRuntime]);

  async function runBoardMovement(intent: BoardMovementIntent) {
    // Last line of defence (#217 fix round 1, item 2): `canMoveStages`/`sameStageReorderEnabled`
    // already withhold the UI affordances that would normally reach this, but a stale drag gesture
    // in flight when a search commits must not be allowed to slip a mutation through regardless.
    if (movementBusyRef.current || movementSettlePendingRef.current || pendingMoves.size > 0 || activeConfirm || pendingOrdering.size > 0 || searchActive) return;
    const baselineModel = boardModelFromProjects(projects);
    const movingProject = baselineModel.projects.find((project) => project.id === intent.projectId);
    if (!movingProject) {
      if (intent.origin === "move-to") {
        captureFocusForRefresh(intent.focusDescriptor.sourceStageKey, intent.focusDescriptor);
        const message = announce({ type: "stale-move-to" }, { terminal: Boolean(queryRuntime?.principalTerminal) });
        if (message !== undefined) setAnnouncement(message);
        queueDashboardRefresh();
      }
      return;
    }
    if (isMovementTerminal(intent.projectId)) return;
    const sourceStageKey = canonicalStageKey(movingProject.stageKey);
    const sameStage = isSameStagePlacementChange({ gap: intent.gap, movingProject });
    const sameStageEnabled = canPrioritize && hasAuthorizedBoardMap && effectiveKanbanSort === "board";
    const fallbackStage = intent.focusDescriptor.sourceStageKey;
    captureFocusForRefresh(fallbackStage, intent.focusDescriptor);

    const activeStageKeys = new Set(activeStages.map((stage) => canonicalStageKey(stage.key)));
    if (!activeStageKeys.has(intent.gap.targetStageKey)) {
      captureFocusTarget(intent.origin === "move-to" ? "stale-move-to" : "dnd-cancel", intent.focusDescriptor, baselineModel, sourceStageKey);
      movementAnnouncement(intent.origin === "move-to" ? { type: "stale-move-to" } : { type: "dnd-cancel" }, baselineModel, movingProject, sourceStageKey);
      if (intent.origin === "move-to") queueDashboardRefresh();
      return;
    }

    if ((intent.kind === "same" && (!sameStage || !sameStageEnabled)) || (intent.kind === "cross" && sameStage)) {
      captureFocusTarget(intent.origin === "keyboard" ? "invalid-keyboard-target" : "dnd-cancel", intent.focusDescriptor, baselineModel, sourceStageKey);
      movementAnnouncement(intent.origin === "keyboard" ? { type: "invalid-keyboard-target" } : { type: "dnd-cancel" }, baselineModel, movingProject, sourceStageKey);
      return;
    }
    if (intent.kind === "same" && !boardGapChangesOrder(intent.gap, baselineModel, intent.projectId)) {
      captureFocusTarget("no-op", intent.focusDescriptor, baselineModel, sourceStageKey);
      movementAnnouncement({ type: "unchanged-gap" }, baselineModel, movingProject, sourceStageKey);
      return;
    }
    if (intent.kind === "cross" && !canMoveStages) {
      captureFocusTarget("dnd-cancel", intent.focusDescriptor, baselineModel, sourceStageKey);
      movementAnnouncement({ type: "dnd-cancel" }, baselineModel, movingProject, sourceStageKey);
      return;
    }

    let request: MoveProjectStageRequest;
    if (intent.kind === "same") {
      const resolved = reorderIntentFromGap(intent.gap, baselineModel, intent.projectId, role);
      if ("stale" in resolved) {
        captureFocusTarget(intent.origin === "move-to" ? "stale-move-to" : "dnd-cancel", intent.focusDescriptor, baselineModel, sourceStageKey);
        movementAnnouncement(intent.origin === "move-to" ? { type: "stale-move-to" } : { type: "dnd-cancel" }, baselineModel, movingProject, sourceStageKey);
        if (intent.origin === "move-to") queueDashboardRefresh();
        return;
      }
      request = {
        expected: { stageKey: movingProject.stageKey, boardRevision: movingProject.boardRevision },
        targetStageKey: resolved.targetStageKey,
        placement: resolved.placement,
      };
    } else {
      const resolved = buildMoveRequest(baselineModel, intent.projectId, intent.gap, role);
      if ("stale" in resolved) {
        captureFocusTarget(intent.origin === "move-to" ? "stale-move-to" : "dnd-cancel", intent.focusDescriptor, baselineModel, sourceStageKey);
        movementAnnouncement(intent.origin === "move-to" ? { type: "stale-move-to" } : { type: "dnd-cancel" }, baselineModel, movingProject, sourceStageKey);
        if (intent.origin === "move-to") queueDashboardRefresh();
        return;
      }
      request = resolved;
    }
    const optimisticModel = applyOptimisticOverlay(baselineModel, intent.projectId, intent.gap, role);
    const optimismSafe = intent.kind === "same"
      || optimismSafeBeforeResponse(movingProject.stageKey, intent.gap.targetStageKey, role, false);
    const applyOverlay = () => {
      if (isMovementTerminal(intent.projectId)) return;
      setBoardOverlay({ key: dashboardKeyString, baseline: baselineModel.projects, model: optimisticModel.projects, movingProjectId: intent.projectId });
    };
    if (optimismSafe) applyOverlay();
    movementBusyRef.current = true;
    setPendingMoves((current) => new Set(current).add(intent.projectId));
    let shouldRefresh = false;
    try {
      const response = await submitStageMoveWithConfirmation<MoveProjectStageResponse>(
        request,
        (body) => apiPost<MoveProjectStageResponse, MoveProjectStageRequest>(
          `/api/projects/${encodeURIComponent(intent.projectId)}/${intent.kind === "same" ? "board-position" : "stage"}`,
          body,
        ),
        {
          confirmationPolicy: intent.kind === "same" ? "forbidden" : "stage-move",
          onConfirmationRequired: () => {
            setBoardOverlay(null);
            movementAnnouncement({ type: "confirmation-required" }, baselineModel, movingProject, sourceStageKey);
          },
          beforeConfirmedSubmit: applyOverlay,
        },
      );
      if (!response) {
        setBoardOverlay(null);
        movementRecoveryRef.current = null;
        captureFocusTarget("modal-cancel", intent.focusDescriptor, baselineModel, sourceStageKey);
        movementAnnouncement({ type: "modal-cancel" }, baselineModel, movingProject, sourceStageKey);
        shouldRefresh = true;
        return;
      }
      if (isMovementTerminal(intent.projectId)) return;
      const reconciled = reconcileAuthoritativeResponse(baselineModel, intent.projectId, response);
      if (isMovementTerminal(intent.projectId)) return;
      setFocusFallbackStage(canonicalStageKey(response.project.stageKey));
      captureFocusTarget(response.changed ? "success" : "no-op", intent.focusDescriptor, reconciled.model, canonicalStageKey(response.project.stageKey));
      replaceAcceptedProjects(reconciled.model.projects);
      setBoardOverlay(null);
      setRecoveryReason(null);
      const settledStage = canonicalStageKey(response.project.stageKey);
      const settledProject = reconciled.model.projects.find((project) => project.id === intent.projectId) ?? movingProject;
      movementRecoveryRef.current = response.changed && reconciled.sourceProvisional
        ? { model: reconciled.model, projectId: intent.projectId, project: settledProject, settledStageKey: settledStage }
        : null;
      if (response.changed) {
        // Board invalidation is deliberately ID-free; each receiving tab invalidates only its
        // own authorization-scoped dashboard query. This tab is the producer: its own Board
        // query converges through queuedRefreshRef, not the coordinator.
        if (queryClient) {
          await invalidateProjectSurfaces(queryClient, {
            projectId: intent.projectId,
            resources: [{ kind: "detail" }, { kind: "activity" }],
            dashboard: true,
            calendar: true,
            gantt: true,
            producer: "dashboard",
          });
        } else {
          queryRuntime?.publish(createDashboardBoardInvalidatedMessage());
        }
      }
      movementAnnouncement(
        response.changed
          ? (reconciled.sourceProvisional ? { type: "cross-stage-success" } : { type: "same-stage-success" })
          : { type: "no-change" },
        reconciled.model,
        settledProject,
        settledStage,
      );
      if (response.changed && reconciled.sourceProvisional) {
        movementSettlePendingRef.current = true;
        setMovementSettlePending(true);
      }
      shouldRefresh = true;
      // `movementAnnouncement` above already spoke this outcome in the Dashboard live region. #99
      if (response.changed) toast(reconciled.sourceProvisional ? `Moved to ${stageLabelFor(settledStage)}.` : `Reordered in ${stageLabelFor(settledStage)}.`, "success", { announcedElsewhere: true });
    } catch (reason) {
      if (isMovementTerminal(intent.projectId)) return;
      setBoardOverlay(null);
      const details = reason instanceof ApiError && reason.details && typeof reason.details === "object" ? reason.details as Record<string, unknown> : {};
      const code = typeof details.code === "string" ? details.code : undefined;
      const capability = typeof details.capability === "string" ? details.capability : undefined;
      const isPriorityForbidden = reason instanceof ApiError && reason.status === 403
        && (capability === "prioritizeProjects" || code === "project_board_reorder_forbidden");
      const isAccessLoss = reason instanceof ApiError && reason.status === 401;
      const isConflict = reason instanceof ApiError && reason.status === 409 && code === "project_stage_conflict";
      const isContractUnavailable = reason instanceof ApiError && reason.status === 503 && code === "board_contract_disabled";
      const isMaintenance = reason instanceof ApiError && reason.status === 503 && code === "board_schema_maintenance";
      const focusOutcome = isConflict ? "conflict" : (isContractUnavailable || isMaintenance ? "503" : "conflict");
      captureFocusTarget(focusOutcome, intent.focusDescriptor, baselineModel, sourceStageKey);
      if (isPriorityForbidden) {
        setAnnouncement("Manual Board reorder requires Priority access.");
        toast("Manual Board reorder requires Priority access.", "error", { announcedElsewhere: true });
      } else if (isContractUnavailable || isMaintenance) {
        const event = isContractUnavailable ? { type: "contract-off" as const } : { type: "maintenance" as const };
        const copy = isContractUnavailable
          ? "Board interactions are temporarily unavailable while the Board contract is disabled."
          : "Board interactions are temporarily unavailable while the Board is being updated.";
        setBoardUnavailableReason(copy);
        movementAnnouncement(event, baselineModel, movingProject, sourceStageKey);
      } else if (isConflict) {
        movementAnnouncement({ type: "conflict" }, baselineModel, movingProject, sourceStageKey);
        toast("The project changed elsewhere; the Board was refreshed.", "error", { announcedElsewhere: true });
      } else {
        if (isAccessLoss && queryRuntime) {
          queryRuntime.markPrincipalTerminal();
          return;
        }
        setAnnouncement(reason instanceof Error ? reason.message : "The Board could not be updated.");
        toast(reason instanceof Error ? reason.message : "The Board could not be updated.", "error", { announcedElsewhere: true });
      }
      shouldRefresh = true;
    } finally {
      if (shouldRefresh && !isMovementTerminal(intent.projectId)) queueDashboardRefresh();
      setPendingMoves((current) => { const next = new Set(current); next.delete(intent.projectId); return next; });
      movementBusyRef.current = false;
    }
  }

  function onBoardMove(projectId: string, gap: SemanticGap, kind: "cross" | "same", focusDescriptor: FocusDescriptor) {
    void runBoardMovement({ projectId, gap, kind, origin: focusDescriptor.path, focusDescriptor });
  }

  function onMoveToStage(project: ProjectSummary, gap: SemanticGap, kind: "cross" | "same", focusDescriptor: FocusDescriptor) {
    void runBoardMovement({ projectId: project.id, gap, kind, origin: "move-to", focusDescriptor });
  }

  async function setProjectPriority(project: ProjectSummary, priority: number | null) {
    if (pendingOrdering.has(project.id)) return;
    updateProjects((current) => current.map((item) => item.id === project.id ? { ...item, priority } : item));
    setPendingOrdering((current) => new Set(current).add(project.id));
    try {
      const response = await apiPost<{ priority: number | null; boardRevision: number }, { priority: number | null }>(`/api/projects/${project.id}/priority`, { priority });
      // Sol review round 1, item 1: the fan-out below opens two races once it lands in a SIBLING
      // entry no observer is currently reading -- (A) a sibling's own refetch that started BEFORE
      // this POST resolving AFTER the fan-out write and putting the stale value back, (B) this
      // response being older than a sibling that already holds a NEWER server `boardRevision` (a
      // later stage move, say) and regressing it. `isSiblingDashboardQuery` structurally compares
      // `queryKey` (JSON, not reference) against the key ACTIVE at confirmation -- the ACTIVE entry's
      // own refresh is owned by `queueDashboardRefresh` below and must never be cancelled or
      // invalidated here.
      //
      // Sol review round 2, item 1: snapshot `dashboardKeyStringRef.current` HERE, immediately after
      // the POST resolves, not `dashboardKeyString` from this closure's own render (the CLICK-time
      // key). If the committed search (or archived scope) changed while the POST was in flight, the
      // NEWLY active key must be excluded from cancel/invalidate below -- it's the entry
      // `queueDashboardRefresh` is about to refresh, and cancelling its in-flight fetch or marking it
      // stale with no refetch regresses whatever it's showing. The origin key, now inactive, is just
      // another sibling once it's no longer the active one: it still gets the fan-out patch (via the
      // prefix write below, unconditional on this predicate), has its own late fetch cancelled, and
      // is marked stale, same as any other sibling.
      const currentKeyAtConfirm = dashboardKeyStringRef.current;
      const isSiblingDashboardQuery = (query: Query) =>
        Array.isArray(query.queryKey) &&
        query.queryKey[0] === "dashboard-projects" &&
        query.queryKey[1] === currentUserId &&
        JSON.stringify(query.queryKey) !== currentKeyAtConfirm;
      // (A) cancel every sibling's in-flight fetch FIRST -- its late result, once cancelled, can no
      // longer overwrite the fan-out write that follows.
      if (queryClient) await queryClient.cancelQueries({ predicate: isSiblingDashboardQuery });
      // (B) never patch an item whose cached `boardRevision` is already NEWER than this response's
      // -- leave it untouched. Applied to the exact-key write too, for the same reason: the active
      // entry can equally hold a boardRevision this response has fallen behind.
      const applyConfirmed = (current: ProjectSummary[]) => current.map((item) => {
        if (item.id !== project.id) return item;
        if (item.boardRevision > response.boardRevision) return item;
        return { ...item, priority: response.priority, boardRevision: response.boardRevision };
      });
      updateProjects(applyConfirmed);
      updateAllProjectScopes(applyConfirmed);
      // Mark the patched SIBLINGS stale without refetching them now (`refetchType: "none"`) -- a
      // same-`boardRevision` race then self-heals the next time that entry is actually observed
      // again, instead of firing a request for a scope nobody is looking at right now. Never the
      // active key: its own refresh is `queueDashboardRefresh` below.
      if (queryClient) queryClient.invalidateQueries({ predicate: isSiblingDashboardQuery, refetchType: "none" });
      queueDashboardRefresh();
      if (queryClient) await invalidateProjectSurfaces(queryClient, { projectId: project.id, resources: [{ kind: "detail" }, { kind: "activity" }], dashboard: true, calendar: false, gantt: false, producer: "dashboard" });
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 503 && reason.details && typeof reason.details === "object" && ((reason.details as { code?: unknown }).code === "board_contract_disabled" || (reason.details as { code?: unknown }).code === "board_schema_maintenance")) setBoardUnavailableReason("Board interactions are temporarily unavailable while the Board is being updated.");
      updateProjects((current) => current.map((item) => item.id === project.id && item.priority === priority ? { ...item, priority: project.priority } : item));
      queueDashboardRefresh();
      // One string for both: the toast is silenced as `announcedElsewhere`, so whatever the live region
      // says is all a screen-reader user gets. Speaking a generic line while the silent toast shows the
      // specific reason would withhold the reason from them alone.
      const priorityFailure = reason instanceof Error ? reason.message : "The project priority could not be updated.";
      setAnnouncement(priorityFailure);
      toast(priorityFailure, "error", { announcedElsewhere: true });
    } finally {
      setPendingOrdering((current) => { const next = new Set(current); next.delete(project.id); return next; });
    }
  }

  function moveProjectPosition(project: ProjectSummary, direction: "up" | "down") {
    if (movementBusyRef.current || pendingMoves.size > 0 || pendingOrdering.size > 0) return;
    const currentProject = projects.find((item) => item.id === project.id);
    if (!currentProject) return;
    const gap = adjacentBoardGap(currentProject.id, canonicalStageKey(currentProject.stageKey), direction, projects);
    if (!gap) return;
    const model = boardModelFromProjects(projects);
    const focusDescriptor = focusDescriptorFor("arrow", currentProject, model, direction === "up" ? "arrow-up" : "arrow-down");
    void runBoardMovement({ projectId: currentProject.id, gap, kind: "same", origin: "arrow", focusDescriptor });
  }

  return (
    <main className="page [overflow-x:clip]">
      <div className="flex flex-wrap items-end justify-between gap-x-[var(--space-6)] gap-y-[var(--space-5)] pb-[var(--space-4)]">
        <div>
          <Eyebrow className="mb-[var(--space-3)]">Quincy Portal · production desk</Eyebrow>
          <h1 className="[font:var(--type-h1)] tracking-[var(--tracking-tight)] max-[721px]:[font:var(--type-h2)]">Projects</h1>
        </div>
        <hr className="basis-full m-0 mb-[var(--space-6)] border-0 [border-top-style:solid] border-t-[length:var(--border-width-rule)] border-t-primary max-[721px]:mb-[var(--space-5)]" />
      </div>

      {canViewNoticeBoard && <NoticeBoard currentUserId={currentUserId} />}

      {!viewingArchived && !searchActive && <section aria-label="Project summary" className="[display:grid] grid-cols-4 [border-block-style:solid] border-y-[length:var(--border-width-hair)] border-y-border bg-transparent mb-[var(--space-6)] max-[1080px]:grid-cols-2">
        <div className="py-[var(--space-5)] pr-[var(--space-5)]">
          <div className="[font:var(--type-h2)] tracking-[var(--tracking-tight)] flex items-baseline gap-[var(--space-2)] tabular-nums max-[390px]:[font:var(--type-h3)]">{activeCount}</div>
          <div className="[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-widest)] text-foreground-secondary mt-[var(--space-2)]">Active shoots</div>
        </div>
        <div className="py-[var(--space-5)] pr-[var(--space-5)] pl-[var(--space-5)] [border-left-style:solid] border-l-[length:var(--border-width-hair)] border-l-border">
          <div className="[font:var(--type-h2)] tracking-[var(--tracking-tight)] flex items-baseline gap-[var(--space-2)] tabular-nums max-[390px]:[font:var(--type-h3)]"><span className="size-[7px] rounded-[var(--radius-pill)] shrink-0 self-center bg-signal-caution" />{needsReviewCount}</div>
          <div className="[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-widest)] text-foreground-secondary mt-[var(--space-2)]">Needs review</div>
        </div>
        <div className="py-[var(--space-5)] pr-[var(--space-5)] pl-[var(--space-5)] [border-left-style:solid] border-l-[length:var(--border-width-hair)] border-l-border max-[1080px]:pl-0 max-[1080px]:border-l-0 max-[1080px]:[border-top-style:solid] max-[1080px]:border-t-[length:var(--border-width-hair)] max-[1080px]:border-t-border">
          <div className="[font:var(--type-h2)] tracking-[var(--tracking-tight)] flex items-baseline gap-[var(--space-2)] tabular-nums max-[390px]:[font:var(--type-h3)]"><span className="size-[7px] rounded-[var(--radius-pill)] shrink-0 self-center bg-signal-positive" />{deliveredCount}</div>
          <div className="[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-widest)] text-foreground-secondary mt-[var(--space-2)]">Delivered</div>
        </div>
        <div className="py-[var(--space-5)] pr-[var(--space-5)] pl-[var(--space-5)] [border-left-style:solid] border-l-[length:var(--border-width-hair)] border-l-border max-[1080px]:[border-top-style:solid] max-[1080px]:border-t-[length:var(--border-width-hair)] max-[1080px]:border-t-border">
          <div className="[font:var(--type-h2)] tracking-[var(--tracking-tight)] flex items-baseline gap-[var(--space-2)] tabular-nums max-[390px]:[font:var(--type-h3)]">{projects.length}</div>
          <div className="[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-widest)] text-foreground-secondary mt-[var(--space-2)]">All projects</div>
        </div>
      </section>}

      <div data-testid="dashboard-toolbar" tabIndex={-1} className={cn(
        "flex flex-wrap items-center gap-x-[var(--space-6)] gap-y-[var(--space-3)] " +
        "mb-[var(--space-4)] pt-[var(--space-4)] [border-top-style:solid] " +
        "border-t-[length:var(--border-width-hair)] border-t-border")}>
        <div className="flex items-center gap-[var(--space-3)] flex-wrap max-[721px]:basis-full">
          {canCreateProject && <InternalLink className={buttonClasses()} to="/projects/new">New shoot</InternalLink>}
        </div>
        <div className="flex items-center flex-wrap justify-end gap-x-[var(--space-3)] gap-y-[var(--space-2)] ml-auto max-[721px]:basis-full max-[721px]:justify-start">
        {canViewArchived && <>
          <Eyebrow className="max-[721px]:basis-full max-[721px]:-mb-[var(--space-1)]">Projects</Eyebrow>
          <div className={SEGMENT_GROUP} aria-label="Project status">
            <button className={cn(SEGMENT_BUTTON, !viewingArchived && "is-active")} type="button" onClick={() => selectProjectScope("active")}>Active</button>
            <button className={cn(SEGMENT_BUTTON, viewingArchived && "is-active")} type="button" onClick={() => selectProjectScope("archived")}>Archived</button>
          </div>
        </>}
        {viewingArchived && <Eyebrow role="status">Archived projects</Eyebrow>}
        {!viewingArchived && <>
        <Eyebrow className="max-[721px]:basis-full max-[721px]:-mb-[var(--space-1)]">View</Eyebrow>
        <div className={SEGMENT_GROUP} aria-label="Dashboard view">
          <button className={cn(SEGMENT_BUTTON, view === "list" && "is-active")} type="button" data-focus-key="dashboard-view-list" data-active={view === "list" ? "true" : undefined} disabled={interactionBlocked || calendarInteractionBlocked} onClick={() => selectView("list")}>List</button>
          <button className={cn(SEGMENT_BUTTON, view === "kanban" && "is-active")} type="button" data-focus-key="dashboard-view-kanban" data-active={view === "kanban" ? "true" : undefined} disabled={interactionBlocked || calendarInteractionBlocked} onClick={() => selectView("kanban")}>Kanban</button>
          {canViewProductionCalendar && <button className={cn(SEGMENT_BUTTON, view === "calendar" && "is-active")} type="button" data-focus-key="dashboard-view-calendar" data-active={view === "calendar" ? "true" : undefined} disabled={interactionBlocked || calendarInteractionBlocked} onClick={() => selectView("calendar")}>Calendar</button>}
        </div>
        {!viewingArchived && view === "kanban" && (
          <div className="max-[721px]:basis-full">
            <Select
              value={effectiveKanbanSort}
              onValueChange={(next) => selectKanbanSort(next)}
              options={kanbanSortOptions}
              disabled={interactionBlocked}
              ariaLabel="Sort Kanban board"
              className="max-[721px]:w-full"
              triggerClassName={cn(
                "min-w-[var(--space-10)] max-[721px]:w-full max-[721px]:min-w-0",
                "max-[721px]:min-h-[44px]" /* WCAG 2.5.8 minimum target, not a spacing token */,
              )}
            />
          </div>
        )}
        </>}
        </div>
      </div>

      {/* #217 chip-row: the toolbar's geometry must never depend on the query -- measured in a real
          browser, with the rail expanded the toolbar's fixed controls take ~864 of ~1076px at 1440,
          and the chip's count text alone is ~148px, so no echo width kept the toolbar on one row
          (three rows at 1280, even after two rounds of shrinking the echo). The chip now renders in
          its own row below the toolbar instead, reading toolbar -> active search -> results. */}
      {searchActive && (
        <div data-testid="dashboard-search-summary" role="group" aria-label="Active search" className="flex min-w-0 items-center mb-[var(--space-4)]">
          <Badge data-testid="dashboard-search-chip" variant="secondary" size="sm" className="gap-[var(--space-2)] max-w-full min-w-0">
            <span className="shrink-0">
              {searchCountsQuery.data && (
                <>
                  {searchCountsQuery.data.matching} of {searchCountsQuery.data.total}{" "}
                  {searchCountsQuery.data.total === 1 ? "project" : "projects"} ·{" "}
                </>
              )}
            </span>
            {/* #217 design review (browser pass 3). The query is capped at 200 code points, not
                200 pixels, and `Badge` is `whitespace-nowrap`: unbounded, a deep-linked long query
                is a ~1000px pill. Bounded and truncating here, full text in `title`.
                `tracking-normal` finishes what `normal-case` started -- the user's own text is
                shown as typed, not with the Badge's eyebrow letter-spacing. */}
            <span
              className="min-w-0 max-w-[40ch] truncate normal-case tracking-normal"
              data-testid="dashboard-search-chip-query"
              title={committedQuery}
            >
              '{committedQuery}'
            </span>
            {/* WCAG 2.5.8: a `size-3` glyph alone is a ~12px hit area. `relative` plus the
                rail's own hit-expansion pattern (`reui/sidebar.tsx`'s `SidebarGroupAction`,
                `after:absolute after:-inset-2`) pads the actual hit target to >=24px without
                growing the chip's own visible box. At phone width the rail's own 44px touch
                convention applies (`ShellSearch.tsx`'s Sheet trigger): 12 + 2 x 16 = 44px. */}
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                clearDashboardSearch(currentUserId);
                // Clearing unmounts this very button. Hand focus to a control that survives it (see
                // `focusTargetAfterClearingSearch`) so it never falls back to `document.body`, from
                // where the next Tab restarts in the page chrome.
                window.setTimeout(() => focusTargetAfterClearingSearch(document.querySelector<HTMLElement>('[data-testid="dashboard-toolbar"]'))?.focus({ preventScroll: true }), 0);
              }}
              className="relative inline-flex items-center shrink-0 after:absolute after:-inset-2 max-[721px]:after:-inset-4"
            >
              <XIcon aria-hidden="true" className="size-3" />
            </button>
          </Badge>
        </div>
      )}

      {boardUnavailableMessage && !viewingArchived && !isCalendarView && (
        <Notice tone="caution" role="status" data-testid="board-unavailable-notice" className="flex items-baseline gap-[var(--space-3)] mb-[var(--space-4)] px-[var(--space-4)] py-[var(--space-3)] before:content-['Board'] before:shrink-0 before:[font:var(--type-eyebrow)] before:uppercase before:tracking-[var(--tracking-widest)] before:text-signal-caution-text text-foreground">{boardUnavailableMessage}</Notice>
      )}

      {isCalendarView && (
        <Suspense fallback={<div className={cn("empty", CALENDAR_STATE_BOX)} role="status">Loading calendar…</div>}>
          <ProductionCalendar
            identity={identity}
            calendar={calendarState && { ...calendarState, search: committedQuery }}
            onNavigate={(next) => navigateCalendar(next)}
            onAppliedFilters={reconcileAppliedCalendarFilters}
            onAcceptGateChange={setCalendarInteractionBlocked}
            onSettleStateChange={setCalendarSettle}
            onAccessLoss={handleCalendarAccessLoss}
            projectHrefFor={projectHrefFor}
            onOpenProject={openCalendarProject}
          />
        </Suspense>
      )}

      {!isCalendarView && isLoading && (
        <div role="status" className="relative border-solid border-[length:var(--border-width-hair)] border-border bg-card motion-safe:animate-[fade_var(--dur-slow)_var(--ease-entrance)]">
          <span className="absolute size-px overflow-hidden [clip-path:inset(50%)] whitespace-nowrap">{`Loading ${viewingArchived ? "archived " : ""}projects. Preparing the production desk.`}</span>
          {[0, 1, 2, 3, 4].map((row) => (
            <div key={row} className="[display:grid] grid-cols-[72px_minmax(0,1fr)_96px] gap-[var(--space-4)] items-center px-[var(--space-5)] py-[var(--space-3)] [border-top-style:solid] border-t-[length:var(--border-width-hair)] border-t-border first:border-t-0" aria-hidden="true">
              <Skeleton className="h-[var(--space-7)]" />
              <Skeleton className="h-[10px] w-2/5" />
              <Skeleton className="h-[10px]" />
            </div>
          ))}
        </div>
      )}

      {!isCalendarView && !isLoading && error && (
        <EmptyState tone="error" role="alert" title={`${viewingArchived ? "Archived projects" : "Projects"} are unavailable.`} className="border-solid border-[length:var(--border-width-hair)] border-border bg-card [border-left-style:solid] border-l-[length:var(--border-width-rule)] border-l-destructive">
          {error}
          <div><Button type="button" variant="secondary" className="mt-[var(--space-4)]" onClick={() => void projectsQuery.refetch()}>Try again</Button></div>
        </EmptyState>
      )}

      {!isCalendarView && !isLoading && !error && projects.length === 0 && (
        <EmptyState title={searchActive ? "No matches." : viewingArchived ? "No archived projects." : "No shoots yet — create the first one."} className="max-[721px]:px-[var(--space-4)] max-[721px]:py-[var(--space-7)] [&>strong]:max-w-[34ch] [&>strong]:mx-auto">
          {searchActive ? "No projects match this search." : viewingArchived ? "Archived projects remain here until they are restored or permanently deleted." : "Start the production desk with the property, client, and team details."}
          {!searchActive && !viewingArchived && canCreateProject && <div><InternalLink className={buttonClasses("primary", { className: "mt-[var(--space-4)]" })} to="/projects/new">New shoot</InternalLink></div>}
        </EmptyState>
      )}

      {!isCalendarView && !isLoading && !error && projects.length > 0 && (viewingArchived || view === "list") && (
        <div className="border-solid border-[length:var(--border-width-hair)] border-border bg-card" aria-label="Projects list">
          <div className={cn(PROW_GRID, "bg-secondary cursor-default")}>
            <div />
            <div className="[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-widest)] text-foreground-secondary">Address</div>
            <div className="[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-widest)] text-foreground-secondary max-[721px]:hidden">Client</div>
            <div className="[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-widest)] text-foreground-secondary max-[721px]:hidden">Shoot date</div>
            <div className="[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-widest)] text-foreground-secondary max-[721px]:hidden">Status</div>
            <div className="[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-widest)] text-foreground-secondary text-right">RAW received</div>
          </div>
          {projects.map((project) => <ProjectListRow key={project.id} project={project} projectHref={projectHrefFor(project.id)} />)}
        </div>
      )}

      {!isCalendarView && !isLoading && !error && !viewingArchived && projects.length > 0 && view === "kanban" && (
        <ProjectKanbanBoard2
          projects={projects}
          activeStages={activeStages}
          canMoveStages={canMoveStages}
          canPrioritize={canPrioritize && hasAuthorizedBoardMap}
          role={role}
          boardMutationEnabled={boardMutationEnabled}
          movementDisabled={movementSettlePending || !boardMutationEnabled || searchActive}
          sameStageReorderEnabled={boardMutationEnabled && canPrioritize && hasAuthorizedBoardMap && effectiveKanbanSort === "board" && !searchActive}
          effectiveKanbanSort={effectiveKanbanSort}
          pendingMoves={pendingMoves}
          pendingOrdering={pendingOrdering}
          terminal={Boolean(queryRuntime?.principalTerminal || projects.some((project) => queryRuntime?.isProjectRemoved(project.id)))}
          onBoardMove={onBoardMove}
          onBoardPosition={moveProjectPosition}
          onPriorityChange={setProjectPriority}
          onMoveStage={onMoveToStage}
          onMoveToProposalChange={(proposal) => setBoardInteraction((current) => ({ activeId: current.activeId, proposal }))}
          onInteractionStateChange={setBoardInteraction}
          onAnnounce={(message) => { if (message !== undefined) setAnnouncement(message); }}
          projectHrefFor={(project) => projectHrefFor(project.id)}
        />
      )}
      <div className="sr-only" data-testid="dashboard-live-region" aria-live="polite" aria-atomic="true">{announcement}</div>
      <ToastViewport testId="dashboard-toast-viewport" toastTestId="dashboard-toast" />
    </main>
  );
}

function StandaloneDashboard(props: DashboardProps) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return <QueryClientProvider client={queryClient}><DashboardContent {...props} /></QueryClientProvider>;
}

export function Dashboard(props: DashboardProps) {
  // App normally supplies the principal-scoped provider. Keep an isolated screen renderable in
  // previews/tests without changing the production cache boundary.
  const queryClient = useContext(QueryClientContext);
  return queryClient ? <DashboardContent {...props} /> : <StandaloneDashboard {...props} />;
}
