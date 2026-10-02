import { describe, expect, it } from "vitest";
import {
  DASHBOARD_FILTER_TREE_MAX_PEOPLE_IDS,
  DEFAULT_DASHBOARD_FILTER,
  dashboardFilterTreeOf,
  normalizeDashboardFilter,
  type DashboardFilter,
  type DashboardFilterTree,
} from "@quincy/shared";
import type { FilterNode, FilterQuery } from "../components/reui/filters/filters-types";
import {
  applyDashboardFilter,
  clampDashboardFilter,
  dashboardArchivedModeOf,
  dashboardFilterAppliedCount,
  dashboardFilterKeepingArchived,
  canAddDashboardFilterGroup,
  canAddDashboardFilterRule,
  dashboardFilterKey,
  dashboardFilterToQuery,
  queryToDashboardFilter,
  queryToDashboardFilterResult,
  DASHBOARD_FILTER_RULE_ID,
  DASHBOARD_UNASSIGNED_OPTION,
} from "./dashboard-filter-query";

const E1 = "11111111-1111-4111-8111-111111111111";
const E2 = "22222222-2222-4222-8222-222222222222";
const filterOf = (over: Partial<DashboardFilter> = {}): DashboardFilter => normalizeDashboardFilter({ ...DEFAULT_DASHBOARD_FILTER, ...over });
const treeFilter = (tree: DashboardFilterTree): DashboardFilter => normalizeDashboardFilter({ tree });

type Rule = Extract<FilterNode<unknown>, { type: "rule" }>;
const rule = (path: string, operator: string, value: unknown, id: string = path, negated?: boolean): Rule => ({ id, type: "rule", path: [path], operator, value, ...(negated ? { negated } : {}) });
const group = (combinator: "and" | "or", id: string, ...rules: FilterNode<unknown>[]): FilterQuery<unknown> => ({ id, type: "group", combinator, rules });
const root = (...rules: FilterNode<unknown>[]) => group("and", "r", ...rules);
const orRoot = (...rules: FilterNode<unknown>[]) => group("or", "r", ...rules);
const stage = (id: string, ...values: string[]) => rule("stage", "is_any_of", values, id);
const priority = (id: string, ...values: string[]) => rule("priority", "is_any_of", values, id);

