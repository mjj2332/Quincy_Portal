import { useEffect, useMemo, useState } from "react";
import { DEFAULT_STAGES, type StageKey } from "@quincy/shared";
import { StatusBadge } from "../components/atoms";
import { apiGet } from "../lib/api";

export interface ProjectSummary {
  id: string;
  street: string;
  suburb: string;
  agencyName: string;
  agentName: string;
  stageKey: StageKey;
  shootDate: string | null;
  coverAssetId: string | null;
}

interface ProjectsResponse {
  projects: ProjectSummary[];
}

interface DashboardProps {
  onOpenProject: (projectId: string) => void;
}

function formatDate(value: string | null): string {
  if (!value) return "Shoot date pending";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function coverUrl(assetId: string): string {
  return `/media/${encodeURIComponent(assetId)}`;
}

function ProjectCard({ project, onOpen }: { project: ProjectSummary; onOpen: (projectId: string) => void }) {
  const stage = DEFAULT_STAGES.find(({ key }) => key === project.stageKey);

  return (
    <button className="proj" type="button" onClick={() => onOpen(project.id)}>
      <div className="proj__media">
        {project.coverAssetId ? (
          <img src={coverUrl(project.coverAssetId)} alt={`Preview of ${project.street}`} loading="lazy" />
        ) : (
          <div className="proj__placeholder" aria-hidden="true">
            <img src="/brand/quincy-qp-white.png" alt="" />
          </div>
        )}
        <div className="proj__badges">
          <span className="cbubble"><StatusBadge stageKey={project.stageKey} /></span>
        </div>
      </div>
      <div className="proj__body">
        <div className="proj__addr serif">{project.street}</div>
        <div className="proj__meta">
          <div className="ey">{project.suburb}</div>
          <div>{project.agencyName} · {project.agentName}</div>
        </div>
        <div className="proj__foot">
          <span className="ey">{formatDate(project.shootDate)}</span>
          <span className="ey muted">{stage?.label ?? project.stageKey}</span>
        </div>
      </div>
    </button>
  );
}

export function Dashboard({ onOpenProject }: DashboardProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const [isLoading, setIsLoading] = useState(true);
  const [reload, setReload] = useState(0);

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
      .some((value) => value.toLocaleLowerCase().includes(term)));
  }, [projects, query]);

  const activeCount = projects.filter((project) => project.stageKey !== "delivered").length;
  const needsReviewCount = projects.filter((project) => project.stageKey === "raw_review" || project.stageKey === "edited_review").length;
  const deliveredCount = projects.filter((project) => project.stageKey === "delivered").length;

  return (
    <main className="page">
      <div className="pagehead">
        <div>
          <div className="ey" style={{ marginBottom: 14 }}>Quincy Portal · production desk</div>
          <h1 className="serif">Projects</h1>
        </div>
        <label className="dashboard-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>
          <span className="sr-only">Search projects</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search address, suburb, client…" />
        </label>
      </div>

      <div className="stats" aria-label="Project summary">
        <div className="stat"><div className="v">{activeCount}</div><div className="l">Active shoots</div></div>
        <div className="stat"><div className="v"><span className="sdot" style={{ background: "var(--signal-caution)" }} />{needsReviewCount}</div><div className="l">Needs review</div></div>
        <div className="stat"><div className="v"><span className="sdot" style={{ background: "var(--signal-positive)" }} />{deliveredCount}</div><div className="l">Delivered</div></div>
        <div className="stat"><div className="v">{projects.length}</div><div className="l">All projects</div></div>
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
        <div className="empty"><span className="serif">Nothing here yet.</span>{query ? "No projects match this search." : "Projects will appear here when work is scheduled."}</div>
      )}

      {!isLoading && !error && filteredProjects.length > 0 && (
        <div className="projects">
          {filteredProjects.map((project) => <ProjectCard key={project.id} project={project} onOpen={onOpenProject} />)}
        </div>
      )}
    </main>
  );
}
