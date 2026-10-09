/**
 * `@reui/number-field`, fetched with `npx shadcn@latest add @reui/number-field` into the sandbox (`tmp/ReUI-Test-1`) for #741 5c-ui (the
 * paste dialog's frame offset). Edits, each so `reui-skin.guard` and `design-system-guards` pass:
 * - `"use client"` dropped; `cn` imported from `@/lib/utils`, never the `cn` npm package (see `reui/checkbox.tsx`).
 * - `NumberFieldScrubArea` and its `CursorGrowIcon` removed: scrubbing is not used, and the icon hard-codes `fill="black"`, a colour literal. The
 *   `Label` import went with them.
 * - Every `dark:` variant removed (`styles/tokens/reui.css` rebinds `dark` to a class nothing sets).
 * - The group takes Quincy's field box (`reui/input.tsx` FIELD_BOX: 38px, 44px at <=720px, `--radius-sm`, `border-border`, `--field-bg`).
 * - `focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50` removed and the input's `outline-none` dropped: the global
 *   `:focus-visible` outline is the one focus line (`reui/input.tsx` divergences 3 and 4).
 * - Stepper buttons hover on `bg-secondary` (`accent` is not a Quincy surface) and keep the group's radius.
 */
import type { ReactNode } from "react"
import { createContext, useContext, useId } from "react"
import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field"
import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { MinusIcon, PlusIcon } from "lucide-react"

const NumberFieldContext = createContext<{
  fieldId: string
  size: "sm" | "default" | "lg"
} | null>(null)

const numberFieldGroupVariants = cva(
  "relative flex w-full justify-between rounded-[var(--radius-sm)] border border-border bg-[var(--field-bg)] transition-colors data-disabled:pointer-events-none data-disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
  {
    variants: {
      // Ladders restored from the pre-rename source. Rhea was added after they
      // were written, so its rungs are new: rhea tracks nova here because
      // .cn-input is h-8 px-2.5 in both sheets, where luma is h-9 px-3.
      size: {
        sm: "min-h-8 text-sm",
        default: "min-h-[38px] max-[721px]:min-h-[44px] text-sm",
        lg: "min-h-10 text-sm",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
)

const numberFieldButtonVariants = cva(
  "relative flex shrink-0 cursor-pointer items-center justify-center transition-colors pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:bg-secondary",
  {
    variants: {
      size: {
        sm: ["px-1.5", "[&_svg:not([class*='size-'])]:size-3.5"],
        default:
          ["px-2", "[&_svg:not([class*='size-'])]:size-4"],
        lg: ["px-2.5", "[&_svg:not([class*='size-'])]:size-4"],
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
)

const numberFieldInputVariants = cva(
  "w-full min-w-0 flex-1 bg-transparent text-center tabular-nums",
  {
    variants: {
      size: {
        sm: "px-2 py-0.5",
        default: "px-2.5 py-1",
        lg: "px-2.5 py-1.5",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
)

function NumberField({
  id,
  className,
  size = "default",
  ...props
}: NumberFieldPrimitive.Root.Props &
  VariantProps<typeof numberFieldGroupVariants>) {
  const generatedId = useId()
  const fieldId = id ?? generatedId
  const sizeValue = size ?? "default"

  return (
    <NumberFieldContext.Provider value={{ fieldId, size: sizeValue }}>
      <NumberFieldPrimitive.Root
        className={cn("flex w-full flex-col items-start gap-2", className)}
        data-size={sizeValue}
        data-slot="number-field"
        id={fieldId}
        {...props}
      />
    </NumberFieldContext.Provider>
  )
}

function NumberFieldGroup({
  className,
  size: sizeProp,
  ...props
}: NumberFieldPrimitive.Group.Props &
  Partial<VariantProps<typeof numberFieldGroupVariants>>) {
  const context = useContext(NumberFieldContext)
  if (!context) {
    throw new Error(
      "NumberFieldGroup must be used within a NumberField component."
    )
  }
  const size = sizeProp ?? context.size

  return (
    <NumberFieldPrimitive.Group
      className={cn(numberFieldGroupVariants({ size }), className)}
      data-slot="number-field-group"
      {...props}
    />
  )
}

function NumberFieldDecrement({
  className,
  size: sizeProp,
  children,
  ...props
}: NumberFieldPrimitive.Decrement.Props &
  Partial<VariantProps<typeof numberFieldButtonVariants>> & {
    children?: React.ReactNode
  }) {
  const context = useContext(NumberFieldContext)
  if (!context) {
    throw new Error(
      "NumberFieldDecrement must be used within a NumberField component."
    )
  }
  const size = sizeProp ?? context.size

  return (
    <NumberFieldPrimitive.Decrement
      className={cn(
        numberFieldButtonVariants({ size }),
        "rounded-s-[var(--radius-sm)]",
        className
      )}
      data-slot="number-field-decrement"
      {...props}
    >
      {children ?? (
        <MinusIcon
        />
      )}
    </NumberFieldPrimitive.Decrement>
  )
}

function NumberFieldIncrement({
  className,
  size: sizeProp,
  children,
  ...props
}: NumberFieldPrimitive.Increment.Props &
  Partial<VariantProps<typeof numberFieldButtonVariants>> & {
    children?: ReactNode
  }) {
  const context = useContext(NumberFieldContext)
  if (!context) {
    throw new Error(
      "NumberFieldIncrement must be used within a NumberField component."
    )
  }
  const size = sizeProp ?? context.size

  return (
    <NumberFieldPrimitive.Increment
      className={cn(
        numberFieldButtonVariants({ size }),
        "rounded-e-[var(--radius-sm)]",
        className
      )}
      data-slot="number-field-increment"
      {...props}
    >
      {children ?? (
        <PlusIcon
        />
      )}
    </NumberFieldPrimitive.Increment>
  )
}

function NumberFieldInput({
  className,
  size: sizeProp,
  ...props
}: NumberFieldPrimitive.Input.Props &
  Partial<VariantProps<typeof numberFieldInputVariants>>) {
  const context = useContext(NumberFieldContext)
  if (!context) {
    throw new Error(
      "NumberFieldInput must be used within a NumberField component."
    )
  }
  const size = sizeProp ?? context.size

  return (
    <NumberFieldPrimitive.Input
      className={cn(numberFieldInputVariants({ size }), className)}
      data-slot="number-field-input"
      {...props}
    />
  )
}

export {
  NumberField,
  NumberFieldDecrement,
  NumberFieldIncrement,
  NumberFieldGroup,
  NumberFieldInput,
}