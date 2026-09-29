/**
 * #221 PR B2 — the Dashboard Gantt's `SchedulingPort`: every data access the shared scheduling
 * controller (`useSchedulingController`, `lib/use-scheduling-commands.tsx`) makes, answered from
 * the Gantt's own `GanttProjectRowDto[]` instead of the Calendar's range response.
 * `useCalendarSchedulingPort` in that same file is the reference implementation of each member.
 *
 * The baseline is `{ projects }` — the Gantt's EFFECTIVE projects (page one plus any continuation
 * child pages the component walked). The controller clones it on accept and adopts mutation results
 * into the clone; the component renders from that accepted clone while an interaction is open.
 *
 * Warnings (#288): one shared out-of-range rule, `scheduleWindowWarnings` (`schedule-bounds.ts`),
 * the same one the Calendar runs. This port supplies `boundsFor` (`ganttScheduleBounds` of the
 * project); the controller runs the rule over the SAVED schedule for the saved announcement and the
 * toast's `warningText`, and `ganttEditWarnings` below runs it through the planner for the drop
 * hint — so the hint, the live announcement and the toast always agree.
 *
 * Import boundary: like `production-gantt-adapter.ts` and `production-gantt-scheduling.ts`, never
 * import `@/components/reui/gantt/**` here, not even `import type`.
 */
import { useMemo } from "react";
import type { QueryClient } from "@tanstack/react-query";
import {
  subtaskIdFromCalendarEntityId,
  type ChecklistCalendarEventDto,
  type GanttChecklistRowDto,
  type GanttProjectRowDto,
  type ProductionCalendarFilters,
} from "@quincy/shared";
import type { DashboardIdentity } from "./dashboard-projects";
import type { ChecklistMutationResult } from "./scheduling-types";
import { planSchedulingProposal, type SchedulingWarning } from "./scheduling-policy";
import {
  ganttChecklistSource,
  ganttDeadlineEntry,
  ganttDeadlineEvent,
  ganttEditToProposal,
  ganttScheduleBounds,
  PROJECT_DEADLINE_ID_PREFIX,
  type GanttEdit,
} from "./production-gantt-scheduling";
import { removeProductionGanttQueries } from "./production-gantt-query";
import type { SchedulingDeadlineConfirmInput, SchedulingPort } from "./use-scheduling-commands";
import { sydneyToday } from "../screens/dashboard-helpers";

export type GanttBaseline = { projects: GanttProjectRowDto[] };

/** A deep, structured copy — the controller's accepted baseline must never alias query data. */
export function cloneGanttBaseline(baseline: GanttBaseline): GanttBaseline {
  return { projects: structuredClone(baseline.projects) };
}

export function findGanttChecklistRow(baseline: GanttBaseline, subtaskId: string): { project: GanttProjectRowDto; row: GanttChecklistRowDto } | undefined {
  for (const project of baseline.projects) {
    const row = project.children.rows.find((candidate) => candidate.id === subtaskId);
    if (row) return { project, row };
  }
  return undefined;
}

function findChecklist(baseline: GanttBaseline, entityId: string) {
  const subtaskId = subtaskIdFromCalendarEntityId(entityId);
  if (!subtaskId) return undefined;
  const found = findGanttChecklistRow(baseline, subtaskId);
  return found ? ganttChecklistSource(found.project, found.row) ?? undefined : undefined;
}

function projectForDeadlineId(baseline: GanttBaseline, id: string): GanttProjectRowDto | undefined {
  if (!id.startsWith(PROJECT_DEADLINE_ID_PREFIX)) return undefined;
  const projectId = id.slice(PROJECT_DEADLINE_ID_PREFIX.length);
  return baseline.projects.find((project) => project.id === projectId);
}

/**
 * Version-wins: a mutation result replaces the row's `schedule` (and `done`) only when its
 * `scheduleVersion` is NEWER than the row's own — a late result never rolls a fresher row back.
 * Returns the row itself when nothing changes.
 */
export function adoptGanttChecklistRow(row: GanttChecklistRowDto, result: ChecklistMutationResult): GanttChecklistRowDto {
  if (row.id !== result.id || result.scheduleVersion <= row.schedule.version) return row;
  return { ...row, schedule: result.schedule, done: result.done };
}

export function adoptGanttChecklist(baseline: GanttBaseline, result: ChecklistMutationResult): GanttBaseline {
  let changed = false;
  const projects = baseline.projects.map((project) => {
    let projectChanged = false;
    const rows = project.children.rows.map((row) => {
      const next = adoptGanttChecklistRow(row, result);
      if (next !== row) projectChanged = true;
      return next;
    });
    if (!projectChanged) return project;
    changed = true;
    return { ...project, children: { ...project.children, rows } };
  });
  return changed ? { projects } : baseline;
}

export function ganttInvalidation(_kind: "checklist" | "deadline", projectId: string) {
  // Every surface that shows the item refreshes; `producer: "gantt"` suppresses only this tab's own
  // Gantt refetch (the controller's settle refetch is the single one).
  return {
    projectId,
    resources: [{ kind: "detail" as const }, { kind: "subtasks" as const }, { kind: "activity" as const }],
    dashboard: true,
    calendar: true,
    gantt: true,
    producer: "gantt" as const,
  };
}

