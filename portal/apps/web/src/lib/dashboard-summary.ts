import type { DashboardArchivedMode } from "@quincy/shared";

/**
 * The Dashboard header's summary line (#427), which replaced the search chip's count text (#260).
 *
 * Pure: the Dashboard hands it the projects the Table/Board actually render (`projects` — the
 * current filter and committed search, after overlays), the Archived mode, whether the search or the
 * Filter narrows, the server's `total` for the CURRENT request key (null until that key's counts
 * land), and how many projects the Calendar/Timeline report drawing (`shown`, null for Table/Board
 * and until a view reports). Loading and error states pass `null` for `projects` and get no summary
 * at all — never a "0".
 *
 * Three shapes (#428), one per Archived mode: Hide "N[ of T] active projects", Only
 * "N[ of T] archived projects", Include "N[ of T] projects · A archived". "of T" appears only while
 * the search or the Filter narrows and the server has counted. Overdue never counts an archived or
 * delivered project.
 */
export type DashboardSummaryProject = { stageKey: string; deadlineAt: number | null; archivedAt?: string | null };

export type DashboardSummaryInput = {
  projects: readonly DashboardSummaryProject[] | null;
  archived: DashboardArchivedMode;
  searchActive: boolean;
  /** True while the shared Filter (Stage, Priority or Archived) narrows. */
  filterActive?: boolean;
  /** The server's Project total for the current request key, or null until it lands. */
  searchTotal: number | null;
  /** How many of the visible projects the Calendar/Timeline draws under its own filters. */
  shown: number | null;
  now: number;
};

export type DashboardSummary = { text: string; overdue: number };

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The server's own rule (`workers/app/src/lib/project-deadline.ts`): a delivered project is never
 * overdue, an unset deadline is not overdue, and only a deadline strictly in the past counts. An
 * archived project is never overdue either (#428: it is out of the production desk). */
export function isOverdueProject(project: DashboardSummaryProject, now: number): boolean {
  return project.stageKey !== "delivered" && !project.archivedAt && project.deadlineAt !== null && project.deadlineAt < now;
}

export function dashboardSummary(input: DashboardSummaryInput): DashboardSummary | null {
  const { projects, archived, searchActive, filterActive = false, searchTotal, shown, now } = input;
  if (projects === null) return null;
  const overdue = projects.filter((project) => isOverdueProject(project, now)).length;
  const narrowed = searchActive || filterActive;
  const count = narrowed && searchTotal !== null ? `${projects.length} of ${searchTotal}` : String(projects.length);
  // "1 project" for an exact count of one; an "of T" count is singular only when T is.
  const singular = narrowed && searchTotal !== null ? searchTotal === 1 : projects.length === 1;
  const noun = singular ? "project" : "projects";
  let base: string;
  if (archived === "only") base = `${count} archived ${noun}`;
  else if (archived === "include") base = `${count} ${noun} · ${projects.filter((project) => project.archivedAt).length} archived`;
  else base = `${count} active ${noun}`;
  const hidden = shown !== null && shown < projects.length;
  return { text: hidden ? `${base} · ${shown} shown` : base, overdue };
}
