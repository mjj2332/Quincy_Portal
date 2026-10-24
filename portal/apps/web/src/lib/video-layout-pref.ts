import { uiPrefKey } from "./ui-prefs";

/**
 * How a screen lays out its Videos (#933, #938): `tiles` (the poster grid, `quincy/VideoTile`) or `rows` (the Video row list, `quincy/VideoRows`).
 * Staff keep it in the per-person video-grid preference (`video-grid-prefs.ts`); the guest Review link page and the client Delivery page each keep it
 * per browser under their own key, since neither has a user id. Guest-safe: it imports `ui-prefs` only (`guest/guest-boundary.guard.test.ts`).
 */
export type VideoLayout = "tiles" | "rows";

/** Module level (stable for `useUiPref`). Anything but `rows` is `tiles`, the default. */
export const normalizeVideoLayout = (raw: unknown): VideoLayout => (raw === "rows" ? "rows" : "tiles");

/** The guest Review link page's layout (#940). */
export const GUEST_VIDEO_LAYOUT_KEY = uiPrefKey("video-layout:guest");
/** The client Delivery page's Film layout, the Film tab and Premium's films alike (#941). */
export const DELIVERY_VIDEO_LAYOUT_KEY = uiPrefKey("video-layout:delivery");
