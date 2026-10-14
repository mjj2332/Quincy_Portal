/** Pieces the Admin screen and the Admin tabs' panels (Social overlays, #869) share, so a panel does not re-declare them. */

// ReUI `Switch` rows. 44px touch target: WCAG 2.5.5 Enhanced / HIG, not a spacing token.
export const TOGGLE_ROW =
  "flex items-center gap-[var(--space-2)] cursor-pointer " +
  "min-h-[38px] max-[721px]:min-h-[44px] text-foreground-secondary " +
  "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]";

/** "5 Oct 2026" from an ISO string or epoch milliseconds; an em dash for no value or an unreadable one. */
export function formatDate(value: string | number | null): string {
  if (value === null || value === "") return "\u2014";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "\u2014";
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(date);
}
