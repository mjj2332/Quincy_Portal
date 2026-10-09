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

/** The width of one marker, in px: markers closer than this on the lane merge into a cluster. */
export const MARKER_WIDTH_PX = 12;

type Placed = { id: string; startFrame: number; endFrame: number | null; /** Ties between markers on the same frame go to the oldest note. */ createdAt?: string };
/** Earliest frame first, then the oldest note, then id (so the order is the same however the list was sorted). */
const byPosition = (a: Placed, b: Placed) => a.startFrame - b.startFrame || (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id);

/**
 * Groups markers that would overlap at this lane width (#741 5b resize clustering). A marker joins the cluster it is within one marker width
 * of (measured from the cluster's first, earliest, marker); a lane not yet measured clusters nothing. The cluster stands at its earliest frame
 * and its `id` is that note's, so pressing it seeks there; every member stays in `members`.
 */
export function clusterMarkers<T extends Placed>(markers: readonly T[], frameCount: number, width: number, thumbHalf: number): Array<{ id: string; first: T; members: T[] }> {
  const usable = Math.max(0, width - 2 * thumbHalf);
  const sorted = [...markers].sort(byPosition);
  const clusters: Array<{ id: string; first: T; members: T[] }> = [];
  for (const marker of sorted) {
    const last = clusters.at(-1);
    const near = last !== undefined && usable > 0 && usable * (frameFraction(marker.startFrame, frameCount) - frameFraction(last.first.startFrame, frameCount)) < MARKER_WIDTH_PX;
    if (near) last.members.push(marker);
    else clusters.push({ id: marker.id, first: marker, members: [marker] });
  }
  return clusters;
}

/**
 * The marker a pointer at `x` (px from the lane's left edge) is on or nearest to, within `reach`, else null. A marker sits at its
 * thumb-centre coordinate, `thumbHalf + (width - 2 * thumbHalf) * fraction`; a range is the stretch between its start and its last frame.
 */
export function nearestMarkerId(markers: ReadonlyArray<Placed>, frameCount: number, x: number, width: number, thumbHalf: number, reach = MARKER_REACH_PX): string | null {
  const usable = Math.max(0, width - 2 * thumbHalf);
  let best: { marker: Placed; distance: number } | null = null;
  for (const marker of markers) {
    const [from, to] = marker.endFrame === null ? [frameFraction(marker.startFrame, frameCount), frameFraction(marker.startFrame, frameCount)] : spanFractions(marker.startFrame, marker.endFrame, frameCount);
    const left = thumbHalf + usable * from; const right = thumbHalf + usable * to;
    const distance = x < left ? left - x : x > right ? x - right : 0;
    // Equally near (to the pixel's rounding): the earliest frame, then the oldest note, whatever order the list came in.
    if (distance <= reach && (best === null || distance < best.distance - 1e-6 || (Math.abs(distance - best.distance) <= 1e-6 && byPosition(marker, best.marker) < 0))) best = { marker, distance };
  }
  return best?.marker.id ?? null;
}
