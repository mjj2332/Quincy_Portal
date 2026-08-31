import { describe, expect, it } from "vitest";
import { PRODUCTION_CALENDAR_MAX_ENCODED_QUERY_BYTES, type DashboardCalendarState, type StaffRoute } from "../src/index";
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

describe("TB6 Slice 0 staff-route characterization", () => {
  it("keeps the root query closed except for Calendar and collaboration arrival", () => {
    for (const location of [
      "/?view=list",
      "/?view=kanban",
      `/?detail=${projectId}`,
      "/?q=search",
      "/?tab=projects",
    ]) {
      expect(parseStaffLocation(location), location).toEqual({ kind: "not-found" });
    }

    expect(parseStaffLocation(`/projects/${projectId}?collaboration=open`)).toEqual({ kind: "project", projectId, collaboration: "open" });
    for (const location of [
      `/projects/${projectId}?collaboration=closed`,
      `/projects/${projectId}?collaboration=open&extra=1`,
      `/projects/${projectId}?detail=1`,
    ]) {
      expect(parseStaffLocation(location), location).toEqual({ kind: "not-found" });
    }
  });

  it("keeps Calendar's private parameter allow-list, malformed-query guard, and 8192-byte bound", () => {
    const query = "view=calendar&date=2026-08-30&sub=week&layers=project%2Cchecklist&editors="
      + editorId
      + "&unassigned=1&stages=editing&completed=1&delivered=1&overdue=1&mine=1&q=smith+street";
    expect(parseStaffLocation(`/?${query}`)).toEqual({
      kind: "dashboard",
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
    });

    for (const location of [
      "/?view=calendar&date=2026-08-30&sub=week&layers=project&unknown=1",
      "/?view=calendar&view=calendar&date=2026-08-30&sub=week&layers=project",
      "/?view=calendar&date=2026-08-30&sub=week&layers=project&q=%E0%A4%A",
    ]) {
      expect(parseStaffLocation(location), location).toEqual({ kind: "not-found" });
    }

    const oversized = `view=calendar&date=2026-08-30&sub=week&layers=project&q=${"x".repeat(8_200)}`;
    expect(new TextEncoder().encode(oversized).byteLength).toBeGreaterThan(PRODUCTION_CALENDAR_MAX_ENCODED_QUERY_BYTES);
    expect(parseStaffLocation(`/?${oversized}`)).toEqual({ kind: "not-found" });
  });

  it("keeps staffPathFor and parseStaffLocation at fixed points for every current route kind", () => {
    const routes: Array<Exclude<StaffRoute, { kind: "not-found" } | { kind: "reserved" }>> = [
      { kind: "dashboard" },
      { kind: "dashboard", calendar: calendar({ layers: ["project"], stageKeys: ["editing"] }) },
      { kind: "create-project" },
      { kind: "project", projectId },
      { kind: "project", projectId, collaboration: "open" },
      { kind: "edit-project", projectId },
      { kind: "admin" },
      { kind: "notifications" },
    ];

    for (const route of routes) {
      const path = staffPathFor(route);
      expect(parseStaffLocation(path), path).toEqual(route);
      expect(staffPathFor(parseStaffLocation(path) as Exclude<StaffRoute, { kind: "not-found" } | { kind: "reserved" }>)).toBe(path);
    }
  });

  it("keeps the safe OAuth destination accept/reject set and Calendar canonicalization", () => {
    for (const value of ["/", "/projects/new", `/projects/${projectId}`, `/projects/${projectId}?collaboration=open`, `/projects/${projectId}/edit`, "/admin", "/settings/notifications"]) {
      expect(safeStaffDestination(value), value).toBe(value);
    }

    const unorderedCalendar = "/?q=smith+street&layers=project&sub=week&date=2026-08-30&view=calendar";
    expect(safeStaffDestination(unorderedCalendar)).toBe("/?view=calendar&date=2026-08-30&sub=week&layers=project&q=smith+street");

    for (const value of [
      "https://example.test/",
      "//example.test/",
      "/?view=list",
      `/?detail=${projectId}`,
      "/admin?tab=users",
      `/projects/${projectId}?collaboration=close`,
      "/projects/not-a-uuid",
      "/projects/new/",
      "/#hash",
    ]) {
      expect(safeStaffDestination(value), value).toBeNull();
    }
  });
});
