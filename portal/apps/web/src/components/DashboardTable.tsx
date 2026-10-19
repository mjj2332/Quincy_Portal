import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTable, type ColumnDef, type ColumnVisibilityState, type ExpandedState, type Row, type SortingState } from "@tanstack/react-table";
import { formatSydneyCivil, type Role } from "@quincy/shared";
import { Badge } from "./reui/badge";
import { DataGrid, DataGridContainer, dataGridFeatures, type DataGridFeatures } from "./reui/data-grid/data-grid";
import { DataGridColumnHeader } from "./reui/data-grid/data-grid-column-header";
import { DataGridScrollArea } from "./reui/data-grid/data-grid-scroll-area";
import { DataGridTable } from "./reui/data-grid/data-grid-table";
import { Frame, FramePanel } from "./reui/frame";
import { Button } from "./reui/button";
import { useCoverRetry } from "./board/card";
import { Skeleton } from "./reui/skeleton";
import { InternalLink } from "./InternalLink";
import { AvatarStack } from "./quincy/AvatarStack";
import { DoneProgress } from "./quincy/DoneProgress";
import { EmptyState } from "./quincy/EmptyState";
import { PriorityStars } from "./quincy/PriorityStars";
import { StageLabel } from "./quincy/StageLabel";
import { CellContext, GroupToggle, ProjectDeadline, ProjectThumb, oldestLateText, projectPlace, useCells, type CellContextValue, type GroupRowData, type ProjectRowData, type TableRowData } from "./DashboardTableParts";
import { TablePhoneList } from "./TablePhoneList";
import { formatDashboardDate } from "../screens/dashboard-helpers";
import { useCapabilities } from "../lib/capabilities";
import { projectAppearance, stageGroupAppearance } from "../lib/dashboard-project-appearance";
import {
  DEFAULT_TABLE_SORTING,
  NO_CLIENT_LABEL,
  TABLE_COLUMN_IDS,
  TABLE_NARROW_QUERY,
  TABLE_COLUMN_LABELS,
  columnVisibleToRole,
  columnsDroppedToFit,
  defaultCollapsedGroups,
  groupTableRows,
  hideDelivered,
  sortTableRows,
  stageDisplayLabel,
  tableCountLabel,
  type HideableColumnId,
  type TableColumnId,
  type TableGroupBy,
} from "../lib/dashboard-table-model";
import type { ProjectSummary } from "../lib/kanban-interaction";
import { rawCounts } from "../lib/raw-counts";
import { useStages, type ProjectStageKey } from "../lib/stages";
import { columnLabelKey } from "../lib/dashboard-appearance";
import { useMediaQuery } from "../lib/use-media-query";
import { useOwnWidth } from "../lib/use-own-width";
import { cn } from "../lib/utils";

/**
 * The Dashboard's Table view (#431), composed on the ReUI `data-grid` (TanStack Table v9, vendored
 * into `reui/data-grid/`) inside the `frame` surface (ADR 0014: Frame, then FramePanel). #923 gives it
 * the round 4 look: frames 4b (grouped by Stage, 52px rows), 4c (flat and dense, 44px rows, the count
 * footer) and, at <=721px, 4g (`TablePhoneList`).
 *
 * ## Appearance
 * Every late, due-today, done and Stage-tone fact comes from `lib/dashboard-project-appearance.ts`
 * (`projectAppearance` per row, `stageGroupAppearance` per group) against the `now` the Dashboard
 * passes, and nothing here derives one again.
 *
 * ## Data and sort
 * `GET /api/projects` returns every matching row with no sort parameter, so the sort is the
 * client's: `sortTableRows` orders the rows BEFORE grouping, and the grid is told `manualSorting` +
 * `manualPagination` (without the second, v9's pagination row model would show 10 rows). A viewer
 * starts on Deadline ascending (4b/4c); a header runs asc, desc, cleared, and cleared is the
 * server's order. Table semantics, not grid: `<table>`, `th[aria-sort]`, no cell selection.
 *
 * ## Opening a Project
 * The row is NEVER opened through the vendor's `onRowClick` (a bare `<tr onClick>`: no keyboard,
 * no href, and a click inside a popover portal bubbles to it through the React tree). The Project
 * cell holds a real `InternalLink`; its `::after` stretches over the row (`tr` is `relative`), so a
 * plain click anywhere on the row follows the link, Enter on the link works, and modifier or middle
 * clicks stay native. The stars, the Deadline trigger and the cover-retry button sit in
 * `relative z-[1]` wrappers ABOVE that overlay and are not inside the `<a>`, so they need no
 * `stopPropagation`.
 *
 * ## Group by
 * ONE table under one header (4b): each group is a tree row of the grid (`getSubRows`), its
 * Projects its sub-rows, and a collapsed group is simply not expanded. The group row fills the same
 * columns as a Project row: the toggle under Project, "Oldest late" under Deadline, the summed task
 * progress under Progress. Delivered starts collapsed under Stage; a change of Group by starts that
 * Group by's defaults again.
 *
 * ## Columns
 * `hiddenColumns` is the viewer's Display choice; a column the viewer's role cannot see (Priority
 * and Progress for an External Editor) is hidden on top of it at render, never stored. So is a column
 * that does not fit the panel's measured width (`columnsDroppedToFit`, #923 pass round 2): Deadline and
 * Project always stay. The grid reports those width-dropped columns (`onWidthDroppedColumnsChange`) so the
 * Display menu can say why a chosen column is not on screen (owner decision, #923); the phone list and the
 * all-hidden empty state draw no columns, so they report none. Progress has no header sort (4b draws none on it).
 */

