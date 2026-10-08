/**
 * #726 (PR1 of #722): the one place the Gantt's horizontal track geometry is computed.
 * #727 (PR2): the tree is a sticky column inside the scroller, so the visible track is the client
 * width minus the tree's width; `scrollerGeometry` takes that inset from `--gantt-tree-inset`, the width the column is given.
 */

/** Height of the sticky two-row header (the tree's and the timeline's alike): 64px of rows plus the 1px rule. */
export const GANTT_HEADER_PX = 65

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
export const GANTT_TREE_COLUMN_SELECTOR = "[data-gantt-tree-column]"

/** The custom property that is the one source of the tree column's width (set on the Gantt body, inherited by the scroller). */
export const GANTT_TREE_INSET_VAR = "--gantt-tree-inset"

/**
 * The tree column's width, read from the same number that sizes it (`--gantt-tree-inset`, the clamped
 * or live-dragged width) rather than from `getBoundingClientRect()`, so a sub-pixel layout rect can
 * never disagree with the width the column was given. 0 when the variable is absent or not in px.
 */
export function treeInset(scroller: HTMLElement): number {
  // The variable is only ever written inline on the Gantt body (render, then the splitter drag), so
  // walk up the inline styles: no style recalculation, and the live drag value is always current.
  let raw = ""
  for (let el: HTMLElement | null = scroller; el && !raw; el = el.parentElement) {
    raw = el.style.getPropertyValue(GANTT_TREE_INSET_VAR).trim()
  }
  const px = raw.endsWith("px") ? Number.parseFloat(raw) : Number.NaN
  return Number.isFinite(px) && px > 0 ? px : 0
}

/** `trackGeometry` with the live tree inset: what every Gantt consumer should call. */
export function scrollerGeometry(scroller: HTMLElement): TrackGeometry {
  return trackGeometry(scroller, treeInset(scroller))
}

/** Sub-pixel slack kept from the original chip test: a bar edge within 2px of the lane edge still counts as past it. */
const OFFSCREEN_SLACK_PX = 2

/** The PAINTED extent of one Gantt row in track pixels: the union of its bar wrapper(s) and external label(s). */
export interface RowExtentPx {
  /** Inline-start edge of whatever the row paints. */
  startPx: number
  /** Inline-end edge of whatever the row paints. */
  endPx: number
}

/**
 * #734: which edge chip a row earns. Everything the row paints (bar wrapper AND external label, which can extend past
 * the temporal bounds for a minimum-width bar or a centred milestone) must have left the visible lane
 * (`visibleStart`..`visibleEnd`), so a chip never covers anything still readable. Callers pass the painted extent.
 */
export function offscreenSide(
  row: RowExtentPx,
  visibleStart: number,
  visibleEnd: number
): "start" | "end" | null {
  if (row.endPx <= visibleStart + OFFSCREEN_SLACK_PX) return "start"
  if (row.startPx >= visibleEnd - OFFSCREEN_SLACK_PX) return "end"
  return null
}
