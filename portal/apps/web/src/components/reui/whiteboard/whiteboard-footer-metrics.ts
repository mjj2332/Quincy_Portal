import { useLayoutEffect, type RefObject } from "react"

/**
 * The editor's buttons that share the footer's line (a touch screen's finalize) sit past the footer's
 * width, measured before the first paint and on every resize.
 *
 * Only the WIDTH is measured. `--wb-control-size` is never written from here (#564): the footer's own
 * controls size from that variable, so writing the footer's height into it pinned the phone's 44px
 * after the window widened. The size follows the layout instead, in CSS: 2rem by default and 44px at
 * `max-[721px]` (`whiteboard-theme.ts` on the board root, `whiteboard-controls.tsx` on the chrome layer).
 */
export function useFooterMetrics(rootRef: RefObject<HTMLElement | null>, footer: HTMLElement | null) {
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || !footer) return
    const measure = () => {
      root.style.setProperty("--wb-footer-width", `${footer.offsetWidth}px`)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(footer)
    return () => observer.disconnect()
  }, [rootRef, footer])
}
