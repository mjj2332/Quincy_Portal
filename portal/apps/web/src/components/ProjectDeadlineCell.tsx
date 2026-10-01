/**
 * #431: the surface-neutral Deadline cell, moved out of `ProductionGanttProjectCells.tsx` so the
 * Gantt's Due column and the Dashboard Table's Deadline column share ONE editor path. Nothing here
 * is Gantt-specific: the Gantt keeps its own wrapper (the "Set deadline" / "Fix deadline" action
 * and its test ids) and passes `testIdPrefix="gantt"`, so its DOM and tests are unchanged.
 *
 * Editing reuses the Project page's own `ProjectDeadlineControl` whole, fed from the Project
 * detail, which loads only while the popover is open (`ProjectDetailGate`). Popover content mounts
 * only while open (no `keepMounted`): 100 rows never start 100 detail queries. The control's own
 * `invalidateProjectSurfaces(…, dashboard/gantt: true)` calls refresh every surface; 409, Clear and
 * Resume all stay inside `ProjectDeadlineControl`.
 */
import { useState, type ReactNode } from "react";
import type { GanttProjectRowDto, Role } from "@quincy/shared";
import { Notice } from "./quincy/Notice";
import { Button } from "./reui/button";
import { Popover, PopoverTrigger } from "./reui/popover";
import { Skeleton } from "./reui/skeleton";
import { ProjectDeadlineControl } from "./ProjectDeadlineControl";
import { deadlineTriggerText } from "./ProjectHeaderDeadline";
import { DateTimePopoverContent } from "./quincy/DateTimeField";
import { useProjectDetailQuery, type ProjectDetail } from "../lib/project-data";
import { cn } from "../lib/utils";

/** A real 44px hit area on coarse pointers and phones, compact on desktop. */
// `-ml-1` cancels the ghost button's `px-1` so the cell's text starts where its column header's does.
export const CELL_TRIGGER = "h-auto min-h-6 max-w-full justify-start -ml-1 px-1 normal-case tracking-[var(--tracking-normal)] pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px] max-[720px]:min-h-[44px] max-[720px]:min-w-[44px]";

/** The Deadline as a surface sees it: the instant, the studio wall-clock civil string, and overdue. */
export type ProjectDeadlineView = Pick<NonNullable<GanttProjectRowDto["deadline"]>, "at" | "localCivil" | "overdue">;

/**
 * Loads the Project detail behind a popover. Children render only once data exists: the Deadline
 * control seeds its draft once, at mount (`ProjectDeadlineControl.tsx`).
 */
export function ProjectDetailGate({ projectId, role, fallbackClassName, testIdPrefix, children }: { projectId: string; role: Role; fallbackClassName?: string; testIdPrefix: string; children: (detail: ProjectDetail) => ReactNode }) {
  const query = useProjectDetailQuery(projectId, true, false, role);
  if (query.data) return <>{children(query.data)}</>;
  if (query.isError) {
    return (
      <Notice data-testid={`${testIdPrefix}-project-detail-error`} role="alert" className={cn("flex items-center justify-between gap-[var(--space-3)]", fallbackClassName)}>
        <span>Project details could not be loaded.</span>
        <Button type="button" size="xs" variant="outline" onClick={() => void query.refetch()}>Retry</Button>
      </Notice>
    );
  }
  return (
    <div data-testid={`${testIdPrefix}-project-detail-loading`} role="status" aria-label="Loading project details" className={cn("grid gap-[var(--space-2)]", fallbackClassName)}>
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

export function ProjectDeadlineCell({ projectId, street, deadline, canEdit, disabled, role, emptyLabel = "No deadline", testIdPrefix, triggerClassName, textClassName, overdueInName = false }: {
  projectId: string;
  street: string;
  deadline: ProjectDeadlineView | null;
  canEdit: boolean;
  disabled: boolean;
  role: Role;
  /** The inert dash's accessible text when there is no Deadline. */
  emptyLabel?: string;
  /** Test ids are `<prefix>-deadline`, `<prefix>-deadline-trigger` and `<prefix>-project-detail-*`. */
  testIdPrefix: string;
  triggerClassName?: string;
  /** Font-size class applied to both the read-only text and the trigger, so the two match. */
  textClassName?: string;
  /** Adds "overdue" to the trigger's accessible name and a visually hidden word to the read-only text. */
  overdueInName?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (deadline === null) {
    // No Deadline: an inert dash.
    return <span data-testid={`${testIdPrefix}-deadline`} className="text-foreground-secondary">—<span className="sr-only">{emptyLabel}</span></span>;
  }
  const text = deadlineTriggerText(deadline.localCivil);
  const tone = deadline.overdue ? "text-signal-critical" : "text-foreground";
  const overdueWord = overdueInName && deadline.overdue;
  if (!canEdit) {
    return <time data-testid={`${testIdPrefix}-deadline`} dateTime={deadline.at} className={cn("truncate", tone, textClassName)}>{text}{overdueWord && <span className="sr-only"> (overdue)</span>}</time>;
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button type="button" size="xs" variant="ghost" className={cn(CELL_TRIGGER, tone, textClassName, triggerClassName)} />}
        data-testid={`${testIdPrefix}-deadline-trigger`}
        aria-label={`Deadline for ${street}: ${text}${overdueWord ? " (overdue)" : ""}`}
        disabled={disabled}
        onClick={(event: { stopPropagation: () => void }) => event.stopPropagation()}
      >
        <span className="truncate">{text}</span>
      </PopoverTrigger>
      {/* #422: the date-time popup mounts once the detail has loaded, after the popover opened, so
          Base UI's `initialFocus` (evaluated at open) found nothing: `focusOnMount` moves focus in
          the moment the popup mounts. The cached-detail case is covered by `initialFocus`. */}
      <DateTimePopoverContent label="Deadline">
        <ProjectDetailGate projectId={projectId} role={role} testIdPrefix={testIdPrefix} fallbackClassName="m-[var(--space-3)] w-[min(20rem,calc(100vw-4*var(--space-4)))]">
          {(detail) => <ProjectDeadlineControl projectId={projectId} schedule={detail.deadlineSchedule} canEdit onClose={() => setOpen(false)} focusOnMount />}
        </ProjectDetailGate>
      </DateTimePopoverContent>
    </Popover>
  );
}
