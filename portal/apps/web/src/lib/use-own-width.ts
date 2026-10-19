import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * An element's own width, in px: measured before paint, then kept by a ResizeObserver where there is one.
 * 0 until the element has layout. Shared by the Dashboard's view bar (its row layout) and the Table (which
 * columns fit, #923).
 */
export function useOwnWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(entry.contentRect.width); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
