import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Shared geometry and states for a glyph affordance: drag grips, overflow menus,
 * popover triggers. Not `buttonClasses("text")` — that is a text control with a
 * text baseline. 28px desktop / 44px at <=720px (44px touch target — WCAG 2.5.5
 * Enhanced / HIG, not a spacing token).
 *
 * Colour is NEVER dimmed by opacity to express disabled: a group opacity on an
 * already-quiet colour is what took the Kanban board's disabled handle to 1.72:1
 * (TB8-06) and this surface's drag grip to 2.51:1 (TB8-07 §2.1). The recessed
 * `--bg-sunken` chip carries it instead, at 7.40:1.
 *
 * Both `disabled:` and `aria-disabled:` are needed, not one or the other: the drag
 * grip is disabled via `aria-disabled` (dnd-kit keeps it focusable), the popover
 * triggers via the real attribute.
 */
const ICON_BUTTON_BASE =
  "inline-grid place-items-center shrink-0 p-0 m-0 " +
  "min-h-[28px] min-w-[28px] max-[721px]:min-h-[44px] max-[721px]:min-w-[44px] " +
  "bg-transparent border-0 rounded-[var(--radius-sm)] " +
  "text-foreground-secondary cursor-pointer " +
  "[font:var(--weight-regular)_var(--text-md)/1_var(--font-sans)] " +
  "transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] " +
  "hover:not-disabled:bg-secondary " +
  // Important, not decorative: `tokens/base.css`'s unlayered
  // `:focus-visible { outline: … }` shorthand resets `outline-offset` (TB8-07 §4.3).
  "focus-visible:!outline focus-visible:!outline-[length:var(--border-width-bold)] " +
  "focus-visible:!outline-[var(--focus-ring)] focus-visible:!outline-offset-2 " +
  "disabled:bg-surface-sunken disabled:cursor-not-allowed " +
  "aria-disabled:bg-surface-sunken aria-disabled:cursor-default";

/**
 * Square, glyph-only: the drag grip and the overflow menu.
 * `min-h`/`min-w` live on the base and `w-` on each variant — deliberately, not
 * `size-`: that split is what lets `META_TRIGGER` grow while this stays square.
 */
const ICON_BUTTON = ICON_BUTTON_BASE + " w-[28px] max-[721px]:w-[44px]";

/**
 * Variable width: a popover trigger that shows a glyph when empty and a value chip
 * when set (schedule, assignee). `min-w` from the base keeps the empty state on the
 * same 28/44 grid as `ICON_BUTTON`.
 */
const META_TRIGGER = ICON_BUTTON_BASE +
  // `shrink` overrides the base's `shrink-0`. Without it `max-w-full` is not a
  // no-overflow guarantee: a long schedule string would take the full row width and
  // refuse to give any back, pushing the assignee and overflow controls out of a
  // 390px row. `min-w-[28px]/[44px]` from the base still floors the target size.
  " shrink w-auto max-w-full min-w-0 overflow-hidden px-[var(--space-1)] " +
  // The pill is `inline-flex` (`ui/status-pill.tsx`), and `text-overflow` does not
  // apply to a flex container's own overflow — it truncates a flex *item*. So the
  // pill gets `min-w-0` here and the value text is wrapped in a `truncate` span at
  // the call site. Do not put `text-ellipsis` on the pill itself; it is inert there.
  "[&>[data-slot=status-pill]]:min-w-0 [&>[data-slot=status-pill]]:max-w-full";

function IconButton({ className, ...props }: React.ComponentProps<"button">) {
  return <button type="button" data-slot="icon-button" className={cn(ICON_BUTTON, className)} {...props} />;
}

export { IconButton, ICON_BUTTON, ICON_BUTTON_BASE, META_TRIGGER };
