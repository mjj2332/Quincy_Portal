import type { CollectionKind } from "@quincy/shared";
import { StatusBadge } from "./atoms";
import { InternalLink } from "./InternalLink";
import { ProjectTeamControl } from "./ProjectTeamControl";
import { ProjectDeadlineControl } from "./ProjectDeadlineControl";
import { useStages } from "../lib/stages";
import type { ProjectDetail } from "../lib/project-data";

function date(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value))
    : "Shoot date pending";
}

function collectionLabel(value: string) {
  return value === "raw" ? "RAW" : value.charAt(0).toUpperCase() + value.slice(1);
}

export function ProjectOverviewRail({
  project,
  activeTab,
  availableTabs,
  canUpload,
  canAdminBackend,
  canEdit,
  hasRawFolder,
  autohdrBlocked,
  isSyncing,
  onSyncDropbox,
  onActiveTabChange,
}: {
  project: ProjectDetail;
  activeTab: CollectionKind;
  availableTabs: CollectionKind[];
  canUpload: boolean;
  canAdminBackend: boolean;
  canEdit: boolean;
  hasRawFolder: boolean;
  autohdrBlocked: boolean;
  isSyncing: boolean;
  onSyncDropbox: () => void;
  onActiveTabChange: (kind: CollectionKind) => void;
}) {
  const { presentationStageKey, stages } = useStages();
  const stage = stages.find((item) => item.key === presentationStageKey(project.stageKey));

  return <aside className="rail" aria-label="Project Overview">
    <div className="project-overview__heading">Project Overview</div>
    <section className="rail__sec project-overview__header" aria-labelledby="project-overview-property">
      <div style={{ marginBottom: 10 }}><StatusBadge stageKey={project.stageKey} /></div>
      <h2 className="serif" id="project-overview-property">{project.street}</h2>
      <div className="ey" style={{ marginTop: 8 }}>{[project.suburb, project.postcode].filter(Boolean).join(" · ")}</div>
    </section>

    <section className="rail__sec" aria-labelledby="project-overview-production">
      <div className="ey rail__section-label" id="project-overview-production">Production</div>
      <div className="kv"><span className="k">Stage</span><span className="vv">{stage?.label ?? project.stageKey}</span></div>
      <div className="kv"><span className="k">Shoot</span><span className="vv">{date(project.shootDate)}</span></div>
      <ProjectDeadlineControl projectId={project.id} schedule={project.deadlineSchedule} canEdit={canEdit} />
      {canEdit && <InternalLink className="button button--secondary rail__edit" to={`/projects/${encodeURIComponent(project.id)}/edit`}>Edit details</InternalLink>}
    </section>

    <section className="rail__sec" aria-labelledby="project-overview-team">
      <div className="ey rail__section-label" id="project-overview-team">Team</div>
      <ProjectTeamControl projectId={project.id} members={project.members} canEdit={canEdit} />
    </section>

    <section className="rail__sec" aria-labelledby="project-overview-client">
      <div className="ey rail__section-label" id="project-overview-client">Client</div>
      <div className="kv"><span className="k">Agency</span><span className="vv">{project.agencyName ?? "—"}</span></div>
      <div className="kv"><span className="k">Agent</span><span className="vv">{project.agentName ?? "—"}</span></div>
    </section>

    {project.productionNotes && <section className="rail__sec" aria-labelledby="project-overview-notes">
      <div className="ey rail__section-label" id="project-overview-notes">Production notes</div>
      <p className="muted" style={{ whiteSpace: "pre-wrap" }}>{project.productionNotes}</p>
    </section>}

    <section className="rail__sec" aria-labelledby="project-overview-collections">
      <div className="ey rail__section-label" id="project-overview-collections">Collections</div>
      <div className="filterlist">{availableTabs.map((tab) => {
        const collection = project.collections.find((item) => item.kind === tab);
        return <button className={`frow ${activeTab === tab ? "is-active" : ""}`} type="button" key={tab} onClick={() => onActiveTabChange(tab)}>
          <span>{collectionLabel(tab)}</span><span className="cnt">{collection ? collection.receivedCount : "—"}</span>
        </button>;
      })}</div>
    </section>

    {canUpload && (hasRawFolder || canAdminBackend) && <section className="rail__sec" aria-labelledby="project-overview-dropbox">
      <div className="ey rail__section-label" id="project-overview-dropbox">Dropbox</div>
      <button className="dropcard" type="button" disabled={isSyncing} onClick={onSyncDropbox}>
        <span>◈</span><span>{isSyncing ? "Syncing Dropbox…" : "Sync from Dropbox"}</span>{autohdrBlocked && <span className="statetag st-flagged">Blocked</span>}
      </button>
    </section>}
  </aside>;
}
