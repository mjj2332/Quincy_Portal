import type { CSSProperties } from "react";
import type { StagePattern } from "../../lib/stage-colors";

/**
 * #255: a stage's colour swatch, the one square both the Gantt's stage legend (`GanttLegend` in
 * `ProductionGantt.tsx`) and the filters bar's Stage options (`ProductionGanttFiltersBar.tsx`) draw
 * beside a stage label. Decorative: the label beside it carries the meaning. The colour comes from
 * the caller's entry (`stageOptionsWithColor` / `ganttLegendEntries`), never recomputed here.
 *
 * #257: `pattern="hatch"` (Edited review) keeps the stage colour at FULL strength — so at 10px it
 * still reads as the same hue as RAW review (design review: a tinted swatch read as a different,
 * paler colour and fell under 3:1) — with light `--bg-surface` stripes over it as the second cue.
 * Solid swatches are unchanged.
 */
export function StageSwatch({ color, pattern = null }: { color: string; pattern?: StagePattern | null }) {
  if (pattern === "hatch") {
    return (
      <span
        aria-hidden="true"
        data-testid="stage-swatch"
        data-pattern="hatch"
        className="size-2.5 shrink-0 rounded-[2px] bg-(--swatch-color) bg-[repeating-linear-gradient(135deg,transparent_0_2.5px,color-mix(in_oklab,var(--bg-surface)_55%,transparent)_2.5px_4px)]"
        style={{ "--swatch-color": color } as CSSProperties}
      />
    );
  }
  return <span aria-hidden="true" data-testid="stage-swatch" className="size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: color }} />;
}
