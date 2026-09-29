/**
 * #260: the Dashboard search chip's count text. `matching`/`total` are the server's search counts
 * (search alone, no view filters). `shown` is how many of those projects the current view actually
 * draws under its own filters — reported by the Gantt and the Calendar, `null` for List/Kanban and
 * while a view has not reported yet. Only when the view hides some matches does the chip name both
 * numbers ("2 of 31 projects match · 1 shown"); otherwise it stays the plain search count.
 */
export function searchChipCountText(counts: { matching: number; total: number }, shown: number | null): string {
  const base = `${counts.matching} of ${counts.total} ${counts.total === 1 ? "project" : "projects"}`;
  if (shown === null || shown >= counts.matching) return `${base} · `;
  return `${base} match · ${shown} shown · `;
}
