import { z } from "zod";
import { STAGE_PRESENTATION_KEYS, type StagePresentationKey } from "./stage-move";
import { isSydneyCalendarDate } from "./sydney-civil-time";

/**
 * The Dashboard's shared Filter (#428): the facets every Dashboard view reads from one place.
 *
 * - `stageKeys`: Stage, any-of, in `STAGE_PRESENTATION_KEYS` order. Empty = unrestricted.
 * - `priorities`: the Project priority, any-of. `"5"`..`"1"` are the star values (descending, the
 *   canonical order everywhere) and `"none"` is "no priority" (SQL NULL). Empty = unrestricted.
 * - `archived`: Hide (default; the active Projects), Include (both) or Only (archived). Admin only,
 *   enforced on the server.
 *
 * #429 adds the relation and date facets (the same names the Calendar already used where it had them):
 * - `editorIds` + `includeUnassigned`: People. Named people are any-of, Unassigned joins them with OR;
 *   different fields intersect. What "a person" matches is per result kind (the server owns it): on the
 *   Table/Board a Project's Editor or the assignee of one of its open Subtasks, on the Calendar/Timeline
 *   a Deadline's Editor or a Subtask's assignee.
 * - `myTasks`: "People = me", the session user (never a client-supplied id).
 * - `shootRange`, `deadlineRange`: inclusive Sydney civil-day ranges, both ends required.
 * - `overdueOnly`: the Deadline is past, the Project not Delivered and not archived. Exclusive with
 *   `deadlineRange` (one Deadline rule): `normalizeDashboardFilter` keeps the range and drops it.
 *
 * The same names are spelled the same way in the URL (`stages`, `priority`, `archived`, `editors`,
 * `unassigned`, `shoot`, `deadline`, `overdue`, `mine`) and in the
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

/** The People field's cap: the Calendar's and Timeline's, so a pre-#429 URL parses unchanged. */
export const DASHBOARD_FILTER_MAX_EDITOR_IDS = 50;

/** An inclusive range of Sydney civil days (`YYYY-MM-DD`), both ends required, `from <= to`. */
export type DashboardDateRange = { from: string; to: string };

export type DashboardFilter = {
  stageKeys: StagePresentationKey[];
  priorities: DashboardPriorityFilterValue[];
  archived: DashboardArchivedMode;
  /** Canonical lowercase UUIDs, sorted, no duplicates, at most `DASHBOARD_FILTER_MAX_EDITOR_IDS`. */
  editorIds: string[];
  includeUnassigned: boolean;
  shootRange: DashboardDateRange | null;
  deadlineRange: DashboardDateRange | null;
  overdueOnly: boolean;
  myTasks: boolean;
};

export const DEFAULT_DASHBOARD_FILTER: Readonly<DashboardFilter> = Object.freeze({
  stageKeys: [], priorities: [], archived: "hide", editorIds: [], includeUnassigned: false, shootRange: null, deadlineRange: null, overdueOnly: false, myTasks: false,
});

export function isDefaultDashboardFilter(filter: DashboardFilter | undefined): boolean {
  return filter === undefined || (
    filter.stageKeys.length === 0 && filter.priorities.length === 0 && filter.archived === "hide"
    && filter.editorIds.length === 0 && !filter.includeUnassigned && filter.shootRange === null && filter.deadlineRange === null && !filter.overdueOnly && !filter.myTasks
  );
}

/** The ONE spelling of a range in the URL and on the request: `from..to`. */
export function formatDashboardDateRange(range: DashboardDateRange): string {
  return `${range.from}..${range.to}`;
}

/** `from..to` with both ends real Sydney civil days and `from <= to`; `null` for anything else. */
export function parseDashboardDateRange(value: string): DashboardDateRange | null {
  const match = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/u.exec(value);
  if (!match) return null;
  const [, from, to] = match as unknown as [string, string, string];
  return isSydneyCalendarDate(from) && isSydneyCalendarDate(to) && from <= to ? { from, to } : null;
}

const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Sorted, no duplicates; the caller has already validated each id. */
export function canonicalDashboardEditorIds(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
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
  const deadlineRange = filter?.deadlineRange ?? null;
  return {
    stageKeys: canonicalDashboardStages(filter?.stageKeys ?? []),
    priorities: canonicalDashboardPriorities(filter?.priorities ?? []),
    archived: filter?.archived ?? "hide",
    editorIds: canonicalDashboardEditorIds(filter?.editorIds ?? []),
    includeUnassigned: filter?.includeUnassigned ?? false,
    shootRange: filter?.shootRange ? { from: filter.shootRange.from, to: filter.shootRange.to } : null,
    deadlineRange: deadlineRange ? { from: deadlineRange.from, to: deadlineRange.to } : null,
    // One Deadline rule: a range and "is overdue" cannot both be written (the URL rejects the pair).
    overdueOnly: deadlineRange ? false : filter?.overdueOnly ?? false,
    myTasks: filter?.myTasks ?? false,
  };
}

const rangesEqual = (left: DashboardDateRange | null, right: DashboardDateRange | null) =>
  left === right || (left !== null && right !== null && left.from === right.from && left.to === right.to);

