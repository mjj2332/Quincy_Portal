import { describe, expect, it } from "vitest";
import {
  canonicalLegacyDashboardLocation,
  dashboardFilterOf,
  dashboardFilterTreeOf,
  parseDashboardFilterTree,
  parseStaffLocation,
  staffPathFor,
  withDashboardFilter,
  type DashboardFilter,
  type DashboardFilterTree,
  type StaffRoute,
} from "../src/index";

/** #461: `f=1:<tree>` and `forder=` in the staff URL, on the three arms that carry the shared Filter. */
const TREE = "1:or(stages=editing;overdue)";
const treeOf = (raw: string): DashboardFilterTree => {
  const parsed = parseDashboardFilterTree(raw);
  if ("error" in parsed) throw new Error(raw);
  return parsed.tree;
};
const F = new URLSearchParams([["f", TREE]]).toString().slice(2);

describe("filter tree in the staff URL (#461)", () => {
  const CALENDAR = "view=calendar&date=2026-08-30&sub=month&layers=project%2Cchecklist";
  it.each([
    ["table", "/?view=table"],
    ["board", "/?view=board"],
    ["timeline", "/?view=timeline"],
    ["calendar", `/?${CALENDAR}`],
  ])("%s carries f and round trips byte for byte", (_name, base) => {
    const location = `${base}&f=${new URLSearchParams([["f", TREE]]).toString().slice(2)}`;
    const route = parseStaffLocation(location);
    expect(route.kind).toBe("dashboard");
    const filter = dashboardFilterOf(route);
    expect(filter.tree).toEqual(treeOf(TREE));
    expect(filter.stageKeys).toEqual([]);
    const written = staffPathFor(route as Exclude<StaffRoute, { kind: "not-found" } | { kind: "reserved" }>);
    expect(parseStaffLocation(written)).toEqual(route);
    expect(staffPathFor(parseStaffLocation(written) as never)).toBe(written);
    expect(written).toContain("f=1%3Aor%28stages%3Dediting%3Boverdue%29");
  });

  it("withDashboardFilter writes a tree, then clears it", () => {
    const route = parseStaffLocation("/?view=table") as Extract<StaffRoute, { kind: "dashboard" }>;
    const tree = treeOf(TREE);
    const withTree = withDashboardFilter(route, { ...dashboardFilterOf(route), tree });
    expect(staffPathFor(withTree as never)).toBe("/?view=table&f=1%3Aor%28stages%3Dediting%3Boverdue%29");
    const cleared = withDashboardFilter(withTree, dashboardFilterOf(route));
    expect(staffPathFor(cleared as never)).toBe("/?view=table");
    const calendarRoute = parseStaffLocation(`/?${CALENDAR}&f=${F}`) as Extract<StaffRoute, { kind: "dashboard" }>;
    expect(staffPathFor(withDashboardFilter(calendarRoute, dashboardFilterOf(parseStaffLocation(`/?${CALENDAR}`))) as never)).toBe(`/?${CALENDAR}`);
  });

  it("a canonical flat AND tree writes neither f nor forder", () => {
    const flat: DashboardFilter = { stageKeys: ["editing"], priorities: [], archived: "hide", editorIds: [], includeUnassigned: false, shootRange: null, deadlineRange: null, overdueOnly: false, myTasks: true };
    const route = withDashboardFilter(parseStaffLocation("/?view=table") as Extract<StaffRoute, { kind: "dashboard" }>, { ...flat, tree: dashboardFilterTreeOf(flat) });
    expect(staffPathFor(route as never)).toBe("/?view=table&stages=editing&mine=1");
  });

  it("a reordered flat tree writes forder after q and nothing else new", () => {
    const flat: DashboardFilter = { stageKeys: ["editing"], priorities: [], archived: "hide", editorIds: [], includeUnassigned: false, shootRange: null, deadlineRange: null, overdueOnly: false, myTasks: true, order: ["mine", "stages"] };
    const route = { ...withDashboardFilter(parseStaffLocation("/?view=table") as Extract<StaffRoute, { kind: "dashboard" }>, flat), search: "x" };
    const path = staffPathFor(route as never);
    expect(path).toBe("/?view=table&stages=editing&mine=1&q=x&forder=mine%2Cstages");
    expect(dashboardFilterOf(parseStaffLocation(path)).order).toEqual(["mine", "stages"]);
    expect(staffPathFor(parseStaffLocation(path) as never)).toBe(path);
    const cal = parseStaffLocation(`/?${CALENDAR}&stages=editing&mine=1&forder=mine%2Cstages`);
    expect(dashboardFilterOf(cal).order).toEqual(["mine", "stages"]);
  });

  it.each([
    ["missing facet", "/?view=table&stages=editing&mine=1&priority=5&forder=mine%2Cstages"],
    ["extra facet", "/?view=table&stages=editing&mine=1&forder=mine%2Cstages%2Cpeople"],
    ["duplicate", "/?view=table&stages=editing&mine=1&forder=mine%2Cmine"],
    ["canonical order spelled out", "/?view=table&stages=editing&mine=1&forder=stages%2Cmine"],
    ["unknown facet", "/?view=table&stages=editing&forder=nope"],
    ["forder alone", "/?view=table&forder=mine%2Cstages"],
    ["f with a legacy facet", `/?view=table&stages=editing&f=${F}`],
    ["f with forder", `/?view=table&forder=mine%2Cstages&f=${F}`],
    ["legacy-expressible f", `/?view=table&f=${new URLSearchParams([["f", "1:and(stages=editing;mine)"]]).toString().slice(2)}`],
    ["raw delimiters in f", `/?view=table&f=${TREE}`],
    ["bad version", `/?view=table&f=${new URLSearchParams([["f", "2:or(stages=editing;overdue)"]]).toString().slice(2)}`],
    ["f twice", `/?view=table&f=${F}&f=${F}`],
  ])("is not-found: %s", (_name, location) => {
    expect(parseStaffLocation(location).kind).toBe("not-found");
  });

  it("the retired view spelling rewrite carries f", () => {
    expect(canonicalLegacyDashboardLocation(`/?view=kanban&f=${F}`)).toBe("/?view=board&f=1%3Aor%28stages%3Dediting%3Boverdue%29");
  });
});
