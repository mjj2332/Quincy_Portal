import { useEffect, useRef, useState } from "react";

/** Whole seconds until `until` (epoch ms), counting down once a second; 0 when there is none or it has passed. Keyed on the deadline, so a remount (a tab change) resumes the same wait rather than restarting it. */
export function useSecondsUntil(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null) return;
    setNow(Date.now());
    const timer = setInterval(() => { const current = Date.now(); setNow(current); if (current >= until) clearInterval(timer); }, 1000);
    return () => { clearInterval(timer); };
  }, [until]);
  return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
}

const REDUCED = "(prefers-reduced-motion: reduce)";
/** `prefers-reduced-motion: reduce`, live. The lightbox jumps instead of sliding when it is on. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(REDUCED).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCED);
    const onChange = () => { setReduced(query.matches); };
    onChange();
    query.addEventListener("change", onChange);
    return () => { query.removeEventListener("change", onChange); };
  }, []);
  return reduced;
}

/**
 * Warms the browser cache for the photos either side of the one on screen, so a swipe or an arrow shows the next photo at once. It is this module's own hook, not `lib/lightbox-neighbor-preload`,
 * which pulls in the staff `PhotoGrid`. `reach` photos each way; a null url (a locked item with nothing to show) is skipped. Each URL is requested once per mount.
 */
export function useNeighbourPreload(urls: readonly (string | null)[], index: number, reach = 2): void {
  const requested = useRef(new Set<string>());
  useEffect(() => {
    const seen = requested.current;
    for (let offset = -reach; offset <= reach; offset += 1) {
      const url = offset === 0 ? null : urls[index + offset];
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const image = new Image();
      image.decoding = "async";
      image.src = url;
    }
  }, [urls, index, reach]);
}
