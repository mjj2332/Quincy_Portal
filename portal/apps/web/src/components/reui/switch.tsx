import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { cn } from "@/lib/utils"

/**
 * Switch primitive — base-nova's `switch`, fetched via `npx shadcn@latest add switch` into a
 * sandbox (`tmp/ReUI-Test-1`) for #219 (stage 1 of the Gantt vendor, PR A), registry version
 * matching `@base-ui/react` 1.7.0 in `portal/package.json`. Two mechanical edits: dropped the
 * registry's `"use client"` directive (meaningless in this Vite SPA) and imported `cn` from
 * `@/lib/utils` instead of the registry's raw `"cn"` package (see `reui/checkbox.tsx`'s header
 * for why that package must never be installed).
 * Quincy adaptation (#724): the off track is `bg-control-off`, not the registry's `bg-input` (a 1.6:1
 * hairline, under WCAG 1.4.11). No other change.
 */
function Switch({
  className,
  size = "default",
  ...props
}: SwitchPrimitive.Root.Props & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-all outline-none group-has-[:focus-visible]/field-label:border-transparent group-has-[:focus-visible]/field-label:ring-0 after:absolute after:-inset-x-3 after:-inset-y-2 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-[18.4px] data-[size=default]:w-[32px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px] data-checked:bg-primary data-unchecked:bg-control-off data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-full bg-background ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 group-data-[size=default]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=sm]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=default]/switch:data-unchecked:translate-x-0 group-data-[size=sm]/switch:data-unchecked:translate-x-0"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
