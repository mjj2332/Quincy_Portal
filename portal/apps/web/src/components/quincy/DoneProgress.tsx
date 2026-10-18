import type { CSSProperties } from "react";
import { Progress } from "@/components/reui/progress";
import type { StageTone } from "../../lib/dashboard-appearance";
import type { ProjectAppearance } from "../../lib/dashboard-project-appearance";
import { cn } from "../../lib/utils";

/**
 * #923: a Project's "N of M done" over a 4px bar tinted to the Stage tone (frames 4b/4e `.prog`). `done` is
 * `projectAppearance(...).done` (or `stageGroupAppearance(...).done` for a group header): `{ done, total, label }`.
 * A `null` `done` with `known` true is a Project with no Subtasks, drawn "No tasks"; with `known` false (the API
 * sent no `checklist`) it draws nothing, because unknown is never "No tasks" (#923 D1).
 */
export function DoneProgress({
  done,
  tone,
  known = true,
  className,
}: {
  done: ProjectAppearance["done"];
  tone: StageTone;
  /** The Project's `checklist` was present. Leave true where the caller renders only after checking. */
  known?: boolean;
  className?: string;
}) {
  if (!done) {
    return known ? (
      <span data-testid="done-progress" className={cn("text-xs text-muted-foreground", className)}>
        No tasks
      </span>
    ) : null;
  }
  return (
    <div data-testid="done-progress" className={cn("flex min-w-0 flex-col gap-1", className)} style={{ "--progress-tone": tone.color } as CSSProperties}>
      <span className="text-xs text-muted-foreground tabular-nums">{done.label}</span>
      <Progress variant="tone" value={(done.done / done.total) * 100} aria-label={done.label} />
    </div>
  );
}
