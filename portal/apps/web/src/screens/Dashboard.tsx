import { lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { formatSydneyCivil, roleHasCapability, type DashboardCalendarState, type DashboardRoute, type MoveProjectStageRequest, type MoveProjectStageResponse, type ProductionCalendarFilters, type StageKey } from "@quincy/shared";
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
import { Button, buttonClasses } from "../components/quincy/Button";
import { Eyebrow } from "../components/quincy/Eyebrow";
import { Select, type SelectOption } from "../components/quincy/Select";
import { SEGMENT_GROUP, SEGMENT_BUTTON } from "../components/quincy/segment";
import { Skeleton } from "../components/reui/skeleton";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/reui/input-group";
import { EmptyState } from "../components/quincy/EmptyState";
import { Notice } from "../components/quincy/Notice";
import { cn } from "../lib/utils";
import { CALENDAR_STATE_BOX } from "../components/production-calendar-classes";
import { invalidateProjectSurfaces, useOptionalProjectQueryClient } from "../lib/project-data";
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
  type BoardInteractionState,
  type BoardModel,
  type FocusDescriptor,
  type ProjectSummary,
  type SemanticGap,
} from "../lib/kanban-interaction";
import { ProjectKanbanBoard } from "../components/ProjectKanbanBoard";
import { ProjectKanbanBoard2 } from "../components/kanban2/board";
// Code-split: FullCalendar + its deps (~84 kB gzip) load only when a capable
// principal opens the Calendar view, never on the sign-in screen or a
// Photographer dashboard.
const ProductionCalendar = lazy(() => import("../components/ProductionCalendar").then((module) => ({ default: module.ProductionCalendar })));
import { locationStore, parseStaffLocation, staffPathFor } from "../lib/router";
import type { CalendarSettleState } from "../lib/production-calendar-interaction";

export { adjacentBoardGap, adjacentBoardPlacement, cardDropPlacement, sortKanbanProjects } from "../lib/kanban-interaction";
export type { ProjectSummary } from "../lib/kanban-interaction";
export { KanbanCard } from "../components/ProjectKanbanBoard";

type ProjectScope = "active" | "archived";
type Toast = { id: number; message: string; tone: "success" | "error" };
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

