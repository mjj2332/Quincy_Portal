// Quincy-owned positioning for the table bar (#535). Pure (no React, no Tiptap) so the boundary maths is
// tested without a browser. The bar's flip and shift share ONE boundary rectangle, chosen per positioning pass
// by `tableBubbleZone`: the clean zone (between the neighbouring blocks, so the bar covers table rows at most)
// when the bar fits above or below the active ROW there, else the wide zone (the surface top down to the
// helper line), so the bar can still cross the frame's bottom border but never reach the helper line.
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

export type TableBubbleTier = "clean" | "wide"

const finite = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value)

/**
 * The vertical limits of the bar's FINAL position (flip/shift padding 8 and the offset 8 cancel, so the
 * boundary's edges are the bar's own). Two tiers, decided from fresh geometry on every pass so the answer
 * never depends on which placement floating-ui is currently trying:
 * - clean: below the previous block and above the next one, so the bar covers table rows at most, never a
 *   neighbouring block. Used whenever the bar fits above OR below the row inside it.
 * - wide: the surface top down to the helper line (the #535 rule), when the clean zone fits neither side.
 * The fit tests use the un-offset rects; the visualViewport offset is added to the rect afterwards.
 */
export function tableBubbleZone({
  row,
  barHeight,
  surface,
  prevBottom,
  nextTop,
  floorTop,
  viewport,
}: ZoneInput): { top: number; bottom: number; tier: TableBubbleTier } {
  const floorWide = finite(floorTop) ? Math.max(surface.bottom, floorTop - TABLE_BUBBLE_FLOOR_INSET) : surface.bottom
  const ceilClean = finite(prevBottom) ? Math.max(surface.top, prevBottom) : surface.top
  const floorClean = finite(nextTop) ? Math.min(floorWide, nextTop) : floorWide

  const fitsTop = row.top - TABLE_BUBBLE_GAP - barHeight >= Math.max(ceilClean, viewport.top)
  const fitsBottom = row.bottom + TABLE_BUBBLE_GAP + barHeight <= Math.min(floorClean, viewport.bottom)

  return fitsTop || fitsBottom
    ? { top: ceilClean, bottom: floorClean, tier: "clean" }
    : { top: surface.top, bottom: floorWide, tier: "wide" }
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
}

const documentViewport = () => ({ top: 0, bottom: document.documentElement.clientHeight })

/**
 * BubbleMenu `options` for the table bar. flip and shift take derivable options, so the boundary is rebuilt
 * on every positioning pass from fresh rects and the bar's real height (no scroll offsets: all rects are
 * client coordinates).
 */
export function tableBubbleOptions({
  surface,
  floorTop,
  neighbours,
  row,
  viewport = documentViewport,
  visualOffset,
}: TableBubbleOptionsInput) {
  const boundary = (state: FloatingState) => {
    const surfaceRect = surface()
    const { top, bottom } = tableBubbleZone({
      row: row(),
      barHeight: state.rects.floating.height,
      surface: surfaceRect,
      ...neighbours(),
      floorTop: floorTop(),
      viewport: viewport(),
    })

    // Zone edges are already the limits; `tableBubbleBoundary` only adds the visual offset and the rect fields.
    return tableBubbleBoundary(
      { top, bottom, left: surfaceRect.left, right: surfaceRect.right },
      null,
      visualOffset?.()
    )
  }

  return {
    placement: "top-start" as const,
    offset: TABLE_BUBBLE_GAP,
    flip: (state: FloatingState) => ({
      fallbackPlacements: ["bottom-start" as const],
      // When even the zone fails, keep top-start (shift then clamps) rather than clamping the bar
      // onto the row from below.
      fallbackStrategy: "initialPlacement" as const,
      boundary: boundary(state),
      padding: TABLE_BUBBLE_GAP,
    }),
    shift: (state: FloatingState) => ({
      boundary: boundary(state),
      padding: TABLE_BUBBLE_GAP,
      crossAxis: true,
    }),
  }
}
