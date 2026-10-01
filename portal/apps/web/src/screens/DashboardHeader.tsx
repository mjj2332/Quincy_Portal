import { InternalLink } from "../components/InternalLink";
import { Badge } from "../components/reui/badge";
import { buttonClasses } from "../components/quincy/Button";
import type { DashboardSummary } from "../lib/dashboard-summary";

/**
 * The Dashboard's identity header (#427): the page title, the summary line and, when anything is
 * overdue, a badge — plus the "New shoot" action behind `canCreateProject`.
 *
 * `summary` is `null` while the projects load or fail to load: the header then shows the title
 * alone, never a "0". `busy` marks a summary computed from keep-previous placeholder data (a search
 * whose results have not landed), so assistive tech is told the count is still settling.
 */
export function DashboardHeader({ summary, busy, canCreateProject }: { summary: DashboardSummary | null; busy: boolean; canCreateProject: boolean }) {
  return (
    <header data-testid="dashboard-header" className="flex shrink-0 flex-wrap items-center justify-between gap-x-[var(--space-6)] gap-y-[var(--space-3)] mb-[var(--space-4)]">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-[var(--space-4)] gap-y-[var(--space-1)]">
        <h1 className="[font:var(--type-h2)] tracking-[var(--tracking-tight)]">Projects</h1>
        {summary && (
          <p data-testid="dashboard-summary" aria-busy={busy || undefined} className="flex items-center gap-[var(--space-3)] text-[length:var(--text-sm)] text-muted-foreground">
            <span>{summary.text}</span>
            {summary.overdue > 0 && <Badge variant="destructive-light" size="sm" data-testid="dashboard-overdue-badge">{`${summary.overdue} overdue`}</Badge>}
          </p>
        )}
      </div>
      {canCreateProject && <InternalLink className={buttonClasses()} to="/projects/new">New shoot</InternalLink>}
    </header>
  );
}
