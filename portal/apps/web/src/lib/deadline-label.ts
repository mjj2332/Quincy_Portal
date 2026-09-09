import { formatSydneyCivil } from "@quincy/shared";
import type { ProjectSummary } from "./kanban-interaction";

/**
 * Extracted from `ProjectKanbanBoard.tsx` (#82) so the old and new Boards share one formatter
 * instead of drifting into two. `deadlineLocalCivil` is the server-computed studio civil string;
 * `formatSydneyCivil` is only a fallback for a summary that predates that field. Never derive this
 * from `new Date(deadlineAt).toLocaleString()` — that renders in the *viewer's* zone, not the
 * studio's Sydney one.
 */
export function deadlineLabel(project: ProjectSummary): string | null {
  return project.deadlineAt === null ? null : (project.deadlineLocalCivil ?? formatSydneyCivil(project.deadlineAt)).replace("T", " ");
}
