import { lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from "react";
import { formatSydneyCivil, roleHasCapability, type DashboardCalendarState, type DashboardQuickDetail, type DashboardRoute, type MoveProjectStageRequest, type MoveProjectStageResponse, type ProductionCalendarFilters, type StageKey } from "@quincy/shared";
import { QueryClient, QueryClientContext, QueryClientProvider } from "@tanstack/react-query";
import { StatusBadge } from "../components/atoms";
import { LazyImage } from "../components/LazyImage";
import { ApiError, apiPost } from "../lib/api";
import { confirmStore } from "../lib/confirm";
import { useCapabilities } from "../lib/capabilities";
import { useStages } from "../lib/stages";
import { DASHBOARD_CALENDAR_LAST_DATE_KEY, DASHBOARD_CALENDAR_SUBVIEW_KEY, formatDashboardDate, initializeDashboardCalendarState, initializeDashboardView, initializeKanbanSortMode, normalizeDashboardCalendarSearch, sanitizeDashboardCalendarSearch, type DashboardView, type KanbanSortMode } from "./dashboard-helpers";
import { InternalLink } from "../components/InternalLink";
import { NoticeBoard } from "../components/NoticeBoard";
import { invalidateProjectSurfaces, removeProjectData, terminatePrincipalOnUnauthorized, useOptionalProjectQueryClient } from "../lib/project-data";
import { createDashboardBoardInvalidatedMessage, getProjectQueryRuntime } from "../lib/project-query-sync";
import { dashboardProjectsKey, useDashboardProjects } from "../lib/dashboard-projects";
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
  type BoardModel,
  type FocusDescriptor,
  type ProjectSummary,
  type SemanticGap,
} from "../lib/kanban-interaction";
import { ProjectKanbanBoard, type BoardInteractionState } from "../components/ProjectKanbanBoard";
import { ProjectQuickDetailSheet, computeSheetVisible, type ProjectQuickDetailView } from "../components/ProjectQuickDetailSheet";
// Code-split: FullCalendar + its deps (~84 kB gzip) load only when a capable
// principal opens the Calendar view, never on the sign-in screen or a
// Photographer dashboard.
const ProductionCalendar = lazy(() => import("../components/ProductionCalendar").then((module) => ({ default: module.ProductionCalendar })));
import { locationStore, parseStaffLocation, safeStaffDestination, staffPathFor } from "../lib/router";
import type { CalendarSettleState } from "../lib/production-calendar-interaction";

export { adjacentBoardGap, adjacentBoardPlacement, cardDropPlacement, sortKanbanProjects } from "../lib/kanban-interaction";
export type { ProjectSummary } from "../lib/kanban-interaction";
export { KanbanCard } from "../components/ProjectKanbanBoard";

type ProjectScope = "active" | "archived";
type Toast = { id: number; message: string; tone: "success" | "error" };
type BoardOverlay = { key: string; baseline: ProjectSummary[]; model: ProjectSummary[]; movingProjectId: string };
type FocusRestore = { key: string | null; x: number; y: number; fallbackStageKey?: StageKey };
type MovementRecovery = { model: BoardModel; projectId: string; project: ProjectSummary; settledStageKey: StageKey };
type QuickDetailOrigin = { element: HTMLElement; location: string };
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

function ProjectListRow({ project, projectHref, onProjectAnchorClick }: { project: ProjectSummary; projectHref: string; onProjectAnchorClick?: (event: ReactMouseEvent<HTMLAnchorElement>) => void }) {
  const [coverFailed, setCoverFailed] = useState(false); const [coverRetry, setCoverRetry] = useState(0);
  return <div className="prow-wrap">
    <InternalLink className="prow" to={projectHref} onClick={onProjectAnchorClick}>
      <CoverMedia project={project} className="prow__thumb" inlinePlaceholder retryToken={coverRetry} onFailedChange={setCoverFailed} />
      <span><span className="serif prow__addr">{project.street}</span><span className="ey prow__location">{location(project)}</span></span>
      <span className="prow__c-agency">{project.agencyName || "Agency pending"}<span className="muted">{project.agentName || "Agent pending"}</span></span>
      <span className="prow__c-date">{formatDashboardDate(project.shootDate)}</span>
      <span className="prow__c-status"><StatusBadge stageKey={project.stageKey} /></span>
      <span className="prow__raw">{project.receivedCount}</span>
    </InternalLink>
    {coverFailed && <button className="prow__retry button button--secondary" type="button" onClick={() => { setCoverFailed(false); setCoverRetry((current) => current + 1); }}>Retry cover image</button>}
  </div>;
}

