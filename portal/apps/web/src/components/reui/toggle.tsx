// Vendored via `shadcn add toggle` (base-nova) through the `tmp/ReUI-Test-1` sandbox (#491, the
// `rich-text-editor-2` toolbar's only new primitive). Edits, none a behaviour change:
// 1. `import { cn } from "cn"` -> `@/lib/utils`, as every vendored primitive here does.
// 2. `dark:aria-invalid:ring-destructive/40` removed: `styles/tokens/reui.css` rebinds `dark` to a
//    `.dark` class nothing sets (`reui-skin.guard.test.ts`).
// 3. `size="sm"` gains `max-[721px]:h-11 max-[721px]:min-w-11`: the 44px touch target at <=721px
//    (`quincy/icon-button.tsx`'s contract). Neither `Toggle sm` nor `Button icon-sm` (`size-7`) had it.
// 4. `outline-none` and `focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50` removed: `outline-none` is dead
//    (a layered utility loses to the unlayered `tokens/base.css` `:focus-visible` outline, as in
//    `reui/button.tsx` divergence 4) and the ring would be a second indicator beside that outline.
// 5. `disabled:opacity-50` -> `disabled:text-muted-foreground`: a disabled control is colour, never an
//    opacity multiplier on an already-quiet colour (`quincy/icon-button.tsx`, TB8-06/TB8-07 contrast).
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const toggleVariants = cva(
  "group/toggle inline-flex items-center justify-center gap-1 rounded-lg text-sm font-medium whitespace-nowrap transition-all hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:text-muted-foreground aria-invalid:border-destructive aria-invalid:ring-destructive/20 aria-pressed:bg-muted data-[state=on]:bg-muted [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border border-input bg-transparent hover:bg-muted",
      },
      size: {
        default:
          "h-8 min-w-8 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        sm: "h-7 min-w-7 max-[721px]:h-11 max-[721px]:min-w-11 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 min-w-9 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Toggle({
  className,
  variant = "default",
  size = "default",
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
