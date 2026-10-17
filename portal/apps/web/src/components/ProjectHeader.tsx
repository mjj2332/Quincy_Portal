import { useLayoutEffect, useRef, useState } from "react";
import type { CollectionKind, Role } from "@quincy/shared";
import type { WorkspaceTab } from "../lib/workspace-tab";
import { InternalLink } from "./InternalLink";
import { useDashboardReturnLink, useInProjectSheet } from "./quincy/ProjectSheet";
import { CopyProjectLinkButton } from "./quincy/CopyProjectLinkButton";
import { ProjectShowIn } from "./quincy/ProjectShowIn";
import { ProjectTeamCombobox } from "./ProjectTeamCombobox";
import { ProjectHeaderDeadline } from "./ProjectHeaderDeadline";
import { ProjectHeaderDropbox } from "./ProjectHeaderDropbox";
import { Button } from "@/components/reui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/reui/tooltip";
import { PresentationIcon } from "lucide-react";
import { StageControl, StageOption } from "./project-header/StageControl";
import { WorkspaceTabs } from "./project-header/WorkspaceTabs";
import { cn } from "../lib/utils";
import { HEADER_READONLY_VALUE, HEADER_TEXT_LINK, READONLY_GROUP_FOCUS } from "./project-header-popover";
import { useStages } from "../lib/stages";
import { useCapabilities } from "../lib/capabilities";
import { useVideoReviewQuery, type ProjectDetail } from "../lib/project-data";
import { ProjectSocialOverlayPicker } from "./quincy/ProjectSocialOverlayPicker";

function date(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value))
    : "Shoot date pending";
}

/** #498: the whiteboard's entry, beside the Collaboration tab (outside the tablist: it is a button, not a tab). */
export function WhiteboardButton({ onOpen }: { onOpen: () => void }) {
  return <Tooltip>
    <TooltipTrigger render={<Button type="button" variant="ghost" size="icon" aria-label="Open whiteboard" data-testid="project-whiteboard-open" className="min-h-[44px] min-w-[44px]" onClick={onOpen} />}>
      <PresentationIcon className="size-4" aria-hidden="true" />
    </TooltipTrigger>
    <TooltipContent side="bottom">Open whiteboard</TooltipContent>
  </Tooltip>;
}

/** #870: below the control grid, only while the Video review gate is open (the picker's routes answer 404 when it is closed). Its own component, so the query exists only for roles that can see it. */
function SocialOverlaysRow({ projectId, role, canEdit, archived, onArchivedRefusal }: { projectId: string; role: Role; canEdit: boolean; archived: boolean; onArchivedRefusal: () => void }) {
  const open = useVideoReviewQuery(projectId, true, role).data?.open === true;
  if (!open) return null;
  return <div data-testid="project-header-social-overlays"><ProjectSocialOverlayPicker key={projectId} projectId={projectId} role={role} canEdit={canEdit} archived={archived} onArchivedRefusal={onArchivedRefusal} /></div>;
}


// #213: prototype 2a's "Edit details" is an underlined text link in the identity row, not a
// button. `buttonClasses` deliberately carries `no-underline`, so this is its own small idiom;
// inline-flex + min-height keeps the 44px target the rest of the header holds.
const EDIT_DETAILS_LINK = HEADER_TEXT_LINK;

// #367: beside the sentence-case "Edit details" link the ghost Copy link must not read as a field key
// (the button base is uppercase + wide tracking); -ms-2 offsets the ghost padding so the label sits on
// the row rhythm while the hover fill still bleeds.
const COPY_LINK_IN_HEADER = "normal-case tracking-[var(--tracking-normal)] -ms-2";

