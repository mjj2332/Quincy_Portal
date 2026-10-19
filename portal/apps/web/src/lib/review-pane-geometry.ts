/**
 * The review pane's geometry, pure and DOM-free: the phone sheet's stops (#879) and the desktop pane's width bounds and clamp (#881).
 * Velocity is positive when the sheet grows (the finger moves up). Guest-safe: it imports nothing.
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

/**
 * The sheet's three stops. `collapsed` is the measured bar (the grabber, the head and the composer: since #927 the two-row box at rest, P1), and the browse stops never cut it:
 * when the split is too short for the film's floor and the bar both, the film gives way, as it does for compose, and only the split itself bounds the bar.
 */
export function sheetStops({ available, collapsed, filmAspect, width, transport }: { available: number; collapsed: number; filmAspect: number; width: number; transport: number }): SheetStops {
  const cap = Math.round(FILM_SHARE * available);
  const film = filmAspect < 1 ? cap : Math.min(cap, Math.round(width / filmAspect + transport));
  const filmFloor = Math.max(FILM_FLOOR, PICTURE_MIN + STAGE_GAP + transport);
  const floor = Math.max(0, Math.min(collapsed, available));
  const full = Math.max(floor, available - filmFloor);
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

/** The desktop pane's width bounds (#881, prototype `RAIL_MIN` / `RAIL_MAX`, W1 drawn at 380). */
export const PANE_MIN = 300;
export const PANE_DEFAULT = 380;
export const PANE_MAX = 560;
/** The player always keeps at least this much of the row. */
export const PLAYER_MIN = 480;
/** The widest viewport that counts as a tablet (D18: a tablet gets the desktop layout; in portrait the pane starts collapsed). */
export const TABLET_MAX = 1366;

/** The widest the pane may be in a row `hostWidth` wide: 560, or what leaves the player 480, never below the minimum. An unmeasured row (0) allows the full 560. */
export function paneCeiling(hostWidth: number): number {
  if (!(hostWidth > 0)) return PANE_MAX;
  return Math.max(PANE_MIN, Math.min(PANE_MAX, Math.floor(hostWidth - PLAYER_MIN)));
}

/** The width to draw: the preference clamped to the room the row has. The preference itself is never rewritten by it (a narrow window keeps a wide choice). */
export const clampPaneWidth = (width: number, hostWidth: number): number => Math.min(paneCeiling(hostWidth), Math.max(PANE_MIN, Math.round(width)));

/** Whether the pane is open (D18): a remembered choice always wins; with none (`null`) a portrait tablet starts collapsed and every other desktop width open. */
export const resolvePaneOpen = (remembered: boolean | null, portraitTablet: boolean): boolean => remembered ?? !portraitTablet;
