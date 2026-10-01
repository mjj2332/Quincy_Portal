import { describe, expect, it } from "vitest";
import {
  dashboardFilterOf,
  dashboardRouteCarriesFilter,
  parseStaffLocation,
  safeStaffDestination,
  staffPathFor,
  withDashboardFilter,
  type DashboardCalendarState,
  type DashboardFilter,
  type StaffRoute,
} from "../src/index";

/**
 * #428 — the shared Dashboard Filter in the URL: `stages` (unchanged spelling), `priority` and
 * `archived`, carried by the table/board, Timeline and Calendar facet arms and read/written through
 * exactly two helpers, `dashboardFilterOf` and `withDashboardFilter`.
 */

type SerializableRoute = Exclude<StaffRoute, { kind: "not-found" } | { kind: "reserved" }>;

const editorId = "11111111-1111-4111-8111-111111111111";

function calendar(overrides: Partial<DashboardCalendarState> = {}): DashboardCalendarState {
  return {
    view: "calendar", date: "2026-08-30", subview: "month", layers: ["project", "checklist"], editorIds: [], includeUnassigned: false,
    stageKeys: [], priorities: [], archived: "hide", shootRange: null, deadlineRange: null, showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false,
    ...overrides,
  };
}

const filter = (overrides: Partial<DashboardFilter> = {}): DashboardFilter => ({ stageKeys: [], priorities: [], archived: "hide", editorIds: [], includeUnassigned: false, shootRange: null, deadlineRange: null, overdueOnly: false, myTasks: false, ...overrides });

