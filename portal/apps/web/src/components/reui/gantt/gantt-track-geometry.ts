/**
 * #726 (PR1 of #722): the one place the Gantt's horizontal track geometry is computed.
 * #727 (PR2): the tree is a sticky column inside the scroller, so the visible track is the client
 * width minus the tree's width; `scrollerGeometry` measures that inset from the tree column itself.
 */

/** The Gantt's scroll viewport (the pane that scrolls the timeline). */
export const GANTT_SCROLLER_SELECTOR = "[data-gantt-scroller]"

export function findScroller(root: ParentNode | null | undefined): HTMLElement | null {
  return root?.querySelector<HTMLElement>(GANTT_SCROLLER_SELECTOR) ?? null
}

export interface TrackGeometry {
  /** Distance scrolled from the inline-start edge (RTL's negative scrollLeft is folded to positive). */
  start: number
  /** Width of the visible track: client width minus the tree inset. */
  visibleWidth: number
  /** Width of the whole track: scroll width minus the tree inset. */
  trackWidth: number
}

/** The inset is subtracted from the widths only, never from `start` (scrollLeft is unaffected by it). */
export function trackGeometry(scroller: HTMLElement, inset = 0): TrackGeometry {
  return {
    start: Math.abs(scroller.scrollLeft),
    visibleWidth: scroller.clientWidth - inset,
    trackWidth: scroller.scrollWidth - inset,
  }
}

/** The sticky tree column inside the scroller (marked by `data-gantt-tree-column`). */
const GANTT_TREE_COLUMN_SELECTOR = "[data-gantt-tree-column]"

/** Measured width of the tree column covering the scroller's inline start (0 when absent or unlaid). */
export function treeInset(scroller: HTMLElement): number {
  return scroller.querySelector<HTMLElement>(GANTT_TREE_COLUMN_SELECTOR)?.getBoundingClientRect().width ?? 0
}

/** `trackGeometry` with the live tree inset: what every Gantt consumer should call. */
export function scrollerGeometry(scroller: HTMLElement): TrackGeometry {
  return trackGeometry(scroller, treeInset(scroller))
}
