import { buttonVariants } from "@/components/reui/button";
import { cn } from "../../lib/utils";

/**
 * #914 — the Project header's status cluster (prototype project-header-revamp `.qb`, D1/D6), in Quincy tokens. Every chip in the
 * cluster (Stage, Deadline, Team, Project info) is the outline button at the scoped `header` size (44px, `--radius-sm`, label type,
 * sentence case); the Stage select and the Deadline and Team popover triggers take the same classes so the row reads as one set.
 */
export const HEADER_CHIP = cn(buttonVariants({ variant: "outline", size: "header" }), "w-fit max-w-full text-foreground cursor-pointer");

/** The icon-only chips (Whiteboard, ⋯): 44px squares with the same outline. */
export const HEADER_ICON_CHIP = cn(buttonVariants({ variant: "outline", size: "icon-header" }), "text-foreground");

/**
 * D6's read-only value (`.qb.lock`): the chip's box, flat and sunken, no chevron. For read-only roles, External editors and an
 * archived Project. Not a control, so it carries no hover.
 */
export const HEADER_CHIP_LOCK =
  "inline-flex w-fit max-w-full items-center gap-[var(--space-2)] min-h-[44px] " /* WCAG 2.5.5 Enhanced target height, not a spacing token */ +
  "px-[var(--space-3)] rounded-[var(--radius-sm)] border-solid border-[length:var(--border-width-hair)] border-border " +
  "bg-surface-sunken text-foreground-secondary [font:var(--type-label)] whitespace-nowrap " +
  "outline-none focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-2";

/** D6's "Dropbox blocked" (`.qb.warn`): the outline chip in the caution tint — the brand ochre for the border and wash, the caution TEXT token for the label. */
export const HEADER_CHIP_WARN = "border-signal-caution/40 bg-signal-caution/10 !text-signal-caution-text hover:bg-signal-caution/15";

/** The chevron a chip ends with (`.qb .chev`), decorative. */
export const HEADER_CHEVRON = "size-[14px] shrink-0 text-muted-foreground";

/** The rule between the status controls and Whiteboard / Project info / ⋯ (`.vr`, 1×24). */
export const HEADER_RULE = "block w-px h-[var(--space-5)] shrink-0 bg-border";

/** Project info's Dropbox status badge, by the status's tone (`dropboxStatus`). */
export const DROPBOX_BADGE = { positive: "success-light", caution: "warning-light", neutral: "secondary" } as const;
