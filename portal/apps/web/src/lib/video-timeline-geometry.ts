/**
 * Where a frame sits along the scrubber, as a 0..1 fraction of the track (#741 5b). The slider's own `max` is `max(1, lastFrame)`
 * (VideoPlayer), so frame 0 is 0, the last frame is 1, and a one-frame film divides by 1, not 0. The CSS maps the fraction onto the
 * thumb-centre coordinate system (components/quincy/VideoTimelineMarkers).
 */
export function frameFraction(frame: number, frameCount: number): number {
  const last = Math.max(1, frameCount - 1);
  return Math.min(1, Math.max(0, frame / last));
}

/** A note's span as `[start, end]` fractions: the end is the last INCLUDED frame (`endExclusive - 1`), clamped to the last frame. */
export function spanFractions(startFrame: number, endExclusive: number, frameCount: number): [number, number] {
  const lastFrame = Math.max(0, frameCount - 1);
  return [frameFraction(startFrame, frameCount), frameFraction(Math.min(endExclusive - 1, lastFrame), frameCount)];
}

/** How far from a marker, in px, a pointer still picks it. */
export const MARKER_REACH_PX = 8;

/**
 * The marker a pointer at `x` (px from the lane's left edge) is on or nearest to, within `reach`, else null. A marker sits at its
 * thumb-centre coordinate, `thumbHalf + (width - 2 * thumbHalf) * fraction`; a range is the stretch between its start and its last frame.
 */
export function nearestMarkerId(markers: ReadonlyArray<{ id: string; startFrame: number; endFrame: number | null }>, frameCount: number, x: number, width: number, thumbHalf: number, reach = MARKER_REACH_PX): string | null {
  const usable = Math.max(0, width - 2 * thumbHalf);
  let best: { id: string; distance: number } | null = null;
  for (const marker of markers) {
    const [from, to] = marker.endFrame === null ? [frameFraction(marker.startFrame, frameCount), frameFraction(marker.startFrame, frameCount)] : spanFractions(marker.startFrame, marker.endFrame, frameCount);
    const left = thumbHalf + usable * from; const right = thumbHalf + usable * to;
    const distance = x < left ? left - x : x > right ? x - right : 0;
    if (distance <= reach && (best === null || distance < best.distance)) best = { id: marker.id, distance };
  }
  return best?.id ?? null;
}
