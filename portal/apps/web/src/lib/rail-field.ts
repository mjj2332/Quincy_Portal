// Shared 44px-target field treatment for the Project Workspace rail and the reached collection
// shell (TB8-03 §5.4 / §5.9d). One field owner, imported by both ProjectDeadlineControl.tsx and
// CollectionPanel.tsx so their inputs never drift apart.
export const RAIL_FIELD =
  "w-full min-w-0 min-h-[44px] " /* WCAG 2.5.5 Enhanced target, not a spacing token */ +
  "px-[var(--space-3)] py-[var(--space-2)] " +
  "rounded-[var(--radius-sm)] border-solid border-[length:var(--border-width-hair)] border-border " +
  "bg-card text-foreground " +
  "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] tracking-normal " +
  "hover:not-disabled:border-border-hover " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2 focus-visible:border-[color:var(--border-strong)]";
