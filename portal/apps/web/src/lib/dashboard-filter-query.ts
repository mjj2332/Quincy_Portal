/**
 * #428 / #461: the Dashboard's shared Filter as pure functions between its three spellings:
 *
 * - the URL (`DashboardFilter`, `@quincy/shared` — read and written only through
 *   `dashboardFilterOf` / `withDashboardFilter`),
 * - the request (`dashboardProjectsFilterQueryParams` and friends), and
 * - the Filter popover (`screens/DashboardFilter.tsx`, a ReUI `Filters`, `variant="advanced"`): a
 *   `FilterQuery` tree. `dashboardFilterToQuery` / `queryToDashboardFilter` are the pair.
 *
 * The shared filter TREE (`dashboard-filter-tree.ts`) is what the popover draws: a flat filter is read
 * through `dashboardFilterTreeOf` (an AND of leaves in its `order`), a tree as itself. Going back,
 * `normalizeDashboardFilter({ tree })` gives the flat spelling whenever the legacy parameters can say it,
 * so every state the old chip row could produce still writes the URL it always wrote.
 *
 * What maps to `null` (the popover vetoes the edit): an unknown field / operator / value, a nested
 * path, a field the role may not use, and the shared caps (20 rules, depth 3, 50 People ids, the encoded
 * length). Unfinished rows (no operator or no value yet) and empty groups are dropped: they have no URL
 * spelling and narrow nothing. OR, groups, repeats, negation and a Deadline range beside Overdue are all
 * accepted.
 */
import {
  CANONICAL_LOWERCASE_UUID_REGEX,
  canonicalizeDashboardFilterTree,
  clampDashboardFilterForRole,
  coerceDashboardFilterTree,
  DASHBOARD_ARCHIVED_MODES,
  DASHBOARD_FILTER_MAX_STAGE_KEYS,
  DASHBOARD_FILTER_TREE_MAX_DEPTH,
  DASHBOARD_FILTER_TREE_MAX_PEOPLE_IDS,
  DASHBOARD_FILTER_TREE_MAX_RULES,
  DASHBOARD_PRIORITY_FILTER_VALUES,
  dashboardFilterArchivedMode,
  dashboardFilterRuleCount,
  dashboardFilterTreeOf,
  emptyDashboardFilterTree,
  formatDashboardFilterTree,
  normalizeDashboardFilter,
  parseDashboardDateRange,
  STAGE_PRESENTATION_KEYS,
  type DashboardArchivedMode,
  type DashboardDateRange,
  type DashboardFilter,
  type DashboardFilterLeaf,
  type DashboardFilterNode,
  type DashboardFilterTree,
  type DashboardPriorityFilterValue,
  type StagePresentationKey,
} from "@quincy/shared";
import type { FilterGroupNode, FilterNode, FilterOperator, FilterQuery, FilterRule } from "../components/reui/filters/filters-types";

/** The fields. Their ids are the rule `path` segments the mapping reads. */
export const DASHBOARD_FILTER_FIELD = { stage: "stage", priority: "priority", archived: "archived", people: "people", shoot: "shoot", deadline: "deadline", mine: "mine" } as const;

/** Stable rule ids of a FLAT filter, so a URL re-seed hands the bar the same row identities it already had. A tree's nodes get positional ids (`dashboardTreeNodeId`). */
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

const ID_PREFIX = "dashboard-t";
/** A tree node's id: its position, `dashboard-t<i>` for the root's i-th child, `dashboard-t<i>-<j>` below that. */
const dashboardTreeNodeId = (path: readonly number[]) => `${ID_PREFIX}${path.join("-")}`;

/** A canonical string for a filter, so two filters compare by value, never by object identity. Includes the tree and the flat facets' order: a reorder is a different URL. */
export function dashboardFilterKey(filter: DashboardFilter): string {
  const next = normalizeDashboardFilter(filter);
  return JSON.stringify([next.stageKeys, next.priorities, next.archived, next.editorIds, next.includeUnassigned, next.shootRange, next.deadlineRange, next.overdueOnly, next.myTasks, next.tree ? formatDashboardFilterTree(next.tree) : null, next.order ?? null]);
}