type Column = ColumnDef<DataGridFeatures, TableRowData>;

type CellProps = { row: Row<DataGridFeatures, TableRowData> };

/** A column's cell: the Project renderer for a Project row, the group renderer (or nothing) for a group row. */
function cellOf(Project: (props: { project: ProjectSummary }) => ReactNode, Group?: (props: { data: GroupRowData }) => ReactNode): Column["cell"] {
  return function TableCell({ row }: CellProps) {
    const data = row.original;
    if (data.kind === "group") return Group ? <Group data={data} /> : null;
    return <Project project={data.project} />;
  };
}

/** 4b `.proj`: the 44x30 thumb, then the street at 14px sans and the suburb at 12px. */
function ProjectCell({ project }: { project: ProjectSummary }) {
  const { projectHrefFor, appearanceOf } = useCells();
  // One line per row (#923 pass, row 7): the retry is an icon after the text, the Archived badge sits on
  // the street's line, and each text truncates with its full value as a title.
  const cover = useCoverRetry("shrink-0", { iconOnly: true });
  const place = projectPlace(project);
  return (
    <div data-testid="project-table-project" data-late={appearanceOf(project).lateness.late} className="flex min-w-0 items-center gap-[var(--space-3)]">
      <ProjectThumb project={project} retryToken={cover.token} failed={cover.failed} onFailedChange={cover.setFailed} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-[var(--space-2)]">
          <InternalLink
            to={projectHrefFor(project.id)}
            data-testid="project-table-row-link"
            title={project.street}
            // The overlay: ::after covers the row (`tr` is `relative`), so the whole row is the link.
            className="block min-w-0 truncate text-sm text-inherit no-underline after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:outline-[length:var(--border-width-bold)] focus-visible:after:outline-solid focus-visible:after:outline-ring after:-outline-offset-2 focus-visible:after:-outline-offset-2"
          >
            {project.street}
          </InternalLink>
          {project.archivedAt && <Badge variant="secondary" size="sm" className="shrink-0" data-testid="project-table-archived">Archived</Badge>}
        </div>
        <span className="block truncate text-xs text-foreground-secondary" title={place}>{place}</span>
      </div>
      {cover.retry}
    </div>
  );
}

function GroupProjectCell({ data }: { data: GroupRowData }) {
  const { isGroupOpen, toggleGroup } = useCells();
  return <GroupToggle label={data.group.label} stageKey={data.stageKey} appearance={data.appearance} open={isGroupOpen(data.group.key)} onToggle={() => toggleGroup(data.group.key)} />;
}

function StageCell({ project }: { project: ProjectSummary }) {
  const { stages } = useCells();
  return <StageLabel stageKey={project.stageKey} label={stageDisplayLabel(project.stageKey, stages)} />;
}

function ClientCell({ project }: { project: ProjectSummary }) {
  const client = project.agencyName || NO_CLIENT_LABEL;
  const agent = project.agentName || "Agent pending";
  return (
    <span className="block min-w-0">
      <span className="block truncate text-sm" title={client}>{client}</span>
      <span className="block truncate text-xs text-foreground-secondary" title={agent}>{agent}</span>
    </span>
  );
}

