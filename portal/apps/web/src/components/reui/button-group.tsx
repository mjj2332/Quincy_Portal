import * as React from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

import { Separator } from "@/components/reui/separator"

/**
 * Button-group primitive — base-nova's `button-group`, fetched via
 * `npx shadcn@latest add button-group` into a sandbox (`tmp/ReUI-Test-1`) for #219 (stage 1 of
 * the Gantt vendor, PR A), registry version matching `@base-ui/react` 1.7.0 in
 * `portal/package.json`. Four edits, the first two mechanical:
 *
 * 1. `cn` imported from `@/lib/utils` instead of the registry's raw `"cn"` package (see
 *    `reui/checkbox.tsx`'s header for why that package must never be installed).
 * 2. `@/components/ui/separator` repointed at `@/components/reui/separator`, the Quincy copy
 *    actually on disk (same reasoning as `reui/alert-dialog.tsx`'s header).
 * 3. **Added `import * as React from "react"`.** The registry source uses `React.ComponentProps`
 *    in `ButtonGroup`'s props type without importing `React` at all — every other vendored file
 *    in this directory that reaches for `React.ComponentProps` imports it explicitly (see
 *    `reui/item.tsx:1`); this one only compiled in the sandbox because some sibling module there
 *    happened to pull the ambient JSX global in first. `strict`/`isolatedModules` in this repo's
 *    `tsconfig.base.json` does not extend that grace to every file, so `tsc` reports `React` as
 *    unresolved without the import. No `"use client"` directive was present to drop.
 * 4. **2026-09-28 — `ButtonGroupSeparator`'s `data-horizontal:` / `data-vertical:` →
 *    `data-[orientation=horizontal]:` / `data-[orientation=vertical]:`**, the same fix
 *    `reui/tabs.tsx` item 4 made in #202, `reui/separator.tsx` got the same day, and
 *    `reui/scroll-area.tsx` gets in #279. Base UI 1.7.0's separator emits `data-orientation="horizontal|vertical"`, never
 *    a bare `data-horizontal` attribute, so the registry's `mx-px`/`w-auto`/`my-px`/`h-auto`
 *    matched nothing. Written against the real attribute, they now also land in tailwind-merge's
 *    conflict table beside `Separator`'s own `data-[orientation=horizontal]:w-full`, which `cn`
 *    therefore drops in favour of this `w-auto` (so the `mx-px` inset does not overflow the
 *    group). No app consumer renders `ButtonGroupSeparator` today;
 *    `button-group-separator-orientation.dom.test.tsx` pins the class contract.
 */
const buttonGroupVariants = cva(
  "flex w-fit items-stretch *:focus-visible:relative *:focus-visible:z-10 has-[>[data-slot=button-group]]:gap-2 has-[select[aria-hidden=true]:last-child]:[&>[data-slot=select-trigger]:last-of-type]:rounded-r-lg [&>[data-slot=select-trigger]:not([class*='w-'])]:w-fit [&>input]:flex-1",
  {
    variants: {
      orientation: {
        horizontal:
          "*:data-slot:rounded-r-none [&>[data-slot]:not(:has(~[data-slot]))]:rounded-r-lg! [&>[data-slot]~[data-slot]]:rounded-l-none [&>[data-slot]~[data-slot]]:border-l-0",
        vertical:
          "flex-col *:data-slot:rounded-b-none [&>[data-slot]:not(:has(~[data-slot]))]:rounded-b-lg! [&>[data-slot]~[data-slot]]:rounded-t-none [&>[data-slot]~[data-slot]]:border-t-0",
      },
    },
    defaultVariants: {
      orientation: "horizontal",
    },
  }
)

function ButtonGroup({
  className,
  orientation,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof buttonGroupVariants>) {
  return (
    <div
      role="group"
      data-slot="button-group"
      data-orientation={orientation}
      className={cn(buttonGroupVariants({ orientation }), className)}
      {...props}
    />
  )
}

function ButtonGroupText({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(
          "flex items-center gap-2 rounded-lg border bg-muted px-2.5 text-sm font-medium [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
          className
        ),
      },
      props
    ),
    render,
    state: {
      slot: "button-group-text",
    },
  })
}

function ButtonGroupSeparator({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="button-group-separator"
      orientation={orientation}
      className={cn(
        "relative self-stretch bg-input data-[orientation=horizontal]:mx-px data-[orientation=horizontal]:w-auto data-[orientation=vertical]:my-px data-[orientation=vertical]:h-auto",
        className
      )}
      {...props}
    />
  )
}

export {
  ButtonGroup,
  ButtonGroupSeparator,
  ButtonGroupText,
  buttonGroupVariants,
}
