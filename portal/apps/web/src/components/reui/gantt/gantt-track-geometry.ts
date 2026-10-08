/**
 * #726 (PR1 of #722): the one place the Gantt's horizontal track geometry is computed. The tree
 * inset is 0 today (the tree is a sibling pane); #722 PR2 moves the tree into the scroller as a
 * sticky column and passes its width here, so every consumer already reads through this helper.
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
