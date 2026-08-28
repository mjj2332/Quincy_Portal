import { useCallback, useContext, useMemo, useRef, useState, type DragEvent } from "react";
import { compareByStreetThenId, formatSydneyCivil, isDeadlineOverdue, type MoveProjectStageRequest, type StageKey, type StageMoveConfirmationReason } from "@quincy/shared";
import { QueryClient, QueryClientContext, QueryClientProvider } from "@tanstack/react-query";
import { StatusBadge } from "../components/atoms";
import { LazyImage } from "../components/LazyImage";
import { ApiError, apiPost } from "../lib/api";
import { confirm } from "../lib/confirm";
import { useCapabilities } from "../lib/capabilities";
import { type ProjectStageKey, useStages } from "../lib/stages";
import { formatDashboardDate, initializeDashboardView, initializeKanbanSortMode, isCanonicalShootDate, type DashboardView, type KanbanSortMode } from "./dashboard-helpers";
import { InternalLink } from "../components/InternalLink";
import { NoticeBoard } from "../components/NoticeBoard";
import { invalidateProjectResources, useOptionalProjectQueryClient } from "../lib/project-data";
import { dashboardProjectsKey, useDashboardProjects } from "../lib/dashboard-projects";

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
  boardPosition?: number;
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
  if (sort !== "board") return sortKanbanProjectsByShootDate(projects, sort);
  const hasAuthorizedMap = projects.some((project) => project.boardMapPresent === true || project.boardRank !== undefined);
  if (hasAuthorizedMap) {
    return [...projects].sort((left, right) =>
      (left.boardRank === undefined ? Number.POSITIVE_INFINITY : left.boardRank)
      - (right.boardRank === undefined ? Number.POSITIVE_INFINITY : right.boardRank)
      || left.id.localeCompare(right.id));
  }
  return [...projects].sort((left, right) =>
    (left.priority === null ? 1 : 0) - (right.priority === null ? 1 : 0)
    || (left.boardPosition ?? 0) - (right.boardPosition ?? 0)
    || left.id.localeCompare(right.id));
}

type ProjectScope = "active" | "archived";
type Toast = { id: number; message: string; tone: "success" | "error" };

function CoverMedia({ project, className = "", inlinePlaceholder = false, retryToken, onFailedChange }: { project: ProjectSummary; className?: string; inlinePlaceholder?: boolean; retryToken?: number; onFailedChange?: (failed: boolean) => void }) {
  if (project.coverAssetId) return <LazyImage className={className} preload="background" assetId={project.coverAssetId} alt={`Preview of ${project.street}`} retryToken={retryToken} onFailedChange={onFailedChange} />;
  const content = project.street.trim().charAt(0).toUpperCase() || "Q";
  return inlinePlaceholder ? <span className={`project-cover-placeholder ${className}`} aria-hidden="true">{content}</span> : <div className={`project-cover-placeholder ${className}`} aria-hidden="true">{content}</div>;
}

function location(project: ProjectSummary) { return [project.suburb, project.postcode].filter(Boolean).join(" · ") || "Location pending"; }

