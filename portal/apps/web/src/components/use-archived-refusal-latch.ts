import { useCallback, useEffect, useRef, useState } from "react";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * The "refused, awaiting fresh data" latch behind the archived read-only surfaces (#450 Checklist, #527 Discussion; #566).
 *
 * A write refused as archived latches the surface read-only at once, and `latch()` then runs one real refetch of `archivedQueryKey`:
 * exactly the query that supplies this surface's `archived` prop (Project detail in the workspace, the collaboration summary in the
 * collaboration-only view). When that fetch settles successfully the latch clears whatever it said, and the prop is trusted alone. A
 * failed fetch, or one that never ran, leaves the surface read-only (fails safe). The latch also clears when the prop goes true to
 * false. Clearing on the prop edge alone stuck when the Project was restored before the post-refusal refetch landed: that refetch
 * already said `archived: false`, so the prop never changed.
 *
 * The refetch is driven by the refusal handler, not by a cache subscription: a subscription starts after the latched render, so a
 * fast fetch could finish first, and a manual `setQueryData` would look like a fetch. A newer refusal supersedes an older pending one.
 */
export function useArchivedRefusalLatch(queryClient: QueryClient | undefined, archivedQueryKey: QueryKey, archived: boolean) {
  const [latched, setLatched] = useState(false);
  const priorArchived = useRef(archived);
  const generation = useRef(0);
  const mounted = useRef(true);
  const keyRef = useRef(archivedQueryKey); keyRef.current = archivedQueryKey;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (priorArchived.current && !archived) setLatched(false); priorArchived.current = archived; }, [archived]);
  const latch = useCallback(() => {
    setLatched(true);
    if (!queryClient) return;
    const mine = ++generation.current;
    const startedAt = Date.now();
    const queryKey = keyRef.current;
    void (async () => {
      try { await queryClient.refetchQueries({ queryKey, exact: true }); } catch { return; }
      // Let the query observers publish the new `archived` prop (they notify on a zero-delay timer) before the latch lets go.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (!mounted.current || generation.current !== mine) return;
      const state = queryClient.getQueryCache().find({ queryKey, exact: true })?.state;
      if (state && state.status === "success" && state.fetchStatus === "idle" && state.dataUpdatedAt >= startedAt) setLatched(false);
    })();
  }, [queryClient]);
  return { latched, latch, readOnly: archived || latched };
}
