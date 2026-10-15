import { useEffect, useState } from "react";

export type VisualViewportBox = { height: number; offsetTop: number };

/**
 * The visual viewport's height and offset (#879, D10): what is left above the on-screen keyboard. `enabled` is the phone compose mode; off (or with no `visualViewport`, as in a
 * desktop test), it is `null` and the caller keeps its own `100dvh` layout. The viewer's root takes `height` and shifts by `offsetTop`, so the film stays above the keyboard and the
 * composer sits on top of it rather than under it.
 */
export function useVisualViewport(enabled: boolean): VisualViewportBox | null {
  const [box, setBox] = useState<VisualViewportBox | null>(null);
  useEffect(() => {
    const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!enabled || !viewport) { setBox(null); return undefined; }
    const read = () => { setBox((held) => (held && held.height === viewport.height && held.offsetTop === viewport.offsetTop ? held : { height: viewport.height, offsetTop: viewport.offsetTop })); };
    read();
    viewport.addEventListener("resize", read);
    viewport.addEventListener("scroll", read);
    return () => { viewport.removeEventListener("resize", read); viewport.removeEventListener("scroll", read); };
  }, [enabled]);
  return enabled ? box : null;
}
