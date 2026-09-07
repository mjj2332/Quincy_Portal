import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Eyebrow typography for elements that are NOT a `<span>` — `<time dateTime>` above
 * all, plus `<small>` and `<strong>`. The `Eyebrow` component below is hard-coded to
 * a `<span>`, so using it for a timestamp would silently drop `dateTime` (TB8-07 §9a).
 *
 * `--type-eyebrow` resolves through `--text-xs`, i.e. 12px. Tracking is `--tracking-wide`,
 * not the component's `--tracking-widest`: 0.22em is a section-label tracking and reads as
 * loose on an inline timestamp. `font` does not reset `letter-spacing`, so the separate
 * `tracking-` utility here does not conflict with the `[font:…]` shorthand.
 */
const META_TEXT =
  "[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] text-foreground-secondary";

export function Eyebrow({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="eyebrow"
      className={cn(
        "[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-widest)] text-foreground-secondary",
        className,
      )}
      {...props}
    />
  );
}

export { META_TEXT };
