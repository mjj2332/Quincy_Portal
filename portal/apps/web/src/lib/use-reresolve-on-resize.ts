import { useEffect, useRef } from "react";

/**
 * #602: a popup's collision padding is resolved when it opens (a cold load has no shell header yet, #528), so a
 * viewport resize while it is open (a phone rotating, the impersonation banner appearing, a Project sheet
 * settling) left the padding stale. This re-reads it on `resize`, coalesced to one read per animation frame.
 * Only the padding callback is re-run: `pinnedToField` scrolls the page, so a caller that pins never uses this.
 *
 * `resolve` and `set` are read through refs, so passing fresh closures each render does not re-subscribe.
 */
export function useReresolveOnResize<T>(open: boolean, resolve: () => T, set: (value: T) => void): void {
  const latest = useRef({ resolve, set });
  latest.current = { resolve, set };
  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const onResize = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        latest.current.set(latest.current.resolve());
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [open]);
}
