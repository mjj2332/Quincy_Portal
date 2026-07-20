import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import { DEFAULT_STAGES, type StageKey } from "@quincy/shared";
import { StatusBadge } from "../components/atoms";
import { apiGet, apiPost } from "../lib/api";
import { useCapabilities } from "../lib/capabilities";

export interface ProjectSummary {
  id: string;
  street: string;
  suburb: string | null;
  postcode: string | null;
  agencyName: string | null;
  agentName: string | null;
  stageKey: StageKey;
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

type DashboardView = "grid" | "list" | "kanban";
type Toast = { id: number; message: string; tone: "success" | "error" };

function formatDate(value: string | null): string {
  if (!value) return "Shoot date pending";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function coverUrl(assetId: string): string {
  return `/media/asset/${encodeURIComponent(assetId)}/thumb`;
}

function CoverMedia({ project, className = "", inlinePlaceholder = false }: { project: ProjectSummary; className?: string; inlinePlaceholder?: boolean }) {
  if (project.coverAssetId) return <img className={className} src={coverUrl(project.coverAssetId)} alt={`Preview of ${project.street}`} loading="lazy" />;
  const content = project.street.trim().charAt(0).toUpperCase() || "Q";
  return inlinePlaceholder ? <span className={`project-cover-placeholder ${className}`} aria-hidden="true">{content}</span> : <div className={`project-cover-placeholder ${className}`} aria-hidden="true">{content}</div>;
}

function location(project: ProjectSummary) { return [project.suburb, project.postcode].filter(Boolean).join(" · ") || "Location pending"; }

function ProjectCard({ project, onOpen }: { project: ProjectSummary; onOpen: (projectId: string) => void }) {
  const stage = DEFAULT_STAGES.find(({ key }) => key === project.stageKey);

  return (
    <button className="proj" type="button" onClick={() => onOpen(project.id)}>
      <div className="proj__media">
        <CoverMedia project={project} />
        <div className="proj__badges">
          <span className="cbubble"><StatusBadge stageKey={project.stageKey} /></span>
        </div>
      </div>
      <div className="proj__body">
        <div className="proj__addr serif">{project.street}</div>
        <div className="proj__meta">
          <div className="ey">{location(project)}</div>
          <div>{[project.agencyName, project.agentName].filter(Boolean).join(" · ") || "Client pending"}</div>
        </div>
        <div className="proj__foot">
          <span className="ey">{formatDate(project.shootDate)}</span>
          <span className="ey muted">{stage?.label ?? project.stageKey}</span>
        </div>
      </div>
    </button>
  );
}

function KanbanCard({ project, canMove, isDragging, onOpen, onDragStart, onDragEnd }: {
  project: ProjectSummary;
  canMove: boolean;
  isDragging: boolean;
  onOpen: (projectId: string) => void;
  onDragStart: (project: ProjectSummary, event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
}) {
  const rawCount = project.expectedCount === null ? `${project.receivedCount} RAW` : `${project.receivedCount}/${project.expectedCount} RAW`;
  return <button className={`kcard ${isDragging ? "is-dragging" : ""}`} type="button" draggable={canMove} onClick={() => onOpen(project.id)} onDragStart={(event) => onDragStart(project, event)} onDragEnd={onDragEnd}>
    <div className="kcard__media"><CoverMedia project={project} /></div>
    <div className="kcard__b">
      <div className="kcard__addr serif">{project.street}</div>
      <div className="kcard__meta">{location(project)}</div>
      <div className="kcard__meta">{project.agencyName || "Agency pending"}</div>
      <div className="kcard__foot"><span className="ey">{rawCount}</span></div>
    </div>
  </button>;
}

export function Dashboard({ onOpenProject, onCreateProject }: DashboardProps) {
  const { can } = useCapabilities();
  const canCreateProject = can("createProject");
  const canMoveStages = can("selectForEditing");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<DashboardView>(() => {
    try { const saved = window.localStorage.getItem("quincy:dashboard:view"); return saved === "grid" || saved === "list" || saved === "kanban" ? saved : "grid"; }
    catch { return "grid"; }
  });
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

    apiGet<ProjectsResponse>("/api/projects")
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
  }, [reload]);

  const filteredProjects = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return projects;
    return projects.filter((project) => [project.street, project.suburb, project.agencyName, project.agentName]
      .some((value) => (value ?? "").toLocaleLowerCase().includes(term)));
  }, [projects, query]);

  const activeCount = projects.filter((project) => project.stageKey !== "delivered").length;
  const needsReviewCount = projects.filter((project) => project.stageKey === "raw_review" || project.stageKey === "edited_review").length;
  const deliveredCount = projects.filter((project) => project.stageKey === "delivered").length;

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
      const label = DEFAULT_STAGES.find((stage) => stage.key === stageKey)?.label ?? stageKey;
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

      <div className="stats" aria-label="Project summary">
        <div className="stat"><div className="v">{activeCount}</div><div className="l">Active shoots</div></div>
        <div className="stat"><div className="v"><span className="sdot" style={{ background: "var(--signal-caution)" }} />{needsReviewCount}</div><div className="l">Needs review</div></div>
        <div className="stat"><div className="v"><span className="sdot" style={{ background: "var(--signal-positive)" }} />{deliveredCount}</div><div className="l">Delivered</div></div>
        <div className="stat"><div className="v">{projects.length}</div><div className="l">All projects</div></div>
      </div>

      <div className="dashboard-viewbar">
        <span className="ey">View</span>
        <div className="segment" aria-label="Dashboard view">
          <button className={view === "grid" ? "is-active" : ""} type="button" onClick={() => selectView("grid")}>Grid</button>
          <button className={view === "list" ? "is-active" : ""} type="button" onClick={() => selectView("list")}>List</button>
          <button className={view === "kanban" ? "is-active" : ""} type="button" onClick={() => selectView("kanban")}>Kanban</button>
        </div>
      </div>

      {isLoading && <div className="empty" role="status"><span className="serif">Loading projects.</span>Preparing the production desk.</div>}

      {!isLoading && error && (
        <div className="empty" role="alert">
          <span className="serif">Projects are unavailable.</span>
          {error}
          <div style={{ marginTop: 16 }}><button className="button button--secondary" type="button" onClick={() => setReload((value) => value + 1)}>Try again</button></div>
        </div>
      )}

      {!isLoading && !error && filteredProjects.length === 0 && (
        <div className="empty">
          <span className="serif">{query ? "Nothing here yet." : "No shoots yet — create the first one."}</span>
          {query ? "No projects match this search." : "Start the production desk with the property, client, and team details."}
          {!query && canCreateProject && <div style={{ marginTop: 16 }}><button className="button" type="button" onClick={onCreateProject}>New shoot</button></div>}
        </div>
      )}

      {!isLoading && !error && filteredProjects.length > 0 && view === "grid" && (
        <div className="projects">
          {filteredProjects.map((project) => <ProjectCard key={project.id} project={project} onOpen={onOpenProject} />)}
        </div>
      )}

      {!isLoading && !error && filteredProjects.length > 0 && view === "list" && (
        <div className="plist" aria-label="Projects list">
          <div className="prow head"><div /><div>Address</div><div className="prow__c-agency">Client</div><div className="prow__c-date">Shoot date</div><div className="prow__c-status">Status</div><div className="prow__raw">RAW received</div></div>
          {filteredProjects.map((project) => <button className="prow" type="button" key={project.id} onClick={() => onOpenProject(project.id)}>
            <CoverMedia project={project} className="prow__thumb" inlinePlaceholder />
            <span><span className="serif prow__addr">{project.street}</span><span className="ey prow__location">{location(project)}</span></span>
            <span className="prow__c-agency">{project.agencyName || "Agency pending"}<span className="muted">{project.agentName || "Agent pending"}</span></span>
            <span className="prow__c-date">{formatDate(project.shootDate)}</span>
            <span className="prow__c-status"><StatusBadge stageKey={project.stageKey} /></span>
            <span className="prow__raw">{project.receivedCount}</span>
          </button>)}
        </div>
      )}

      {!isLoading && !error && filteredProjects.length > 0 && view === "kanban" && (
        <div className="kanban" aria-label="Project pipeline board">
          {DEFAULT_STAGES.map((stage) => {
            const stageProjects = filteredProjects.filter((project) => project.stageKey === stage.key);
            const isDropTarget = canMoveStages && dropStage === stage.key;
            return <section className={`kcol ${isDropTarget ? "is-over" : ""}`} key={stage.key} onDragOver={(event) => { if (canMoveStages && dragging) { event.preventDefault(); setDropStage(stage.key); } }} onDragLeave={() => { if (dropStage === stage.key) setDropStage(undefined); }} onDrop={(event) => { event.preventDefault(); void moveProject(stage.key); }}>
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
