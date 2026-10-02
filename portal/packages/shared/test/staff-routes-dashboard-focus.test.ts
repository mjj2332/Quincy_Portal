/**
 * #464 — `focus=<project uuid>` on the Timeline arm and the Calendar facet arm only. It is written
 * last (after `q`), never inside `DashboardCalendarState`, and every pre-#464 URL stays
 * byte-identical.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalLegacyDashboardLocation,
  dashboardFilterOf,
  dashboardFocusOf,
  parseStaffLocation,
  safeStaffDestination,
  staffPathFor,
  withDashboardFilter,
  withoutDashboardFocus,
  type StaffRoute,
} from "../src/index";

type Serializable = Exclude<StaffRoute, { kind: "not-found" } | { kind: "reserved" }>;
const ID = "7f3b9c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f";
const CAL = "view=calendar&date=2026-08-30&sub=month&layers=project";

describe("Dashboard focus parameter (#464)", () => {
  it("accepts focus on the Timeline arm and the Calendar facet arm, and reads it back", () => {
    for (const location of [`/?view=timeline&focus=${ID}`, `/?view=timeline&q=smith&focus=${ID}`, `/?${CAL}&focus=${ID}`, `/?${CAL}&q=smith&focus=${ID}`]) {
      const route = parseStaffLocation(location);
      expect(route.kind, location).toBe("dashboard");
      expect(dashboardFocusOf(route), location).toBe(ID);
    }
  });

  it("keeps focus beside, not inside, the Calendar state", () => {
    const route = parseStaffLocation(`/?${CAL}&focus=${ID}`);
    if (route.kind !== "dashboard" || !("calendar" in route)) throw new Error("expected a Calendar facet route");
    expect(route.calendar).not.toHaveProperty("focus");
    const stripped = withoutDashboardFocus(route);
    expect(dashboardFocusOf(stripped)).toBeUndefined();
    expect(staffPathFor(stripped as Serializable)).toBe(`/?${CAL}`);
    expect(staffPathFor({ kind: "dashboard", calendar: route.calendar })).toBe(`/?${CAL}`);
  });

  it("rejects focus everywhere else, and any value that is not a canonical lowercase UUID", () => {
    for (const location of [
      `/?view=table&focus=${ID}`,
      `/?view=board&focus=${ID}`,
      `/?focus=${ID}`,
      `/?q=smith&focus=${ID}`,
      `/?view=calendar&focus=${ID}`,
      `/?view=calendar&q=smith&focus=${ID}`,
      `/?view=timeline&focus=${ID.toUpperCase()}`,
      `/?view=timeline&focus=not-a-uuid`,
      `/?view=timeline&focus=`,
      `/?view=timeline&focus=${ID}&focus=${ID}`,
      `/?${CAL}&focus=${ID.toUpperCase()}`,
      `/?${CAL}&focus=`,
      `/projects/${ID}?focus=${ID}`,
    ]) {
      expect(parseStaffLocation(location).kind, location).toBe("not-found");
    }
  });

  it("writes focus last (after q) and round-trips as a fixed point", () => {
    for (const location of [
      `/?view=timeline&focus=${ID}`,
      `/?view=timeline&stages=raw_review&delivered=1&q=smith&focus=${ID}`,
      `/?${CAL}&focus=${ID}`,
      `/?${CAL}&delivered=1&q=smith&focus=${ID}`,
    ]) {
      const route = parseStaffLocation(location) as Serializable;
      expect(staffPathFor(route), location).toBe(location);
      expect(safeStaffDestination(location), location).toBe(location);
    }
  });

  it("leaves every pre-#464 URL byte-identical", () => {
    for (const location of ["/?view=timeline", "/?view=timeline&q=smith", `/?${CAL}`, `/?${CAL}&q=smith`, "/?view=table", "/"]) {
      expect(safeStaffDestination(location), location).toBe(location);
      expect(dashboardFocusOf(parseStaffLocation(location)), location).toBeUndefined();
    }
  });

  it("canonicalises a legacy gantt spelling and keeps focus", () => {
    expect(canonicalLegacyDashboardLocation(`/?view=gantt&focus=${ID}`)).toBe(`/?view=timeline&focus=${ID}`);
  });

  it("survives withDashboardFilter", () => {
    for (const location of [`/?view=timeline&focus=${ID}`, `/?${CAL}&focus=${ID}`]) {
      const route = parseStaffLocation(location);
      if (route.kind !== "dashboard") throw new Error("expected dashboard");
      const next = withDashboardFilter(route, { ...dashboardFilterOf(route), stageKeys: ["raw_review"] });
      expect(dashboardFocusOf(next), location).toBe(ID);
    }
  });

  it("dashboardFocusOf is undefined for a non-Dashboard route", () => {
    expect(dashboardFocusOf({ kind: "admin" })).toBeUndefined();
  });
});
