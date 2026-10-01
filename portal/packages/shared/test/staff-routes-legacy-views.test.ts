/**
 * #427 — the Dashboard `view` values were renamed list -> table, kanban -> board, gantt ->
 * timeline. The old spellings still PARSE (to the new route value, under the same grammar), so an
 * old bookmark or an old-bundle tab lands correctly, but the serializer only ever EMITS the new
 * spellings, and `canonicalLegacyDashboardLocation` is the one predicate that says "this location
 * is an old spelling; here is its canonical path".
 */
import { describe, expect, it } from "vitest";
import { canonicalLegacyDashboardLocation, parseStaffLocation, safeStaffDestination, staffPathFor, type StaffRoute } from "../src/index";

const editorId = "11111111-1111-4111-8111-111111111111";

describe("legacy Dashboard view spellings (#427)", () => {
  it.each([
    ["/?view=list", { kind: "dashboard", dashboardView: "table" }, "/?view=table"],
    ["/?view=kanban", { kind: "dashboard", dashboardView: "board" }, "/?view=board"],
    ["/?view=gantt", { kind: "dashboard", dashboardView: "timeline" }, "/?view=timeline"],
    ["/?view=list&q=smith", { kind: "dashboard", dashboardView: "table", search: "smith" }, "/?view=table&q=smith"],
    ["/?view=kanban&q=smith+street", { kind: "dashboard", dashboardView: "board", search: "smith street" }, "/?view=board&q=smith+street"],
  ] as const)("%s parses to the new route and serialises the new spelling", (location, route, canonical) => {
    expect(parseStaffLocation(location)).toEqual(route);
    expect(staffPathFor(route as Exclude<StaffRoute, { kind: "not-found" } | { kind: "reserved" }>)).toBe(canonical);
    expect(canonicalLegacyDashboardLocation(location)).toBe(canonical);
    expect(safeStaffDestination(location)).toBe(canonical);
  });

  it("carries the Timeline facets through a legacy gantt location", () => {
    const location = `/?view=gantt&editors=${editorId}&stages=raw_review&delivered=1&completed=1&q=smith`;
    const route = parseStaffLocation(location);
    expect(route).toMatchObject({ kind: "dashboard", dashboardView: "timeline", search: "smith", gantt: { stageKeys: ["raw_review"], priorities: [], archived: "hide", delivered: true, completed: true, editorIds: [editorId], includeUnassigned: false, shootRange: null, deadlineRange: null, overdueOnly: false, myTasks: false } });
    expect(canonicalLegacyDashboardLocation(location)).toBe(`/?view=timeline&editors=${editorId}&stages=raw_review&completed=1&delivered=1&q=smith`);
  });

  it("is null for new spellings, the bare route, Calendar and every non-Dashboard location", () => {
    for (const location of [
      "/", "/?q=smith", "/?view=table", "/?view=board&q=x", "/?view=timeline", "/?view=calendar",
      "/?view=calendar&date=2026-08-30&sub=month&layers=project%2Cchecklist",
      "/?layers=project%2Cchecklist&sub=week&date=2026-08-30&view=calendar",
      "/admin", "/notices", "/admin?view=list",
    ]) expect(canonicalLegacyDashboardLocation(location), location).toBeNull();
  });

  it("is null when the legacy location is not a valid Dashboard location at all", () => {
    for (const location of [
      "/?view=list&view=list", "/?view=list&bogus=1", "/?view=list&date=2026-09-19", "/?view=gantt&date=2026-09-19",
      "/?view=list&", "/?view=kanban2", "/?view=list&q=a%0Db", "/?view=list&q=",
    ]) expect(canonicalLegacyDashboardLocation(location), location).toBeNull();
  });

  it("keeps rejecting what the legacy grammar always rejected", () => {
    expect(parseStaffLocation("/?view=list&completed=1")).toEqual({ kind: "not-found" });
    expect(parseStaffLocation("/?view=kanban&delivered=1")).toEqual({ kind: "not-found" });
    expect(parseStaffLocation("/?view=gantt&stages=raw_review&stages=editing")).toEqual({ kind: "not-found" });
    expect(parseStaffLocation("/?view=gantt&delivered=0")).toEqual({ kind: "not-found" });
    expect(parseStaffLocation("/?view=kanban2")).toEqual({ kind: "not-found" });
  });
});

describe("legacy Dashboard scope spelling (#428)", () => {
  it("reads /?scope=archived as the Board with Archived = Only, and canonicalises it", () => {
    const location = "/?scope=archived";
    expect(parseStaffLocation(location)).toEqual({ kind: "dashboard", dashboardView: "board", filter: { stageKeys: [], priorities: [], archived: "only", editorIds: [], includeUnassigned: false, shootRange: null, deadlineRange: null, overdueOnly: false, myTasks: false } });
    expect(canonicalLegacyDashboardLocation(location)).toBe("/?view=board&archived=only");
    expect(safeStaffDestination(location)).toBe("/?view=board&archived=only");
  });

  it("carries q through scope=archived", () => {
    expect(canonicalLegacyDashboardLocation("/?scope=archived&q=smith")).toBe("/?view=board&archived=only&q=smith");
  });

  it("reads /?scope=active as the plain bare route, with no archived param", () => {
    expect(parseStaffLocation("/?scope=active")).toEqual({ kind: "dashboard" });
    expect(canonicalLegacyDashboardLocation("/?scope=active")).toBe("/");
    expect(canonicalLegacyDashboardLocation("/?scope=active&q=smith")).toBe("/?q=smith");
  });

  it("rejects an unknown scope, a scope beside a view, and a duplicate scope", () => {
    for (const location of ["/?scope=all", "/?scope=", "/?scope=archived&view=table", "/?view=board&scope=archived", "/?scope=archived&scope=active"]) {
      expect(parseStaffLocation(location), location).toEqual({ kind: "not-found" });
      expect(canonicalLegacyDashboardLocation(location), location).toBeNull();
    }
  });
});

