/**
 * #428: the Dashboard's shared Filter (Stage, Project priority, Archived Hide/Include/Only) as pure
 * functions between its three spellings:
 *
 * - the URL (`DashboardFilter`, `@quincy/shared` — read and written only through
 *   `dashboardFilterOf` / `withDashboardFilter`),
 * - the request (`dashboardProjectsFilterQueryParams` and friends), and
 * - the Filter's chip row (`screens/DashboardFilter.tsx`, a ReUI `Filters`): a `FilterQuery` with one
 *   rule per non-default facet. `dashboardFilterToQuery` / `queryToDashboardFilter` are the pair,
 *   shaped like the Timeline's (`lib/production-gantt-filters.ts`).
 *
 * One operator per field, no negation, one rule per field. An edit the URL cannot say (an `or`, a
 * group, a negated rule, a second rule on one field, an unknown value) maps to `null` and the bar
 * vetoes it.
 */
import {
  CANONICAL_LOWERCASE_UUID_REGEX,
  canonicalDashboardEditorIds,
  canonicalDashboardPriorities,
  canonicalDashboardStages,
  DASHBOARD_ARCHIVED_MODES,
  DASHBOARD_PRIORITY_FILTER_VALUES,
  DEFAULT_DASHBOARD_FILTER,
    normalizeDashboardFilter,
  parseDashboardDateRange,
  STAGE_PRESENTATION_KEYS,
  type DashboardArchivedMode,
  type DashboardDateRange,
  type DashboardFilter,
} from "@quincy/shared";
import type { FilterOperator, FilterQuery, FilterRule } from "../components/reui/filters/filters-types";

/** The fields. Their ids are the rule `path` segments the mapping reads. */
export const DASHBOARD_FILTER_FIELD = { stage: "stage", priority: "priority", archived: "archived", people: "people", shoot: "shoot", deadline: "deadline", mine: "mine" } as const;

/** Stable rule ids, so a URL re-seed hands the bar the same chip identities it already had. */
export const DASHBOARD_FILTER_RULE_ID = {
  stage: "dashboard-stage",
  priority: "dashboard-priority",
  archived: "dashboard-archived",
  people: "dashboard-people",
  shoot: "dashboard-shoot",
  deadline: "dashboard-deadline",
  mine: "dashboard-mine",
} as const;

/** The People field's "no Editor / no assignee" option value: never a UUID, so it cannot collide with a person. */
export const DASHBOARD_UNASSIGNED_OPTION = "unassigned";

export const DASHBOARD_FILTER_ROOT_ID = "dashboard-filters";

const ANY_OF = "is_any_of";
const IS = "is";
const BETWEEN = "between";
const OVERDUE = "overdue";
const ONLY = "only";

export const DASHBOARD_STAGE_OPERATORS: FilterOperator[] = [{ value: ANY_OF, label: "is any of", arity: "many" }];
export const DASHBOARD_PRIORITY_OPERATORS: FilterOperator[] = [{ value: ANY_OF, label: "is any of", arity: "many" }];
export const DASHBOARD_ARCHIVED_OPERATORS: FilterOperator[] = [{ value: IS, label: "is", arity: "one" }];
export const DASHBOARD_PEOPLE_OPERATORS: FilterOperator[] = [{ value: ANY_OF, label: "is any of", arity: "many" }];
export const DASHBOARD_SHOOT_OPERATORS: FilterOperator[] = [{ value: BETWEEN, label: "is between", arity: "range" }];
/** Deadline: a range or "is overdue" — one rule per field, so one or the other. */
export const DASHBOARD_DEADLINE_OPERATORS: FilterOperator[] = [
  { value: BETWEEN, label: "is between", arity: "range" },
  { value: OVERDUE, label: "is overdue", arity: "none" },
];
/** My tasks: "People = me" with no value to pick. */
export const DASHBOARD_MINE_OPERATORS: FilterOperator[] = [{ value: ONLY, label: "only", arity: "none" }];

/** The Archived chip's options (the chip reads "Archived is Included"). The URL values stay hide / include / only; Hide is the default: choosing it leaves the URL bare. */
export const DASHBOARD_ARCHIVED_OPTIONS: ReadonlyArray<{ value: DashboardArchivedMode; label: string }> = [
  { value: "hide", label: "Hidden" },
  { value: "include", label: "Included" },
  { value: "only", label: "Only archived" },
];

/** The Priority chip's options, in canonical order (5 stars first, "No priority" last). */
export const DASHBOARD_PRIORITY_OPTIONS: ReadonlyArray<{ value: (typeof DASHBOARD_PRIORITY_FILTER_VALUES)[number]; label: string }> =
  DASHBOARD_PRIORITY_FILTER_VALUES.map((value) => ({ value, label: value === "none" ? "No priority" : value === "1" ? "1 star" : `${value} stars` }));

