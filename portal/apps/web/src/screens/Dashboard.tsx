import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { compareByStreetThenId, formatSydneyCivil, isDeadlineOverdue, type ExpectedBoardProject, type MoveProjectStageRequest, type StageMovePlacement } from "@quincy/shared";
import { QueryClient, QueryClientContext, QueryClientProvider } from "@tanstack/react-query";
import { StatusBadge } from "../components/atoms";
import { LazyImage } from "../components/LazyImage";
import { ApiError, apiPost } from "../lib/api";
import { confirmStore } from "../lib/confirm";
import { useCapabilities } from "../lib/capabilities";
import { type ProjectStageKey, useStages } from "../lib/stages";
import { formatDashboardDate, initializeDashboardView, initializeKanbanSortMode, isCanonicalShootDate, type DashboardView, type KanbanSortMode } from "./dashboard-helpers";
import { InternalLink } from "../components/InternalLink";
import { NoticeBoard } from "../components/NoticeBoard";
import { invalidateProjectResources, useOptionalProjectQueryClient } from "../lib/project-data";
import { getProjectQueryRuntime } from "../lib/project-query-sync";
import { dashboardProjectsKey, useDashboardProjects } from "../lib/dashboard-projects";
import { submitStageMoveWithConfirmation } from "../lib/stage-move";

export interface ProjectSummary {
  id: string;
  street: string;
  suburb: string | null;
  postcode: string | null;
  agencyName: string | null;
  agentName: string | null;
  stageKey: ProjectStageKey;
  shootDate: string | null;
  coverAssetId: string | null;
  receivedCount: number;
  expectedCount: number | null;
  priority: number | null;
  /** Legacy wire field retained for compatibility; Board rendering never reads it. */
  boardPosition?: number;
  /** The one authorized board projection carried through the web adapter for interactions. */
  authorizedBoardOrder?: Record<string, string[]>;
  /** Private, non-wire rendering rank derived from the authorized Board ID map. */
  boardRank?: number;
  /** Private marker: Board ordering is authoritative even when this card's ID is absent. */
  boardMapPresent?: boolean;
  boardContractEnabled?: boolean;
  boardRevision: number;
  deadlineAt: number | null;
  deadlineLocalCivil: string | null;
  deadlineZone: "Australia/Sydney" | null;
}

function sortKanbanProjectsByShootDate(projects: ProjectSummary[], mode: "shootDate-asc" | "shootDate-desc"): ProjectSummary[] {
  const direction = mode === "shootDate-asc" ? 1 : -1;
  return [...projects].sort((left, right) => {
    const leftDate = isCanonicalShootDate(left.shootDate) ? left.shootDate : null;
    const rightDate = isCanonicalShootDate(right.shootDate) ? right.shootDate : null;
    if (leftDate === null || rightDate === null) {
      if (leftDate === rightDate) return compareByStreetThenId(left, right); // both null or both non-canonical
      return leftDate === null ? 1 : -1; // no usable date sorts last, either direction
    }
    if (leftDate !== rightDate) return direction * (leftDate < rightDate ? -1 : 1);
    return compareByStreetThenId(left, right);
  });
}

export function sortKanbanProjects(projects: ProjectSummary[], sort: KanbanSortMode = "board"): ProjectSummary[] {
  const boardRank = (project: ProjectSummary) => {
    const order = project.authorizedBoardOrder?.[project.stageKey];
    if (order !== undefined) {
      const rank = order.indexOf(project.id);
      return rank < 0 ? Number.POSITIVE_INFINITY : rank;
    }
    return project.boardRank ?? Number.POSITIVE_INFINITY;
  };
  if (sort === "priority") return [...projects].sort((left, right) =>
    (left.priority === null ? 1 : 0) - (right.priority === null ? 1 : 0)
    || (left.priority ?? 0) - (right.priority ?? 0)
    || boardRank(left) - boardRank(right)
    || left.id.localeCompare(right.id));
  if (sort !== "board") return sortKanbanProjectsByShootDate(projects, sort);
  const hasAuthorizedMap = projects.some((project) => project.boardMapPresent === true || project.boardRank !== undefined || project.authorizedBoardOrder?.[project.stageKey] !== undefined);
  if (hasAuthorizedMap) {
    return [...projects].sort((left, right) =>
      boardRank(left) - boardRank(right)
      || left.id.localeCompare(right.id));
  }
  // Pre-contract servers do not provide a board map. Their list order is the only
  // authoritative order available; never infer render order from the private position field.
  return [...projects];
}

