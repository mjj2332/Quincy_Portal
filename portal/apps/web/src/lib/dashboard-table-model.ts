import type { SortingState } from "@tanstack/react-table";
import type { Role } from "@quincy/shared";
import { isCanonicalShootDate } from "../screens/dashboard-helpers";
import type { ProjectSummary } from "./kanban-interaction";
import type { PipelineStage } from "./stages";

/**
 * The Dashboard Table's pure model (#431): column ids, the client-side sort, Group by, and the
 * per-viewer Display preferences. Nothing here touches React or the DOM, so every rule is unit
 * tested directly (`dashboard-table-model.test.ts`).
 *
 * `GET /api/projects` returns every matching row, with no paging and no sort parameter, so the
 * sort is the client's. The server's order stays until a header sort is chosen.
 */

export const TABLE_COLUMN_IDS = ["address", "stage", "client", "shootDate", "deadline", "editors", "priority", "raw"] as const;
export type TableColumnId = (typeof TABLE_COLUMN_IDS)[number];
/** Every column but Address, which is the row's link and never hidden. */
export type HideableColumnId = Exclude<TableColumnId, "address">;
export const HIDEABLE_COLUMN_IDS = TABLE_COLUMN_IDS.filter((id): id is HideableColumnId => id !== "address");

export const TABLE_COLUMN_LABELS: Record<TableColumnId, string> = {
  address: "Address",
  stage: "Stage",
  client: "Client",
  shootDate: "Shoot date",
  deadline: "Deadline",
  editors: "Editors",
  priority: "Priority",
  raw: "RAW received",
};

/** At or below this width the Table shows only Address and Deadline (`DashboardTable.tsx`). */
export const TABLE_NARROW_QUERY = "(max-width: 721px)";

export type TableGroupBy = "none" | "stage" | "client";
export const TABLE_GROUP_BY_VALUES: readonly TableGroupBy[] = ["none", "stage", "client"];
export const TABLE_GROUP_BY_LABELS: Record<TableGroupBy, string> = { none: "None", stage: "Stage", client: "Client" };

/** A column an external editor never sees: Priority is not part of their Project summary. */
export function columnVisibleToRole(id: TableColumnId, role: Role | undefined): boolean {
  return id !== "priority" || role !== "external_editor";
}

/** The columns the Display menu offers this viewer. */
export function hideableColumnsFor(role: Role | undefined): HideableColumnId[] {
  return HIDEABLE_COLUMN_IDS.filter((id) => columnVisibleToRole(id, role));
}

export function isTableColumnId(value: unknown): value is TableColumnId {
  return typeof value === "string" && (TABLE_COLUMN_IDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------------------------

export type TablePrefs = { groupBy: TableGroupBy; hiddenColumns: HideableColumnId[] };
export const DEFAULT_TABLE_PREFS: TablePrefs = { groupBy: "none", hiddenColumns: [] };

export const tablePrefsKey = (principalId: string) => `quincy:dashboard:table:${principalId}`;

/**
 * Reads whatever was stored into a valid `TablePrefs`: an unknown group-by falls back to None, an
 * unknown, duplicate or non-hideable column id (Address included) is dropped. Never throws.
 * Role-invisible columns are NOT filtered here: they are a render-time fact about the viewer, and a
 * stored value must survive a role change.
 */
export function normalizeTablePrefs(raw: unknown): TablePrefs {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { groupBy: "none", hiddenColumns: [] };
  const record = raw as Record<string, unknown>;
  const groupBy = TABLE_GROUP_BY_VALUES.find((value) => value === record.groupBy) ?? "none";
  const hidden = Array.isArray(record.hiddenColumns) ? record.hiddenColumns : [];
  const hiddenColumns = HIDEABLE_COLUMN_IDS.filter((id) => hidden.includes(id));
  return { groupBy, hiddenColumns };
}

/** The slice of `Storage` the preferences use, injectable so the rules are testable without a DOM. */
export type TablePrefsStorage = Pick<Storage, "getItem" | "setItem">;

const browserStorage = (): TablePrefsStorage => window.localStorage;

export function readTablePrefs(principalId: string, storage: () => TablePrefsStorage = browserStorage): TablePrefs {
  try {
    const stored = storage().getItem(tablePrefsKey(principalId));
    return stored === null ? { groupBy: "none", hiddenColumns: [] } : normalizeTablePrefs(JSON.parse(stored));
  } catch {
    return { groupBy: "none", hiddenColumns: [] };
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

function comparators(stages: readonly Pick<PipelineStage, "key" | "displayOrder">[]): Record<TableColumnId, Comparator> {
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
    editors: simple((project) => text(project.editors?.[0]?.name)),
    priority: simple((project) => project.priority ?? MISSING),
    raw: simple((project) => project.receivedCount),
  };
}

/**
 * Sorts by the first entry of `sorting` that names a known column, or returns the input order when
 * there is none (the server's order). Ties keep the server's order: the sort is stable on the input
 * index, in both directions.
 */
export function sortTableRows(projects: readonly ProjectSummary[], sorting: SortingState, stages: readonly Pick<PipelineStage, "key" | "displayOrder">[]): ProjectSummary[] {
  const active = sorting[0];
  if (!active || !isTableColumnId(active.id)) return [...projects];
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
