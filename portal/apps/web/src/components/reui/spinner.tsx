/**
 * ReUI `@reui/filters` (#255), vendored from `npx shadcn@latest add @reui/filters --yes --path
 * src/components/vendor-255` in the `tmp/ReUI-Test-1` base-nova sandbox (the sandbox install is the
 * source of truth; the ReUI MCP was not available to the installing agent). Mechanical edits, identical
 * in kind across every file of this item (`components/reui/filters/`, `components/reui/cascader/`,
 * `components/reui/spinner.tsx`):
 *
 * 1. Dropped the registry's `"use client"` directive (meaningless in this Vite SPA).
 * 2. `cn` imported from `@/lib/utils` instead of the registry's raw `"cn"` package.
 * 3. Cross-file imports repointed from `@/components/vendor-255/<name>` to this item's real home
 *    (`@/components/reui/filters/<name>`, `@/components/reui/cascader/<name>`,
 *    `@/components/reui/spinner`), and `@/components/ui/<name>` to Quincy's own adapted copies in
 *    `@/components/reui/<name>` (`button`, `button-group`, `dropdown-menu`, `input`, `popover`,
 *    `scroll-area`, `separator`, `tooltip` — the vendored duplicates of those were NOT copied).
 *
 * Left out of the install on purpose: `cascader-virtual.tsx` (imports `@tanstack/react-virtual`, a
 * new production dependency — see `filters-builder.tsx`), `cascader-columns.tsx` (imported only by
 * `cascader-virtual.tsx`), and `filters-date.tsx` (nothing imports it).
 *
 * No file-specific edits.
 */
import { cn } from "@/lib/utils"
import { Loader2Icon } from "lucide-react"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon data-slot="spinner" role="status" aria-label="Loading" className={cn("size-4 animate-spin", className)} {...props} />
  )
}

export { Spinner }