describe("the Dashboard Filter <-> popover query: flat filters (#429, kept by #461)", () => {
  const cases: Array<[string, DashboardFilter]> = [
    ["people", filterOf({ editorIds: [E2, E1] })],
    ["unassigned alone", filterOf({ includeUnassigned: true })],
    ["people and unassigned", filterOf({ editorIds: [E1], includeUnassigned: true })],
    ["shoot range", filterOf({ shootRange: { from: "2026-08-01", to: "2026-08-31" } })],
    ["deadline range", filterOf({ deadlineRange: { from: "2026-09-01", to: "2026-09-01" } })],
    ["overdue", filterOf({ overdueOnly: true })],
    ["my tasks", filterOf({ myTasks: true })],
    ["everything", filterOf({ stageKeys: ["editing"], priorities: ["5"], archived: "include", editorIds: [E1], includeUnassigned: true, shootRange: { from: "2026-08-01", to: "2026-08-02" }, overdueOnly: true, myTasks: true })],
    ["a reordered flat filter", filterOf({ stageKeys: ["editing"], priorities: ["5"], order: ["priority", "stages"] })],
  ];

  it.each(cases)("round-trips %s", (_name, filter) => {
    expect(queryToDashboardFilter(dashboardFilterToQuery(filter))).toEqual(filter);
  });

  it("keeps the stable dashboard-<field> rule ids of a flat filter, in its order", () => {
    const ids = (filter: DashboardFilter) => dashboardFilterToQuery(filter).rules.map((node) => node.id);
    expect(ids(filterOf({ priorities: ["5"], stageKeys: ["editing"] }))).toEqual([DASHBOARD_FILTER_RULE_ID.stage, DASHBOARD_FILTER_RULE_ID.priority]);
    expect(ids(filterOf({ priorities: ["5"], stageKeys: ["editing"], order: ["priority", "stages"] }))).toEqual([DASHBOARD_FILTER_RULE_ID.priority, DASHBOARD_FILTER_RULE_ID.stage]);
    expect(dashboardFilterToQuery(filterOf({ overdueOnly: true })).rules[0]).toMatchObject({ id: DASHBOARD_FILTER_RULE_ID.deadline, path: ["deadline"], operator: "overdue" });
  });

  it("puts Unassigned first in the People value and keeps ids sorted", () => {
    const first = dashboardFilterToQuery(filterOf({ editorIds: [E2, E1], includeUnassigned: true })).rules[0];
    expect(first?.type === "rule" && first.value).toEqual([DASHBOARD_UNASSIGNED_OPTION, E1, E2]);
  });

  it("is flat whenever the legacy spelling can say it", () => {
    const flat = queryToDashboardFilter(root(stage("a", "editing"), priority("b", "5")))!;
    expect(flat.tree).toBeUndefined();
    expect(flat).toEqual(filterOf({ stageKeys: ["editing"], priorities: ["5"] }));
    // An OR root with one rule is the same filter.
    expect(queryToDashboardFilter(orRoot(stage("a", "editing")))).toEqual(filterOf({ stageKeys: ["editing"] }));
    // A one-rule group is a flat AND of its rules only when nothing else needs the structure: still a tree here.
    expect(queryToDashboardFilter(root(group("or", "g", stage("a", "editing"))))?.tree).toBeDefined();
  });

  it("keys by value, order and tree", () => {
    expect(dashboardFilterKey(filterOf({ editorIds: [E2, E1] }))).toBe(dashboardFilterKey(filterOf({ editorIds: [E1, E2] })));
    expect(dashboardFilterKey(filterOf({ myTasks: true }))).not.toBe(dashboardFilterKey(filterOf()));
    // A reorder is a different key: it must push a history entry.
    expect(dashboardFilterKey(filterOf({ stageKeys: ["editing"], priorities: ["5"], order: ["priority", "stages"] }))).not.toBe(dashboardFilterKey(filterOf({ stageKeys: ["editing"], priorities: ["5"] })));
    const a = treeFilter({ kind: "group", op: "or", children: [{ kind: "leaf", field: "stages", values: ["editing"] }, { kind: "leaf", field: "mine" }] });
    const b = treeFilter({ kind: "group", op: "or", children: [{ kind: "leaf", field: "mine" }, { kind: "leaf", field: "stages", values: ["editing"] }] });
    expect(dashboardFilterKey(a)).not.toBe(dashboardFilterKey(b));
    expect(dashboardFilterKey(a)).not.toBe(dashboardFilterKey(filterOf()));
  });
});

