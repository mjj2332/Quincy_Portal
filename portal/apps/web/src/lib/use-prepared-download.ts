import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Waiting for a zip to be prepared (#802). A large archive can only be streamed once the CRC-32 of every file is known, which a background job computes, so a page asks the server to prepare it and then
 * waits. This hook is the waiting, shared by the staff and guest surfaces: `start()` asks once (the caller's `check("start")` is the preparing request), and while the answer is `preparing` it asks again
 * every 30 s (`check("poll")`), for at most five minutes, only while the surface is `active` (open) and the page is visible. Closing it, unmounting it, or the five minutes running out stops the timer, and a
 * late answer to an earlier round changes nothing. It never downloads: `ready` is the caller's cue to offer the button, and the person presses it.
 *
 * A poll that fails (`failed`) is one dropped request, so the wait goes on; a failed `start` is shown as `failed`. `timeout` is "still preparing after five minutes": the caller offers "Check again", which is `start()`.
 */
export const PREPARE_POLL_MS = 30_000;
export const PREPARE_MAX_MS = 5 * 60_000;
/** What both surfaces say once the five minutes have run out and the archive is still not ready. */
export const PREPARE_TIMEOUT_COPY = "Still preparing. Check again in a minute.";
/** What both surfaces say once the archive is ready and the person presses the download. */
export const READY_HINT_COPY = "Your zip is ready. It starts in your browser when you press Download zip. If nothing downloads, wait a minute and try again.";
/** Lines the spinner up with the first line of a notice whose copy wraps to two (the call sites, not the shared Notice, own this). */
export const NOTICE_SPINNER = "self-start mt-[var(--space-1)] shrink-0";

export type PrepareOutcome = { state: "ready" } | { state: "preparing" } | { state: "unavailable" } | { state: "too_large" } | { state: "failed" };
export type PreparedStatus = "idle" | "checking" | "preparing" | "ready" | "unavailable" | "too_large" | "failed" | "timeout";
export type PreparedDownload = { status: PreparedStatus; start: () => Promise<PrepareOutcome> };

/** A check that rejects (a dropped connection, a 401) is a `failed` answer, so nothing waits on it forever; `onError` sees the reason first, so the caller can run its auth handling (401/403). */
export function usePreparedDownload({ check, active, onError }: { check: (reason: "start" | "poll") => Promise<PrepareOutcome>; active: boolean; onError?: (reason: unknown) => void }): PreparedDownload {
  const [status, setStatus] = useState<PreparedStatus>("idle");
  const checkRef = useRef(check); checkRef.current = check;
  const onErrorRef = useRef(onError); onErrorRef.current = onError;
  const ask = useCallback(async (reason: "start" | "poll"): Promise<PrepareOutcome> => {
    try { return await checkRef.current(reason); } catch (error) { onErrorRef.current?.(error); return { state: "failed" }; }
  }, []);
  const generation = useRef(0);
  const startedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waiting = useRef(false);
  const lastAsk = useRef(0);
  const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
  const stop = useCallback(() => { generation.current += 1; waiting.current = false; if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; } }, []);

  const settle = useCallback((mine: number, outcome: PrepareOutcome, reason: "start" | "poll") => {
    if (generation.current !== mine) return;
    if (outcome.state === "preparing" || (outcome.state === "failed" && reason === "poll")) {
      if (Date.now() - startedAt.current >= PREPARE_MAX_MS) { waiting.current = false; setStatus("timeout"); return; }
      setStatus("preparing"); waiting.current = true;
      timer.current = setTimeout(() => { timer.current = null; void poll(mine); }, PREPARE_POLL_MS);
      return;
    }
    waiting.current = false; setStatus(outcome.state);
  }, []);
  const poll = useCallback(async (mine: number) => {
    if (generation.current !== mine) return;
    // Hidden: do not ask. The visibility listener asks as soon as the page is back, if the five minutes have not run out.
    if (!visible()) return;
    if (Date.now() - startedAt.current >= PREPARE_MAX_MS) { waiting.current = false; setStatus("timeout"); return; }
    lastAsk.current = Date.now();
    settle(mine, await ask("poll"), "poll");
  }, [ask, settle]);

  const start = useCallback(async (): Promise<PrepareOutcome> => {
    stop(); const mine = generation.current; startedAt.current = Date.now(); setStatus("checking");
    lastAsk.current = Date.now();
    const outcome = await ask("start");
    settle(mine, outcome, "start");
    return outcome;
  }, [ask, settle, stop]);

  useEffect(() => {
    if (!active) { stop(); setStatus("idle"); return undefined; }
    const onVisible = () => {
      // Back in view while waiting: ask now rather than at the next tick, unless the last ask was moments ago (a tab flicking back and forth must not hammer the server).
      if (!visible() || !waiting.current || Date.now() - lastAsk.current < 5_000) return;
      if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
      void poll(generation.current);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => { document.removeEventListener("visibilitychange", onVisible); stop(); };
  }, [active, poll, stop]);

  return { status, start };
}
