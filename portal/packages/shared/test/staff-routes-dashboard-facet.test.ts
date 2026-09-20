import { describe, expect, it } from "vitest";
import { PRODUCTION_CALENDAR_MAX_ENCODED_QUERY_BYTES, type DashboardCalendarState, type StaffRoute } from "../src/index";
import { parseStaffLocation, safeStaffDestination, staffPathFor } from "../src/staff-routes";

const projectId = "123e4567-e89b-42d3-a456-426614174000";
const editorId = "11111111-1111-4111-8111-111111111111";
const retiredProjectParameter = "detail";
const retiredViewParameter = ["detail", "View"].join("");

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

function calendarUrl(query: string): string {
  return `/?${query}`;
}

describe("Dashboard routing grammar", () => {
  it("round-trips the canonical Dashboard arms without a project facet", () => {
    const routes: Array<Exclude<StaffRoute, { kind: "not-found" } | { kind: "reserved" }>> = [
      { kind: "dashboard" },
      { kind: "dashboard", dashboardView: "list" },
      { kind: "dashboard", dashboardView: "kanban" },
      { kind: "dashboard", calendar: calendar() },
    ];

    for (const route of routes) {
      const location = staffPathFor(route);
      const parsed = parseStaffLocation(location);
      expect(parsed, location).toEqual(route);
      expect(staffPathFor(parsed as Exclude<StaffRoute, { kind: "not-found" } | { kind: "reserved" }>), location).toBe(location);
    }

    expect(staffPathFor({ kind: "dashboard", dashboardView: "list" })).toBe("/?view=list");
    expect(staffPathFor({ kind: "dashboard", dashboardView: "kanban" })).toBe("/?view=kanban");
  });

  it("preserves the complete Calendar state", () => {
    const route = { kind: "dashboard" as const, calendar: calendar({
      subview: "week",
      editorIds: [editorId],
      includeUnassigned: true,
      stageKeys: ["editing"],
      showCompletedChecklist: true,
      showDeliveredProjects: true,
      overdueOnly: true,
      myTasks: true,
      search: "smith street",
    }) };
    const location = staffPathFor(route);

    expect(parseStaffLocation(location)).toEqual(route);
    expect(safeStaffDestination(location)).toBe(location);
  });

  it("keeps the List/Kanban and Calendar allow-lists separate", () => {
    // `q` is deliberately NOT in this list (#217): it is a legal parameter on the bare Dashboard
    // and the List/Kanban facets, exercised by the round-trip test just below. Only date/sub/layers
    // -- Calendar-facet-only parameters -- stay rejected here.
    for (const view of ["list", "kanban"]) {
      for (const parameter of ["date=2026-08-30", "sub=week", "layers=project"]) {
        expect(parseStaffLocation(`/?view=${view}&${parameter}`), `${view} ${parameter}`).toEqual({ kind: "not-found" });
      }
    }

    const calendarBase = "view=calendar&date=2026-08-30&sub=month&layers=project";
    for (const location of [
      calendarUrl("view=calendar&detail=" + projectId),
      calendarUrl(`${calendarBase}&dashboardView=list`),
      calendarUrl(`${calendarBase}&${retiredViewParameter}=activity`),
      calendarUrl("view=calendar&sub=month&layers=project"),
      calendarUrl("view=calendar&date=2026-08-30&layers=project"),
      calendarUrl("view=calendar&date=2026-08-30&sub=month"),
      calendarUrl(`${retiredProjectParameter}=${projectId}`),
      calendarUrl(`view=list&${retiredViewParameter}=activity`),
    ]) {
      expect(parseStaffLocation(location), location).toEqual({ kind: "not-found" });
      expect(safeStaffDestination(location), location).toBeNull();
    }
  });

  it("makes `q` legal on the bare Dashboard and the List/Kanban facets (#217)", () => {
    for (const [location, route] of [
      ["/?view=list&q=search", { kind: "dashboard", dashboardView: "list", search: "search" }],
      ["/?view=kanban&q=search", { kind: "dashboard", dashboardView: "kanban", search: "search" }],
      ["/?q=search", { kind: "dashboard", search: "search" }],
    ] as const) {
      expect(parseStaffLocation(location), location).toEqual(route);
      expect(staffPathFor(route as Exclude<StaffRoute, { kind: "not-found" } | { kind: "reserved" }>), location).toBe(location);
      expect(safeStaffDestination(location), location).toBe(location);
    }
  });

  it("rejects malformed, duplicate, oversized, and retired query fields", () => {
    const malformed = [
      calendarUrl(`view=list&${retiredProjectParameter}=${projectId}%`),
      calendarUrl("view=calendar&date=2026-08-30&sub=week&layers=project&q=%"),
      calendarUrl(`view=list&${retiredViewParameter}=act%00ivity`),
      calendarUrl("view=calendar&date=2026-08-30&sub=week&layers=project&%71%00=search"),
      calendarUrl(`view=list&${retiredProjectParameter}=${projectId}&${retiredViewParameter}=activity`),
    ];
    for (const location of malformed) expect(parseStaffLocation(location), location).toEqual({ kind: "not-found" });

    for (const location of [
      calendarUrl("view=list&view=list"),
      calendarUrl("view=calendar&view=calendar&date=2026-08-30&sub=week&layers=project"),
      calendarUrl(`view=list&${retiredProjectParameter}=${projectId}&${retiredProjectParameter}=${projectId}`),
      calendarUrl("view=list&"),
      calendarUrl(`view=list&${retiredProjectParameter}=${projectId}&`),
      calendarUrl("view=list&&q=search"),
    ]) expect(parseStaffLocation(location), location).toEqual({ kind: "not-found" });

    const oversizedListQuery = `view=list&x=${"x".repeat(8_200)}`;
    const oversizedCalendarQuery = `view=calendar&date=2026-08-30&sub=week&layers=project&q=${"x".repeat(8_200)}`;
    expect(new TextEncoder().encode(oversizedListQuery).byteLength).toBeGreaterThan(PRODUCTION_CALENDAR_MAX_ENCODED_QUERY_BYTES);
    expect(new TextEncoder().encode(oversizedCalendarQuery).byteLength).toBeGreaterThan(PRODUCTION_CALENDAR_MAX_ENCODED_QUERY_BYTES);
    expect(parseStaffLocation(calendarUrl(oversizedListQuery))).toEqual({ kind: "not-found" });
    expect(parseStaffLocation(calendarUrl(oversizedCalendarQuery))).toEqual({ kind: "not-found" });
  });

  it("rejects non-canonical query encodings while accepting reordered canonical fields", () => {
    expect(parseStaffLocation(calendarUrl("layers=project%2Cchecklist&sub=week&date=2026-08-30&view=calendar"))).toMatchObject({ kind: "dashboard", calendar: { subview: "week" } });
    expect(parseStaffLocation(calendarUrl("view=%6Cist"))).toEqual({ kind: "not-found" });
    expect(parseStaffLocation(calendarUrl("view=calendar&date=2026%2D08%2D30&sub=month&layers=project"))).toEqual({ kind: "not-found" });
    expect(parseStaffLocation(calendarUrl("q=smith%20street&view=calendar&date=2026-08-30&sub=week&layers=project"))).toEqual({ kind: "not-found" });
  });

  it("keeps Dashboard parsing ahead of the Calendar fallback and accepts collaboration", () => {
    expect(parseStaffLocation("/?view=list")).toEqual({ kind: "dashboard", dashboardView: "list" });
    expect(parseStaffLocation("/?view=kanban")).toEqual({ kind: "dashboard", dashboardView: "kanban" });
    expect(parseStaffLocation("/?view=unknown")).toEqual({ kind: "not-found" });
    expect(parseStaffLocation("/admin?view=list")).toEqual({ kind: "not-found" });
    expect(parseStaffLocation(`/?${retiredProjectParameter}=${projectId}`)).toEqual({ kind: "not-found" });
    expect(parseStaffLocation(`/projects/${projectId}?collaboration=open`)).toEqual({ kind: "project", projectId, collaboration: "open" });
    expect(parseStaffLocation(`/projects/${projectId}?collaboration=closed`)).toEqual({ kind: "not-found" });
  });

  it("rejects the retired kanban2 view (#83)", () => {
    expect(parseStaffLocation("/?view=kanban2")).toEqual({ kind: "not-found" });
  });

  it("round-trips Calendar searches through the canonical re-encode boundary", () => {
    for (const search of ["smith + co", "50% done", "café façade", "a & b = c"]) {
      const route = { kind: "dashboard" as const, calendar: calendar({ search }) };
      const location = staffPathFor(route);
      expect(safeStaffDestination(location), location).toBe(location);
      expect(parseStaffLocation(location)).toMatchObject({ kind: "dashboard", calendar: { search } });
    }
    expect(parseStaffLocation("/?view=calendar&date=2026-08-30&sub=month&layers=project&q=a%20b")).toEqual({ kind: "not-found" });
  });
});
