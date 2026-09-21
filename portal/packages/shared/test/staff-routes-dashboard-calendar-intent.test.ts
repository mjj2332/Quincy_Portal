import { describe, expect, it } from "vitest";
import { parseStaffLocation, safeStaffDestination, staffPathFor } from "../src/staff-routes";

/**
 * The bare `/?view=calendar` Calendar intent (#111).
 *
 * The navigation rail links Calendar to a URL carrying at most `view` and `q`, and lets the
 * Dashboard canonicalise it from the remembered subview and last date it already reads (plus,
 * since #217 fix round 4 item 1, the `q` this URL itself carries). The alternative — the rail
 * resolving the date/subview preferences itself — was rejected because it would put that
 * preference logic in two places; `q` is different, and now travels on the intent directly, since
 * a native navigation (keyboard Enter, cmd/middle-click, reload) loads this URL as a fresh
 * document with no in-memory search state left to fall back on.
 *
 * So this spelling is a deliberately transient *intent*, distinct from the parameterised facet URL
 * that `parseCalendarLocation` owns. It is legal when `view` is the sole query field, or when `q`
 * is the only other one: anything more is either the full facet (which must still parse as the
 * facet) or an incomplete facet (which must still be rejected, exactly as before).
 */
describe("the bare Calendar intent", () => {
  it("parses `/?view=calendar` as a view intent, not a calendar facet", () => {
    expect(parseStaffLocation("/?view=calendar")).toEqual({ kind: "dashboard", dashboardView: "calendar" });
  });

  it("round-trips: the intent route prints the bare URL, and that URL re-parses to it", () => {
    const path = staffPathFor({ kind: "dashboard", dashboardView: "calendar" });
    expect(path).toBe("/?view=calendar");
    expect(parseStaffLocation(path)).toEqual({ kind: "dashboard", dashboardView: "calendar" });
  });

  // #217 fix round 4, item 1 (Sol re-review, BLOCKER): the intent's own `q`, so a native
  // navigation (not just an SPA-intercepted click) never loses the search.
  it("round-trips with a `q` alongside `view` alone", () => {
    const path = staffPathFor({ kind: "dashboard", dashboardView: "calendar", search: "smith" });
    expect(path).toBe("/?view=calendar&q=smith");
    expect(parseStaffLocation(path)).toEqual({ kind: "dashboard", dashboardView: "calendar", search: "smith" });
  });

  it("is a safe sign-in destination", () => {
    expect(safeStaffDestination("/?view=calendar")).toBe("/?view=calendar");
    expect(safeStaffDestination("/?view=calendar&q=smith")).toBe("/?view=calendar&q=smith");
  });

  it("still parses the full facet URL as a calendar facet, not as the intent", () => {
    const route = parseStaffLocation("/?view=calendar&date=2026-08-30&sub=month&layers=project");
    expect(route.kind).toBe("dashboard");
    expect(route).toHaveProperty("calendar");
    expect(route).not.toHaveProperty("dashboardView");
  });

  // The intent widens the grammar by exactly two spellings (`view` alone, or `view` plus `q`).
  // Every partial facet stays rejected: accepting `view=calendar` plus *some* of its parameters
  // (other than `q`) would silently discard the rest.
  it.each([
    ["a subview with no date or layers", "/?view=calendar&sub=month"],
    ["a date and layers with no subview", "/?view=calendar&date=2026-08-30&layers=project"],
    ["a date alone", "/?view=calendar&date=2026-08-30"],
    ["an empty layer list", "/?view=calendar&date=2026-08-30&sub=month&layers="],
    ["a duplicated view key", "/?view=calendar&view=calendar"],
    ["a trailing separator", "/?view=calendar&"],
    ["non-canonical casing", "/?view=Calendar"],
    ["a percent-encoded spelling", "/?view=%63alendar"],
    ["the intent on a non-dashboard pathname", "/admin?view=calendar"],
    ["an unknown companion parameter", "/?view=calendar&archived=1"],
    ["q alongside an otherwise-partial facet", "/?view=calendar&q=smith&sub=month"],
    ["a duplicated q key", "/?view=calendar&q=a&q=b"],
    ["an empty q", "/?view=calendar&q="],
  ])("rejects %s", (_label, location) => {
    expect(parseStaffLocation(location)).toEqual({ kind: "not-found" });
  });

  it("leaves the List, Kanban and Gantt spellings alone", () => {
    expect(parseStaffLocation("/?view=list")).toEqual({ kind: "dashboard", dashboardView: "list" });
    expect(parseStaffLocation("/?view=kanban")).toEqual({ kind: "dashboard", dashboardView: "kanban" });
    expect(parseStaffLocation("/?view=gantt")).toEqual({ kind: "dashboard", dashboardView: "gantt" });
  });
});
