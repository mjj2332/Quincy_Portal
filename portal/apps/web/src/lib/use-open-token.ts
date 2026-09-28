import { useState } from "react";

/**
 * An identity token for a retained dialog's re-mount `key` (§6.0 retention). Bumps once per
 * null→non-null (`isOpen`) transition, using React's own documented "adjust state while
 * rendering" pattern — conditional `setState` calls made during render, not a ref mutated during
 * render (react.dev/reference/react/useState#storing-information-from-previous-renders).
 *
 * This matters specifically under React 19's concurrent rendering: React may start a render,
 * abandon it before it commits (an interruption, a discarded speculative render), and retry.
 * A ref mutated unconditionally during render carries that abandoned attempt's write forward —
 * the retry then sees an "already open" ref that was never actually committed, and can skip a
 * token bump it should make. `setState` calls made *during* render are a first-class operation
 * React itself owns: calling it re-runs the component synchronously with the updated state
 * *before* anything commits, so an abandoned render's state update can never leak into a later,
 * genuinely different render's decision the way a raw ref write can. It still updates the
 * SAME render's `key=` read (the whole reason the original `useEffect`-based version was wrong,
 * per round 1) — React re-invokes the function body immediately, not on a later tick.
 *
 * Used by `components/ProductionEventCalendarDialogs.tsx`, which the Calendar and (since #224) the
 * Gantt both render; the Gantt's own copy and `components/ProductionCalendar.tsx` went in #224.
 */
export function useOpenToken(isOpen: boolean): number {
  const [token, setToken] = useState(0);
  const [wasOpen, setWasOpen] = useState(false);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setToken((current) => current + 1);
  }
  return token;
}
