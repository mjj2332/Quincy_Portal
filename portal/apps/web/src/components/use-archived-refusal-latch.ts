import { useCallback, useEffect, useRef, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { projectDataKeys } from "../lib/project-data";

/**
 * The "refused, awaiting fresh data" latch behind the archived read-only surfaces (#450 Checklist, #527 Discussion; #566).
 *
 * A write refused as archived latches the surface read-only at once. The latch then clears when the next Project detail or
 * collaboration-summary fetch lands (any value), after which the `archived` prop (which that fetch feeds) is trusted alone. It also
 * clears when the prop goes true to false. Clearing on the prop edge alone left the latch stuck when the Project was restored before
 * the post-refusal refetch landed: that refetch already said `archived: false`, so the prop never showed a true to false change.
 *
 * Only a fetch that lands after the latch was set counts; the refusal handler invalidates detail and summary, which cancels and
 * restarts any fetch still in flight. A failed fetch leaves the latch on (fails safe: the surface stays read-only).
 */
export function useArchivedRefusalLatch(queryClient: QueryClient | undefined, projectId: string, archived: boolean) {
  const [latched, setLatched] = useState(false);
  const priorArchived = useRef(archived);
  const latchedAt = useRef(0);
  const latch = useCallback(() => { latchedAt.current = Date.now(); setLatched(true); }, []);
  useEffect(() => { if (priorArchived.current && !archived) setLatched(false); priorArchived.current = archived; }, [archived]);
  useEffect(() => {
    if (!latched || !queryClient) return;
    const watched = [projectDataKeys.detail(projectId), projectDataKeys.collaborationSummary(projectId)];
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success") return;
      const key = event.query.queryKey;
      if (!watched.some((candidate) => candidate.length === key.length && candidate.every((part, index) => part === key[index]))) return;
      if (event.query.state.dataUpdatedAt < latchedAt.current) return;
      setLatched(false);
    });
  }, [latched, projectId, queryClient]);
  return { latched, latch, readOnly: archived || latched };
}
