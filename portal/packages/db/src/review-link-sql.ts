/**
 * The one definition of "this Review link is open" (#847), as a SQL fragment over a `client_links` alias. A link is open when it is a video review link, not revoked, not expired and, for the
 * Delivery review link, its Project's Delivery page is still switched on (ADR 0023: switching a page off ends the link too). `expires_at` is NULL for the Delivery review link and means
 * never: a bare `expires_at > now` reads NULL as expired, and `MIN(x, NULL)` is NULL, so no caller compares the column itself (the review-link-open guard test enforces it).
 * `alias` is the table alias, `now` a SQL expression (a placeholder such as `?3`). Pure string, importable by the app Worker and the background Worker alike.
 */
export const reviewLinkOpenSql = (alias: string, now: string): string =>
  `${alias}.kind = 'video_review' AND ${alias}.revoked_at IS NULL AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > ${now}) AND (${alias}.delivery_review = 0 OR EXISTS (SELECT 1 FROM delivery_pages dp WHERE dp.project_id = ${alias}.project_id AND dp.enabled = 1))`;

/** The expiry of a link row as a SQL expression that is never NULL: the link's own, or `fallback` when it has none. For capping a session at the link's expiry. */
export const reviewLinkExpiryOrSql = (alias: string, fallback: string): string => `COALESCE(${alias}.expires_at, ${fallback})`;

/** Whether an expiry read from a row has passed. `null` never expires: `null <= now` is true in JS, so every TS comparison goes through here. */
export const reviewLinkExpired = (expiresAt: number | null, now: number): boolean => expiresAt !== null && expiresAt <= now;
