/**
 * The Dashboard header's summary line (#427), which replaced the search chip's count text (#260).
 *
 * Pure: the Dashboard hands it the projects the Table/Board actually render (`projects` — the
 * current scope and committed search, after overlays), whether a search is active, the server's
 * `total` for the CURRENT search key (null until that key's counts land), and how many projects the
 * Calendar/Timeline report drawing (`shown`, null for Table/Board and until a view reports).
 * Loading and error states pass `null` for `projects` and get no summary at all — never a "0".
 */
export type DashboardSummaryProject = { stageKey: string; deadlineAt: number | null };

export type DashboardSummaryInput = {
  projects: readonly DashboardSummaryProject[] | null;
  archived: boolean;
  searchActive: boolean;
  /** The server's active-Project total for the current search key, or null until it lands. */
  searchTotal: number | null;
  /** How many of the visible projects the Calendar/Timeline draws under its own filters. */
  shown: number | null;
  now: number;
};

export type DashboardSummary = { text: string; overdue: number };

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The server's own rule (`workers/app/src/lib/project-deadline.ts`): a delivered project is never
 * overdue, an unset deadline is not overdue, and only a deadline strictly in the past counts. */
export function isOverdueProject(project: DashboardSummaryProject, now: number): boolean {
  return project.stageKey !== "delivered" && project.deadlineAt !== null && project.deadlineAt < now;
}

export function dashboardSummary(input: DashboardSummaryInput): DashboardSummary | null {
  const { projects, archived, searchActive, searchTotal, shown, now } = input;
  if (projects === null) return null;
  if (archived) return { text: plural(projects.length, "archived Project"), overdue: 0 };
  const overdue = projects.filter((project) => isOverdueProject(project, now)).length;
  if (!searchActive) return { text: plural(projects.length, "active Project"), overdue };
  const of = searchTotal === null ? "" : ` of ${searchTotal}`;
  const base = `${projects.length}${of} active ${projects.length === 1 && searchTotal === null ? "Project" : searchTotal === 1 ? "Project" : "Projects"}`;
  const hidden = shown !== null && shown < projects.length;
  return { text: hidden ? `${base} · ${shown} shown` : base, overdue };
}
