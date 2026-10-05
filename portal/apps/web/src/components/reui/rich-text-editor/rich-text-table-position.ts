// Quincy-owned positioning for the table bar (#535). Pure (no React, no Tiptap) so the boundary maths is
// tested without a browser. The bar's flip and shift share ONE boundary rectangle, chosen per positioning pass
// by `tableBubbleZone`: between the neighbouring blocks (and above the helper line), so the bar NEVER covers a
// neighbouring block or the active row. There is no wide tier: when the bar fits neither above nor below the
// row it takes the tighter side with a gap under 8px ("tight"), then the blocks' room ignoring the viewport
// ("offscreen": partly scrolled out, never clamped onto the row), and with no room at all the tier is "none"
// and the host shows the table controls in the formatting toolbar instead.
// The bar's own height comes from floating-ui's state, never a constant.

export const TABLE_BUBBLE_GAP = 8

/**
 * Tiptap 3.30.2 orders the middleware flip -> shift -> offset, so flip and shift judge the bar BEFORE the
 * 8px offset is applied. The floor therefore sits one gap above the helper, so that the bar's final
 * bottom edge (after the offset) is at most `helperTop - 8`.
 */
export const TABLE_BUBBLE_FLOOR_INSET = TABLE_BUBBLE_GAP

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
 * The ONE rect the bar anchors to and the zone is judged against: vertically the union of the row and the active
 * cell (a rowspan cell reaches past its row's rect), horizontally the cell. Anchoring to the cell while judging
 * the row let floating-ui and the zone disagree about which side fits.
 */
export function tableBubbleAnchor(row: RectLike, cell: RectLike): RectLike {
  return {
    top: Math.min(row.top, cell.top),
    bottom: Math.max(row.bottom, cell.bottom),
    left: cell.left,
    right: cell.right,
  }
}

export interface VisualOffset {
  x: number
  y: number
}

/**
 * The boundary rect: the editable surface, extended down to `floorBottom` when that is below the surface's
 * bottom. Never shrinks the surface. Fields are copied explicitly because DOMRect exposes getters on its
 * prototype, so a spread would lose them. `visualOffset` compensates floating-ui, which subtracts the
 * visualViewport offset from Rect boundaries (WebKit only) but not from an absolutely positioned anchor.
 */
export function tableBubbleBoundary(
  surface: RectLike,
  floorBottom: number | null,
  visualOffset: VisualOffset = { x: 0, y: 0 }
): BoundaryRect {
  const top = surface.top
  const left = surface.left
  const right = surface.right
  const bottom =
    floorBottom !== null && Number.isFinite(floorBottom)
      ? Math.max(surface.bottom, floorBottom)
      : surface.bottom

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

interface FloorElement {
  isConnected: boolean
  getBoundingClientRect: () => RectLike & { width: number; height: number }
}

/**
 * The top edge of the first rendered element below the editor frame: pass the candidates in any order (the
 * character counter, the host's helper line) and the highest usable one wins. Absent, detached, hidden,
 * zero-size or non-finite candidates are skipped; null when none is usable, so the surface stays the boundary.
 */
export function readFloorTop(...elements: Array<FloorElement | null | undefined>): number | null {
  let floor: number | null = null

  for (const element of elements) {
    if (!element || !element.isConnected) continue

    const rect = element.getBoundingClientRect()

    if (![rect.top, rect.bottom, rect.width, rect.height].every(Number.isFinite)) continue
    if (rect.width <= 0 || rect.height <= 0) continue

    floor = floor === null ? rect.top : Math.min(floor, rect.top)
  }

  return floor
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
  /** The WHOLE active row (every cell), not the cell: the bar must never cover the row it edits. */
  row: RectLike
  /** The bar's real height, from floating-ui's `state.rects.floating.height`. */
  barHeight: number
  /** The editable surface (`editor.view.dom`). */
  surface: RectLike
  /** Bottom of the block before the table, top of the block after it (null at the document's edges). */
  prevBottom: number | null
  nextTop: number | null
  /** The raw top of the first element below the frame (counter, helper); one gap is taken off here. */
  floorTop: number | null
  /** Client-coordinate viewport edges. */
  viewport: { top: number; bottom: number }
}

/**
 * - clean: the bar fits above or below the row with the full 8px gap, inside the viewport.
 * - tight: it fits on the roomier side with a gap under 8px (never under EPS of clearance).
 * - offscreen: the viewport cuts the room, but the blocks around the row allow it (bar partly scrolled out).
 * - none: no side fits anywhere; the host shows the controls in the toolbar.
 */
export type TableBubbleTier = "clean" | "tight" | "offscreen" | "none"

/** Clearance kept between a tight bar and the block or row it nearly touches. */
export const TABLE_BUBBLE_EPS = 0.5

export interface TableBubbleZone {
  /** Boundary edges: the previous block's bottom (or the surface top) and the next block's top / the helper. */
  top: number
  bottom: number
  tier: TableBubbleTier
  /** The gap between the bar and the row: 8, or less in the tight tier. Both the offset and the padding. */
  gap: number
  /** The root boundary floating-ui intersects the rect with: the viewport, or the document for "offscreen". */
  root: "viewport" | "document"
}

const finite = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value)

/** One side's choice for rooms above and below the row: the full gap, else the roomier side tight, else null. */
function pick(roomTop: number, roomBottom: number, barHeight: number): { side: "top" | "bottom"; gap: number } | null {
  const full = barHeight + TABLE_BUBBLE_GAP

  if (roomTop >= full) return { side: "top", gap: TABLE_BUBBLE_GAP }
  if (roomBottom >= full) return { side: "bottom", gap: TABLE_BUBBLE_GAP }

  const room = Math.max(roomTop, roomBottom)

  if (room - barHeight < TABLE_BUBBLE_EPS) return null

  return { side: roomTop >= roomBottom ? "top" : "bottom", gap: room - barHeight - TABLE_BUBBLE_EPS }
}

/**
 * The vertical limits of the bar's FINAL position (flip/shift padding and the offset are the same gap, so the
 * boundary's edges are the bar's own). Decided from fresh geometry on every pass, so the answer never depends
 * on which placement floating-ui is currently trying. The fit tests use the un-offset rects; the
 * visualViewport offset is added to the rect afterwards.
 */
export function tableBubbleZone({
  row,
  barHeight,
  surface,
  prevBottom,
  nextTop,
  floorTop,
  viewport,
}: ZoneInput): TableBubbleZone {
  const floorWide = finite(floorTop) ? Math.max(surface.bottom, floorTop - TABLE_BUBBLE_FLOOR_INSET) : surface.bottom
  const ceil = finite(prevBottom) ? Math.max(surface.top, prevBottom) : surface.top
  const floor = finite(nextTop) ? Math.min(floorWide, nextTop) : floorWide
  const zone = { top: ceil, bottom: floor }

  // An unmeasured bar (hidden, not laid out yet) cannot be judged: keep the bar rather than flicker the toolbar.
  if (!(barHeight > 0)) return { ...zone, tier: "clean", gap: TABLE_BUBBLE_GAP, root: "viewport" }

  const visible = pick(
    row.top - Math.max(ceil, viewport.top),
    Math.min(floor, viewport.bottom) - row.bottom,
    barHeight
  )

  if (visible) {
    return { ...zone, tier: visible.gap === TABLE_BUBBLE_GAP ? "clean" : "tight", gap: visible.gap, root: "viewport" }
  }

  const blocks = pick(row.top - ceil, floor - row.bottom, barHeight)

  return blocks
    ? { ...zone, tier: "offscreen", gap: blocks.gap, root: "document" }
    : { ...zone, tier: "none", gap: TABLE_BUBBLE_GAP, root: "viewport" }
}

/** The state floating-ui hands a derivable middleware option; only the bar's height is read. */
interface FloatingState {
  rects: { floating: { height: number } }
}

export interface TableBubbleOptionsInput {
  /** The editable surface (`editor.view.dom`). */
  surface: () => RectLike
  /** The helper line's top edge, or null to keep the surface as the boundary. */
  floorTop: () => number | null
  /** The blocks beside the table, re-read on every positioning pass. */
  neighbours: () => { prevBottom: number | null; nextTop: number | null }
  /** The whole active row. */
  row: () => RectLike
  /** Client-coordinate viewport edges; defaults to the document's client height. */
  viewport?: () => { top: number; bottom: number }
  visualOffset?: () => VisualOffset
  /** Fired when the tier CHANGES (not on every pass): "none" asks the host to show the toolbar group instead. */
  onTier?: (tier: TableBubbleTier) => void
}

const documentViewport = () => ({ top: 0, bottom: document.documentElement.clientHeight })

/**
 * BubbleMenu `options` for the table bar. offset, flip and shift take derivable options, so the zone is rebuilt
 * on every positioning pass from fresh rects and the bar's real height (no scroll offsets: all rects are
 * client coordinates). The same `gap` feeds the offset and the flip/shift padding, so the side flip judges is the
 * side the bar lands on, and a side that does not fit is never clamped onto the row.
 */
export function tableBubbleOptions({
  surface,
  floorTop,
  neighbours,
  row,
  viewport = documentViewport,
  visualOffset,
  onTier,
}: TableBubbleOptionsInput) {
  let lastTier: TableBubbleTier | null = null

  const zone = (state: FloatingState) => {
    const surfaceRect = surface()
    const result = tableBubbleZone({
      row: row(),
      barHeight: state.rects.floating.height,
      surface: surfaceRect,
      ...neighbours(),
      floorTop: floorTop(),
      viewport: viewport(),
    })

    if (result.tier !== lastTier) {
      lastTier = result.tier
      onTier?.(result.tier)
    }

    // Zone edges are already the limits; `tableBubbleBoundary` only adds the visual offset and the rect fields.
    const boundary = tableBubbleBoundary(
      { top: result.top, bottom: result.bottom, left: surfaceRect.left, right: surfaceRect.right },
      null,
      visualOffset?.()
    )

    return {
      boundary,
      gap: result.gap,
      rootBoundary: result.root,
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
      // (its far-side padding would nudge a bar that is already clear) or, on a side that does not fit, onto the row.
      return { boundary, rootBoundary, padding, crossAxis: false }
    },
  }
}