function ShootDateCell({ project }: { project: ProjectSummary }) {
  // Frame 4b's "Tue 20 Oct" (#923 pass round 2, row 11). One line: a long legacy value truncates, with a title.
  const { currentYear } = useCells();
  const text = formatDashboardDate(project.shootDate, currentYear);
  return <span className="block truncate text-sm tabular-nums" title={text}>{text}</span>;
}

function DeadlineCell({ project }: { project: ProjectSummary }) {
  const { appearanceOf, canEditDeadline, terminal, role } = useCells();
  return <ProjectDeadline project={project} appearance={appearanceOf(project)} canEditDeadline={canEditDeadline} terminal={terminal} role={role} />;
}

function GroupDeadlineCell({ data }: { data: GroupRowData }) {
  const text = oldestLateText(data.appearance);
  return text ? <span className="text-xs text-foreground-secondary">{text}</span> : null;
}

function ProgressCell({ project }: { project: ProjectSummary }) {
  const { appearanceOf } = useCells();
  const appearance = appearanceOf(project);
  return <DoneProgress done={appearance.done} tone={appearance.tone} known={project.checklist !== undefined} />;
}

function GroupProgressCell({ data }: { data: GroupRowData }) {
  return data.appearance.done ? <span className="text-xs text-foreground-secondary tabular-nums">{data.appearance.done.label}</span> : null;
}

function EditorsCell({ project }: { project: ProjectSummary }) {
  return <AvatarStack people={project.editors ?? []} personNoun="Editor" emptyLabel="No Editor assigned" />;
}

function PriorityCell({ project }: { project: ProjectSummary }) {
  const { canPrioritize, terminal, pendingOrdering, onPriorityChange } = useCells();
  const editable = canPrioritize && !terminal && !project.archivedAt;
  return (
    // Interactive stars ride above the row link's overlay; read-only ones let the click through. The
    // read-only form carries card padding (`px/pb-[--space-3]`), which the negative margins cancel.
    <div className={cn("w-max max-w-full", editable ? "relative z-[1]" : "-mx-[var(--space-3)] -mb-[var(--space-3)]")} data-testid="project-table-priority">
      <PriorityStars
        priority={project.priority}
        street={project.street}
        canPrioritize={editable}
        pending={pendingOrdering.has(project.id)}
        onPriorityChange={(next) => onPriorityChange(project, next)}
      />
    </div>
  );
}

function RawCell({ project }: { project: ProjectSummary }) {
  const raw = rawCounts(project);
  return (
    <span className="text-sm tabular-nums">
      <span aria-hidden="true" data-testid="project-table-raw">{raw.visible}</span>
      <span className="sr-only">{raw.spoken}</span>
    </span>
  );
}

/**
 * Column widths, padding included, from frame 4b's grid (#923 pass, row 6). The default columns (RAW
 * hidden) sum to 1260, inside the 1262px table at a 1440 viewport, so nothing scrolls there; below it
 * the Table drops columns in `TABLE_FIT_DROP_ORDER` until the rest fit (#923 pass round 2, row 5), so the
 * Deadline and its late chip show at 1024 and 768 without scrolling sideways. Priority keeps its 36px star hit cells (ADR 0003, #923 D4): five stars, its
 * 8px start and the table's 16px end edge make 204, not the frame's 92, and that width comes out of
 * Project and Client, the frame's two flexible columns. Deadline holds a date and its late chip on one
 * line ("Wed 30 Sep · 09:00" and "19 days late" measure ~212px with the trigger's inset); Shoot holds
 * "Wed 31 Dec 2025" (~96px). RAW received is not in the frame.
 */
const SIZES: Record<TableColumnId, number> = { address: 212, stage: 164, client: 128, shootDate: 104, deadline: 232, progress: 120, editors: 96, priority: 204, raw: 120 };

/**
 * The frame's 12px column gap, on the token scale: 8px each side (16px between columns) in place of the
 * grid's 12px, through the column's own `meta` so the shared grid is untouched. The table's outer
 * edges keep `EDGE_CELL`'s 16px.
 *
 * No vertical padding either: the grid's `py-2` plus a two-line cell (20px + 16px) needs 52px before the
 * row's hairline, so every row grew to 53 (#923 pass, row 7). Without it the content centres in the
 * row's own height, and the frame's border-box heights (4b 52px, 4c and `.grp` 44px) hold with the
 * hairline inside them.
 */
const CELL_X = "px-[var(--space-2)] py-0";
/** 4b's header: sentence-case 12px, not the Button's uppercase eyebrow (#923 pass, row 8). */
const HEADER_TYPE = "normal-case tracking-[var(--tracking-normal)] text-xs";

