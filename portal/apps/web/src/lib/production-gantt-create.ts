/**
 * #344 — the Gantt's "+ Add task" pin: a display-only copy of a just-created Subtask, kept on
 * screen while the Gantt's own refetch catches up, and (if an authoritative complete refetch omits
 * it, e.g. under a filter) until the NEXT refetch after that, with a "Created — hidden by current
 * filters" notice. Pure and node-testable; `components/ProductionGantt.tsx` owns the state and the
 * toast.
 *
 * It is never spliced into TanStack's paginated response or `childState`: both have explicit
 * generation and pagination ownership rules. It is applied to the DISPLAYED projects only, keyed by
 * the render's own `generationKey`, so a filter or identity change drops it.
 *
 * "Omitted" is judged only on an authoritative view: a stamp newer than the pin's AND a project
 * whose children are fully loaded (`truncated === false`). A truncated project keeps the pin
 * silently until its child chain completes — a missing row on page one is not a filter omission.
 */
import type { GanttChecklistRowDto, GanttProjectRowDto } from "@quincy/shared";
import type { ProjectSubtask } from "./project-data";

export type PinnedCreatedRow = {
  row: GanttChecklistRowDto;
  generationKey: string;
  /** The query's `dataUpdatedAt` when the row was created. */
  stamp: number;
  /** Set once judged hidden by the current filters: the stamp of the refetch that omitted it. */
  hiddenAtStamp: number | null;
};

const READ_ONLY = { canDrag: false, canResize: false, canOpenScheduleEditor: false, canScheduleRange: false } as const;

/** The created Subtask as a Gantt child row: unassigned (a title-only create), read-only until the real row arrives. */
export function pinFromCreated(projectId: string, created: Pick<ProjectSubtask, "id" | "title" | "done" | "position" | "schedule">, stamp: number, generationKey: string): PinnedCreatedRow {
  return {
    row: { id: created.id, projectId, title: created.title, done: created.done, position: created.position, assignee: null, schedule: created.schedule, permissions: { ...READ_ONLY } },
    generationKey,
    stamp,
    hiddenAtStamp: null,
  };
}

/** Appends each applicable pin to its project's children when the id is absent. Identity-preserving when nothing applies. */
export function withPinnedCreatedRows(projects: GanttProjectRowDto[], pins: readonly PinnedCreatedRow[], generationKey: string): GanttProjectRowDto[] {
  const active = pins.filter((pin) => pin.generationKey === generationKey);
  if (active.length === 0) return projects;
  let changed = false;
  const next = projects.map((project) => {
    const add = active.filter((pin) => pin.row.projectId === project.id && !project.children.rows.some((row) => row.id === pin.row.id));
    if (add.length === 0) return project;
    changed = true;
    return { ...project, children: { ...project.children, rows: [...project.children.rows, ...add.map((pin) => pin.row)] } };
  });
  return changed ? next : projects;
}

export function reconcilePinnedCreatedRows(
  pins: readonly PinnedCreatedRow[],
  projects: readonly GanttProjectRowDto[],
  stamp: number,
  generationKey: string,
): { pins: PinnedCreatedRow[]; newlyHidden: PinnedCreatedRow[] } {
  const kept: PinnedCreatedRow[] = [];
  const newlyHidden: PinnedCreatedRow[] = [];
  for (const pin of pins) {
    if (pin.generationKey !== generationKey) continue;
    const project = projects.find((candidate) => candidate.id === pin.row.projectId);
    if (project?.children.rows.some((row) => row.id === pin.row.id)) continue;
    if (pin.hiddenAtStamp !== null) {
      // shown for one more refetch after the omission, then let go
      if (stamp > pin.hiddenAtStamp) continue;
      kept.push(pin);
      continue;
    }
    const authoritative = stamp > pin.stamp && (!project || !project.children.truncated);
    if (!authoritative) {
      kept.push(pin);
      continue;
    }
    const hidden = { ...pin, hiddenAtStamp: stamp };
    kept.push(hidden);
    newlyHidden.push(hidden);
  }
  return { pins: kept, newlyHidden };
}