const FIELD_OF_LEAF: Record<DashboardFilterLeaf["field"], string> = { stages: "stage", priority: "priority", archived: "archived", people: "people", shoot: "shoot", deadline: "deadline", overdue: "deadline", mine: "mine" };
const RULE_ID_OF_LEAF: Record<DashboardFilterLeaf["field"], string> = {
  stages: DASHBOARD_FILTER_RULE_ID.stage, priority: DASHBOARD_FILTER_RULE_ID.priority, archived: DASHBOARD_FILTER_RULE_ID.archived, people: DASHBOARD_FILTER_RULE_ID.people,
  shoot: DASHBOARD_FILTER_RULE_ID.shoot, deadline: DASHBOARD_FILTER_RULE_ID.deadline, overdue: DASHBOARD_FILTER_RULE_ID.deadline, mine: DASHBOARD_FILTER_RULE_ID.mine,
};

function ruleOfLeaf(leaf: DashboardFilterLeaf, id: string): FilterRule<DashboardFilterValue> {
  const base = { id, type: "rule" as const, path: [FIELD_OF_LEAF[leaf.field]], ...(leaf.negated ? { negated: true } : {}) };
  switch (leaf.field) {
    case "stages": return { ...base, operator: ANY_OF, value: [...leaf.values] };
    case "priority": return { ...base, operator: ANY_OF, value: [...leaf.values] };
    case "archived": return { ...base, operator: IS, value: leaf.mode };
    case "people": return { ...base, operator: ANY_OF, value: [...(leaf.unassigned ? [DASHBOARD_UNASSIGNED_OPTION] : []), ...leaf.ids] };
    case "shoot": return { ...base, operator: BETWEEN, value: [leaf.range.from, leaf.range.to] };
    case "deadline": return { ...base, operator: BETWEEN, value: [leaf.range.from, leaf.range.to] };
    case "overdue": return { ...base, operator: OVERDUE, value: undefined };
    case "mine": return { ...base, operator: ONLY, value: undefined };
  }
}

/** Filter -> the popover's query: the filter's tree, drawn as an `and` / `or` root of rules and groups. */
export function dashboardFilterToQuery(filter: DashboardFilter): DashboardFilterQuery {
  const next = normalizeDashboardFilter(filter);
  const tree = dashboardFilterTreeOf(next);
  // A flat filter keeps the stable per-field ids; a tree's nodes are identified by position.
  const stable = next.tree === undefined;
  const draw = (node: DashboardFilterNode, path: readonly number[]): FilterNode<DashboardFilterValue> =>
    node.kind === "leaf"
      ? ruleOfLeaf(node, stable ? RULE_ID_OF_LEAF[node.field] : dashboardTreeNodeId(path))
      : { id: dashboardTreeNodeId(path), type: "group", combinator: node.op, rules: node.children.map((child, index) => draw(child, [...path, index])) };
  return { id: DASHBOARD_FILTER_ROOT_ID, type: "group", combinator: tree.op, rules: tree.children.map((child, index) => draw(child, [index])) };
}

function rangeOf(value: unknown): DashboardDateRange | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || typeof value[1] !== "string") return null;
  return parseDashboardDateRange(`${value[0]}..${value[1]}`);
}

type QueryOptions = { archivedAllowed?: boolean; priorityAllowed?: boolean };
/** `veto: "cap"` is a limit the user hit (worth saying so); `"invalid"` is something the UI never produces. */
export type DashboardFilterQueryResult = { filter: DashboardFilter } | { veto: "cap" | "invalid" };

/** The caps the panel and the URL share, measured on the QUERY: every rule counts, finished or not, so a row the user is still building cannot slip past the cap. */
function queryExceedsCaps(query: FilterQuery<unknown>): boolean {
  let rules = 0;
  let peopleIds = 0;
  let exceeded = false;
  const walk = (group: FilterGroupNode<unknown>, depth: number) => {
    for (const node of group.rules) {
      if (node.type === "group") {
        // A group at depth 3 could hold no rule (its rules would be depth 4).
        if (depth + 1 > DASHBOARD_FILTER_TREE_MAX_DEPTH - 1) exceeded = true;
        walk(node, depth + 1);
        continue;
      }
      rules += 1;
      if (depth + 1 > DASHBOARD_FILTER_TREE_MAX_DEPTH) exceeded = true;
      if (node.path[0] === DASHBOARD_FILTER_FIELD.people && Array.isArray(node.value)) peopleIds += node.value.filter((value) => value !== DASHBOARD_UNASSIGNED_OPTION).length;
    }
  };
  walk(query, 0);
  return exceeded || rules > DASHBOARD_FILTER_TREE_MAX_RULES || peopleIds > DASHBOARD_FILTER_TREE_MAX_PEOPLE_IDS;
}

