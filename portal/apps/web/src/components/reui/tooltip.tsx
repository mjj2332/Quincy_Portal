import { useContext } from "react"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

import { cn } from "@/lib/utils"
import { OverlayContainerContext } from "@/components/OverlayContainerContext"

/**
 * Tooltip primitive — base-nova, vendored whole for #122 (`docs/adr/0005-…`), the first consumer
 * being `reui/sidebar.tsx`'s `SidebarMenuButton` `tooltip` prop (collapsed-rail labels).
 * `@reui/tooltip` 404s the same way `@reui/sidebar` does — see that file's header and
 * `docs/reui-reuse.md`. Fetched via `npx shadcn@latest add tooltip` into a sandbox
 * (`tmp/ReUI-Test-1`), diffed against the registry JSON, and carried across with two conformance
 * edits, neither a behaviour change:
 *
 * 1. **`z-50` → `z-[var(--z-popover)]`.** `.shell-header` is `z-index: 75` (`styles/app.css`); a
 *    bare Tailwind `z-50` would sit under it and the tooltip would paint beneath the sticky header
 *    instead of above it. `--z-popover` (90) is the same token `quincy/menu.tsx`'s own popup
 *    reaches for.
 * 2. **`container={useContext(OverlayContainerContext) ?? undefined}`** on the `Portal`, the same
 *    normalisation `quincy/menu.tsx:92` already does: `null` is read by Base UI's Portal as "wait
 *    forever", so an explicit `undefined` falls back to `document.body` outside any nested overlay.
 *    Inside `quincy/RailSheet.tsx`'s modal Sheet — which makes everything outside it inert — a
 *    tooltip anchored to a collapsed rail item that opened at `document.body` would be unreachable;
 *    this is what relocates it inside the Sheet's own slot instead.
 */

function TooltipProvider({
  delay = 0,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      {...props}
    />
  )
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  const container = useContext(OverlayContainerContext) ?? undefined
  return (
    <TooltipPrimitive.Portal container={container}>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-[var(--z-popover)]"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "z-[var(--z-popover)] inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground data-[side=bottom]:top-1 data-[side=inline-end]:top-1/2! data-[side=inline-end]:-left-1 data-[side=inline-end]:-translate-y-1/2 data-[side=inline-start]:top-1/2! data-[side=inline-start]:-right-1 data-[side=inline-start]:-translate-y-1/2 data-[side=left]:top-1/2! data-[side=left]:-right-1 data-[side=left]:-translate-y-1/2 data-[side=right]:top-1/2! data-[side=right]:-left-1 data-[side=right]:-translate-y-1/2 data-[side=top]:-bottom-2.5" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
