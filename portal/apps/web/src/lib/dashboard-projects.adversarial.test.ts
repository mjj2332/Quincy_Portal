import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { dashboardProjectSearchKey, dashboardProjectsKey, removeProjectFromDashboardQueries } from "./dashboard-projects";

describe("dashboard search cache adversarial probes (#217)", () => {
  it("keeps the explicit empty-q key hash identical to the pre-search key", () => {
    const omitted = dashboardProjectsKey("principal", "admin", 4, false);
    const explicitEmpty = dashboardProjectsKey("principal", "admin", 4, false, "");
    expect(explicitEmpty).toEqual(omitted);
    expect(Object.prototype.hasOwnProperty.call(explicitEmpty[4], "q")).toBe(false);
  });

  it("makes every non-empty q a distinct projects key while keeping counts in a sibling namespace", () => {
    const a = dashboardProjectsKey("principal", "admin", 4, false, "smith");
    const b = dashboardProjectsKey("principal", "admin", 4, false, "jones");
    const counts = dashboardProjectSearchKey("principal", "admin", 4, false, "smith");
    expect(a).not.toEqual(b);
    expect(a[0]).toBe("dashboard-projects");
    expect(counts[0]).toBe("dashboard-project-search");
  });

  it("purges every q/counts variant for one principal without touching another principal", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ownList = dashboardProjectsKey("principal-a", "admin", 4, false, "smith");
    const ownEmptyList = dashboardProjectsKey("principal-a", "admin", 4, false);
    const ownCounts = dashboardProjectSearchKey("principal-a", "admin", 4, false, "smith");
    const otherCounts = dashboardProjectSearchKey("principal-b", "admin", 4, false, "smith");
    client.setQueryData(ownList, [{ id: "project-1" }, { id: "project-2" }]);
    client.setQueryData(ownEmptyList, [{ id: "project-1" }]);
    client.setQueryData(ownCounts, { query: "smith", matching: 1, total: 2 });
    client.setQueryData(otherCounts, { query: "smith", matching: 9, total: 9 });

    removeProjectFromDashboardQueries(client, "principal-a", "project-1");

    expect(client.getQueryData(ownList)).toEqual([{ id: "project-2" }]);
    expect(client.getQueryData(ownEmptyList)).toEqual([]);
    expect(client.getQueryData(ownCounts)).toBeUndefined();
    expect(client.getQueryData(otherCounts)).toEqual({ query: "smith", matching: 9, total: 9 });
  });
});