function projectById(projects: ProjectSummary[]) {
  return new Map(projects.map((project) => [project.id, project]));
}

function authorizedOrderForStage(projects: ProjectSummary[], stageKey: string) {
  return projects.find((project) => project.authorizedBoardOrder?.[stageKey] !== undefined)?.authorizedBoardOrder?.[stageKey];
}

function expectedNeighbour(projectId: string, projects: Map<string, ProjectSummary>): ExpectedBoardProject | null {
  const project = projects.get(projectId);
  return project ? { projectId, boardRevision: project.boardRevision } : null;
}

/** Build the exact visible neighbour tuple from the authorized map, never from boardPosition. */
export function cardDropPlacement(
  movingProjectId: string,
  targetProjectId: string,
  targetStageKey: string,
  edge: "before" | "after",
  projects: ProjectSummary[],
): StageMovePlacement | null {
  const order = authorizedOrderForStage(projects, targetStageKey);
  if (!order) return null;
  const withoutMoving = order.filter((projectId) => projectId !== movingProjectId);
  const targetIndex = withoutMoving.indexOf(targetProjectId);
  if (targetIndex < 0) return null;
  const insertionIndex = edge === "before" ? targetIndex : targetIndex + 1;
  if (insertionIndex >= withoutMoving.length) return { kind: "append" };
  const byId = projectById(projects);
  const before = insertionIndex > 0 ? expectedNeighbour(withoutMoving[insertionIndex - 1]!, byId) : null;
  const after = expectedNeighbour(withoutMoving[insertionIndex]!, byId);
  if (insertionIndex > 0 && !before) return null;
  if (!after) return null;
  return { kind: "between", before, after };
}

export function cardDropDirection(
  movingProjectId: string,
  targetProjectId: string,
  targetStageKey: string,
  edge: "before" | "after",
  projects: ProjectSummary[],
): "up" | "down" | null {
  const order = authorizedOrderForStage(projects, targetStageKey);
  if (!order || movingProjectId === targetProjectId) return null;
  const movingIndex = order.indexOf(movingProjectId);
  const withoutMoving = order.filter((projectId) => projectId !== movingProjectId);
  const targetIndex = withoutMoving.indexOf(targetProjectId);
  if (movingIndex < 0 || targetIndex < 0) return null;
  const currentIndex = withoutMoving.slice(0, movingIndex).length;
  const desiredIndex = edge === "before" ? targetIndex : targetIndex + 1;
  if (desiredIndex === currentIndex) return null;
  return desiredIndex < currentIndex ? "up" : "down";
}

type ProjectScope = "active" | "archived";
type Toast = { id: number; message: string; tone: "success" | "error" };
const noRuntimeSubscribe = () => () => undefined;
const zeroRuntimeSnapshot = () => 0;

function CoverMedia({ project, className = "", inlinePlaceholder = false, retryToken, onFailedChange }: { project: ProjectSummary; className?: string; inlinePlaceholder?: boolean; retryToken?: number; onFailedChange?: (failed: boolean) => void }) {
  if (project.coverAssetId) return <LazyImage className={className} preload="background" assetId={project.coverAssetId} alt={`Preview of ${project.street}`} retryToken={retryToken} onFailedChange={onFailedChange} />;
  const content = project.street.trim().charAt(0).toUpperCase() || "Q";
  return inlinePlaceholder ? <span className={`project-cover-placeholder ${className}`} aria-hidden="true">{content}</span> : <div className={`project-cover-placeholder ${className}`} aria-hidden="true">{content}</div>;
}

function location(project: ProjectSummary) { return [project.suburb, project.postcode].filter(Boolean).join(" · ") || "Location pending"; }

