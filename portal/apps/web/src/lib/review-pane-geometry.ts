/**
 * The phone review sheet's geometry (#879), pure and DOM-free. #881 adds the desktop rail's width clamp here.
 * Velocity is positive when the sheet grows (the finger moves up).
 */
export const PHONE_QUERY = "(width < 721px)";
export const FLICK_PX_PER_MS = 0.5;
export const FILM_FLOOR = 200;
const FILM_SHARE = 0.65;
/** The shortest picture the full stop may leave (#879): the film area at full is this plus the measured transport and the gap between them, never less than `FILM_FLOOR`. */
export const PICTURE_MIN = 110;
/** The phone player draws the transport flush under the picture (#879 PR 3a, P1: no gap between the film and the ControlBar). */
const STAGE_GAP = 0;

export type SheetStop = "collapsed" | "half" | "full";
export type SheetStops = Record<SheetStop, number>;

export function sheetStops({ available, collapsed, filmAspect, width, transport }: { available: number; collapsed: number; filmAspect: number; width: number; transport: number }): SheetStops {
  const cap = Math.round(FILM_SHARE * available);
  const film = filmAspect < 1 ? cap : Math.min(cap, Math.round(width / filmAspect + transport));
  const filmFloor = Math.max(FILM_FLOOR, PICTURE_MIN + STAGE_GAP + transport);
  const full = Math.max(0, available - filmFloor);
  const floor = Math.min(collapsed, full);
  const half = Math.min(full, Math.max(floor, available - film));
  return { collapsed: floor, half, full };
}

const ORDER: SheetStop[] = ["collapsed", "half", "full"];

export function settleSheet({ stops, height, velocity }: { stops: SheetStops; height: number; velocity: number }): SheetStop {
  if (Math.abs(velocity) >= FLICK_PX_PER_MS) {
    if (velocity > 0) return ORDER.find((s) => stops[s] > height) ?? "full";
    return [...ORDER].reverse().find((s) => stops[s] < height) ?? "collapsed";
  }
  return ORDER.reduce((best, s) => (Math.abs(stops[s] - height) < Math.abs(stops[best] - height) ? s : best), "collapsed" as SheetStop);
}

/** The release velocity in px/ms, positive when the sheet grows (the finger moves up): from the last move sample to the release sample, so a pause before lifting is a slow release. */
export function releaseVelocity(from: { y: number; t: number }, to: { y: number; t: number }): number {
  const elapsed = to.t - from.t;
  return elapsed > 0 ? (from.y - to.y) / elapsed : 0;
}
