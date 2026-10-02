/**
 * Dashboard search key/cache seam — #217. Node-environment tests: the query key shapes and the
 * `removeProjectFromDashboardQueries` purge, independent of any component or network call.
 */
import { describe, expect, it } from "vitest";
import { hashKey, QueryClient } from "@tanstack/react-query";
import { dashboardProjectSearchKey, dashboardProjectsKey, dashboardProjectsKeyPrefix, isDashboardProjectsQueryFor, mapInternalProjects, removeProjectFromDashboardQueries } from "./dashboard-projects";
import type { ProjectSummary } from "./kanban-interaction";

function client() { return new QueryClient({ defaultOptions: { queries: { retry: false } } }); }
function project(id: string): ProjectSummary {
  return { id, street: id, suburb: null, postcode: null, agencyName: null, agentName: null, stageKey: "raw_review", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: null, editors: [], boardContractEnabled: true, boardRevision: 0, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null } as unknown as ProjectSummary;
}

describe("dashboardProjectsKey / dashboardProjectSearchKey (#217)", () => {
  // #217 fix round 1, item 7: an empty `q` must hash IDENTICALLY to the pre-#217 key, not merely
  // look similar -- react-query's own key hashing is shape-sensitive, so `{ archived }` and
  // `{ archived, q: "" }` are different cache entries. This asserts deep equality against the
  // literal pre-#217 tuple shape (no `q` property at all when `q` is empty), not a same-shape
  // "byte-identical" claim that was actually asserting a changed shape.
  // #428: `archived` is now the mode string ("hide" | "include" | "only"), and the facets (`stages`,
  // `priority`) join the trailing object only when they narrow, so the default key keeps this shape.
  const PRE_217_KEY = ["dashboard-projects", "p", "admin", 0, { archived: "hide" }] as const;

  it("an empty q produces the exact pre-#217 key literal -- no q property at all", () => {
    expect(dashboardProjectsKey("p", "admin", 0, { archived: "hide" })).toEqual(PRE_217_KEY);
    expect(dashboardProjectsKey("p", "admin", 0, { archived: "hide" })[4]).not.toHaveProperty("q");
  });

  it("an empty q hashes IDENTICALLY to the pre-#217 key under react-query's own hashKey, not merely structurally-equal", () => {
    expect(hashKey(dashboardProjectsKey("p", "admin", 0, { archived: "hide" }))).toBe(hashKey(PRE_217_KEY));
  });

  it("a non-empty q widens the trailing object instead of adding a sixth element", () => {
    expect(dashboardProjectsKey("p", "admin", 0, { archived: "hide" }, "smith")).toEqual(["dashboard-projects", "p", "admin", 0, { archived: "hide", q: "smith" }]);
    expect(dashboardProjectsKey("p", "admin", 0, { archived: "hide" }, "smith")).not.toEqual(PRE_217_KEY);
  });

  it("widens the trailing object by the facets that narrow, in a fixed shape, and by nothing else (#428)", () => {
    const key = dashboardProjectsKey("p", "admin", 0, { archived: "include", stageKeys: ["editing"], priorities: ["5", "none"] }, "smith");
    expect(key[4]).toEqual({ archived: "include", q: "smith", stages: ["editing"], priority: ["5", "none"] });
    expect(dashboardProjectsKey("p", "admin", 0, { archived: "only", stageKeys: [], priorities: [] })[4]).toEqual({ archived: "only" });
  });

  it("uses a distinct key[0] for the search-counts sibling, so prefix scans on \"dashboard-projects\" never match it", () => {
    const searchKey = dashboardProjectSearchKey("p", "admin", 0, { archived: "hide" }, "smith");
    expect(searchKey[0]).toBe("dashboard-project-search");
    expect(searchKey[0]).not.toBe(dashboardProjectsKey("p", "admin", 0, { archived: "hide" }, "smith")[0]);
  });
});

describe("removeProjectFromDashboardQueries (#217)", () => {
  it("filters the removed project out of the projects list and purges the sibling search-counts cache", () => {
    const queryClient = client();
    const listKey = dashboardProjectsKey("principal", "admin", 0, { archived: "hide" });
    const searchKey = dashboardProjectSearchKey("principal", "admin", 0, { archived: "hide" }, "smith");
    queryClient.setQueryData(listKey, [project("a"), project("b")]);
    queryClient.setQueryData(searchKey, { query: "smith", matching: 1, total: 2 });

    removeProjectFromDashboardQueries(queryClient, "principal", "a");

    expect(queryClient.getQueryData<ProjectSummary[]>(listKey)?.map((p) => p.id)).toEqual(["b"]);
    expect(queryClient.getQueryData(searchKey)).toBeUndefined();
  });

  it("leaves another principal's caches untouched", () => {
    const queryClient = client();
    const ownKey = dashboardProjectsKey("principal", "admin", 0, { archived: "hide" });
    const ownSearchKey = dashboardProjectSearchKey("principal", "admin", 0, { archived: "hide" });
    const otherKey = dashboardProjectsKey("someone-else", "admin", 0, { archived: "hide" });
    const otherSearchKey = dashboardProjectSearchKey("someone-else", "admin", 0, { archived: "hide" });
    queryClient.setQueryData(ownKey, [project("a")]);
    queryClient.setQueryData(ownSearchKey, { query: "", matching: 1, total: 1 });
    queryClient.setQueryData(otherKey, [project("a")]);
    queryClient.setQueryData(otherSearchKey, { query: "", matching: 1, total: 1 });

    removeProjectFromDashboardQueries(queryClient, "principal", "a");

    expect(queryClient.getQueryData(otherKey)).toEqual([project("a")]);
    expect(queryClient.getQueryData(otherSearchKey)).toEqual({ query: "", matching: 1, total: 1 });
  });
});

