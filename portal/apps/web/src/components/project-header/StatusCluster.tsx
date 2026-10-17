import type { ReactNode, Ref, RefObject } from "react";
import { ArchiveIcon } from "lucide-react";
import type { WorkspaceTab } from "@quincy/shared";
import { Badge } from "@/components/reui/badge";
import { ProjectHeaderDeadline } from "../ProjectHeaderDeadline";
import { ProjectTeamCombobox } from "../ProjectTeamCombobox";
import { StageControl, StageOption } from "./StageControl";
import { ProjectMoreMenu } from "./ProjectMoreMenu";
import { WhiteboardButton } from "./WhiteboardButton";
import { HEADER_CHIP_LOCK, HEADER_RULE } from "./header-styles";
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
  /** S1 interim: the Dropbox popover, until S2 moves its details into Project info and leaves only the "Dropbox blocked" chip here. */
  dropbox?: ReactNode;
};

/**
 * #914 D1/D6 — the status cluster at the end of Row A: Stage, Deadline and Team (the controls people use daily, each its own
 * popover), the Archived badge, then a rule and Whiteboard and ⋯. A problem changes how a control looks; read-only roles and an
 * archived Project get flat values with no chevron. Below the `project-header` container's wide size the cluster takes its own
 * line, and the rule pushes Whiteboard and ⋯ to its end (T1).
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
    {props.dropbox}
    {archived && <Badge variant="secondary" size="xl" data-testid="project-archived-badge" className="normal-case tracking-normal gap-[var(--space-1)] [&_svg]:size-3.5"><ArchiveIcon aria-hidden="true" />Archived</Badge>}
    <span aria-hidden="true" className={cn(HEADER_RULE, "project-header__push mx-[var(--space-1)]")} />
    {props.onOpenWhiteboard && <WhiteboardButton variant="header" onOpen={props.onOpenWhiteboard} />}
    <ProjectMoreMenu project={project} activeTab={props.activeTab} canEdit={canEdit} archived={archived} canAdminBackend={props.canAdminBackend} />
  </div>;
}
