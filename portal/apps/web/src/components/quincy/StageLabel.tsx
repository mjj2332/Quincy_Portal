import { stageTone } from "../../lib/dashboard-appearance";
import { cn } from "../../lib/utils";
import { StageToneSwatch } from "./StageKeyRow";

/**
 * #923: a Stage's cell in the Table, and the group and column headers of the Table and Board (frames 4b, 4e,
 * 4g `.sw` + label). The Stage swatch drawn from the appearance module's tone, then the sentence-case label at
 * 14px. The Admin-only `editing_autohdr` transport key draws as Editing with a "· autoHDR" suffix at 12px.
 * `label` is the Stage's display name (from the Stage definitions); the tone comes from `stageKey` alone.
 */
export function StageLabel({ stageKey, label, className }: { stageKey: string | null | undefined; label: string; className?: string }) {
  const tone = stageTone(stageKey);
  return (
    <span data-testid="stage-label" data-stage={tone.stage} className={cn("inline-flex min-w-0 items-center gap-[var(--space-2)] text-sm text-foreground", className)}>
      <StageToneSwatch tone={tone} />
      <span className="truncate">{label}</span>
      {stageKey === "editing_autohdr" && <span className="shrink-0 text-xs text-muted-foreground">· autoHDR</span>}
    </span>
  );
}
