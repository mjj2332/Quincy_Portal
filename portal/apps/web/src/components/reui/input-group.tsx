import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

import { Button } from "@/components/reui/button"
import { Input } from "@/components/reui/input"

// Four corrections to the vendor class string, marked inline below. The box this paints is the
// one Quincy's shipped search control already draws by hand (the search label in `Dashboard.tsx`;
// it carried a `.dashboard-search` hook until #56 criterion 5 retired it as unused), so the
// dressing targets that exact appearance rather than nova's.
//
// 1. Geometry and colour roles: nova's `h-8 rounded-lg border-input` (and its transparent ground)
//    become the Quincy field box — `min-h-[38px] max-[721px]:min-h-[44px]` matching
//    `input.tsx`'s FIELD_BOX (38px legacy control height; 44px at <=720px is WCAG 2.5.5
//    Enhanced / HIG, not a spacing token), `rounded-[var(--radius-sm)]`, a hairline
//    `border-border`, and `bg-card`.
//
// 2. Focus and hover are re-pointed from nova's ring to Quincy's. `border-primary` plus a real
//    `outline` (not a ring) is Quincy's focus treatment; `hover:border-border-hover` is the
//    resting affordance nova has no equivalent for.
//
//    The SELECTOR is `has-[input:focus-visible]:`, not `focus-within:` (#217 design-fix round 2,
//    item 2). `focus-within` originally matched the shipped search label this box replaces, but
//    it fires on ANY focused descendant — including an `InputGroupButton` (the combobox
//    trigger/clear this file restored in #202) — so a focused BUTTON painted its own global
//    `:focus-visible` outline (`tokens/base.css:25`, unsuppressed on `Button` — see
//    `reui/button.tsx`'s own divergence 5) AND this wrapper's `focus-within` outline at once: two
//    indicators on one focused control. `has-[input:focus-visible]:` scopes the wrapper's own
//    treatment to the INPUT specifically, so a focused button now shows exactly its own
//    indicator and nothing from the wrapper. The input's own global outline stays suppressed by
//    `InputGroupInput`'s `focus-visible:!outline-none` below (divergence 3 lower down), so the
//    wrapper's `has-[input:focus-visible]:outline-*` remains the field's single visible
//    indicator when the INPUT itself is focused — unchanged from before this item.
//
// 3. `outline-none` is REMOVED, the same correction #54 applied to `reui/button.tsx` and
//    `reui/input.tsx`. It is dead — `tokens/base.css:25` declares an unlayered
//    `:focus-visible { outline: … }` imported outside any cascade layer, and unlayered author CSS
//    beats Tailwind's `@layer utilities` regardless of specificity — but a live `outline-`
//    suppressor in a shared primitive is what the WCAG 2.4.7 detector in
//    `ProjectDeadlineControl.dom.test.tsx` exists to catch, and leaving dead ones around trains
//    the eye to skip them.
//
// 4. Vendor rules are dropped in two ways, and the distinction matters. DELETED outright:
//    `in-data-[slot=combobox-content]` (this app has no combobox surface) and the
//    `has-[>[data-align=inline-*]]:[&>input]:p{l,r}-1.5` nudges (Quincy's control carries its own
//    `px-[var(--space-3)]`, and the two would compound into an off-grid inset). OVERRIDDEN on
//    `InputGroupInput`, because they arrive from `FIELD_BOX` through `<Input>` rather than from
//    this file's own string: `aria-invalid:ring-0 aria-invalid:border-0` — Quincy expresses
//    invalidity through `QuincyField`'s error row, not a control-level ring — and
//    `disabled:opacity-100`, because `FIELD_BOX` carries `disabled:opacity-50` and an opacity
//    multiplier on an already-quiet colour is the contrast defect recorded in TB8-06 / TB8-07 §2.1
//    and guarded against by name in `quincy/icon-button.tsx`. Deleting a class from this file does
//    NOT remove it when `FIELD_BOX` also declares it; only a same-group override does.
//    The `has-[>[data-align=block-*]]` column rules are KEPT untouched — they cost nothing unused
//    and are load-bearing for any future block-aligned addon.
//
// 5. The vendor's `InputGroupText` and `InputGroupTextarea` are dropped. The first call site
//    (`Dashboard.tsx`'s search control) composes only group + addon + input, and #47's rule is
//    that a slice vendors what it uses. `InputGroupTextarea` in particular would have pulled
//    `reui/textarea` into this module's import closure for no consumer. `InputGroupButton` was
//    dropped for the same reason and restored verbatim in #202, because `reui/combobox.tsx` (the
//    registry's own source) composes it for its clear and trigger buttons; it renders Quincy's
//    adapted `Button`, so it inherits every correction recorded in `reui/button.tsx`.
function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      role="group"
      className={cn(
        "group/input-group relative flex min-h-[38px] max-[721px]:min-h-[44px] w-full min-w-0 items-center rounded-[var(--radius-sm)] border border-border bg-card transition-[border-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:border-border-hover has-[input:focus-visible]:border-primary has-[input:focus-visible]:outline-[length:var(--border-width-bold)] has-[input:focus-visible]:outline-solid has-[input:focus-visible]:outline-ring has-[input:focus-visible]:outline-offset-2 has-disabled:bg-surface-sunken has-disabled:cursor-not-allowed has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col has-[>textarea]:h-auto has-[>[data-align=block-end]]:[&>input]:pt-3 has-[>[data-align=block-start]]:[&>input]:pb-3",
        className
      )}
      {...props}
    />
  )
}

