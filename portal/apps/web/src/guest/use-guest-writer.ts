import { useCallback, useEffect, useMemo, useRef } from "react";
import type { WriteResult } from "./guest-api";

/** A write that was not sent because one for the same key is still out, or whose answer arrived after the scope it was made in had gone. Neither changes anything. */
export type Skipped = { kind: "busy" } | { kind: "stale" };
export type Run = (key: string, call: () => Promise<WriteResult>) => Promise<WriteResult | Skipped>;

/**
 * Serialises a guest's note writes (#741 13c). One write per key is in flight at a time (a second for the same key answers `busy` without sending), and every answer is
 * checked against the `scope` (the Version on screen) it started in: an answer that arrives after the guest moved on is `stale` and the caller applies nothing. `epoch()` moves whenever
 * a write starts or settles, so a list read can tell it overlapped a write and must not overwrite the answer the write already applied.
 * `effects` run for the refusals that change the page (verification lost, the link gone, the Project archived) and only for a write that is not stale.
 */
export function useGuestWriter(scope: string, effects: { onUnverified: () => void; onGone: () => void; onArchived: () => void }): { run: Run; epoch: () => number } {
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const effectsRef = useRef(effects);
  effectsRef.current = effects;
  const inflight = useRef(new Set<string>());
  const epochRef = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const run = useCallback<Run>(async (key, call) => {
    if (inflight.current.has(key)) return { kind: "busy" };
    inflight.current.add(key);
    epochRef.current += 1;
    const started = scopeRef.current;
    let result: WriteResult;
    try { result = await call(); } finally { inflight.current.delete(key); epochRef.current += 1; }
    if (!alive.current || scopeRef.current !== started) return { kind: "stale" };
    if (result.kind === "unverified") effectsRef.current.onUnverified();
    else if (result.kind === "gone") effectsRef.current.onGone();
    else if (result.kind === "archived") effectsRef.current.onArchived();
    return result;
  }, []);
  const epoch = useCallback(() => epochRef.current, []);
  return useMemo(() => ({ run, epoch }), [run, epoch]);
}