const CELLS: Record<TableColumnId, { value: (project: ProjectSummary) => unknown; cell: Column["cell"] }> = {
  address: { value: (project) => project.street, cell: cellOf(ProjectCell, GroupProjectCell) },
  stage: { value: (project) => project.stageKey, cell: cellOf(StageCell) },
  client: { value: (project) => project.agencyName, cell: cellOf(ClientCell) },
  shootDate: { value: (project) => project.shootDate, cell: cellOf(ShootDateCell) },
  deadline: { value: (project) => project.deadlineAt, cell: cellOf(DeadlineCell, GroupDeadlineCell) },
  progress: { value: (project) => project.checklist?.completed, cell: cellOf(ProgressCell, GroupProgressCell) },
  editors: { value: (project) => project.editors?.[0]?.name, cell: cellOf(EditorsCell) },
  priority: { value: (project) => project.priority, cell: cellOf(PriorityCell) },
  raw: { value: (project) => project.receivedCount, cell: cellOf(RawCell) },
};

const COLUMNS: Column[] = TABLE_COLUMN_IDS.map((id): Column => ({
  id,
  accessorFn: (data) => (data.kind === "project" ? CELLS[id].value(data.project) : undefined),
  header: ({ column }) => <DataGridColumnHeader column={column} title={TABLE_COLUMN_LABELS[id]} className={HEADER_TYPE} />,
  cell: CELLS[id].cell,
  size: SIZES[id],
  meta: { headerClassName: CELL_X, cellClassName: CELL_X },
  enableSorting: id !== "progress",
  enableHiding: id !== "address",
}));

const EDGE_CELL = "first:ps-[var(--space-4)] last:pe-[var(--space-4)]";
/** The 3px late edge (4b `.r-late`) on the row's first cell, keyed off the Project cell's `data-late`. */
const LATE_EDGE = "has-[[data-late=true]]:[&>td:first-child]:shadow-[inset_var(--border-width-rule)_0_0_var(--late)]";
/** A group row (4b `.grp`): 44px on the raised paper, the canvas paper once collapsed. */
const GROUP_ROW = "has-[[data-table-row=group]]:h-11 has-[[data-table-row=group]]:bg-muted has-[[data-table-row=group][data-open=false]]:bg-background";

const getSubRows = (data: TableRowData) => (data.kind === "group" ? data.subRows : undefined);
const getRowId = (data: TableRowData) => data.id;

function TableGrid({ data, grouped, sorting, onSortingChange, visibility, expanded }: {
  data: TableRowData[];
  grouped: boolean;
  sorting: SortingState;
  onSortingChange: (next: SortingState | ((current: SortingState) => SortingState)) => void;
  visibility: ColumnVisibilityState;
  expanded: ExpandedState;
}) {
  const table = useTable({
    features: dataGridFeatures,
    // The rows are already sorted and complete: v9 keeps its pagination row model unless told the
    // data is the page, and would show 10 rows.
    manualPagination: true,
    manualSorting: true,
    data,
    columns: COLUMNS,
    getRowId,
    getSubRows,
    getRowCanExpand: (row) => row.original.kind === "group",
    state: { sorting, columnVisibility: visibility, expanded },
    onSortingChange,
  });
  return (
    <DataGrid
      table={table}
      recordCount={data.length}
      emptyMessage="No projects in this view."
      tableLayout={{ rowBorder: true, headerBorder: true, width: "fixed", headerSticky: true, columnsResizable: false, columnsVisibility: false, columnsMovable: false, columnsPinnable: false }}
      tableClassNames={{
        edgeCell: EDGE_CELL,
        headerRow: "[&>th]:h-10 bg-background",
        headerSticky: "sticky top-0 z-20 bg-background",
        // `relative` is the containing block of the Project link's stretched ::after.
        bodyRow: cn("relative bg-card", grouped ? "h-13" : "h-11", LATE_EDGE, GROUP_ROW),
      }}
    >
      {/* Sticky: a flex-column chain (container, wrapper, Root) so the ScrollArea viewport is the
          scroller and the header sticks inside it. */}
      <DataGridContainer className="flex min-h-0 flex-1 flex-col">
        <DataGridScrollArea orientation="both" containerClassName="flex min-h-0 flex-1 flex-col" className="min-h-0 flex-1">
          <DataGridTable />
        </DataGridScrollArea>
      </DataGridContainer>
    </DataGrid>
  );
}