export function KanbanCard({ project, canMove, isDragging, onDragStart, onDragEnd, initialCoverFailed = false, canPrioritize = false, canReorder = false, onPriorityChange, onBoardPosition }: {
  project: ProjectSummary;
  canMove: boolean;
  isDragging: boolean;
  onDragStart: (project: ProjectSummary, event: DragEvent<HTMLAnchorElement>) => void;
  onDragEnd: () => void;
  canPrioritize?: boolean;
  canReorder?: boolean;
  onPriorityChange?: (project: ProjectSummary, priority: number | null) => void;
  onBoardPosition?: (project: ProjectSummary, direction: "up" | "down") => void;
  /** Used by the Node markup test; normal cards begin with their cover available. */
  initialCoverFailed?: boolean;
}) {
  const overdue = isDeadlineOverdue(project.deadlineAt);
  const deadlineLabel = project.deadlineAt === null ? null : (project.deadlineLocalCivil ?? formatSydneyCivil(project.deadlineAt)).replace("T", " ");
  const [coverFailed, setCoverFailed] = useState(initialCoverFailed); const [coverRetry, setCoverRetry] = useState(0);
  const suppressNavigation = useRef(false);
  return <div className={`kcard-wrap ${isDragging ? "is-dragging" : ""}`}>
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
  const [dropStage, setDropStage] = useState<StageKey>();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const viewingArchived = projectScope === "archived";
  const identity = { principalId: currentUserId, role, authorizationEpoch } as const;
  const projectsQuery = useDashboardProjects(viewingArchived, identity);
  const projects = projectsQuery.data ?? [];
  const boardContractEnabled = projects.some((project) => project.boardContractEnabled === true);
  const canMoveStages = boardContractEnabled && canMoveStagesCapability;
  const isLoading = projectsQuery.isPending && !projectsQuery.data;
  const error = projectsQuery.error instanceof Error ? projectsQuery.error.message : projectsQuery.error ? "Projects could not be loaded." : undefined;
  const dashboardKey = dashboardProjectsKey(currentUserId, role, authorizationEpoch, viewingArchived);
  const updateProjects = useCallback((update: (current: ProjectSummary[]) => ProjectSummary[]) => {
    queryClient?.setQueryData<ProjectSummary[]>(dashboardKey, (current) => update(current ?? []));
  }, [dashboardKey, queryClient]);

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
    setKanbanSort(next);
    try { window.localStorage.setItem("quincy:dashboard:kanbanSort", next); } catch { /* Storage can be disabled by the browser. */ }
  }

  function beginDrag(project: ProjectSummary, event: DragEvent<HTMLAnchorElement>) {
    if (!canMoveStages || pendingMoves.has(project.id)) return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", project.id);
    setDragging(project);
  }

  async function moveProject(stageKey: StageKey) {
    const project = dragging;
    setDragging(undefined);
    setDropStage(undefined);
    if (!project) return;
    setPendingMoves((current) => new Set(current).add(project.id));
    const transportStageKey = role === "admin" || stageKey !== "editing_autohdr" ? stageKey : "editing";
    const request: MoveProjectStageRequest = {
      expected: { stageKey: project.stageKey, boardRevision: project.boardRevision },
      targetStageKey: transportStageKey,
      placement: { kind: "append" },
    };
    const submitStageMove = async (body: MoveProjectStageRequest) => {
      try {
        return await apiPost<{ changed: boolean; project: { stageKey: ProjectStageKey; boardRevision: number } }, MoveProjectStageRequest>(`/api/projects/${project.id}/stage`, body);
      } catch (reason) {
        if (!(reason instanceof ApiError) || reason.status !== 409 || !reason.details || typeof reason.details !== "object" || (reason.details as { code?: unknown }).code !== "stage_confirmation_required") throw reason;
        const details = reason.details as { requiredConfirmation?: { reasons?: StageMoveConfirmationReason[] } };
        const reasons = details.requiredConfirmation?.reasons ?? [];
        const reasonCopy: Record<StageMoveConfirmationReason, string> = {
          backward: "moves backward",
          skipped_forward: "skips production steps",
          delivered_boundary: "crosses the Delivered boundary",
          editing_boundary: "crosses the Editing boundary",
        };
        const explanation = reasons.map((item) => reasonCopy[item]).filter(Boolean);
        const accepted = await confirm({
          title: "Confirm Stage move",
          message: `This move ${explanation.length ? explanation.join(", ") : "changes the project Stage"}. Continue?`,
          confirmLabel: "Move project",
        });
        if (!accepted) {
          void projectsQuery.refetch();
          return null;
        }
        return apiPost<{ changed: boolean; project: { stageKey: ProjectStageKey; boardRevision: number } }, MoveProjectStageRequest>(`/api/projects/${project.id}/stage`, { ...body, confirmation: { reasons } });
      }
    };
    try {
      // Confirmation is a server round trip: the server owns the cumulative reasons and the
      // retry reuses the same expected revision and placement.
      const response = await submitStageMove(request);
      if (!response) return;
      const label = stages.find((stage) => stage.key === stageKey)?.label ?? stageKey;
      updateProjects((current) => current.map((item) => item.id === project.id ? { ...item, stageKey: response.project.stageKey, boardRevision: response.project.boardRevision } : item));
      void projectsQuery.refetch();
      if (queryClient) await invalidateProjectResources(queryClient, { projectId: project.id, resources: [{ kind: "detail" }] });
      toast(`Moved to ${label}.`);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409 && reason.details && typeof reason.details === "object" && (reason.details as { code?: unknown }).code === "project_stage_conflict") {
        const current = (reason.details as { current?: { stageKey: ProjectStageKey; boardRevision: number } | null }).current;
        if (current) updateProjects((items) => items.map((item) => item.id === project.id ? { ...item, stageKey: current.stageKey, boardRevision: current.boardRevision } : item));
        void projectsQuery.refetch();
      }
      if (reason instanceof ApiError && reason.status === 403 && reason.details && typeof reason.details === "object" && (reason.details as { code?: unknown }).code === "project_board_reorder_forbidden") {
        toast("Manual Board reorder requires Priority access.", "error");
      } else {
        toast(reason instanceof Error ? reason.message : "The stage could not be updated.", "error");
      }
    } finally {
      setPendingMoves((current) => { const next = new Set(current); next.delete(project.id); return next; });
    }
  }

  async function setProjectPriority(project: ProjectSummary, priority: number | null) {
    if (pendingOrdering.has(project.id)) return;
    updateProjects((current) => current.map((item) => item.id === project.id ? { ...item, priority } : item));
    setPendingOrdering((current) => new Set(current).add(project.id));
    try {
      const response = await apiPost<{ priority: number | null; boardRevision: number }, { priority: number | null }>(`/api/projects/${project.id}/priority`, { priority });
      updateProjects((current) => current.map((item) => item.id === project.id ? { ...item, priority: response.priority, boardRevision: response.boardRevision } : item));
      void projectsQuery.refetch();
    } catch (reason) {
      updateProjects((current) => current.map((item) => item.id === project.id && item.priority === priority ? { ...item, priority: project.priority } : item));
      void projectsQuery.refetch();
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
      void projectsQuery.refetch();
    } catch (reason) {
      void projectsQuery.refetch();
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
            <select value={kanbanSort} onChange={(event) => selectKanbanSort(event.target.value as KanbanSortMode)}>
              <option value="board">Board order</option>
              <option value="shootDate-asc">Shoot date ↑</option>
              <option value="shootDate-desc">Shoot date ↓</option>
            </select>
          </label>
        )}
        </>}
      </div>

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
            const stageProjects = sortKanbanProjects(filteredProjects.filter((project) => project.stageKey === stage.key), kanbanSort);
            const stageKey = stage.key === "editing" ? "editing_autohdr" : stage.key;
            const draggingStageKey = dragging?.stageKey === "editing" ? "editing_autohdr" : dragging?.stageKey;
            const isSameStageDrop = dragging !== undefined && draggingStageKey === stageKey;
            const canDropStage = dragging !== undefined && (isSameStageDrop ? boardContractEnabled && canPrioritize : canMoveStages);
            const isDropTarget = canDropStage && dropStage === stageKey;
            return <section className={`kcol ${isDropTarget ? "is-over" : ""}`} key={stage.key} onDragOver={(event) => { if (canDropStage && dragging) { event.preventDefault(); setDropStage(stageKey); } }} onDragLeave={() => { if (dropStage === stageKey) setDropStage(undefined); }} onDrop={(event) => { event.preventDefault(); if (canDropStage) void moveProject(stageKey); }}>
              <div className="kcol__head"><span className="row gap2"><StatusBadge stageKey={stage.key} /></span><span className="cnt">{stageProjects.length}</span></div>
              <div className="kcol__body">
                {stageProjects.length === 0 && <div className="kcol__empty">—</div>}
                {stageProjects.map((project) => <KanbanCard key={project.id} project={project} canMove={canMoveStages && !pendingMoves.has(project.id)} canPrioritize={boardContractEnabled && canPrioritize && !pendingOrdering.has(project.id)} canReorder={boardContractEnabled && canPrioritize && kanbanSort === "board" && !pendingOrdering.has(project.id)} isDragging={dragging?.id === project.id} onPriorityChange={setProjectPriority} onBoardPosition={moveProjectPosition} onDragStart={beginDrag} onDragEnd={() => { setDragging(undefined); setDropStage(undefined); }} />)}
              </div>
            </section>;
          })}
        </div>
      )}
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
