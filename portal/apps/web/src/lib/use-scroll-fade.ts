import { useLayoutEffect, useState, type RefObject } from "react"

export type ScrollFade = "none" | "start" | "end" | "both"

/** The mask fades the outer 15% of the scroller (the `black_85%` / `black_15%` stops below). */
export const SCROLL_FADE_EDGE_FRACTION = 0.15

/**
 * Edge mask for a horizontal scroller, keyed on `data-fade`: only the side that has more content fades, so a scroller
 * resting at its end does not fade its last item. Browsers that hide scrollbars (macOS) give no other cue that a
 * strip scrolls.
 */
export const SCROLL_FADE_MASK_CLASSES =
  "data-[fade=end]:[mask-image:linear-gradient(to_right,black_85%,transparent)] data-[fade=start]:[mask-image:linear-gradient(to_left,black_85%,transparent)] data-[fade=both]:[mask-image:linear-gradient(to_right,transparent,black_15%,black_85%,transparent)]"

/**
 * Tracks which sides of a horizontal scroller have more content. Re-measures after every render (children come and go),
 * on resize, and on scroll (`onScroll`); setState bails out on an equal value. Spread `{ "data-fade": fade, onScroll }`
 * on the scroller and add `SCROLL_FADE_MASK_CLASSES`.
 */
export function useScrollFade(ref: RefObject<HTMLElement | null>) {
  const [fade, setFade] = useState<ScrollFade>("none")

  function measure() {
    const el = ref.current
    if (!el) return
    const start = el.scrollLeft > 1
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setFade(start && end ? "both" : start ? "start" : end ? "end" : "none")
  }

  useLayoutEffect(() => {
    measure()
  })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { fade, onScroll: measure }
}
