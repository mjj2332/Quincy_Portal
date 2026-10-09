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

/**
 * The width a cluster is drawn at, in px (the renderer sets it and clustering measures with it): one note is a 12px marker; a pill is at least
 * 16px, one digit of mono text is 7px, the padding is 8px, and an internal note adds its 6px diamond, a 2px gap and the 2px edge.
 */
export function clusterWidthPx(members: ReadonlyArray<{ tone?: string }>): number {
  if (members.length <= 1) return MARKER_WIDTH_PX;
  const internal = members.some((member) => member.tone === "internal");
  return Math.max(16, String(members.length).length * 7 + 8 + (internal ? 10 : 0));
}
/** The clear space kept between two drawn markers. */
export const MARKER_GAP_PX = 2;

type Placed = { id: string; startFrame: number; endFrame: number | null; /** "internal" widens a cluster pill (its diamond). */ tone?: string; /** Ties between markers on the same frame go to the oldest note. */ createdAt?: string };
type Target = Placed & { /** Drawn as a point (a dot, a diamond or a cluster), not a bar. */ point?: boolean };
/** Earliest frame first, then the oldest note, then id (so the order is the same however the list was sorted). */
const byPosition = (a: Placed, b: Placed) => a.startFrame - b.startFrame || (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id);

/**
 * Groups markers that would overlap at this lane width (#741 5b resize clustering). Neighbouring clusters merge while the distance between their
 * drawn centres is less than half the sum of their drawn widths (`clusterWidthPx`: a pill is wider than a dot, and wider still with a two-digit
 * count or the internal diamond) plus a small gap; merging widens the pill, so it repeats until stable. A lane not yet measured clusters nothing.
 * A cluster stands at its earliest frame and its `id` is that note's, so pressing it seeks there; every member stays in `members`.
 */
export function clusterMarkers<T extends Placed>(markers: readonly T[], frameCount: number, width: number, thumbHalf: number): Array<{ id: string; first: T; members: T[] }> {
  const usable = Math.max(0, width - 2 * thumbHalf);
  let clusters: Array<{ id: string; first: T; members: T[] }> = [...markers].sort(byPosition).map((marker) => ({ id: marker.id, first: marker, members: [marker] }));
  if (usable <= 0) return clusters;
  const centre = (cluster: { first: T }) => usable * frameFraction(cluster.first.startFrame, frameCount);
  for (let merged = true; merged;) {
    merged = false;
    const next: typeof clusters = [];
    for (const cluster of clusters) {
      const last = next.at(-1);
      if (last !== undefined && centre(cluster) - centre(last) < (clusterWidthPx(last.members) + clusterWidthPx(cluster.members)) / 2 + MARKER_GAP_PX) { last.members.push(...cluster.members); merged = true; }
      else next.push({ ...cluster, members: [...cluster.members] });
    }
    clusters = next;
  }
  return clusters;
}

/**
 * What a press can land on, taken from the clusters as drawn: a multi-member cluster is a point at its rendered position (its first member's
 * start), its members' spans are not hittable; a single marker keeps its own geometry, a range through its last included frame.
 */
export function markerHitTargets<T extends Placed>(clusters: ReadonlyArray<{ first: T; members: readonly T[] }>): Target[] {
  return clusters.map(({ first, members }) => (members.length > 1 ? { id: first.id, startFrame: first.startFrame, endFrame: null, ...(first.createdAt !== undefined ? { createdAt: first.createdAt } : {}), point: true } : { ...first, point: first.endFrame === null }));
}

/**
 * The marker a pointer at `x` (px from the lane's left edge) is on or nearest to, within `reach`, else null. A marker sits at its
 * thumb-centre coordinate, `thumbHalf + (width - 2 * thumbHalf) * fraction`; a range is the stretch between its start and its last frame.
 */
export function nearestMarkerId(markers: ReadonlyArray<Target>, frameCount: number, x: number, width: number, thumbHalf: number, reach = MARKER_REACH_PX): string | null {
  const usable = Math.max(0, width - 2 * thumbHalf);
  let best: { marker: Target; distance: number } | null = null;
  for (const marker of markers) {
    const [from, to] = marker.endFrame === null ? [frameFraction(marker.startFrame, frameCount), frameFraction(marker.startFrame, frameCount)] : spanFractions(marker.startFrame, marker.endFrame, frameCount);
    const left = thumbHalf + usable * from; const right = thumbHalf + usable * to;
    const distance = x < left ? left - x : x > right ? x - right : 0;
    // Equally near (to the pixel's rounding): a point beats the inside of a bar drawn under it, then the earliest frame, then the oldest note, whatever order the list came in.
    const tied = best !== null && Math.abs(distance - best.distance) <= 1e-6;
    const gain = best === null ? 0 : Number(marker.point ?? marker.endFrame === null) - Number(best.marker.point ?? best.marker.endFrame === null);
    if (distance <= reach && (best === null || distance < best.distance - 1e-6 || (tied && (gain > 0 || (gain === 0 && byPosition(marker, best.marker) < 0))))) best = { marker, distance };
  }
  return best?.marker.id ?? null;
}
