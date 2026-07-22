import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import { type StageKey } from "@quincy/shared";
import { StatusBadge } from "../components/atoms";
import { LazyImage } from "../components/LazyImage";
import { apiGet, apiPost } from "../lib/api";
import { useCapabilities } from "../lib/capabilities";
import { type ProjectStageKey, useStages } from "../lib/stages";
import { formatDashboardDate, initializeDashboardView, type DashboardView } from "./dashboard-helpers";

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
}

interface ProjectsResponse {
  projects: ProjectSummary[];
}

interface DashboardProps {
  onOpenProject: (projectId: string) => void;
  onCreateProject: () => void;
}

type ProjectScope = "active" | "archived";
type Toast = { id: number; message: string; tone: "success" | "error" };

function coverUrl(assetId: string): string {
  return `/media/asset/${encodeURIComponent(assetId)}/thumb`;
}

function CoverMedia({ project, className = "", inlinePlaceholder = false, retryToken, onFailedChange }: { project: ProjectSummary; className?: string; inlinePlaceholder?: boolean; retryToken?: number; onFailedChange?: (failed: boolean) => void }) {
  if (project.coverAssetId) return <LazyImage className={className} src={coverUrl(project.coverAssetId)} alt={`Preview of ${project.street}`} retryToken={retryToken} onFailedChange={onFailedChange} />;
  const content = project.street.trim().charAt(0).toUpperCase() || "Q";
  return inlinePlaceholder ? <span className={`project-cover-placeholder ${className}`} aria-hidden="true">{content}</span> : <div className={`project-cover-placeholder ${className}`} aria-hidden="true">{content}</div>;
}

function location(project: ProjectSummary) { return [project.suburb, project.postcode].filter(Boolean).join(" · ") || "Location pending"; }