describe("tree filters", () => {
  const orTree: DashboardFilterTree = { kind: "group", op: "or", children: [{ kind: "leaf", field: "stages", values: ["editing"] }, { kind: "leaf", field: "priority", values: ["5"] }] };

  it("accepts OR, groups, repeats, negation and a Deadline range beside Overdue", () => {
    expect(queryToDashboardFilter(orRoot(stage("a", "editing"), priority("b", "5")))?.tree).toEqual(orTree);
    const grouped = queryToDashboardFilter(root(stage("a", "editing"), group("or", "g", rule("mine", "only", undefined), rule("people", "is_any_of", [E1]))));
    expect(grouped?.tree).toEqual({ kind: "group", op: "and", children: [{ kind: "leaf", field: "stages", values: ["editing"] }, { kind: "group", op: "or", children: [{ kind: "leaf", field: "mine" }, { kind: "leaf", field: "people", ids: [E1], unassigned: false }] }] });
    expect(queryToDashboardFilter(root(stage("a", "editing"), stage("b", "delivered")))?.tree).toBeDefined();
    expect(queryToDashboardFilter(root(stage("a", "editing", "delivered")))).toEqual(filterOf({ stageKeys: ["editing", "delivered"] }));
    expect(queryToDashboardFilter(root(rule("stage", "is_any_of", ["editing"], "a", true)))?.tree).toEqual({ kind: "group", op: "and", children: [{ kind: "leaf", negated: true, field: "stages", values: ["editing"] }] });
    const both = queryToDashboardFilter(root(rule("deadline", "between", ["2026-09-01", "2026-09-02"], "d1"), rule("deadline", "overdue", undefined, "d2")));
    expect(both?.tree?.children).toEqual([{ kind: "leaf", field: "deadline", range: { from: "2026-09-01", to: "2026-09-02" } }, { kind: "leaf", field: "overdue" }]);
    // An explicit Archived=Hidden rule is a tree (it has no flat spelling).
    expect(queryToDashboardFilter(root(rule("archived", "is", "hide")))?.tree?.children).toEqual([{ kind: "leaf", field: "archived", mode: "hide" }]);
  });

  it("round-trips a tree through the popover query with positional ids", () => {
    const filter = treeFilter(orTree);
    const query = dashboardFilterToQuery(filter);
    expect(query.combinator).toBe("or");
    expect(query.rules.map((node) => node.id)).toEqual(["dashboard-t0", "dashboard-t1"]);
    expect(queryToDashboardFilter(query)).toEqual(filter);
    // Stable: the same tree always draws the same ids.
    expect(dashboardFilterToQuery(filter)).toEqual(query);
    const nested = treeFilter({ kind: "group", op: "and", children: [{ kind: "leaf", negated: true, field: "mine" }, { kind: "group", op: "or", children: [{ kind: "leaf", field: "overdue" }, { kind: "leaf", field: "deadline", range: { from: "2026-09-01", to: "2026-09-02" } }] }] });
    expect(queryToDashboardFilter(dashboardFilterToQuery(nested))).toEqual(nested);
  });

  it("drops unfinished rules and empty groups, and a value-less rule reads as unfinished", () => {
    expect(queryToDashboardFilter(root(rule("mine", "", undefined)))).toEqual(DEFAULT_DASHBOARD_FILTER);
    expect(queryToDashboardFilter(root(rule("stage", "is_any_of", []), rule("shoot", "between", undefined), rule("archived", "is", undefined)))).toEqual(DEFAULT_DASHBOARD_FILTER);
    expect(queryToDashboardFilter(orRoot(stage("a", "editing"), rule("mine", "", undefined, "u"), group("or", "g")))).toEqual(filterOf({ stageKeys: ["editing"] }));
    expect(queryToDashboardFilter(root())).toEqual(DEFAULT_DASHBOARD_FILTER);
  });

  it("vetoes only unknown values, forbidden fields and caps", () => {
    expect(queryToDashboardFilter(root(rule("people", "is_any_of", ["not-a-uuid"])))).toBeNull();
    expect(queryToDashboardFilter(root(rule("stage", "is_any_of", ["bogus"])))).toBeNull();
    expect(queryToDashboardFilter(root(rule("shoot", "between", ["2026-08-31", "2026-08-01"])))).toBeNull();
    expect(queryToDashboardFilter(root(rule("shoot", "between", ["2026-02-30", "2026-03-01"])))).toBeNull();
    expect(queryToDashboardFilter(root(rule("shoot", "overdue", undefined)))).toBeNull();
    expect(queryToDashboardFilter(root(rule("mine", "is", undefined)))).toBeNull();
    expect(queryToDashboardFilter(root(rule("nope", "is", "x")))).toBeNull();
    expect(queryToDashboardFilter({ id: "r", type: "group", combinator: "and", rules: [{ ...rule("stage", "is_any_of", ["editing"]), path: ["stage", "x"] }] })).toBeNull();
    expect(queryToDashboardFilter(root(rule("priority", "is_any_of", ["5"])), { priorityAllowed: false })).toBeNull();
    expect(queryToDashboardFilter(root(rule("archived", "is", "only")), { archivedAllowed: false })).toBeNull();
    // An unknown (UUID-shaped) person is kept: the server drops it as "not applied".
    expect(queryToDashboardFilter(root(rule("people", "is_any_of", [E2])))).toEqual(filterOf({ editorIds: [E2] }));
  });

  it("vetoes more than 20 rules (unfinished ones count), depth 4 and 51 People ids, and says why", () => {
    const rules = (count: number) => Array.from({ length: count }, (_, index) => rule("mine", index % 2 ? "only" : "", undefined, `m${index}`));
    expect(queryToDashboardFilter(root(...rules(20)))).not.toBeNull();
    expect(queryToDashboardFilterResult(root(...rules(21)))).toEqual({ veto: "cap" });
    // Depth: root > group > group > rule is depth 3; one level more is not allowed.
    const deep3 = root(group("or", "g1", group("or", "g2", rule("mine", "only", undefined, "x"))));
    expect(queryToDashboardFilter(deep3)).not.toBeNull();
    const deep4 = root(group("or", "g1", group("or", "g2", group("or", "g3", rule("mine", "only", undefined, "x")))));
    expect(queryToDashboardFilterResult(deep4)).toEqual({ veto: "cap" });
    const ids = Array.from({ length: DASHBOARD_FILTER_TREE_MAX_PEOPLE_IDS + 1 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    expect(queryToDashboardFilterResult(root(rule("people", "is_any_of", ids)))).toEqual({ veto: "cap" });
    expect(queryToDashboardFilterResult(root(rule("stage", "is_any_of", ["bogus"])))).toEqual({ veto: "invalid" });
  });

  it("answers whether a rule or a group may be added under a parent", () => {
    const full = root(...Array.from({ length: 20 }, (_, index) => rule("mine", "only", undefined, `m${index}`)));
    expect(canAddDashboardFilterRule(root(), "r")).toBe(true);
    expect(canAddDashboardFilterRule(full, "r")).toBe(false);
    expect(canAddDashboardFilterGroup(full, "r")).toBe(false);
    // A group may sit at depth 1 and 2; at depth 3 it could hold nothing.
    const nest = root(group("or", "g1", group("or", "g2", rule("mine", "only", undefined, "x"))));
    expect(canAddDashboardFilterGroup(nest, "r")).toBe(true);
    expect(canAddDashboardFilterGroup(nest, "g1")).toBe(true);
    expect(canAddDashboardFilterGroup(nest, "g2")).toBe(false);
    expect(canAddDashboardFilterRule(nest, "g2")).toBe(true);
  });

  it("reads a tree as the same tree the shared accessor gives", () => {
    const filter = treeFilter(orTree);
    expect(dashboardFilterTreeOf(filter)).toEqual(orTree);
  });
});

describe("whole-filter helpers", () => {
  const orTree: DashboardFilterTree = { kind: "group", op: "or", children: [{ kind: "leaf", field: "priority", values: ["5"] }, { kind: "leaf", field: "archived", mode: "only" }, { kind: "leaf", field: "stages", values: ["editing"] }] };

  it("clamps by role: AND widens (flat in, flat out), OR narrows, and a tree that becomes flat is flat", () => {
    const flat = filterOf({ stageKeys: ["editing"], priorities: ["5"], archived: "only" });
    expect(clampDashboardFilter(flat, { archived: false, priority: false })).toEqual(filterOf({ stageKeys: ["editing"] }));
    expect(clampDashboardFilter(flat, { archived: true, priority: true })).toEqual(flat);
    const clamped = clampDashboardFilter(treeFilter(orTree), { archived: false, priority: false });
    expect(clamped).toEqual(filterOf({ stageKeys: ["editing"] }));
    expect(clampDashboardFilter(treeFilter(orTree), { archived: true, priority: false }).tree?.children).toHaveLength(2);
    // The flat order survives a clamp that removes another facet.
    expect(clampDashboardFilter(filterOf({ stageKeys: ["editing"], priorities: ["5"], archived: "only", order: ["archived", "priority", "stages"] }), { archived: true, priority: false })).toEqual(filterOf({ stageKeys: ["editing"], archived: "only", order: ["archived", "stages"] }));
  });

  it("reads the archived scope from the tree helper", () => {
    expect(dashboardArchivedModeOf(filterOf({ archived: "only" }))).toBe("only");
    expect(dashboardArchivedModeOf(filterOf())).toBe("hide");
    expect(dashboardArchivedModeOf(treeFilter(orTree))).toBe("include");
  });

  it("keeps only the Archived scope when clearing", () => {
    expect(dashboardFilterKeepingArchived(filterOf({ stageKeys: ["editing"], archived: "include" }))).toEqual(filterOf({ archived: "include" }));
    expect(dashboardFilterKeepingArchived(filterOf({ stageKeys: ["editing"] }))).toEqual(filterOf());
    expect(dashboardFilterKeepingArchived(treeFilter(orTree))).toEqual(filterOf({ archived: "include" }));
  });

  it("writes a filter over a base without letting a stale tree survive", () => {
    const base = { view: "calendar", ...treeFilter(orTree) };
    const next = applyDashboardFilter(base, filterOf({ myTasks: true }));
    expect(next.tree).toBeUndefined();
    expect(next).toMatchObject({ view: "calendar", myTasks: true });
    expect(applyDashboardFilter({ view: "x", ...filterOf({ stageKeys: ["editing"], priorities: ["5"], order: ["priority", "stages"] }) }, filterOf({ stageKeys: ["editing"] })).order).toBeUndefined();
    expect(applyDashboardFilter({ view: "x" }, treeFilter(orTree)).tree).toEqual(orTree);
  });

  it("counts the applied rules, groups' leaves included", () => {
    expect(dashboardFilterAppliedCount(filterOf())).toBe(0);
    expect(dashboardFilterAppliedCount(filterOf({ editorIds: [E1], includeUnassigned: true, overdueOnly: true, myTasks: true }))).toBe(3);
    expect(dashboardFilterAppliedCount(treeFilter(orTree))).toBe(3);
  });
});
