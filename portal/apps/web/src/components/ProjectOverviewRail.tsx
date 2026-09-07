import type { CollectionKind } from "@quincy/shared";
import { ChevronDown, RefreshCw } from "lucide-react";
import { StatusBadge } from "./atoms";
import { InternalLink } from "./InternalLink";
import { ProjectTeamControl } from "./ProjectTeamControl";
import { ProjectDeadlineControl } from "./ProjectDeadlineControl";
import { buttonClasses } from "./ui/button";
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

const RAIL_SECTION_LABEL =
  "rail__section-label mb-[var(--space-3)] " +
  "[font:var(--weight-regular)_var(--text-xs)/1.2_var(--font-sans)] " +
  "uppercase tracking-[var(--tracking-wide)] text-foreground";

const RAIL_KV_KEY =
  "k [font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] " +
  "uppercase tracking-[var(--tracking-wide)] text-foreground-secondary";

const RAIL_KV_VALUE =
  "vv [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] " +
  "text-foreground [overflow-wrap:anywhere]";

// ProjectOverviewRail.tsx — module scope
const STAGE_SELECT =
  "w-full appearance-none cursor-pointer text-left " +
  "min-h-[44px] " /* WCAG 2.5.5 Enhanced target, not a spacing token */ +
  "pl-[14px] pr-[var(--space-7)] py-[9px] " +
  "rounded-[var(--radius-sm)] border-solid border-[length:var(--border-width-hair)] " +
  "bg-card border-border text-foreground " +
  "[font:var(--weight-regular)_var(--text-sm)/1.2_var(--font-sans)] " +
  "transition-[background-color,color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] " +
  "hover:not-disabled:bg-secondary hover:not-disabled:border-border-hover " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2 " +
  "disabled:text-foreground-secondary disabled:bg-surface-sunken disabled:border-border disabled:cursor-not-allowed";

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
  return <div className="stage-control grid gap-[var(--space-1)]">
    <div className="rail-kv grid gap-[var(--space-1)] py-[var(--space-2)]">
      <span className={RAIL_KV_KEY}>Stage</span>
      <span className={RAIL_KV_VALUE}><StatusBadge stageKey={project.stageKey} /></span>
    </div>
    <label className="sr-only" htmlFor={`project-stage-${project.id}`}>Move project Stage</label>
    <div className="relative">
      <select id={`project-stage-${project.id}`} data-focus-key={`rail-stage:${project.id}`} aria-label="Move project Stage" value={currentStageKey} disabled={disabled} aria-disabled={unavailable ? "true" : undefined} aria-busy={pending || undefined} className={STAGE_SELECT} onChange={(event) => {
        const next = event.target.value as ProjectDetail["stageKey"];
        if (!unavailable && next !== currentStageKey) onMove?.(next);
      }}>
        {stages.filter((stage) => stage.active || stage.key === currentStageKey).map((stage) => <option value={stage.key} key={stage.key} disabled={!stage.active && stage.key === currentStageKey}>{stage.label}</option>)}
        {!current && <option value={currentStageKey}>{currentStageKey}</option>}
      </select>
      <ChevronDown aria-hidden="true"
        className="pointer-events-none absolute right-[var(--space-3)] top-1/2 -translate-y-1/2
                   size-[var(--space-3)] stroke-[1.5] text-foreground" />
    </div>
    {unavailable && <span className="stage-control__message block mt-[var(--space-1)]
                     [font:var(--weight-regular)_var(--text-2xs)/var(--leading-normal)_var(--font-sans)]
                     text-foreground-secondary">{unavailable}</span>}
  </div>;
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

  return <aside className="rail p-[var(--space-6)] max-[721px]:p-[var(--space-4)]" aria-label="Project Overview">
    <div className={cn("project-overview__heading hidden max-[721px]:block", RAIL_SECTION_LABEL)}>Project Overview</div>
    <section
      className="rail__sec project-overview__header
                 pt-0 pb-[var(--space-5)] max-[721px]:pb-[var(--space-4)]
                 [border-bottom-style:solid] border-b-[length:var(--border-width-rule)] border-b-primary"
      aria-labelledby="project-overview-property"
    >
      <h2 id="project-overview-property"
          className="[font:var(--type-h3)] tracking-[var(--tracking-tight)] text-foreground [text-wrap:pretty]">
        {project.street}
      </h2>
      <div className="mt-[var(--space-2)]
                      [font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)]
                      uppercase tracking-[var(--tracking-wide)] text-foreground-secondary">
        {[project.suburb, project.postcode].filter(Boolean).join(" · ")}
      </div>
    </section>

    <section className="rail__sec py-[var(--space-5)] max-[721px]:py-[var(--space-4)]
                        [border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border
                        last:border-b-0" aria-labelledby="project-overview-production">
      <div className={RAIL_SECTION_LABEL} id="project-overview-production">Production</div>
      {canMoveStage ? <StageControl project={project} currentStageKey={currentStageKey} stages={stages} contractEnabled={project.contractEnabled} pending={stageMovePending} disabledReason={stageMoveDisabledReason} onMove={onStageMove} /> : <div className="rail-kv grid gap-[var(--space-1)] py-[var(--space-2)]"><span className={RAIL_KV_KEY}>Stage</span><span className={RAIL_KV_VALUE}><StatusBadge stageKey={project.stageKey} /></span></div>}
      <div className="rail-kv grid gap-[var(--space-1)] py-[var(--space-2)]"><span className={RAIL_KV_KEY}>Shoot</span><span className={RAIL_KV_VALUE}>{date(project.shootDate)}</span></div>
      <ProjectDeadlineControl projectId={project.id} schedule={project.deadlineSchedule} canEdit={canEdit} />
      {canEdit && <InternalLink className={buttonClasses("secondary", { className: "rail__edit w-full mt-[var(--space-4)] min-h-[44px]" })} to={`/projects/${encodeURIComponent(project.id)}/edit`}>Edit details</InternalLink>}
    </section>

    <section className="rail__sec py-[var(--space-5)] max-[721px]:py-[var(--space-4)]
                        [border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border
                        last:border-b-0" aria-labelledby="project-overview-team">
      <div className={RAIL_SECTION_LABEL} id="project-overview-team">Team</div>
      <ProjectTeamControl projectId={project.id} members={project.members} canEdit={canEdit} />
    </section>

    <section className="rail__sec py-[var(--space-5)] max-[721px]:py-[var(--space-4)]
                        [border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border
                        last:border-b-0" aria-labelledby="project-overview-client">
      <div className={RAIL_SECTION_LABEL} id="project-overview-client">Client</div>
      <div className="rail-kv grid gap-[var(--space-1)] py-[var(--space-2)]"><span className={RAIL_KV_KEY}>Agency</span><span className={RAIL_KV_VALUE}>{project.agencyName ?? "—"}</span></div>
      <div className="rail-kv grid gap-[var(--space-1)] py-[var(--space-2)]"><span className={RAIL_KV_KEY}>Agent</span><span className={RAIL_KV_VALUE}>{project.agentName ?? "—"}</span></div>
    </section>

    {project.productionNotes && <section className="rail__sec py-[var(--space-5)] max-[721px]:py-[var(--space-4)]
                        [border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border
                        last:border-b-0" aria-labelledby="project-overview-notes">
      <div className={RAIL_SECTION_LABEL} id="project-overview-notes">Production notes</div>
      <p className="m-0 [white-space:pre-wrap]
                    [font:var(--weight-regular)_var(--text-sm)/var(--leading-relaxed)_var(--font-body-serif)]
                    text-foreground-secondary">{project.productionNotes}</p>
    </section>}

    <section className="rail__sec py-[var(--space-5)] max-[721px]:py-[var(--space-4)]
                        [border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border
                        last:border-b-0" aria-labelledby="project-overview-collections">
      <div className={RAIL_SECTION_LABEL} id="project-overview-collections">Collections</div>
      <div className="filterlist grid gap-[var(--space-1)]">{availableTabs.map((tab) => {
        const collection = project.collections.find((item) => item.kind === tab);
        const isActive = activeTab === tab;
        return <button
          key={tab} type="button" aria-pressed={isActive} data-testid="project-overview-tab"
          className={cn(
            "frow flex w-full items-center justify-between gap-[var(--space-3)] text-left cursor-pointer",
            "min-h-[44px] " /* WCAG 2.5.5 Enhanced target, not a spacing token */,
            "pl-[var(--space-3)] pr-[var(--space-3)] py-[var(--space-2)]",
            "rounded-none border-0 [border-left-style:solid] border-l-[length:var(--border-width-bold)]",
            "[font:var(--weight-regular)_var(--text-xs)/1.2_var(--font-sans)] uppercase tracking-[var(--tracking-wide)]",
            "transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
            "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid",
            "focus-visible:outline-ring focus-visible:outline-offset-[-2px]",
            isActive
              ? "border-l-primary bg-secondary text-foreground"
              : "border-l-transparent bg-transparent text-foreground-secondary hover:bg-secondary hover:text-foreground",
          )}
          onClick={() => onActiveTabChange(tab)}
        >
          <span>{collectionLabel(tab)}</span>
          <span className="cnt [font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-mono)]
                           [font-variant-numeric:tabular-nums] text-foreground-secondary"
          >{collection ? collection.receivedCount : "—"}</span>
        </button>;
      })}</div>
    </section>

    {canUpload && (hasRawFolder || canAdminBackend) && <section className="rail__sec py-[var(--space-5)] max-[721px]:py-[var(--space-4)]
                        [border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border
                        last:border-b-0" aria-labelledby="project-overview-dropbox">
      <div className={RAIL_SECTION_LABEL} id="project-overview-dropbox">Dropbox</div>
      <button
        type="button" disabled={isSyncing} aria-busy={isSyncing || undefined} data-testid="dropbox-sync"
        className={buttonClasses("secondary", { className: "dropcard w-full min-h-[44px]" })}
        onClick={onSyncDropbox}
      >
        <RefreshCw aria-hidden="true" className="size-[var(--space-4)] shrink-0 stroke-[1.5]" />
        <span>{isSyncing ? "Syncing Dropbox…" : "Sync from Dropbox"}</span>
      </button>
      {autohdrBlocked && (
        <p role="status" className="mt-[var(--space-2)] m-0
             [font:var(--weight-regular)_var(--text-2xs)/var(--leading-normal)_var(--font-sans)]
             uppercase tracking-[var(--tracking-wide)] text-[color:var(--signal-caution-text)]">Blocked</p>
      )}
    </section>}
  </aside>;
}
