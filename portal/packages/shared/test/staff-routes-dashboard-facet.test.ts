import { describe, expect, it } from "vitest";
import { PRODUCTION_CALENDAR_MAX_ENCODED_QUERY_BYTES, type DashboardCalendarState, type DashboardRoute, type StaffRoute } from "../src/index";
import { parseStaffLocation, safeStaffDestination, staffPathFor } from "../src/staff-routes";

const projectId = "123e4567-e89b-42d3-a456-426614174000";
const editorId = "11111111-1111-4111-8111-111111111111";

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

function detail(view: "overview" | "activity" | "discussion") {
  return { projectId, view } as const;
}

function routeWithDetail(view: "overview" | "activity" | "discussion"): DashboardRoute {
  return { kind: "dashboard", dashboardView: "list", detail: detail(view) };
}

describe("TB6 Slice 1 Dashboard routing grammar", () => {
  it("parses every canonical Dashboard arm and keeps route/serializer fixed points", () => {
    const routes: Array<Exclude<StaffRoute, { kind: "not-found" } | { kind: "reserved" }>> = [
      { kind: "dashboard" },
      { kind: "dashboard", dashboardView: "list" },
      { kind: "dashboard", dashboardView: "kanban" },
      routeWithDetail("overview"),
      routeWithDetail("activity"),
      routeWithDetail("discussion"),
      { kind: "dashboard", dashboardView: "kanban", detail: detail("overview") },
      { kind: "dashboard", dashboardView: "kanban", detail: detail("activity") },
      { kind: "dashboard", dashboardView: "kanban", detail: detail("discussion") },
      { kind: "dashboard", calendar: calendar() },
      { kind: "dashboard", calendar: calendar(), detail: detail("overview") },
      { kind: "dashboard", calendar: calendar(), detail: detail("activity") },
      { kind: "dashboard", calendar: calendar(), detail: detail("discussion") },
    ];

    for (const route of routes) {
      const location = staffPathFor(route);
      const parsed = parseStaffLocation(location);
      expect(parsed, location).toEqual(route);
      expect(staffPathFor(parsed as Exclude<StaffRoute, { kind: "not-found" } | { kind: "reserved" }>), location).toBe(location);
    }

    expect(staffPathFor({ kind: "dashboard", dashboardView: "list" })).toBe("/?view=list");
    expect(staffPathFor({ kind: "dashboard", dashboardView: "list", detail: detail("overview") })).toBe(`/?view=list&detail=${projectId}`);
    expect(staffPathFor(routeWithDetail("activity"))).toBe(`/?view=list&detail=${projectId}&detailView=activity`);
    expect(staffPathFor(routeWithDetail("discussion"))).toBe(`/?view=list&detail=${projectId}&detailView=discussion`);
  });

  it("preserves the complete Calendar state while appending quick-detail facets", () => {
    const location = calendarUrl("view=calendar&date=2026-08-30&sub=week&layers=project%2Cchecklist&editors="
      + editorId
      + "&unassigned=1&stages=editing&completed=1&delivered=1&overdue=1&mine=1&q=smith+street&detail="
      + projectId
      + "&detailView=discussion");
    const route = {
      kind: "dashboard" as const,
      calendar: calendar({
        subview: "week",
        editorIds: [editorId],
        includeUnassigned: true,
        stageKeys: ["editing"],
        showCompletedChecklist: true,
        showDeliveredProjects: true,
        overdueOnly: true,
        myTasks: true,
        search: "smith street",
      }),
      detail: detail("discussion"),
    } satisfies DashboardRoute;

    expect(parseStaffLocation(location)).toEqual(route);
    expect(staffPathFor(route)).toBe(location);
    expect(safeStaffDestination(location)).toBe(location);
  });

  it("keeps the List/Kanban and Calendar allow-lists separate", () => {
    for (const view of ["list", "kanban"]) {
      for (const parameter of ["date=2026-08-30", "sub=week", "layers=project", "q=search"]) {
        expect(parseStaffLocation(`/?view=${view}&${parameter}`), `${view} ${parameter}`).toEqual({ kind: "not-found" });
      }
    }

    const calendarBase = "view=calendar&date=2026-08-30&sub=month&layers=project";
    for (const location of [
      calendarUrl("view=calendar&detail=" + projectId),
      calendarUrl("view=calendar&date=2026-08-30&sub=month&layers=project&dashboardView=list"),
      calendarUrl("view=calendar&date=2026-08-30&sub=month&layers=project&detailView=activity"),
      calendarUrl("view=calendar&sub=month&layers=project"),
      calendarUrl("view=calendar&date=2026-08-30&layers=project"),
      calendarUrl("view=calendar&date=2026-08-30&sub=month"),
      calendarUrl("detail=" + projectId),
      calendarUrl("view=list&detailView=activity"),
      calendarUrl("view=list&detail=" + projectId.toUpperCase()),
      calendarUrl("view=list&detail=" + projectId + "&detailView=overview"),
    ]) {
      expect(parseStaffLocation(location), location).toEqual({ kind: "not-found" });
      expect(safeStaffDestination(location), location).toBeNull();
    }

    expect(parseStaffLocation(calendarUrl(calendarBase + "&detail=" + projectId))).toMatchObject({ kind: "dashboard", detail: detail("overview") });
  });

  it("runs the bounded and lossless query preamble on every Dashboard arm", () => {
    const malformed = [
      calendarUrl("view=list&detail=" + projectId + "%"),
      calendarUrl("view=calendar&date=2026-08-30&sub=week&layers=project&q=%"),
      calendarUrl("view=list&detail=" + projectId + "&detailView=act%00ivity"),
      calendarUrl("view=calendar&date=2026-08-30&sub=week&layers=project&%71%00=search"),
    ];
    for (const location of malformed) expect(parseStaffLocation(location), location).toEqual({ kind: "not-found" });

    for (const location of [
      calendarUrl("view=list&view=list"),
      calendarUrl("view=calendar&view=calendar&date=2026-08-30&sub=week&layers=project"),
    ]) expect(parseStaffLocation(location), location).toEqual({ kind: "not-found" });

    const oversizedListQuery = `view=list&detail=${projectId}&x=${"x".repeat(8_200)}`;
    const oversizedCalendarQuery = `view=calendar&date=2026-08-30&sub=week&layers=project&q=${"x".repeat(8_200)}`;
    expect(new TextEncoder().encode(oversizedListQuery).byteLength).toBeGreaterThan(PRODUCTION_CALENDAR_MAX_ENCODED_QUERY_BYTES);
    expect(new TextEncoder().encode(oversizedCalendarQuery).byteLength).toBeGreaterThan(PRODUCTION_CALENDAR_MAX_ENCODED_QUERY_BYTES);
    expect(parseStaffLocation(calendarUrl(oversizedListQuery))).toEqual({ kind: "not-found" });
    expect(parseStaffLocation(calendarUrl(oversizedCalendarQuery))).toEqual({ kind: "not-found" });
  });

  it("rejects non-canonical query percent encodings while accepting reordered canonical fields", () => {
    expect(parseStaffLocation(calendarUrl("detail=" + projectId + "&view=list"))).toEqual({ kind: "dashboard", dashboardView: "list", detail: detail("overview") });
    expect(parseStaffLocation(calendarUrl("view=%6Cist"))).toEqual({ kind: "not-found" });
    expect(parseStaffLocation(calendarUrl("view=list&detail=" + projectId + "&detailView=%61ctivity"))).toEqual({ kind: "not-found" });
    expect(parseStaffLocation(calendarUrl("view=calendar&date=2026%2D08%2D30&sub=month&layers=project"))).toEqual({ kind: "not-found" });
    expect(parseStaffLocation(calendarUrl("q=smith%20street&view=calendar&date=2026-08-30&sub=week&layers=project"))).toEqual({ kind: "not-found" });
    expect(parseStaffLocation(calendarUrl("layers=project%2Cchecklist&sub=week&date=2026-08-30&view=calendar"))).toMatchObject({ kind: "dashboard", calendar: { subview: "week" } });
  });

  it("keeps Dashboard parsing ahead of the Calendar fallback and fails closed elsewhere", () => {
    expect(parseStaffLocation("/?view=list")).toEqual({ kind: "dashboard", dashboardView: "list" });
    expect(parseStaffLocation("/?view=kanban")).toEqual({ kind: "dashboard", dashboardView: "kanban" });
    expect(parseStaffLocation("/?view=unknown")).toEqual({ kind: "not-found" });
    expect(parseStaffLocation("/admin?view=list")).toEqual({ kind: "not-found" });
    expect(parseStaffLocation(`/projects/${projectId}?view=calendar&date=2026-08-30&sub=month&layers=project`)).toEqual({ kind: "not-found" });
    expect(parseStaffLocation(`/projects/${projectId}?collaboration=open`)).toEqual({ kind: "project", projectId, collaboration: "open" });
  });

  it("completes the detail/detailView rejection matrix on both arms", () => {
    const calBase = "view=calendar&date=2026-08-30&sub=month&layers=project";
    const rejected = [
      // explicit overview on the Calendar arm
      calendarUrl(`${calBase}&detail=${projectId}&detailView=overview`),
      // non-UUID / wrong-version / uppercase detail id — List, Kanban, and Calendar arms
      calendarUrl(`view=list&detail=not-a-uuid`),
      calendarUrl(`view=kanban&detail=123e4567-e89b-62d3-a456-426614174000`), // version nibble 6 — regex requires 1..5
      calendarUrl(`view=kanban&detail=123e4567-e89b-42d3-c456-426614174000`), // variant nibble c — regex requires 8/9/a/b
      calendarUrl(`view=kanban&detail=123e4567e89b42d3a456426614174000`), // no hyphens
      calendarUrl(`${calBase}&detail=${projectId.toUpperCase()}`),
      calendarUrl(`${calBase}&detail=not-a-uuid`),
      // duplicate detail / detailView
      calendarUrl(`view=list&detail=${projectId}&detail=${projectId}`),
      calendarUrl(`view=list&detail=${projectId}&detailView=activity&detailView=activity`),
      calendarUrl(`${calBase}&detail=${projectId}&detail=${projectId}`),
      // trailing '&' / empty query part on each arm
      calendarUrl(`view=list&`),
      calendarUrl(`view=list&detail=${projectId}&`),
      calendarUrl(`${calBase}&`),
      calendarUrl(`view=list&&detail=${projectId}`),
    ];
    for (const location of rejected) {
      expect(parseStaffLocation(location), location).toEqual({ kind: "not-found" });
      expect(safeStaffDestination(location), location).toBeNull();
    }
  });

  it("isolates the arm allow-lists on values that are individually valid in the other arm", () => {
    // date/sub/layers/q are legal Calendar values but must be UNKNOWN on the List/Kanban arm,
    // rejected purely by the allow-list (not by value validation).
    for (const view of ["list", "kanban"]) {
      for (const param of ["date=2026-08-30", "sub=month", "layers=project", "editors=" + editorId, "stages=editing", "unassigned=1", "completed=1", "delivered=1", "overdue=1", "mine=1", "q=anything"]) {
        expect(parseStaffLocation(`/?view=${view}&${param}`), `${view} ${param}`).toEqual({ kind: "not-found" });
      }
    }
    // detail/detailView are legal everywhere, but a *raw* List/Kanban-only param never leaks onto Calendar:
    expect(parseStaffLocation("/?view=calendar&date=2026-08-30&sub=month&layers=project&dashboardView=list")).toEqual({ kind: "not-found" });
  });

  it("round-trips a Calendar search containing +, %, and unicode through the canonical re-encode boundary", () => {
    for (const search of ["smith + co", "50% done", "café façade", "a & b = c"]) {
      const route = { kind: "dashboard" as const, calendar: calendar({ search }) };
      const location = staffPathFor(route);
      expect(safeStaffDestination(location), location).toBe(location);
      const parsed = parseStaffLocation(location);
      expect(parsed, location).toMatchObject({ kind: "dashboard", calendar: { search } });
      expect(staffPathFor(parsed as Exclude<StaffRoute, { kind: "not-found" } | { kind: "reserved" }>), location).toBe(location);
    }
    // the non-canonical %20 spelling of a space is rejected even though '+' is accepted
    expect(parseStaffLocation("/?view=calendar&date=2026-08-30&sub=month&layers=project&q=a%20b")).toEqual({ kind: "not-found" });
  });

  it("accepts every canonical quick-detail destination for OAuth-safe navigation", () => {
    const paths = [
      staffPathFor({ kind: "dashboard", dashboardView: "list" }),
      staffPathFor({ kind: "dashboard", dashboardView: "kanban", detail: detail("overview") }),
      staffPathFor({ kind: "dashboard", dashboardView: "list", detail: detail("activity") }),
      staffPathFor({ kind: "dashboard", dashboardView: "kanban", detail: detail("discussion") }),
      staffPathFor({ kind: "dashboard", calendar: calendar(), detail: detail("overview") }),
      staffPathFor({ kind: "dashboard", calendar: calendar(), detail: detail("activity") }),
      staffPathFor({ kind: "dashboard", calendar: calendar(), detail: detail("discussion") }),
    ];
    for (const path of paths) {
      expect(safeStaffDestination(path), path).toBe(path);
      expect(staffPathFor(parseStaffLocation(path) as Exclude<StaffRoute, { kind: "not-found" } | { kind: "reserved" }>)).toBe(path);
    }
  });
});
