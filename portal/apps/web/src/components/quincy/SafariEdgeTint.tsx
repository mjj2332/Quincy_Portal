import { useEffect, useState } from "react";

/**
 * How long the strips stay. Measured on iOS 27 Safari: 50ms is enough, and the tint stays after they go. The margin covers a slow frame.
 */
export const EDGE_TINT_HOLD_MS = 250;

const STRIP = "pointer-events-none fixed inset-x-0 z-[60] h-[var(--space-2)]";
const PAINT = { card: "bg-card", background: "bg-background" } as const;

/**
 * #927 follow-up: makes iOS Safari re-tint its status band and toolbar after an in-app navigation. Safari takes each bar's tint from a
 * bar-shaped fixed element at that edge, and re-samples only when a new one is inserted: a recolour, a scroll, a hash or history change,
 * or a full-screen fixed layer (the viewer dialog) does not move it. A strip of 2px is ignored, 6px is taken. So this inserts one strip at
 * each edge in the colour the bars should take, painted to match what is under it, and removes them after a short hold: the tint stays.
 * Key it to re-run (Safari ignores a node it has seen). Lesson: "Safari re-tints its bars only for a newly inserted bar at the edge (#927 follow-up)".
 */
export function SafariEdgeTint({ paint }: { paint: keyof typeof PAINT }) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => { setOn(false); }, EDGE_TINT_HOLD_MS);
    return () => { window.clearTimeout(timer); };
  }, []);
  if (!on) return null;
  return <>
    <div aria-hidden="true" data-testid="safari-edge-tint" className={`${STRIP} top-0 ${PAINT[paint]}`} />
    <div aria-hidden="true" data-testid="safari-edge-tint" className={`${STRIP} bottom-0 ${PAINT[paint]}`} />
  </>;
}
