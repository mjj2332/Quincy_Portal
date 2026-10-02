import { describe, expect, it } from "vitest";
import { dashboardFocusOf, parseStaffLocation, type DashboardCalendarState } from "@quincy/shared";
import { buildShowInCalendar, buildShowInTimeline, NOTHING_SCHEDULED_REASON, ARCHIVED_ADMIN_ONLY_REASON, type ShowInArgs } from "./project-show-in";

const ID = "7f3b9c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f";
const TASK_A = "1a3b9c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f";
const TASK_B = "2a3b9c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f";

const calendarBase: DashboardCalendarState = {
  view: "calendar", date: "2026-10-02", subview: "week", layers: ["project", "checklist"], editorIds: [], includeUnassigned: false,
  stageKeys: [], priorities: [], archived: "hide", shootRange: null, deadlineRange: null, showCompletedChecklist: false, showDeliveredProjects: false,
  overdueOnly: false, search: "", myTasks: false,
};

function args(overrides: Partial<ShowInArgs> = {}): ShowInArgs {
  return {
    project: { id: ID, stageKey: "editing", archivedAt: null, shootDate: null, deadlineLocalCivil: null },
    tasks: [],
    backdrop: "/",
    isAdmin: false,
    calendarBase,
    ...overrides,
  };
}

const href = (destination: ReturnType<typeof buildShowInTimeline>) => {
  if (!destination.available) throw new Error(`unavailable: ${destination.reason}`);
  return destination.href;
};

describe("buildShowInTimeline (#464)", () => {
  it("from the bare Dashboard, a plain Timeline URL carrying focus", () => {
    expect(href(buildShowInTimeline(args()))).toBe(`/?view=timeline&focus=${ID}`);
  });

  it("carries the backdrop's shared filter and q, written before focus", () => {
    const backdrop = "/?view=table&stages=editing&priority=3&q=smith";
    const to = href(buildShowInTimeline(args({ backdrop })));
    const route = parseStaffLocation(to);
    expect(route).toMatchObject({ dashboardView: "timeline", search: "smith", focus: ID, gantt: { stageKeys: ["editing"] } });
    expect(to.endsWith(`q=smith&focus=${ID}`)).toBe(true);
  });

  it("from a Timeline backdrop keeps its delivered/completed; from any other it uses the defaults", () => {
    expect(href(buildShowInTimeline(args({ backdrop: "/?view=timeline&delivered=1&completed=1" })))).toBe(`/?view=timeline&completed=1&delivered=1&focus=${ID}`);
    expect(href(buildShowInTimeline(args({ backdrop: "/?view=board" })))).toBe(`/?view=timeline&focus=${ID}`);
  });

  it("from a Calendar backdrop takes its filter and q but not its subview", () => {
    const backdrop = "/?view=calendar&date=2026-10-02&sub=week&layers=project%2Cchecklist&stages=editing&q=smith";
    const to = href(buildShowInTimeline(args({ backdrop })));
    expect(parseStaffLocation(to)).toMatchObject({ dashboardView: "timeline", search: "smith", gantt: { stageKeys: ["editing"] } });
  });

  it("broadens delivered for a Delivered Project", () => {
    const to = href(buildShowInTimeline(args({ project: { ...args().project, stageKey: "delivered" } })));
    expect(parseStaffLocation(to)).toMatchObject({ gantt: { delivered: true } });
  });

  it("broadens archived to include for an Admin, and is disabled with a reason for anyone else", () => {
    const archived = { ...args().project, archivedAt: "2026-09-01T00:00:00Z" };
    expect(parseStaffLocation(href(buildShowInTimeline(args({ project: archived, isAdmin: true }))))).toMatchObject({ gantt: { archived: "include" } });
    expect(buildShowInTimeline(args({ project: archived }))).toEqual({ available: false, reason: ARCHIVED_ADMIN_ONLY_REASON });
  });

  it("an Admin whose backdrop already shows archived Only keeps it", () => {
    const archived = { ...args().project, archivedAt: 1 };
    const to = href(buildShowInTimeline(args({ project: archived, isAdmin: true, backdrop: "/?view=timeline&archived=only" })));
    expect(parseStaffLocation(to)).toMatchObject({ gantt: { archived: "only" } });
  });
});