function KanbanCard({ project, canMove, isDragging, onOpen, onDragStart, onDragEnd }: {
  project: ProjectSummary;
  canMove: boolean;
  isDragging: boolean;
  onOpen: (projectId: string) => void;
  onDragStart: (project: ProjectSummary, event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
}) {
  const rawCount = project.expectedCount === null ? `${project.receivedCount} RAW` : `${project.receivedCount}/${project.expectedCount} RAW`;
  const [coverFailed, setCoverFailed] = useState(false); const [coverRetry, setCoverRetry] = useState(0);
  function activate() { if (coverFailed) { setCoverFailed(false); setCoverRetry((current) => current + 1); } else onOpen(project.id); }
  return <button className={`kcard ${isDragging ? "is-dragging" : ""}`} type="button" draggable={canMove} onClick={activate} aria-label={coverFailed ? `Retry cover image for ${project.street}` : undefined} onDragStart={(event) => onDragStart(project, event)} onDragEnd={onDragEnd}>
    <div className="kcard__media"><CoverMedia project={project} retryToken={coverRetry} onFailedChange={setCoverFailed} /></div>
    <div className="kcard__b">
      <div className="kcard__addr serif">{project.street}</div>
      <div className="kcard__meta">{location(project)}</div>
      <div className="kcard__meta">{project.agencyName || "Agency pending"}</div>
      <div className="kcard__foot"><span className="ey">{rawCount}</span></div>
    </div>
  </button>;
}

function ProjectListRow({ project, onOpen }: { project: ProjectSummary; onOpen: (projectId: string) => void }) {
  const [coverFailed, setCoverFailed] = useState(false); const [coverRetry, setCoverRetry] = useState(0);
  function activate() { if (coverFailed) { setCoverFailed(false); setCoverRetry((current) => current + 1); } else onOpen(project.id); }
  return <button className="prow" type="button" onClick={activate} aria-label={coverFailed ? `Retry cover image for ${project.street}` : undefined}>
    <CoverMedia project={project} className="prow__thumb" inlinePlaceholder retryToken={coverRetry} onFailedChange={setCoverFailed} />
    <span><span className="serif prow__addr">{project.street}</span><span className="ey prow__location">{location(project)}</span></span>
    <span className="prow__c-agency">{project.agencyName || "Agency pending"}<span className="muted">{project.agentName || "Agent pending"}</span></span>
    <span className="prow__c-date">{formatDashboardDate(project.shootDate)}</span>
    <span className="prow__c-status"><StatusBadge stageKey={project.stageKey} /></span>
    <span className="prow__raw">{project.receivedCount}</span>
  </button>;
}

export function Dashboard({ onOpenProject, onCreateProject }: DashboardProps) {
  const { can } = useCapabilities();
  const { stages } = useStages();
  const canCreateProject = can("createProject");
  const canMoveStages = can("selectForEditing");
  const canViewArchived = can("adminBackend");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectScope, setProjectScope] = useState<ProjectScope>("active");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<DashboardView>(() => initializeDashboardView({
    read: () => window.localStorage.getItem("quincy:dashboard:view"),
    write: (next) => window.localStorage.setItem("quincy:dashboard:view", next),
  }));
  const [dragging, setDragging] = useState<ProjectSummary>();
  const [pendingMoves, setPendingMoves] = useState<Set<string>>(new Set());
  const [dropStage, setDropStage] = useState<StageKey>();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [error, setError] = useState<string>();
  const [isLoading, setIsLoading] = useState(true);
  const [reload, setReload] = useState(0);

  const toast = useCallback((message: string, tone: Toast["tone"] = "success") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 3600);
  }, []);

  useEffect(() => {
    let isCurrent = true;
    setIsLoading(true);
    setError(undefined);

    apiGet<ProjectsResponse>(projectScope === "archived" ? "/api/projects?archived=1" : "/api/projects")
      .then((response) => {
        if (isCurrent) setProjects(response.projects);
      })
      .catch((reason) => {
        if (isCurrent) setError(reason instanceof Error ? reason.message : "Projects could not be loaded.");
      })
      .finally(() => {
        if (isCurrent) setIsLoading(false);
      });

    return () => {
      isCurrent = false;
    };
  }, [projectScope, reload]);

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
  const viewingArchived = projectScope === "archived";

  function selectView(next: DashboardView) {
    setView(next);
    try { window.localStorage.setItem("quincy:dashboard:view", next); } catch { /* Storage can be disabled by the browser. */ }
  }

  function beginDrag(project: ProjectSummary, event: DragEvent<HTMLButtonElement>) {
    if (!canMoveStages || pendingMoves.has(project.id)) return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", project.id);
    setDragging(project);
  }

  async function moveProject(stageKey: StageKey) {
    const project = dragging;
    setDragging(undefined);
    setDropStage(undefined);
    if (!project || project.stageKey === stageKey) return;
    setProjects((current) => current.map((item) => item.id === project.id ? { ...item, stageKey } : item));
    setPendingMoves((current) => new Set(current).add(project.id));
    try {
      await apiPost<{ ok: true; stageKey: StageKey }, { stageKey: StageKey }>(`/api/projects/${project.id}/stage`, { stageKey });
      const label = stages.find((stage) => stage.key === stageKey)?.label ?? stageKey;
      toast(`Moved to ${label}.`);
    } catch (reason) {
      setProjects((current) => current.map((item) => item.id === project.id && item.stageKey === stageKey ? { ...item, stageKey: project.stageKey } : item));
      toast(reason instanceof Error ? reason.message : "The stage could not be updated.", "error");
    } finally {
      setPendingMoves((current) => { const next = new Set(current); next.delete(project.id); return next; });
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
          {canCreateProject && <button className="button" type="button" onClick={onCreateProject}>New shoot</button>}
        </div>
      </div>

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
        </>}
      </div>

      {isLoading && <div className="empty" role="status"><span className="serif">Loading {viewingArchived ? "archived " : ""}projects.</span>Preparing the production desk.</div>}

      {!isLoading && error && (
        <div className="empty" role="alert">
          <span className="serif">{viewingArchived ? "Archived projects" : "Projects"} are unavailable.</span>
          {error}
          <div style={{ marginTop: 16 }}><button className="button button--secondary" type="button" onClick={() => setReload((value) => value + 1)}>Try again</button></div>
        </div>
      )}

      {!isLoading && !error && filteredProjects.length === 0 && (
        <div className="empty">
          <span className="serif">{query ? "Nothing here yet." : viewingArchived ? "No archived projects." : "No shoots yet — create the first one."}</span>
          {query ? "No projects match this search." : viewingArchived ? "Archived projects remain here until they are restored or permanently deleted." : "Start the production desk with the property, client, and team details."}
          {!query && !viewingArchived && canCreateProject && <div style={{ marginTop: 16 }}><button className="button" type="button" onClick={onCreateProject}>New shoot</button></div>}
        </div>
      )}

      {!isLoading && !error && filteredProjects.length > 0 && (viewingArchived || view === "list") && (
        <div className="plist" aria-label="Projects list">
          <div className="prow head"><div /><div>Address</div><div className="prow__c-agency">Client</div><div className="prow__c-date">Shoot date</div><div className="prow__c-status">Status</div><div className="prow__raw">RAW received</div></div>
          {filteredProjects.map((project) => <ProjectListRow key={project.id} project={project} onOpen={onOpenProject} />)}
        </div>
      )}

      {!isLoading && !error && !viewingArchived && filteredProjects.length > 0 && view === "kanban" && (
        <div className="kanban" aria-label="Project pipeline board">
          {activeStages.map((stage) => {
            const stageProjects = filteredProjects.filter((project) => project.stageKey === stage.key);
            const stageKey = stage.key === "editing" ? "editing_autohdr" : stage.key;
            const canDropStage = canMoveStages && (canViewArchived || stage.key !== "editing");
            const isDropTarget = canDropStage && dropStage === stageKey;
            return <section className={`kcol ${isDropTarget ? "is-over" : ""}`} key={stage.key} onDragOver={(event) => { if (canDropStage && dragging) { event.preventDefault(); setDropStage(stageKey); } }} onDragLeave={() => { if (dropStage === stageKey) setDropStage(undefined); }} onDrop={(event) => { event.preventDefault(); if (canDropStage) void moveProject(stageKey); }}>
              <div className="kcol__head"><span className="row gap2"><StatusBadge stageKey={stage.key} /></span><span className="cnt">{stageProjects.length}</span></div>
              <div className="kcol__body">
                {stageProjects.length === 0 && <div className="kcol__empty">—</div>}
                {stageProjects.map((project) => <KanbanCard key={project.id} project={project} canMove={canMoveStages && !pendingMoves.has(project.id)} isDragging={dragging?.id === project.id} onOpen={onOpenProject} onDragStart={beginDrag} onDragEnd={() => { setDragging(undefined); setDropStage(undefined); }} />)}
              </div>
            </section>;
          })}
        </div>
      )}
      <div className="toasts" aria-live="polite">{toasts.map((item) => <div className={`toast ${item.tone === "error" ? "toast--error" : ""}`} key={item.id}>{item.tone === "error" ? "!" : "✓"}<span>{item.message}</span></div>)}</div>
    </main>
  );
}
