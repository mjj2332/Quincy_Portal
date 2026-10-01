import {
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "../components/reui/dropdown-menu";
import { PRODUCTION_CALENDAR_LAYERS, type ProductionCalendarLayer } from "@quincy/shared";
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
 * Calendar and Timeline (#430): the Calendar's Layers and the "Show" toggles for delivered Projects and
 * completed Subtasks, which are real server filters on both views and must not be active without a
 * visible control. Layers keep at least one layer on.
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

const LAYER_LABELS: Record<ProductionCalendarLayer, string> = { project: "Project deadlines", checklist: "Subtasks" };

/** The "Show" group both Calendar and Timeline carry: delivered Projects and completed Subtasks. */
function ShowGroup({ delivered, completed, onDeliveredChange, onCompletedChange }: { delivered: boolean; completed: boolean; onDeliveredChange: (next: boolean) => void; onCompletedChange: (next: boolean) => void }) {
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>Show</DropdownMenuLabel>
      <DropdownMenuCheckboxItem checked={delivered} onCheckedChange={onDeliveredChange}>Show delivered Projects</DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem checked={completed} onCheckedChange={onCompletedChange}>Show completed Subtasks</DropdownMenuCheckboxItem>
    </DropdownMenuGroup>
  );
}

/** The Calendar's Layers (the last checked layer is disabled; written in canonical order) and Show. */
export function CalendarDisplayContent({ layers, onLayersChange, showDeliveredProjects, showCompletedChecklist, onShowChange }: {
  layers: readonly ProductionCalendarLayer[];
  onLayersChange: (next: ProductionCalendarLayer[]) => void;
  showDeliveredProjects: boolean;
  showCompletedChecklist: boolean;
  onShowChange: (changes: { showDeliveredProjects?: boolean; showCompletedChecklist?: boolean }) => void;
}) {
  const toggleLayer = (layer: ProductionCalendarLayer, on: boolean) => {
    const selected = new Set(layers);
    if (on) selected.add(layer); else selected.delete(layer);
    if (selected.size === 0) return;
    onLayersChange(PRODUCTION_CALENDAR_LAYERS.filter((candidate) => selected.has(candidate)));
  };
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>Layers</DropdownMenuLabel>
        {PRODUCTION_CALENDAR_LAYERS.map((layer) => {
          const on = layers.includes(layer);
          return (
            <DropdownMenuCheckboxItem key={layer} checked={on} disabled={on && layers.length === 1} onCheckedChange={(next) => toggleLayer(layer, next)}>
              {LAYER_LABELS[layer]}
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <ShowGroup delivered={showDeliveredProjects} completed={showCompletedChecklist} onDeliveredChange={(next) => onShowChange({ showDeliveredProjects: next })} onCompletedChange={(next) => onShowChange({ showCompletedChecklist: next })} />
    </>
  );
}

/** The Timeline's Show group only. */
export function TimelineDisplayContent({ delivered, completed, onChange }: { delivered: boolean; completed: boolean; onChange: (changes: { delivered?: boolean; completed?: boolean }) => void }) {
  return <ShowGroup delivered={delivered} completed={completed} onDeliveredChange={(next) => onChange({ delivered: next })} onCompletedChange={(next) => onChange({ completed: next })} />;
}