// The addon is where the search glyph lives. Colour comes from `text-muted-foreground` and picks
// up the group's focus state through `group-focus-within/input-group:text-foreground-secondary` —
// the shipped search label already does exactly this transition on its inline `<svg>`, so keeping
// it here is what lets the call site drop its hand-written `group-focus-within:` class rather than
// carry a second copy of the rule.
//
// `opacity-50` for the disabled state is replaced by `text-muted-foreground`: an opacity
// multiplier on an already-quiet colour is the contrast defect recorded in TB8-06 / TB8-07 §2.1
// and guarded against by name in `quincy/icon-button.tsx`. The glyph is decorative here, but the
// rule is the app's, not the component's.
const inputGroupAddonVariants = cva(
  "flex h-auto cursor-text items-center justify-center gap-[var(--space-2)] text-sm font-medium text-muted-foreground select-none transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] group-focus-within/input-group:text-foreground-secondary group-data-[disabled=true]/input-group:text-muted-foreground [&>svg:not([class*='size-'])]:size-4",
  {
    variants: {
      align: {
        "inline-start":
          "order-first pl-[var(--space-3)] has-[>button]:ml-[-0.3rem]",
        "inline-end":
          "order-last pr-[var(--space-3)] has-[>button]:mr-[-0.3rem]",
        "block-start":
          "order-first w-full justify-start px-[var(--space-3)] pt-[var(--space-2)] [.border-b]:pb-[var(--space-2)]",
        "block-end":
          "order-last w-full justify-start px-[var(--space-3)] pb-[var(--space-2)] [.border-t]:pt-[var(--space-2)]",
      },
    },
    defaultVariants: {
      align: "inline-start",
    },
  }
)

function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    <div
      role="group"
      data-slot="input-group-addon"
      data-align={align}
      className={cn(inputGroupAddonVariants({ align }), className)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) {
          return
        }
        e.currentTarget.parentElement?.querySelector("input")?.focus()
      }}
      {...props}
    />
  )
}

// The control sheds the field box entirely — border, ground, radius and ring all belong to the
// group wrapper, which is already painting them. `focus-visible:ring-0` stays: ReUI's ring is a
// box-shadow, so suppressing it here does NOT suppress a focus indicator — `tokens/base.css`'s
// unlayered `:focus-visible { outline: … }` still paints on the focused input, and the wrapper
// draws its own outline besides — TWO indicators on one field (#217 design-review, item 4).
// `focus-visible:!outline-none` below is the fix, and the `!` is required for the SAME reason
// `quincy/icon-button.tsx`'s own `focus-visible:!outline` needs it in the other direction:
// `tokens/base.css:25`'s `:focus-visible { outline: … }` is unlayered author CSS, which beats
// Tailwind's `@layer utilities` regardless of source order or specificity, so a bare
// `outline-none` here would never suppress it. The group's own `has-[input:focus-visible]:outline-*`
// (scoped to the INPUT specifically, not `focus-within:` — #217 design-fix round 2, item 2, divergence
// 2 above) is Tailwind utility-layer, unaffected, and remains the field's single visible indicator.
//
// Type is spelled as four LONGHANDS (`text-sm`, `leading-`, `font-[…]` weight, `font-[family-name:…]`)
// and deliberately NOT as the `[font:var(--weight-regular)_var(--text-sm)/…]` shorthand the shipped
// search control uses. The shorthand would be the closer transcription, but it lands in a different
// twMerge group from the `text-base md:text-sm` that `FIELD_BOX` unconditionally applies through
// `<Input>`, so both would survive into the stylesheet and the winner would be decided by Tailwind's
// emission order rather than by this class list — the exact trap in `docs/lessons.md`, "A shorthand
// always resets its longhands, and Tailwind's emission order is not your class order" (TB8-06).
// `text-sm` collides with `text-base` in the same group, so twMerge resolves it here and the result
// is 14px at every width, which is what the shipped control renders. `--text-sm` is 14px and
// Tailwind's `text-sm` is 0.875rem, so the two spellings agree by value, not by luck.
function InputGroupInput({
  className,
  ...props
}: React.ComponentProps<"input">) {
  return (
    <Input
      data-slot="input-group-control"
      className={cn(
        "flex-1 min-h-0 max-[721px]:min-h-0 rounded-none border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0 focus-visible:border-0 focus-visible:!outline-none px-[var(--space-3)] py-[var(--space-2)] max-[721px]:py-[var(--space-3)] text-foreground text-sm leading-[var(--leading-normal)] font-[var(--weight-regular)] font-[family-name:var(--font-sans)] placeholder:text-muted-foreground disabled:bg-transparent disabled:opacity-100 aria-invalid:ring-0 aria-invalid:border-0",
        className
      )}
      {...props}
    />
  )
}

const inputGroupButtonVariants = cva(
  "flex items-center gap-2 text-sm shadow-none",
  {
    variants: {
      size: {
        xs: "h-6 gap-1 rounded-[calc(var(--radius)-3px)] px-1.5 [&>svg:not([class*='size-'])]:size-3.5",
        sm: "",
        "icon-xs":
          "size-6 rounded-[calc(var(--radius)-3px)] p-0 has-[>svg]:p-0",
        "icon-sm": "size-8 p-0 has-[>svg]:p-0",
      },
    },
    defaultVariants: {
      size: "xs",
    },
  }
)

function InputGroupButton({
  className,
  type = "button",
  variant = "ghost",
  size = "xs",
  ...props
}: Omit<React.ComponentProps<typeof Button>, "size" | "type"> &
  VariantProps<typeof inputGroupButtonVariants> & {
    type?: "button" | "submit" | "reset"
  }) {
  return (
    <Button
      type={type}
      data-size={size}
      variant={variant}
      className={cn(inputGroupButtonVariants({ size }), className)}
      {...props}
    />
  )
}

export { InputGroup, InputGroupAddon, InputGroupInput, InputGroupButton }