export function KanbanCard({ project, canMove, isDragging, onDragStart, onDragEnd, initialCoverFailed = false, canPrioritize = false, canReorder = false, onPriorityChange, onBoardPosition, stageOptions, onMoveStage, onCardDragOver, onCardDrop, cardDropEdge }: {
  project: ProjectSummary;
  canMove: boolean;
  isDragging: boolean;
  onDragStart: (project: ProjectSummary, event: DragEvent<HTMLAnchorElement>) => void;
  onDragEnd: () => void;
  canPrioritize?: boolean;
  canReorder?: boolean;
  onPriorityChange?: (project: ProjectSummary, priority: number | null) => void;
  onBoardPosition?: (project: ProjectSummary, direction: "up" | "down") => void;
  stageOptions?: readonly { key: ProjectStageKey; label: string; active: boolean }[];
  onMoveStage?: (project: ProjectSummary, targetStageKey: ProjectStageKey) => void;
  onCardDragOver?: (project: ProjectSummary, event: DragEvent<HTMLDivElement>) => void;
  onCardDrop?: (project: ProjectSummary, edge: "before" | "after", event: DragEvent<HTMLDivElement>) => void;
  cardDropEdge?: "before" | "after";
  /** Used by the Node markup test; normal cards begin with their cover available. */
  initialCoverFailed?: boolean;
}) {
  const overdue = isDeadlineOverdue(project.deadlineAt);
  const deadlineLabel = project.deadlineAt === null ? null : (project.deadlineLocalCivil ?? formatSydneyCivil(project.deadlineAt)).replace("T", " ");
  const [coverFailed, setCoverFailed] = useState(initialCoverFailed); const [coverRetry, setCoverRetry] = useState(0);
  const [moveStageValue, setMoveStageValue] = useState("");
  const suppressNavigation = useRef(false);
  const moveStageOptions = (stageOptions ?? []).filter((stage) => stage.active);
  return <div className={`kcard-wrap ${isDragging ? "is-dragging" : ""}${cardDropEdge ? ` is-drop-${cardDropEdge}` : ""}`} onDragOver={onCardDragOver ? (event) => onCardDragOver(project, event) : undefined} onDrop={onCardDrop ? (event) => {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const edge = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    onCardDrop(project, edge, event);
  } : undefined}>
    <InternalLink className="kcard" to={`/projects/${encodeURIComponent(project.id)}`} draggable={canMove} onClick={(event) => { if (suppressNavigation.current) { event.preventDefault(); suppressNavigation.current = false; } }} onDragStart={(event) => onDragStart(project, event)} onDragEnd={() => { suppressNavigation.current = true; window.setTimeout(() => { suppressNavigation.current = false; }, 0); onDragEnd(); }}>
      <div className="kcard__media"><CoverMedia project={project} retryToken={coverRetry} onFailedChange={setCoverFailed} /></div>
      <div className="kcard__b">
        <div className="kcard__addr serif">{project.street}</div>
        <div className="kcard__meta">{location(project)}</div>
        <div className="kcard__meta">{project.agencyName || "Agency pending"}</div>
        <div className="kcard__foot">{deadlineLabel && <time className={overdue ? "project-deadline__overdue" : ""} dateTime={new Date(project.deadlineAt!).toISOString()}>{overdue ? "Overdue" : "Due"} {deadlineLabel} Sydney</time>}{project.priority !== null && <span className="ey">Priority {project.priority}</span>}</div>
      </div>
    </InternalLink>
    {canPrioritize && <div className="kcard-controls" aria-label={`Order controls for ${project.street}`}>
      <label className="sr-only" htmlFor={`priority-${project.id}`}>Priority</label>
      <select id={`priority-${project.id}`} value={project.priority ?? ""} aria-label="Priority" onChange={(event) => onPriorityChange?.(project, event.target.value === "" ? null : Number(event.target.value))}>
        <option value="">—</option>
        {Array.from({ length: 10 }, (_, index) => index + 1).map((value) => <option value={value} key={value}>{value}</option>)}
      </select>
      {canReorder && <>
        <button type="button" className="kcard-controls__arrow" aria-label="Move project up" onClick={() => onBoardPosition?.(project, "up")}>↑</button>
        <button type="button" className="kcard-controls__arrow" aria-label="Move project down" onClick={() => onBoardPosition?.(project, "down")}>↓</button>
      </>}
    </div>}
    {canMove && <div className="kcard-stage-control">
      <label className="sr-only" htmlFor={`move-stage-${project.id}`}>Move {project.street} to Stage</label>
      <select id={`move-stage-${project.id}`} data-focus-key={`move-stage:${project.id}`} aria-label={`Move ${project.street} to Stage`} value={moveStageValue} onChange={(event) => {
        const targetStageKey = event.target.value as ProjectStageKey;
        setMoveStageValue("");
        if (targetStageKey && targetStageKey !== project.stageKey) onMoveStage?.(project, targetStageKey);
      }}>
        <option value="">Move Stage…</option>
        {moveStageOptions.map((stage) => <option value={stage.key} key={stage.key}>{stage.label}</option>)}
      </select>
    </div>}
    {coverFailed && <button className="kcard__retry button button--secondary" type="button" onClick={() => { setCoverFailed(false); setCoverRetry((current) => current + 1); }}>Retry cover image</button>}
  </div>;
}

