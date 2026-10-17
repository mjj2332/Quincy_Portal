import { PANE_DEFAULT, PANE_MAX, PANE_MIN } from "./review-pane-geometry";
import { uiPrefKey } from "./ui-prefs";

/**
 * The review viewer's side pane (#859): Notes (or Version details, or Delivery), plus Delivery on staff. One key for the whole browser, shared by the staff
 * viewer and the Review-link guest page (same origin, one layout). `open` is the remembered choice, `null` until the person makes one (#881, D18): the screen
 * then decides (a portrait tablet starts collapsed). The width is a preference: it is kept as saved and clamped at use time (`clampPaneWidth`) against the
 * room the row actually has, so a narrow window never rewrites a wide choice.
 */
export const REVIEW_PANE_KEY = uiPrefKey("review-notes-pane");

export type ReviewPanePref = { open: boolean | null; width: number };

const clampStored = (width: number): number => Math.min(PANE_MAX, Math.max(PANE_MIN, Math.round(width)));

export function normalizeReviewPane(raw: unknown): ReviewPanePref {
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const open = typeof record.open === "boolean" ? record.open : null;
  const width = typeof record.width === "number" && Number.isFinite(record.width) ? clampStored(record.width) : PANE_DEFAULT;
  return { open, width };
}
