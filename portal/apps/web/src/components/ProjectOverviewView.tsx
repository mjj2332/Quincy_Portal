import { deadlineOffsetLabel, type Role } from "@quincy/shared";
import { useStages } from "../lib/stages";
import { overviewPresentation } from "../lib/project-overview";
import type { ProjectDetail } from "../lib/project-data";

type ProjectOverviewViewProps = {
  detail: ProjectDetail | undefined;
  role: Role;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Project overview could not be loaded.";
}

function shootDateLabel(value: string | null) {
  return value || "Not scheduled";
}

function stageLabel(stageKey: string, stages: readonly { key: string; label: string }[]) {
  return stages.find((stage) => stage.key === stageKey)?.label ?? stageKey;
}

function roleLabel(roleOnProject: string) {
  return roleOnProject === "photographer" ? "Photographer" : "Editor";
}

function deadlineStateLabel(state: string) {
  return state === "unset" ? "Not set" : state.replaceAll("_", " ");
}

function nextReminderLabel(nextOccurrence: ReturnType<typeof overviewPresentation>["deadline"]["nextOccurrence"]) {
  if (!nextOccurrence) return "None";
  return nextOccurrence.kind === "due_now" ? "Due now" : deadlineOffsetLabel(nextOccurrence.offsetMinutes);
}

function deadlineLabel(deadline: ReturnType<typeof overviewPresentation>["deadline"]["deadline"]) {
  return deadline ? deadline.localCivil.replace("T", " ") : "Not set";
}

export function ProjectOverviewView({ detail, role, loading, error, onRetry }: ProjectOverviewViewProps) {
  const { stages } = useStages();

  if (loading && !detail) {
    return <section className="project-overview-view" aria-label="Project overview"><div className="empty" role="status"><span className="serif">Loading project overview.</span>Preparing the project details.</div></section>;
  }
  if (error && !detail) {
    return <section className="project-overview-view" aria-label="Project overview"><div className="empty" role="alert"><span className="serif">Project overview unavailable.</span>{errorMessage(error)} <button className="button button--secondary" type="button" onClick={onRetry}>Retry</button></div></section>;
  }
  if (!detail) {
    return <section className="project-overview-view" aria-label="Project overview"><div className="empty" role="status"><span className="serif">No project overview.</span>There are no project details to show.</div></section>;
  }

  const presentation = overviewPresentation(detail, role);
  const deadline = presentation.deadline;
  return <section className="project-overview-view" aria-label="Project overview">
    {Boolean(error) && <div className="notice" role="alert">{errorMessage(error)} <button className="button button--text" type="button" onClick={onRetry}>Retry</button></div>}
    <header className="project-overview-view__header"><div className="ey">Project overview</div><h2 className="serif">{presentation.address.street}</h2><div className="muted">{[presentation.address.suburb, presentation.address.postcode].filter(Boolean).join(" · ") || "Address details unavailable"}</div></header>
    <section className="project-overview-view__section" aria-labelledby="project-overview-view-production"><div className="ey" id="project-overview-view-production">Production</div>
      <div className="kv"><span className="k">Stage</span><span className="vv">{stageLabel(presentation.stageKey, stages)}</span></div>
      {Object.prototype.hasOwnProperty.call(presentation, "priority") && <div className="kv"><span className="k">Priority</span><span className="vv">{presentation.priority}</span></div>}
      <div className="kv"><span className="k">Shoot</span><span className="vv">{shootDateLabel(presentation.summary.shootDate)}{presentation.summary.timeWindow ? ` · ${presentation.summary.timeWindow}` : ""}</span></div>
      <div className="kv"><span className="k">Deadline</span><span className="vv">{deadlineLabel(deadline.deadline)} <small>{deadlineStateLabel(deadline.state)}</small></span></div>
      <div className="kv"><span className="k">Next reminder</span><span className="vv">{nextReminderLabel(deadline.nextOccurrence)}</span></div>
      <div className="kv"><span className="k">Advance reminders</span><span className="vv">{deadline.reminderOffsetsMinutes.length ? deadline.reminderOffsetsMinutes.map(deadlineOffsetLabel).join(", ") : "None"}</span></div>
    </section>
    <section className="project-overview-view__section" aria-labelledby="project-overview-view-team"><div className="ey" id="project-overview-view-team">Team</div>{presentation.team.length ? <div className="project-overview-view__team">{presentation.team.map((member) => <div className="project-overview-view__member" key={member.id}><strong>{member.name || "Unnamed team member"}</strong><span>{roleLabel(member.roleOnProject)}{member.active ? "" : " · Inactive"}</span></div>)}</div> : <div className="muted">Not assigned</div>}</section>
    <section className="project-overview-view__section" aria-labelledby="project-overview-view-client"><div className="ey" id="project-overview-view-client">Client</div><div className="kv"><span className="k">Agency</span><span className="vv">{presentation.summary.agencyName ?? "—"}</span></div><div className="kv"><span className="k">Agent</span><span className="vv">{presentation.summary.agentName ?? "—"}</span></div></section>
    {presentation.summary.productionNotes && <section className="project-overview-view__section" aria-labelledby="project-overview-view-notes"><div className="ey" id="project-overview-view-notes">Production notes</div><p className="muted" style={{ whiteSpace: "pre-wrap" }}>{presentation.summary.productionNotes}</p></section>}
  </section>;
}