describe("shared Filter URL grammar (#428)", () => {
  it("keeps every pre-#428 Calendar and Timeline URL byte-identical (serialise -> parse -> serialise)", () => {
    const literals = [
      "/?view=timeline",
      "/?view=timeline&stages=raw_review",
      "/?view=timeline&stages=raw_review&completed=1&delivered=1&q=smith",
      "/?view=timeline&editors=11111111-1111-4111-8111-111111111111&stages=awaiting_raw%2Cediting&delivered=1",
      "/?view=calendar&date=2026-08-30&sub=month&layers=project%2Cchecklist",
      "/?view=calendar&date=2026-08-30&sub=week&layers=project&stages=editing%2Cdelivered&completed=1&overdue=1&mine=1&q=smith",
      "/?view=calendar&date=2026-08-30&sub=agenda&layers=checklist&editors=11111111-1111-4111-8111-111111111111&unassigned=1&stages=raw_review&delivered=1",
      "/?view=table&q=smith",
      "/?view=board",
      "/?q=smith",
      "/",
    ];
    for (const location of literals) {
      const route = parseStaffLocation(location);
      expect(route.kind, location).toBe("dashboard");
      expect(staffPathFor(route as SerializableRoute), location).toBe(location);
      expect(safeStaffDestination(location), location).toBe(location);
    }
  });

  it("writes the filter right after the arm's leading params and before the flags and q", () => {
    const route = withDashboardFilter({ kind: "dashboard", dashboardView: "timeline", search: "smith", gantt: { stageKeys: [], priorities: [], archived: "hide", delivered: true, completed: true, editorIds: [editorId], includeUnassigned: false, shootRange: null, deadlineRange: null, overdueOnly: false, myTasks: false } }, filter({ stageKeys: ["editing", "raw_review"], priorities: ["1", "5", "none"], archived: "include", editorIds: [editorId] }));
    expect(staffPathFor(route)).toBe(`/?view=timeline&editors=${editorId}&stages=raw_review%2Cediting&priority=5%2C1%2Cnone&archived=include&completed=1&delivered=1&q=smith`);
    expect(staffPathFor(withDashboardFilter({ kind: "dashboard", dashboardView: "board", search: "smith" }, filter({ stageKeys: ["editing"], priorities: ["4"], archived: "only" })))).toBe("/?view=board&stages=editing&priority=4&archived=only&q=smith");
    expect(staffPathFor({ kind: "dashboard", calendar: calendar({ stageKeys: ["editing"], priorities: ["none"], archived: "only", showDeliveredProjects: true, search: "x" }) }))
      .toBe("/?view=calendar&date=2026-08-30&sub=month&layers=project%2Cchecklist&stages=editing&priority=none&archived=only&delivered=1&q=x");
  });

  it("round-trips the filter through every arm that carries it, and the serialised form is a fixed point", () => {
    const filters: DashboardFilter[] = [
      filter(),
      filter({ stageKeys: ["editing"] }),
      filter({ priorities: ["5", "none"] }),
      filter({ archived: "include" }),
      filter({ archived: "only" }),
      filter({ stageKeys: ["awaiting_raw", "edited_review", "delivered"], priorities: ["5", "4", "3", "2", "1", "none"], archived: "only" }),
    ];
    const arms: SerializableRoute[] = [
      { kind: "dashboard", dashboardView: "table" },
      { kind: "dashboard", dashboardView: "board", search: "a b" },
      { kind: "dashboard", dashboardView: "timeline" },
      { kind: "dashboard", dashboardView: "timeline", search: "smith", gantt: { stageKeys: [], priorities: [], archived: "hide", delivered: true, completed: false, editorIds: [editorId], includeUnassigned: false, shootRange: null, deadlineRange: null, overdueOnly: false, myTasks: false } },
      { kind: "dashboard", calendar: calendar({ search: "smith", overdueOnly: true }) },
    ];
    for (const arm of arms) {
      for (const next of filters) {
        const route = withDashboardFilter(arm as Extract<StaffRoute, { kind: "dashboard" }>, next) as SerializableRoute;
        const location = staffPathFor(route);
        const parsed = parseStaffLocation(location);
        expect(parsed, location).toEqual(route);
        expect(dashboardFilterOf(parsed), location).toEqual(next);
        expect(staffPathFor(parsed as SerializableRoute), location).toBe(location);
        expect(safeStaffDestination(location), location).toBe(location);
      }
    }
  });

  it("canonicalises order and drops the carrier for a default filter", () => {
    expect(parseStaffLocation("/?view=table&priority=none%2C5%2C3&stages=delivered%2Cawaiting_raw")).toEqual({
      kind: "dashboard", dashboardView: "table", filter: filter({ stageKeys: ["awaiting_raw", "delivered"], priorities: ["5", "3", "none"] }),
    });
    expect(withDashboardFilter({ kind: "dashboard", dashboardView: "table", filter: filter({ archived: "only" }) }, filter())).toEqual({ kind: "dashboard", dashboardView: "table" });
    expect(withDashboardFilter({ kind: "dashboard", dashboardView: "timeline", gantt: { stageKeys: ["editing"], priorities: [], archived: "hide", delivered: false, completed: false, editorIds: [], includeUnassigned: false, shootRange: null, deadlineRange: null, overdueOnly: false, myTasks: false } }, filter())).toEqual({ kind: "dashboard", dashboardView: "timeline" });
    // A Timeline whose other facets are non-default keeps its facet when the filter empties.
    expect(withDashboardFilter({ kind: "dashboard", dashboardView: "timeline", gantt: { stageKeys: ["editing"], priorities: [], archived: "hide", delivered: true, completed: false, editorIds: [], includeUnassigned: false, shootRange: null, deadlineRange: null, overdueOnly: false, myTasks: false } }, filter()))
      .toEqual({ kind: "dashboard", dashboardView: "timeline", gantt: { stageKeys: [], priorities: [], archived: "hide", delivered: true, completed: false, editorIds: [], includeUnassigned: false, shootRange: null, deadlineRange: null, overdueOnly: false, myTasks: false } });
  });

  it("rejects the spellings the serializer never emits and every malformed list", () => {
    for (const location of [
      "/?view=table&archived=hide", "/?view=table&archived=1", "/?view=table&archived=", "/?view=table&archived=include&archived=only",
      "/?view=table&priority=", "/?view=table&priority=6", "/?view=table&priority=0", "/?view=table&priority=5%2C5", "/?view=table&priority=5%2C", "/?view=table&priority=NONE", "/?view=table&priority=5&priority=4",
      "/?view=table&stages=", "/?view=table&stages=nope", "/?view=table&stages=editing_autohdr", "/?view=table&stages=editing%2Cediting",
      "/?view=timeline&archived=hide", "/?view=timeline&priority=7",
      "/?view=calendar&date=2026-08-30&sub=month&layers=project&archived=hide",
      "/?view=calendar&date=2026-08-30&sub=month&layers=project&priority=%2C",
      // The bare Dashboard and the Calendar intent carry no filter.
      "/?priority=5", "/?archived=only", "/?stages=editing", "/?view=calendar&archived=only", "/?view=calendar&priority=5&q=a",
    ]) {
      expect(parseStaffLocation(location), location).toEqual({ kind: "not-found" });
      expect(safeStaffDestination(location), location).toBeNull();
    }
  });

  it("accepts the legacy view spellings with the filter and canonicalises them to the new ones", () => {
    expect(parseStaffLocation("/?view=list&archived=only")).toEqual({ kind: "dashboard", dashboardView: "table", filter: filter({ archived: "only" }) });
    expect(parseStaffLocation("/?view=kanban&priority=5&stages=editing")).toEqual({ kind: "dashboard", dashboardView: "board", filter: filter({ stageKeys: ["editing"], priorities: ["5"] }) });
    expect(parseStaffLocation("/?view=gantt&priority=none")).toEqual({
      kind: "dashboard", dashboardView: "timeline", gantt: { stageKeys: [], priorities: ["none"], archived: "hide", delivered: false, completed: false, editorIds: [], includeUnassigned: false, shootRange: null, deadlineRange: null, overdueOnly: false, myTasks: false },
    });
    expect(safeStaffDestination("/?view=list&archived=include")).toBe("/?view=table&archived=include");
  });

  it("dashboardFilterOf reads the default off every arm that carries nothing", () => {
    expect(dashboardFilterOf({ kind: "dashboard" })).toEqual(filter());
    expect(dashboardFilterOf({ kind: "dashboard", dashboardView: "calendar" })).toEqual(filter());
    expect(dashboardFilterOf({ kind: "admin" })).toEqual(filter());
    expect(dashboardFilterOf({ kind: "not-found" })).toEqual(filter());
    expect(dashboardFilterOf(parseStaffLocation("/?view=board"))).toEqual(filter());
  });

  it("returns fresh copies: mutating a result never reaches the route", () => {
    const route = parseStaffLocation("/?view=table&stages=editing");
    dashboardFilterOf(route).stageKeys.push("delivered");
    expect(dashboardFilterOf(route).stageKeys).toEqual(["editing"]);
  });

  it("withDashboardFilter leaves a bare route and the Calendar intent unchanged: they have nowhere to carry one", () => {
    const next = filter({ archived: "only" });
    expect(withDashboardFilter({ kind: "dashboard" }, next)).toEqual({ kind: "dashboard" });
    expect(withDashboardFilter({ kind: "dashboard", dashboardView: "calendar", search: "a" }, next)).toEqual({ kind: "dashboard", dashboardView: "calendar", search: "a" });
    expect(dashboardRouteCarriesFilter({ kind: "dashboard" })).toBe(false);
    expect(dashboardRouteCarriesFilter({ kind: "dashboard", dashboardView: "calendar" })).toBe(false);
    for (const location of ["/?view=table", "/?view=board", "/?view=timeline", "/?view=calendar&date=2026-08-30&sub=month&layers=project"]) {
      expect(dashboardRouteCarriesFilter(parseStaffLocation(location)), location).toBe(true);
    }
    expect(dashboardRouteCarriesFilter({ kind: "admin" })).toBe(false);
  });

  it("withDashboardFilter keeps every other field of the arm (#429: People, Overdue and My tasks are the filter's now)", () => {
    const base = calendar({ subview: "week", editorIds: [editorId], includeUnassigned: true, overdueOnly: true, myTasks: true, search: "smith", showCompletedChecklist: true });
    const next = withDashboardFilter({ kind: "dashboard", calendar: base }, filter({ archived: "include", priorities: ["2"], editorIds: [editorId], includeUnassigned: true, overdueOnly: true, myTasks: true }));
    expect(next).toEqual({ kind: "dashboard", calendar: { ...base, archived: "include", priorities: ["2"] } });
    // The filter owns those fields: a filter without them clears them, and nothing else moves.
    expect(withDashboardFilter({ kind: "dashboard", calendar: base }, filter({ archived: "include" }))).toEqual({
      kind: "dashboard", calendar: { ...base, archived: "include", editorIds: [], includeUnassigned: false, overdueOnly: false, myTasks: false },
    });
  });

  it("a filtered URL over the encoded-size cap is rejected like any other", () => {
    expect(parseStaffLocation(`/?view=table&q=${"a".repeat(9000)}`)).toEqual({ kind: "not-found" });
  });

  describe("People, Shoot date, Deadline, Overdue and My tasks (#429)", () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const everything = filter({
      editorIds: [editorId, other], includeUnassigned: true, stageKeys: ["editing"], priorities: ["5"], archived: "include",
      shootRange: { from: "2026-08-01", to: "2026-08-31" }, deadlineRange: { from: "2026-09-01", to: "2026-09-30" }, myTasks: true,
    });
    const withOverdue = filter({ editorIds: [editorId], includeUnassigned: true, shootRange: { from: "2026-08-01", to: "2026-08-01" }, overdueOnly: true, myTasks: true });
    const arms: SerializableRoute[] = [
      { kind: "dashboard", dashboardView: "table" },
      { kind: "dashboard", dashboardView: "board", search: "a b" },
      { kind: "dashboard", dashboardView: "timeline", search: "smith" },
      { kind: "dashboard", dashboardView: "timeline", gantt: { ...filter(), delivered: true, completed: true } },
      { kind: "dashboard", calendar: calendar({ search: "smith", showDeliveredProjects: true }) },
    ];

    it("round-trips every arm with every new parameter set, and the serialised form is a fixed point", () => {
      for (const arm of arms) {
        for (const next of [everything, withOverdue, filter({ includeUnassigned: true }), filter({ myTasks: true }), filter({ overdueOnly: true }), filter({ editorIds: [editorId] })]) {
          const route = withDashboardFilter(arm as Extract<StaffRoute, { kind: "dashboard" }>, next) as SerializableRoute;
          const location = staffPathFor(route);
          const parsed = parseStaffLocation(location);
          expect(parsed, location).toEqual(route);
          expect(dashboardFilterOf(parsed), location).toEqual(next);
          expect(staffPathFor(parsed as SerializableRoute), location).toBe(location);
          expect(safeStaffDestination(location), location).toBe(location);
        }
      }
    });

    it("writes the new parameters in the Calendar's order on every arm", () => {
      expect(staffPathFor(withDashboardFilter({ kind: "dashboard", calendar: calendar({ showCompletedChecklist: true, showDeliveredProjects: true, search: "x" }) }, everything)))
        .toBe(`/?view=calendar&date=2026-08-30&sub=month&layers=project%2Cchecklist&editors=${editorId}%2C${other}&unassigned=1&stages=editing&priority=5&archived=include&shoot=2026-08-01..2026-08-31&deadline=2026-09-01..2026-09-30&completed=1&delivered=1&mine=1&q=x`);
      expect(staffPathFor(withDashboardFilter({ kind: "dashboard", calendar: calendar() }, withOverdue)))
        .toBe(`/?view=calendar&date=2026-08-30&sub=month&layers=project%2Cchecklist&editors=${editorId}&unassigned=1&shoot=2026-08-01..2026-08-01&overdue=1&mine=1`);
      expect(staffPathFor(withDashboardFilter({ kind: "dashboard", dashboardView: "timeline", gantt: { ...filter(), delivered: true, completed: true }, search: "x" }, everything)))
        .toBe(`/?view=timeline&editors=${editorId}%2C${other}&unassigned=1&stages=editing&priority=5&archived=include&shoot=2026-08-01..2026-08-31&deadline=2026-09-01..2026-09-30&completed=1&delivered=1&mine=1&q=x`);
      expect(staffPathFor(withDashboardFilter({ kind: "dashboard", dashboardView: "board", search: "x" }, withOverdue)))
        .toBe(`/?view=board&editors=${editorId}&unassigned=1&shoot=2026-08-01..2026-08-01&overdue=1&mine=1&q=x`);
    });

    it("keeps every earlier Calendar and Timeline URL byte-identical when the new facets are absent", () => {
      for (const location of [
        `/?view=timeline&editors=${editorId}&stages=editing&completed=1&delivered=1&q=smith`,
        `/?view=calendar&date=2026-08-30&sub=week&layers=project&editors=${editorId}&unassigned=1&stages=editing&delivered=1&overdue=1&mine=1&q=x`,
        "/?view=calendar&date=2026-08-30&sub=month&layers=checklist&mine=1",
      ]) expect(staffPathFor(parseStaffLocation(location) as SerializableRoute), location).toBe(location);
    });

    it("rejects a Deadline range beside Overdue, a reversed or half-spelled range, and a flag that is not 1", () => {
      for (const view of ["view=table", "view=board", "view=timeline", "view=calendar&date=2026-08-30&sub=month&layers=project"]) {
        for (const extra of [
          "deadline=2026-09-01..2026-09-02&overdue=1", "shoot=2026-09-02..2026-09-01", "deadline=2026-09-02..2026-09-01", "shoot=2026-09-01", "shoot=..2026-09-01", "deadline=2026-09-01..",
          "shoot=2026-02-30..2026-03-01", "shoot=2026-09-01..2026-09-02..2026-09-03", "shoot=", "overdue=0", "mine=0", "unassigned=0", "mine=1&mine=1", "shoot=2026-09-01..2026-09-02&shoot=2026-09-01..2026-09-02",
        ]) {
          const location = `/?${view}&${extra}`;
          expect(parseStaffLocation(location), location).toEqual({ kind: "not-found" });
          expect(safeStaffDestination(location), location).toBeNull();
        }
      }
    });

    it("never writes a Deadline range and Overdue together", () => {
      const route = withDashboardFilter({ kind: "dashboard", dashboardView: "table" }, filter({ overdueOnly: true, deadlineRange: { from: "2026-09-01", to: "2026-09-02" } }));
      expect(staffPathFor(route as SerializableRoute)).toBe("/?view=table&deadline=2026-09-01..2026-09-02");
      expect(dashboardFilterOf(route).overdueOnly).toBe(false);
    });

    it("keeps the new parameters off the bare Dashboard and the Calendar intent", () => {
      for (const location of ["/?editors=" + editorId, "/?mine=1", "/?shoot=2026-08-01..2026-08-02", "/?view=calendar&mine=1", "/?view=calendar&overdue=1&q=a"]) {
        expect(parseStaffLocation(location), location).toEqual({ kind: "not-found" });
      }
    });
  });
});
