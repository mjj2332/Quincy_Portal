import type { SortingState } from "@tanstack/react-table";
import type { Role } from "@quincy/shared";
import { isCanonicalShootDate } from "../screens/dashboard-helpers";
import type { ProjectSummary } from "./kanban-interaction";
import type { PipelineStage } from "./stages";
import { PHONE_VIEWPORT_QUERY } from "./use-media-query";

/**
 * The Dashboard Table's pure model (#431): column ids, the client-side sort, Group by, and the
 * per-viewer Display preferences. Nothing here touches React or the DOM, so every rule is unit
 * tested directly (`dashboard-table-model.test.ts`).
 *
 * `GET /api/projects` returns every matching row, with no paging and no sort parameter, so the
 * sort is the client's. Round 4 (#923, frames 4b/4c) sorts by Deadline ascending until the viewer
 * picks another header; clearing a header sort returns to the server's order.
 */

export const TABLE_COLUMN_IDS = ["address", "stage", "client", "shootDate", "deadline", "progress", "editors", "priority", "raw"] as const;
export type TableColumnId = (typeof TABLE_COLUMN_IDS)[number];
/** Every column but Address, which is the row's link and never hidden. */
export type HideableColumnId = Exclude<TableColumnId, "address">;
export const HIDEABLE_COLUMN_IDS = TABLE_COLUMN_IDS.filter((id): id is HideableColumnId => id !== "address");

/** The frame's header copy (4b): "Project" and "Shoot", not the old "Address" and "Shoot date". */
export const TABLE_COLUMN_LABELS: Record<TableColumnId, string> = {
  address: "Project",
  stage: "Stage",
  client: "Client",
  shootDate: "Shoot",
  deadline: "Deadline",
  progress: "Progress",
  editors: "Editors",
  priority: "Priority",
  raw: "RAW received",
};

/**
 * The order the Table drops columns in where they do not all fit its width (#923 pass round 2, row 5), so the
 * Deadline and its late chip always show without scrolling sideways at tablet widths. RAW received (not in frame
 * 4b) goes first, then Client and Shoot, then Priority (the widest, at its 36px star cells, and on every card
 * too), Progress, Editors and last Stage. Project and Deadline never drop. A render-time choice from the
 * measured width, never written to the viewer's `hiddenColumns`.
 */
export const TABLE_FIT_DROP_ORDER: readonly HideableColumnId[] = ["raw", "client", "shootDate", "priority", "progress", "editors", "stage"];

/**
 * Which of the `visible` columns to leave out so the rest fit `width` (the Table's inner width, px), dropping
 * in `TABLE_FIT_DROP_ORDER` until they do. `sizes` are the columns' widths, padding included. An unmeasured
 * width (0) drops nothing.
 */
export function columnsDroppedToFit(visible: readonly TableColumnId[], sizes: Readonly<Record<TableColumnId, number>>, width: number): Set<TableColumnId> {
  const dropped = new Set<TableColumnId>();
  if (width <= 0) return dropped;
  let total = visible.reduce((sum, id) => sum + sizes[id], 0);
  for (const id of TABLE_FIT_DROP_ORDER) {
    if (total <= width) break;
    if (!visible.includes(id)) continue;
    dropped.add(id);
    total -= sizes[id];
  }
  return dropped;
}

/** Below 721px (the one phone breakpoint, `PHONE_VIEWPORT_QUERY`) the Table is the phone list (`TablePhoneList.tsx`, frame 4g), not the grid. */
export const TABLE_NARROW_QUERY = PHONE_VIEWPORT_QUERY;

export type TableGroupBy = "none" | "stage" | "client";
export const TABLE_GROUP_BY_VALUES: readonly TableGroupBy[] = ["none", "stage", "client"];
export const TABLE_GROUP_BY_LABELS: Record<TableGroupBy, string> = { none: "None", stage: "Stage", client: "Client" };

