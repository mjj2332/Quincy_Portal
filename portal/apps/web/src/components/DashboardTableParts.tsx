import { createContext, useContext, useState } from "react";
import { ChevronRight } from "lucide-react";
import { formatSydneyCivil, type Role } from "@quincy/shared";
import { Button } from "./reui/button";
import { CoverMedia } from "./board/card";
import { ProjectDeadlineCell, type ProjectDeadlineView } from "./ProjectDeadlineCell";
import { LateChip } from "./quincy/LateChip";
import { StageLabel } from "./quincy/StageLabel";
import { SHELL_AWARE_SHIFT_AVOIDANCE, shellAwarePopupPadding } from "../lib/date-time-field";
import type { ProjectAppearance, StageGroupAppearance } from "../lib/dashboard-project-appearance";
import type { TableGroup } from "../lib/dashboard-table-model";
import type { PipelineStage } from "../lib/stages";
import type { ProjectSummary } from "../lib/kanban-interaction";
import { cn } from "../lib/utils";

/**
 * #923: the pieces the Dashboard Table's grid (`DashboardTable.tsx`, frames 4b/4c) and its phone list
 * (`TablePhoneList.tsx`, frame 4g) both draw, so the two never drift: the 44x30 thumb, the Deadline with
 * its due-today dot and late chip, and a group's toggle row. Every late, due-today and done fact comes in
 * as an appearance from `lib/dashboard-project-appearance.ts`; nothing here derives one.
 */

/** The rows the grid and the phone list draw: a Project, or a group holding its Projects as sub-rows. */
export type ProjectRowData = { kind: "project"; id: string; project: ProjectSummary };
export type GroupRowData = { kind: "group"; id: string; group: TableGroup; stageKey: string | null; appearance: StageGroupAppearance; subRows: ProjectRowData[] };
export type TableRowData = ProjectRowData | GroupRowData;

export type CellContextValue = {
  role: Role;
  canPrioritize: boolean;
  canEditDeadline: boolean;
  pendingOrdering: ReadonlySet<string>;
  terminal: boolean;
  onPriorityChange: (project: ProjectSummary, priority: number | null) => void;
  projectHrefFor: (projectId: string) => string;
  stages: readonly Pick<PipelineStage, "key" | "label">[];
  appearanceOf: (project: ProjectSummary) => ProjectAppearance;
  isGroupOpen: (key: string) => boolean;
  toggleGroup: (key: string) => void;
};

/**
 * The volatile values the cells read. They travel by context, NOT by closing over them in the
 * column definitions: the grid renders `columnDef.cell` as a component, so a column array rebuilt
 * on every change of `onPriorityChange` (a fresh function each Dashboard render), `pendingOrdering`
 * or `now` would hand React a new component type per cell and REMOUNT every row, losing focus, an
 * open Deadline popover and a failed-cover retry on any refetch or clock tick. The columns are built
 * once (`DashboardTable.tsx`); the phone list reads the same context.
 */
export const CellContext = createContext<CellContextValue | null>(null);

export function useCells(): CellContextValue {
  const value = useContext(CellContext);
  if (!value) throw new Error("DashboardTable cells render inside DashboardTable");
  return value;
}

/** The Project's suburb line (frame 4b `.pn small`): the suburb, else the postcode. */
export function projectPlace(project: ProjectSummary): string {
  return project.suburb?.trim() || project.postcode?.trim() || "Location pending";
}

/** The 44x30 cover thumb (frames 4b/4g `.cv.th`). `onFailedChange` lets the caller offer a retry. */
export function ProjectThumb({ project, retryToken, onFailedChange }: { project: ProjectSummary; retryToken: number; onFailedChange: (failed: boolean) => void }) {
  return (
    <span className="block h-7.5 w-11 shrink-0 overflow-hidden rounded-sm bg-[var(--ink-800)]">
      {/* `!`: `.project-cover-placeholder` (unlayered app.css) sets a Board-card font size that would clip in this box. */}
      <CoverMedia project={project} retryToken={retryToken} onFailedChange={onFailedChange} placeholderClassName="!text-[length:var(--text-sm)]" />
    </span>
  );
}