export type DashboardTableProps = {
  projects: ProjectSummary[];
  role: Role;
  groupBy: TableGroupBy;
  /** The viewer's Display choice; role-forced hiding is added on top at render. */
  hiddenColumns: readonly HideableColumnId[];
  /** The Priority capability AND an authorized Board map (the Dashboard folds both in). */
  canPrioritize: boolean;
  pendingOrdering: ReadonlySet<string>;
  terminal: boolean;
  onPriorityChange: (project: ProjectSummary, priority: number | null) => void;
  projectHrefFor: (projectId: string) => string;
  /** The Dashboard's clock (#923). Until it is passed, the current minute. */
  now?: number;
  /** The Display menu's "Show: Delivered Projects" (#923). Defaults to shown. */
  showDelivered?: boolean;
  /** Turns Delivered back on, for the empty state when Display hid every row. */
  onShowDelivered?: () => void;
  /** The viewer's chosen columns the grid leaves out for width right now (never stored), in column order. */
  onWidthDroppedColumnsChange?: (columns: readonly HideableColumnId[]) => void;
};

export function DashboardTable({ projects, role, groupBy, hiddenColumns, canPrioritize, pendingOrdering, terminal, onPriorityChange, projectHrefFor, now: givenNow, showDelivered = true, onShowDelivered, onWidthDroppedColumnsChange }: DashboardTableProps) {
  const { stages } = useStages();
  const { can } = useCapabilities();
  const canEditDeadline = can("editProject");
  const narrow = useMediaQuery(TABLE_NARROW_QUERY);
  // Floored to the minute when the Dashboard passes no clock, so an unrelated re-render keeps the memo.
  const now = givenNow ?? Math.floor(Date.now() / 60_000) * 60_000;
  const [sorting, setSorting] = useState<SortingState>(DEFAULT_TABLE_SORTING);
  // Collapsed groups belong to the Group by they were collapsed under; a change starts its defaults again.
  const [collapsed, setCollapsed] = useState<{ groupBy: TableGroupBy; keys: ReadonlySet<string> }>(() => ({ groupBy, keys: defaultCollapsedGroups(groupBy) }));
  if (collapsed.groupBy !== groupBy) setCollapsed({ groupBy, keys: defaultCollapsedGroups(groupBy) });
  const collapsedKeys = collapsed.groupBy === groupBy ? collapsed.keys : defaultCollapsedGroups(groupBy);

  // The panel's own width decides which of the viewer's columns fit (#923 pass round 2, row 5). Render-time
  // only: what drops for width is never written to `hiddenColumns`, so a wider screen shows them again.
  const panelRef = useRef<HTMLDivElement>(null);
  const panelWidth = useOwnWidth(panelRef);
  const { visibility, widthDropped } = useMemo(() => {
    const chosen = TABLE_COLUMN_IDS.filter((id) => columnVisibleToRole(id, role) && (id === "address" || !hiddenColumns.includes(id as HideableColumnId)));
    const dropped = columnsDroppedToFit(chosen, SIZES, panelWidth);
    return {
      visibility: Object.fromEntries(TABLE_COLUMN_IDS.map((id) => [id, chosen.includes(id) && !dropped.has(id)])) as ColumnVisibilityState,
      widthDropped: TABLE_COLUMN_IDS.filter((id): id is HideableColumnId => id !== "address" && dropped.has(id)),
    };
  }, [hiddenColumns, panelWidth, role]);

  const shown = useMemo(() => hideDelivered(projects, showDelivered), [projects, showDelivered]);
  const sorted = useMemo(() => sortTableRows(shown, sorting, stages), [shown, sorting, stages]);
  const groups = useMemo(() => groupTableRows(sorted, groupBy, stages), [groupBy, sorted, stages]);

  const appearances = useMemo(() => new Map(projects.map((project) => [project.id, projectAppearance(project, now)])), [now, projects]);
  const data = useMemo<TableRowData[]>(() => {
    const projectRow = (project: ProjectSummary): ProjectRowData => ({ kind: "project", id: project.id, project });
    if (groupBy === "none") return (groups[0]?.rows ?? []).map(projectRow);
    return groups.map((group) => ({
      kind: "group",
      id: `group:${group.key}`,
      group,
      // A Stage group's swatch; `editing_autohdr` draws as Editing, its label from the Stage definitions.
      stageKey: groupBy === "stage" ? columnLabelKey(group.key as ProjectStageKey) : null,
      appearance: stageGroupAppearance(group.rows, now),
      subRows: group.rows.map(projectRow),
    }));
  }, [groupBy, groups, now]);

  const expanded = useMemo<ExpandedState>(() => Object.fromEntries(groups.filter((group) => !collapsedKeys.has(group.key)).map((group) => [`group:${group.key}`, true])), [collapsedKeys, groups]);

  const cells = useMemo<CellContextValue>(() => ({
    role, canPrioritize, canEditDeadline, pendingOrdering, terminal, onPriorityChange, projectHrefFor, stages,
    appearanceOf: (project) => appearances.get(project.id) ?? projectAppearance(project, now),
    currentYear: Number(formatSydneyCivil(now).slice(0, 4)),
    isGroupOpen: (key) => !collapsedKeys.has(key),
    toggleGroup: (key) => {
      const keys = new Set(collapsedKeys);
      if (keys.has(key)) keys.delete(key); else keys.add(key);
      setCollapsed({ groupBy, keys });
    },
  }), [appearances, canEditDeadline, canPrioritize, collapsedKeys, groupBy, now, onPriorityChange, pendingOrdering, projectHrefFor, role, stages, terminal]);

  const allHidden = projects.length > 0 && shown.length === 0;
  // Only the grid draws columns; the phone list and the empty state report none. Keyed by value, so an
  // unrelated re-render (a new array of the same ids) never calls back.
  const reportedDropped = narrow || allHidden ? "" : widthDropped.join(",");
  useEffect(() => {
    onWidthDroppedColumnsChange?.(reportedDropped === "" ? [] : (reportedDropped.split(",") as HideableColumnId[]));
  }, [onWidthDroppedColumnsChange, reportedDropped]);
  useEffect(() => () => onWidthDroppedColumnsChange?.([]), [onWidthDroppedColumnsChange]);
  const footer = groupBy === "none" && !allHidden ? tableCountLabel({ shown: shown.length, total: projects.length }) : null;

  return (
    <section aria-label="Projects table" data-testid="dashboard-table" className="flex min-h-0 flex-1 flex-col">
      <CellContext.Provider value={cells}>
        <Frame dense className="min-h-0 flex-1">
          <FramePanel ref={panelRef} className="flex min-h-0 flex-col p-0">
            {allHidden ? (
              <EmptyState title="Delivered projects are hidden by Display.">
                {onShowDelivered && <Button type="button" variant="outline" size="sm" className="mt-[var(--space-4)]" onClick={onShowDelivered}>Show delivered projects</Button>}
              </EmptyState>
            ) : narrow ? (
              <TablePhoneList data={data} />
            ) : (
              <TableGrid data={data} grouped={groupBy !== "none"} sorting={sorting} onSortingChange={setSorting} visibility={visibility} expanded={expanded} />
            )}
            {footer && (
              <p data-testid="project-table-footer" className="m-0 border-t border-border bg-background px-[var(--space-4)] py-[var(--space-2)] text-xs text-foreground-secondary">{footer}</p>
            )}
          </FramePanel>
        </Frame>
      </CellContext.Provider>
    </section>
  );
}