export type DashboardFilterValue = string | string[];
export type DashboardFilterQuery = FilterQuery<DashboardFilterValue>;

const STAGE_VALUES = new Set<string>(STAGE_PRESENTATION_KEYS);
const PRIORITY_VALUES = new Set<string>(DASHBOARD_PRIORITY_FILTER_VALUES);
const FIELD_SET: Record<string, true> = Object.fromEntries(Object.values(DASHBOARD_FILTER_FIELD).map((field) => [field, true as const]));
const ARCHIVED_VALUES = new Set<string>(DASHBOARD_ARCHIVED_MODES);

/** A canonical string for a filter, so two filters compare by value, never by object identity. */
export function dashboardFilterKey(filter: DashboardFilter): string {
  const next = normalizeDashboardFilter(filter);
  return JSON.stringify([next.stageKeys, next.priorities, next.archived, next.editorIds, next.includeUnassigned, next.shootRange, next.deadlineRange, next.overdueOnly, next.myTasks]);
}

/** Filter -> the bar's query: a flat `and` root holding a rule only for each non-default facet. */
export function dashboardFilterToQuery(filter: DashboardFilter): DashboardFilterQuery {
  const next = normalizeDashboardFilter(filter);
  const rules: FilterRule<DashboardFilterValue>[] = [];
  if (next.stageKeys.length > 0) rules.push({ id: DASHBOARD_FILTER_RULE_ID.stage, type: "rule", path: [DASHBOARD_FILTER_FIELD.stage], operator: ANY_OF, value: [...next.stageKeys] });
  if (next.priorities.length > 0) rules.push({ id: DASHBOARD_FILTER_RULE_ID.priority, type: "rule", path: [DASHBOARD_FILTER_FIELD.priority], operator: ANY_OF, value: [...next.priorities] });
  if (next.archived !== "hide") rules.push({ id: DASHBOARD_FILTER_RULE_ID.archived, type: "rule", path: [DASHBOARD_FILTER_FIELD.archived], operator: IS, value: next.archived });
  const people = [...(next.includeUnassigned ? [DASHBOARD_UNASSIGNED_OPTION] : []), ...next.editorIds];
  if (people.length > 0) rules.push({ id: DASHBOARD_FILTER_RULE_ID.people, type: "rule", path: [DASHBOARD_FILTER_FIELD.people], operator: ANY_OF, value: people });
  if (next.shootRange) rules.push({ id: DASHBOARD_FILTER_RULE_ID.shoot, type: "rule", path: [DASHBOARD_FILTER_FIELD.shoot], operator: BETWEEN, value: [next.shootRange.from, next.shootRange.to] });
  if (next.deadlineRange) rules.push({ id: DASHBOARD_FILTER_RULE_ID.deadline, type: "rule", path: [DASHBOARD_FILTER_FIELD.deadline], operator: BETWEEN, value: [next.deadlineRange.from, next.deadlineRange.to] });
  else if (next.overdueOnly) rules.push({ id: DASHBOARD_FILTER_RULE_ID.deadline, type: "rule", path: [DASHBOARD_FILTER_FIELD.deadline], operator: OVERDUE, value: undefined });
  if (next.myTasks) rules.push({ id: DASHBOARD_FILTER_RULE_ID.mine, type: "rule", path: [DASHBOARD_FILTER_FIELD.mine], operator: ONLY, value: undefined });
  return { id: DASHBOARD_FILTER_ROOT_ID, type: "group", combinator: "and", rules };
}

function rangeOf(value: unknown): DashboardDateRange | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || typeof value[1] !== "string") return null;
  return parseDashboardDateRange(`${value[0]}..${value[1]}`);
}

/**
 * The bar's query -> filter, or `null` when the query holds something the URL cannot express: a
 * nested group, an `or` root, a negated rule, an unknown field / operator / value, a nested path, a
 * value of the wrong shape, or a second rule on a field already used (finished or not). Unfinished
 * rules (no operator yet) and rules with no value read as the default — though a value an unfinished
 * rule retains is still checked, and an unknown one returns `null`. `archivedAllowed` is false for a
 * role that may not read archived Projects: its Archived rule reads as unreadable.
 */