/**
 * A column an External Editor never sees: Priority is not part of their Project summary, and their
 * strict DTO carries no `checklist`, so Progress would be empty for every row (#923 D1).
 */
export function columnVisibleToRole(id: TableColumnId, role: Role | undefined): boolean {
  return (id !== "priority" && id !== "progress") || role !== "external_editor";
}

/** The columns the Display menu offers this viewer. */
export function hideableColumnsFor(role: Role | undefined): HideableColumnId[] {
  return HIDEABLE_COLUMN_IDS.filter((id) => columnVisibleToRole(id, role));
}

export function isTableColumnId(value: unknown): value is TableColumnId {
  return typeof value === "string" && (TABLE_COLUMN_IDS as readonly string[]).includes(value);
}

/**
 * Progress and Editors have no header sort in the frame (4b draws no sort mark on either; #923 review round 3);
 * every other column sorts.
 */
const UNSORTABLE_COLUMN_IDS = ["progress", "editors"] as const;
export type SortableColumnId = Exclude<TableColumnId, (typeof UNSORTABLE_COLUMN_IDS)[number]>;
export function isSortableColumnId(value: unknown): value is SortableColumnId {
  return isTableColumnId(value) && !(UNSORTABLE_COLUMN_IDS as readonly string[]).includes(value);
}

/** The sort a viewer starts with (frames 4b and 4c both run by Deadline, earliest first). */
export const DEFAULT_TABLE_SORTING: SortingState = [{ id: "deadline", desc: false }];

// ---------------------------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------------------------

/**
 * `showDelivered` is the Display menu's "Show: Delivered Projects" (#923): a viewer preference, not a
 * Filter rule. A new viewer starts grouped by Stage with RAW received hidden (frame 4b has no RAW
 * column) and Delivered hidden (frame 4c, owner decision #923 round 3); a stored explicit choice,
 * Group by None and Delivered shown included, is kept.
 */
export type TablePrefs = { groupBy: TableGroupBy; hiddenColumns: HideableColumnId[]; showDelivered: boolean };
export const DEFAULT_TABLE_PREFS: TablePrefs = { groupBy: "stage", hiddenColumns: ["raw"], showDelivered: false };
const defaults = (): TablePrefs => ({ ...DEFAULT_TABLE_PREFS, hiddenColumns: [...DEFAULT_TABLE_PREFS.hiddenColumns] });

export const tablePrefsKey = (principalId: string) => `quincy:dashboard:table:${principalId}`;

/**
 * Reads whatever was stored into a valid `TablePrefs`: an unknown group-by falls back to Stage, a
 * missing column list to the default, a missing or non-boolean `showDelivered` to the default (hidden), and an unknown,
 * duplicate or non-hideable column id (Address included) is dropped. Never throws.
 * Role-invisible columns are NOT filtered here: they are a render-time fact about the viewer, and a
 * stored value must survive a role change.
 */
export function normalizeTablePrefs(raw: unknown): TablePrefs {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return defaults();
  const record = raw as Record<string, unknown>;
  const groupBy = TABLE_GROUP_BY_VALUES.find((value) => value === record.groupBy) ?? DEFAULT_TABLE_PREFS.groupBy;
  const hidden: readonly unknown[] = Array.isArray(record.hiddenColumns) ? record.hiddenColumns : DEFAULT_TABLE_PREFS.hiddenColumns;
  const hiddenColumns = HIDEABLE_COLUMN_IDS.filter((id) => hidden.includes(id));
  const showDelivered = typeof record.showDelivered === "boolean" ? record.showDelivered : DEFAULT_TABLE_PREFS.showDelivered;
  return { groupBy, hiddenColumns, showDelivered };
}

/** The slice of `Storage` the preferences use, injectable so the rules are testable without a DOM. */
export type TablePrefsStorage = Pick<Storage, "getItem" | "setItem">;

const browserStorage = (): TablePrefsStorage => window.localStorage;

