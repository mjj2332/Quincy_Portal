import { useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import { QueryClientContext, type QueryClient } from "@tanstack/react-query";
import { CalendarDaysIcon, ChartGanttIcon } from "lucide-react";
import { Button } from "@/components/reui/button";
import { ButtonGroup } from "@/components/reui/button-group";
import { InternalLink } from "../InternalLink";
import { useDashboardReturnLink } from "./ProjectSheet";
import { useCapabilities } from "../../lib/capabilities";
import { projectDataKeys, type ProjectDetail, type ProjectSubtask } from "../../lib/project-data";
import { buildShowInCalendar, buildShowInTimeline, type ShowInArgs, type ShowInDestination } from "../../lib/project-show-in";
import { initializeDashboardCalendarState } from "../../screens/dashboard-helpers";

/**
 * #464 — "Show in Calendar / Timeline" in the Project sheet's identity row. Composition of ReUI
 * `c-button-group-1` (two outline buttons in a `ButtonGroup`) on the installed `reui/button-group`
 * and `reui/button`; each available button renders an `InternalLink`, so a plain click is an SPA
 * push through `locationStore()` (Back returns to the sheet) and Cmd-click / "open in new tab" are
 * native. An unavailable destination is a real disabled `<button>` with its reason shown beside the
 * group (Archived for a non-Admin, nothing scheduled). Hidden for roles without
 * `viewProductionCalendar` (a Photographer).
 *
 * The Subtask schedule comes from the cache the sheet's checklist already fills, read through the
 * query cache's own subscription and never an observer (#423: an observer here would own the key).
 */
const GROUP_ROW = "inline-flex flex-wrap items-center gap-x-[var(--space-3)] gap-y-[var(--space-1)] max-[721px]:basis-full";
const GROUP_LABEL = "[font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] uppercase tracking-[var(--tracking-wide)] text-foreground-secondary";
const REASON_TEXT = "[font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] text-foreground-secondary";

function subtasksFromCache(client: QueryClient | null, projectId: string): ProjectSubtask[] | undefined {
  return client?.getQueryData<ProjectSubtask[]>(projectDataKeys.subtasks(projectId));
}

function useCachedSubtasks(projectId: string): ProjectSubtask[] | undefined {
  const client = useContext(QueryClientContext) ?? null;
  const subscribe = useCallback((listener: () => void) => client ? client.getQueryCache().subscribe(listener) : () => undefined, [client]);
  const snapshot = useCallback(() => subtasksFromCache(client, projectId), [client, projectId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

const calendarStorage = {
  read(key: string) {
    try { return window.localStorage.getItem(key); } catch { return null; }
  },
};

function rememberedCalendarState() {
  // Read-only storage (no `write`): rendering must not rewrite the user's preferences.
  return initializeDashboardCalendarState({ kind: "dashboard" }, calendarStorage, { now: Date.now(), isPhone: window.matchMedia?.("(max-width: 720px)").matches ?? false });
}

function ShowInButton({ label, icon, destination, testId, describedBy }: { label: "Calendar" | "Timeline"; icon: React.ReactNode; destination: ShowInDestination; testId: string; describedBy?: string }) {
  const name = `Show in ${label}`;
  if (!destination.available) {
    return <Button type="button" variant="outline" size="sm" disabled data-testid={testId} aria-label={name} aria-describedby={describedBy}>{icon}{label}</Button>;
  }
  return (
    <Button
      variant="outline"
      size="sm"
      nativeButton={false}
      data-testid={testId}
      aria-label={name}
      role="link"
      render={<InternalLink to={destination.href} />}
    >
      {icon}{label}
    </Button>
  );
}

function ProjectShowInControl({ project, isAdmin }: { project: ProjectDetail; isAdmin: boolean }) {
  const backdrop = useDashboardReturnLink().to;
  const subtasks = useCachedSubtasks(project.id);
  const calendarBase = useMemo(() => rememberedCalendarState(), []);

  const args: ShowInArgs = {
    project: {
      id: project.id,
      stageKey: project.stageKey,
      archivedAt: project.archivedAt,
      shootDate: project.shootDate,
      deadlineLocalCivil: project.deadlineSchedule.deadline?.localCivil ?? null,
    },
    tasks: (subtasks ?? []).flatMap((task) => task.schedule?.start?.localCivil ? [{ id: task.id, position: task.position, done: task.done, startCivil: task.schedule.start.localCivil }] : []),
    backdrop,
    isAdmin,
    calendarBase,
  };
  const calendar = buildShowInCalendar(args);
  const timeline = buildShowInTimeline(args);
  const reason = !calendar.available ? calendar.reason : !timeline.available ? timeline.reason : null;
  const reasonId = `project-show-in-reason-${project.id}`;

  return (
    <div className={GROUP_ROW} data-testid="project-show-in">
      <span className={GROUP_LABEL} aria-hidden="true">Show in</span>
      <ButtonGroup aria-label="Show in">
        <ShowInButton label="Calendar" icon={<CalendarDaysIcon aria-hidden="true" data-icon="inline-start" />} destination={calendar} testId="project-show-in-calendar" describedBy={reason ? reasonId : undefined} />
        <ShowInButton label="Timeline" icon={<ChartGanttIcon aria-hidden="true" data-icon="inline-start" />} destination={timeline} testId="project-show-in-timeline" describedBy={reason ? reasonId : undefined} />
      </ButtonGroup>
      {reason && <span id={reasonId} className={REASON_TEXT} data-testid="project-show-in-reason">{reason}</span>}
    </div>
  );
}

export function ProjectShowIn({ project }: { project: ProjectDetail }) {
  const { can, role } = useCapabilities();
  if (!can("viewProductionCalendar")) return null;
  return <ProjectShowInControl project={project} isAdmin={role === "admin"} />;
}