describe("buildShowInCalendar (#464)", () => {
  const stateOf = (to: string) => {
    const route = parseStaffLocation(to);
    if (route.kind !== "dashboard" || !("calendar" in route)) throw new Error(`not a Calendar facet: ${to}`);
    return route;
  };

  it("nothing scheduled: disabled with the reason", () => {
    expect(buildShowInCalendar(args())).toEqual({ available: false, reason: NOTHING_SCHEDULED_REASON });
  });

  it("an invalid shoot date counts as nothing", () => {
    expect(buildShowInCalendar(args({ project: { ...args().project, shootDate: "not-a-date" } }))).toEqual({ available: false, reason: NOTHING_SCHEDULED_REASON });
  });

  it("lands on the Deadline's Sydney date first, with the remembered subview and layers", () => {
    const to = href(buildShowInCalendar(args({
      project: { ...args().project, deadlineLocalCivil: "2026-10-09T17:00", shootDate: "2026-10-01" },
      tasks: [{ id: TASK_A, position: 0, done: false, startCivil: "2026-10-03T09:00" }],
    })));
    const route = stateOf(to);
    expect(route.calendar).toMatchObject({ date: "2026-10-09", subview: "week" });
    expect(route.focus).toBe(ID);
    expect(to.endsWith(`&focus=${ID}`)).toBe(true);
  });

  it("without a Deadline, the earliest scheduled task (tie: start, position, id)", () => {
    const tasks = [
      { id: TASK_B, position: 1, done: false, startCivil: "2026-10-03T09:00" },
      { id: TASK_A, position: 1, done: false, startCivil: "2026-10-03T09:00" },
      { id: "3a3b9c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f", position: 0, done: false, startCivil: "2026-10-05T09:00" },
    ];
    expect(stateOf(href(buildShowInCalendar(args({ tasks })))).calendar.date).toBe("2026-10-03");
  });

  it("prefers an open task over an earlier done one, and falls back to the done one", () => {
    const tasks = [
      { id: TASK_A, position: 0, done: true, startCivil: "2026-10-01T09:00" },
      { id: TASK_B, position: 1, done: false, startCivil: "2026-10-05T09:00" },
    ];
    const open = stateOf(href(buildShowInCalendar(args({ tasks }))));
    expect(open.calendar).toMatchObject({ date: "2026-10-05", showCompletedChecklist: false });
    const done = stateOf(href(buildShowInCalendar(args({ tasks: [tasks[0]!] }))));
    expect(done.calendar).toMatchObject({ date: "2026-10-01", showCompletedChecklist: true });
  });

  it("then the shoot date, and says so", () => {
    const destination = buildShowInCalendar(args({ project: { ...args().project, shootDate: "2026-10-12" } }));
    if (!destination.available) throw new Error("expected available");
    expect(stateOf(destination.href).calendar.date).toBe("2026-10-12");
    expect(destination.note).toBe("shoot-date");
  });

  it("turns on the target's layer", () => {
    const only = { ...calendarBase, layers: ["checklist" as const] };
    expect(stateOf(href(buildShowInCalendar(args({ calendarBase: only, project: { ...args().project, deadlineLocalCivil: "2026-10-09T17:00" } })))).calendar.layers).toEqual(["project", "checklist"]);
    const projectOnly = { ...calendarBase, layers: ["project" as const] };
    expect(stateOf(href(buildShowInCalendar(args({ calendarBase: projectOnly, tasks: [{ id: TASK_A, position: 0, done: false, startCivil: "2026-10-03T09:00" }] })))).calendar.layers).toEqual(["project", "checklist"]);
  });

  it("broadens delivered, completed (for a done target task) and archived (Admin)", () => {
    const delivered = { ...args().project, stageKey: "delivered", deadlineLocalCivil: "2026-10-09T17:00" };
    expect(stateOf(href(buildShowInCalendar(args({ project: delivered })))).calendar.showDeliveredProjects).toBe(true);
    const done = [{ id: TASK_A, position: 0, done: true, startCivil: "2026-10-03T09:00" }];
    expect(stateOf(href(buildShowInCalendar(args({ tasks: done })))).calendar.showCompletedChecklist).toBe(true);
    const open = [{ id: TASK_A, position: 0, done: false, startCivil: "2026-10-03T09:00" }];
    expect(stateOf(href(buildShowInCalendar(args({ tasks: open })))).calendar.showCompletedChecklist).toBe(false);
    const archived = { ...args().project, archivedAt: 5, deadlineLocalCivil: "2026-10-09T17:00" };
    expect(stateOf(href(buildShowInCalendar(args({ project: archived, isAdmin: true })))).calendar.archived).toBe("include");
    expect(buildShowInCalendar(args({ project: archived }))).toEqual({ available: false, reason: ARCHIVED_ADMIN_ONLY_REASON });
  });

  it("from a Calendar backdrop keeps its subview, layers, filter and q", () => {
    const backdrop = "/?view=calendar&date=2026-11-02&sub=month&layers=project&stages=editing&q=smith";
    const to = href(buildShowInCalendar(args({ backdrop, project: { ...args().project, deadlineLocalCivil: "2026-10-09T17:00" } })));
    expect(stateOf(to).calendar).toMatchObject({ date: "2026-10-09", subview: "month", layers: ["project"], stageKeys: ["editing"], search: "smith" });
  });

  it("from a Table backdrop takes only the filter and q", () => {
    const backdrop = "/?view=table&stages=editing&q=smith";
    const to = href(buildShowInCalendar(args({ backdrop, project: { ...args().project, deadlineLocalCivil: "2026-10-09T17:00" } })));
    expect(stateOf(to).calendar).toMatchObject({ subview: "week", stageKeys: ["editing"], search: "smith" });
    expect(dashboardFocusOf(parseStaffLocation(to))).toBe(ID);
  });
});
