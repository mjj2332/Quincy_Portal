import { describe, expect, it } from "vitest";
import {
  DEFAULT_DASHBOARD_FILTER,
  dashboardFiltersEqual,
  formatDashboardDateRange,
  parseDashboardDateRange,
  dashboardPriorityFilterValueOf,
  dashboardProjectsFilterQueryParams,
  dashboardProjectsFilterQuerySchema,
  isDefaultDashboardFilter,
  normalizeDashboardFilter,
} from "../src/index";

describe("dashboard filter (#428)", () => {
  const parse = (query: Record<string, string>) => dashboardProjectsFilterQuerySchema.safeParse(query);

  it("parses the Projects-list wire spelling into the canonical filter", () => {
    expect(parse({})).toMatchObject({ success: true, data: { stageKeys: [], priorities: [], archived: "hide" } });
    expect(parse({ stages: "delivered,editing", priority: "none,5,1", archived: "include" })).toMatchObject({
      success: true, data: { stageKeys: ["editing", "delivered"], priorities: ["5", "1", "none"], archived: "include" },
    });
    expect(parse({ archived: "only" })).toMatchObject({ success: true, data: { archived: "only" } });
  });

  it("keeps the pre-#428 archived=1 spelling as archived-only", () => {
    expect(parse({ archived: "1" })).toMatchObject({ success: true, data: { archived: "only" } });
  });

  it("rejects non-spellings, duplicates, unknowns, empties and stray keys", () => {
    for (const query of [
      { archived: "hide" }, { archived: "0" }, { archived: "" }, { archived: "true" },
      { stages: "" }, { stages: "nope" }, { stages: "editing,editing" }, { stages: "editing," }, { stages: "editing_autohdr" },
      { priority: "" }, { priority: "6" }, { priority: "5,5" }, { priority: "none,none" }, { priority: "0" },
      { q: "x" },
    ]) expect(parse(query).success, JSON.stringify(query)).toBe(false);
  });

  it("serialises defaults away and round-trips through the schema", () => {
    expect(dashboardProjectsFilterQueryParams(normalizeDashboardFilter(undefined))).toEqual([]);
    const filter = normalizeDashboardFilter({ stageKeys: ["editing", "delivered"], priorities: ["4", "none"], archived: "only" });
    const params = dashboardProjectsFilterQueryParams(filter);
    expect(params).toEqual([["stages", "editing,delivered"], ["priority", "4,none"], ["archived", "only"]]);
    expect(dashboardProjectsFilterQuerySchema.parse(Object.fromEntries(params))).toEqual(filter);
  });

  it("normalises, compares and maps priorities", () => {
    expect(normalizeDashboardFilter({ stageKeys: ["delivered", "editing"], priorities: ["none", "5"] })).toEqual({ ...DEFAULT_DASHBOARD_FILTER, stageKeys: ["editing", "delivered"], priorities: ["5", "none"] });
    expect(isDefaultDashboardFilter(undefined)).toBe(true);
    expect(isDefaultDashboardFilter(normalizeDashboardFilter({ archived: "include" }))).toBe(false);
    expect(dashboardFiltersEqual(normalizeDashboardFilter({ priorities: ["5"] }), normalizeDashboardFilter({ priorities: ["5"] }))).toBe(true);
    expect(dashboardFiltersEqual(normalizeDashboardFilter({ priorities: ["5"] }), normalizeDashboardFilter({ priorities: ["4"] }))).toBe(false);
    expect(dashboardPriorityFilterValueOf(null)).toBe("none");
    expect(dashboardPriorityFilterValueOf(3)).toBe("3");
  });

  describe("People, date ranges, Overdue and My tasks (#429)", () => {
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";

    it("parses the relation and date facets into the canonical filter", () => {
      expect(parse({ editors: `${b},${a}`, unassigned: "1", shoot: "2026-08-01..2026-08-31", overdue: "1", mine: "1" })).toMatchObject({
        success: true,
        data: { editorIds: [a, b], includeUnassigned: true, shootRange: { from: "2026-08-01", to: "2026-08-31" }, deadlineRange: null, overdueOnly: true, myTasks: true },
      });
      expect(parse({ deadline: "2026-08-30..2026-08-30" })).toMatchObject({ success: true, data: { deadlineRange: { from: "2026-08-30", to: "2026-08-30" }, overdueOnly: false } });
    });

    it("rejects malformed People, ranges and flags, and a Deadline range beside Overdue", () => {
      const tooMany = Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`).join(",");
      for (const query of [
        { editors: "" }, { editors: "nope" }, { editors: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }, { editors: `${a},${a}` }, { editors: `${a},` }, { editors: tooMany },
        { unassigned: "0" }, { unassigned: "true" }, { overdue: "0" }, { mine: "" },
        { shoot: "" }, { shoot: "2026-08-01" }, { shoot: "2026-08-31..2026-08-01" }, { shoot: "2026-02-30..2026-03-01" }, { shoot: "2026-8-1..2026-8-2" }, { deadline: "2026-08-01.." },
        { deadline: "2026-08-01..2026-08-02", overdue: "1" },
      ]) expect(parse(query).success, JSON.stringify(query)).toBe(false);
    });

    it("serialises the new facets in a fixed order and round-trips through the schema", () => {
      const filter = normalizeDashboardFilter({ editorIds: [b, a], includeUnassigned: true, stageKeys: ["editing"], shootRange: { from: "2026-08-01", to: "2026-08-31" }, deadlineRange: { from: "2026-09-01", to: "2026-09-02" }, myTasks: true });
      const params = dashboardProjectsFilterQueryParams(filter);
      expect(params).toEqual([["editors", `${a},${b}`], ["unassigned", "1"], ["stages", "editing"], ["shoot", "2026-08-01..2026-08-31"], ["deadline", "2026-09-01..2026-09-02"], ["mine", "1"]]);
      expect(dashboardProjectsFilterQuerySchema.parse(Object.fromEntries(params))).toEqual(filter);
      const overdue = normalizeDashboardFilter({ overdueOnly: true });
      expect(dashboardProjectsFilterQuerySchema.parse(Object.fromEntries(dashboardProjectsFilterQueryParams(overdue)))).toEqual(overdue);
    });

    it("keeps one Deadline rule: a range wins over Overdue when normalising", () => {
      expect(normalizeDashboardFilter({ overdueOnly: true, deadlineRange: { from: "2026-08-01", to: "2026-08-02" } })).toMatchObject({ overdueOnly: false, deadlineRange: { from: "2026-08-01", to: "2026-08-02" } });
    });

    it("compares and defaults every new field", () => {
      expect(isDefaultDashboardFilter(normalizeDashboardFilter({ editorIds: [a] }))).toBe(false);
      expect(isDefaultDashboardFilter(normalizeDashboardFilter({ includeUnassigned: true }))).toBe(false);
      expect(isDefaultDashboardFilter(normalizeDashboardFilter({ shootRange: { from: "2026-08-01", to: "2026-08-01" } }))).toBe(false);
      expect(isDefaultDashboardFilter(normalizeDashboardFilter({ overdueOnly: true }))).toBe(false);
      expect(isDefaultDashboardFilter(normalizeDashboardFilter({ myTasks: true }))).toBe(false);
      expect(dashboardFiltersEqual(normalizeDashboardFilter({ editorIds: [b, a] }), normalizeDashboardFilter({ editorIds: [a, b] }))).toBe(true);
      expect(dashboardFiltersEqual(normalizeDashboardFilter({ editorIds: [a] }), normalizeDashboardFilter({ editorIds: [b] }))).toBe(false);
      expect(dashboardFiltersEqual(normalizeDashboardFilter({ shootRange: { from: "2026-08-01", to: "2026-08-02" } }), normalizeDashboardFilter({ shootRange: { from: "2026-08-01", to: "2026-08-03" } }))).toBe(false);
      expect(dashboardFiltersEqual(normalizeDashboardFilter({ myTasks: true }), normalizeDashboardFilter({}))).toBe(false);
    });

    it("spells and parses a range", () => {
      expect(formatDashboardDateRange({ from: "2026-08-01", to: "2026-08-31" })).toBe("2026-08-01..2026-08-31");
      expect(parseDashboardDateRange("2026-08-01..2026-08-31")).toEqual({ from: "2026-08-01", to: "2026-08-31" });
      expect(parseDashboardDateRange("2026-08-01..2026-08-01")).toEqual({ from: "2026-08-01", to: "2026-08-01" });
      expect(parseDashboardDateRange("2026-08-02..2026-08-01")).toBeNull();
      expect(parseDashboardDateRange("2026-08-01")).toBeNull();
    });
  });
});
