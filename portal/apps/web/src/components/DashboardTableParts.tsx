import { createContext, useContext } from "react";
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
  /** The studio's civil year at the Table's `now`: a Shoot date in it drops its year (frame 4b). */
  currentYear: number;
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

/** The 44x30 cover thumb (frames 4b/4g `.cv.th`). `onFailedChange` lets the caller offer a retry; `failed` draws the initial. */
export function ProjectThumb({ project, retryToken, failed, onFailedChange }: { project: ProjectSummary; retryToken: number; failed: boolean; onFailedChange: (failed: boolean) => void }) {
  return (
    <span data-testid="project-thumb" className="block h-7.5 w-11 shrink-0 overflow-hidden rounded-sm bg-[var(--ink-800)]">
      {/* `!`: `.project-cover-placeholder` (unlayered app.css) sets a Board-card font size that would clip in this box. */}
      <CoverMedia project={project} retryToken={retryToken} failed={failed} onFailedChange={onFailedChange} placeholderClassName="!text-[length:var(--text-sm)]" />
    </span>
  );
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
 * The shared trigger pulls 4px to the start (`CELL_TRIGGER`'s `-ml-1`) but caps itself at `max-w-full`, so
 * it fell 4px short of its own text and truncated the date with room to spare (#923 pass, row 15). Its cap
 * here adds the pull back. Scoped to the Dashboard's Deadline; the Gantt's cells keep `CELL_TRIGGER` as is.
 */
const DEADLINE_TRIGGER = "max-w-[calc(100%+var(--space-1))]";

/**
 * The phone list (4g `.prow`, ~86pt tall) draws the Deadline as a 20px line, but `CELL_TRIGGER`'s 44px min-height at
 * <=721px and on touch made the row ~113pt (#923 review round 3). Here the box is the 20px text line and the touch
 * target is an invisible `after:`, the way `reui/button`'s `chip` size draws its hit area, so it adds no layout height.
 *
 * The `after:` starts on the Deadline line and grows only downward, into the row's 12px bottom padding: 20 + 12 =
 * 32px tall. A symmetric 12px reached up over the suburb line (4px gap, then the suburb), so a low tap on the suburb
 * opened the date popover instead of the Project (#923 polish). 44px would have to cross into the next row's top
 * padding, the same fault one row down, so 32px (above WCAG 2.5.8's 24px) is the tallest that stays in this row.
 * Width keeps `CELL_TRIGGER`'s 44px minimum. A cover retry under the line sits in that 12px gap and paints above it.
 */
const PHONE_DEADLINE_TRIGGER = "relative min-h-5 pointer-coarse:min-h-5 max-[721px]:min-h-5 after:absolute after:inset-x-0 after:top-0 after:-bottom-[var(--space-3)] after:content-['']";

/**
 * The Deadline (frames 4b/4g `.dl`): a dot before today's Deadline, the shared editable cell, then the late
 * chip with `lateLabel`'s wording. Only an editable trigger rides above the row link's overlay.
 *
 * In the grid (4b) it is one line: the chip keeps the date's line, and the date truncates, with a title,
 * if the column is ever too narrow. The phone list (4g) passes `wrap`, so the chip drops under the date
 * instead of cutting it.
 */
export function ProjectDeadline({ project, appearance, canEditDeadline, terminal, role, wrap = false }: { project: ProjectSummary; appearance: ProjectAppearance; canEditDeadline: boolean; terminal: boolean; role: Role; wrap?: boolean }) {
  const canEdit = canEditDeadline && project.stageKey !== "delivered" && !project.archivedAt;
  return (
    <div
      data-testid="project-table-deadline-line"
      className={cn("flex min-w-0 items-center gap-x-[var(--space-2)]", wrap ? "flex-wrap gap-y-[var(--space-1)]" : "flex-nowrap")}
    >
      {appearance.dueToday && (
        <span data-testid="project-table-due-today" className="inline-flex shrink-0 items-center">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-foreground" />
          <span className="sr-only">Due today</span>
        </span>
      )}
      {/* On the phone line the wrapper is a 20px flex box: as a block, its inherited 24px line box made the line
          24px whatever the 20px trigger or chip measured (#923 polish, measured on the served build). */}
      <div className={cn("min-w-0", wrap && "flex leading-5", canEdit && project.deadlineAt !== null && "relative z-[1]")}>
        <ProjectDeadlineCell
          projectId={project.id}
          street={project.street}
          deadline={deadlineViewOf(project, appearance)}
          textClassName="!text-[length:var(--text-sm)] tabular-nums"
          triggerClassName={cn(DEADLINE_TRIGGER, wrap && PHONE_DEADLINE_TRIGGER)}
          titled
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
      {appearance.lateLabel && <LateChip size={wrap ? "line" : "default"}>{appearance.lateLabel}</LateChip>}
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
        // Sentence case, as in 4b / 4g: the Button's default is the uppercase eyebrow (#923 pass, row 8).
        className="min-w-0 gap-[var(--space-2)] normal-case tracking-[var(--tracking-normal)] pointer-coarse:min-h-[44px] max-[721px]:min-h-[44px]"
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
