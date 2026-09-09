import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Two corrections, marked inline below. Tones are deliberately NOT touched here — Stage B maps
// Quincy's tones onto (or past) nova's semantic variants; see `tokens/reui.css`'s header for why
// `destructive-light` and the `[data-surface="inverse"]` roles are not safe to reconcile yet.
const badgeVariants = cva(
  [
    // Correction 1: nova's `font-medium` is replaced by Quincy's small-caps badge typography,
    // ported from `ui/status-pill.tsx`'s PILL_BASE — the closest existing Quincy analogue to a
    // badge. Same shorthand-vs-utility conflict as the other primitives corrected in this slice,
    // which is also why every SIZE variant below has its own text-*/leading-* utilities removed:
    // left in place, they would compete with this base font-size on Tailwind's generated rule
    // order rather than source order.
    "relative inline-flex shrink-0 items-center justify-center w-fit border border-transparent [font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] uppercase tracking-[var(--tracking-wide)] whitespace-nowrap transition-shadow",
    "disabled:pointer-events-none disabled:opacity-50",
    // Correction 2: nova's `outline-none` and its focus ring (`focus-visible:ring-2 ring-ring
    // ring-offset-1 ring-offset-background`) are both REMOVED. `tokens/base.css:25` declares an
    // unlayered `:focus-visible { outline: … }` that beats Tailwind's `@layer utilities`, so
    // `outline-none` never suppressed anything — it only tripped the WCAG 2.4.7 detector — while
    // the ring painted a second indicator beside the global outline that tailwind-merge cannot
    // collapse against it (`box-shadow` vs `outline`). Removing the ring alone would have left a
    // badge with no focus indicator IF `outline-none` had worked; removing both is what makes the
    // global outline the single indicator here. Same correction as `reui/button.tsx` divergence 5.
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-3",
  ],
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        outline: "border-border bg-transparent dark:bg-input/32",
        secondary: "bg-secondary text-secondary-foreground",
        info: "bg-info text-white",
        success: "bg-success text-white",
        warning: "bg-warning text-white",
        destructive: "bg-destructive text-white",
        focus: "bg-focus text-focus-foreground",
        invert: "bg-invert text-invert-foreground",
        "primary-light":
          "border-primary/10 bg-primary/10 text-primary dark:border-primary/25 dark:bg-primary/15 dark:text-primary",
        "warning-light":
          "border-warning/15 bg-warning/10 text-warning-foreground dark:border-warning/25 dark:bg-warning/15 dark:text-warning",
        "success-light":
          "border-success/15 bg-success/10 text-success-foreground dark:border-success/25 dark:bg-success/15 dark:text-success",
        "info-light":
          "border-info/15 bg-info/10 text-info-foreground dark:border-info/25 dark:bg-info/15 dark:text-info",
        "destructive-light":
          "border-destructive/15 bg-destructive/10 text-destructive-foreground dark:border-destructive/25 dark:bg-destructive/15 dark:text-destructive",
        "invert-light":
          "border-invert/15 bg-invert/10 text-foreground dark:border-invert/45 dark:bg-invert/35 dark:text-invert-foreground",
        "focus-light":
          "border-focus/15 bg-focus/10 text-focus-foreground dark:border-focus/25 dark:bg-focus/15 dark:text-focus",
        "primary-outline":
          "bg-background border-border text-primary dark:bg-input/30",
        "warning-outline":
          "bg-background border-border text-warning-foreground dark:bg-input/30",
        "success-outline":
          "bg-background border-border text-success-foreground dark:bg-input/30",
        "info-outline":
          "bg-background border-border text-info-foreground dark:bg-input/30",
        "destructive-outline":
          "bg-background border-border text-destructive-foreground dark:bg-input/30",
        "invert-outline":
          "bg-background border-border text-invert-foreground dark:bg-input/30",
        "focus-outline":
          "bg-background border-border text-focus-foreground dark:bg-input/30",
      },
      // Correction 2: every size's text-*/leading-* utility is dropped — see the base comment
      // above. All five sizes now share the same base type size; they differ only in box
      // dimensions (padding/height/min-width/gap).
      size: {
        xs: "px-1 py-0.25 h-4 min-w-4 gap-1",
        sm: "px-1 py-0.25 h-4.5 min-w-4.5 gap-1",
        default: "px-1.25 py-0.5 h-5 min-w-5 gap-1",
        lg: "px-1.5 py-0.5 h-5.5 min-w-5.5 gap-1",
        xl: "px-2 py-0.75 h-6 min-w-6 gap-1.5",
      },
      /** `default`: active style radius. `full`: pill radius. */
      radius: {
        default:
          "rounded-sm",
        full: "rounded-full",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      radius: "default",
    },
  }
)

interface BadgeProps extends useRender.ComponentProps<"span"> {
  variant?: VariantProps<typeof badgeVariants>["variant"]
  size?: VariantProps<typeof badgeVariants>["size"]
  radius?: VariantProps<typeof badgeVariants>["radius"]
}

function Badge({
  className,
  variant,
  size,
  radius,
  render,
  ...props
}: BadgeProps) {
  const defaultProps = {
    "data-slot": "badge",
    className: cn(badgeVariants({ variant, size, radius, className })),
  }

  return useRender({
    defaultTagName: "span",
    render,
    props: mergeProps<"span">(defaultProps, props),
  })
}

export { Badge, badgeVariants, type BadgeProps }