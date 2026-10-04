import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CollectionKind } from "@quincy/shared";
import type { WorkspaceTab } from "../lib/workspace-tab";
import { StageDot } from "./atoms";
import { InternalLink } from "./InternalLink";
import { useDashboardReturnLink, useInProjectSheet } from "./quincy/ProjectSheet";
import { CopyProjectLinkButton } from "./quincy/CopyProjectLinkButton";
import { ProjectShowIn } from "./quincy/ProjectShowIn";
import { ProjectTeamCombobox } from "./ProjectTeamCombobox";
import { ProjectHeaderDeadline } from "./ProjectHeaderDeadline";
import { ProjectHeaderDropbox } from "./ProjectHeaderDropbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/reui/tabs";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/reui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/reui/tooltip";
import { PresentationIcon } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/reui/select";
import { cn, formatUnreadCount } from "../lib/utils";
import { HEADER_READONLY_VALUE, HEADER_TEXT_LINK, READONLY_GROUP_FOCUS } from "./project-header-popover";
import { useStages } from "../lib/stages";
import { useCapabilities } from "../lib/capabilities";
import type { ProjectDetail } from "../lib/project-data";

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

function collectionLabel(value: string) {
  return value === "raw" ? "RAW" : value.charAt(0).toUpperCase() + value.slice(1);
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

// Stage select styling — carried over from ProjectOverviewRail.tsx (#202), restyled from a
// native <select> onto the ReUI select's SelectTrigger <button> (#203). `disabled:opacity-100`
// keeps the rail's sunken disabled treatment instead of also fading it. #213 follow-up: `w-fit`,
// not the rail's `w-full` — in the stacked and two-per-line layouts the other three triggers are
// content-sized, and a lone full-width select read as a different kind of control.
const STAGE_SELECT =
  "w-fit max-w-full cursor-pointer text-left justify-between disabled:opacity-100 " +
  "min-h-[44px] " /* WCAG 2.5.5 Enhanced target, not a spacing token */ +
  "pl-[14px] pr-[14px] py-[9px] " +
  "rounded-[var(--radius-sm)] border-solid border-[length:var(--border-width-hair)] " +
  "bg-card border-border text-foreground " +
  "[font:var(--weight-regular)_var(--text-sm)/1.2_var(--font-sans)] " +
  "transition-[background-color,color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] " +
  "hover:not-disabled:bg-secondary hover:not-disabled:border-border-hover " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2 " +
  "disabled:text-foreground-secondary disabled:bg-surface-sunken disabled:border-border disabled:cursor-not-allowed";

function StageOption({ stageKey, label }: { stageKey: ProjectDetail["stageKey"]; label: string }) {
  return <span className="inline-flex items-center gap-[var(--space-2)]">
    <StageDot stageKey={stageKey} />
    <span>{label}</span>
  </span>;
}

function StageControl({ project, currentStageKey, stages, contractEnabled, pending, disabledReason, onMove }: {
  project: ProjectDetail;
  currentStageKey: ProjectDetail["stageKey"];
  stages: ReturnType<typeof useStages>["stages"];
  contractEnabled: boolean;
  pending: boolean;
  disabledReason?: string | null;
  onMove?: (stageKey: ProjectDetail["stageKey"]) => void;
}) {
  const current = stages.find((item) => item.key === currentStageKey);
  const unavailable = disabledReason ?? (!contractEnabled ? "Stage movement is temporarily unavailable." : null);
  // Keep an already-focused select focusable after a command-level 503 so the
  // workspace can return focus to the same control while exposing the reason.
  // The contract-off state remains a genuinely disabled control.
  const disabled = pending || (!contractEnabled && !disabledReason);
  const labelFor = (key: ProjectDetail["stageKey"]) => stages.find((item) => item.key === key)?.label ?? key;
  const reasonId = `project-stage-reason-${project.id}`;
  return <div className="grid gap-[var(--space-1)]">
    <Select
      value={currentStageKey}
      disabled={disabled}
      readOnly={Boolean(unavailable) && !disabled}
      onValueChange={(next) => {
        if (next == null || unavailable || next === currentStageKey) return;
        const stage = stages.find((item) => item.key === next);
        if (!stage?.active) return;
        onMove?.(next as ProjectDetail["stageKey"]);
      }}
    >
      <SelectTrigger
        id={`project-stage-${project.id}`}
        data-focus-key={`rail-stage:${project.id}`}
        aria-label="Move project Stage"
        aria-busy={pending || undefined}
        aria-disabled={unavailable ? "true" : undefined}
        // #206: the reason must be described, not just visually adjacent — only wired when a
        // reason is actually shown below, since an absent target id would be worse than none.
        aria-describedby={unavailable ? reasonId : undefined}
        className={STAGE_SELECT}
      >
        <SelectValue>{() => <StageOption stageKey={currentStageKey} label={labelFor(currentStageKey)} />}</SelectValue>
      </SelectTrigger>
      {/* #325: options are nowrap, so the registry's `w-(--anchor-width)` clipped a long Stage
          ("Awaiting RAW · Smoke"). Never narrower than the trigger, never wider than the viewport. */}
      <SelectContent className="w-auto min-w-(--anchor-width) max-w-(--available-width)">
        {stages.filter((stage) => stage.active || stage.key === currentStageKey).map((stage) => (
          <SelectItem value={stage.key} key={stage.key} disabled={!stage.active && stage.key === currentStageKey}>
            <StageOption stageKey={stage.key} label={stage.label} />
          </SelectItem>
        ))}
        {!current && <SelectItem value={currentStageKey}><StageOption stageKey={currentStageKey} label={labelFor(currentStageKey)} /></SelectItem>}
      </SelectContent>
    </Select>
    {/* #213 (Sol): the Stage column is `max-content`, so an unconstrained reason (75–89 characters)
        would size the column to the sentence and push the row past 1280. `width: 0` removes it from
        the column's intrinsic size; `min-width: 100%` then lets it wrap at the select's width. */}
    {unavailable && <span id={reasonId} className="block mt-[var(--space-1)] [width:0] [min-width:100%]
                     [font:var(--weight-regular)_var(--text-2xs)/var(--leading-normal)_var(--font-sans)]
                     text-foreground-secondary">{unavailable}</span>}
  </div>;
}

/** #455: which write was refused as archived, if any (the latch's source; it also says which read-only group focus returns to). */
type ArchivedLatch = null | "stage" | "deadline" | "dropbox";

export function ProjectHeader({
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
  collaborationUnread = 0,
  workspaceTabRefs,
  onStageMove,
  stageMovePending = false,
  stageMoveDisabledReason = null,
  onOpenWhiteboard,
}: {
  project: ProjectDetail;
  /** #498: opens the Project whiteboard. Offered only once the Workspace has confirmed collaboration access. */
  onOpenWhiteboard?: () => void;
  activeTab: WorkspaceTab;
  availableTabs: CollectionKind[];
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
  const { can } = useCapabilities();
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
    const target = { stage: stageGroupRef, deadline: deadlineGroupRef, dropbox: dropboxGroupRef }[flip.source].current;
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
  // The strip scrolls horizontally on phones and opens at scrollLeft 0, so a selected tab past the
  // fold (Collaboration is last and the default) would be out of view. `nearest` on both axes keeps
  // the page itself from scrolling vertically.
  const tabsRef = useRef<HTMLDivElement>(null);
  // One stable callback per tab for the component's lifetime: a fresh ref callback every render makes
  // Base UI's trigger re-run its own ref registration (a state update), which loops. A `useRef` Map,
  // not `useMemo`, because React may discard a memo; the registry prop is read through a ref.
  const tabRefCallbacks = useRef(new Map<WorkspaceTab, (element: HTMLButtonElement | null) => void>());
  const workspaceTabRefsRef = useRef(workspaceTabRefs);
  workspaceTabRefsRef.current = workspaceTabRefs;
  const tabRef = (tab: WorkspaceTab) => {
    let callback = tabRefCallbacks.current.get(tab);
    if (!callback) {
      callback = (element) => {
        const refs = workspaceTabRefsRef.current?.current;
        if (!refs) return;
        if (element) refs.set(tab, element);
        else refs.delete(tab);
      };
      tabRefCallbacks.current.set(tab, callback);
    }
    return callback;
  };
  useEffect(() => {
    const selected = tabsRef.current?.querySelector<HTMLElement>('[data-testid="project-overview-tab"][aria-selected="true"]');
    if (typeof selected?.scrollIntoView === "function") selected.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTab]);

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

    {/* The entry button sits beside the scroller, not inside it: at phone width the tabs scroll sideways and it must stay in view. */}
    <div className="flex min-w-0 items-center gap-[var(--space-2)]">
    {/* The scroller clips its overflow on both axes: the padding (cancelled by the negative margin) keeps the focus ring and the count chip inside it. */}
    <div className="project-header__tabs -my-[var(--space-1)] flex min-w-0 flex-1 items-center gap-[var(--space-2)] p-[var(--space-1)]" ref={tabsRef}>
      <Tabs value={activeTab} onValueChange={(next) => { if (typeof next === "string" && next !== activeTab) onActiveTabChange(next as WorkspaceTab); }}>
        <TabsList variant="line" aria-label="Workspace">
          {availableTabs.map((tab) => { const collection = project.collections.find((item) => item.kind === tab); return (
            <TabsTrigger key={tab} value={tab} ref={tabRef(tab)} data-testid="project-overview-tab" className="gap-[var(--space-2)]">
              {collectionLabel(tab)}
              {/* #213: the active tab's count is the filled ink badge, the rest stay muted (prototype 2a). */}
              <Badge variant={tab === activeTab ? "default" : "primary-light"} size="sm" className="[font-family:var(--font-mono)] [font-variant-numeric:tabular-nums]">{collection ? collection.receivedCount : "—"}</Badge>
            </TabsTrigger>); })}
          <TabsTrigger value="collaboration" id="project-workspace-tab-collaboration" aria-controls="project-workspace-panel-collaboration" ref={tabRef("collaboration")} data-testid="project-overview-tab" className="gap-[var(--space-2)]">
            Collaboration
            {collaborationUnread > 0 && <>
              <Badge variant="destructive" size="sm" aria-hidden="true" data-testid="project-collaboration-tab-unread">{formatUnreadCount(collaborationUnread)}</Badge>
              <span className="sr-only">, {collaborationUnread} unread comment{collaborationUnread === 1 ? "" : "s"}</span>
            </>}
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
    {onOpenWhiteboard && <div className="shrink-0"><WhiteboardButton onOpen={onOpenWhiteboard} /></div>}
    </div>
  </section>;
}
