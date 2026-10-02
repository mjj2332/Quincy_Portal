import { describe, expect, it, vi } from "vitest";
import { readRememberedDashboardView, writeDashboardViewPreference, formatDashboardDate, initializeDashboardCalendarState, initializeDashboardView, initializeKanbanSortMode, isCanonicalCalendarDate, isCanonicalShootDate, normalizeDashboardCalendarSearch, normalizeDashboardCalendarSubview, normalizeDashboardView, normalizeKanbanSortMode, sanitizeDashboardCalendarSearch, DASHBOARD_CALENDAR_LAST_DATE_KEY, DASHBOARD_CALENDAR_SUBVIEW_KEY } from "./dashboard-helpers";

describe("dashboard view preferences", () => {
  it("keeps supported views and migrates grid, missing, and invalid values to board", () => {
    expect(normalizeDashboardView("table")).toBe("table");
    expect(normalizeDashboardView("board")).toBe("board");
    expect(normalizeDashboardView("timeline")).toBe("timeline");
    expect(normalizeDashboardView("calendar")).toBe("calendar");
    expect(normalizeDashboardView("grid")).toBe("board");
    expect(normalizeDashboardView(null)).toBe("board");
    expect(normalizeDashboardView("other")).toBe("board");
  });

  // #427: the stored values were renamed. A real user's localStorage holds the OLD spellings, so
  // each reads as its new equivalent.
  it.each([["list", "table"], ["kanban", "board"], ["gantt", "timeline"]] as const)("reads a stored %s as %s, and writes the new spelling back", (stored, expected) => {
    expect(normalizeDashboardView(stored)).toBe(expected);
    const write = vi.fn();
    expect(initializeDashboardView({ read: () => stored, write })).toBe(expected);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(expected);
    expect(readRememberedDashboardView({ read: () => stored })).toBe(expected);
  });

  it("keeps a valid saved table preference when the migration write is rejected", () => {
    const write = vi.fn(() => { throw new Error("storage is read-only"); });
    expect(initializeDashboardView({ read: () => "table", write })).toBe("table");
    expect(write).toHaveBeenCalledWith("table");
    const legacyWrite = vi.fn(() => { throw new Error("storage is read-only"); });
    expect(initializeDashboardView({ read: () => "list", write: legacyWrite })).toBe("table");
  });

  it("writeDashboardViewPreference writes the view and swallows a rejected write", () => {
    const write = vi.fn();
    writeDashboardViewPreference({ write }, "timeline");
    expect(write).toHaveBeenCalledWith("timeline");
    expect(() => writeDashboardViewPreference({ write: () => { throw new Error("quota"); } }, "board")).not.toThrow();
  });

  // #83 retired `kanban2` as a route/storage value (see dashboard-helpers.ts's header comment). It
  // is the one value a real user's localStorage can actually hold from before the cutover — every
  // other invalid value in the test above is synthetic — so it must be pinned as degrading to
  // `board` explicitly, through both the read-time normalizer and the write-back migration path a
  // real stored preference goes through.
  it("migrates a stored kanban2 preference to board, and writes the migration back", () => {
    expect(normalizeDashboardView("kanban2")).toBe("board");
    const write = vi.fn();
    expect(initializeDashboardView({ read: () => "kanban2", write })).toBe("board");
    expect(write).toHaveBeenCalledWith("board");
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
      stageKeys: [], priorities: [], archived: "hide" as const,
      shootRange: null, deadlineRange: null,
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
    // #222: day and days joined the shared subview list (additive)
    expect(normalizeDashboardCalendarSubview("day")).toBe("day");
    expect(normalizeDashboardCalendarSubview("days")).toBe("days");
    expect(normalizeDashboardCalendarSubview("year")).toBeNull();
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
  it("maps every stored value, including the retired Board order, to the one fixed Board rule (#470)", () => {
    for (const stored of ["board", "priority", "shootDate-asc", "shootDate-desc", "other", "", null]) {
      expect(normalizeKanbanSortMode(stored)).toBe("priority-shoot-date");
    }
  });

  it("rewrites a retired stored sort as the fixed rule, and still answers when the write is rejected", () => {
    const write = vi.fn();
    expect(initializeKanbanSortMode({ read: () => "board", write })).toBe("priority-shoot-date");
    expect(write).toHaveBeenCalledWith("priority-shoot-date");
    const rejecting = vi.fn(() => { throw new Error("storage is read-only"); });
    expect(initializeKanbanSortMode({ read: () => "shootDate-desc", write: rejecting })).toBe("priority-shoot-date");
    expect(rejecting).toHaveBeenCalledWith("priority-shoot-date");
    expect(initializeKanbanSortMode({ read: () => { throw new Error("denied"); }, write })).toBe("priority-shoot-date");
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

describe("readRememberedDashboardView", () => {
  // #111 gave the remembered preference a second caller: the shell reads it to resolve the
  // navigation rail's active item. `initializeDashboardView` keeps its single caller and its single
  // one-time migration WRITE; this is the pure read. So a storage failure now degrades navigation,
  // not just the Dashboard, and these are the cases that reach it.
  it("returns a canonical stored value unchanged", () => {
    expect(readRememberedDashboardView({ read: () => "table" })).toBe("table");
    expect(readRememberedDashboardView({ read: () => "calendar" })).toBe("calendar");
  });

  it("degrades a corrupt stored value to Board", () => {
    expect(readRememberedDashboardView({ read: () => "not-a-dashboard-view" })).toBe("board");
  });

  it("degrades an absent value to Board", () => {
    expect(readRememberedDashboardView({ read: () => null })).toBe("board");
  });

  it("keeps navigation alive when the storage accessor throws", () => {
    // Private browsing, blocked site data, a quota error. The rail must still render.
    expect(readRememberedDashboardView({ read: () => { throw new Error("storage disabled"); } })).toBe("board");
  });

  it("does not write", () => {
    // The whole reason the read was split out of `initializeDashboardView`, which migrates a legacy
    // "grid" value and writes it back. A second caller must not repeat that write.
    const read = vi.fn(() => "list");  // a retired spelling: the read still never writes
    readRememberedDashboardView({ read });
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("Calendar day/days subviews are kept as-is (#224)", () => {
  const route = { kind: "dashboard" as const };
  const now = "2026-08-30T12:00:00.000Z";

  it("uses a remembered day/days subview as-is and writes it back unchanged", () => {
    for (const remembered of ["day", "days"]) {
      const values = new Map([[DASHBOARD_CALENDAR_SUBVIEW_KEY, remembered], [DASHBOARD_CALENDAR_LAST_DATE_KEY, "2026-09-03"]]);
      const writes: Array<[string, string]> = [];
      const storage = { read: (key: string) => values.get(key) ?? null, write: (key: string, value: string) => writes.push([key, value]) };
      expect(initializeDashboardCalendarState(route, storage, { now, isPhone: false })).toMatchObject({ subview: remembered, date: "2026-09-03" });
      expect(writes).toContainEqual([DASHBOARD_CALENDAR_SUBVIEW_KEY, remembered]);
      expect(writes).not.toContainEqual([DASHBOARD_CALENDAR_SUBVIEW_KEY, "week"]);
    }
  });

  it("returns a route calendar with a day/days subview unchanged, without touching storage", () => {
    for (const subview of ["day", "days"] as const) {
      const read = vi.fn(() => null);
      const write = vi.fn();
      const calendar = {
        view: "calendar" as const, date: "2026-08-31", subview, layers: ["project" as const], editorIds: [],
        includeUnassigned: false, stageKeys: [], priorities: [], archived: "hide" as const, shootRange: null, deadlineRange: null, showCompletedChecklist: false, showDeliveredProjects: false,
        overdueOnly: false, search: "", myTasks: false,
      };
      expect(initializeDashboardCalendarState({ kind: "dashboard", calendar }, { read, write }, { now, isPhone: false })).toEqual(calendar);
      expect(read).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    }
  });
});
