/**
 * The phone review sheet's geometry (#879), pure and DOM-free. #881 adds the desktop rail's width clamp here.
 * Velocity is positive when the sheet grows (the finger moves up).
 */
export const PHONE_QUERY = "(width < 721px)";
export const FLICK_PX_PER_MS = 0.5;
export const FILM_FLOOR = 200;
const FILM_SHARE = 0.65;

export type SheetStop = "collapsed" | "half" | "full";
export type SheetStops = Record<SheetStop, number>;

export function sheetStops({ available, collapsed, filmAspect, width, transport }: { available: number; collapsed: number; filmAspect: number; width: number; transport: number }): SheetStops {
  const cap = Math.round(FILM_SHARE * available);
  const film = filmAspect < 1 ? cap : Math.min(cap, Math.round(width / filmAspect + transport));
  const full = Math.max(0, available - FILM_FLOOR);
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