/**
 * The Table's loading state (frame 4h, in the Table's own shape): a header bar and six rows of thumb,
 * two lines and a deadline bar; at <=721px the same rows read as the phone list. The Dashboard mounts it
 * while the projects query has no data (#923 S5). `label` is read by a screen reader only.
 */
export function TableSkeleton({ label = "Loading projects." }: { label?: string }) {
  return (
    <Frame dense role="status" data-testid="table-skeleton" className="min-h-0 flex-1">
      <span className="sr-only">{label}</span>
      <FramePanel aria-hidden="true" className="flex flex-col p-0">
        <div className="flex h-10 items-center gap-[var(--space-3)] border-b border-border bg-background px-[var(--space-4)] max-[721px]:hidden">
          <Skeleton className="h-2.5 w-24" />
          <Skeleton className="ms-auto h-2.5 w-16" />
        </div>
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} data-testid="table-skeleton-row" className="flex h-13 items-center gap-[var(--space-3)] border-b border-border bg-card px-[var(--space-4)] last:border-b-0">
            <Skeleton className="h-7.5 w-11 shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col gap-[var(--space-1)]">
              <Skeleton className="h-3 w-2/5" />
              <Skeleton className="h-2.5 w-1/4" />
            </div>
            <Skeleton className="h-2.5 w-28 max-[721px]:w-16" />
            <Skeleton className="h-2.5 w-20 max-[721px]:hidden" />
          </div>
        ))}
      </FramePanel>
    </Frame>
  );
}
