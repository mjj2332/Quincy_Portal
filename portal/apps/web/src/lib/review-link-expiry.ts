import { REVIEW_LINK_DEFAULT_EXPIRY_MS, REVIEW_LINK_MAX_EXPIRY_MS, REVIEW_LINK_MIN_EXPIRY_MS, resolveSydneyCivilMinute } from "@quincy/shared";
import { addCivilDays, sydneyToday } from "./date-time-field";

/**
 * A Review link's expiry (#741 11b). The field is a Sydney calendar day (`quincy/DateTimeField`, date mode); the link lapses at the end of
 * that day (23:59 Sydney) and the API takes an ISO instant it bounds to one hour .. 365 days from now. Pure, so the conversion and its
 * refusals are tested without a DOM.
 */
export const REVIEW_LINK_DEFAULT_EXPIRY_DAYS = REVIEW_LINK_DEFAULT_EXPIRY_MS / 86_400_000;

/** The default day: thirty Sydney days after today. */
export const defaultExpiryDay = (now: number): string => addCivilDays(sydneyToday(now), REVIEW_LINK_DEFAULT_EXPIRY_DAYS);

export type ExpiryResult = { ok: true; iso: string } | { ok: false; message: string };

/** The ISO instant for the end of `day`, or why it is not allowed (before the server would say so). */
export function expiryDayToIso(day: string, now: number): ExpiryResult {
  const resolved = resolveSydneyCivilMinute(`${day}T23:59`);
  if (!resolved.ok) return { ok: false, message: "Choose a valid expiry day." };
  const ms = resolved.value.epochMs;
  if (ms < now + REVIEW_LINK_MIN_EXPIRY_MS) return { ok: false, message: "Choose a later day: the link must last at least an hour." };
  if (ms > now + REVIEW_LINK_MAX_EXPIRY_MS) return { ok: false, message: "Choose an earlier day: a link can last at most a year." };
  return { ok: true, iso: new Date(ms).toISOString() };
}
