/**
 * #205: class strings shared by the header's popover triggers (`ProjectHeaderDeadline.tsx`,
 * `ProjectHeaderDropbox.tsx`). `HEADER_KV_KEY` and `HEADER_KV_VALUE` match the same-named
 * constants in `ProjectHeader.tsx`.
 */

export const HEADER_KV_KEY =
  "k [font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] " +
  "uppercase tracking-[var(--tracking-wide)] text-foreground-secondary";

export const HEADER_KV_VALUE =
  "vv [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] " +
  "text-foreground [overflow-wrap:anywhere]";

/** #455: a read-only header value (Stage, Deadline) sized to the 44px triggers beside it, so an archived row lines up. */
export const HEADER_READONLY_VALUE =
  HEADER_KV_VALUE + " flex items-center gap-[var(--space-2)] min-h-[44px]"; // WCAG 2.5.5 Enhanced target height, not a spacing token

/** #455: the focus ring a read-only group (`tabIndex={-1}`, focused after a refusal) draws; copied from the Team group. */
export const READONLY_GROUP_FOCUS =
  "outline-none focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-2";

/** The header's underlined text link ("Edit details", "Restore or delete", "Open in Dropbox" on an archived Project). */
export const HEADER_TEXT_LINK =
  "inline-flex items-center min-h-[44px] " /* WCAG 2.5.5 Enhanced target, not a spacing token */ +
  "underline [text-underline-offset:3px] decoration-border hover:decoration-foreground " +
  "[font:var(--weight-regular)_var(--text-xs)/1.2_var(--font-sans)] text-foreground " +
  "transition-[text-decoration-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2";

// A dashed-border trigger idiom, carried over from STAGE_SELECT (ProjectHeader.tsx) with a solid
// border swapped for a dashed one — this control opens an editor, it does not host one directly.
// #213: content-sized and single-line like the prototype's `.sel.dashed` (value · pill · chevron
// in a row), not a full-width labelled box — the label now lives on the header cell around it.
export const DASHED_TRIGGER =
  "w-fit max-w-full text-left cursor-pointer " +
  "min-h-[44px] " /* WCAG 2.5.5 Enhanced target, not a spacing token */ +
  "inline-flex items-center gap-[var(--space-2)] " +
  "px-[14px] py-[9px] " +
  "rounded-[var(--radius-sm)] [border-style:dashed] border-[length:var(--border-width-hair)] " +
  "bg-card border-border text-foreground " +
  "transition-[background-color,color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] " +
  "hover:bg-secondary hover:border-border-hover " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2";

// The chevron both triggers end with (`.chev` in prototype 2a) — decorative, so `aria-hidden`
// is set at the call site alongside this class.
export const TRIGGER_CHEVRON = "size-[var(--space-4)] shrink-0 stroke-[1.5] text-foreground-secondary";

export const POPOVER_CONTENT =
  "w-[360px] max-w-[calc(100vw-2*var(--space-4))] max-h-[var(--available-height)] overflow-y-auto";
