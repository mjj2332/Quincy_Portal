import { z } from "zod";
import { STAGE_PRESENTATION_KEYS, type StagePresentationKey } from "./stage-move";

/**
 * The Dashboard's shared Filter (#428): the facets every Dashboard view reads from one place.
 *
 * - `stageKeys`: Stage, any-of, in `STAGE_PRESENTATION_KEYS` order. Empty = unrestricted.
 * - `priorities`: the Project priority, any-of. `"5"`..`"1"` are the star values (descending, the
 *   canonical order everywhere) and `"none"` is "no priority" (SQL NULL). Empty = unrestricted.
 * - `archived`: Hide (default; the active Projects), Include (both) or Only (archived). Admin only,
 *   enforced on the server.
 *
 * The same names are spelled the same way in the URL (`stages`, `priority`, `archived`) and in the
 * Projects-list, Calendar and Timeline request queries. `Stage` keeps the presentation key the
 * Calendar and Gantt already use; `editing` is the one that maps to the stored `editing_autohdr`.
 */
export const DASHBOARD_ARCHIVED_MODES = ["hide", "include", "only"] as const;
export type DashboardArchivedMode = (typeof DASHBOARD_ARCHIVED_MODES)[number];

/** Star values highest first, then "no priority". The canonical order. */
export const DASHBOARD_PRIORITY_FILTER_VALUES = ["5", "4", "3", "2", "1", "none"] as const;
export type DashboardPriorityFilterValue = (typeof DASHBOARD_PRIORITY_FILTER_VALUES)[number];

/** Same bound as the Calendar's Stage filter: a list cannot be longer than the stage vocabulary. */
export const DASHBOARD_FILTER_MAX_STAGE_KEYS = 5;

export type DashboardFilter = {
  stageKeys: StagePresentationKey[];
  priorities: DashboardPriorityFilterValue[];
  archived: DashboardArchivedMode;
};

export const DEFAULT_DASHBOARD_FILTER: Readonly<DashboardFilter> = Object.freeze({ stageKeys: [], priorities: [], archived: "hide" });

export function isDefaultDashboardFilter(filter: DashboardFilter | undefined): boolean {
  return filter === undefined || (filter.stageKeys.length === 0 && filter.priorities.length === 0 && filter.archived === "hide");
}

/** Canonical order and no duplicates; unknown values are dropped. */
export function canonicalDashboardPriorities(values: readonly string[]): DashboardPriorityFilterValue[] {
  const selected = new Set(values);
  return DASHBOARD_PRIORITY_FILTER_VALUES.filter((value) => selected.has(value));
}

export function canonicalDashboardStages(values: readonly string[]): StagePresentationKey[] {
  const selected = new Set(values);
  return STAGE_PRESENTATION_KEYS.filter((value) => selected.has(value));
}

/** A fresh, canonical copy. */
export function normalizeDashboardFilter(filter: Partial<DashboardFilter> | undefined): DashboardFilter {
  return {
    stageKeys: canonicalDashboardStages(filter?.stageKeys ?? []),
    priorities: canonicalDashboardPriorities(filter?.priorities ?? []),
    archived: filter?.archived ?? "hide",
  };
}

export function dashboardFiltersEqual(left: DashboardFilter, right: DashboardFilter): boolean {
  return left.archived === right.archived
    && left.stageKeys.length === right.stageKeys.length && left.stageKeys.every((key, index) => key === right.stageKeys[index])
    && left.priorities.length === right.priorities.length && left.priorities.every((value, index) => value === right.priorities[index]);
}

/** The priority a stored Project value filters as: `null` is `"none"`. */
export function dashboardPriorityFilterValueOf(priority: number | null): DashboardPriorityFilterValue {
  return priority === null ? "none" : (String(priority) as DashboardPriorityFilterValue);
}

/** Parses a non-empty comma list with no empty or duplicate entries; `null` for a malformed one. */
export function parseDashboardFilterList(value: string): string[] | null {
  if (value === "") return null;
  const values = value.split(",");
  return values.some((item) => item === "") || new Set(values).size !== values.length ? null : values;
}

const commaList = <T extends readonly [string, ...string[]]>(values: T, maxLength: number) => z.string().transform((raw, context) => {
  const list = parseDashboardFilterList(raw);
  if (list === null || list.length > maxLength || list.some((item) => !values.includes(item))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Expected a comma list of known, distinct values." });
    return z.NEVER;
  }
  return list;
});

/**
 * The ONE validator for the Dashboard filter's wire spelling on the Projects-list request
 * (`GET /api/projects?stages=&priority=&archived=`). `archived=1` is the pre-#428 spelling of
 * "archived only" (an Admin's Archived scope) and keeps meaning `only`; `archived=hide` and
 * `archived=0` are not spellings (default means absent). Unknown keys are not this schema's business:
 * the caller passes only the three it owns.
 */
export const dashboardProjectsFilterQuerySchema = z.object({
  stages: commaList(STAGE_PRESENTATION_KEYS, DASHBOARD_FILTER_MAX_STAGE_KEYS).optional(),
  priority: commaList(DASHBOARD_PRIORITY_FILTER_VALUES, DASHBOARD_PRIORITY_FILTER_VALUES.length).optional(),
  archived: z.enum(["include", "only", "1"]).optional(),
}).strict().transform((query): DashboardFilter => ({
  stageKeys: canonicalDashboardStages(query.stages ?? []),
  priorities: canonicalDashboardPriorities(query.priority ?? []),
  archived: query.archived === undefined ? "hide" : query.archived === "1" ? "only" : query.archived,
}));

export type DashboardProjectsFilterQueryInput = z.input<typeof dashboardProjectsFilterQuerySchema>;

/** Serialises a filter to the Projects-list request spelling (defaults omitted). */
export function dashboardProjectsFilterQueryParams(filter: DashboardFilter): Array<[string, string]> {
  const params: Array<[string, string]> = [];
  if (filter.stageKeys.length > 0) params.push(["stages", canonicalDashboardStages(filter.stageKeys).join(",")]);
  if (filter.priorities.length > 0) params.push(["priority", canonicalDashboardPriorities(filter.priorities).join(",")]);
  if (filter.archived !== "hide") params.push(["archived", filter.archived]);
  return params;
}