export function readTablePrefs(principalId: string, storage: () => TablePrefsStorage = browserStorage): TablePrefs {
  try {
    const stored = storage().getItem(tablePrefsKey(principalId));
    return stored === null ? defaults() : normalizeTablePrefs(JSON.parse(stored));
  } catch {
    return defaults();
  }
}

/** Best-effort: storage can be unavailable or reject a write; the in-memory choice stands. */
export function writeTablePrefs(principalId: string, prefs: TablePrefs, storage: () => TablePrefsStorage = browserStorage): void {
  try {
    storage().setItem(tablePrefsKey(principalId), JSON.stringify(normalizeTablePrefs(prefs)));
  } catch {
    // The preference is per-viewer convenience; losing it is harmless.
  }
}

// ---------------------------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------------------------

const collator = new Intl.Collator("en-AU", { numeric: true, sensitivity: "base" });

/** "No value": sorts last in BOTH directions, so a missing value is never "the smallest". */
const MISSING = Symbol("missing");
type SortValue = string | number | typeof MISSING;

/** The two Stage keys that name the same pipeline step, whichever the viewer's role presents. */
function stageAliases(stageKey: string): string[] {
  if (stageKey === "editing") return ["editing", "editing_autohdr"];
  if (stageKey === "editing_autohdr") return ["editing_autohdr", "editing"];
  return [stageKey];
}

/** The pipeline rank of a Stage key (lower is earlier), or `undefined` for one the list does not name. */
export function stageRank(stageKey: string, stages: readonly Pick<PipelineStage, "key" | "displayOrder">[]): number | undefined {
  for (const key of stageAliases(stageKey)) {
    const found = stages.find((stage) => stage.key === key);
    if (found) return found.displayOrder;
  }
  return undefined;
}

const text = (value: string | null | undefined): string | typeof MISSING => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? MISSING : trimmed;
};

function compareValues(left: SortValue, right: SortValue): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return collator.compare(String(left), String(right));
}

type Comparator = (a: ProjectSummary, b: ProjectSummary, descending: boolean) => number;

/** Applies direction to a present/missing pair: missing is last whichever way the column runs. */
function directed(left: SortValue, right: SortValue, descending: boolean): number {
  if (left === MISSING && right === MISSING) return 0;
  if (left === MISSING) return 1;
  if (right === MISSING) return -1;
  const order = compareValues(left, right);
  return descending ? -order : order;
}

function simple(value: (project: ProjectSummary) => SortValue): Comparator {
  return (a, b, descending) => directed(value(a), value(b), descending);
}

function comparators(stages: readonly Pick<PipelineStage, "key" | "displayOrder">[]): Record<SortableColumnId, Comparator> {
  return {
    address: simple((project) => text(project.street)),
    stage: simple((project) => stageRank(project.stageKey, stages) ?? MISSING),
    // Agency, then agent. A row with no agency is "no client" and sorts last; within one agency a
    // missing agent is last, in the same direction-independent way.
    client: (a, b, descending) => {
      const byAgency = directed(text(a.agencyName), text(b.agencyName), descending);
      return byAgency !== 0 ? byAgency : directed(text(a.agentName), text(b.agentName), descending);
    },
    shootDate: simple((project) => (isCanonicalShootDate(project.shootDate) ? project.shootDate : MISSING)),
    deadline: simple((project) => project.deadlineAt ?? MISSING),
    priority: simple((project) => project.priority ?? MISSING),
    raw: simple((project) => project.receivedCount),
  };
}

/**
 * Sorts by the first entry of `sorting` that names a sortable column, or returns the input order when
 * there is none (the server's order). Ties keep the server's order: the sort is stable on the input
 * index, in both directions.
 */
export function sortTableRows(projects: readonly ProjectSummary[], sorting: SortingState, stages: readonly Pick<PipelineStage, "key" | "displayOrder">[]): ProjectSummary[] {
  const active = sorting[0];
  if (!active || !isSortableColumnId(active.id)) return [...projects];
  const compare = comparators(stages)[active.id];
  return projects
    .map((project, index) => ({ project, index }))
    .sort((left, right) => compare(left.project, right.project, active.desc) || left.index - right.index)
    .map(({ project }) => project);
}

