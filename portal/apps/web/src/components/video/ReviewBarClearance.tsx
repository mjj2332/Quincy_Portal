import { createContext, useContext, useState, type CSSProperties, type ReactNode } from "react";

/**
 * #741 11b: the fixed selection bar covers the end of the Video tab's scroll, so the clearance pads the wrapper that holds BOTH the Films and
 * the Video links section (`CollectionPanel`'s video branch), not just the Films body. `VideoCollectionPanel` reports the measured bar height.
 */
const ReportBarHeight = createContext<((height: number) => void) | null>(null);

/** The setter the Films section reports the bar's measured height to; `null` outside a `ReviewBarClearanceRoot`. */
export function useReportBarHeight() { return useContext(ReportBarHeight); }

export function ReviewBarClearanceRoot({ children }: { children: ReactNode }) {
  const [barHeight, setBarHeight] = useState(0);
  return <ReportBarHeight.Provider value={setBarHeight}>
    <div className="pb-[var(--review-bar-clearance,0px)]" data-testid="video-tab-body" {...(barHeight > 0 ? { style: { "--review-bar-clearance": `calc(${barHeight}px + var(--space-4))` } as CSSProperties } : {})}>{children}</div>
  </ReportBarHeight.Provider>;
}
