/**
 * base-nova `progress` (Base UI `@base-ui/react/progress`), vendored through the sandbox (#377,
 * docs/reui-reuse.md). Quincy changes to the registry source:
 * - Drops `"use client"` (Vite SPA); `cn` imports from `@/lib/utils` (the sandbox's `"cn"` alias does not exist here).
 * - Track: `h-1 rounded-full bg-muted` becomes `h-[2px] rounded-none bg-surface-sunken`, the
 *   hairline-flat bar the Checklist rail calls for (#358).
 * - Indicator: `bg-primary` becomes `bg-[var(--accent)]`, so the fill is the token (`--ink-900`)
 *   and never a UA/`accent-color` green.
 * - Scoped `variant="tone"` (#923, the Dashboard Table and Board "N of M done"): a 4px track with a 2px radius and an
 *   indicator filled from `--progress-tone` (the Stage tone, set by `quincy/DoneProgress`). The default variant
 *   renders as before for every other caller.
 * `ProgressLabel` / `ProgressValue` are kept as registry exports; the checklist uses neither.
 */
import { Progress as ProgressPrimitive } from "@base-ui/react/progress"
import { cn } from "@/lib/utils"

function Progress({
  className,
  children,
  value,
  variant = "default",
  ...props
}: ProgressPrimitive.Root.Props & { variant?: "default" | "tone" }) {
  return (
    <ProgressPrimitive.Root
      value={value}
      data-slot="progress"
      className={cn("flex flex-wrap gap-3", className)}
      {...props}
    >
      {children}
      <ProgressTrack className={variant === "tone" ? "h-1 rounded-xs" : undefined}>
        <ProgressIndicator className={variant === "tone" ? "bg-[var(--progress-tone,var(--accent))]" : undefined} />
      </ProgressTrack>
    </ProgressPrimitive.Root>
  )
}

function ProgressTrack({ className, ...props }: ProgressPrimitive.Track.Props) {
  return (
    <ProgressPrimitive.Track
      className={cn(
        "relative flex h-[2px] w-full items-center overflow-x-hidden rounded-none bg-surface-sunken",
        className
      )}
      data-slot="progress-track"
      {...props}
    />
  )
}

function ProgressIndicator({
  className,
  ...props
}: ProgressPrimitive.Indicator.Props) {
  return (
    <ProgressPrimitive.Indicator
      data-slot="progress-indicator"
      className={cn("h-full bg-[var(--accent)] transition-all", className)}
      {...props}
    />
  )
}

function ProgressLabel({ className, ...props }: ProgressPrimitive.Label.Props) {
  return (
    <ProgressPrimitive.Label
      className={cn("text-sm font-medium", className)}
      data-slot="progress-label"
      {...props}
    />
  )
}

function ProgressValue({ className, ...props }: ProgressPrimitive.Value.Props) {
  return (
    <ProgressPrimitive.Value
      className={cn(
        "ml-auto text-sm text-muted-foreground tabular-nums",
        className
      )}
      data-slot="progress-value"
      {...props}
    />
  )
}

export {
  Progress,
  ProgressTrack,
  ProgressIndicator,
  ProgressLabel,
  ProgressValue,
}
