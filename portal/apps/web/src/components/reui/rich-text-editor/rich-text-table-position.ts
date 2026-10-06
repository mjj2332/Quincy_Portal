// Quincy-owned positioning for the table bar (#535, #555). Pure (no React, no Tiptap) so the boundary maths is
// tested without a browser. The bar DOCKS to the table's outer edge: just above the whole table, else just below
// it, never over a cell. Its flip and shift share ONE boundary rectangle, chosen per positioning pass by
// `tableBubbleZone`: the editor surface clipped to the visible viewport (below the sticky shell header). The
// neighbouring blocks do not bound it: the bar may float over the paragraph above or below the table while a cell
// is edited (owner decision 2026-10-06), but never leaves the surface, so the helper line stays visible. When
// neither side fits the tier is "none" and the host shows the table controls in the formatting toolbar instead.
// The bar's own height comes from floating-ui's state, never a constant.

import { shellChromeBottom } from "@/lib/shell-chrome"

export const TABLE_BUBBLE_GAP = 8

export interface BoundaryRect {
  x: number
  y: number
  width: number
  height: number
  top: number
  left: number
  right: number
  bottom: number
}

interface RectLike {
  top: number
  left: number
  right: number
  bottom: number
}

/**
 * The ONE rect the bar anchors to and the zone is judged against (#555): vertically the whole TABLE, so the bar
 * docks to the table's outer top or bottom edge and never covers any cell; horizontally the active cell's
 * column, clamped to the table's visible width. Anchoring and judging one rect keeps floating-ui and the zone
 * agreeing about which side fits.
 */
export function tableBubbleAnchor(table: RectLike, cell: RectLike): RectLike {
  const left = Math.min(Math.max(cell.left, table.left), table.right)
  const right = Math.max(Math.min(cell.right, table.right), left)

  return { top: table.top, bottom: table.bottom, left, right }
}

export interface VisualOffset {
  x: number
  y: number
}

/**
 * The boundary rect floating-ui judges the bar against: the zone's edges plus the horizontal limits. Fields are
 * copied explicitly because DOMRect exposes getters on its prototype, so a spread would lose them. `visualOffset`
 * compensates floating-ui, which subtracts the visualViewport offset from Rect boundaries (WebKit only) but not
 * from an absolutely positioned anchor.
 */
export function tableBubbleBoundary(surface: RectLike, visualOffset: VisualOffset = { x: 0, y: 0 }): BoundaryRect {
  const { top, left, right, bottom } = surface

  return {
    x: left + visualOffset.x,
    y: top + visualOffset.y,
    width: right - left,
    height: bottom - top,
    top: top + visualOffset.y,
    left: left + visualOffset.x,
    right: right + visualOffset.x,
    bottom: bottom + visualOffset.y,
  }
}

/** floating-ui subtracts the visualViewport offset from Rect boundaries on WebKit only. */
export function readVisualOffset(win: Window = window): VisualOffset {
  const viewport = win.visualViewport
  const webkit =
    typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("-webkit-backdrop-filter", "none")

  if (!viewport || !webkit) return { x: 0, y: 0 }

  return { x: viewport.offsetLeft, y: viewport.offsetTop }
}

export interface ZoneInput {
  /** The WHOLE table (`tableBubbleAnchor`): the no-go area. The bar docks above or below it, never over a cell. */
  row: RectLike
  /** The bar's real height, from floating-ui's `state.rects.floating.height`. */
  barHeight: number
  /** The editable surface (`editor.view.dom`): the bar never leaves it. */
  surface: RectLike
  /** Client-coordinate visible edges: the viewport, with `top` already below the sticky shell header. */
  viewport: { top: number; bottom: number }
}

/**
 * - clean: the bar fits above the table, else below it, with the full 8px gap, inside the surface and the visible
 *   viewport. It may float over the paragraph above or below the table (owner decision, #555).
 * - none: neither docked spot fits (or the tall table leaves both outside the viewport); the host shows the
 *   controls in the toolbar group instead.
 */
export type TableBubbleTier = "clean" | "none"

export interface TableBubbleZone {
  /** Boundary edges: the visible top of the surface and its visible bottom. They ARE the final bar's limits. */
  top: number
  bottom: number
  tier: TableBubbleTier
  /** The gap between the bar and the table: always 8. Both the offset and the padding. */
  gap: number
  /** The side the bar docks to; null when the tier is none. */
  side: "top" | "bottom" | null
}

