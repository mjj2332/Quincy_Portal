/*
 * Vendored from `@reui/frame` (base-nova) via the tmp/ReUI-Test-1 sandbox (#420, ADR 0014).
 *
 * Changes from the registry source, and why:
 * - `cn` import -> `@/lib/utils`.
 * - The roles --frame-radius, --frame-panel-radius, --frame-gap, --frame-border-color,
 *   --frame-panel-border-color and --frame-panel-bg are no longer declared inline by the cva. The
 *   registry pointed them at --radius-xl / --color-card / --color-border, which are nova's rungs,
 *   not Quincy's. They are bridged to Quincy tokens in `styles/tokens/reui.css` instead, and
 *   `styles/frame-token-bridge.guard.test.ts` checks every consumed role is bridged. A
 *   per-element declaration here would shadow that bridge, so do not re-add one.
 * - The concentric panel radius calc() and `ghost`'s variant of it are dropped: Quincy's radius is
 *   `0` (a unitless number), and calc(0 - 3px) is invalid CSS. The panel radius is its own bridged
 *   role (square, like the frame). `dense` still pins it to the frame radius.
 * - FramePanel: `shadow-xs` (Quincy shadows are overlay-only), the `before:` inner-shadow overlay
 *   and its `dark:` classes are removed (reui-skin.guard.test.ts). The overlay carried no shadow
 *   size, so it painted nothing.
 */
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Frame sets --frame-panel-bg and --frame-panel-border-color; FramePanel reads
 * them back as bg-(--frame-panel-bg) and border-(--frame-panel-border-color).
 * So variant="inverse" re-points every panel from one place, and a consumer's
 * own bg-* on a panel still wins on source order, with no :not() and no `!`.
 */
const frameVariants = cva(
  [
    "relative flex flex-col bg-muted/50 gap-(--frame-gap) px-(--frame-px) py-(--frame-py) rounded-(--frame-radius)",
    // --frame-radius, --frame-panel-radius, --frame-gap and the three colour roles are NOT
    // declared here: they are bridged to Quincy tokens in styles/tokens/reui.css.
    "[--frame-px:--spacing(0.75)] [--frame-py:--spacing(0.75)] [--frame-panel-header-gap:0rem] [--frame-panel-footer-gap:--spacing(1)]",
    "[--frame-panel-px-adjust:0px] [--frame-panel-py-adjust:0px] [--frame-panel-header-px-adjust:0px] [--frame-panel-header-py-adjust:0px] [--frame-panel-footer-px-adjust:0px] [--frame-panel-footer-py-adjust:0px]",
    "[--frame-panel-px:calc(var(--frame-panel-px-base)+var(--frame-panel-px-adjust))] [--frame-panel-py:calc(var(--frame-panel-py-base)+var(--frame-panel-py-adjust))] [--frame-panel-header-px:calc(var(--frame-panel-header-px-base)+var(--frame-panel-header-px-adjust))] [--frame-panel-header-py:calc(var(--frame-panel-header-py-base)+var(--frame-panel-header-py-adjust))] [--frame-panel-footer-px:calc(var(--frame-panel-footer-px-base)+var(--frame-panel-footer-px-adjust))] [--frame-panel-footer-py:calc(var(--frame-panel-footer-py-base)+var(--frame-panel-footer-py-adjust))]",
  ],
  {
    variants: {
      variant: {
        default: "border border-[var(--frame-border-color)] bg-clip-padding",
        inverse:
          "[--frame-panel-bg:color-mix(in_oklch,var(--color-muted)_40%,transparent)] border border-[var(--frame-border-color)] bg-background bg-clip-padding",
        ghost: "",
      },
      // Bars read as chrome, not a second content block: py runs 0.5/1.5/2/2.5
      // against a body py of 2/3.5/4/5, while px stays level with the body so
      // header, content and footer left-align. xs floors at 0.5 (2px), below
      // which it stops reading as padding. No style-*.css overrides these.
      spacing: {
        xs: "[--frame-panel-px-base:--spacing(2)] [--frame-panel-py-base:--spacing(2)] [--frame-panel-header-px-base:--spacing(2)] [--frame-panel-header-py-base:--spacing(0.5)] [--frame-panel-footer-px-base:--spacing(2)] [--frame-panel-footer-py-base:--spacing(0.5)]",
        sm: "[--frame-panel-px-base:--spacing(3)] [--frame-panel-py-base:--spacing(3.5)] [--frame-panel-header-px-base:--spacing(3)] [--frame-panel-header-py-base:--spacing(1.5)] [--frame-panel-footer-px-base:--spacing(3)] [--frame-panel-footer-py-base:--spacing(1.5)]",
        default:
          "[--frame-panel-px-base:--spacing(4)] [--frame-panel-py-base:--spacing(4)] [--frame-panel-header-px-base:--spacing(4)] [--frame-panel-header-py-base:--spacing(2)] [--frame-panel-footer-px-base:--spacing(4)] [--frame-panel-footer-py-base:--spacing(2)]",
        lg: "[--frame-panel-px-base:--spacing(5)] [--frame-panel-py-base:--spacing(5)] [--frame-panel-header-px-base:--spacing(5)] [--frame-panel-header-py-base:--spacing(2.5)] [--frame-panel-footer-px-base:--spacing(5)] [--frame-panel-footer-py-base:--spacing(2.5)]",
      },
      stacked: {
        true: [
          "gap-0 *:has-[+[data-slot=frame-panel]]:rounded-b-none",
          "*:has-[+[data-slot=frame-panel]]:before:hidden",
          "*:[[data-slot=frame-panel]+[data-slot=frame-panel]]:rounded-t-none",
          "*:[[data-slot=frame-panel]+[data-slot=frame-panel]]:border-t-0",
        ],
        false: [
          "data-[spacing=sm]:*:[[data-slot=frame-panel]+[data-slot=frame-panel]]:mt-0.5",
          "data-[spacing=default]:*:[[data-slot=frame-panel]+[data-slot=frame-panel]]:mt-1",
          "data-[spacing=lg]:*:[[data-slot=frame-panel]+[data-slot=frame-panel]]:mt-2",
        ],
      },
      dense: {
        // Parent selectors, not CSS vars: these are positional. Panels are
        // pulled flush (-mx-px), so corners align with the frame's own radius.
        true: "p-0 gap-0 border-[var(--frame-border-color)] [--frame-panel-radius:var(--frame-radius)] [&_[data-slot=frame-panel]]:-mx-px [&_[data-slot=frame-panel]]:before:hidden [&_[data-slot=frame-panel]:last-child]:-mb-px [&:not(:has([data-slot=frame-panel-header]))_[data-slot=frame-panel]:is(:first-child)]:-mt-px",
        false: "",
      },
    },
    defaultVariants: {
      variant: "default",
      spacing: "default",
      stacked: false,
      dense: false,
    },
  }
)

