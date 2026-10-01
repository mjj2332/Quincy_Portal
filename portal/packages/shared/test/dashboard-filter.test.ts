import { describe, expect, it } from "vitest";
import {
  dashboardFiltersEqual,
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
    expect(dashboardProjectsFilterQueryParams({ stageKeys: [], priorities: [], archived: "hide" })).toEqual([]);
    const filter = { stageKeys: ["editing", "delivered"] as const, priorities: ["4", "none"] as const, archived: "only" as const };
    const params = dashboardProjectsFilterQueryParams({ stageKeys: [...filter.stageKeys], priorities: [...filter.priorities], archived: filter.archived });
    expect(params).toEqual([["stages", "editing,delivered"], ["priority", "4,none"], ["archived", "only"]]);
    expect(dashboardProjectsFilterQuerySchema.parse(Object.fromEntries(params))).toEqual(filter);
  });

  it("normalises, compares and maps priorities", () => {
    expect(normalizeDashboardFilter({ stageKeys: ["delivered", "editing"], priorities: ["none", "5"] })).toEqual({ stageKeys: ["editing", "delivered"], priorities: ["5", "none"], archived: "hide" });
    expect(isDefaultDashboardFilter(undefined)).toBe(true);
    expect(isDefaultDashboardFilter(normalizeDashboardFilter({ archived: "include" }))).toBe(false);
    expect(dashboardFiltersEqual(normalizeDashboardFilter({ priorities: ["5"] }), normalizeDashboardFilter({ priorities: ["5"] }))).toBe(true);
    expect(dashboardFiltersEqual(normalizeDashboardFilter({ priorities: ["5"] }), normalizeDashboardFilter({ priorities: ["4"] }))).toBe(false);
    expect(dashboardPriorityFilterValueOf(null)).toBe("none");
    expect(dashboardPriorityFilterValueOf(3)).toBe("3");
  });
});
