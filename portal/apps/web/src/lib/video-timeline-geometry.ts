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
