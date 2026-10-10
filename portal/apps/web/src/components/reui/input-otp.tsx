import * as React from "react"
import { OTPInput, OTPInputContext } from "input-otp"
import { MinusIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * base-nova `input-otp`, fetched through the sandbox (`tmp/ReUI-Test-1`, `npx shadcn@latest add input-otp`) for #741 slice 13c (the guest email code), registry version matching
 * `input-otp` 1.5.0 in `portal/package.json`. Adapted, per `docs/reui-reuse.md`:
 * - `"cn"` -> `@/lib/utils`; all `dark:` variants dropped (`reui-skin.guard.test.ts`; `styles/tokens/reui.css` rebinds `dark` to a class nothing sets).
 * - Quincy's field box: `rounded-lg` / `border-input` / `bg-input/30` / `size-8` are re-pointed to `--radius-sm`, `border-border`, `--field-bg` and a 44px slot (the field box's `max-[721px]`
 *   rung is 44px; 40px above it). The invalid ring uses `--destructive` at the token strength other fields use.
 * - The fake caret's `animate-caret-blink` keyframe does not exist in this app's tokens, so the caret uses `motion-safe:animate-pulse` (a stock Tailwind keyframe) instead.
 * - The active slot's `ring-3` is `ring-2`: the real input behind the slots is transparent, so this ring is the only focus indicator the guest sees.
 */
function InputOTP({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<typeof OTPInput> & {
  containerClassName?: string
}) {
  return (
    <OTPInput
      data-slot="input-otp"
      containerClassName={cn(
        "cn-input-otp flex items-center has-disabled:opacity-50",
        containerClassName
      )}
      spellCheck={false}
      className={cn("disabled:cursor-not-allowed", className)}
      {...props}
    />
  )
}

function InputOTPGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-otp-group"
      className={cn(
        "flex items-center rounded-[var(--radius-sm)] has-aria-invalid:border-destructive has-aria-invalid:ring-2 has-aria-invalid:ring-destructive/30",
        className
      )}
      {...props}
    />
  )
}

function InputOTPSlot({
  index,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  index: number
}) {
  const inputOTPContext = React.useContext(OTPInputContext)
  const { char, hasFakeCaret, isActive } = inputOTPContext?.slots[index] ?? {}

  return (
    <div
      data-slot="input-otp-slot"
      data-active={isActive}
      className={cn(
        "relative flex size-10 items-center justify-center border-y border-r border-border bg-[var(--field-bg)] text-sm transition-all outline-none first:rounded-l-[var(--radius-sm)] first:border-l last:rounded-r-[var(--radius-sm)] max-[721px]:size-11 aria-invalid:border-destructive data-[active=true]:z-10 data-[active=true]:border-ring data-[active=true]:ring-2 data-[active=true]:ring-ring/50 data-[active=true]:aria-invalid:border-destructive data-[active=true]:aria-invalid:ring-destructive/30",
        className
      )}
      {...props}
    >
      {char}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-4 w-px bg-foreground motion-safe:animate-pulse" />
        </div>
      )}
    </div>
  )
}

function InputOTPSeparator({ ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-otp-separator"
      className="flex items-center [&_svg:not([class*='size-'])]:size-4"
      role="separator"
      {...props}
    >
      <MinusIcon aria-hidden="true" />
    </div>
  )
}

export { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator }
