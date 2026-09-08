import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

// Three corrections to the vendor class string, each marked inline below.
//
// 1. cva base: nova's bare `text-sm font-medium` is replaced by Quincy's button typography,
//    ported verbatim from `ui/button.tsx`'s BASE comment. A `[font:…]` shorthand resets
//    font-size/weight/line-height as a unit, so it cannot be left beside another utility that
//    also sets one of those three — Tailwind generates rules in its own property order, not
//    class-string order, so which one wins is not decided by writing the shorthand last.
//
// 2. `variants.variant`: every text-COLOUR utility is `!`-prefixed, carrying across the
//    reasoning from `ui/button.tsx:7-14`, not just the `!` itself. `tokens/base.css` has an
//    unlayered `a { color: inherit }` rule, and unlayered author CSS always beats Tailwind's
//    `@layer utilities` regardless of selector specificity. `buttonVariants` renders on real
//    `<a>` elements via `InternalLink` on both project screens as well as real `<button>`s, so
//    every variant's text-colour value needs `!important` to reliably win — not just the ones a
//    given screen happens to put on an anchor today.
//
// 3. `variants.size.default`: nova's `h-8` (32px) is re-pointed to Quincy's touch-target
//    contract, `min-h-[38px] max-[721px]:min-h-[44px]`. 44px is WCAG 2.5.5 Enhanced / HIG, not
//    a spacing token — see `ui/button.tsx:19-21`.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding [font:var(--weight-regular)_var(--text-xs)/1.2_var(--font-sans)] uppercase tracking-[var(--tracking-wide)] whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary !text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:!text-foreground aria-expanded:bg-muted aria-expanded:!text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary !text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:!text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:!text-foreground aria-expanded:bg-muted aria-expanded:!text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 !text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "!text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "min-h-[38px] max-[721px]:min-h-[44px] gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
