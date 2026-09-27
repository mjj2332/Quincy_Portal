import * as React from "react"
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"
import { cn } from "@/lib/utils"

/**
 * Scroll-area primitive — base-nova's `scroll-area`, fetched via
 * `npx shadcn@latest add scroll-area` into a sandbox (`tmp/ReUI-Test-1`) for #219 (stage 1 of the
 * Gantt vendor, PR A), registry version matching `@base-ui/react` 1.7.0 in `portal/package.json`.
 * One mechanical edit: `cn` imported from `@/lib/utils` instead of the registry's raw `"cn"`
 * package (see `reui/checkbox.tsx`'s header for why that package must never be installed). No
 * `"use client"` directive was present to drop.
 *
 * 2026-09-28 — `data-horizontal:` / `data-vertical:` → `data-[orientation=horizontal]:` /
 * `data-[orientation=vertical]:` in `ScrollBar`, the same fix `reui/tabs.tsx` item 4 made in #202.
 * Base UI 1.7.0's scrollbar emits `data-orientation="horizontal|vertical"`, never a bare
 * `data-horizontal`, so the registry's variants matched nothing: every scrollbar stayed a `flex-row`
 * with no size of its own. Horizontal: the thumb's `flex-1` (basis 0%) beat its inline
 * `width: var(--scroll-area-thumb-width)` and filled the whole track, and Base UI's translate then
 * pushed it past the ScrollArea's edge — the Gantt measured its wrapper 145–445px wider than itself
 * because of it (`gantt/gantt-view.tsx`'s header, same date). Vertical: the bar was 2px of padding
 * with a 0-wide thumb, i.e. invisible; it is now the registry's intended `w-2.5`, so every
 * ScrollArea (event calendar, cascader, Gantt) shows its vertical thumb again.
 */
function ScrollArea({
  className,
  children,
  ...props
}: ScrollAreaPrimitive.Root.Props) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none data-[orientation=horizontal]:h-2.5 data-[orientation=horizontal]:flex-col data-[orientation=horizontal]:border-t data-[orientation=horizontal]:border-t-transparent data-[orientation=vertical]:h-full data-[orientation=vertical]:w-2.5 data-[orientation=vertical]:border-l data-[orientation=vertical]:border-l-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.Scrollbar>
  )
}

export { ScrollArea, ScrollBar }
