import { useEffect, useState } from "react";

/** The countdown refresh: a deadline reads in days, hours and minutes, so a minute is fine-grained enough. */
export const MINUTE_NOW_REFRESH_MS = 60_000;

/**
 * #914: "now" for a deadline countdown, refreshed every minute while the caller is mounted, so a countdown stays true on a header,
 * or a Project info that is left open. One hook for the desktop chip, the phone bar and both Project info surfaces.
 */
export function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), MINUTE_NOW_REFRESH_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}
