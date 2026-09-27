/**
 * #255: a stage's colour swatch, the one square both the Gantt's stage legend (`GanttLegend` in
 * `ProductionGantt.tsx`) and the filters bar's Stage options (`ProductionGanttFiltersBar.tsx`) draw
 * beside a stage label. Decorative: the label beside it carries the meaning. The colour comes from
 * the caller's entry (`stageOptionsWithColor` / `ganttLegendEntries`), never recomputed here.
 */
export function StageSwatch({ color }: { color: string }) {
  return <span aria-hidden="true" className="size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: color }} />;
}