// #230, item 3. The cache-key shape (prefix + sibling predicate) moved here from Dashboard.tsx so
// the screen no longer has to know what a dashboard-projects key looks like to scan or match one.
describe("dashboardProjectsKeyPrefix / isDashboardProjectsQueryFor (#230)", () => {
  it("dashboardProjectsKeyPrefix is the leading two elements every dashboardProjectsKey starts with", () => {
    expect(dashboardProjectsKeyPrefix("principal")).toEqual(["dashboard-projects", "principal"]);
    expect(dashboardProjectsKey("principal", "admin", 0, { archived: "hide" }, "smith").slice(0, 2)).toEqual(dashboardProjectsKeyPrefix("principal"));
  });

  it("isDashboardProjectsQueryFor matches every dashboard-projects entry for the principal, regardless of role/epoch/archived/q", () => {
    const queryClient = client();
    const keyA = dashboardProjectsKey("principal", "admin", 0, { archived: "hide" });
    const keyB = dashboardProjectsKey("principal", "photographer", 1, { archived: "only" }, "smith");
    queryClient.setQueryData(keyA, [project("a")]);
    queryClient.setQueryData(keyB, [project("b")]);

    const matches = isDashboardProjectsQueryFor("principal");
    const matched = queryClient.getQueryCache().getAll().filter(matches).map((query) => query.queryKey);
    expect(matched).toEqual(expect.arrayContaining([keyA, keyB]));
    expect(matched).toHaveLength(2);
  });

  it("isDashboardProjectsQueryFor never matches another principal's entries or the dashboard-project-search sibling", () => {
    const queryClient = client();
    const ownKey = dashboardProjectsKey("principal", "admin", 0, { archived: "hide" });
    const otherPrincipalKey = dashboardProjectsKey("someone-else", "admin", 0, { archived: "hide" });
    const searchSiblingKey = dashboardProjectSearchKey("principal", "admin", 0, { archived: "hide" });
    queryClient.setQueryData(ownKey, [project("a")]);
    queryClient.setQueryData(otherPrincipalKey, [project("a")]);
    queryClient.setQueryData(searchSiblingKey, { query: "", matching: 0, total: 0 });

    const matches = isDashboardProjectsQueryFor("principal");
    const matched = queryClient.getQueryCache().getAll().filter(matches).map((query) => query.queryKey);
    expect(matched).toEqual([ownKey]);
  });

  it("isDashboardProjectsQueryFor excludes the exact key passed as exceptKeyString, structurally not by reference", () => {
    const queryClient = client();
    const activeKey = dashboardProjectsKey("principal", "admin", 0, { archived: "hide" }, "smith");
    const siblingKey = dashboardProjectsKey("principal", "admin", 0, { archived: "hide" });
    queryClient.setQueryData(activeKey, [project("a")]);
    queryClient.setQueryData(siblingKey, [project("a")]);

    const matches = isDashboardProjectsQueryFor("principal", JSON.stringify(activeKey));
    const matched = queryClient.getQueryCache().getAll().filter(matches).map((query) => query.queryKey);
    expect(matched).toEqual([siblingKey]);
  });

  it("isDashboardProjectsQueryFor with no exceptKeyString matches every sibling, including one that would otherwise be excluded", () => {
    const queryClient = client();
    const keyA = dashboardProjectsKey("principal", "admin", 0, { archived: "hide" });
    queryClient.setQueryData(keyA, [project("a")]);

    const matches = isDashboardProjectsQueryFor("principal");
    expect(queryClient.getQueryCache().getAll().filter(matches).map((query) => query.queryKey)).toEqual([keyA]);
  });
});

describe("mapInternalProjects (#475)", () => {
  it("maps an envelope that carries no per-Stage order without throwing, reading only contractEnabled", () => {
    const rows = [project("a"), project("b")];
    expect(mapInternalProjects({ projects: rows, board: { contractEnabled: true } }).map((row) => row.id)).toEqual(["a", "b"]);
    expect(mapInternalProjects({ projects: rows, board: { contractEnabled: false } }).every((row) => row.boardContractEnabled === false)).toBe(true);
    // A missing envelope is an old deployed server: Board mutation stays available.
    expect(mapInternalProjects({ projects: rows }).every((row) => row.boardContractEnabled === true)).toBe(true);
  });

  it("ignores the deprecated map when a stale server still sends it", () => {
    const mapped = mapInternalProjects({ projects: [project("a")], board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a"] } } });
    expect(mapped[0]).not.toHaveProperty("authorizedBoardOrder");
    expect(mapped[0]).not.toHaveProperty("boardRank");
  });
});