/** A failed cover's retry, sitting above the row link's overlay. */
export function useCoverRetry() {
  const [failed, setFailed] = useState(false);
  const [token, setToken] = useState(0);
  const retry = (
    failed ? (
      <Button type="button" size="xs" variant="secondary" className="relative z-[1] mt-[var(--space-2)]" onClick={() => { setFailed(false); setToken((current) => current + 1); }}>
        Retry cover image
      </Button>
    ) : null
  );
  return { token, setFailed, retry };
}

function deadlineViewOf(project: ProjectSummary, appearance: ProjectAppearance): ProjectDeadlineView | null {
  if (project.deadlineAt === null) return null;
  return {
    at: new Date(project.deadlineAt).toISOString(),
    localCivil: project.deadlineLocalCivil ?? formatSydneyCivil(project.deadlineAt),
    // The Portal rule (#427), from the appearance module: delivered and archived Projects are never late.
    overdue: appearance.lateness.late,
  };
}

/**
 * The Deadline (frames 4b/4g `.dl`): a dot before today's Deadline, the shared editable cell, then the late
 * chip with `lateLabel`'s wording. Only an editable trigger rides above the row link's overlay.
 */
export function ProjectDeadline({ project, appearance, canEditDeadline, terminal, role }: { project: ProjectSummary; appearance: ProjectAppearance; canEditDeadline: boolean; terminal: boolean; role: Role }) {
  const canEdit = canEditDeadline && project.stageKey !== "delivered" && !project.archivedAt;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-[var(--space-2)] gap-y-[var(--space-1)]">
      {appearance.dueToday && (
        <span data-testid="project-table-due-today" className="inline-flex shrink-0 items-center">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-foreground" />
          <span className="sr-only">Due today</span>
        </span>
      )}
      <div className={cn("min-w-0", canEdit && project.deadlineAt !== null && "relative z-[1]")}>
        <ProjectDeadlineCell
          projectId={project.id}
          street={project.street}
          deadline={deadlineViewOf(project, appearance)}
          textClassName="!text-[length:var(--text-sm)] tabular-nums"
          canEdit={canEdit}
          disabled={terminal}
          role={role}
          testIdPrefix="project-table"
          overdueInName
          emptyLabel="No deadline"
          popupCollisionAvoidance={SHELL_AWARE_SHIFT_AVOIDANCE}
          popupCollisionPadding={shellAwarePopupPadding}
        />
      </div>
      {appearance.lateLabel && <LateChip>{appearance.lateLabel}</LateChip>}
    </div>
  );
}

/**
 * A group's toggle (frame 4b `.grp`, 4g `.pgh`): chevron, the Stage swatch and name (a Client group has no
 * swatch), the count, then "N late". `stageKey` is null for a Client group.
 */
export function GroupToggle({ label, stageKey, appearance, open, onToggle }: { label: string; stageKey: string | null; appearance: StageGroupAppearance; open: boolean; onToggle: () => void }) {
  return (
    <div data-testid="project-table-group" data-table-row="group" data-open={open} className="flex min-w-0 items-center gap-[var(--space-2)]">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        className="min-w-0 gap-[var(--space-2)] pointer-coarse:min-h-[44px] max-[721px]:min-h-[44px]"
        data-testid="project-table-group-trigger"
        onClick={onToggle}
      >
        <ChevronRight aria-hidden="true" className={cn("size-4 shrink-0 text-foreground-secondary transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none", open && "rotate-90")} />
        {stageKey === null
          ? <span data-testid="project-table-group-label" className="truncate text-sm font-normal">{label}</span>
          : <span data-testid="project-table-group-label" className="contents"><StageLabel stageKey={stageKey} label={label} className="font-normal" /></span>}
        <span data-testid="project-table-group-count" className="font-mono text-xs text-foreground-secondary tabular-nums">{appearance.count}</span>
      </Button>
      {appearance.lateCount > 0 && <LateChip data-testid="project-table-group-late">{`${appearance.lateCount} late`}</LateChip>}
    </div>
  );
}

/** "Oldest late: N days" (frame 4b, under the Deadline column), or nothing when no row is late. */
export function oldestLateText(appearance: StageGroupAppearance): string | null {
  if (appearance.oldestDaysLate === null) return null;
  if (appearance.oldestDaysLate <= 0) return "Oldest late: today";
  return `Oldest late: ${appearance.oldestDaysLate} ${appearance.oldestDaysLate === 1 ? "day" : "days"}`;
}