export function queryToDashboardFilter(query: FilterQuery<unknown>, options: { archivedAllowed?: boolean; priorityAllowed?: boolean } = {}): DashboardFilter | null {
  const archivedAllowed = options.archivedAllowed ?? true;
  const priorityAllowed = options.priorityAllowed ?? true;
  if (query.type !== "group" || query.combinator !== "and") return null;
  const seen = new Set<string>();
  let stageKeys: string[] = [];
  let priorities: string[] = [];
  let archived: DashboardArchivedMode = DEFAULT_DASHBOARD_FILTER.archived;
  let editorIds: string[] = [];
  let includeUnassigned = false;
  let shootRange: DashboardDateRange | null = null;
  let deadlineRange: DashboardDateRange | null = null;
  let overdueOnly = false;
  let myTasks = false;
  for (const node of query.rules) {
    if (node.type !== "rule" || node.negated) return null;
    const [field, ...rest] = node.path;
    if (field === undefined || rest.length > 0) return null;
    if (!(field in FIELD_SET)) return null;
    if (field === DASHBOARD_FILTER_FIELD.archived && !archivedAllowed) return null;
    if (field === DASHBOARD_FILTER_FIELD.priority && !priorityAllowed) return null;
    if (seen.has(field)) return null;
    seen.add(field);
    const unfinished = node.operator === "";
    if (field === DASHBOARD_FILTER_FIELD.people) {
      if (!unfinished && node.operator !== ANY_OF) return null;
      if (node.value === undefined) continue;
      if (!Array.isArray(node.value)) return null;
      for (const value of node.value) if (typeof value !== "string" || (value !== DASHBOARD_UNASSIGNED_OPTION && !CANONICAL_LOWERCASE_UUID_REGEX.test(value))) return null;
      if (unfinished) continue;
      includeUnassigned = node.value.includes(DASHBOARD_UNASSIGNED_OPTION);
      editorIds = (node.value as string[]).filter((value) => value !== DASHBOARD_UNASSIGNED_OPTION);
      continue;
    }
    if (field === DASHBOARD_FILTER_FIELD.shoot || field === DASHBOARD_FILTER_FIELD.deadline) {
      if (!unfinished && node.operator !== BETWEEN && !(field === DASHBOARD_FILTER_FIELD.deadline && node.operator === OVERDUE)) return null;
      if (!unfinished && node.operator === OVERDUE) { overdueOnly = true; continue; }
      const range = rangeOf(node.value);
      if (range === undefined) continue;
      if (range === null) return null;
      if (unfinished) continue;
      if (field === DASHBOARD_FILTER_FIELD.shoot) shootRange = range;
      else deadlineRange = range;
      continue;
    }
    if (field === DASHBOARD_FILTER_FIELD.mine) {
      if (!unfinished && node.operator !== ONLY) return null;
      if (!unfinished) myTasks = true;
      continue;
    }
    const expectedOperator = field === DASHBOARD_FILTER_FIELD.archived ? IS : ANY_OF;
    if (!unfinished && node.operator !== expectedOperator) return null;
    if (node.value === undefined) continue;
    if (field === DASHBOARD_FILTER_FIELD.archived) {
      const value = Array.isArray(node.value) ? (node.value.length === 1 ? node.value[0] : undefined) : node.value;
      if (typeof value !== "string" || !ARCHIVED_VALUES.has(value)) {
        // An emptied selection on an unfinished rule is just unfinished.
        if (Array.isArray(node.value) && node.value.length === 0) continue;
        return null;
      }
      if (!unfinished) archived = value as DashboardArchivedMode;
      continue;
    }
    if (!Array.isArray(node.value)) return null;
    const allowed = field === DASHBOARD_FILTER_FIELD.stage ? STAGE_VALUES : PRIORITY_VALUES;
    for (const value of node.value) if (typeof value !== "string" || !allowed.has(value)) return null;
    if (unfinished) continue;
    if (field === DASHBOARD_FILTER_FIELD.stage) stageKeys = node.value as string[];
    else priorities = node.value as string[];
  }
  return normalizeDashboardFilter({
    stageKeys: canonicalDashboardStages(stageKeys),
    priorities: canonicalDashboardPriorities(priorities),
    archived,
    editorIds: canonicalDashboardEditorIds(editorIds),
    includeUnassigned,
    shootRange,
    deadlineRange,
    overdueOnly,
    myTasks,
  });
}

/** How many facets of `filter` narrow (the Filter trigger's badge and the empty state's wording). */
export function dashboardFilterNarrowCount(filter: DashboardFilter): number {
  return (filter.stageKeys.length > 0 ? 1 : 0) + (filter.priorities.length > 0 ? 1 : 0) + (filter.archived !== "hide" ? 1 : 0)
    + (filter.editorIds.length > 0 || filter.includeUnassigned ? 1 : 0) + (filter.shootRange ? 1 : 0) + (filter.deadlineRange || filter.overdueOnly ? 1 : 0) + (filter.myTasks ? 1 : 0);
}