type DashboardProps = { currentUserId: string; role?: Parameters<typeof dashboardProjectsKey>[1]; authorizationEpoch?: number; calendar?: DashboardCalendarState | null; suppressQuickDetail?: boolean };

type DashboardRouteArm = Extract<DashboardRoute, { kind: "dashboard" }>;

type DashboardViewRoute = Extract<DashboardRouteArm, { dashboardView: "list" | "kanban" }>;
type DashboardCalendarRoute = Extract<DashboardRouteArm, { calendar: DashboardCalendarState }>;

function isDashboardViewRoute(route: DashboardRouteArm): route is DashboardViewRoute {
  return "dashboardView" in route;
}

function isDashboardCalendarRoute(route: DashboardRouteArm): route is DashboardCalendarRoute {
  return "calendar" in route;
}

function dashboardDetail(route: DashboardRouteArm): DashboardQuickDetail | undefined {
  return "detail" in route ? route.detail : undefined;
}

function dashboardBackingRoute(route: DashboardRouteArm): DashboardRouteArm {
  if ("calendar" in route) return { kind: "dashboard", calendar: route.calendar };
  if ("dashboardView" in route) return { kind: "dashboard", dashboardView: route.dashboardView };
  return { kind: "dashboard" };
}

function dashboardRouteWithDetail(route: DashboardRouteArm, detail: DashboardQuickDetail | undefined): DashboardRouteArm {
  if ("calendar" in route) return { kind: "dashboard", calendar: route.calendar, ...(detail ? { detail } : {}) };
  if ("dashboardView" in route) return { kind: "dashboard", dashboardView: route.dashboardView, ...(detail ? { detail } : {}) };
  return { kind: "dashboard" };
}