/**
 * The vertical limits of the bar's FINAL position (flip/shift padding and the offset are the same gap, so the
 * boundary's edges are the bar's own). Decided from fresh geometry on every pass, so the answer never depends
 * on which placement floating-ui is currently trying. Room above = table top minus the higher of the surface top
 * and the visible viewport top; room below = the lower of the surface bottom and the viewport bottom minus the
 * table bottom. Neighbouring blocks do not bound it. The fit tests use the un-offset rects; the visualViewport
 * offset is added to the rect afterwards.
 */
export function tableBubbleZone({ row, barHeight, surface, viewport }: ZoneInput): TableBubbleZone {
  const top = Math.max(surface.top, viewport.top)
  const bottom = Math.min(surface.bottom, viewport.bottom)
  const zone = { top, bottom, gap: TABLE_BUBBLE_GAP }

  // An unmeasured bar (hidden, not laid out yet) cannot be judged: keep the bar rather than flicker the toolbar.
  if (!(barHeight > 0)) return { ...zone, tier: "clean", side: "top" }

  const full = barHeight + TABLE_BUBBLE_GAP

  // A docked bar must also land inside [top, bottom]: a table wholly scrolled below the visible area has "room
  // above" that is really off the bottom edge, and one wholly above it has "room below" off the top edge.
  if (row.top - top >= full && row.top - TABLE_BUBBLE_GAP <= bottom) return { ...zone, tier: "clean", side: "top" }
  if (bottom - row.bottom >= full && row.bottom + TABLE_BUBBLE_GAP >= top) return { ...zone, tier: "clean", side: "bottom" }

  return { ...zone, tier: "none", side: null }
}

/** The state floating-ui hands a derivable middleware option; only the bar's height is read. */
interface FloatingState {
  rects: { floating: { height: number } }
}

export interface TableBubbleOptionsInput {
  /** The editable surface (`editor.view.dom`). */
  surface: () => RectLike
  /** The whole table's rect (the anchor). */
  row: () => RectLike
  /** Client-coordinate visible edges (top below the sticky shell header); defaults to the document's client height. */
  viewport?: () => { top: number; bottom: number }
  visualOffset?: () => VisualOffset
  /** Fired when the tier CHANGES (not on every pass): "none" asks the host to show the toolbar group instead. */
  onTier?: (tier: TableBubbleTier) => void
}

const documentViewport = () => ({ top: shellChromeBottom(), bottom: document.documentElement.clientHeight })

/**
 * BubbleMenu `options` for the table bar. offset, flip and shift take derivable options, so the zone is rebuilt
 * on every positioning pass from fresh rects and the bar's real height (no scroll offsets: all rects are
 * client coordinates). The same `gap` feeds the offset and the flip/shift padding, so the side flip judges is the
 * side the bar lands on, and a side that does not fit is never clamped onto the table.
 */
export function tableBubbleOptions({ surface, row, viewport = documentViewport, visualOffset, onTier }: TableBubbleOptionsInput) {
  let lastTier: TableBubbleTier | null = null

  const zone = (state: FloatingState) => {
    const surfaceRect = surface()
    const result = tableBubbleZone({
      row: row(),
      barHeight: state.rects.floating.height,
      surface: surfaceRect,
      viewport: viewport(),
    })

    if (result.tier !== lastTier) {
      lastTier = result.tier
      onTier?.(result.tier)
    }

    // Zone edges are already the limits; `tableBubbleBoundary` only adds the visual offset and the rect fields.
    const boundary = tableBubbleBoundary(
      { top: result.top, bottom: result.bottom, left: surfaceRect.left, right: surfaceRect.right },
      visualOffset?.()
    )

    return {
      boundary,
      gap: result.gap,
      rootBoundary: "viewport" as const,
      padding: { top: result.gap, bottom: result.gap, left: TABLE_BUBBLE_GAP, right: TABLE_BUBBLE_GAP },
    }
  }

  return {
    placement: "top-start" as const,
    offset: (state: FloatingState) => zone(state).gap,
    flip: (state: FloatingState) => {
      const { boundary, rootBoundary, padding } = zone(state)

      return {
        fallbackPlacements: ["bottom-start" as const],
        fallbackStrategy: "bestFit" as const,
        boundary,
        rootBoundary,
        padding,
      }
    },
    shift: (state: FloatingState) => {
      const { boundary, rootBoundary, padding } = zone(state)

      // Horizontal only: flip already chose a side that fits, and a vertical shift would move the bar off its gap
      // (its far-side padding would nudge a bar that is already clear) or, on a side that does not fit, onto the table.
      return { boundary, rootBoundary, padding, crossAxis: false }
    },
  }
}
