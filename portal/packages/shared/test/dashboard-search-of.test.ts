import { describe, expect, it } from "vitest";
import { dashboardSearchOf, type DashboardCalendarState, type StaffRoute } from "../src/staff-routes";

/**
 * #217 build, step 2. `dashboardSearchOf` is the ONE accessor every render-time consumer reads
 * instead of a copy of the URL's own committed search — see `dashboard-search-source.guard.test.ts`
 * (step 7) for the mechanised rule that `screens/Dashboard.tsx` must read through this, not the
 * store. Every route shape `StaffRoute`/`DashboardRoute` can take is covered here.
 */
function calendar(overrides: Partial<DashboardCalendarState> = {}): DashboardCalendarState {
  return {
    view: "calendar",
    date: "2026-08-30",
    subview: "month",
    layers: ["project", "checklist"],
    editorIds: [],
    includeUnassigned: false,
    stageKeys: [],
    showCompletedChecklist: false,
    showDeliveredProjects: false,
    overdueOnly: false,
    search: "",
    myTasks: false,
    ...overrides,
  };
}

describe("dashboardSearchOf", () => {
  it("bare dashboard route with no search field: undefined", () => {
    expect(dashboardSearchOf({ kind: "dashboard" })).toBeUndefined();
  });

  it("bare dashboard route carrying q: the value", () => {
    expect(dashboardSearchOf({ kind: "dashboard", search: "smith" })).toBe("smith");
  });

  it("List route with no q: undefined", () => {
    expect(dashboardSearchOf({ kind: "dashboard", dashboardView: "list" })).toBeUndefined();
  });

  it("List route carrying q: the value", () => {
    expect(dashboardSearchOf({ kind: "dashboard", dashboardView: "list", search: "smith" })).toBe("smith");
  });

  it("Kanban route carrying q: the value", () => {
    expect(dashboardSearchOf({ kind: "dashboard", dashboardView: "kanban", search: "smith" })).toBe("smith");
  });

  it("Kanban route with no q: undefined", () => {
    expect(dashboardSearchOf({ kind: "dashboard", dashboardView: "kanban" })).toBeUndefined();
  });

  it("the bare Calendar-intent route with no q: undefined", () => {
    expect(dashboardSearchOf({ kind: "dashboard", dashboardView: "calendar" })).toBeUndefined();
  });

  it("the bare Calendar-intent route carrying q: the value", () => {
    expect(dashboardSearchOf({ kind: "dashboard", dashboardView: "calendar", search: "smith" })).toBe("smith");
  });

  it("the canonical Calendar facet with an empty search: the real empty string, not undefined", () => {
    expect(dashboardSearchOf({ kind: "dashboard", calendar: calendar({ search: "" }) })).toBe("");
  });

  it("the canonical Calendar facet with a search: the value", () => {
    expect(dashboardSearchOf({ kind: "dashboard", calendar: calendar({ search: "smith" }) })).toBe("smith");
  });

  it("every non-Dashboard route shape: undefined", () => {
    const routes: StaffRoute[] = [
      { kind: "create-project" },
      { kind: "project", projectId: "123e4567-e89b-42d3-a456-426614174000" },
      { kind: "project", projectId: "123e4567-e89b-42d3-a456-426614174000", collaboration: "open" },
      { kind: "edit-project", projectId: "123e4567-e89b-42d3-a456-426614174000" },
      { kind: "admin" },
      { kind: "notifications" },
      { kind: "notification-preferences" },
      { kind: "not-found" },
      { kind: "reserved" },
    ];
    for (const route of routes) expect(dashboardSearchOf(route)).toBeUndefined();
  });
});
