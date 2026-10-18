import type { ProjectDetail } from "../../lib/project-data";

/** The meta line's separator (`·`), decorative: the desktop meta line and the phone project bar's subline. */
export const META_DOT = <span aria-hidden="true" className="text-muted-foreground">·</span>;

/** A Stage's label, or its key when the list does not carry it (an inactive or unknown Stage). */
export function stageLabel(stages: readonly { key: string; label: string }[], key: string): string {
  return stages.find((stage) => stage.key === key)?.label ?? key;
}

/** One entry per person: a Project lists a person once per role (Photographer and Editor), the header shows them once. */
export function uniqueByUser<T extends { userId: string }>(items: readonly T[]): T[] {
  return [...new Map(items.map((item) => [item.userId, item])).values()];
}

/**
 * Where "Edit project details" leads, or null when it is not offered. #455: an archived Project's details are read-only, so an Admin
 * with backend access is offered "Restore or delete" there instead, and nobody else is offered the link.
 */
export function projectDetailsAction(project: Pick<ProjectDetail, "id">, { canEdit, archived, canAdminBackend }: { canEdit: boolean; archived: boolean; canAdminBackend: boolean }): { href: string; label: string } | null {
  if (!canEdit || (archived && !canAdminBackend)) return null;
  return { href: `/projects/${encodeURIComponent(project.id)}/edit`, label: archived ? "Restore or delete" : "Edit project details" };
}
