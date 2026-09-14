import * as React from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"

import { cn } from "@/lib/utils"
import { OverlayContainerContext } from "@/components/OverlayContainerContext"

/**
 * Popover primitive — base-nova's `popover` (`docs/adr/0005-…` addendum), the first consumer
 * being `quincy/NotificationBell.tsx`'s panel. Fetched via `npx shadcn@latest add popover` into a
 * sandbox (`tmp/ReUI-Test-1`), diffed against the registry source, and carried across with five
 * conformance edits, none a behaviour change:
 *
 * 1. **Drop `"use client"`** and import `cn` from `@/lib/utils` instead of the registry's raw
 *    `"cn"`. Vendored siblings have neither (`reui/tooltip.tsx:1-4`, `reui/sheet.tsx:1-3`) — a
 *    Next.js directive has no meaning in this Vite SPA, and `"cn"` does not resolve here.
 * 2. **Positioner and Popup `z-50` → `z-[var(--z-popover)]`.** `.shell-header` is `z-index: 75`
 *    (`styles/app.css:69`); a bare `z-50` would sit under it. `--z-popover` (90,
 *    `tokens/spacing.css:60`) is the same token `reui/tooltip.tsx` and `quincy/menu.tsx` already
 *    reach for.
 * 3. **Portal container.** `container={useContext(OverlayContainerContext) ?? undefined}`, the
 *    same normalisation as `reui/tooltip.tsx:61` and `quincy/menu.tsx:112` — `null` is read by
 *    Base UI's Portal as "wait forever", so an explicit `undefined` falls back to
 *    `document.body`. Neither bell today renders inside a nested overlay (the rail's is in its
 *    own header; the narrow one is in `ShellHeader`'s content column, not `RailSheet`'s popup),
 *    so this is future-safe wiring, not a behaviour change for either call site.
 * 4. **Remove `outline-hidden`.** It is dead: a LAYERED Tailwind utility loses to the unlayered
 *    `:focus-visible { outline }` (`tokens/base.css:25-28`) regardless of specificity — the same
 *    removal as `reui/button.tsx` divergence 4 and `reui/sidebar.tsx`'s own focus-ring removal
 *    (`docs/adr/0005-…`). The registry source has no `focus-visible:ring*` classes, so nothing
 *    else needs to change alongside it.
 * 5. **Widen the `Pick`** on `PopoverContent`'s props to add `"collisionAvoidance" |
 *    "collisionPadding"` and forward both. Leaving either unset keeps Base UI's own defaults.
 *
 * `bg-popover`, `text-popover-foreground` and `ring-foreground/10` are kept: the panel portals to
 * `document.body`, outside any `[data-surface]` subtree, and all three roles are bridged
 * (`tokens/tailwind.css:24,27-28`) — `styles/sidebar-token-bridge.guard.test.ts`'s rail-surface
 * check reads only `NavigationRail.tsx` and `reui/sidebar.tsx`, not this file.
 *
 * Every `data-slot` is kept; `testing/test-seam.guard.test.ts` guard F forbids a DOM test from
 * selecting on one anyway. `animate-in`/`data-open`/`data-closed` classes are left as-is —
 * no-ops today, same as P1's sidebar/tooltip vendoring.
 */

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "center",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  collisionAvoidance,
  collisionPadding,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<
    PopoverPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "collisionAvoidance" | "collisionPadding"
  >) {
  const container = React.useContext(OverlayContainerContext) ?? undefined
  return (
    <PopoverPrimitive.Portal container={container}>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        collisionAvoidance={collisionAvoidance}
        collisionPadding={collisionPadding}
        className="isolate z-[var(--z-popover)]"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "z-[var(--z-popover)] flex w-72 origin-(--transform-origin) flex-col gap-2.5 rounded-lg bg-popover p-2.5 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-0.5 text-sm", className)}
      {...props}
    />
  )
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      data-slot="popover-title"
      className={cn("font-medium", className)}
      {...props}
    />
  )
}

function PopoverDescription({
  className,
  ...props
}: PopoverPrimitive.Description.Props) {
  return (
    <PopoverPrimitive.Description
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
}
