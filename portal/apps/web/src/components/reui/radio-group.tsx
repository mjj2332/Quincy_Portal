// Vendored via `shadcn add radio-group` (base-nova) through the `tmp/ReUI-Test-1` sandbox (#741 slice 6s-ui, the markup
// toolbar's tool selector: a single choice, so radio semantics -- one tab stop, arrow keys, aria-checked). Edits:
// 1. `import { cn } from "cn"` -> `@/lib/utils`, as every vendored primitive here does.
// 2. The `dark:` variants removed (`styles/tokens/reui.css` rebinds `dark` to a `.dark` class nothing sets;
//    `reui-skin.guard.test.ts`).
// 3. `outline-none` and the `focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50` pair removed: a layered
//    utility loses to the unlayered `tokens/base.css` `:focus-visible` outline, and the ring would be a second indicator
//    (`reui/toggle.tsx` item 4). `aria-invalid:ring-3` and `disabled:opacity-50` go the same way: this item is never in a form,
//    and a disabled control is colour, never an opacity multiplier (`quincy/icon-button.tsx`).
// 4. `after:-inset-x-3 after:-inset-y-2` (the registry's enlarged hit area) removed: in a row of adjacent segments it would
//    overlap the neighbour's target.
// 5. `RadioGroupItem` renders its `children` INSTEAD of the default dot indicator when it is given any, so an item can be an
//    icon button (the registry's item is always a 16px dot). With no children it is unchanged.
// Base UI's Radio renders a `<span role="radio">`; a caller that needs a native button passes
// `render={<button type="button" />} nativeButton`.
import { Radio as RadioPrimitive } from "@base-ui/react/radio"
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group"
import { cn } from "@/lib/utils"

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn("grid w-full gap-2", className)}
      {...props}
    />
  )
}

function RadioGroupItem({ className, children, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        "group/radio-group-item peer relative flex aspect-square size-4 shrink-0 rounded-full border border-input group-has-[:focus-visible]/field-label:ring-0 group-has-[:focus-visible]/field-label:not-data-checked:border-input disabled:cursor-not-allowed aria-invalid:border-destructive aria-invalid:aria-checked:border-primary data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground group-has-[:focus-visible]/field-label:data-checked:border-primary",
        className
      )}
      {...props}
    >
      {children ?? (
        <RadioPrimitive.Indicator
          data-slot="radio-group-indicator"
          className="flex size-4 items-center justify-center"
        >
          <span className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-foreground" />
        </RadioPrimitive.Indicator>
      )}
    </RadioPrimitive.Root>
  )
}

export { RadioGroup, RadioGroupItem }
