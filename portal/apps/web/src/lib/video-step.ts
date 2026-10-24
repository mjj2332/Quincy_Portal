/** Where the open film stands in the list a viewer steps through (#936), and its neighbours. `position` is 0-based; null when nothing is open or the list does not show it. */
export type StepTargets<T> = { position: number | null; total: number; prev: T | null; next: T | null };

/**
 * The step targets of the open film in `shown`, the films in the order the grid shows them (sort and Review status filter applied). Read by id from the live list on
 * every render, so a refresh, a re-sort or a film leaving the list moves the position at once. A film the list does not show (filtered out) has no position and steps
 * nowhere (#933 S1): the person changes the filter, not the order.
 */
export function stepTargets<T extends { id: string }>({ shown, openId }: { shown: readonly T[]; openId: string | null }): StepTargets<T> {
  const index = openId === null ? -1 : shown.findIndex((entry) => entry.id === openId);
  if (index < 0) return { position: null, total: shown.length, prev: null, next: null };
  return { position: index, total: shown.length, prev: shown[index - 1] ?? null, next: shown[index + 1] ?? null };
}