/** The Gantt's own filters live in its query key; the controller only copies this into a snapshot
 * it never reads back for the Gantt, so a default Calendar filter object is enough. */
function defaultCalendarFilters(): ProductionCalendarFilters {
  return { layers: [], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false };
}

/**
 * The advisory reason a drag/resize would carry, for the vendor's `dropWarning` (called per pointer
 * move — pure and cheap: one mapping, one plan, one window check).
 */
export function ganttEditWarnings(project: GanttProjectRowDto, source: ChecklistCalendarEventDto, edit: GanttEdit): SchedulingWarning[] {
  const proposal = ganttEditToProposal(source, edit);
  if (!proposal) return [];
  const planned = planSchedulingProposal(proposal, { bounds: ganttScheduleBounds(project) });
  if (!planned.ok || planned.value.kind !== "checklist") return [];
  return planned.value.warnings;
}

type GanttQuery = {
  data?: { projects: GanttProjectRowDto[] };
  dataUpdatedAt: number;
  error: unknown;
  refetch: () => Promise<{ data?: { projects: GanttProjectRowDto[] }; error: unknown; isError: boolean }>;
};

export type GanttSchedulingPortInput = {
  identity: DashboardIdentity;
  /** The effective projects (page one plus walked continuation pages). */
  projects: GanttProjectRowDto[];
  query: GanttQuery;
  /** Clears the component's own continuation-page state on access loss. */
  purgeChildren: () => void;
  /**
   * An access failure the query itself never sees (a continuation child-page 401/403). Surfaced
   * through `latestError` so the controller's own access-loss path handles it.
   */
  accessError?: unknown;
  /**
   * #221 PR C: opens the Gantt's own Deadline confirmation (`ProductionGanttDeadlineDialog`) and
   * resolves with the user's answer — becomes the port's `confirmDeadline`.
   */
  openDeadlineConfirm?: (input: SchedulingDeadlineConfirmInput) => Promise<boolean>;
};

export function useGanttSchedulingPort({ identity, projects, query, purgeChildren, accessError, openDeadlineConfirm }: GanttSchedulingPortInput): SchedulingPort<GanttBaseline> {
  const hasData = query.data !== undefined;
  // Memoised on the projects' identity: the controller's accept effect keys on `latest`, and a
  // fresh object every render would re-accept (and re-render) forever.
  const latest = useMemo<GanttBaseline | undefined>(() => (hasData ? { projects } : undefined), [hasData, projects]);
  const principalId = identity.principalId;
  return {
    latest,
    latestUnchecked: latest,
    latestStamp: query.dataUpdatedAt,
    latestError: query.error ?? accessError ?? null,
    refetch: async () => {
      const result = await query.refetch();
      // Continuation child pages are not part of the query; the component's chain logic re-seeds
      // them from the refetched page one and the next accept picks them up.
      return { data: result.data ? { projects: result.data.projects } : undefined, error: result.error, isError: result.isError };
    },
    clone: cloneGanttBaseline,
    snapshotFilters: defaultCalendarFilters,
    findUnscheduledEntry: (baseline, id, kind) => {
      if (!id) return undefined;
      if (kind !== "project") return undefined;
      const project = projectForDeadlineId(baseline, id);
      return project && !project.deadline ? ganttDeadlineEntry(project) : undefined;
    },
    findChecklist,
    findDeadline: (baseline, eventId) => {
      const project = projectForDeadlineId(baseline, eventId);
      return project ? ganttDeadlineEvent(project) ?? undefined : undefined;
    },
    findUnscheduledDeadline: (baseline, entryId) => {
      const project = projectForDeadlineId(baseline, entryId);
      return project && !project.deadline ? ganttDeadlineEntry(project) : undefined;
    },
    adoptChecklist: (baseline, _source, result) => adoptGanttChecklist(baseline, result),
    adoptDeadline: (baseline, event, current) => {
      let changed = false;
      const projects = baseline.projects.map((project) => {
        if (project.id !== event.project.id || current.version <= project.deadlineVersion) return project;
        changed = true;
        return {
          ...project,
          deadlineVersion: current.version,
          deadline: current.deadline
            ? { at: current.deadline.instant, localCivil: current.deadline.localCivil, version: current.version, reminderOffsetsMinutes: [...current.reminderOffsetsMinutes], overdue: project.deadline?.overdue ?? false }
            : null,
        };
      });
      return changed ? { projects } : baseline;
    },
    purge: (queryClient: QueryClient) => {
      removeProductionGanttQueries(queryClient, principalId);
      void queryClient.cancelQueries({ queryKey: ["production-gantt", principalId] });
      purgeChildren();
    },
    invalidation: ganttInvalidation,
    defaultPlacementDate: () => sydneyToday(Date.now()),
    settleFailedReason: "The latest Gantt could not be loaded.",
    boundsFor: (projectId) => {
      const project = projects.find((candidate) => candidate.id === projectId);
      return project ? ganttScheduleBounds(project) : null;
    },
    ...(openDeadlineConfirm ? { confirmDeadline: openDeadlineConfirm } : {}),
  };
}
