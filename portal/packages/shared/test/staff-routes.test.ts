import { describe, expect, it } from "vitest";
import {
  DASHBOARD_SEARCH_MAX_CHARS,
  parseStaffLocation,
  parseStaffPathname,
  safeStaffDestination,
  staffPathFor,
  type DashboardCalendarState,
  type StaffRoute,
} from "../src/staff-routes";

const projectId = "123e4567-e89b-42d3-a456-426614174000";
const editorId = "11111111-1111-4111-8111-111111111111";
const secondEditorId = "22222222-2222-4222-8222-222222222222";

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

describe("shared staff route contract", () => {
  it("keeps every existing canonical staff route parsing and serializing", () => {
    const routes: Array<[string, StaffRoute]> = [
      ["/", { kind: "dashboard" }],
      ["/projects/new", { kind: "create-project" }],
      [`/projects/${projectId}`, { kind: "project", projectId }],
      [`/projects/${projectId}?collaboration=open`, { kind: "project", projectId, collaboration: "open" }],
      [`/projects/${projectId}/edit`, { kind: "edit-project", projectId }],
      ["/admin", { kind: "admin" }],
      ["/settings/notifications", { kind: "notifications" }],
      ["/settings/notifications/preferences", { kind: "notification-preferences" }],
    ];

    for (const [location, route] of routes) {
      expect(parseStaffLocation(location)).toEqual(route);
      expect(staffPathFor(route as Exclude<StaffRoute, { kind: "not-found" } | { kind: "reserved" }>)).toBe(location);
      expect(safeStaffDestination(location)).toBe(location);
    }
    expect(parseStaffPathname(`/projects/${projectId.toUpperCase()}`)).toEqual({ kind: "not-found" });
  });

  it("checks the 3-segment notification-preferences arm before the 2-segment notifications arm", () => {
    // Both share the same two leading segments ("settings", "notifications"); the longer, more
    // specific match must be checked first or it is unreachable.
    expect(parseStaffPathname("/settings/notifications")).toEqual({ kind: "notifications" });
    expect(parseStaffPathname("/settings/notifications/preferences")).toEqual({ kind: "notification-preferences" });
    expect(parseStaffPathname("/settings/notifications/preferences/extra")).toEqual({ kind: "not-found" });
    expect(parseStaffPathname("/settings/notifications/other")).toEqual({ kind: "not-found" });
    expect(parseStaffPathname("/settings/other")).toEqual({ kind: "not-found" });
  });

  it("keeps the one-shot collaboration query strict", () => {
    for (const location of [
      `/projects/${projectId}?collaboration=close`,
      `/projects/${projectId}?collaboration=open&x=1`,
      `/projects/${projectId}?collaboration=open&collaboration=open`,
      `/admin?tab=users`,
      `/projects/${projectId}?x=collaboration%3Dopen`,
      `/projects/${projectId}?collaboration=open#x`,
    ]) expect(parseStaffLocation(location)).toEqual({ kind: "not-found" });
  });

  it("round-trips a minimal Calendar query with all documented defaults", () => {
    const location = calendarUrl("view=calendar&date=2026-08-30&sub=month&layers=project%2Cchecklist");
    const route = { kind: "dashboard", calendar: calendar() } satisfies StaffRoute;
    expect(parseStaffLocation(location)).toEqual(route);
    expect(staffPathFor(route)).toBe(location);
    expect(safeStaffDestination(location)).toBe(location);
  });

  it("round-trips every Calendar filter and canonicalizes list order", () => {
    const route = {
      kind: "dashboard",
      calendar: calendar({
        subview: "agenda",
        layers: ["checklist", "project", "project"],
        editorIds: [secondEditorId, editorId, editorId],
        includeUnassigned: true,
        stageKeys: ["delivered", "editing", "awaiting_raw"],
        showCompletedChecklist: true,
        showDeliveredProjects: true,
        overdueOnly: true,
        search: "smith street ",
        myTasks: true,
      }),
    } satisfies StaffRoute;
    const canonical = staffPathFor(route);
    expect(canonical).toBe(`/?view=calendar&date=2026-08-30&sub=agenda&layers=project%2Cchecklist&editors=${editorId}%2C${secondEditorId}&unassigned=1&stages=awaiting_raw%2Cediting%2Cdelivered&completed=1&delivered=1&overdue=1&mine=1&q=smith+street+`);
    expect(parseStaffLocation(canonical)).toEqual({
      kind: "dashboard",
      calendar: calendar({
        subview: "agenda",
        editorIds: [editorId, secondEditorId],
        includeUnassigned: true,
        stageKeys: ["awaiting_raw", "editing", "delivered"],
        showCompletedChecklist: true,
        showDeliveredProjects: true,
        overdueOnly: true,
        search: "smith street ",
        myTasks: true,
      }),
    });
    expect(safeStaffDestination(canonical)).toBe(canonical);
  });

  it("parses query parameters in any order and serializes them in the fixed order", () => {
    const unordered = calendarUrl("q=smith+street&mine=1&layers=checklist%2Cproject&sub=week&date=2026-09-01&view=calendar&overdue=1");
    const route = parseStaffLocation(unordered);
    expect(route).toEqual({ kind: "dashboard", calendar: calendar({ date: "2026-09-01", subview: "week", layers: ["project", "checklist"], overdueOnly: true, search: "smith street", myTasks: true }) });
    expect(safeStaffDestination(unordered)).toBe(`/?view=calendar&date=2026-09-01&sub=week&layers=project%2Cchecklist&overdue=1&mine=1&q=smith+street`);
  });

  it("keeps mine explicit when true and omits it when false", () => {
    const withMine = calendarUrl("view=calendar&date=2026-08-30&sub=month&layers=project&mine=1");
    const withoutMine = calendarUrl("view=calendar&date=2026-08-30&sub=month&layers=project");
    expect(parseStaffLocation(withMine)).toMatchObject({ kind: "dashboard", calendar: { myTasks: true } });
    expect(staffPathFor({ kind: "dashboard", calendar: calendar({ layers: ["project"], myTasks: true }) })).toContain("&mine=1");
    expect(staffPathFor({ kind: "dashboard", calendar: calendar({ layers: ["project"] }) })).not.toContain("mine=");
    expect(parseStaffLocation(withoutMine)).toMatchObject({ kind: "dashboard", calendar: { myTasks: false } });
    const withSearch = staffPathFor({ kind: "dashboard", calendar: calendar({ layers: ["project"], search: "a b", myTasks: true }) });
    expect(withSearch.indexOf("mine=1")).toBeLessThan(withSearch.indexOf("q=a+b"));
  });

  it("strips parse-unsafe characters from a serialized search so the route round-trips", () => {
    // A DashboardCalendarState whose search was not client-sanitized (restored
    // state, direct construction) must not produce a path that fails its own
    // parse guard and collapses safeStaffDestination to "/".
    const dirty = "smith" + String.fromCharCode(92) + "street" + String.fromCharCode(7) + " road";
    const route = { kind: "dashboard" as const, calendar: calendar({ layers: ["project"], search: dirty }) };
    const path = staffPathFor(route);
    expect(path.includes(String.fromCharCode(92))).toBe(false);
    expect(path).toContain("q=smithstreet+road");
    expect(parseStaffLocation(path)).toEqual({ kind: "dashboard", calendar: calendar({ layers: ["project"], search: "smithstreet road" }) });
    expect(safeStaffDestination(path)).toBe(path);
  });

  it("accepts the role-independent presentation editing stage and rejects autoHDR", () => {
    const editing = calendarUrl("view=calendar&date=2026-08-30&sub=month&layers=project&stages=editing");
    expect(parseStaffLocation(editing)).toMatchObject({ kind: "dashboard", calendar: { stageKeys: ["editing"] } });
    expect(safeStaffDestination(editing)).toBe(editing);
    expect(parseStaffLocation(`${editing},editing_autohdr`)).toEqual({ kind: "not-found" });
    expect(parseStaffLocation(calendarUrl("view=calendar&date=2026-08-30&sub=month&layers=project&stages=editing_autohdr"))).toEqual({ kind: "not-found" });
  });

  it("rejects malformed, duplicate, unknown, and over-limit Calendar parameters", () => {
    const base = "view=calendar&date=2026-08-30&sub=month&layers=project";
    const manyEditors = Array.from({ length: 51 }, (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`).join(",");
    const sixStages = "awaiting_raw,raw_review,editing,edited_review,delivered,delivered";
    for (const location of [
      calendarUrl(`${base}&unknown=1`),
      calendarUrl(`${base}&date=2026-08-31`),
      calendarUrl(`${base}&unassigned=true`),
      calendarUrl(`${base}&editors=${projectId.toUpperCase()}`),
      calendarUrl(`${base}&stages=editing_autohdr`),
      calendarUrl(`${base}&layers=`),
      calendarUrl(`${base}&editors=${manyEditors}`),
      calendarUrl(`${base}&stages=${sixStages}`),
      calendarUrl(`${base}&q=${"x".repeat(8200)}`),
      calendarUrl("date=2026-08-30&sub=month&layers=project"),
      calendarUrl("view=calendar&date=2026-08-30&sub=month"),
      calendarUrl(`${base}&view=calendar`),
      calendarUrl(`${base}&q=%`),
      `${calendarUrl(base)}#hash`,
    ]) {
      expect(parseStaffLocation(location), location).toEqual({ kind: "not-found" });
      expect(safeStaffDestination(location), location).toBeNull();
    }
  });

  it("rejects unsafe text after URLSearchParams decoding in every value position", () => {
    const base = "view=calendar&date=2026-08-30&sub=month&layers=project";
    const unsafeValues = [
      "\\",
      "%5C",
      String.fromCharCode(0),
      "%00",
      String.fromCharCode(1),
      "%01",
      "\r",
      "\n",
      "%0D",
      "%0A",
      String.fromCharCode(0x7f),
      "%7F",
    ];
    for (const value of unsafeValues) {
      for (const location of [calendarUrl(`${base}&q=${value}`), calendarUrl(`view=calendar&date=2026-08-30&sub=${value}&layers=project`)]) {
        expect(parseStaffLocation(location), JSON.stringify({ value, location })).toEqual({ kind: "not-found" });
        expect(safeStaffDestination(location), JSON.stringify({ value, location })).toBeNull();
      }
    }
  });

  it("rejects unsafe decoded parameter names as well", () => {
    const location = calendarUrl("view=calendar&date=2026-08-30&sub=month&layers=project&%71%00=search");
    expect(parseStaffLocation(location)).toEqual({ kind: "not-found" });
    expect(safeStaffDestination(location)).toBeNull();
  });

  describe("the Dashboard `q` grammar (#217)", () => {
    it("round-trips a search value through the bare, List and Kanban facets", () => {
      const astral = "🎉".repeat(DASHBOARD_SEARCH_MAX_CHARS);
      expect([...astral].length).toBe(DASHBOARD_SEARCH_MAX_CHARS);
      const values = ["smith street", "a&b", "a+b", "a%b", "a=b", "café façade", astral];
      for (const search of values) {
        const routes: StaffRoute[] = [
          { kind: "dashboard", search },
          { kind: "dashboard", dashboardView: "list", search },
          { kind: "dashboard", dashboardView: "kanban", search },
        ];
        for (const route of routes) {
          const location = staffPathFor(route as Exclude<StaffRoute, { kind: "not-found" } | { kind: "reserved" }>);
          expect(parseStaffLocation(location), location).toEqual(route);
          expect(safeStaffDestination(location), location).toBe(location);
        }
      }
    });

    it("rejects an illegal `q` spelling", () => {
      const overLimit = "x".repeat(DASHBOARD_SEARCH_MAX_CHARS + 1);
      for (const location of [
        "/?q=",
        "/?q=a&q=b",
        `/?q=${overLimit}`,
        "/?q=%zz",
        "/?q=a%00b",
        "/?view=calendar&q=x",
        "/?search=x",
        "/?view=list&q=x&bogus=1",
      ]) {
        expect(parseStaffLocation(location), location).toEqual({ kind: "not-found" });
        expect(safeStaffDestination(location), location).toBeNull();
      }
    });

    it("strips parse-unsafe characters from a bare-dashboard search so the route round-trips", () => {
      const dirty = "smith" + String.fromCharCode(92) + "street";
      const route = { kind: "dashboard" as const, search: dirty };
      const path = staffPathFor(route);
      expect(path.includes(String.fromCharCode(92))).toBe(false);
      expect(parseStaffLocation(path)).toEqual({ kind: "dashboard", search: "smithstreet" });
      expect(safeStaffDestination(path)).toBe(path);
    });

    it("serializes the canonical view+q spelling with `+` for spaces", () => {
      expect(safeStaffDestination("/?view=kanban&q=hi+there")).toBe("/?view=kanban&q=hi+there");
    });
  });
});
