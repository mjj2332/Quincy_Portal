import { uiPrefKey } from "./ui-prefs";

/**
 * The review viewer's side pane (#859): Notes (or Version details), plus Delivery on staff. One key for the whole browser, shared by the staff
 * viewer and the Review-link guest page (same origin, one layout), defaulting to open. The width is a preference: it is kept as saved and clamped
 * at use time against the room the row actually has, so a narrow window never rewrites a wide choice.
 */
export const REVIEW_PANE_KEY = uiPrefKey("review-notes-pane");
export const PANE_MIN = 280;
export const PANE_DEFAULT = 360;
export const PANE_MAX = 640;
/** The player always keeps at least this much of the row. */
export const PLAYER_MIN = 480;

export type ReviewPanePref = { open: boolean; width: number };

const clampStored = (width: number): number => Math.min(PANE_MAX, Math.max(PANE_MIN, Math.round(width)));

export function normalizeReviewPane(raw: unknown): ReviewPanePref {
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const open = typeof record.open === "boolean" ? record.open : true;
  const width = typeof record.width === "number" && Number.isFinite(record.width) ? clampStored(record.width) : PANE_DEFAULT;
  return { open, width };
}

/** The widest the pane may be in a row `hostWidth` wide: 640, or what leaves the player 480, never below the minimum. An unmeasured row (0) allows the full 640. */
export function paneCeiling(hostWidth: number): number {
  if (!(hostWidth > 0)) return PANE_MAX;
  return Math.max(PANE_MIN, Math.min(PANE_MAX, Math.floor(hostWidth - PLAYER_MIN)));
}

export const clampPaneWidth = (width: number, hostWidth: number): number => Math.min(paneCeiling(hostWidth), Math.max(PANE_MIN, Math.round(width)));
