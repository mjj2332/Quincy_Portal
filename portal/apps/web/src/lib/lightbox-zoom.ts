export type ZoomTransform = { scale: number; panX: number; panY: number };
export type ZoomBounds = { viewportWidth: number; viewportHeight: number; imageWidth: number; imageHeight: number };

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export const ZOOM_STEP = 0.25;
export const initialZoom = (): ZoomTransform => ({ scale: MIN_ZOOM, panX: 0, panY: 0 });

function panLimit(scale: number, image: number, viewport: number) {
  if (!Number.isFinite(image) || !Number.isFinite(viewport) || image <= 0 || viewport <= 0) return (scale - 1) / 2;
  return Math.max(0, (image * scale - viewport) / (2 * image));
}

export function clampZoom(transform: ZoomTransform, bounds?: ZoomBounds): ZoomTransform {
  const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, transform.scale));
  if (scale === MIN_ZOOM) return initialZoom();
  const maxPanX = bounds ? panLimit(scale, bounds.imageWidth, bounds.viewportWidth) : (scale - 1) / 2;
  const maxPanY = bounds ? panLimit(scale, bounds.imageHeight, bounds.viewportHeight) : (scale - 1) / 2;
  const bounded = (value: number, limit: number) => { const result = Math.min(limit, Math.max(-limit, value)); return Object.is(result, -0) ? 0 : result; };
  return { scale, panX: bounded(transform.panX, maxPanX), panY: bounded(transform.panY, maxPanY) };
}

export function zoomBy(transform: ZoomTransform, delta: number, bounds?: ZoomBounds): ZoomTransform {
  return clampZoom({ ...transform, scale: transform.scale + delta }, bounds);
}

/** Deltas are fractions of the visible frame so RAW and Edited panes share one transform. */
export function panBy(transform: ZoomTransform, deltaX: number, deltaY: number, bounds?: ZoomBounds): ZoomTransform {
  return clampZoom({ ...transform, panX: transform.panX + deltaX, panY: transform.panY + deltaY }, bounds);
}