const INVALID = Symbol("invalid");
type Converted = DashboardFilterNode | null | typeof INVALID;

/** One finished rule -> its leaf; `null` when unfinished (it narrows nothing yet); `INVALID` for something the URL cannot say. */
function leafOfRule(rule: FilterRule<unknown>, options: Required<QueryOptions>): DashboardFilterLeaf | null | typeof INVALID {
  const [field, ...rest] = rule.path;
  if (field === undefined || rest.length > 0 || !(field in FIELD_SET)) return INVALID;
  if (field === DASHBOARD_FILTER_FIELD.archived && !options.archivedAllowed) return INVALID;
  if (field === DASHBOARD_FILTER_FIELD.priority && !options.priorityAllowed) return INVALID;
  if (rule.operator === "") return null;
  const bang = rule.negated ? { negated: true as const } : {};
  const { value } = rule;
  if (field === DASHBOARD_FILTER_FIELD.mine) return rule.operator === ONLY ? { kind: "leaf", ...bang, field: "mine" } : INVALID;
  if (field === DASHBOARD_FILTER_FIELD.shoot || field === DASHBOARD_FILTER_FIELD.deadline) {
    if (rule.operator === OVERDUE && field === DASHBOARD_FILTER_FIELD.deadline) return { kind: "leaf", ...bang, field: "overdue" };
    if (rule.operator !== BETWEEN) return INVALID;
    const range = rangeOf(value);
    if (range === undefined) return null;
    if (range === null) return INVALID;
    return { kind: "leaf", ...bang, field: field === DASHBOARD_FILTER_FIELD.shoot ? "shoot" : "deadline", range };
  }
  if (field === DASHBOARD_FILTER_FIELD.archived) {
    if (rule.operator !== IS) return INVALID;
    if (value === undefined || (Array.isArray(value) && value.length === 0)) return null;
    const mode = Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
    return typeof mode === "string" && ARCHIVED_VALUES.has(mode) ? { kind: "leaf", ...bang, field: "archived", mode: mode as DashboardArchivedMode } : INVALID;
  }
  if (rule.operator !== ANY_OF) return INVALID;
  if (value === undefined) return null;
  if (!Array.isArray(value)) return INVALID;
  if (field === DASHBOARD_FILTER_FIELD.people) {
    for (const item of value) if (typeof item !== "string" || (item !== DASHBOARD_UNASSIGNED_OPTION && !CANONICAL_LOWERCASE_UUID_REGEX.test(item))) return INVALID;
    if (value.length === 0) return null;
    return { kind: "leaf", ...bang, field: "people", ids: (value as string[]).filter((item) => item !== DASHBOARD_UNASSIGNED_OPTION), unassigned: value.includes(DASHBOARD_UNASSIGNED_OPTION) };
  }
  const allowed = field === DASHBOARD_FILTER_FIELD.stage ? STAGE_VALUES : PRIORITY_VALUES;
  for (const item of value) if (typeof item !== "string" || !allowed.has(item)) return INVALID;
  if (value.length === 0) return null;
  if (field === DASHBOARD_FILTER_FIELD.stage) return value.length > DASHBOARD_FILTER_MAX_STAGE_KEYS ? INVALID : { kind: "leaf", ...bang, field: "stages", values: value as StagePresentationKey[] };
  return { kind: "leaf", ...bang, field: "priority", values: value as DashboardPriorityFilterValue[] };
}

/**
 * The popover's query -> filter. Unfinished rules and empty groups are dropped; a filter the legacy
 * parameters can spell comes out flat. `{ veto }` when the query holds something the URL cannot say.
 */
export function queryToDashboardFilterResult(query: FilterQuery<unknown>, options: QueryOptions = {}): DashboardFilterQueryResult {
  const resolved = { archivedAllowed: options.archivedAllowed ?? true, priorityAllowed: options.priorityAllowed ?? true };
  if (query.type !== "group") return { veto: "invalid" };
  if (queryExceedsCaps(query)) return { veto: "cap" };
  const convert = (node: FilterNode<unknown>): Converted => {
    if (node.type === "rule") return leafOfRule(node, resolved);
    if (node.combinator !== "and" && node.combinator !== "or") return INVALID;
    const children: DashboardFilterNode[] = [];
    for (const child of node.rules) {
      const converted = convert(child);
      if (converted === INVALID) return INVALID;
      if (converted !== null) children.push(converted);
    }
    return children.length === 0 ? null : { kind: "group", op: node.combinator, children };
  };
  const root = convert(query);
  if (root === INVALID) return { veto: "invalid" };
  if (root === null) return { filter: normalizeDashboardFilter(undefined) };
  const filter = normalizeDashboardFilter({ tree: canonicalizeDashboardFilterTree(root as DashboardFilterTree) });
  // Whatever stays a tree must be one the URL and the server accept: canonical, within the encoded-length cap.
  if (filter.tree && coerceDashboardFilterTree(filter.tree) === null) return { veto: "cap" };
  return { filter };
}

