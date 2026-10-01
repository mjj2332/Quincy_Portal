import type { ProjectSummary } from "./kanban-interaction";

/**
 * RAW counts as the Dashboard Table shows them (#431), a copy of `components/kanban2/card.tsx`'s
 * private `rawCounts` (#82) so the Board's card stays untouched. Branches on
 * `expectedCount === null`, not truthiness: `expectedCount: 0` is meaningful and renders `0/0`. The
 * visible string and the spoken one are split because "12/40" is read aloud as "twelve slash forty".
 */
export function rawCounts(project: Pick<ProjectSummary, "receivedCount" | "expectedCount">): { visible: string; spoken: string } {
  const { receivedCount, expectedCount } = project;
  if (expectedCount === null) {
    return { visible: `${receivedCount}`, spoken: `${receivedCount} RAW files received, expected count unknown` };
  }
  return { visible: `${receivedCount}/${expectedCount}`, spoken: `${receivedCount} of ${expectedCount} RAW files received` };
}