// ---------------------------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------------------------

export type TableGroup = { key: string; label: string; rows: ProjectSummary[] };

export const NO_CLIENT_LABEL = "No client";

/**
 * Splits already-sorted rows into groups, keeping each group's rows in the order given.
 * - Stage: pipeline order, a Stage with no rows omitted, a Stage the list does not name last.
 * - Client: trimmed, case-insensitive agency, A to Z, "No client" last.
 * - None: one group holding every row (the caller renders it without a group header).
 */
export function groupTableRows(rows: readonly ProjectSummary[], groupBy: TableGroupBy, stages: readonly Pick<PipelineStage, "key" | "label" | "displayOrder">[]): TableGroup[] {
  if (groupBy === "none") return [{ key: "all", label: "", rows: [...rows] }];
  if (groupBy === "stage") {
    const byKey = new Map<string, TableGroup>();
    for (const project of rows) {
      const stage = stageAliases(project.stageKey).map((key) => stages.find((candidate) => candidate.key === key)).find(Boolean);
      const key = stage?.key ?? project.stageKey;
      const group = byKey.get(key) ?? { key, label: stage?.label ?? project.stageKey, rows: [] };
      group.rows.push(project);
      byKey.set(key, group);
    }
    const rank = (group: TableGroup) => stageRank(group.key, stages) ?? Number.POSITIVE_INFINITY;
    return [...byKey.values()].sort((left, right) => rank(left) - rank(right));
  }
  const byClient = new Map<string, TableGroup>();
  for (const project of rows) {
    const agency = project.agencyName?.trim() ?? "";
    const key = agency.toLowerCase();
    const group = byClient.get(key) ?? { key, label: agency === "" ? NO_CLIENT_LABEL : agency, rows: [] };
    group.rows.push(project);
    byClient.set(key, group);
  }
  return [...byClient.values()].sort((left, right) => {
    if (left.key === "" || right.key === "") return left.key === right.key ? 0 : left.key === "" ? 1 : -1;
    return collator.compare(left.label, right.label);
  });
}

// ---------------------------------------------------------------------------------------------
// Round 4 (#923)
// ---------------------------------------------------------------------------------------------

/** The groups a Group by starts with collapsed: Delivered, under Stage (frame 4b). Nothing under Client or None. */
export function defaultCollapsedGroups(groupBy: TableGroupBy): ReadonlySet<string> {
  return new Set(groupBy === "stage" ? ["delivered"] : []);
}

/** The Display menu's "Show: Delivered Projects": off drops the Delivered Stage, nothing else. */
export function hideDelivered<T extends Pick<ProjectSummary, "stageKey">>(rows: readonly T[], showDelivered: boolean): T[] {
  return showDelivered ? [...rows] : rows.filter((row) => row.stageKey !== "delivered");
}

/** The flat Table's footer (frame 4c): "11 of 13 projects · Delivered hidden by Display", or "13 projects". */
export function tableCountLabel({ shown, total }: { shown: number; total: number }): string {
  if (shown < total) return `${shown} of ${total} projects · Delivered hidden by Display`;
  return `${total} ${total === 1 ? "project" : "projects"}`;
}

/**
 * The Stage name the Table paints beside a swatch. The Admin-only `editing_autohdr` key is named
 * "Editing" (its definition reads "Editing · autoHDR"): `StageLabel` adds the "· autoHDR" suffix itself,
 * and a group of them is the Editing group. An unknown key is shown as itself.
 */
export function stageDisplayLabel(stageKey: string, stages: readonly Pick<PipelineStage, "key" | "label">[]): string {
  if (stageKey === "editing_autohdr" || stageKey === "editing") return stages.find((stage) => stage.key === "editing")?.label ?? "Editing";
  return stages.find((stage) => stage.key === stageKey)?.label ?? stageKey;
}
