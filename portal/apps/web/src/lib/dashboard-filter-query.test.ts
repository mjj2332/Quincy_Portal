import { describe, expect, it } from "vitest";
import { DEFAULT_DASHBOARD_FILTER, normalizeDashboardFilter, type DashboardFilter } from "@quincy/shared";
import { dashboardFilterKey, dashboardFilterNarrowCount, dashboardFilterToQuery, queryToDashboardFilter, DASHBOARD_UNASSIGNED_OPTION } from "./dashboard-filter-query";

const E1 = "11111111-1111-4111-8111-111111111111";
const E2 = "22222222-2222-4222-8222-222222222222";
const filterOf = (over: Partial<DashboardFilter> = {}): DashboardFilter => normalizeDashboardFilter({ ...DEFAULT_DASHBOARD_FILTER, ...over });

describe("the Dashboard Filter <-> chip query, People and date facets (#429)", () => {
  const cases: Array<[string, DashboardFilter]> = [
    ["people", filterOf({ editorIds: [E2, E1] })],
    ["unassigned alone", filterOf({ includeUnassigned: true })],
    ["people and unassigned", filterOf({ editorIds: [E1], includeUnassigned: true })],
    ["shoot range", filterOf({ shootRange: { from: "2026-08-01", to: "2026-08-31" } })],
    ["deadline range", filterOf({ deadlineRange: { from: "2026-09-01", to: "2026-09-01" } })],
    ["overdue", filterOf({ overdueOnly: true })],
    ["my tasks", filterOf({ myTasks: true })],
    ["everything", filterOf({ stageKeys: ["editing"], priorities: ["5"], archived: "include", editorIds: [E1], includeUnassigned: true, shootRange: { from: "2026-08-01", to: "2026-08-02" }, overdueOnly: true, myTasks: true })],
  ];

  it.each(cases)("round-trips %s", (_name, filter) => {
    expect(queryToDashboardFilter(dashboardFilterToQuery(filter))).toEqual(filter);
  });

  it("draws one rule per field: Deadline is a range or Overdue, never both", () => {
    const paths = (filter: DashboardFilter) => dashboardFilterToQuery(filter).rules.map((rule) => (rule.type === "rule" ? `${rule.path[0]}:${rule.operator}` : "group"));
    expect(paths(filterOf({ deadlineRange: { from: "2026-09-01", to: "2026-09-02" }, overdueOnly: true }))).toEqual(["deadline:between"]);
    expect(paths(filterOf({ overdueOnly: true }))).toEqual(["deadline:overdue"]);
    expect(paths(filterOf({ editorIds: [E1], includeUnassigned: true }))).toEqual(["people:is_any_of"]);
  });

  it("puts Unassigned first in the People value and keeps ids sorted", () => {
    const rule = dashboardFilterToQuery(filterOf({ editorIds: [E2, E1], includeUnassigned: true })).rules[0];
    expect(rule?.type === "rule" && rule.value).toEqual([DASHBOARD_UNASSIGNED_OPTION, E1, E2]);
  });

  it("vetoes what the URL cannot say", () => {
    const rule = (path: string, operator: string, value: unknown, id = path) => ({ id, type: "rule" as const, path: [path], operator, value });
    const root = (...rules: ReturnType<typeof rule>[]) => ({ id: "r", type: "group" as const, combinator: "and" as const, rules });
    expect(queryToDashboardFilter(root(rule("people", "is_any_of", ["not-a-uuid"])))).toBeNull();
    expect(queryToDashboardFilter(root(rule("shoot", "between", ["2026-08-31", "2026-08-01"])))).toBeNull();
    expect(queryToDashboardFilter(root(rule("shoot", "between", ["2026-02-30", "2026-03-01"])))).toBeNull();
    expect(queryToDashboardFilter(root(rule("shoot", "overdue", undefined)))).toBeNull();
    expect(queryToDashboardFilter(root(rule("deadline", "between", ["2026-09-01", "2026-09-02"]), rule("deadline", "overdue", undefined, "d2")))).toBeNull();
    expect(queryToDashboardFilter(root(rule("mine", "is", undefined)))).toBeNull();
    expect(queryToDashboardFilter(root(rule("priority", "is_any_of", ["5"])), { priorityAllowed: false })).toBeNull();
    // An unfinished rule reads as the default.
    expect(queryToDashboardFilter(root(rule("mine", "", undefined)))).toEqual(DEFAULT_DASHBOARD_FILTER);
  });

  it("counts a narrowing facet once per field and keys by value", () => {
    expect(dashboardFilterNarrowCount(filterOf({ editorIds: [E1], includeUnassigned: true, overdueOnly: true, myTasks: true }))).toBe(3);
    expect(dashboardFilterKey(filterOf({ editorIds: [E2, E1] }))).toBe(dashboardFilterKey(filterOf({ editorIds: [E1, E2] })));
    expect(dashboardFilterKey(filterOf({ myTasks: true }))).not.toBe(dashboardFilterKey(filterOf()));
  });
});
