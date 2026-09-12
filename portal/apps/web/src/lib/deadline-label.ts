import { formatSydneyCivil } from "@quincy/shared";
import type { ProjectSummary } from "./kanban-interaction";

/**
 * Extracted from the original Board's card (#82), now the single formatter for `KanbanCard2`
 * (`components/kanban2/card.tsx`) since #83's cutover retired that original. `deadlineLocalCivil`
 * is the server-computed studio civil string; `formatSydneyCivil` is only a fallback for a summary
 * that predates that field. Never derive this from `new Date(deadlineAt).toLocaleString()` — that
 * renders in the *viewer's* zone, not the studio's Sydney one.
 */
export function deadlineLabel(project: ProjectSummary): string | null {
  return project.deadlineAt === null ? null : (project.deadlineLocalCivil ?? formatSydneyCivil(project.deadlineAt)).replace("T", " ");
}
