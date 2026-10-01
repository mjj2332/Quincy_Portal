import {
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "../components/reui/dropdown-menu";
import {
  TABLE_COLUMN_LABELS,
  TABLE_GROUP_BY_LABELS,
  TABLE_GROUP_BY_VALUES,
  TABLE_NARROW_QUERY,
  type HideableColumnId,
  type TableGroupBy,
} from "../lib/dashboard-table-model";
import { useMediaQuery } from "../lib/use-media-query";
import type { KanbanSortMode } from "./dashboard-helpers";

/**
 * What each view puts in the Dashboard's Display menu (#431). `DashboardViewBar` owns the trigger
 * and the popup; a view supplies its own content through the `display` slot, and a view with none
 * leaves the trigger disabled with a reason.
 *
 * Radio and checkbox items leave the menu open (Base UI's default for both), so a viewer can change
 * Group by and several columns in one visit.
 */

const SORT_LABELS: Record<KanbanSortMode, string> = {
  board: "Board order",
  priority: "Priority",
  "shootDate-asc": "Shoot date, earliest first",
  "shootDate-desc": "Shoot date, latest first",
};

/** The Board's Sort group, moved here unchanged from the view bar (#427). "Priority" only when authorized. */
export function BoardDisplayContent({ sort, canSortByPriority, onSortChange }: { sort: KanbanSortMode; canSortByPriority: boolean; onSortChange: (next: KanbanSortMode) => void }) {
  const options = (Object.keys(SORT_LABELS) as KanbanSortMode[]).filter((mode) => mode !== "priority" || canSortByPriority);
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>Sort</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={sort} onValueChange={(next) => onSortChange(next as KanbanSortMode)}>
        {options.map((mode) => (
          <DropdownMenuRadioItem key={mode} value={mode}>{SORT_LABELS[mode]}</DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  );
}

/** The Table's Group by (None, Stage, Client) and the hideable columns. Address is never offered. */
export function TableDisplayContent({ groupBy, onGroupByChange, hiddenColumns, hideableColumns, onColumnVisibilityChange }: {
  groupBy: TableGroupBy;
  onGroupByChange: (next: TableGroupBy) => void;
  hiddenColumns: readonly HideableColumnId[];
  /** The columns this viewer can see at all (no Priority for an External Editor). */
  hideableColumns: readonly HideableColumnId[];
  onColumnVisibilityChange: (column: HideableColumnId, visible: boolean) => void;
}) {
  const narrow = useMediaQuery(TABLE_NARROW_QUERY);
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>Group by</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={groupBy} onValueChange={(next) => { if (TABLE_GROUP_BY_VALUES.includes(next as TableGroupBy)) onGroupByChange(next as TableGroupBy); }}>
          {TABLE_GROUP_BY_VALUES.map((value) => (
            <DropdownMenuRadioItem key={value} value={value}>{TABLE_GROUP_BY_LABELS[value]}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>Columns</DropdownMenuLabel>
        {narrow && <p data-testid="table-display-narrow-note" className="m-0 px-[var(--space-2)] pb-[var(--space-2)] text-[length:var(--text-xs)] text-foreground-secondary">On narrow screens the Table shows Address and Deadline only.</p>}
        {hideableColumns.map((column) => (
          <DropdownMenuCheckboxItem key={column} checked={!hiddenColumns.includes(column)} onCheckedChange={(checked) => onColumnVisibilityChange(column, checked)}>
            {TABLE_COLUMN_LABELS[column]}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuGroup>
    </>
  );
}
