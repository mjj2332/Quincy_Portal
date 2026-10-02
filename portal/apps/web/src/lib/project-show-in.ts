/**
 * #464 — the destinations of the Project sheet's "Show in Calendar / Timeline" control.
 *
 * Pure builders: a Project, its scheduled Subtasks and the Dashboard location the sheet floats over
 * go in; a canonical Dashboard URL carrying `focus=<project id>` (or a reason it is unavailable)
 * comes out. The shared Filter and `q` come from the backdrop; the Calendar's subview and layers
 * come from the backdrop when it is a Calendar and from the remembered settings (`calendarBase`)
 * otherwise. Filters are broadened only where the Project's own data makes it certain it would be
 * hidden (Delivered, Archived for an Admin, a completed target task); anything else a filter hides
 * is the Dashboard's "isn't shown with the current filters" notice to explain.
 */
import {
  dashboardFilterOf,
  dashboardSearchOf,
  isDefaultGanttFacet,
  isSydneyCalendarDate,
  parseStaffLocation,
  staffPathFor,
  type DashboardCalendarState,
  type DashboardFilter,
  type DashboardGanttFacet,
  type StaffRoute,
} from "@quincy/shared";

export const NOTHING_SCHEDULED_REASON = "Nothing scheduled";
export const ARCHIVED_ADMIN_ONLY_REASON = "Archived Projects are shown to Admins only";

export type ShowInProject = {
  id: string;
  stageKey: string;
  archivedAt: string | number | null | undefined;
  shootDate: string | null;
  /** The Deadline's Sydney civil minute (`YYYY-MM-DDTHH:mm`), when one is set. */
  deadlineLocalCivil: string | null;
};

/** A Subtask with a schedule: `startCivil` is the range start's Sydney civil minute. */
export type ShowInTask = { id: string; position: number; done: boolean; startCivil: string };

export type ShowInArgs = {
  project: ShowInProject;
  tasks: readonly ShowInTask[];
  /** The Dashboard location the sheet floats over. */
  backdrop: string;
  isAdmin: boolean;
  /** The Calendar state to start from when the backdrop is not a Calendar (remembered subview, default layers). */
  calendarBase: DashboardCalendarState;
};

export type ShowInDestination =
  | { available: true; href: string; /** `"shoot-date"`: no Deadline or scheduled task, so the date is the shoot date and there is no chip. */ note?: "shoot-date"; /** The Calendar's target, for the caller's announcement. */ target?: "deadline" | "task" | "shoot-date" }
  | { available: false; reason: string };

function backdropRoute(backdrop: string): StaffRoute {
  return parseStaffLocation(backdrop);
}

function isArchived(project: ShowInProject): boolean {
  return project.archivedAt !== null && project.archivedAt !== undefined && project.archivedAt !== "";
}

function broadenedFilter(backdrop: StaffRoute, project: ShowInProject): DashboardFilter {
  const filter = dashboardFilterOf(backdrop);
  // Archived Include/Only is Admin-only; the caller has already refused a non-Admin.
  if (isArchived(project) && filter.archived === "hide") return { ...filter, archived: "include" };
  return filter;
}

function earliestTask(tasks: readonly ShowInTask[]): ShowInTask | null {
  // Open tasks first: a done task only becomes the target when nothing open is scheduled (and then
  // the Calendar's Completed toggle is broadened so its chip is drawn).
  const scheduled = tasks.filter((task) => task.startCivil.length >= 10);
  const open = scheduled.filter((task) => !task.done);
  const pool = open.length > 0 ? open : scheduled;
  pool.sort((a, b) => (a.startCivil < b.startCivil ? -1 : a.startCivil > b.startCivil ? 1 : a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  return pool[0] ?? null;
}

export function buildShowInTimeline({ project, backdrop, isAdmin }: ShowInArgs): ShowInDestination {
  if (isArchived(project) && !isAdmin) return { available: false, reason: ARCHIVED_ADMIN_ONLY_REASON };
  const route = backdropRoute(backdrop);
  const filter = broadenedFilter(route, project);
  const onTimeline = route.kind === "dashboard" && "dashboardView" in route && route.dashboardView === "timeline";
  const keep = onTimeline && route.kind === "dashboard" && "gantt" in route && route.gantt ? route.gantt : null;
  const gantt: DashboardGanttFacet = { ...filter, delivered: (keep?.delivered ?? false) || project.stageKey === "delivered", completed: keep?.completed ?? false };
  const search = dashboardSearchOf(route);
  const next: StaffRoute = {
    kind: "dashboard",
    dashboardView: "timeline",
    ...(search ? { search } : {}),
    ...(isDefaultGanttFacet(gantt) ? {} : { gantt }),
    focus: project.id,
  };
  return { available: true, href: staffPathFor(next) };
}

export function buildShowInCalendar({ project, tasks, backdrop, isAdmin, calendarBase }: ShowInArgs): ShowInDestination {
  if (isArchived(project) && !isAdmin) return { available: false, reason: ARCHIVED_ADMIN_ONLY_REASON };

  const deadlineDate = project.deadlineLocalCivil ? project.deadlineLocalCivil.slice(0, 10) : null;
  const task = deadlineDate && isSydneyCalendarDate(deadlineDate) ? null : earliestTask(tasks);
  const shootDate = project.shootDate && isSydneyCalendarDate(project.shootDate) ? project.shootDate : null;

  let date: string;
  let target: "deadline" | "task" | "shoot-date";
  if (deadlineDate && isSydneyCalendarDate(deadlineDate)) { date = deadlineDate; target = "deadline"; }
  else if (task && isSydneyCalendarDate(task.startCivil.slice(0, 10))) { date = task.startCivil.slice(0, 10); target = "task"; }
  else if (shootDate) { date = shootDate; target = "shoot-date"; }
  else return { available: false, reason: NOTHING_SCHEDULED_REASON };

  const route = backdropRoute(backdrop);
  const onCalendar = route.kind === "dashboard" && "calendar" in route;
  const base: DashboardCalendarState = onCalendar ? route.calendar : calendarBase;
  const filter = broadenedFilter(route, project);
  const search = dashboardSearchOf(route);

  const layer = target === "task" ? "checklist" : "project";
  const layers = base.layers.includes(layer) ? base.layers : (["project", "checklist"] as const).filter((candidate) => candidate === layer || base.layers.includes(candidate));
  const calendar: DashboardCalendarState = {
    ...base,
    ...filter,
    date,
    layers: [...layers],
    search: search ?? "",
    showDeliveredProjects: base.showDeliveredProjects || project.stageKey === "delivered",
    showCompletedChecklist: base.showCompletedChecklist || (target === "task" && task?.done === true),
  };
  return {
    available: true,
    href: staffPathFor({ kind: "dashboard", calendar, focus: project.id }),
    target,
    ...(target === "shoot-date" ? { note: "shoot-date" as const } : {}),
  };
}
