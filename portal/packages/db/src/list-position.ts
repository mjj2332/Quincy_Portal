/** Generic fractional list position between two neighbours (subtasks, collections). */
export function computeInsertPosition(before: number | null, after: number | null): number {
  if (before === null && after === null) return 0;
  if (before === null) return after! - 1024;
  if (after === null) return before + 1024;
  return (before + after) / 2;
}
