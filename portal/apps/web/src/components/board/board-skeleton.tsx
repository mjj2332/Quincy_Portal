import type { StageKey } from "@quincy/shared";
import type { PipelineStage } from "../../lib/stages";
import { columnLabelKey, stageTone } from "../../lib/dashboard-appearance";
import { Skeleton } from "../reui/skeleton";
import { StageLabel } from "../quincy/StageLabel";
import { StageToneSwatch } from "../quincy/StageKeyRow";
import { COLUMN_SIZE_CLASS, COLUMN_SURFACE_CLASS, RAIL_SIZE_CLASS, semanticStageKey } from "./board-layout";

/**
 * Frame 4h's loading Board, which the Dashboard mounts while the one Projects query loads (#923 S5): a column
 * shell per Stage (its label when the Stages are known) holding two skeleton compact cards in the card's own
 * shape. Collapsed Stages draw as rails, so the Board does not jump when it lands; a phone shows the first
 * column only, as the Board does.
 *
 * Its own module, not `board.tsx`: the Dashboard renders it before any Board exists, so it must not depend on
 * the Board module (which a lazy split or a test can replace) being there.
 */
export function BoardSkeleton({ stages, collapsedStageKeys = [] }: { stages?: readonly PipelineStage[]; collapsedStageKeys?: readonly StageKey[] }) {
  const shells: readonly (PipelineStage | null)[] = stages ?? [null, null, null, null];
  return (
    <div role="status" data-testid="board-skeleton" aria-busy="true" className="flex min-h-0 w-full flex-1 gap-[var(--space-4)] overflow-hidden">
      <span className="sr-only">Loading projects</span>
      {shells.map((stage, index) => {
        if (stage && collapsedStageKeys.includes(semanticStageKey(stage.key))) {
          return (
            <div key={stage.key} aria-hidden="true" data-testid="board-skeleton-column" className={`${RAIL_SIZE_CLASS} ${COLUMN_SURFACE_CLASS} flex flex-col items-center gap-[var(--space-3)] py-[var(--space-3)] max-[721px]:hidden`}>
              <StageToneSwatch tone={stageTone(stage.key)} />
            </div>
          );
        }
        return (
          <div key={stage?.key ?? index} aria-hidden="true" data-testid="board-skeleton-column" className={`${COLUMN_SIZE_CLASS} ${COLUMN_SURFACE_CLASS} flex flex-col ${index > 0 ? "max-[721px]:hidden" : ""}`}>
            <div className="flex h-11 shrink-0 items-center gap-[var(--space-2)] ps-[var(--space-3)] pe-[var(--space-2)] border-b border-b-border">
              {stage ? <StageLabel stageKey={columnLabelKey(stage.key)} label={stage.label} /> : <Skeleton className="h-3 w-24" />}
              <Skeleton className="h-3 w-10" />
            </div>
            <div className="flex flex-col gap-[var(--space-3)] p-[var(--space-3)]">
              {[0, 1].map((card) => (
                <div key={card} data-testid="board-skeleton-card" className="flex flex-col gap-[var(--space-2)] border border-[length:var(--border-width-hair)] border-border bg-card p-[var(--space-3)]">
                  <div className="flex items-center gap-2.5">
                    <Skeleton className="h-7.5 w-11 shrink-0" data-testid="board-skeleton-thumb" />
                    <div className="flex min-w-0 flex-1 flex-col gap-[var(--space-1)]">
                      <Skeleton className="h-3 w-[70%]" />
                      <Skeleton className="h-2.5 w-1/2" />
                    </div>
                  </div>
                  <Skeleton className="h-2.5 w-[60%]" />
                  <Skeleton className="h-2.5 w-[90%]" />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