// #213 follow-up: prototype 2a's `.crumb` — "← Dashboard" as small secondary text above the title,
// moved here from the work area's `.wsbar` chip. The 44px target is kept by the min-height; the
// negative block margin gives that height back so the identity row keeps the prototype's 8px rhythm.
const DASHBOARD_CRUMB =
  "inline-flex items-center w-fit min-h-[44px] " /* WCAG 2.5.5 Enhanced target, not a spacing token */ +
  "[margin-block:-12px] no-underline " +
  "[font:var(--weight-regular)_var(--text-xs)/1.2_var(--font-sans)] text-foreground-secondary hover:text-foreground " +
  "transition-[color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2";

const HEADER_KV_KEY =
  "k [font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] " +
  "uppercase tracking-[var(--tracking-wide)] text-foreground-secondary";

const HEADER_KV_VALUE =
  "vv [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] " +
  "text-foreground [overflow-wrap:anywhere]";

/** #455: which write was refused as archived, if any (the latch's source; it also says which read-only group focus returns to). */
type ArchivedLatch = null | "stage" | "deadline" | "dropbox" | "social-overlays";

export function ProjectHeader({
  project,
  activeTab,
  availableTabs,
  deliveryOffered = false,
  canUpload,
  canAdminBackend,
  canEdit,
  hasRawFolder,
  autohdrBlocked,
  isSyncing,
  onSyncDropbox,
  onActiveTabChange,
  collaborationUnread = 0,
  workspaceTabRefs,
  onStageMove,
  stageMovePending = false,
  stageMoveDisabledReason = null,
  onOpenWhiteboard,
  whiteboardOpen = false,
}: {
  project: ProjectDetail;
  /** #498: opens the Project whiteboard. Offered only once the Workspace has confirmed collaboration access. */
  onOpenWhiteboard?: () => void;
  /** #498: the board is open and this header is hidden beneath it; see the scroll effect. */
  whiteboardOpen?: boolean;
  activeTab: WorkspaceTab;
  availableTabs: CollectionKind[];
  /** #787: the Delivery tab exists (gate open, `viewClientPreview`). It follows Collaboration. */
  deliveryOffered?: boolean;
  canUpload: boolean;
  canAdminBackend: boolean;
  canEdit: boolean;
  hasRawFolder: boolean;
  autohdrBlocked: boolean;
  isSyncing: boolean;
  /** Resolves "archived" when the server refused the sync because the Project is archived (#455). */
  onSyncDropbox: () => void | Promise<"archived" | void>;
  onActiveTabChange: (tab: WorkspaceTab) => void;
  /** Unread discussion comments, shown as a badge on the Collaboration tab. */
  collaborationUnread?: number;
  /** #337: each Workspace tab's trigger, keyed by tab, so an arrival can focus the tab it selected. */
  workspaceTabRefs?: React.RefObject<Map<WorkspaceTab, HTMLButtonElement>>;
  /** Resolves "archived" when the server refused the move because the Project is archived (#455). */
  onStageMove?: (stageKey: ProjectDetail["stageKey"]) => void | Promise<"archived" | void>;
  stageMovePending?: boolean;
  stageMoveDisabledReason?: string | null;
}) {
  const dashboardReturn = useDashboardReturnLink();
  const inSheet = useInProjectSheet();
  const { presentationStageKey, stages } = useStages();
  const { can, role } = useCapabilities();
  // #870: the Social overlays picker needs `viewVideo` (an External editor sees it read-only) and the Video review gate open: see `SocialOverlaysRow`.
  const offersOverlays = can("viewVideo") && role !== undefined;
  const currentStageKey = presentationStageKey(project.stageKey);
  // #455: the header is read-only on an archived Project, from the loaded detail or latched by the first refusal of a write (Stage, Deadline,
  // Dropbox) until the detail goes un-archived. The latch makes the whole row flip at once instead of one control per refusal.
  const [latch, setLatch] = useState<ArchivedLatch>(null);
  const archived = Boolean(project.archivedAt) || latch !== null;
  const canMoveStage = can("moveProjectStage") && !archived;
  const stageCellRef = useRef<HTMLDivElement>(null);
  const stageGroupRef = useRef<HTMLSpanElement>(null);
  const deadlineGroupRef = useRef<HTMLDivElement>(null);
  const dropboxGroupRef = useRef<HTMLDivElement>(null);
  const priorArchivedAt = useRef(Boolean(project.archivedAt));
  const priorProjectId = useRef(project.id);
  const focusAfterFlip = useRef<{ source: NonNullable<ArchivedLatch> } | null>(null);
  // Restore (the detail's archivedAt goes truthy to falsy) or another Project: the latch goes with it. (Archived and restored inside one refetch window keeps the latch until remount, as for the Team.)
  useLayoutEffect(() => {
    const was = priorArchivedAt.current, sameProject = priorProjectId.current === project.id;
    priorArchivedAt.current = Boolean(project.archivedAt); priorProjectId.current = project.id;
    if (!sameProject || (was && !project.archivedAt)) { setLatch(null); focusAfterFlip.current = null; }
  }, [project.archivedAt, project.id]);
  function latchArchived(source: NonNullable<ArchivedLatch>, focusWasInside: boolean) {
    focusAfterFlip.current = focusWasInside ? { source } : null;
    setLatch((current) => current ?? source);
  }
  // Lost focus is decided from the capture taken when the write started, only on a refusal-driven flip, never on load: the control unmounts in the
  // flip commit, leaving focus on <body> (or a disabled control) unless it is moved to the source's always-mounted read-only group. Focus the user
  // moved to another connected, enabled control while the request was pending is theirs: leave it.
  useLayoutEffect(() => {
    const flip = focusAfterFlip.current;
    if (!latch || !flip) return;
    focusAfterFlip.current = null;
    const target = { stage: stageGroupRef, deadline: deadlineGroupRef, dropbox: dropboxGroupRef, "social-overlays": stageGroupRef }[flip.source].current;
    if (!target) return;
    const active = document.activeElement;
    const reclaimed = !!active && active !== document.body && active !== target && active.contains(target);
    if (!active || active === document.body || !active.isConnected || active.matches(":disabled") || reclaimed) target.focus();
  }, [latch]);
  async function moveStageAndLatch(stageKey: ProjectDetail["stageKey"]) {
    const active = document.activeElement;
    // The Select's popup is portalled: its trigger names it through aria-controls while it is open.
    const popupId = stageCellRef.current?.querySelector("[aria-controls]")?.getAttribute("aria-controls");
    const inside = Boolean(active && (stageCellRef.current?.contains(active) || (popupId && document.getElementById(popupId)?.contains(active))));
    const result = await onStageMove?.(stageKey);
    if (result === "archived") latchArchived("stage", inside);
  }
  return <section className="project-header" aria-label="Project Overview" data-testid="project-header">
    <div className="project-header__identity">
      {!inSheet && <InternalLink className={DASHBOARD_CRUMB} {...dashboardReturn}>← Dashboard</InternalLink>}
      <h2 id="project-overview-property"
          className="[font:var(--type-h3)] tracking-[var(--tracking-tight)] text-foreground [text-wrap:pretty]">
        {project.street}
      </h2>
      <div className="project-header__meta">
        <span className="[font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)]
                        uppercase tracking-[var(--tracking-wide)] text-foreground-secondary">
          {[project.suburb, project.postcode].filter(Boolean).join(" · ")}
        </span>
        <span><span className={HEADER_KV_KEY}>Shoot</span> <span className={HEADER_KV_VALUE}>{date(project.shootDate)}</span></span>
        <span><span className={HEADER_KV_KEY}>Client</span> <span className={HEADER_KV_VALUE}>{project.agencyName || project.agentName ? `${project.agencyName ?? "—"} · ${project.agentName ?? "—"}` : "—"}</span></span>
        {/* #455: an archived Project's details are read-only, so the link leads to Restore / Delete (Admin) and is not offered to anyone else. */}
        {canEdit && (!archived || canAdminBackend) && <InternalLink className={EDIT_DETAILS_LINK} to={`/projects/${encodeURIComponent(project.id)}/edit`}>{archived ? "Restore or delete" : "Edit details"}</InternalLink>}
        <CopyProjectLinkButton projectId={project.id} tab={activeTab} className={COPY_LINK_IN_HEADER} />
        <ProjectShowIn project={project} />
      </div>
      {project.productionNotes && <p className={cn("project-header__notes", "m-0 [white-space:pre-wrap]",
                    "[font:var(--weight-regular)_var(--text-sm)/var(--leading-relaxed)_var(--font-body-serif)]",
                    "text-foreground-secondary")}>{project.productionNotes}</p>}
    </div>

    {/* #213: prototype 2a's flat control row — four cells, one small label each, no section
        headings. The cells are plain layout divs (a generic div cannot carry a name, #206 lesson);
        every control inside already has its own accessible name. */}
    <div className="project-header__controls">
      <div className="project-header__control" ref={stageCellRef}>
        <span className={HEADER_KV_KEY}>Stage</span>
        {canMoveStage ? <StageControl project={project} currentStageKey={currentStageKey} stages={stages} contractEnabled={project.contractEnabled} pending={stageMovePending} disabledReason={stageMoveDisabledReason} onMove={(stageKey) => { void moveStageAndLatch(stageKey); }} /> : <span
          ref={stageGroupRef}
          {...(archived ? { role: "group", "aria-label": "Stage", tabIndex: -1 } : {})}
          className={cn(HEADER_READONLY_VALUE, archived && READONLY_GROUP_FOCUS)}
        ><StageOption stageKey={currentStageKey} label={stages.find((stage) => stage.key === currentStageKey)?.label ?? currentStageKey} /></span>}
      </div>

      <div className="project-header__control">
        <span className={HEADER_KV_KEY}>Team</span>
        <ProjectTeamCombobox projectId={project.id} members={project.members} canEdit={canEdit} archived={archived} rowClassName="min-h-[44px]" />
      </div>

      <div className="project-header__control">
        <span className={HEADER_KV_KEY}>Deadline</span>
        <ProjectHeaderDeadline projectId={project.id} schedule={project.deadlineSchedule} canEdit={canEdit} archived={archived} archivedNotice={latch === "deadline"} readOnlyRef={deadlineGroupRef} onArchivedRefusal={(inside) => latchArchived("deadline", inside)} />
      </div>

      {canUpload && (hasRawFolder || canAdminBackend || Boolean(project.monitoredRawFolder)) && <div className="project-header__control">
        <span className={HEADER_KV_KEY}>Dropbox</span>
        <ProjectHeaderDropbox project={project} isSyncing={isSyncing} autohdrBlocked={autohdrBlocked} onSyncDropbox={onSyncDropbox} archived={archived} archivedNotice={latch === "dropbox"} readOnlyRef={dropboxGroupRef} onArchivedRefusal={(inside) => latchArchived("dropbox", inside)} />
      </div>}
    </div>

    {offersOverlays && <SocialOverlaysRow projectId={project.id} role={role!} canEdit={can("chooseSocialOverlays")} archived={archived} onArchivedRefusal={() => latchArchived("social-overlays", false)} />}

    {/* The entry button sits beside the scroller, not inside it: at phone width the tabs scroll sideways and it must stay in view. */}
    <div className="project-header__tabrow flex min-w-0 items-center gap-[var(--space-2)]">
    <WorkspaceTabs project={project} activeTab={activeTab} availableTabs={availableTabs} deliveryOffered={deliveryOffered} onActiveTabChange={onActiveTabChange} collaborationUnread={collaborationUnread} workspaceTabRefs={workspaceTabRefs} whiteboardOpen={whiteboardOpen} />
    {onOpenWhiteboard && <div className="shrink-0"><WhiteboardButton onOpen={onOpenWhiteboard} /></div>}
    </div>
  </section>;
}
