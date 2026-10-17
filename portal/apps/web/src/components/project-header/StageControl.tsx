import { StageDot } from "../atoms";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/reui/select";
import type { useStages } from "../../lib/stages";
import type { ProjectDetail } from "../../lib/project-data";

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

export function StageOption({ stageKey, label }: { stageKey: ProjectDetail["stageKey"]; label: string }) {
  return <span className="inline-flex items-center gap-[var(--space-2)]">
    <StageDot stageKey={stageKey} />
    <span>{label}</span>
  </span>;
}

export function StageControl({ project, currentStageKey, stages, contractEnabled, pending, disabledReason, onMove }: {
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
      <SelectContent data-testid="project-stage-options" className="w-auto min-w-(--anchor-width) max-w-(--available-width)">
        {stages.filter((stage) => stage.active || stage.key === currentStageKey).map((stage) => (
          <SelectItem className="max-[721px]:min-h-[44px]" value={stage.key} key={stage.key} disabled={!stage.active && stage.key === currentStageKey}>
            <StageOption stageKey={stage.key} label={stage.label} />
          </SelectItem>
        ))}
        {!current && <SelectItem className="max-[721px]:min-h-[44px]" value={currentStageKey}><StageOption stageKey={currentStageKey} label={labelFor(currentStageKey)} /></SelectItem>}
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

