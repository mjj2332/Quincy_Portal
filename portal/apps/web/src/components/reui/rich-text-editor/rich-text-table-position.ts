// Quincy-owned positioning for the table bar (#535). Pure (no React, no Tiptap) so the boundary maths is
// tested without a browser. The bar's flip and shift share ONE boundary rectangle that runs from the top of
// the editable surface down to the helper line (when the host has one), so the bar can drop below the
// active cell across the editor frame's bottom border but never onto the helper line.

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

/** The helper line's top edge, or null when it is absent, detached, hidden, zero-size or non-finite. */
export function readFloorTop(
  helper: { isConnected: boolean; getBoundingClientRect: () => RectLike & { width: number; height: number } } | null | undefined
): number | null {
  if (!helper || !helper.isConnected) return null

  const rect = helper.getBoundingClientRect()

  if (![rect.top, rect.bottom, rect.width, rect.height].every(Number.isFinite)) return null
  if (rect.width <= 0 || rect.height <= 0) return null

  return rect.top
}

/** floating-ui subtracts the visualViewport offset from Rect boundaries on WebKit only. */
export function readVisualOffset(win: Window = window): VisualOffset {
  const viewport = win.visualViewport
  const webkit =
    typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("-webkit-backdrop-filter", "none")

  if (!viewport || !webkit) return { x: 0, y: 0 }

  return { x: viewport.offsetLeft, y: viewport.offsetTop }
}

export interface TableBubbleOptionsInput {
  /** The editable surface (`editor.view.dom`). */
  surface: () => RectLike
  /** The helper line's top edge, or null to keep the surface as the boundary. */
  floorTop: () => number | null
  visualOffset?: () => VisualOffset
}

/**
 * BubbleMenu `options` for the table bar. flip and shift take derivable options, so the boundary is rebuilt
 * on every positioning pass from fresh rects (no scroll offsets: all rects are client coordinates).
 */
export function tableBubbleOptions({ surface, floorTop, visualOffset }: TableBubbleOptionsInput) {
  const boundary = () => {
    const top = floorTop()

    return tableBubbleBoundary(
      surface(),
      top === null ? null : top - TABLE_BUBBLE_FLOOR_INSET,
      visualOffset?.()
    )
  }

  return {
    placement: "top-start" as const,
    offset: TABLE_BUBBLE_GAP,
    flip: () => ({
      fallbackPlacements: ["bottom-start" as const],
      // When even the extended boundary fails, keep top-start (shift then clamps) rather than
      // clamping the bar onto the cell from below.
      fallbackStrategy: "initialPlacement" as const,
      boundary: boundary(),
      padding: TABLE_BUBBLE_GAP,
    }),
    shift: () => ({
      boundary: boundary(),
      padding: TABLE_BUBBLE_GAP,
      crossAxis: true,
    }),
  }
}