/** `queryToDashboardFilterResult` as the binding's `toFacet`: the filter, or `null` for a veto. */
export function queryToDashboardFilter(query: FilterQuery<unknown>, options: QueryOptions = {}): DashboardFilter | null {
  const result = queryToDashboardFilterResult(query, options);
  return "filter" in result ? result.filter : null;
}

function depthOf(query: FilterQuery<unknown>, id: string | undefined): number | null {
  if (id === undefined || id === query.id) return 0;
  const walk = (group: FilterGroupNode<unknown>, depth: number): number | null => {
    for (const node of group.rules) {
      if (node.type !== "group") continue;
      if (node.id === id) return depth + 1;
      const found = walk(node, depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(query, 0);
}

function ruleCountOf(query: FilterQuery<unknown>): number {
  const walk = (group: FilterGroupNode<unknown>): number => group.rules.reduce((sum, node) => sum + (node.type === "group" ? walk(node) : 1), 0);
  return walk(query);
}

/** May a rule be added under `parentId` (the root when omitted)? False at the rule cap or below the depth cap. */
export function canAddDashboardFilterRule(query: FilterQuery<unknown>, parentId?: string): boolean {
  const depth = depthOf(query, parentId);
  return depth !== null && ruleCountOf(query) < DASHBOARD_FILTER_TREE_MAX_RULES && depth + 1 <= DASHBOARD_FILTER_TREE_MAX_DEPTH;
}

/** May a group be added under `parentId`? False at the rule cap, and where it could hold no rule (its rules would be deeper than the cap). */
export function canAddDashboardFilterGroup(query: FilterQuery<unknown>, parentId?: string): boolean {
  const depth = depthOf(query, parentId);
  return depth !== null && ruleCountOf(query) < DASHBOARD_FILTER_TREE_MAX_RULES && depth + 1 <= DASHBOARD_FILTER_TREE_MAX_DEPTH - 1;
}

/* ------------------------------------------------------------------ whole-filter helpers (the Dashboard reads a filter only through these and the shared tree helpers) */

/** `filter` for a role: Priority rules removed for an External Editor, Archived rules for a non-Admin. A stale pasted link reads "as default". */
export function clampDashboardFilter(filter: DashboardFilter, allowed: { archived: boolean; priority: boolean }): DashboardFilter {
  return normalizeDashboardFilter({ tree: clampDashboardFilterForRole(dashboardFilterTreeOf(filter), allowed) });
}

/** The Archived scope the filter implies: `hide` with no Archived rule (the shared helper's rules). */
export function dashboardArchivedModeOf(filter: DashboardFilter): DashboardArchivedMode {
  return dashboardFilterArchivedMode(dashboardFilterTreeOf(filter));
}

/** The filter with everything cleared but the Archived scope it already implied (a sheet that broadened Archived keeps it). */
export function dashboardFilterKeepingArchived(filter: DashboardFilter): DashboardFilter {
  const mode = dashboardArchivedModeOf(filter);
  return mode === "hide" ? normalizeDashboardFilter(undefined) : normalizeDashboardFilter({ tree: { ...emptyDashboardFilterTree(), children: [{ kind: "leaf", field: "archived", mode }] } });
}

/**
 * `base` with `filter` written over it, as ONE filter: whatever tree or order `base` carried is dropped
 * first, so a flat `filter` cannot be shadowed by a stale tree (`{ ...base, ...filter }` would keep it:
 * a flat filter has no `tree` key to overwrite it with).
 */
export function applyDashboardFilter<T extends object>(base: T, filter: DashboardFilter): Omit<T, "tree" | "order"> & DashboardFilter {
  const { tree: _tree, order: _order, ...rest } = base as T & { tree?: unknown; order?: unknown };
  return { ...rest, ...filter } as Omit<T, "tree" | "order"> & DashboardFilter;
}

/** How many rules the filter applies (the Filter button's badge). */
export function dashboardFilterAppliedCount(filter: DashboardFilter): number {
  return dashboardFilterRuleCount(dashboardFilterTreeOf(filter));
}
