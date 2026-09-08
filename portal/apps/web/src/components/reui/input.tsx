import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { cn } from "@/lib/utils"

// Three corrections to the vendor class string, marked inline below.
//
// 1. Geometry and colour roles: nova's `h-8 rounded-lg px-2.5 py-1` (plus `border-input` /
//    `bg-transparent`) are re-pointed to Quincy's field box, ported from `ui/input.tsx`'s
//    FIELD_BOX — `min-h-[38px] max-[721px]:min-h-[44px]` (38px legacy control height, 44px at
//    <=720px is WCAG 2.5.5 Enhanced / HIG, not a spacing token), `rounded-[var(--radius-sm)]`,
//    `px-[10px] py-[8px]`, `border-border` and `bg-[var(--field-bg)]`.
//
// 2. Read-only rule, ADDED (nova has none): `[&:read-only:not(select)]:…`. The `:not(select)`
//    is load-bearing, not decorative — a <select> matches `:read-only` unconditionally (only
//    input/textarea/contenteditable are ever `:read-write`), so a bare `read-only:` variant
//    would paint every enabled NativeSelect as if it were disabled. This box class is exported
//    so the Stage B native select and textarea can share it, which is exactly why the guard
//    matters here even though this file itself never renders a <select>.
//
// 3. `outline-none` is REMOVED. It is dead — `tokens/base.css:25` declares an unlayered
//    `:focus-visible { outline: … }`, imported at `index.css:13` outside any layer, and
//    unlayered author CSS beats Tailwind's `@layer utilities` regardless of specificity, so the
//    global ring paints anyway. It is not harmless, though: it trips the WCAG 2.4.7
//    outline-suppression detector at `ProjectDeadlineControl.dom.test.tsx:80`. `reui/textarea.tsx`
//    and `quincy/NativeSelect.tsx` share this box, so the correction covers them too.
const FIELD_BOX =
  "min-h-[38px] max-[721px]:min-h-[44px] w-full min-w-0 rounded-[var(--radius-sm)] border border-border bg-[var(--field-bg)] px-[10px] py-[8px] text-base transition-colors file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&:read-only:not(select)]:bg-surface-sunken [&:read-only:not(select)]:text-foreground-secondary"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(FIELD_BOX, className)}
      {...props}
    />
  )
}

export { Input, FIELD_BOX }
