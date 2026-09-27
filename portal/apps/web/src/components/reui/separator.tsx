import { Separator as SeparatorPrimitive } from "@base-ui/react/separator"
import { cn } from "@/lib/utils"

/**
 * Separator primitive — base-nova's `separator`, installed with the form, table and tab primitives
 * in #53.
 *
 * 2026-09-28 — `data-horizontal:` / `data-vertical:` → `data-[orientation=horizontal]:` /
 * `data-[orientation=vertical]:`, the same fix `reui/tabs.tsx` item 4 made in #202 (and
 * `reui/scroll-area.tsx`'s `ScrollBar` got the same day). Base UI 1.7.0's separator emits
 * `data-orientation="horizontal|vertical"` (plus `role="separator"` and `aria-orientation`), never
 * a bare `data-horizontal`, so the registry's variants matched nothing: every separator was a
 * `shrink-0 bg-border` box with no size of its own. Horizontal: a block with no content, so 0px
 * tall — the account menu's separator in `quincy/NavigationRail.tsx` (#122) was only its
 * `my-[var(--space-1)]` gap, with no line. It is now the intended 1px `bg-border` rule. Vertical:
 * 0px wide; it is now `w-px` and stretches with its row. No other consumer renders today —
 * `ItemSeparator`, `FieldSeparator`, `SidebarSeparator` and `ButtonGroupSeparator` are unused.
 */
function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
