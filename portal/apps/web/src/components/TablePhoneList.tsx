import { InternalLink } from "./InternalLink";
import { AvatarStack } from "./quincy/AvatarStack";
import { Badge } from "./reui/badge";
import { GroupToggle, ProjectDeadline, ProjectThumb, projectPlace, useCells, type GroupRowData, type TableRowData } from "./DashboardTableParts";
import { useCoverRetry } from "./board/card";
import type { ProjectSummary } from "../lib/kanban-interaction";

/**
 * #923, frame 4g: the Table at <=721px is a list, not a grid. The same rows the grid draws
 * (`DashboardTable.tsx` builds them, grouped or flat by the viewer's Group by), each one the thumb, the
 * street, the suburb, the Deadline with its late chip, and the editors. A group header is the grid's
 * toggle (44px on touch), so Delivered starts collapsed here too.
 *
 * The row is opened by the street's `InternalLink`, whose `::after` stretches over the `li` (the same
 * pattern as the grid row); the Deadline trigger and the cover retry ride above it in `relative z-[1]`.
 */
export function TablePhoneList({ data }: { data: TableRowData[] }) {
  return (
    <div data-testid="project-table-phone-list" className="min-h-0 flex-1 overflow-y-auto">
      {/* The rows are all groups (a Group by) or all Projects (None). */}
      {data.map((row) => (row.kind === "group" ? <PhoneGroup key={row.id} data={row} /> : null))}
      {data.some((row) => row.kind === "project") && (
        <ul className="m-0 list-none p-0">
          {data.map((row) => (row.kind === "project" ? <PhoneRow key={row.id} project={row.project} /> : null))}
        </ul>
      )}
    </div>
  );
}

function PhoneGroup({ data }: { data: GroupRowData }) {
  const { isGroupOpen, toggleGroup } = useCells();
  const open = isGroupOpen(data.group.key);
  return (
    <section aria-label={data.group.label}>
      {/* 4g `.pgh`: 44px on the raised paper, under a hairline. */}
      <div className="flex min-h-11 items-center border-b border-border bg-muted px-[var(--space-2)]">
        <GroupToggle label={data.group.label} stageKey={data.stageKey} appearance={data.appearance} open={open} onToggle={() => toggleGroup(data.group.key)} />
      </div>
      {open && (
        <ul className="m-0 list-none p-0">
          {data.subRows.map((row) => <PhoneRow key={row.id} project={row.project} />)}
        </ul>
      )}
    </section>
  );
}

/** 4g `.prow`: thumb, then street / suburb / Deadline stacked, then the editors; 12px and 16px padding. */
function PhoneRow({ project }: { project: ProjectSummary }) {
  const { projectHrefFor, appearanceOf, canEditDeadline, terminal, role } = useCells();
  const appearance = appearanceOf(project);
  const cover = useCoverRetry();
  return (
    <li
      data-late={appearance.lateness.late}
      className="relative flex items-start gap-[var(--space-3)] border-b border-border bg-card px-[var(--space-4)] py-[var(--space-3)]"
    >
      <ProjectThumb project={project} retryToken={cover.token} onFailedChange={cover.setFailed} />
      <div className="flex min-w-0 flex-1 flex-col gap-[var(--space-1)]">
        <InternalLink
          to={projectHrefFor(project.id)}
          data-testid="project-table-row-link"
          className="block truncate text-sm text-inherit no-underline after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:outline-[length:var(--border-width-bold)] focus-visible:after:outline-solid focus-visible:after:outline-ring after:-outline-offset-2 focus-visible:after:-outline-offset-2"
        >
          {project.street}
        </InternalLink>
        <span className="block truncate text-xs text-foreground-secondary">{projectPlace(project)}</span>
        <ProjectDeadline project={project} appearance={appearance} canEditDeadline={canEditDeadline} terminal={terminal} role={role} />
        {project.archivedAt && <Badge variant="secondary" size="sm" className="self-start" data-testid="project-table-archived">Archived</Badge>}
        {cover.retry}
      </div>
      <AvatarStack people={project.editors ?? []} personNoun="Editor" emptyLabel="No Editor assigned" className="shrink-0" />
    </li>
  );
}