function DashboardContent({ currentUserId, role = "photographer", authorizationEpoch = 0, calendar: routeCalendar = null, suppressQuickDetail = false }: DashboardProps) {
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
  const routeDetail = currentDashboardRoute ? dashboardDetail(currentDashboardRoute) : undefined;
  const effectiveRouteCalendar = currentDashboardRoute && isDashboardCalendarRoute(currentDashboardRoute) ? currentDashboardRoute.calendar : routeCalendar;
  const calendarStorage = {
    read: (key: string) => window.localStorage.getItem(key),
    write: (key: string, value: string) => window.localStorage.setItem(key, value),
  };
  const [projectScope, setProjectScope] = useState<ProjectScope>("active");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<DashboardView>(() => {
    if (routeDashboardView) return routeDashboardView;
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
  const [calendarState, setCalendarState] = useState<DashboardCalendarState | null>(() => effectiveRouteCalendar && canViewProductionCalendar
    ? effectiveRouteCalendar
    : canViewProductionCalendar ? initializeDashboardCalendarState({ kind: "dashboard" }, calendarStorage, { now: Date.now(), isPhone: window.matchMedia?.("(max-width: 720px)").matches ?? false }) : null);
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
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const [boardUnavailableReason, setBoardUnavailableReason] = useState<string | null>(null);
  const [, setDocumentActivityVersion] = useState(0);
  const quickDetailOriginRef = useRef<QuickDetailOrigin | null>(null);
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
  const projectsQuery = useDashboardProjects(viewingArchived, identity);
  const dashboardKey = dashboardProjectsKey(currentUserId, role, authorizationEpoch, viewingArchived);
  const dashboardKeyString = JSON.stringify(dashboardKey);
  const queryProjects = projectsQuery.data;
  const queryDataUpdatedAt = projectsQuery.dataUpdatedAt;
  const [acceptedProjects, setAcceptedProjects] = useState<{ key: string; projects: ProjectSummary[] }>();
  const queryRuntime = queryClient ? getProjectQueryRuntime(queryClient) : undefined;
  const runtimeVersion = useSyncExternalStore(queryRuntime?.subscribe ?? noRuntimeSubscribe, queryRuntime?.getSnapshot ?? zeroRuntimeSnapshot, queryRuntime?.getSnapshot ?? zeroRuntimeSnapshot);
  const activeConfirm = useSyncExternalStore(confirmStore.subscribe, confirmStore.getSnapshot, () => null);
  // Calendar owns its accept/settle barriers separately. Board interactionBlocked
  // remains the TB5B state machine and never incorporates either Calendar gate.
  const interactionBlocked = Boolean(boardInteraction.activeId || boardInteraction.proposal || pendingMoves.size > 0 || pendingOrdering.size > 0 || activeConfirm);
  const interactionBlockedRef = useRef(interactionBlocked);
  interactionBlockedRef.current = interactionBlocked;
  const lastNonCalendarViewRef = useRef<"list" | "kanban">("list");
  const calendarFallbackLocationRef = useRef(!effectiveRouteCalendar && !routeDashboardView && view === "calendar" && canViewProductionCalendar);
  const calendarSearchTimerRef = useRef<number | null>(null);
  const movementSettlePendingRef = useRef(false);
  movementSettlePendingRef.current = movementSettlePending;
  const movementBusyRef = useRef(false);
  const queuedRefreshRef = useRef(false);
  const focusRestoreRef = useRef<FocusRestore | null>(null);
  const movementRecoveryRef = useRef<MovementRecovery | null>(null);
  const acceptedQueryUpdatedAtRef = useRef<number | null>(null);
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
  const canMoveStages = boardMutationEnabled && canMoveStagesCapability;
  const isLoading = projectsQuery.isPending && !projectsQuery.data;
  const hasAcceptedDashboard = acceptedProjects?.key === dashboardKeyString;
  const error = !hasAcceptedDashboard && !queryProjects
    ? projectsQuery.error instanceof Error ? projectsQuery.error.message : projectsQuery.error ? "Projects could not be loaded." : undefined
    : undefined;
  const isCalendarView = view === "calendar" && !viewingArchived && calendarState !== null;
  // Priority is deliberately the only Dashboard path that still writes this query cache.
  const updateProjects = useCallback((update: (current: ProjectSummary[]) => ProjectSummary[]) => {
    queryClient?.setQueryData<ProjectSummary[]>(dashboardKey, (current) => update(current ?? []));
  }, [dashboardKey, queryClient]);

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
    if (!canViewProductionCalendar) {
      calendarFallbackLocationRef.current = false;
      if (view === "calendar") setView("list");
      return;
    }
    if (routeDashboardView) {
      calendarFallbackLocationRef.current = false;
      if (view !== routeDashboardView) setView(routeDashboardView);
      return;
    }
    if (effectiveRouteCalendar) {
      calendarFallbackLocationRef.current = false;
      setCalendarState(effectiveRouteCalendar);
      // Keep live input whitespace while avoiding a redundant state update when
      // this is the route produced by our own debounced search replacement.
      setQuery((current) => normalizeDashboardCalendarSearch(current) === effectiveRouteCalendar.search ? current : effectiveRouteCalendar.search);
      if (!viewingArchived) setView("calendar");
      return;
    }
    if (locationHasCalendar) return;
    if (calendarFallbackLocationRef.current) {
      if (calendarState) {
        const built = staffPathFor(dashboardRouteWithDetail({ kind: "dashboard", calendar: calendarState }, routeDetail));
        if (safeStaffDestination(built) === built) history.replace(built);
        else console.error("Production Calendar route invariant failed while restoring the saved view.");
      }
      calendarFallbackLocationRef.current = false;
      return;
    }
    // Genuinely bare "/" with no calendar involvement: restore the fixed per-document snapshot
    // rather than leaving `view` at whatever an earlier explicit push left it — this is what
    // makes Back actually undo an explicit List/Kanban switch (D2 gave each one its own history
    // entry), not just the pre-existing "leaving Calendar via a stale bare arrival" case.
    if (view !== bareRouteFallbackViewRef.current) setView(bareRouteFallbackViewRef.current);
  }, [calendarState, canViewProductionCalendar, effectiveRouteCalendar, history, locationHasCalendar, routeDashboardView, routeDetail, view, viewingArchived]);

  const navigateCalendar = useCallback((next: DashboardCalendarState, replace = false) => {
    if (!canViewProductionCalendar || viewingArchived || calendarInteractionBlocked) return;
    const built = staffPathFor(dashboardRouteWithDetail({ kind: "dashboard", calendar: next }, routeDetail));
    if (safeStaffDestination(built) !== built) {
      console.error("Production Calendar route invariant failed; navigation was not performed.");
      return;
    }
    setCalendarState(next);
    try {
      calendarStorage.write(DASHBOARD_CALENDAR_SUBVIEW_KEY, next.subview);
      calendarStorage.write(DASHBOARD_CALENDAR_LAST_DATE_KEY, next.date);
    } catch { /* Calendar fallback storage is best effort. */ }
    if (replace) history.replace(built); else history.push(built);
  }, [calendarInteractionBlocked, canViewProductionCalendar, history, routeDetail, viewingArchived]);

  useEffect(() => {
    if (calendarSearchTimerRef.current !== null) {
      window.clearTimeout(calendarSearchTimerRef.current);
      calendarSearchTimerRef.current = null;
    }
    if (view !== "calendar" || !calendarState) return;

    const next = normalizeDashboardCalendarSearch(query);
    if (next === calendarState.search) return;

    calendarSearchTimerRef.current = window.setTimeout(() => {
      calendarSearchTimerRef.current = null;
      const committed = normalizeDashboardCalendarSearch(query);
      if (committed !== calendarState.search) navigateCalendar({ ...calendarState, search: committed, view: "calendar" }, true);
    }, 300);

    return () => {
      if (calendarSearchTimerRef.current !== null) {
        window.clearTimeout(calendarSearchTimerRef.current);
        calendarSearchTimerRef.current = null;
      }
    };
  }, [calendarState, navigateCalendar, query, view]);

  const reconcileAppliedCalendarFilters = useCallback((filters: ProductionCalendarFilters) => {
    if (!calendarState || !canViewProductionCalendar || viewingArchived || calendarInteractionBlocked) return;
    const next: DashboardCalendarState = { ...calendarState, ...filters, view: "calendar" };
    if (JSON.stringify(next) === JSON.stringify(calendarState)) return;
    const built = staffPathFor(dashboardRouteWithDetail({ kind: "dashboard", calendar: next }, routeDetail));
    if (safeStaffDestination(built) !== built) {
      console.error("Production Calendar applied-filter route invariant failed; URL was not changed.");
      return;
    }
    setCalendarState(next);
    history.replace(built);
  }, [calendarInteractionBlocked, calendarState, canViewProductionCalendar, history, routeDetail, viewingArchived]);

  const acceptDashboardProjects = useCallback((next: ProjectSummary[], dataUpdatedAt?: number) => {
    if (queryRuntime?.principalTerminal) return;
    if (dataUpdatedAt !== undefined && acceptedQueryUpdatedAtRef.current === dataUpdatedAt) return;
    const safeProjects = queryRuntime ? next.filter((project) => !queryRuntime.isProjectRemoved(project.id)) : next;
    if (dataUpdatedAt !== undefined) acceptedQueryUpdatedAtRef.current = dataUpdatedAt;
    if (safeProjects.every((project) => project.boardContractEnabled !== false)) setBoardUnavailableReason(null);
    replaceAcceptedProjects(safeProjects);
  }, [queryRuntime, replaceAcceptedProjects]);

  useLayoutEffect(() => {
    if (pendingMoves.size > 0 || pendingOrdering.size > 0 || (movementSettlePending && !recoveryReason)) return;
    const restore = focusRestoreRef.current;
    if (!restore) return;
    focusRestoreRef.current = null;
    window.scrollTo(restore.x, restore.y);
    const target = restore.key ? [...document.querySelectorAll<HTMLElement>("[data-focus-key]")].find((element) => element.getAttribute("data-focus-key") === restore.key) : undefined;
    if (target && !target.hasAttribute("disabled")) { target.focus(); return; }
    const fallback = restore.fallbackStageKey
      ? document.querySelector<HTMLElement>(`[data-focus-key="stage-heading:${restore.fallbackStageKey}"]`)
      : null;
    (fallback ?? document.querySelector<HTMLElement>('[data-focus-key="board"]'))?.focus();
  }, [acceptedProjects, announcement, boardOverlay, boardUnavailableMessage, dashboardKeyString, movementSettlePending, pendingMoves, pendingOrdering, projects, recoveryReason]);

  useEffect(() => {
    if (!queryProjects || queryRuntime?.principalTerminal) return;
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
  }, [acceptDashboardProjects, interactionBlocked, queryDataUpdatedAt, queryProjects, queryRuntime]);

  useEffect(() => {
    if (interactionBlocked || !queuedRefreshRef.current) return;
    queuedRefreshRef.current = false;
    void projectsQuery.refetch().then((result) => {
      const settling = movementSettlePendingRef.current;
      if (result.isError || !result.data) {
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
      if (interactionBlockedRef.current) {
        queuedRefreshRef.current = true;
        return;
      }
      if (queryRuntime?.principalTerminal) return;
      acceptDashboardProjects(result.data, result.dataUpdatedAt);
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
  }, [acceptDashboardProjects, effectiveKanbanSort, interactionBlocked, projectsQuery.refetch, queryRuntime]);

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

  const toast = useCallback((message: string, tone: Toast["tone"] = "success") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 3600);
  }, []);

  const filteredProjects = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return projects;
    return projects.filter((project) => [project.street, project.suburb, project.agencyName, project.agentName]
      .some((value) => (value ?? "").toLocaleLowerCase().includes(term)));
  }, [projects, query]);

  const activeCount = projects.filter((project) => project.stageKey !== "delivered").length;
  const needsReviewCount = projects.filter((project) => project.stageKey === "raw_review" || project.stageKey === "edited_review").length;
  const deliveredCount = projects.filter((project) => project.stageKey === "delivered").length;
  const activeStages = stages.filter((stage) => stage.active);

  const handleCalendarAccessLoss = useCallback(() => {
    setCalendarInteractionBlocked(false);
    setCalendarSettle({ pending: false, recoveryReason: null });
    calendarFallbackLocationRef.current = false;
    setView("list");
    lastNonCalendarViewRef.current = "list";
    try { window.localStorage.setItem("quincy:dashboard:view", "list"); } catch { /* Storage can be disabled by the browser. */ }
    if (view === "calendar" || routeCalendar !== null || locationHasCalendar) history.push("/");
    window.setTimeout(() => document.querySelector<HTMLElement>('[data-focus-key="dashboard-view-list"]')?.focus(), 0);
  }, [history, locationHasCalendar, routeCalendar, view]);

  const projectHrefFor = useCallback((projectId: string) => {
    if (!roleHasCapability(role, "viewQuickDetail")) return `/projects/${encodeURIComponent(projectId)}`;
    const baseRoute: DashboardRouteArm = currentDashboardRoute && (isDashboardCalendarRoute(currentDashboardRoute) || isDashboardViewRoute(currentDashboardRoute))
      ? currentDashboardRoute
      : view === "calendar" && calendarState
        ? { kind: "dashboard", calendar: calendarState }
        : { kind: "dashboard", dashboardView: view === "kanban" ? "kanban" : "list" };
    const built = staffPathFor(dashboardRouteWithDetail(baseRoute, { projectId, view: "overview" }));
    return safeStaffDestination(built) === built ? built : `/projects/${encodeURIComponent(projectId)}`;
  }, [calendarState, currentDashboardRoute, role, view]);

  const rememberQuickDetailOrigin = useCallback((event: ReactMouseEvent<HTMLAnchorElement>) => {
    // Deliberately narrower than shouldInterceptInternalLink: that predicate's
    // detail===0 rejection exists to let InternalLink's native Enter-key
    // activation fall through to a full page navigation, which doesn't apply
    // to ProjectCalendarAnchor's own synthesized Enter/Space .click() (also
    // detail===0) — that gesture legitimately opens the sheet in-document and
    // must still be recorded as a same-document opener.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    quickDetailOriginRef.current = { element: event.currentTarget, location: history.getLocation() };
  }, [history]);

  const openCalendarProject = useCallback((projectId: string) => {
    if (calendarInteractionBlocked || calendarSettle.pending || !canViewProductionCalendar || viewingArchived) return;
    const current = parseStaffLocation(history.getLocation());
    const calendar = current.kind === "dashboard" && "calendar" in current ? current.calendar : calendarState;
    if (!calendar) return;
    // This is intentionally a facet-only writer. navigateCalendar is gated by
    // Calendar's interaction barrier and is therefore not safe for a click
    // that terminates a FullCalendar drag gesture.
    const built = staffPathFor({ kind: "dashboard", calendar, detail: { projectId, view: "overview" } });
    if (safeStaffDestination(built) !== built) {
      console.error("Project quick-detail route invariant failed; navigation was not performed.");
      return;
    }
    history.push(built);
  }, [calendarInteractionBlocked, calendarSettle.pending, calendarState, canViewProductionCalendar, history, viewingArchived]);

  const closeQuickDetail = useCallback(() => {
    if (!currentDashboardRoute || !routeDetail) return;
    const built = staffPathFor(dashboardBackingRoute(currentDashboardRoute));
    if (safeStaffDestination(built) !== built) return;
    const origin = quickDetailOriginRef.current;
    quickDetailOriginRef.current = null;
    if (origin?.location === built) window.history.back();
    else history.replace(built);
    window.setTimeout(() => {
      if (origin?.element.isConnected) { origin.element.focus(); return; }
      document.querySelector<HTMLElement>(`[data-focus-key="dashboard-view-${view}"]`)?.focus();
    }, 0);
  }, [currentDashboardRoute, history, routeDetail, view]);

  const handleSheetAccessFailure = useCallback((error: unknown, resource: "detail" | "activity" | "comments" | "comment-read-marker" | "nested-comment") => {
    // "nested-comment" (an edit/delete rejection) is deliberately excluded: the server checks
    // membership before authorship, but both failures surface as the same 403 status, so a
    // rejection here can't be trusted to mean collaboration access was lost (it's just as likely
    // an author-only mismatch) — it stays a local, inline mutation error, never a sheet-wide close.
    if (resource === "nested-comment" || !(error instanceof ApiError)) return;
    if (error.status !== 401 && error.status !== 403 && error.status !== 404) return;
    if (queryClient) {
      if (error.status === 401) terminatePrincipalOnUnauthorized(queryClient, error);
      else if (routeDetail) void removeProjectData(queryClient, routeDetail.projectId);
    }
    closeQuickDetail();
  }, [closeQuickDetail, queryClient, routeDetail]);

  const changeQuickDetailView = useCallback((next: ProjectQuickDetailView) => {
    if (!currentDashboardRoute || !routeDetail) return;
    const built = staffPathFor(dashboardRouteWithDetail(currentDashboardRoute, { ...routeDetail, view: next }));
    if (safeStaffDestination(built) !== built) return;
    history.replace(built);
  }, [currentDashboardRoute, history, routeDetail]);

  const sheetVisible = typeof document !== "undefined"
    ? computeSheetVisible(document, activeConfirm === null)
    : false;

  function selectView(next: DashboardView) {
    if (interactionBlockedRef.current || calendarInteractionBlocked) return;
    if (next === "calendar") {
      if (!canViewProductionCalendar || viewingArchived) return;
      const nextCalendar = calendarState ?? initializeDashboardCalendarState({ kind: "dashboard" }, calendarStorage, { now: Date.now(), isPhone: window.matchMedia?.("(max-width: 720px)").matches ?? false });
      const enteringSearch = effectiveRouteCalendar?.search ?? (view === "calendar" ? calendarState?.search ?? "" : query);
      const sanitizedSearch = sanitizeDashboardCalendarSearch(enteringSearch);
      calendarFallbackLocationRef.current = false;
      setQuery(sanitizedSearch);
      setView("calendar");
      try { window.localStorage.setItem("quincy:dashboard:view", "calendar"); } catch { /* Storage can be disabled by the browser. */ }
      navigateCalendar({ ...nextCalendar, search: normalizeDashboardCalendarSearch(sanitizedSearch), view: "calendar" });
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
      history.push(staffPathFor({ kind: "dashboard", dashboardView: next }));
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
      if (leavingCalendar || routeCalendar !== null || locationHasCalendar || routeDashboardView !== "list") history.push(staffPathFor({ kind: "dashboard", dashboardView: "list" }));
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
    if (movementBusyRef.current || movementSettlePendingRef.current || pendingMoves.size > 0 || activeConfirm || pendingOrdering.size > 0) return;
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
      if (response.changed) toast(reconciled.sourceProvisional ? `Moved to ${stageLabelFor(settledStage)}.` : `Reordered in ${stageLabelFor(settledStage)}.`);
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
        toast("Manual Board reorder requires Priority access.", "error");
      } else if (isContractUnavailable || isMaintenance) {
        const event = isContractUnavailable ? { type: "contract-off" as const } : { type: "maintenance" as const };
        const copy = isContractUnavailable
          ? "Board interactions are temporarily unavailable while the Board contract is disabled."
          : "Board interactions are temporarily unavailable while the Board is being updated.";
        setBoardUnavailableReason(copy);
        movementAnnouncement(event, baselineModel, movingProject, sourceStageKey);
      } else if (isConflict) {
        movementAnnouncement({ type: "conflict" }, baselineModel, movingProject, sourceStageKey);
        toast("The project changed elsewhere; the Board was refreshed.", "error");
      } else {
        if (isAccessLoss && queryRuntime) {
          queryRuntime.markPrincipalTerminal();
          return;
        }
        setAnnouncement(reason instanceof Error ? reason.message : "The Board could not be updated.");
        toast(reason instanceof Error ? reason.message : "The Board could not be updated.", "error");
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
      updateProjects((current) => current.map((item) => item.id === project.id ? { ...item, priority: response.priority, boardRevision: response.boardRevision } : item));
      queueDashboardRefresh();
      if (queryClient) await invalidateProjectSurfaces(queryClient, { projectId: project.id, resources: [{ kind: "detail" }, { kind: "activity" }], dashboard: true, calendar: false, producer: "dashboard" });
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 503 && reason.details && typeof reason.details === "object" && ((reason.details as { code?: unknown }).code === "board_contract_disabled" || (reason.details as { code?: unknown }).code === "board_schema_maintenance")) setBoardUnavailableReason("Board interactions are temporarily unavailable while the Board is being updated.");
      updateProjects((current) => current.map((item) => item.id === project.id && item.priority === priority ? { ...item, priority: project.priority } : item));
      queueDashboardRefresh();
      setAnnouncement("Project priority could not be updated.");
      toast(reason instanceof Error ? reason.message : "The project priority could not be updated.", "error");
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
    <main className="page">
      <div className="pagehead">
        <div>
          <div className="ey" style={{ marginBottom: 14 }}>Quincy Portal · production desk</div>
          <h1 className="serif">Projects</h1>
        </div>
        <div className="toolbar">
          <label className="dashboard-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>
            <span className="sr-only">Search projects</span>
            <input value={query} onChange={(event) => setQuery(sanitizeDashboardCalendarSearch(event.target.value))} placeholder="Search address, suburb, client…" />
          </label>
          {canCreateProject && <InternalLink className="button" to="/projects/new">New shoot</InternalLink>}
        </div>
      </div>

      {canViewNoticeBoard && <NoticeBoard currentUserId={currentUserId} />}

      {!viewingArchived && <div className="stats" aria-label="Project summary">
        <div className="stat"><div className="v">{activeCount}</div><div className="l">Active shoots</div></div>
        <div className="stat"><div className="v"><span className="sdot" style={{ background: "var(--signal-caution)" }} />{needsReviewCount}</div><div className="l">Needs review</div></div>
        <div className="stat"><div className="v"><span className="sdot" style={{ background: "var(--signal-positive)" }} />{deliveredCount}</div><div className="l">Delivered</div></div>
        <div className="stat"><div className="v">{projects.length}</div><div className="l">All projects</div></div>
      </div>}

      <div className="dashboard-viewbar">
        {canViewArchived && <>
          <span className="ey">Projects</span>
          <div className="segment" aria-label="Project status">
            <button className={!viewingArchived ? "is-active" : ""} type="button" onClick={() => selectProjectScope("active")}>Active</button>
            <button className={viewingArchived ? "is-active" : ""} type="button" onClick={() => selectProjectScope("archived")}>Archived</button>
          </div>
        </>}
        {viewingArchived && <span className="ey" role="status">Archived projects</span>}
        {!viewingArchived && <>
        <span className="ey">View</span>
        <div className="segment" aria-label="Dashboard view">
          <button className={view === "list" ? "is-active" : ""} type="button" data-focus-key="dashboard-view-list" disabled={interactionBlocked || calendarInteractionBlocked} onClick={() => selectView("list")}>List</button>
          <button className={view === "kanban" ? "is-active" : ""} type="button" data-focus-key="dashboard-view-kanban" disabled={interactionBlocked || calendarInteractionBlocked} onClick={() => selectView("kanban")}>Kanban</button>
          {canViewProductionCalendar && <button className={view === "calendar" ? "is-active" : ""} type="button" data-focus-key="dashboard-view-calendar" disabled={interactionBlocked || calendarInteractionBlocked} onClick={() => selectView("calendar")}>Calendar</button>}
        </div>
        {!viewingArchived && view === "kanban" && (
          <label className="dashboard-sort">
            <span className="sr-only">Sort Kanban board</span>
            <select value={effectiveKanbanSort} disabled={interactionBlocked} onChange={(event) => selectKanbanSort(event.target.value as KanbanSortMode)}>
              <option value="board">Board order</option>
              {canPrioritize && hasAuthorizedBoardMap && <option value="priority">Priority</option>}
              <option value="shootDate-asc">Shoot date ↑</option>
              <option value="shootDate-desc">Shoot date ↓</option>
            </select>
          </label>
        )}
        </>}
      </div>

      {boardUnavailableMessage && !viewingArchived && !isCalendarView && <div className="muted" role="status" style={{ marginBottom: 16 }}>{boardUnavailableMessage}</div>}

      {isCalendarView && (
        <Suspense fallback={<div className="empty qc-calendar-state" role="status">Loading calendar…</div>}>
          <ProductionCalendar
            identity={identity}
            calendar={calendarState}
            onNavigate={(next) => navigateCalendar(next)}
            onAppliedFilters={reconcileAppliedCalendarFilters}
            onAcceptGateChange={setCalendarInteractionBlocked}
            onSettleStateChange={setCalendarSettle}
            onAccessLoss={handleCalendarAccessLoss}
            projectHrefFor={projectHrefFor}
            onOpenProject={openCalendarProject}
            onProjectAnchorClick={rememberQuickDetailOrigin}
          />
        </Suspense>
      )}

      {!isCalendarView && isLoading && <div className="empty" role="status"><span className="serif">Loading {viewingArchived ? "archived " : ""}projects.</span>Preparing the production desk.</div>}

      {!isCalendarView && !isLoading && error && (
        <div className="empty" role="alert">
          <span className="serif">{viewingArchived ? "Archived projects" : "Projects"} are unavailable.</span>
          {error}
          <div style={{ marginTop: 16 }}><button className="button button--secondary" type="button" onClick={() => void projectsQuery.refetch()}>Try again</button></div>
        </div>
      )}

      {!isCalendarView && !isLoading && !error && filteredProjects.length === 0 && (
        <div className="empty">
          <span className="serif">{query ? "Nothing here yet." : viewingArchived ? "No archived projects." : "No shoots yet — create the first one."}</span>
          {query ? "No projects match this search." : viewingArchived ? "Archived projects remain here until they are restored or permanently deleted." : "Start the production desk with the property, client, and team details."}
          {!query && !viewingArchived && canCreateProject && <div style={{ marginTop: 16 }}><InternalLink className="button" to="/projects/new">New shoot</InternalLink></div>}
        </div>
      )}

      {!isCalendarView && !isLoading && !error && filteredProjects.length > 0 && (viewingArchived || view === "list") && (
        <div className="plist" aria-label="Projects list">
          <div className="prow head"><div /><div>Address</div><div className="prow__c-agency">Client</div><div className="prow__c-date">Shoot date</div><div className="prow__c-status">Status</div><div className="prow__raw">RAW received</div></div>
          {filteredProjects.map((project) => <ProjectListRow key={project.id} project={project} projectHref={projectHrefFor(project.id)} onProjectAnchorClick={rememberQuickDetailOrigin} />)}
        </div>
      )}

      {!isCalendarView && !isLoading && !error && !viewingArchived && filteredProjects.length > 0 && view === "kanban" && (
        <ProjectKanbanBoard
          projects={filteredProjects}
          activeStages={activeStages}
          canMoveStages={canMoveStages}
          canPrioritize={canPrioritize && hasAuthorizedBoardMap}
          role={role}
          boardMutationEnabled={boardMutationEnabled}
          movementDisabled={movementSettlePending || !boardMutationEnabled}
          sameStageReorderEnabled={boardMutationEnabled && canPrioritize && hasAuthorizedBoardMap && effectiveKanbanSort === "board"}
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
          onProjectAnchorClick={rememberQuickDetailOrigin}
        />
      )}
      <div className="dashboard-live-region sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
      <div className="toasts" aria-live="polite">{toasts.map((item) => <div className={`toast ${item.tone === "error" ? "toast--error" : ""}`} key={item.id}>{item.tone === "error" ? "!" : "✓"}<span>{item.message}</span></div>)}</div>
      {routeDetail && !suppressQuickDetail && <ProjectQuickDetailSheet
        projectId={routeDetail.projectId}
        title={projects.find((project) => project.id === routeDetail.projectId)?.street ?? "Project detail"}
        activeView={routeDetail.view}
        onViewChange={changeQuickDetailView}
        onRequestClose={closeQuickDetail}
        role={role}
        workspaceHref={`/projects/${encodeURIComponent(routeDetail.projectId)}`}
        sheetVisible={sheetVisible}
        escapeDisabled={Boolean(activeConfirm)}
        onAccessFailure={handleSheetAccessFailure}
      />}
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
