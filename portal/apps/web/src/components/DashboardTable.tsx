import { memo, useMemo, useState, type ReactNode } from "react";
import { useTable, type ColumnDef, type ColumnVisibilityState, type SortingState } from "@tanstack/react-table";
import { formatSydneyCivil, isDeadlineOverdue, type Role } from "@quincy/shared";
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
import { LazyImage } from "./LazyImage";
import { ProjectDeadlineCell, type ProjectDeadlineView } from "./ProjectDeadlineCell";
import { AvatarStack } from "./quincy/AvatarStack";
import { Eyebrow } from "./quincy/Eyebrow";
import { PriorityStars } from "./quincy/PriorityStars";
import { formatDashboardDate } from "../screens/dashboard-helpers";
import { useCapabilities } from "../lib/capabilities";
import {
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
  narrow: boolean;
};

function location(project: ProjectSummary) {
  return [project.suburb, project.postcode].filter(Boolean).join(" · ") || "Location pending";
}

function deadlineViewOf(project: ProjectSummary): ProjectDeadlineView | null {
  if (project.deadlineAt === null) return null;
  return {
    at: new Date(project.deadlineAt).toISOString(),
    localCivil: project.deadlineLocalCivil ?? formatSydneyCivil(project.deadlineAt),
    overdue: isDeadlineOverdue(project.deadlineAt),
  };
}

function TableCover({ project, retryToken, onFailedChange }: { project: ProjectSummary; retryToken: number; onFailedChange: (failed: boolean) => void }) {
  const box = "h-12 w-[72px] shrink-0 overflow-hidden bg-[var(--ink-800)] max-[721px]:h-[37px] max-[721px]:w-14";
  if (project.coverAssetId) {
    return (
      <span className={box}>
        <LazyImage className="size-full object-cover" src={`/media/asset/${encodeURIComponent(project.coverAssetId)}/thumb`} alt={`Preview of ${project.street}`} retryToken={retryToken} onFailedChange={onFailedChange} />
      </span>
    );
  }
  const initial = project.street.trim().charAt(0).toUpperCase() || "Q";
  return <span className={cn("project-cover-placeholder", box)} aria-hidden="true">{initial}</span>;
}

