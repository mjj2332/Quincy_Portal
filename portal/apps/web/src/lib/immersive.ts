/**
 * Full screen (immersive, #880), the pure rules. "Immersive" is the code name only; the person sees "Full screen" (D12).
 *
 * The screen owns `ImmersiveState`: null (out), "button" (entered by the Full screen button or F) or "turn" (a phone turned sideways, D14). It is held above the layout, so it survives
 * the 721px crossing a rotation makes. `rotate` is asked only when the orientation changes (and once when a viewer opens already sideways), never on a resize, so a keyboard rising in
 * portrait cannot enter it; minimising in landscape therefore stays out until the next turn.
 */
export type ImmersiveState = null | "button" | "turn";

/** The controls hide this long after playback starts, unless something holds them (D13). */
export const CHROME_HIDE_MS = 3000;

/** A phone is a device, not a width: a coarse pointer on a screen whose short side is under 600 (an 844px-wide landscape iPhone is a phone; an iPad in either hand is not). */
export function isPhoneDevice({ coarse, screenWidth, screenHeight }: { coarse: boolean; screenWidth: number; screenHeight: number }): boolean {
  return coarse && Math.min(screenWidth, screenHeight) < 600;
}

/** What the browser says about this device right now. */
export function readPhoneDevice(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return isPhoneDevice({ coarse: window.matchMedia("(pointer: coarse)").matches, screenWidth: window.screen?.width ?? Infinity, screenHeight: window.screen?.height ?? Infinity });
}

/** The state after the device turned (landscape true = now sideways). A phone turning to landscape enters as a turn; a turn leaves when it comes back upright; a button entry stays (D14). */
export function rotate(state: ImmersiveState, { landscape, phoneDevice }: { landscape: boolean; phoneDevice: boolean }): ImmersiveState {
  if (state === null) return landscape && phoneDevice ? "turn" : null;
  if (state === "turn" && !landscape) return null;
  return state;
}

/** Minimise (or Escape): out, whatever the way in. */
export const leaveImmersive = (): ImmersiveState => null;

export type ChromeHolds = { playing: boolean; composing: boolean; drawing: boolean; card: boolean; focusWithin: boolean; popupOpen: boolean; scrubbing: boolean };

/** Whether the controls must stay up instead of hiding after `CHROME_HIDE_MS`: paused, or anything the person is in the middle of. */
export function chromeHeld(holds: ChromeHolds): boolean {
  return !holds.playing || holds.composing || holds.drawing || holds.card || holds.focusWithin || holds.popupOpen || holds.scrubbing;
}
