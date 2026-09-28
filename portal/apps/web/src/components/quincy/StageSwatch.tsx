import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { STAGE_HATCH_CLASS, type StagePattern } from "../../lib/stage-colors";

/**
 * #255: a stage's colour swatch, the one square both the Gantt's stage legend (`GanttLegend` in
 * `ProductionGantt.tsx`) and the filters bar's Stage options (`ProductionGanttFiltersBar.tsx`) draw
 * beside a stage label. Decorative: the label beside it carries the meaning. The colour comes from
 * the caller's entry (`stageOptionsWithColor` / `ganttLegendEntries`), never recomputed here.
 *
 * #257: `pattern="hatch"` (Edited review) draws the SAME hatch its Gantt bars carry
 * (`STAGE_HATCH_CLASS`), over a light tint of the colour instead of a solid fill, so the swatch
 * reads like the bar it keys. The hatch paints from `--gantt-event-color`, set inline here exactly
 * as the Gantt sets it on a bar. Solid swatches are unchanged.
 */
export function StageSwatch({ color, pattern = null }: { color: string; pattern?: StagePattern | null }) {
  if (pattern === "hatch") {
    return (
      <span
        aria-hidden="true"
        data-testid="stage-swatch"
        className={cn("size-2.5 shrink-0 rounded-[2px] bg-[color-mix(in_oklab,var(--gantt-event-color)_25%,transparent)]", STAGE_HATCH_CLASS)}
        style={{ "--gantt-event-color": color } as CSSProperties}
      />
    );
  }
  return <span aria-hidden="true" data-testid="stage-swatch" className="size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: color }} />;
}
