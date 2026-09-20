import { describe, expect, it } from "vitest";
import {
  DASHBOARD_SEARCH_MAX_CHARS,
  normalizeDashboardSearchText,
  parseStaffLocation,
  staffPathFor,
  type DashboardCalendarState,
  type StaffRoute,
} from "../src/staff-routes";

const editorId = "11111111-1111-4111-8111-111111111111";

function calendar(search = ""): DashboardCalendarState {
  return {
    view: "calendar",
    date: "2026-09-19",
    subview: "month",
    layers: ["project", "checklist"],
    editorIds: [editorId],
    includeUnassigned: false,
    stageKeys: [],
    showCompletedChecklist: false,
    showDeliveredProjects: false,
    overdueOnly: false,
    search,
    myTasks: false,
  };
}

type View = "bare" | "list" | "kanban" | "gantt" | "calendar-intent" | "calendar-facet";

function routeFor(view: View, search?: string): StaffRoute {
  if (view === "calendar-facet") return { kind: "dashboard", calendar: calendar(search ?? "") };
  if (view === "bare") return { kind: "dashboard", ...(search === undefined ? {} : { search }) };
  return { kind: "dashboard", dashboardView: view === "calendar-intent" ? "calendar" : view, ...(search === undefined ? {} : { search }) };
}

function canonicalRoute(route: StaffRoute): StaffRoute {
  if (route.kind !== "dashboard") return route;
  if ("calendar" in route) return { ...route, calendar: { ...route.calendar, search: normalizeDashboardSearchText(route.calendar.search) } };
  const search = route.search === undefined ? undefined : normalizeDashboardSearchText(route.search);
  const { search: _rawSearch, ...withoutSearch } = route;
  return search ? { ...withoutSearch, search } : withoutSearch;
}

function qPart(value: string): string {
  return new URLSearchParams([["q", value]]).toString();
}

describe("staff-route q grammar adversarial matrix (#217)", () => {
  it("round-trips every Dashboard view with raw, Unicode, encoded, unsafe, whitespace, and over-limit searches", () => {
    const values = [
      "smith street",
      "  smith   street  ",
      "a+b",
      "50% done",
      "RTL אבג",
      "café façade",
      "🎉".repeat(DASHBOARD_SEARCH_MAX_CHARS),
      "\u0000smith\\street\u0007",
      "x".repeat(DASHBOARD_SEARCH_MAX_CHARS + 1),
      "   ",
    ];

    for (const view of ["bare", "list", "kanban", "gantt", "calendar-intent", "calendar-facet"] as const) {
      for (const value of values) {
        const input = routeFor(view, value);
        const location = staffPathFor(input as Exclude<StaffRoute, { kind: "not-found" } | { kind: "reserved" }>);
        const parsed = parseStaffLocation(location);
        const expected = canonicalRoute(input);
        expect(parsed, `${view}: ${JSON.stringify(value)} -> ${location}`).toEqual(expected);
        expect(staffPathFor(parsed as Exclude<StaffRoute, { kind: "not-found" } | { kind: "reserved" }>)).toBe(location);
      }
    }
  });

  it("accepts canonical plus and percent encodings, but rejects their non-canonical spellings", () => {
    expect(parseStaffLocation("/?q=a+b")).toEqual({ kind: "dashboard", search: "a b" });
    expect(parseStaffLocation(`/?${qPart("a+b")}`)).toEqual({ kind: "dashboard", search: "a+b" });
    expect(parseStaffLocation(`/?${qPart("50% done")}`)).toEqual({ kind: "dashboard", search: "50% done" });
    expect(parseStaffLocation("/?q=a%20b")).toEqual({ kind: "not-found" });
    expect(parseStaffLocation("/?q=a%2bb")).toEqual({ kind: "not-found" });
    expect(parseStaffLocation("/?q=%")).toEqual({ kind: "not-found" });
  });

  it("rejects repeated q, controls, over-limit q, and illegal sibling fields on every view arm", () => {
    const calendarBase = "view=calendar&date=2026-09-19&sub=month&layers=project%2Cchecklist";
    const locations = [
      "/?q=a&q=b",
      "/?view=list&q=a&q=b",
      "/?view=kanban&q=a&date=2026-09-19",
      "/?view=calendar&q=a&date=2026-09-19",
      `/?${calendarBase}&q=a&unknown=1`,
      "/?q=%00a",
      "/?view=list&q=a%0Db",
      `/?q=${encodeURIComponent("x".repeat(DASHBOARD_SEARCH_MAX_CHARS + 1))}`,
      "/?view=list&q=a&view=list",
      "/?view=calendar&q=a&q=b",
    ];

    for (const location of locations) expect(parseStaffLocation(location), location).toEqual({ kind: "not-found" });
  });

  // #220: Gantt is a plain flat view exactly like List/Kanban — no facet params of its own. A
  // `view=gantt` carrying one of Calendar's own facet keys must never be silently reinterpreted as
  // (or folded into) a Calendar route; it is simply not a legal route at all.
  it("rejects `view=gantt` plus a calendar-only param rather than silently producing a calendar route", () => {
    for (const location of [
      "/?view=gantt&date=2026-09-19",
      "/?view=gantt&sub=month",
      "/?view=gantt&layers=project",
      "/?view=gantt&date=2026-09-19&sub=month&layers=project",
      "/?view=gantt&q=smith&date=2026-09-19",
    ]) {
      expect(parseStaffLocation(location), location).toEqual({ kind: "not-found" });
    }
  });

  it("normalizes whitespace-only q to the same route as an absent q", () => {
    for (const location of [
      "/?q=+++",
      "/?view=list&q=+++",
      "/?view=kanban&q=+++",
      "/?view=calendar&q=+++",
      "/?view=calendar&date=2026-09-19&sub=month&layers=project%2Cchecklist&q=+++",
    ]) {
      const parsed = parseStaffLocation(location);
      expect(parsed, location).toEqual(location.includes("date=")
        ? { kind: "dashboard", calendar: { ...calendar(), editorIds: [] } }
        : location.includes("view=list")
          ? { kind: "dashboard", dashboardView: "list" }
          : location.includes("view=kanban")
            ? { kind: "dashboard", dashboardView: "kanban" }
            : location.includes("view=calendar")
              ? { kind: "dashboard", dashboardView: "calendar" }
              : { kind: "dashboard" });
    }
  });
});
