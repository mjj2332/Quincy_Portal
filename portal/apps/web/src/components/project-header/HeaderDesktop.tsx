import type { ReactNode } from "react";
import type { ProjectDetail } from "../../lib/project-data";
import { deadlineTriggerText } from "../ProjectHeaderDeadline";
import { StatusCluster, type StatusClusterProps } from "./StatusCluster";

/** The shoot date as D1's meta line reads it, "Tue 16 Sep": the Deadline's fixed name tables (no "Sept"), read off the civil date. */
export function shootDateText(value: string | null): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Shoot date pending";
  return `Shoot ${deadlineTriggerText(`${value}T00:00`).split(" · ")[0]}`;
}

export function clientText(project: Pick<ProjectDetail, "agencyName" | "agentName">): string | null {
  const parts = [project.agencyName, project.agentName].filter((part): part is string => Boolean(part && part.trim()));
  return parts.length ? parts.join(", ") : null;
}

const META_DOT = <span aria-hidden="true" className="text-muted-foreground">·</span>;

/**
 * #914 D1/T1 — the desktop header. Row A is the labelled section: the title in the display face with the suburb beside it, the
 * meta line (shoot date, client), and the status cluster. Row B, the Workspace tab bar, is its sibling (see app.css), passed in as
 * `tabs` so it is rendered exactly once.
 */
export function HeaderDesktop({ project, crumb, cluster, tabs, below }: { project: ProjectDetail; crumb?: ReactNode; cluster: StatusClusterProps; tabs: ReactNode; below?: ReactNode }) {
  const client = clientText(project);
  const place = [project.suburb, project.postcode].filter(Boolean).join(" ");
  return <>
    <section className="project-header" aria-label="Project Overview" data-testid="project-header">
      {crumb}
      <div className="project-header__row-a">
        <div className="grid min-w-0 gap-[var(--space-1)]">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-[var(--space-3)] gap-y-[var(--space-1)]">
            <h2 id="project-overview-property" className="m-0 [font:var(--type-h3)] tracking-[var(--tracking-tight)] text-foreground [text-wrap:pretty] [overflow-wrap:anywhere]">{project.street}</h2>
            {place && <span className="[font:var(--type-label)] text-foreground-secondary" data-testid="project-header-place">{place}</span>}
          </div>
          <p className="m-0 flex flex-wrap items-center gap-[var(--space-2)] [font:var(--type-label)] text-foreground-secondary" data-testid="project-header-meta">
            <span>{shootDateText(project.shootDate)}</span>
            {client && <>{META_DOT}<span className="[overflow-wrap:anywhere]">{client}</span></>}
          </p>
        </div>
        <StatusCluster {...cluster} />
      </div>
      {below}
    </section>
    <div className="project-header__tabbar" data-testid="project-header-tabbar">{tabs}</div>
  </>;
}