function Frame({
  className,
  variant,
  spacing,
  stacked,
  dense,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof frameVariants>) {
  return (
    <div
      className={cn(
        frameVariants({ variant, spacing, stacked, dense }),
        className
      )}
      data-slot="frame"
      data-spacing={spacing}
      {...props}
    />
  )
}

function FramePanel({
  className,
  fit,
  ...props
}: React.ComponentProps<"div"> & { fit?: boolean }) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-(--frame-panel-radius) border border-(--frame-panel-border-color) bg-(--frame-panel-bg) bg-clip-padding",
        // `fit` sizes the panel to its content; otherwise it grows to fill the frame.
        !fit && "grow",
        "px-(--frame-panel-px) py-(--frame-panel-py)",
        className
      )}
      data-slot="frame-panel"
      {...props}
    />
  )
}

function FrameHeader({ className, ...props }: React.ComponentProps<"header">) {
  return (
    <header
      className={cn(
        "flex flex-col gap-(--frame-panel-header-gap) px-(--frame-panel-header-px) py-(--frame-panel-header-py)",
        className
      )}
      data-slot="frame-panel-header"
      {...props}
    />
  )
}

function FrameTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("text-sm font-semibold", className)}
      data-slot="frame-panel-title"
      {...props}
    />
  )
}

function FrameDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="frame-panel-description"
      {...props}
    />
  )
}

function FrameFooter({ className, ...props }: React.ComponentProps<"footer">) {
  return (
    <footer
      className={cn(
        "flex flex-col gap-(--frame-panel-footer-gap) px-(--frame-panel-footer-px) py-(--frame-panel-footer-py)",
        className
      )}
      data-slot="frame-panel-footer"
      {...props}
    />
  )
}

export {
  Frame,
  FramePanel,
  FrameHeader,
  FrameTitle,
  FrameDescription,
  FrameFooter,
  frameVariants,
}