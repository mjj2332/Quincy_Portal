import { createContext, memo, useContext, useId, useMemo, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { useTable, type ColumnDef, type ColumnVisibilityState, type Row, type SortingState } from "@tanstack/react-table";
import { formatSydneyCivil, type Role } from "@quincy/shared";
import { Badge } from "./reui/badge";
import { Button } from "./reui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./reui/collapsible";
import { DataGrid, DataGridContainer, dataGridFeatures, type DataGridFeatures } from "./reui/data-grid/data-grid";
import { DataGridColumnHeader } from "./reui/data-grid/data-grid-column-header";
import { DataGridScrollArea } from "./reui/data-grid/data-grid-scroll-area";
import { DataGridTable } from "./reui/data-grid/data-grid-table";
import { Frame, FramePanel } from "./reui/frame";
import { StatusBadge } from "./atoms";
import { InternalLink } from "./InternalLink";
import { CoverMedia } from "./board/card";
import { ProjectDeadlineCell, type ProjectDeadlineView } from "./ProjectDeadlineCell";
import { AvatarStack } from "./quincy/AvatarStack";
import { Eyebrow } from "./quincy/Eyebrow";
import { PriorityStars } from "./quincy/PriorityStars";
import { formatDashboardDate } from "../screens/dashboard-helpers";
import { useCapabilities } from "../lib/capabilities";
import { isOverdueProject } from "../lib/dashboard-summary";
import {
  NO_CLIENT_LABEL,
  TABLE_COLUMN_IDS,
  TABLE_NARROW_QUERY,
  TABLE_COLUMN_LABELS,
  columnVisibleToRole,
  groupTableRows,
  sortTableRows,
  type HideableColumnId,
  type TableColumnId,
  type TableGroup,
  type TableGroupBy,
} from "../lib/dashboard-table-model";
import type { ProjectSummary } from "../lib/kanban-interaction";
import { rawCounts } from "../lib/raw-counts";
import { useStages } from "../lib/stages";
import { useMediaQuery } from "../lib/use-media-query";
import { cn } from "../lib/utils";

/**
 * The Dashboard's Table view (#431), composed on the ReUI `data-grid` (TanStack Table v9, vendored
 * into `reui/data-grid/`) inside the `frame` surface (ADR 0014: Frame, then FramePanel). It replaces
 * the hand-rolled List.
 *
 * ## Data and sort
 * `GET /api/projects` returns every matching row with no sort parameter, so the sort is the
 * client's: `sortTableRows` (`lib/dashboard-table-model.ts`) orders the rows BEFORE grouping, and
 * the grid is told `manualSorting` + `manualPagination` (without the second, v9's pagination row
 * model would show 10 rows). Header buttons run asc, desc, cleared; the server's order stays until
 * one is chosen. Table semantics, not grid: `<table>`, `th[aria-sort]`, no cell selection.
 *
 * ## Opening a Project
 * The row is NEVER opened through the vendor's `onRowClick` (a bare `<tr onClick>`: no keyboard,
 * no href, and a click inside a popover portal bubbles to it through the React tree). The Address
 * cell holds a real `InternalLink`; its `::after` stretches over the row (`tr` is `relative`), so a
 * plain click anywhere on the row follows the link, Enter on the link works, and modifier or middle
 * clicks stay native. The stars, the Deadline trigger and the cover-retry button sit in
 * `relative z-[1]` wrappers ABOVE that overlay and are not inside the `<a>`, so they need no
 * `stopPropagation`.
 *
 * ## Group by
 * One grid per group inside the one FramePanel (the data-grid-grouping-6 composition), so each
 * group repeats its column header. Sorting, column visibility and column widths are shared. A group
 * header is a Collapsible trigger inside an `<h3>`; every group starts expanded and the collapsed
 * set resets when Group by changes.
 *
 * ## Columns
 * `hiddenColumns` is the viewer's Display choice. Two things hide a column on top of it, computed
 * at render and never stored: a column the viewer's role cannot see (Priority for an External
 * Editor), and, at <=721px, everything except Address and Deadline.
 */

const NARROW_COLUMNS: readonly TableColumnId[] = ["address", "deadline"];

type Column = ColumnDef<DataGridFeatures, ProjectSummary>;

type CellContext = {
  role: Role;
  canPrioritize: boolean;
  canEditDeadline: boolean;
  pendingOrdering: ReadonlySet<string>;
  terminal: boolean;
  onPriorityChange: (project: ProjectSummary, priority: number | null) => void;
  projectHrefFor: (projectId: string) => string;
};

function location(project: ProjectSummary) {
  return [project.suburb, project.postcode].filter(Boolean).join(" · ") || "Location pending";
}

function deadlineViewOf(project: ProjectSummary): ProjectDeadlineView | null {
  if (project.deadlineAt === null) return null;
  return {
    at: new Date(project.deadlineAt).toISOString(),
    localCivil: project.deadlineLocalCivil ?? formatSydneyCivil(project.deadlineAt),
    // The Portal rule (#427): delivered and archived Projects are never overdue.
    overdue: isOverdueProject(project, Date.now()),
  };
}

function TableCover({ project, retryToken, onFailedChange }: { project: ProjectSummary; retryToken: number; onFailedChange: (failed: boolean) => void }) {
  return (
    <span className="block h-12 w-[72px] shrink-0 overflow-hidden bg-[var(--ink-800)] max-[721px]:h-[37px] max-[721px]:w-14">
      {/* `!`: `.project-cover-placeholder` (unlayered app.css) sets a Board-card font size that would clip in this box. */}
      <CoverMedia project={project} retryToken={retryToken} onFailedChange={onFailedChange} placeholderClassName="!text-[length:var(--text-lg)]" />
    </span>
  );
}

function AddressCell({ project, href }: { project: ProjectSummary; href: string }) {
  const [coverFailed, setCoverFailed] = useState(false);
  const [coverRetry, setCoverRetry] = useState(0);
  return (
    <div className="flex min-w-0 items-center gap-[var(--space-3)]">
      <TableCover project={project} retryToken={coverRetry} onFailedChange={setCoverFailed} />
      <div className="min-w-0 flex-1">
        <InternalLink
          to={href}
          data-testid="project-table-row-link"
          // The overlay: ::after covers the row (`tr` is `relative`), so the whole row is the link.
          className="block truncate font-[family-name:var(--font-display)] text-[length:var(--text-md)] tracking-[var(--tracking-tight)] text-inherit no-underline after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:outline-[length:var(--border-width-bold)] focus-visible:after:outline-solid focus-visible:after:outline-ring after:-outline-offset-2 focus-visible:after:-outline-offset-2"
        >
          {project.street}
        </InternalLink>
        <Eyebrow className="mt-[var(--space-1)] block truncate">{location(project)}</Eyebrow>
        {project.archivedAt && <Badge variant="secondary" size="sm" className="mt-[var(--space-1)]" data-testid="project-table-archived">Archived</Badge>}
        {coverFailed && (
          <Button
            type="button"
            size="xs"
            variant="secondary"
            className="relative z-[1] mt-[var(--space-2)]"
            onClick={() => { setCoverFailed(false); setCoverRetry((current) => current + 1); }}
          >
            Retry cover image
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The volatile values the cells read. They travel by context, NOT by closing over them in the
 * column definitions: the grid renders `columnDef.cell` as a component, so a column array rebuilt
 * on every change of `onPriorityChange` (a fresh function each Dashboard render) or
 * `pendingOrdering` would hand React a new component type per cell and REMOUNT every row, losing
 * focus, an open Deadline popover and a failed-cover retry on any refetch. The columns depend on
 * the width bucket alone.
 */
const CellContext = createContext<CellContext | null>(null);

function useCells(): CellContext {
  const value = useContext(CellContext);
  if (!value) throw new Error("DashboardTable cells render inside DashboardTable");
  return value;
}

function AddressCellRenderer({ row }: { row: Row<DataGridFeatures, ProjectSummary> }) {
  const { projectHrefFor } = useCells();
  return <AddressCell project={row.original} href={projectHrefFor(row.original.id)} />;
}

function StageCellRenderer({ row }: { row: Row<DataGridFeatures, ProjectSummary> }) {
  return <StatusBadge stageKey={row.original.stageKey} />;
}

function ClientCellRenderer({ row }: { row: Row<DataGridFeatures, ProjectSummary> }) {
  return (
    <span className="block min-w-0 text-[length:var(--text-sm)]">
      <span className="block truncate">{row.original.agencyName || NO_CLIENT_LABEL}</span>
      <span className="mt-[var(--space-1)] block truncate text-[length:var(--text-xs)] text-foreground-secondary">{row.original.agentName || "Agent pending"}</span>
    </span>
  );
}

function ShootDateCellRenderer({ row }: { row: Row<DataGridFeatures, ProjectSummary> }) {
  return <span className="text-[length:var(--text-sm)]">{formatDashboardDate(row.original.shootDate)}</span>;
}

function DeadlineCellRenderer({ row }: { row: Row<DataGridFeatures, ProjectSummary> }) {
  const { canEditDeadline, terminal, role } = useCells();
  const project = row.original;
  const canEdit = canEditDeadline && project.stageKey !== "delivered" && !project.archivedAt;
  return (
    // Only an interactive control rides above the row link's overlay; read-only text lets the click through.
    <div className={cn("min-w-0", canEdit && project.deadlineAt !== null && "relative z-[1]")}>
      <ProjectDeadlineCell
        projectId={project.id}
        street={project.street}
        deadline={deadlineViewOf(project)}
        textClassName="!text-[length:var(--text-sm)]"
        canEdit={canEdit}
        disabled={terminal}
        role={role}
        testIdPrefix="project-table"
        overdueInName
        emptyLabel="No deadline"
      />
    </div>
  );
}

function EditorsCellRenderer({ row }: { row: Row<DataGridFeatures, ProjectSummary> }) {
  return <AvatarStack people={row.original.editors ?? []} personNoun="Editor" emptyLabel="No Editor assigned" />;
}

function PriorityCellRenderer({ row }: { row: Row<DataGridFeatures, ProjectSummary> }) {
  const { canPrioritize, terminal, pendingOrdering, onPriorityChange } = useCells();
  const project = row.original;
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

function RawCellRenderer({ row }: { row: Row<DataGridFeatures, ProjectSummary> }) {
  const raw = rawCounts(row.original);
  return (
    <span className="tabular-nums text-[length:var(--text-sm)]">
      <span aria-hidden="true" data-testid="project-table-raw">{raw.visible}</span>
      <span className="sr-only">{raw.spoken}</span>
    </span>
  );
}

const SIZES: Record<"wide" | "narrow", Record<TableColumnId, number>> = {
  wide: { address: 320, stage: 150, client: 200, shootDate: 130, deadline: 170, editors: 110, priority: 190, raw: 130 },
  narrow: { address: 200, stage: 140, client: 160, shootDate: 120, deadline: 140, editors: 100, priority: 190, raw: 110 },
};

const CELLS: Record<TableColumnId, { value: (project: ProjectSummary) => unknown; cell: Column["cell"] }> = {
  address: { value: (project) => project.street, cell: AddressCellRenderer },
  stage: { value: (project) => project.stageKey, cell: StageCellRenderer },
  client: { value: (project) => project.agencyName, cell: ClientCellRenderer },
  shootDate: { value: (project) => project.shootDate, cell: ShootDateCellRenderer },
  deadline: { value: (project) => project.deadlineAt, cell: DeadlineCellRenderer },
  editors: { value: (project) => project.editors?.[0]?.name, cell: EditorsCellRenderer },
  priority: { value: (project) => project.priority, cell: PriorityCellRenderer },
  raw: { value: (project) => project.receivedCount, cell: RawCellRenderer },
};

function createColumns(narrow: boolean): Column[] {
  const sizes = SIZES[narrow ? "narrow" : "wide"];
  return TABLE_COLUMN_IDS.map((id): Column => ({
    id,
    accessorFn: CELLS[id].value,
    header: ({ column }) => <DataGridColumnHeader column={column} title={TABLE_COLUMN_LABELS[id]} />,
    cell: CELLS[id].cell,
    size: sizes[id],
    enableSorting: true,
    enableHiding: id !== "address",
  }));
}

const EDGE_CELL = "first:ps-[var(--space-4)] last:pe-[var(--space-4)]";

const GroupGrid = memo(function GroupGrid({ rows, columns, sorting, onSortingChange, visibility, sticky, label }: {
  rows: ProjectSummary[];
  columns: Column[];
  sorting: SortingState;
  onSortingChange: (next: SortingState | ((current: SortingState) => SortingState)) => void;
  visibility: ColumnVisibilityState;
  sticky: boolean;
  label: string;
}) {
  const table = useTable({
    features: dataGridFeatures,
    // The rows are already sorted and complete: v9 keeps its pagination row model unless told the
    // data is the page, and would show 10 rows.
    manualPagination: true,
    manualSorting: true,
    data: rows,
    columns,
    getRowId: (project) => project.id,
    state: { sorting, columnVisibility: visibility },
    onSortingChange,
  });
  return (
    <DataGrid
      table={table}
      recordCount={rows.length}
      emptyMessage={`No projects in ${label}.`}
      tableLayout={{ rowBorder: true, headerBorder: true, width: "fixed", headerSticky: sticky, columnsResizable: false, columnsVisibility: false, columnsMovable: false, columnsPinnable: false }}
      tableClassNames={{
        edgeCell: EDGE_CELL,
        headerRow: "[&>th]:h-9 bg-secondary",
        headerSticky: "sticky top-0 z-20 bg-secondary",
        // `relative` is the containing block of the Address link's stretched ::after.
        bodyRow: "relative",
      }}
    >
      {/* Sticky: a flex-column chain (container, wrapper, Root) so the ScrollArea viewport is the
          scroller and the header sticks inside it. */}
      <DataGridContainer className={sticky ? "flex min-h-0 flex-1 flex-col" : undefined}>
        <DataGridScrollArea
          orientation={sticky ? "both" : "horizontal"}
          containerClassName={sticky ? "flex min-h-0 flex-1 flex-col" : undefined}
          className={sticky ? "min-h-0 flex-1" : undefined}
        >
          <DataGridTable />
        </DataGridScrollArea>
      </DataGridContainer>
    </DataGrid>
  );
});

function GroupSection({ group, open, onOpenChange, children }: { group: TableGroup; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  // useId: two groups whose labels sanitise to the same string ("A&B", "A B") must not share an id.
  const headingId = `dashboard-table-group-${useId()}`;
  return (
    <section aria-labelledby={headingId} data-testid="project-table-group" className="border-t border-t-foreground first:border-t-0">
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <h3 id={headingId} className="m-0 flex items-center gap-[var(--space-2)] bg-card px-[var(--space-2)] py-[var(--space-1)] font-medium">
          <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" className="gap-[var(--space-2)]" data-testid="project-table-group-trigger" />}>
            <ChevronRight aria-hidden="true" className={cn("size-4 transition-transform", open && "rotate-90")} />
            <span className="font-semibold">{group.label}</span>
            <Badge variant="outline" size="sm" className="tabular-nums" data-testid="project-table-group-count">{group.rows.length}</Badge>
          </CollapsibleTrigger>
        </h3>
        <CollapsibleContent>{children}</CollapsibleContent>
      </Collapsible>
    </section>
  );
}

export type DashboardTableProps = {
  projects: ProjectSummary[];
  role: Role;
  groupBy: TableGroupBy;
  /** The viewer's Display choice; role- and width-forced hiding is added on top at render. */
  hiddenColumns: readonly HideableColumnId[];
  /** The Priority capability AND an authorized Board map (the Dashboard folds both in). */
  canPrioritize: boolean;
  pendingOrdering: ReadonlySet<string>;
  terminal: boolean;
  onPriorityChange: (project: ProjectSummary, priority: number | null) => void;
  projectHrefFor: (projectId: string) => string;
};

export function DashboardTable({ projects, role, groupBy, hiddenColumns, canPrioritize, pendingOrdering, terminal, onPriorityChange, projectHrefFor }: DashboardTableProps) {
  const { stages } = useStages();
  const { can } = useCapabilities();
  const canEditDeadline = can("editProject");
  const narrow = useMediaQuery(TABLE_NARROW_QUERY);
  const [sorting, setSorting] = useState<SortingState>([]);
  // Collapsed groups belong to the Group by they were collapsed under; a change starts fresh.
  const [collapsed, setCollapsed] = useState<{ groupBy: TableGroupBy; keys: ReadonlySet<string> }>({ groupBy, keys: new Set() });
  if (collapsed.groupBy !== groupBy) setCollapsed({ groupBy, keys: new Set() });
  const collapsedKeys = collapsed.groupBy === groupBy ? collapsed.keys : new Set<string>();

  const visibility = useMemo<ColumnVisibilityState>(() => {
    const state: ColumnVisibilityState = {};
    for (const id of TABLE_COLUMN_IDS) {
      state[id] = columnVisibleToRole(id, role) && (narrow ? NARROW_COLUMNS.includes(id) : id === "address" || !hiddenColumns.includes(id as HideableColumnId));
    }
    return state;
  }, [hiddenColumns, narrow, role]);

  const columns = useMemo(() => createColumns(narrow), [narrow]);
  const cells = useMemo<CellContext>(
    () => ({ role, canPrioritize, canEditDeadline, pendingOrdering, terminal, onPriorityChange, projectHrefFor }),
    [canEditDeadline, canPrioritize, onPriorityChange, pendingOrdering, projectHrefFor, role, terminal],
  );

  const sorted = useMemo(() => sortTableRows(projects, sorting, stages), [projects, sorting, stages]);
  const groups = useMemo(() => groupTableRows(sorted, groupBy, stages), [groupBy, sorted, stages]);

  const toggle = (key: string, open: boolean) => {
    const keys = new Set(collapsedKeys);
    if (open) keys.delete(key); else keys.add(key);
    setCollapsed({ groupBy, keys });
  };

  return (
    <section aria-label="Projects table" data-testid="dashboard-table" className="flex min-h-0 flex-1 flex-col">
      <CellContext.Provider value={cells}>
        <Frame dense className="min-h-0 flex-1">
          <FramePanel className="flex min-h-0 flex-col p-0">
            {groupBy === "none" ? (
              <GroupGrid rows={groups[0]?.rows ?? []} columns={columns} sorting={sorting} onSortingChange={setSorting} visibility={visibility} sticky label="this view" />
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto">
                {groups.map((group) => (
                  <GroupSection key={group.key} group={group} open={!collapsedKeys.has(group.key)} onOpenChange={(open) => toggle(group.key, open)}>
                    <GroupGrid rows={group.rows} columns={columns} sorting={sorting} onSortingChange={setSorting} visibility={visibility} sticky={false} label={group.label} />
                  </GroupSection>
                ))}
              </div>
            )}
          </FramePanel>
        </Frame>
      </CellContext.Provider>
    </section>
  );
}