function ProjectListRow({ project }: { project: ProjectSummary }) {
  const [coverFailed, setCoverFailed] = useState(false); const [coverRetry, setCoverRetry] = useState(0);
  return <div className="prow-wrap">
    <InternalLink className="prow" to={`/projects/${encodeURIComponent(project.id)}`}>
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

type DashboardProps = { currentUserId: string; role?: Parameters<typeof dashboardProjectsKey>[1]; authorizationEpoch?: number };

function DashboardContent({ currentUserId, role = "photographer", authorizationEpoch = 0 }: DashboardProps) {
  const queryClient = useOptionalProjectQueryClient();
  const { can } = useCapabilities();
  const { stages } = useStages();
  const canCreateProject = can("createProject");
  const canMoveStagesCapability = can("moveProjectStage");
  const canPrioritize = can("prioritizeProjects");
  const canViewArchived = can("adminBackend");
  const canViewNoticeBoard = can("viewNoticeBoard");
  const [projectScope, setProjectScope] = useState<ProjectScope>("active");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<DashboardView>(() => initializeDashboardView({
    read: () => window.localStorage.getItem("quincy:dashboard:view"),
    write: (next) => window.localStorage.setItem("quincy:dashboard:view", next),
  }));
  const [kanbanSort, setKanbanSort] = useState<KanbanSortMode>(() => initializeKanbanSortMode({
    read: () => window.localStorage.getItem("quincy:dashboard:kanbanSort"),
    write: (next) => window.localStorage.setItem("quincy:dashboard:kanbanSort", next),
  }));
  const [dragging, setDragging] = useState<ProjectSummary>();
  const [pendingMoves, setPendingMoves] = useState<Set<string>>(new Set());
  const [pendingOrdering, setPendingOrdering] = useState<Set<string>>(new Set());
  const [dropStage, setDropStage] = useState<ProjectStageKey>();
  const [dropTarget, setDropTarget] = useState<{ stageKey: ProjectStageKey; projectId: string; edge: "before" | "after" }>();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const [boardUnavailableReason, setBoardUnavailableReason] = useState<string | null>(null);
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
  const interactionBlocked = Boolean(dragging || pendingMoves.size > 0 || pendingOrdering.size > 0 || activeConfirm);
  const interactionBlockedRef = useRef(interactionBlocked);
  interactionBlockedRef.current = interactionBlocked;
  const queuedRefreshRef = useRef(false);
  const focusRestoreRef = useRef<{ key: string | null; x: number; y: number } | null>(null);
  const projects = acceptedProjects?.key === dashboardKeyString ? acceptedProjects.projects : queryProjects ?? [];
  const boardContractEnabled = projects.some((project) => project.boardContractEnabled === true);
  const hasAuthorizedBoardMap = projects.some((project) => project.boardMapPresent === true || project.boardRank !== undefined || project.authorizedBoardOrder?.[project.stageKey] !== undefined);
  const effectiveKanbanSort: KanbanSortMode = !canPrioritize && kanbanSort === "priority" ? "board" : kanbanSort;
  const boardContractDisabled = projects.some((project) => project.boardContractEnabled === false);
  const boardUnavailableMessage = boardUnavailableReason ?? (boardContractDisabled ? "Board interactions are temporarily unavailable while the Board contract is disabled." : null);
  const boardMutationEnabled = boardContractEnabled && !boardUnavailableMessage;
  const canMoveStages = boardMutationEnabled && canMoveStagesCapability;
  const isLoading = projectsQuery.isPending && !projectsQuery.data;
  const error = projectsQuery.error instanceof Error ? projectsQuery.error.message : projectsQuery.error ? "Projects could not be loaded." : undefined;
  const updateProjects = useCallback((update: (current: ProjectSummary[]) => ProjectSummary[]) => {
    queryClient?.setQueryData<ProjectSummary[]>(dashboardKey, (current) => update(current ?? []));
  }, [dashboardKey, queryClient]);

  const captureFocusForRefresh = useCallback(() => {
    if (focusRestoreRef.current) return;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusRestoreRef.current = { key: active?.getAttribute("data-focus-key") ?? null, x: window.scrollX, y: window.scrollY };
  }, []);

  const replaceAcceptedProjects = useCallback((next: ProjectSummary[]) => {
    captureFocusForRefresh();
    setAcceptedProjects({ key: dashboardKeyString, projects: next });
  }, [captureFocusForRefresh, dashboardKeyString]);

  const acceptDashboardProjects = useCallback((next: ProjectSummary[]) => {
    if (queryRuntime?.principalTerminal) return;
    const safeProjects = queryRuntime ? next.filter((project) => !queryRuntime.isProjectRemoved(project.id)) : next;
    replaceAcceptedProjects(safeProjects);
  }, [queryRuntime, replaceAcceptedProjects]);

  useLayoutEffect(() => {
    const restore = focusRestoreRef.current;
    if (!restore) return;
    focusRestoreRef.current = null;
    window.scrollTo(restore.x, restore.y);
    if (!restore.key) return;
    const target = [...document.querySelectorAll<HTMLElement>("[data-focus-key]")].find((element) => element.getAttribute("data-focus-key") === restore.key);
    target?.focus();
  }, [acceptedProjects]);

  useEffect(() => {
    if (!queryProjects || queryRuntime?.principalTerminal) return;
    if (interactionBlocked) {
      queuedRefreshRef.current = true;
      return;
    }
    if (queuedRefreshRef.current) return;
    acceptDashboardProjects(queryProjects);
  }, [acceptDashboardProjects, interactionBlocked, queryDataUpdatedAt, queryProjects, queryRuntime]);

  useEffect(() => {
    if (interactionBlocked || !queuedRefreshRef.current) return;
    queuedRefreshRef.current = false;
    void projectsQuery.refetch().then((result) => {
      if (!result.data || interactionBlockedRef.current) {
        if (interactionBlockedRef.current) queuedRefreshRef.current = true;
        return;
      }
      acceptDashboardProjects(result.data);
    });
  }, [acceptDashboardProjects, interactionBlocked, projectsQuery.refetch]);

  useEffect(() => {
    if (!queryRuntime) return;
    if (queryRuntime.principalTerminal) {
      queuedRefreshRef.current = false;
      setAcceptedProjects((current) => current?.key === dashboardKeyString && current.projects.length === 0 ? current : { key: dashboardKeyString, projects: [] });
      return;
    }
    const current = acceptedProjects?.key === dashboardKeyString ? acceptedProjects.projects : undefined;
    if (!current?.some((project) => queryRuntime.isProjectRemoved(project.id))) return;
    const filtered = current.filter((project) => !queryRuntime.isProjectRemoved(project.id));
    setAcceptedProjects((previous) => previous?.key === dashboardKeyString && previous.projects.length === filtered.length ? previous : { key: dashboardKeyString, projects: filtered });
  }, [acceptedProjects, dashboardKeyString, queryRuntime, runtimeVersion]);

  useEffect(() => {
    if (!(projectsQuery.error instanceof ApiError) || (projectsQuery.error.status !== 401 && projectsQuery.error.status !== 403)) return;
    queuedRefreshRef.current = false;
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

  function selectView(next: DashboardView) {
    setView(next);
    try { window.localStorage.setItem("quincy:dashboard:view", next); } catch { /* Storage can be disabled by the browser. */ }
  }

  function selectKanbanSort(next: KanbanSortMode) {
    if (next === "priority" && (!canPrioritize || !hasAuthorizedBoardMap)) return;
    setKanbanSort(next);
    try { window.localStorage.setItem("quincy:dashboard:kanbanSort", next); } catch { /* Storage can be disabled by the browser. */ }
  }

  function beginDrag(project: ProjectSummary, event: DragEvent<HTMLAnchorElement>) {
    if (!canMoveStages || pendingMoves.has(project.id)) return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", project.id);
    setDropTarget(undefined);
    setDragging(project);
  }

  async function moveProject(project: ProjectSummary | undefined, stageKey: ProjectStageKey, placement: StageMovePlacement = { kind: "append" }) {
    setDragging(undefined);
    setDropStage(undefined);
    setDropTarget(undefined);
    if (!project || (project.stageKey === stageKey && placement.kind === "append")) return;
    captureFocusForRefresh();
    setPendingMoves((current) => new Set(current).add(project.id));
    const request: MoveProjectStageRequest = {
      expected: { stageKey: project.stageKey, boardRevision: project.boardRevision },
      targetStageKey: stageKey,
      placement,
    };
    try {
      const response = await submitStageMoveWithConfirmation(request, (body) => apiPost<{ changed: boolean; project: { stageKey: ProjectStageKey; boardRevision: number } }, MoveProjectStageRequest>(`/api/projects/${project.id}/stage`, body));
      if (!response) {
        setAnnouncement("Stage move cancelled.");
        return;
      }
      const label = stages.find((stage) => stage.key === stageKey)?.label ?? stageKey;
      updateProjects((current) => current.map((item) => item.id === project.id ? { ...item, stageKey: response.project.stageKey, boardRevision: response.project.boardRevision } : item));
      if (queryClient) await invalidateProjectResources(queryClient, { projectId: project.id, resources: [{ kind: "detail" }] });
      setAnnouncement(`Moved ${project.street} to ${label}.`);
      toast(`Moved to ${label}.`);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409 && reason.details && typeof reason.details === "object" && (reason.details as { code?: unknown }).code === "project_stage_conflict") {
        const current = (reason.details as { current?: { stageKey: ProjectStageKey; boardRevision: number } | null }).current;
        if (current) updateProjects((items) => items.map((item) => item.id === project.id ? { ...item, stageKey: current.stageKey, boardRevision: current.boardRevision } : item));
        setAnnouncement("The project changed elsewhere. Showing the authoritative Stage.");
        toast("The project changed elsewhere; the board was refreshed.", "error");
      } else if (reason instanceof ApiError && reason.status === 403 && reason.details && typeof reason.details === "object" && (reason.details as { code?: unknown }).code === "project_board_reorder_forbidden") {
        setAnnouncement("Manual Board reorder requires Priority access.");
        toast("Manual Board reorder requires Priority access.", "error");
      } else if (reason instanceof ApiError && reason.status === 503 && reason.details && typeof reason.details === "object" && (reason.details as { code?: unknown }).code === "board_contract_disabled") {
        setBoardUnavailableReason("Board interactions are temporarily unavailable while the Board contract is disabled.");
        setAnnouncement("Board interactions are temporarily unavailable while the Board contract is disabled.");
      } else if (reason instanceof ApiError && reason.status === 503 && reason.details && typeof reason.details === "object" && (reason.details as { code?: unknown }).code === "board_schema_maintenance") {
        setBoardUnavailableReason("Board interactions are temporarily unavailable while the Board is being updated.");
        setAnnouncement("Board interactions are temporarily unavailable while the Board is being updated.");
      } else {
        setAnnouncement(reason instanceof Error ? reason.message : "The Stage could not be updated.");
        toast(reason instanceof Error ? reason.message : "The stage could not be updated.", "error");
      }
    } finally {
      queueDashboardRefresh();
      setPendingMoves((current) => { const next = new Set(current); next.delete(project.id); return next; });
    }
  }

  function canDropOnCard(target: ProjectSummary) {
    const project = dragging;
    if (!project || project.id === target.id) return false;
    if (project.stageKey !== target.stageKey) return canMoveStages;
    return boardMutationEnabled && canPrioritize && effectiveKanbanSort === "board";
  }

  function cardDragOver(target: ProjectSummary, event: DragEvent<HTMLDivElement>) {
    if (!canDropOnCard(target)) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const edge = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    setDropStage(target.stageKey);
    setDropTarget({ stageKey: target.stageKey, projectId: target.id, edge });
  }

  function cardDrop(target: ProjectSummary, edge: "before" | "after", event: DragEvent<HTMLDivElement>) {
    if (!canDropOnCard(target)) return;
    event.stopPropagation();
    const project = dragging;
    setDragging(undefined);
    setDropStage(undefined);
    setDropTarget(undefined);
    if (!project || project.id === target.id) return;
    if (project.stageKey === target.stageKey) {
      const direction = cardDropDirection(project.id, target.id, target.stageKey, edge, projects);
      if (direction) void moveProjectPosition(project, direction);
      return;
    }
    const placement = cardDropPlacement(project.id, target.id, target.stageKey, edge, projects);
    if (placement) void moveProject(project, target.stageKey, placement);
  }

  async function setProjectPriority(project: ProjectSummary, priority: number | null) {
    if (pendingOrdering.has(project.id)) return;
    updateProjects((current) => current.map((item) => item.id === project.id ? { ...item, priority } : item));
    setPendingOrdering((current) => new Set(current).add(project.id));
    try {
      const response = await apiPost<{ priority: number | null; boardRevision: number }, { priority: number | null }>(`/api/projects/${project.id}/priority`, { priority });
      updateProjects((current) => current.map((item) => item.id === project.id ? { ...item, priority: response.priority, boardRevision: response.boardRevision } : item));
      queueDashboardRefresh();
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

  async function moveProjectPosition(project: ProjectSummary, direction: "up" | "down") {
    if (pendingOrdering.has(project.id)) return;
    setPendingOrdering((current) => new Set(current).add(project.id));
    try {
      const response = await apiPost<{ project: { boardRevision: number } }, { direction: "up" | "down" }>(`/api/projects/${project.id}/board-position`, { direction });
      updateProjects((current) => current.map((item) => item.id === project.id ? { ...item, boardRevision: response.project.boardRevision } : item));
      queueDashboardRefresh();
      setAnnouncement(`Moved ${project.street} ${direction}.`);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 503 && reason.details && typeof reason.details === "object" && ((reason.details as { code?: unknown }).code === "board_contract_disabled" || (reason.details as { code?: unknown }).code === "board_schema_maintenance")) setBoardUnavailableReason("Board interactions are temporarily unavailable while the Board is being updated.");
      queueDashboardRefresh();
      setAnnouncement("The project position could not be updated.");
      toast(reason instanceof Error ? reason.message : "The project position could not be updated.", "error");
    } finally {
      setPendingOrdering((current) => { const next = new Set(current); next.delete(project.id); return next; });
    }
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
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search address, suburb, client…" />
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
            <button className={!viewingArchived ? "is-active" : ""} type="button" onClick={() => setProjectScope("active")}>Active</button>
            <button className={viewingArchived ? "is-active" : ""} type="button" onClick={() => setProjectScope("archived")}>Archived</button>
          </div>
        </>}
        {viewingArchived && <span className="ey" role="status">Archived projects</span>}
        {!viewingArchived && <>
        <span className="ey">View</span>
        <div className="segment" aria-label="Dashboard view">
          <button className={view === "list" ? "is-active" : ""} type="button" onClick={() => selectView("list")}>List</button>
          <button className={view === "kanban" ? "is-active" : ""} type="button" onClick={() => selectView("kanban")}>Kanban</button>
        </div>
        {!viewingArchived && view === "kanban" && (
          <label className="dashboard-sort">
            <span className="sr-only">Sort Kanban board</span>
            <select value={effectiveKanbanSort} onChange={(event) => selectKanbanSort(event.target.value as KanbanSortMode)}>
              <option value="board">Board order</option>
              {canPrioritize && hasAuthorizedBoardMap && <option value="priority">Priority</option>}
              <option value="shootDate-asc">Shoot date ↑</option>
              <option value="shootDate-desc">Shoot date ↓</option>
            </select>
          </label>
        )}
        </>}
      </div>

      {boardUnavailableMessage && !viewingArchived && <div className="muted" role="status" style={{ marginBottom: 16 }}>{boardUnavailableMessage}</div>}

      {isLoading && <div className="empty" role="status"><span className="serif">Loading {viewingArchived ? "archived " : ""}projects.</span>Preparing the production desk.</div>}

      {!isLoading && error && (
        <div className="empty" role="alert">
          <span className="serif">{viewingArchived ? "Archived projects" : "Projects"} are unavailable.</span>
          {error}
          <div style={{ marginTop: 16 }}><button className="button button--secondary" type="button" onClick={() => void projectsQuery.refetch()}>Try again</button></div>
        </div>
      )}

      {!isLoading && !error && filteredProjects.length === 0 && (
        <div className="empty">
          <span className="serif">{query ? "Nothing here yet." : viewingArchived ? "No archived projects." : "No shoots yet — create the first one."}</span>
          {query ? "No projects match this search." : viewingArchived ? "Archived projects remain here until they are restored or permanently deleted." : "Start the production desk with the property, client, and team details."}
          {!query && !viewingArchived && canCreateProject && <div style={{ marginTop: 16 }}><InternalLink className="button" to="/projects/new">New shoot</InternalLink></div>}
        </div>
      )}

      {!isLoading && !error && filteredProjects.length > 0 && (viewingArchived || view === "list") && (
        <div className="plist" aria-label="Projects list">
          <div className="prow head"><div /><div>Address</div><div className="prow__c-agency">Client</div><div className="prow__c-date">Shoot date</div><div className="prow__c-status">Status</div><div className="prow__raw">RAW received</div></div>
          {filteredProjects.map((project) => <ProjectListRow key={project.id} project={project} />)}
        </div>
      )}

      {!isLoading && !error && !viewingArchived && filteredProjects.length > 0 && view === "kanban" && (
        <div className="kanban" aria-label="Project pipeline board">
          {activeStages.map((stage) => {
            const stageProjects = sortKanbanProjects(filteredProjects.filter((project) => project.stageKey === stage.key), effectiveKanbanSort);
            const stageKey = stage.key;
            const isSameStageDrop = dragging !== undefined && dragging.stageKey === stageKey;
            const canDropStage = dragging !== undefined && !isSameStageDrop && canMoveStages;
            const isDropTarget = canDropStage && dropStage === stageKey;
            return <section className={`kcol ${isDropTarget ? "is-over" : ""}`} key={stage.key} onDragOver={(event) => { if (canDropStage && dragging) { event.preventDefault(); setDropStage(stageKey); } }} onDragLeave={() => { if (dropStage === stageKey) setDropStage(undefined); }} onDrop={(event) => { event.preventDefault(); if (canDropStage) void moveProject(dragging, stageKey); }}>
              <div className="kcol__head"><span className="row gap2"><StatusBadge stageKey={stage.key} /></span><span className="cnt">{stageProjects.length}</span></div>
              <div className="kcol__body">
                {stageProjects.length === 0 && <div className="kcol__empty">—</div>}
                {stageProjects.map((project) => <KanbanCard key={project.id} project={project} canMove={canMoveStages && !pendingMoves.has(project.id)} canPrioritize={boardContractEnabled && canPrioritize && !pendingOrdering.has(project.id)} canReorder={boardMutationEnabled && canPrioritize && effectiveKanbanSort === "board" && !pendingOrdering.has(project.id)} stageOptions={activeStages} onMoveStage={(item, targetStageKey) => { void moveProject(item, targetStageKey); }} isDragging={dragging?.id === project.id} cardDropEdge={dropTarget?.stageKey === stage.key && dropTarget.projectId === project.id ? dropTarget.edge : undefined} onCardDragOver={cardDragOver} onCardDrop={cardDrop} onPriorityChange={setProjectPriority} onBoardPosition={moveProjectPosition} onDragStart={beginDrag} onDragEnd={() => { setDragging(undefined); setDropStage(undefined); setDropTarget(undefined); }} />)}
              </div>
            </section>;
          })}
        </div>
      )}
      <div className="dashboard-live-region sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
      <div className="toasts" aria-live="polite">{toasts.map((item) => <div className={`toast ${item.tone === "error" ? "toast--error" : ""}`} key={item.id}>{item.tone === "error" ? "!" : "✓"}<span>{item.message}</span></div>)}</div>
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