function AddressCell({ project, href }: { project: ProjectSummary; href: string }) {
  const [coverFailed, setCoverFailed] = useState(false);
  const [coverRetry, setCoverRetry] = useState(0);
  return (
    <div className="flex min-w-0 items-center gap-[var(--space-3)]">
      <TableCover project={project} retryToken={coverRetry} onFailedChange={setCoverFailed} />
      <div className="min-w-0">
        <InternalLink
          to={href}
          data-testid="project-table-row-link"
          // The overlay: ::after covers the row (`tr` is `relative`), so the whole row is the link.
          className="block truncate font-[family-name:var(--font-display)] text-[length:var(--text-md)] tracking-[var(--tracking-tight)] text-inherit no-underline after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:outline-[length:var(--border-width-bold)] focus-visible:after:outline-solid focus-visible:after:outline-ring focus-visible:after:-outline-offset-2"
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

function header(id: TableColumnId): Column["header"] {
  return ({ column }) => <DataGridColumnHeader column={column} title={TABLE_COLUMN_LABELS[id]} />;
}

function createColumns(ctx: CellContext): Column[] {
  const sizes = ctx.narrow
    ? { address: 200, stage: 140, client: 160, shootDate: 120, deadline: 140, editors: 100, priority: 190, raw: 110 }
    : { address: 320, stage: 150, client: 200, shootDate: 130, deadline: 170, editors: 110, priority: 190, raw: 130 };
  const base = <T,>(id: TableColumnId, accessorFn: (project: ProjectSummary) => T, cell: Column["cell"], extra: Partial<Column> = {}): Column => ({
    id,
    accessorFn,
    header: header(id),
    cell,
    size: sizes[id],
    enableSorting: true,
    enableHiding: id !== "address",
    ...extra,
  });
  return [
    base("address", (project) => project.street, ({ row }) => <AddressCell project={row.original} href={ctx.projectHrefFor(row.original.id)} />),
    base("stage", (project) => project.stageKey, ({ row }) => <StatusBadge stageKey={row.original.stageKey} />),
    base("client", (project) => project.agencyName, ({ row }) => (
      <span className="block min-w-0 text-[length:var(--text-sm)]">
        <span className="block truncate">{row.original.agencyName || "Agency pending"}</span>
        <span className="mt-[var(--space-1)] block truncate text-[length:var(--text-xs)] text-foreground-secondary">{row.original.agentName || "Agent pending"}</span>
      </span>
    )),
    base("shootDate", (project) => project.shootDate, ({ row }) => <span className="text-[length:var(--text-sm)]">{formatDashboardDate(row.original.shootDate)}</span>),
    base("deadline", (project) => project.deadlineAt, ({ row }) => {
      const project = row.original;
      return (
        <div className="relative z-[1] min-w-0">
          <ProjectDeadlineCell
            projectId={project.id}
            street={project.street}
            deadline={deadlineViewOf(project)}
            canEdit={ctx.canEditDeadline && project.stageKey !== "delivered" && !project.archivedAt}
            disabled={ctx.terminal}
            role={ctx.role}
            testIdPrefix="project-table"
            overdueInName
            emptyLabel="No deadline"
          />
        </div>
      );
    }),
    base("editors", (project) => project.editors?.[0]?.name, ({ row }) => <AvatarStack people={row.original.editors ?? []} personNoun="Editor" emptyLabel="No Editor assigned" />),
    base("priority", (project) => project.priority, ({ row }) => {
      const project = row.original;
      return (
        // The read-only form carries card padding (`px/pb-[--space-3]`); the negative margins cancel it.
        <div className="relative z-[1] -mx-[var(--space-3)] -mb-[var(--space-3)] w-max max-w-full" data-testid="project-table-priority">
          <PriorityStars
            priority={project.priority}
            street={project.street}
            canPrioritize={ctx.canPrioritize && !ctx.terminal && !project.archivedAt}
            pending={ctx.pendingOrdering.has(project.id)}
            onPriorityChange={(next) => ctx.onPriorityChange(project, next)}
          />
        </div>
      );
    }),
    base("raw", (project) => project.receivedCount, ({ row }) => {
      const raw = rawCounts(row.original);
      return (
        <span className="tabular-nums text-[length:var(--text-sm)]" data-testid="project-table-raw">
          <span aria-hidden="true">{raw.visible}</span>
          <span className="sr-only">{raw.spoken}</span>
        </span>
      );
    }),
  ];
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
      <DataGridContainer className={sticky ? "min-h-0 flex-1" : undefined}>
        <DataGridScrollArea orientation={sticky ? "both" : "horizontal"} className={sticky ? "h-full" : undefined}>
          <DataGridTable />
        </DataGridScrollArea>
      </DataGridContainer>
    </DataGrid>
  );
});

function GroupSection({ group, open, onOpenChange, children }: { group: TableGroup; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  const headingId = `dashboard-table-group-${group.key.replace(/[^\w-]/g, "_") || "none"}`;
  return (
    <section aria-labelledby={headingId} data-testid="project-table-group" className="border-b border-border last:border-b-0">
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <h3 id={headingId} className="m-0 flex items-center gap-[var(--space-2)] bg-secondary px-[var(--space-2)] py-[var(--space-1)] font-normal">
          <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" className="gap-[var(--space-2)]" data-testid="project-table-group-trigger" />}>
            <span aria-hidden="true">{open ? "−" : "+"}</span>
            <span>{group.label}</span>
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
  const collapsedKeys = collapsed.groupBy === groupBy ? collapsed.keys : new Set<string>();

  const visibility = useMemo<ColumnVisibilityState>(() => {
    const state: ColumnVisibilityState = {};
    for (const id of TABLE_COLUMN_IDS) {
      state[id] = columnVisibleToRole(id, role) && (narrow ? NARROW_COLUMNS.includes(id) : id === "address" || !hiddenColumns.includes(id as HideableColumnId));
    }
    return state;
  }, [hiddenColumns, narrow, role]);

  const columns = useMemo(
    () => createColumns({ role, canPrioritize, canEditDeadline, pendingOrdering, terminal, onPriorityChange, projectHrefFor, narrow }),
    [canEditDeadline, canPrioritize, narrow, onPriorityChange, pendingOrdering, projectHrefFor, role, terminal],
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
      <Frame className="min-h-0 flex-1">
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
    </section>
  );
}
