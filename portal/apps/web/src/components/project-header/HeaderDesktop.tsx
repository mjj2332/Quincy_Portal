import type { ReactNode, Ref } from "react";
import { NotebookPenIcon, PanelRightIcon } from "lucide-react";
import { StageDot } from "../atoms";
import { Button } from "@/components/reui/button";
import { cn } from "../../lib/utils";
import { INFO_LINK } from "./info-sections";
import type { ProjectDetail } from "../../lib/project-data";
import { civilDayText } from "../ProjectHeaderDeadline";
import { StatusCluster, type StatusClusterProps } from "./StatusCluster";
import { HEADER_CHIP } from "./header-styles";
import { META_DOT } from "./header-parts";
import { WhiteboardButton } from "./WhiteboardButton";

/** The shoot date as D1's meta line reads it, "Tue 16 Sep": the Deadline's fixed name tables (no "Sept"), read off the civil date. */
export function shootDateText(value: string | null): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Shoot date pending";
  return `Shoot ${civilDayText(value)}`;
}

export function clientText(project: Pick<ProjectDetail, "agencyName" | "agentName">): string | null {
  const parts = [project.agencyName, project.agentName].filter((part): part is string => Boolean(part && part.trim()));
  return parts.length ? parts.join(", ") : null;
}


/**
 * #914 D1/T1 — the desktop header. Row A is the labelled section: the title in the display face with the suburb beside it, the
 * meta line (shoot date, client, and a Production notes link that opens Project info at the notes), and the status cluster. Row B, the Workspace tab bar, is its sibling (see app.css), passed in as
 * `tabs` so it is rendered exactly once.
 *
 * D5: Row B is sticky, and once Row A has scrolled out (`condensed`, from the owner's observer on `rowARef`) it is the condensed
 * bar: the stage dot and title, the same tabs, then Whiteboard and Project info, so switching tabs never needs a scroll back up.
 */
export function HeaderDesktop({ project, cluster, tabs, info, condensed = false, rowARef, rowBRef }: {
  project: ProjectDetail;
  cluster: StatusClusterProps;
  tabs: ReactNode;
  /** Project info (D2), rendered beside the rows. */
  info?: ReactNode;
  condensed?: boolean;
  rowARef?: Ref<HTMLElement>;
  rowBRef?: Ref<HTMLDivElement>;
}) {
  const client = clientText(project);
  const place = [project.suburb, project.postcode].filter(Boolean).join(" ");
  return <>
    <section ref={rowARef} className="project-header" aria-label="Project Overview" data-testid="project-header">
      <div className="project-header__row-a">
        <div className="grid min-w-0 gap-[var(--space-1)]">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-[var(--space-3)] gap-y-[var(--space-1)]">
            <h2 id="project-overview-property" className="m-0 [font:var(--type-h3)] tracking-[var(--tracking-tight)] text-foreground [text-wrap:pretty] [overflow-wrap:anywhere]">{project.street}</h2>
            {place && <span className="[font:var(--type-label)] text-foreground-secondary" data-testid="project-header-place">{place}</span>}
          </div>
          <p className="m-0 flex flex-wrap items-center gap-[var(--space-2)] [font:var(--type-label)] text-foreground-secondary" data-testid="project-header-meta">
            <span>{shootDateText(project.shootDate)}</span>
            {client && <>{META_DOT}<span className="[overflow-wrap:anywhere]">{client}</span></>}
            {project.productionNotes?.trim() && <>{META_DOT}<Button type="button" variant="ghost" data-testid="project-header-notes" aria-haspopup="dialog"
              className={cn(INFO_LINK, "gap-[var(--space-1)] [font:var(--type-label)] text-foreground-secondary [margin-block:calc(var(--space-3)*-1)]")}
              onClick={(event) => cluster.onOpenInfo(event.currentTarget, "notes")}><NotebookPenIcon aria-hidden="true" className="size-3.5" />Production notes</Button></>}
          </p>
        </div>
        <StatusCluster {...cluster} />
      </div>
    </section>
    <div ref={rowBRef} className="project-header__tabbar" data-testid="project-header-tabbar" data-header-condensed={condensed ? "" : undefined}>
      {/* The title repeats Row A's heading for sight only (Row A is still in the document). */}
      {condensed && <span aria-hidden="true" data-testid="project-header-condensed-title"
        className="flex h-7 min-w-0 max-w-[40%] shrink-0 items-center gap-[var(--space-2)] border-e-[length:var(--border-width-hair)] border-solid border-border pe-[var(--space-5)] text-foreground [font:var(--weight-regular)_var(--text-md)/1_var(--font-display)]">
        <StageDot stageKey={cluster.currentStageKey} /><span className="truncate">{project.street}</span>
      </span>}
      {tabs}
      {condensed && <div className="flex shrink-0 items-center gap-[var(--space-2)]">
        {cluster.onOpenWhiteboard && <WhiteboardButton variant="header" condensedCopy onOpen={cluster.onOpenWhiteboard} />}
        <Button type="button" variant="outline" size="header" data-testid="project-header-condensed-info" data-twin="info" className={HEADER_CHIP} aria-haspopup="dialog" aria-expanded={cluster.infoOpen}
          onClick={(event) => cluster.onOpenInfo(event.currentTarget, null)}><PanelRightIcon aria-hidden="true" />Project info</Button>
      </div>}
    </div>
    {info}
  </>;
}
