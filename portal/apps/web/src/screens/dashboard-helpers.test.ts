import { describe, expect, it, vi } from "vitest";
import { formatDashboardDate, initializeDashboardCalendarState, initializeDashboardView, initializeKanbanSortMode, isCanonicalCalendarDate, isCanonicalShootDate, normalizeDashboardCalendarSearch, normalizeDashboardCalendarSubview, normalizeDashboardView, normalizeKanbanSortMode, sanitizeDashboardCalendarSearch, DASHBOARD_CALENDAR_LAST_DATE_KEY, DASHBOARD_CALENDAR_SUBVIEW_KEY } from "./dashboard-helpers";

describe("dashboard view preferences", () => {
  it("keeps supported views and migrates grid, missing, and invalid values to kanban", () => {
    expect(normalizeDashboardView("list")).toBe("list");
    expect(normalizeDashboardView("kanban")).toBe("kanban");
    expect(normalizeDashboardView("calendar")).toBe("calendar");
    expect(normalizeDashboardView("grid")).toBe("kanban");
    expect(normalizeDashboardView(null)).toBe("kanban");
    expect(normalizeDashboardView("other")).toBe("kanban");
  });

  it("keeps a valid saved list preference when the migration write is rejected", () => {
    const write = vi.fn(() => { throw new Error("storage is read-only"); });
    expect(initializeDashboardView({ read: () => "list", write })).toBe("list");
    expect(write).toHaveBeenCalledWith("list");
  });

  // #83 retired `kanban2` as a route/storage value (see dashboard-helpers.ts's header comment). It
  // is the one value a real user's localStorage can actually hold from before the cutover — every
  // other invalid value in the test above is synthetic — so it must be pinned as degrading to
  // `kanban` explicitly, through both the read-time normalizer and the write-back migration path a
  // real stored preference goes through.
  it("migrates a stored kanban2 preference to kanban, and writes the migration back", () => {
    expect(normalizeDashboardView("kanban2")).toBe("kanban");
    const write = vi.fn();
    expect(initializeDashboardView({ read: () => "kanban2", write })).toBe("kanban");
    expect(write).toHaveBeenCalledWith("kanban");
  });
});

describe("Calendar initial state", () => {
  const route = { kind: "dashboard" as const };
  const calendarRoute = {
    kind: "dashboard" as const,
    calendar: {
      view: "calendar" as const,
      date: "2026-08-31",
      subview: "week" as const,
      layers: ["project" as const],
      editorIds: [],
      includeUnassigned: false,
      stageKeys: [],
      showCompletedChecklist: false,
      showDeliveredProjects: false,
      overdueOnly: false,
      search: "",
      myTasks: false,
    },
  };

  it("uses URL Calendar state before storage and does not read or write storage", () => {
    const read = vi.fn(() => "agenda");
    const write = vi.fn();
    expect(initializeDashboardCalendarState(calendarRoute, { read, write }, { now: "2026-08-30T12:00:00.000Z", isPhone: true })).toMatchObject({ view: "calendar", subview: "week", date: "2026-08-31", layers: ["project"], myTasks: false });
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("uses valid remembered values and otherwise chooses the device/date fallback", () => {
    const values = new Map([[DASHBOARD_CALENDAR_SUBVIEW_KEY, "agenda"], [DASHBOARD_CALENDAR_LAST_DATE_KEY, "2026-09-03"]]);
    const writes: Array<[string, string]> = [];
    const storage = { read: (key: string) => values.get(key) ?? null, write: (key: string, value: string) => writes.push([key, value]) };
    expect(initializeDashboardCalendarState(route, storage, { now: "2026-08-30T12:00:00.000Z", isPhone: false })).toMatchObject({ view: "calendar", subview: "agenda", date: "2026-09-03", layers: ["project", "checklist"], editorIds: [], search: "" });
    expect(writes).toEqual([[DASHBOARD_CALENDAR_SUBVIEW_KEY, "agenda"], [DASHBOARD_CALENDAR_LAST_DATE_KEY, "2026-09-03"]]);

    expect(initializeDashboardCalendarState(route, { read: () => null }, { now: "2026-08-30T12:00:00.000Z", isPhone: true })).toMatchObject({ subview: "agenda", date: "2026-08-30" });
    expect(initializeDashboardCalendarState(route, { read: () => null }, { now: "2026-08-30T12:00:00.000Z", isPhone: false })).toMatchObject({ subview: "month", date: "2026-08-30" });
  });

  it("tolerates storage read/write exceptions without losing valid fallback state", () => {
    const write = vi.fn(() => { throw new Error("read-only"); });
    expect(initializeDashboardCalendarState(route, { read: (key) => key === DASHBOARD_CALENDAR_SUBVIEW_KEY ? "week" : "2026-09-03", write }, { now: "2026-08-30T12:00:00.000Z", isPhone: false })).toMatchObject({ subview: "week", date: "2026-09-03" });
    expect(write).toHaveBeenCalledTimes(2);

    const read = vi.fn(() => { throw new Error("disabled"); });
    expect(initializeDashboardCalendarState(route, { read }, { now: "2026-08-30T12:00:00.000Z", isPhone: false })).toMatchObject({ subview: "month", date: "2026-08-30" });
  });

  it("normalizes only supported subviews and validates component dates", () => {
    expect(normalizeDashboardCalendarSubview("month")).toBe("month");
    expect(normalizeDashboardCalendarSubview("day")).toBeNull();
    expect(isCanonicalCalendarDate("2026-02-29")).toBe(false);
    expect(isCanonicalCalendarDate("2026-02-28")).toBe(true);
  });

  it("keeps live search spaces while stripping unsafe text and normalizes only the debounced value", () => {
    const input = `a b ${String.fromCharCode(1)} `;
    expect(sanitizeDashboardCalendarSearch(input)).toBe("a b  ");
    expect(normalizeDashboardCalendarSearch("a b  ")).toBe("a b");
  });
});

describe("Kanban sort preferences", () => {
  it("keeps supported sort modes and migrates missing and invalid values to board", () => {
    expect(normalizeKanbanSortMode("shootDate-asc")).toBe("shootDate-asc");
    expect(normalizeKanbanSortMode("shootDate-desc")).toBe("shootDate-desc");
    expect(normalizeKanbanSortMode(null)).toBe("board");
    expect(normalizeKanbanSortMode("other")).toBe("board");
  });

  it("keeps a valid saved sort preference when the migration write is rejected", () => {
    const write = vi.fn(() => { throw new Error("storage is read-only"); });
    expect(initializeKanbanSortMode({ read: () => "shootDate-desc", write })).toBe("shootDate-desc");
    expect(write).toHaveBeenCalledWith("shootDate-desc");
  });
});

describe("dashboard shoot dates", () => {
  it("recognizes only canonical calendar dates", () => {
    expect(isCanonicalShootDate("2026-01-02")).toBe(true);
    expect(isCanonicalShootDate(null)).toBe(false);
    expect(isCanonicalShootDate("tomorrow")).toBe(false);
    expect(isCanonicalShootDate("2025-02-29")).toBe(false);
  });

  it("formats canonical calendar dates without applying a browser timezone", () => {
    expect(formatDashboardDate("2026-01-02")).toBe("2 Jan 2026");
    expect(formatDashboardDate("2024-02-29")).toBe("29 Feb 2024");
  });

  it("keeps null pending and legacy invalid values visible", () => {
    expect(formatDashboardDate(null)).toBe("Shoot date pending");
    expect(formatDashboardDate("2025-02-29")).toBe("2025-02-29");
    expect(formatDashboardDate("20 January 2026")).toBe("20 January 2026");
  });
});
