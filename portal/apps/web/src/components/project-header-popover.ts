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
