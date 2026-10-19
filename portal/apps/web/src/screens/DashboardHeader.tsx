import type { DashboardSummary } from "../lib/dashboard-summary";

/**
 * The Dashboard's page heading and summary, for assistive tech only (#923). Frame 4a removed the
 * visible "Projects" title, the "N active projects" line and the page-level overdue badge: the view
 * bar is the page's only row above the view, and lateness lives where it is actionable (group and
 * column headers, each row's deadline). The page still needs its `<h1>`, and the summary (the
 * search's "N of T", the Timeline's and Calendar's "· N shown") still has to reach a screen reader,
 * so both stay, visually hidden. New shoot moved into the view bar.
 *
 * The summary is a polite live region (`role="status"`), mounted from the first render so a later
 * count is announced, and empty while the projects load or fail to load: never a "0". `busy` marks a
 * summary computed from keep-previous placeholder data (a search whose results have not landed), so
 * assistive tech holds the announcement until the count settles.
 */
export function DashboardHeader({ summary, busy }: { summary: DashboardSummary | null; busy: boolean }) {
  return (
    <header data-testid="dashboard-header" className="sr-only">
      <h1>Projects</h1>
      <p data-testid="dashboard-summary" role="status" aria-busy={busy || undefined}>{summary?.text ?? ""}</p>
    </header>
  );
}
