/**
 * Dashboard search key/cache seam — #217. Node-environment tests: the query key shapes and the
 * `removeProjectFromDashboardQueries` purge, independent of any component or network call.
 */
import { describe, expect, it } from "vitest";
import { hashKey, QueryClient } from "@tanstack/react-query";
import { dashboardProjectSearchKey, dashboardProjectsKey, removeProjectFromDashboardQueries } from "./dashboard-projects";
import type { ProjectSummary } from "./kanban-interaction";

function client() { return new QueryClient({ defaultOptions: { queries: { retry: false } } }); }
function project(id: string): ProjectSummary {
  return { id, street: id, suburb: null, postcode: null, agencyName: null, agentName: null, stageKey: "raw_review", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: null, editors: [], boardRank: undefined, boardMapPresent: false, authorizedBoardOrder: undefined, boardContractEnabled: true, boardRevision: 0, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null } as unknown as ProjectSummary;
}

describe("dashboardProjectsKey / dashboardProjectSearchKey (#217)", () => {
  // #217 fix round 1, item 7: an empty `q` must hash IDENTICALLY to the pre-#217 key, not merely
  // look similar -- react-query's own key hashing is shape-sensitive, so `{ archived }` and
  // `{ archived, q: "" }` are different cache entries. This asserts deep equality against the
  // literal pre-#217 tuple shape (no `q` property at all when `q` is empty), not a same-shape
  // "byte-identical" claim that was actually asserting a changed shape.
  const PRE_217_KEY = ["dashboard-projects", "p", "admin", 0, { archived: false }] as const;

  it("an empty q produces the exact pre-#217 key literal -- no q property at all", () => {
    expect(dashboardProjectsKey("p", "admin", 0, false)).toEqual(PRE_217_KEY);
    expect(dashboardProjectsKey("p", "admin", 0, false)[4]).not.toHaveProperty("q");
  });

  it("an empty q hashes IDENTICALLY to the pre-#217 key under react-query's own hashKey, not merely structurally-equal", () => {
    expect(hashKey(dashboardProjectsKey("p", "admin", 0, false))).toBe(hashKey(PRE_217_KEY));
  });

  it("a non-empty q widens the trailing object instead of adding a sixth element", () => {
    expect(dashboardProjectsKey("p", "admin", 0, false, "smith")).toEqual(["dashboard-projects", "p", "admin", 0, { archived: false, q: "smith" }]);
    expect(dashboardProjectsKey("p", "admin", 0, false, "smith")).not.toEqual(PRE_217_KEY);
  });

  it("uses a distinct key[0] for the search-counts sibling, so prefix scans on \"dashboard-projects\" never match it", () => {
    const searchKey = dashboardProjectSearchKey("p", "admin", 0, false, "smith");
    expect(searchKey[0]).toBe("dashboard-project-search");
    expect(searchKey[0]).not.toBe(dashboardProjectsKey("p", "admin", 0, false, "smith")[0]);
  });
});

describe("removeProjectFromDashboardQueries (#217)", () => {
  it("filters the removed project out of the projects list and purges the sibling search-counts cache", () => {
    const queryClient = client();
    const listKey = dashboardProjectsKey("principal", "admin", 0, false);
    const searchKey = dashboardProjectSearchKey("principal", "admin", 0, false, "smith");
    queryClient.setQueryData(listKey, [project("a"), project("b")]);
    queryClient.setQueryData(searchKey, { query: "smith", matching: 1, total: 2 });

    removeProjectFromDashboardQueries(queryClient, "principal", "a");

    expect(queryClient.getQueryData<ProjectSummary[]>(listKey)?.map((p) => p.id)).toEqual(["b"]);
    expect(queryClient.getQueryData(searchKey)).toBeUndefined();
  });

  it("leaves another principal's caches untouched", () => {
    const queryClient = client();
    const ownKey = dashboardProjectsKey("principal", "admin", 0, false);
    const ownSearchKey = dashboardProjectSearchKey("principal", "admin", 0, false);
    const otherKey = dashboardProjectsKey("someone-else", "admin", 0, false);
    const otherSearchKey = dashboardProjectSearchKey("someone-else", "admin", 0, false);
    queryClient.setQueryData(ownKey, [project("a")]);
    queryClient.setQueryData(ownSearchKey, { query: "", matching: 1, total: 1 });
    queryClient.setQueryData(otherKey, [project("a")]);
    queryClient.setQueryData(otherSearchKey, { query: "", matching: 1, total: 1 });

    removeProjectFromDashboardQueries(queryClient, "principal", "a");

    expect(queryClient.getQueryData(otherKey)).toEqual([project("a")]);
    expect(queryClient.getQueryData(otherSearchKey)).toEqual({ query: "", matching: 1, total: 1 });
  });
});
