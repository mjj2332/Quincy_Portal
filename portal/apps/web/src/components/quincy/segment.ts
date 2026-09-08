// TB8-01 §7.4 — the segment control that motivated this candidate: legacy `.segment button` had
// no disabled styling at all, even though the Dashboard disables it while interaction is blocked.
const SEGMENT_GROUP = "inline-flex border-solid border-[length:var(--border-width-hair)] border-border " +
  "rounded-[var(--radius-sm)] overflow-hidden bg-card has-[button:focus-visible]:overflow-visible " +
  "max-[721px]:flex-auto";
// Merged font shorthand, not `[font:var(--type-label)]` + a separate `text-[length:var(--text-xs)]`
// override — the two-utility split doesn't reliably resolve to text-xs (Tailwind's generated
// order between them isn't guaranteed); see button.tsx's BASE for the same fix.
const SEGMENT_BUTTON = "[font:var(--weight-regular)_var(--text-xs)/1.2_var(--font-sans)] uppercase " +
  "tracking-[var(--tracking-wide)] min-h-[38px] px-[var(--space-4)] py-[var(--space-2)] bg-transparent " +
  "border-0 [border-left-style:solid] border-l-[length:var(--border-width-hair)] border-l-border " +
  "text-foreground-secondary cursor-pointer transition-[background-color,color] duration-[var(--dur-fast)] " +
  "ease-[var(--ease-standard)] first:border-l-0 " +
  "not-[.is-active]:not-disabled:hover:bg-secondary not-[.is-active]:not-disabled:hover:text-foreground " +
  "[&.is-active]:bg-primary [&.is-active]:text-primary-foreground not-disabled:active:translate-y-px " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2 focus-visible:relative focus-visible:z-10 " +
  "disabled:text-foreground-secondary disabled:bg-surface-sunken disabled:cursor-not-allowed " +
  "disabled:translate-y-0 [&.is-active]:disabled:bg-surface-sunken [&.is-active]:disabled:text-foreground-secondary " +
  "[&.is-active]:disabled:border-border-hover max-[721px]:flex-auto " +
  "max-[721px]:min-h-[44px]"; /* WCAG 2.5.8 minimum target, not a spacing token */

export { SEGMENT_GROUP, SEGMENT_BUTTON };
