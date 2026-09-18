import type { CollectionKind } from "@quincy/shared";
import { StageDot, StatusBadge } from "./atoms";
import { InternalLink } from "./InternalLink";
import { ProjectTeamCombobox } from "./ProjectTeamCombobox";
import { ProjectHeaderDeadline } from "./ProjectHeaderDeadline";
import { ProjectHeaderDropbox } from "./ProjectHeaderDropbox";
import { buttonClasses } from "./quincy/Button";
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

const HEADER_SECTION_LABEL =
  "mb-[var(--space-3)] " +
  "[font:var(--weight-regular)_var(--text-xs)/1.2_var(--font-sans)] " +
  "uppercase tracking-[var(--tracking-wide)] text-foreground";

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
  return <div className="grid gap-[var(--space-1)]">
    <div className="grid gap-[var(--space-1)] py-[var(--space-2)]">
      <span className={HEADER_KV_KEY}>Stage</span>
    </div>
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
        aria-describedby={unavailable ? `project-stage-reason-${project.id}` : undefined}
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
    {unavailable && <span id={`project-stage-reason-${project.id}`} className="block mt-[var(--space-1)]
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
        {canEdit && <InternalLink className={buttonClasses("secondary", { className: "min-h-[44px]" })} to={`/projects/${encodeURIComponent(project.id)}/edit`}>Edit details</InternalLink>}
      </div>
      {project.productionNotes && <p className={cn("project-header__notes", "m-0 [white-space:pre-wrap]",
                    "[font:var(--weight-regular)_var(--text-sm)/var(--leading-relaxed)_var(--font-body-serif)]",
                    "text-foreground-secondary")}>{project.productionNotes}</p>}
    </div>

    <div className="project-header__controls">
      <section aria-labelledby="project-overview-production">
        <div className={HEADER_SECTION_LABEL} id="project-overview-production">Production</div>
        {canMoveStage ? <StageControl project={project} currentStageKey={currentStageKey} stages={stages} contractEnabled={project.contractEnabled} pending={stageMovePending} disabledReason={stageMoveDisabledReason} onMove={onStageMove} /> : <div className="grid gap-[var(--space-1)] py-[var(--space-2)]"><span className={HEADER_KV_KEY}>Stage</span><span className={HEADER_KV_VALUE}><StatusBadge stageKey={project.stageKey} /></span></div>}
        <ProjectHeaderDeadline projectId={project.id} schedule={project.deadlineSchedule} canEdit={canEdit} />
      </section>

      <section aria-labelledby="project-overview-team">
        <div className={HEADER_SECTION_LABEL} id="project-overview-team">Team</div>
        <ProjectTeamCombobox projectId={project.id} members={project.members} canEdit={canEdit} />
      </section>

      {canUpload && (hasRawFolder || canAdminBackend || Boolean(project.monitoredRawFolder)) && <section aria-labelledby="project-overview-dropbox">
        <div className={HEADER_SECTION_LABEL} id="project-overview-dropbox">Dropbox</div>
        <ProjectHeaderDropbox project={project} isSyncing={isSyncing} autohdrBlocked={autohdrBlocked} onSyncDropbox={onSyncDropbox} />
      </section>}
    </div>

    <div className="project-header__tabs">
      <Tabs value={activeTab} onValueChange={(next) => { if (typeof next === "string" && next !== activeTab) onActiveTabChange(next as CollectionKind); }}>
        <TabsList variant="line" aria-label="Collections">
          {availableTabs.map((tab) => { const collection = project.collections.find((item) => item.kind === tab); return (
            <TabsTrigger key={tab} value={tab} data-testid="project-overview-tab" className="gap-[var(--space-2)]">
              {collectionLabel(tab)}
              <Badge variant="primary-light" size="sm" className="[font-family:var(--font-mono)] [font-variant-numeric:tabular-nums]">{collection ? collection.receivedCount : "—"}</Badge>
            </TabsTrigger>); })}
        </TabsList>
      </Tabs>
    </div>
  </section>;
}
