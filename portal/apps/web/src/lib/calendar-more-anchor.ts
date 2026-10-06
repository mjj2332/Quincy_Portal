/**
 * #583 — which "+N more" button holds an item for a given DAY. A multi-day item sits in the overflow list of every day it spans, so
 * the item's id alone names several buttons; the day the user opened it from (`data-more-day`, a Quincy tag on the Calendar's
 * `renderMoreIndicator`, beside `data-more-event-ids`) picks the right one. DOM lookup only; no vendor import.
 */
export function findMoreFor(key: string, day: string | null): HTMLElement | null {
  if (!day) return null;
  const marker = [...document.querySelectorAll<HTMLElement>("[data-more-day]")].find((element) => element.getAttribute("data-more-day") === day && (element.getAttribute("data-more-event-ids") ?? "").split(" ").includes(key));
  return marker?.closest<HTMLElement>("button") ?? null;
}

/**
 * #614 PR B (Sol r2) - the "+N more" button that lists an event on ANY day, for a focus return that has no day to ask for:
 * a rollback restores a bar the month cell has folded away, so its chip is gone and its day is the one it was restored to.
 * The first day's button wins (a multi-day item sits in every covered day's list). Same Portal marker as `findMoreFor`.
 */
export function findMoreForEvent(key: string): HTMLElement | null {
  const marker = [...document.querySelectorAll<HTMLElement>("[data-more-event-ids]")].find((element) => (element.getAttribute("data-more-event-ids") ?? "").split(" ").includes(key));
  return marker?.closest<HTMLElement>("button") ?? null;
}