type DashboardViewRoute = Extract<DashboardRouteArm, { dashboardView: "list" | "kanban" | "kanban2" }>;
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
        history.replace(staffPathFor({ kind: "dashboard", calendar: calendarState }));
      }
      calendarFallbackLocationRef.current = false;
      return;
    }
    // Genuinely bare "/" with no calendar involvement: restore the fixed per-document snapshot
    // rather than leaving `view` at whatever an earlier explicit push left it — this is what
    // makes Back actually undo an explicit List/Kanban switch (D2 gave each one its own history
    // entry), not just the pre-existing "leaving Calendar via a stale bare arrival" case.
    if (view !== bareRouteFallbackViewRef.current) setView(bareRouteFallbackViewRef.current);
  }, [calendarState, canViewProductionCalendar, effectiveRouteCalendar, history, locationHasCalendar, routeDashboardView, view, viewingArchived]);

  const navigateCalendar = useCallback((next: DashboardCalendarState, replace = false) => {
    if (!canViewProductionCalendar || viewingArchived || calendarInteractionBlocked) return;
    const built = staffPathFor({ kind: "dashboard", calendar: next });
    setCalendarState(next);
    try {
      calendarStorage.write(DASHBOARD_CALENDAR_SUBVIEW_KEY, next.subview);
      calendarStorage.write(DASHBOARD_CALENDAR_LAST_DATE_KEY, next.date);
    } catch { /* Calendar fallback storage is best effort. */ }
    if (replace) history.replace(built); else history.push(built);
  }, [calendarInteractionBlocked, canViewProductionCalendar, history, viewingArchived]);

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
    const built = staffPathFor({ kind: "dashboard", calendar: next });
    setCalendarState(next);
    history.replace(built);
  }, [calendarInteractionBlocked, calendarState, canViewProductionCalendar, history, viewingArchived]);

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
    if (view === "calendar" || routeCalendar !== null || locationHasCalendar) history.push("/");
    window.setTimeout(() => document.querySelector<HTMLElement>('[data-focus-key="dashboard-view-list"]')?.focus(), 0);
  }, [history, locationHasCalendar, routeCalendar, view]);

  const projectHrefFor = useCallback((projectId: string) => `/projects/${encodeURIComponent(projectId)}`, []);

  const openCalendarProject = useCallback((projectId: string) => {
    if (calendarInteractionBlocked || calendarSettle.pending || !canViewProductionCalendar || viewingArchived) return;
    history.push(projectHrefFor(projectId));
  }, [calendarInteractionBlocked, calendarSettle.pending, canViewProductionCalendar, history, projectHrefFor, viewingArchived]);

  // `kanban2` (#80) is reached only by a route arrival — see the `routeDashboardView` effect
  // above — never through this segmented control, so it is deliberately excluded here.
  function selectView(next: Exclude<DashboardView, "kanban2">) {
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
    <main className="page [overflow-x:clip]">
      <div className="flex flex-wrap items-end justify-between gap-x-[var(--space-6)] gap-y-[var(--space-5)] pb-[var(--space-4)]">
        <div>
          <Eyebrow className="mb-[var(--space-3)]">Quincy Portal · production desk</Eyebrow>
          <h1 className="[font:var(--type-h1)] tracking-[var(--tracking-tight)] max-[721px]:[font:var(--type-h2)]">Projects</h1>
        </div>
        <hr className="basis-full m-0 mb-[var(--space-6)] border-0 [border-top-style:solid] border-t-[length:var(--border-width-rule)] border-t-primary max-[721px]:mb-[var(--space-5)]" />
      </div>

      {canViewNoticeBoard && <NoticeBoard currentUserId={currentUserId} />}

      {!viewingArchived && <section aria-label="Project summary" className="[display:grid] grid-cols-4 [border-block-style:solid] border-y-[length:var(--border-width-hair)] border-y-border bg-transparent mb-[var(--space-6)] max-[1080px]:grid-cols-2">
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

      <div className={cn(
        "flex flex-wrap items-center gap-x-[var(--space-6)] gap-y-[var(--space-3)] " +
        "mb-[var(--space-4)] pt-[var(--space-4)] [border-top-style:solid] " +
        "border-t-[length:var(--border-width-hair)] border-t-border")}>
        <div className="flex items-center gap-[var(--space-3)] flex-wrap max-[721px]:basis-full">
          <InputGroup className="w-auto min-w-[300px] max-[721px]:basis-full max-[721px]:min-w-0">
            <InputGroupAddon>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" className="size-[15px] shrink-0"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>
            </InputGroupAddon>
            <InputGroupInput data-testid="dashboard-search-input" aria-label="Search projects" value={query} onChange={(event) => setQuery(sanitizeDashboardCalendarSearch(event.target.value))} placeholder="Search address, suburb, client…" />
          </InputGroup>
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

      {boardUnavailableMessage && !viewingArchived && !isCalendarView && (
        <Notice tone="caution" role="status" data-testid="board-unavailable-notice" className="flex items-baseline gap-[var(--space-3)] mb-[var(--space-4)] px-[var(--space-4)] py-[var(--space-3)] before:content-['Board'] before:shrink-0 before:[font:var(--type-eyebrow)] before:uppercase before:tracking-[var(--tracking-widest)] before:text-signal-caution-text text-foreground">{boardUnavailableMessage}</Notice>
      )}

      {isCalendarView && (
        <Suspense fallback={<div className={cn("empty", CALENDAR_STATE_BOX)} role="status">Loading calendar…</div>}>
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

      {!isCalendarView && !isLoading && !error && filteredProjects.length === 0 && (
        <EmptyState title={query ? "Nothing here yet." : viewingArchived ? "No archived projects." : "No shoots yet — create the first one."} className="max-[721px]:px-[var(--space-4)] max-[721px]:py-[var(--space-7)] [&>strong]:max-w-[34ch] [&>strong]:mx-auto">
          {query ? "No projects match this search." : viewingArchived ? "Archived projects remain here until they are restored or permanently deleted." : "Start the production desk with the property, client, and team details."}
          {!query && !viewingArchived && canCreateProject && <div><InternalLink className={buttonClasses("primary", { className: "mt-[var(--space-4)]" })} to="/projects/new">New shoot</InternalLink></div>}
        </EmptyState>
      )}

      {!isCalendarView && !isLoading && !error && filteredProjects.length > 0 && (viewingArchived || view === "list") && (
        <div className="border-solid border-[length:var(--border-width-hair)] border-border bg-card" aria-label="Projects list">
          <div className={cn(PROW_GRID, "bg-secondary cursor-default")}>
            <div />
            <div className="[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-widest)] text-foreground-secondary">Address</div>
            <div className="[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-widest)] text-foreground-secondary max-[721px]:hidden">Client</div>
            <div className="[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-widest)] text-foreground-secondary max-[721px]:hidden">Shoot date</div>
            <div className="[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-widest)] text-foreground-secondary max-[721px]:hidden">Status</div>
            <div className="[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-widest)] text-foreground-secondary text-right">RAW received</div>
          </div>
          {filteredProjects.map((project) => <ProjectListRow key={project.id} project={project} projectHref={projectHrefFor(project.id)} />)}
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
        />
      )}

      {/* #80: the second Board (ReUI kanban-board-3), reachable only at ?view=kanban2 for
          comparison against real studio data before cutover (#76). Same props as the Board
          above, verbatim, so the Dashboard's priority and stage coordinators are unchanged. */}
      {!isCalendarView && !isLoading && !error && !viewingArchived && filteredProjects.length > 0 && view === "kanban2" && (
        <ProjectKanbanBoard2
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
        />
      )}
      <div className="sr-only" data-testid="dashboard-live-region" aria-live="polite" aria-atomic="true">{announcement}</div>
      <div
        aria-live="polite"
        className="fixed z-[95] flex flex-col items-end gap-[var(--space-3)] pointer-events-none right-[max(var(--space-5),env(safe-area-inset-right))] bottom-[max(var(--space-5),env(safe-area-inset-bottom))] left-[max(var(--space-5),env(safe-area-inset-left))]"
      >
        {toasts.map((item) => (
          <div
            key={item.id}
            className={cn(
              "flex items-center gap-[var(--space-3)] bg-surface-inverse text-on-inverse px-[var(--space-5)] py-[var(--space-3)] rounded-[var(--radius-sm)] shadow-[var(--shadow-md)] text-[length:var(--text-sm)] leading-[var(--leading-normal)] motion-safe:animate-[slidein_var(--dur-base)_var(--ease-entrance)] pointer-events-auto max-w-[min(380px,100%)]",
              item.tone === "error" && "bg-destructive",
            )}
          >
            <span aria-hidden="true" className="shrink-0 inline-grid place-items-center size-[var(--space-4)] [font:var(--weight-regular)_var(--text-xs)/1.4_var(--font-mono)]">{item.tone === "error" ? "!" : "✓"}</span>
            <span>{item.message}</span>
          </div>
        ))}
      </div>
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