export function dashboardFiltersEqual(left: DashboardFilter, right: DashboardFilter): boolean {
  return left.archived === right.archived
    && left.stageKeys.length === right.stageKeys.length && left.stageKeys.every((key, index) => key === right.stageKeys[index])
    && left.priorities.length === right.priorities.length && left.priorities.every((value, index) => value === right.priorities[index])
    && left.editorIds.length === right.editorIds.length && left.editorIds.every((id, index) => id === right.editorIds[index])
    && left.includeUnassigned === right.includeUnassigned && left.overdueOnly === right.overdueOnly && left.myTasks === right.myTasks
    && rangesEqual(left.shootRange, right.shootRange) && rangesEqual(left.deadlineRange, right.deadlineRange);
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

const lowercaseUuidList = z.string().transform((raw, context) => {
  const list = parseDashboardFilterList(raw);
  if (list === null || list.length > DASHBOARD_FILTER_MAX_EDITOR_IDS || list.some((item) => !LOWERCASE_UUID.test(item))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Expected a comma list of distinct lowercase UUIDs." });
    return z.NEVER;
  }
  return list;
});

const rangeParam = z.string().transform((raw, context) => {
  const range = parseDashboardDateRange(raw);
  if (range === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Expected from..to Sydney calendar days, from <= to." });
    return z.NEVER;
  }
  return range;
});

/**
 * The ONE validator for the Dashboard filter's wire spelling on the Projects-list request
 * (`GET /api/projects?stages=&priority=&archived=&editors=&unassigned=&shoot=&deadline=&overdue=&mine=`).
 * `archived=1` is the pre-#428 spelling of "archived only" (an Admin's Archived scope) and keeps
 * meaning `only`; `archived=hide` and `archived=0` are not spellings (default means absent). The flags
 * are `1` or absent; `deadline` and `overdue` together are invalid (one Deadline rule). Unknown keys are
 * not this schema's business: the caller passes only the ones it owns (`DASHBOARD_PROJECTS_FILTER_QUERY_NAMES`).
 */
export const DASHBOARD_PROJECTS_FILTER_QUERY_NAMES = ["stages", "priority", "archived", "editors", "unassigned", "shoot", "deadline", "overdue", "mine"] as const;

export const dashboardProjectsFilterQuerySchema = z.object({
  stages: commaList(STAGE_PRESENTATION_KEYS, DASHBOARD_FILTER_MAX_STAGE_KEYS).optional(),
  priority: commaList(DASHBOARD_PRIORITY_FILTER_VALUES, DASHBOARD_PRIORITY_FILTER_VALUES.length).optional(),
  archived: z.enum(["include", "only", "1"]).optional(),
  editors: lowercaseUuidList.optional(),
  unassigned: z.literal("1").optional(),
  shoot: rangeParam.optional(),
  deadline: rangeParam.optional(),
  overdue: z.literal("1").optional(),
  mine: z.literal("1").optional(),
}).strict().refine((query) => !(query.deadline !== undefined && query.overdue !== undefined), { message: "deadline and overdue are exclusive." }).transform((query): DashboardFilter => ({
  stageKeys: canonicalDashboardStages(query.stages ?? []),
  priorities: canonicalDashboardPriorities(query.priority ?? []),
  archived: query.archived === undefined ? "hide" : query.archived === "1" ? "only" : query.archived,
  editorIds: canonicalDashboardEditorIds(query.editors ?? []),
  includeUnassigned: query.unassigned === "1",
  shootRange: query.shoot ?? null,
  deadlineRange: query.deadline ?? null,
  overdueOnly: query.overdue === "1",
  myTasks: query.mine === "1",
}));

export type DashboardProjectsFilterQueryInput = z.input<typeof dashboardProjectsFilterQuerySchema>;

/** Serialises a filter to the Projects-list request spelling (defaults omitted). */
export function dashboardProjectsFilterQueryParams(filter: DashboardFilter): Array<[string, string]> {
  const params: Array<[string, string]> = [];
  if (filter.editorIds.length > 0) params.push(["editors", canonicalDashboardEditorIds(filter.editorIds).join(",")]);
  if (filter.includeUnassigned) params.push(["unassigned", "1"]);
  if (filter.stageKeys.length > 0) params.push(["stages", canonicalDashboardStages(filter.stageKeys).join(",")]);
  if (filter.priorities.length > 0) params.push(["priority", canonicalDashboardPriorities(filter.priorities).join(",")]);
  if (filter.archived !== "hide") params.push(["archived", filter.archived]);
  if (filter.shootRange) params.push(["shoot", formatDashboardDateRange(filter.shootRange)]);
  if (filter.deadlineRange) params.push(["deadline", formatDashboardDateRange(filter.deadlineRange)]);
  else if (filter.overdueOnly) params.push(["overdue", "1"]);
  if (filter.myTasks) params.push(["mine", "1"]);
  return params;
}

/** #429: one person in the Dashboard's People options (`GET /api/dashboard/people`). */
export type DashboardPerson = { id: string; name: string; roleLabel: string; isExternal: boolean; active: boolean };
export type DashboardPeopleResponse = { people: DashboardPerson[] };
