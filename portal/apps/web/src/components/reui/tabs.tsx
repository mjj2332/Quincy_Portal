import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Tabs primitive — base-nova's `tabs`, fetched via `npx shadcn@latest add tabs` into a sandbox
 * (`tmp/ReUI-Test-1`) for #202, registry version matching `@base-ui/react` 1.7.0 in
 * `portal/package.json`. Carried across with the conformance edits `reui/popover.tsx` documents:
 *
 * 1. **Drop `"use client"`** and import `cn` from `@/lib/utils` instead of the registry's raw
 *    `"cn"` — a Next.js directive has no meaning in this Vite SPA, and `"cn"` does not resolve
 *    here.
 *
 * 2. **Remove `TabsTrigger`'s focus ring** (`focus-visible:border-ring focus-visible:ring-[3px]
 *    focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring`) and
 *    `TabsContent`'s `outline-none`, the same removal as `reui/button.tsx` divergences 4 and 5:
 *    `tokens/base.css` paints an unlayered `:focus-visible { outline }` on every focusable, so the
 *    ring would double it and the `outline-*` utilities would merge with the global outline.
 * 3. **Forward `orientation` to `TabsPrimitive.Root`.** The registry source destructures it to set
 *    `data-orientation` and then drops it, so Base UI always ran horizontal keyboard navigation.
 *    Forwarding it makes the vertical variant its classes already style actually work.
 * 4. **`data-horizontal:` / `data-vertical:` → `data-[orientation=horizontal]:` /
 *    `data-[orientation=vertical]:`** (and the `group-data-…/tabs:` forms). Base UI 1.7.0 emits
 *    `data-orientation="horizontal|vertical"` (`TabsRootDataAttributes`), never a bare
 *    `data-horizontal` attribute, so the registry's variants matched nothing: the line-variant
 *    indicator had opacity but no geometry. Found by Sol's #202 diff review.
 *
 * This file has no Positioner/Popup (`z-50` does not apply), no Portal (no container context to
 * wire), no `@/components/ui/*` import, and no `outline-hidden` token, so none of `reui/popover.tsx`'s
 * other conformance edits apply.
 */

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      orientation={orientation}
      data-orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-[orientation=horizontal]/tabs:h-8 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start hover:text-foreground disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-sm group-data-[variant=line]/tabs-list:data-active:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
        "data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-[-5px] group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-sm", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
