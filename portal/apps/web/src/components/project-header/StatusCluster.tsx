import type { Ref, RefObject } from "react";
import { PanelRightIcon, TriangleAlertIcon } from "lucide-react";
import type { WorkspaceTab } from "@quincy/shared";
import { Button } from "@/components/reui/button";
import { ProjectHeaderDeadline } from "../ProjectHeaderDeadline";
import { ProjectTeamCombobox } from "../ProjectTeamCombobox";
import { StageControl, StageOption } from "./StageControl";
import { ProjectMoreMenu } from "./ProjectMoreMenu";
import { WhiteboardButton } from "./WhiteboardButton";
import { ArchivedBadge } from "./ArchivedBadge";
import { HEADER_CHIP, HEADER_CHIP_LOCK, HEADER_CHIP_WARN, HEADER_RULE } from "./header-styles";
import type { InfoTarget } from "./ProjectInfoPanel";
import type { useStages } from "../../lib/stages";
import type { ProjectDetail } from "../../lib/project-data";
import { cn } from "../../lib/utils";

/** #455: which write was refused as archived, if any (the latch's source; it also says which read-only group focus returns to). */
export type ArchivedLatch = null | "stage" | "deadline" | "dropbox" | "team" | "social-overlays";

export type StatusClusterProps = {
  project: ProjectDetail;
  activeTab: WorkspaceTab;
  archived: boolean;
  latch: ArchivedLatch;
  canEdit: boolean;
  canAdminBackend: boolean;
  canMoveStage: boolean;
  currentStageKey: ProjectDetail["stageKey"];
  stages: ReturnType<typeof useStages>["stages"];
  stageMovePending: boolean;
  stageMoveDisabledReason: string | null;
  onStageMove: (stageKey: ProjectDetail["stageKey"]) => void;
  stageCellRef: RefObject<HTMLDivElement | null>;
  stageGroupRef: Ref<HTMLSpanElement>;
  deadlineGroupRef: Ref<HTMLDivElement>;
  latchArchived: (source: NonNullable<ArchivedLatch>, focusWasInside: boolean) => void;
  onOpenWhiteboard?: () => void;
  /** D6: the Dropbox is blocked (autoHDR). The cluster shows the caution chip, which opens Project info at Dropbox. */
  dropboxBlocked: boolean;
  /** Opens Project info, at a section or the top; `opener` is where focus returns when it closes. */
  onOpenInfo: (opener: HTMLElement, target: InfoTarget) => void;
  infoOpen: boolean;
};

/**
 * #914 D1/D6 — the status cluster at the end of Row A: Stage, Deadline and Team (the controls people use daily, each its own
 * popover), "Dropbox blocked" when it is, the Archived badge, then a rule and Whiteboard, Project info and ⋯. A problem changes how a control looks; read-only roles and an
 * archived Project get flat values with no chevron. Below the `project-header` container's wide size the cluster takes its own
 * line, and the rule, Whiteboard, Project info and ⋯ go to its end as one unbroken group (T1).
 */
export function StatusCluster(props: StatusClusterProps) {
  const { project, archived, latch, canEdit, canMoveStage, currentStageKey, stages } = props;
  const stageLabel = stages.find((stage) => stage.key === currentStageKey)?.label ?? currentStageKey;
  return <div className="flex min-w-0 flex-wrap items-center gap-[var(--space-2)]" data-testid="project-status-cluster">
    <div ref={props.stageCellRef} className="contents">
      {canMoveStage
        ? <StageControl project={project} currentStageKey={currentStageKey} stages={stages} contractEnabled={project.contractEnabled} pending={props.stageMovePending} disabledReason={props.stageMoveDisabledReason} onMove={props.onStageMove} />
        : <span
          ref={props.stageGroupRef}
          {...(archived ? { role: "group", "aria-label": "Stage", tabIndex: -1 } : {})}
          data-header-value="stage"
          className={HEADER_CHIP_LOCK}
        ><StageOption stageKey={currentStageKey} label={stageLabel} /></span>}
    </div>
    <ProjectHeaderDeadline projectId={project.id} schedule={project.deadlineSchedule} canEdit={canEdit} archived={archived} archivedNotice={latch === "deadline"} readOnlyRef={props.deadlineGroupRef} onArchivedRefusal={(inside) => props.latchArchived("deadline", inside)} />
    <ProjectTeamCombobox presentation="popover" projectId={project.id} members={project.members} canEdit={canEdit} archived={archived} onArchivedRefusal={() => props.latchArchived("team", false)} />
    {props.dropboxBlocked && <Button type="button" variant="outline" size="header" data-testid="project-dropbox-blocked" className={cn(HEADER_CHIP, HEADER_CHIP_WARN)} aria-haspopup="dialog"
      onClick={(event) => props.onOpenInfo(event.currentTarget, "dropbox")}><TriangleAlertIcon aria-hidden="true" />Dropbox blocked</Button>}
    {archived && <ArchivedBadge data-testid="project-archived-badge" />}
    {/* T1: the rule, Whiteboard, Project info and ⋯ are one group that never splits, pushed to the line's end below the wide size
        (app.css `.project-header__push`); when the line is full the group moves down whole, still at the end. */}
    <div className="project-header__push flex shrink-0 flex-nowrap items-center gap-[var(--space-2)]">
      <span aria-hidden="true" className={cn(HEADER_RULE, "mx-[var(--space-1)]")} />
      {props.onOpenWhiteboard && <WhiteboardButton variant="header" onOpen={props.onOpenWhiteboard} />}
      <Button type="button" variant="outline" size="header" data-testid="project-info-open" data-twin="info" className={HEADER_CHIP} aria-haspopup="dialog" aria-expanded={props.infoOpen}
        onClick={(event) => props.onOpenInfo(event.currentTarget, null)}><PanelRightIcon aria-hidden="true" />Project info</Button>
      <ProjectMoreMenu project={project} activeTab={props.activeTab} canEdit={canEdit} archived={archived} canAdminBackend={props.canAdminBackend} />
    </div>
  </div>;
}
