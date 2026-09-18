import type { CollectionKind } from "@quincy/shared";
import { StageDot, StatusBadge } from "./atoms";
import { InternalLink } from "./InternalLink";
import { ProjectTeamCombobox } from "./ProjectTeamCombobox";
import { ProjectHeaderDeadline } from "./ProjectHeaderDeadline";
import { ProjectHeaderDropbox } from "./ProjectHeaderDropbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/reui/tabs";
import { Badge } from "@/components/reui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/reui/select";
import { cn } from "../lib/utils";
import { useStages } from "../lib/stages";
import { useCapabilities } from "../lib/capabilities";
import type { ProjectDetail } from "../lib/project-data";

function date(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value))
    : "Shoot date pending";
}

function collectionLabel(value: string) {
  return value === "raw" ? "RAW" : value.charAt(0).toUpperCase() + value.slice(1);
}

// #213: prototype 2a's "Edit details" is an underlined text link in the identity row, not a
// button. `buttonClasses` deliberately carries `no-underline`, so this is its own small idiom;
// inline-flex + min-height keeps the 44px target the rest of the header holds.
const EDIT_DETAILS_LINK =
  "inline-flex items-center min-h-[44px] " /* WCAG 2.5.5 Enhanced target, not a spacing token */ +
  "underline [text-underline-offset:3px] decoration-border hover:decoration-foreground " +
  "[font:var(--weight-regular)_var(--text-xs)/1.2_var(--font-sans)] text-foreground " +
  "transition-[text-decoration-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] " +
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
// keeps the rail's sunken disabled treatment instead of also fading it.
const STAGE_SELECT =
  "w-full cursor-pointer text-left justify-between disabled:opacity-100 " +
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
      <SelectContent>
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
  onStageMove,
  stageMovePending = false,
  stageMoveDisabledReason = null,
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
  onStageMove?: (stageKey: ProjectDetail["stageKey"]) => void;
  stageMovePending?: boolean;
  stageMoveDisabledReason?: string | null;
}) {
  const { presentationStageKey, stages } = useStages();
  const { can } = useCapabilities();
  const currentStageKey = presentationStageKey(project.stageKey);
  const canMoveStage = can("moveProjectStage") && !project.archivedAt;

  return <section className="project-header" aria-label="Project Overview" data-testid="project-header">
    <div className="project-header__identity">
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
        {canEdit && <InternalLink className={EDIT_DETAILS_LINK} to={`/projects/${encodeURIComponent(project.id)}/edit`}>Edit details</InternalLink>}
      </div>
      {project.productionNotes && <p className={cn("project-header__notes", "m-0 [white-space:pre-wrap]",
                    "[font:var(--weight-regular)_var(--text-sm)/var(--leading-relaxed)_var(--font-body-serif)]",
                    "text-foreground-secondary")}>{project.productionNotes}</p>}
    </div>

    {/* #213: prototype 2a's flat control row — four cells, one small label each, no section
        headings. The cells are plain layout divs (a generic div cannot carry a name, #206 lesson);
        every control inside already has its own accessible name. */}
    <div className="project-header__controls">
      <div className="project-header__control">
        <span className={HEADER_KV_KEY}>Stage</span>
        {canMoveStage ? <StageControl project={project} currentStageKey={currentStageKey} stages={stages} contractEnabled={project.contractEnabled} pending={stageMovePending} disabledReason={stageMoveDisabledReason} onMove={onStageMove} /> : <span className={cn(HEADER_KV_VALUE, "py-[var(--space-2)]")}><StatusBadge stageKey={project.stageKey} /></span>}
      </div>

      <div className="project-header__control">
        <span className={HEADER_KV_KEY}>Team</span>
        <ProjectTeamCombobox projectId={project.id} members={project.members} canEdit={canEdit} />
      </div>

      <div className="project-header__control">
        <span className={HEADER_KV_KEY}>Deadline</span>
        <ProjectHeaderDeadline projectId={project.id} schedule={project.deadlineSchedule} canEdit={canEdit} />
      </div>

      {canUpload && (hasRawFolder || canAdminBackend || Boolean(project.monitoredRawFolder)) && <div className="project-header__control">
        <span className={HEADER_KV_KEY}>Dropbox</span>
        <ProjectHeaderDropbox project={project} isSyncing={isSyncing} autohdrBlocked={autohdrBlocked} onSyncDropbox={onSyncDropbox} />
      </div>}
    </div>

    <div className="project-header__tabs">
      <Tabs value={activeTab} onValueChange={(next) => { if (typeof next === "string" && next !== activeTab) onActiveTabChange(next as CollectionKind); }}>
        <TabsList variant="line" aria-label="Collections">
          {availableTabs.map((tab) => { const collection = project.collections.find((item) => item.kind === tab); return (
            <TabsTrigger key={tab} value={tab} data-testid="project-overview-tab" className="gap-[var(--space-2)]">
              {collectionLabel(tab)}
              {/* #213: the active tab's count is the filled ink badge, the rest stay muted (prototype 2a). */}
              <Badge variant={tab === activeTab ? "default" : "primary-light"} size="sm" className="[font-family:var(--font-mono)] [font-variant-numeric:tabular-nums]">{collection ? collection.receivedCount : "—"}</Badge>
            </TabsTrigger>); })}
        </TabsList>
      </Tabs>
    </div>
  </section>;
}
