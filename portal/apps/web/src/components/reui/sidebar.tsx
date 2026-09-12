import * as React from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Sidebar primitive — #111.
 *
 * ## Where this came from, and why it is not a registry install
 *
 * The ReUI registry has no `sidebar` component. `sidebar`, `sheet` and `tooltip` all 404 against
 * the registry in `components.json`, while `kanban` and `badge` return 200 with the same key — so
 * this is a genuine gap in the registry, not a licence or URL problem. (`tokens/reui.css`'s header
 * says "whoever installs @reui/sidebar must read its variants and bridge the roles by hand"; that
 * instruction was written on the assumption the component existed. It does not.)
 *
 * The owner's decision was to vendor shadcn's `new-york-v4` sidebar into `tmp/` (gitignored) as a
 * REFERENCE and carry across only the parts this app needs, rather than re-invent the structure.
 * That reference has 24 exports; 13 survive here. **Do NOT run the shadcn CLI against this app** to
 * "complete" the set — the discards below are deliberate, and several of them depend on primitives
 * this app does not have.
 *
 * ## What was discarded, and why
 *
 * - `SidebarProvider` / `useSidebar` — a React context, a `document.cookie` write and a ⌘B key
 *   handler. Screens in this app are rendered standalone by their own DOM tests with no provider
 *   of any kind, so a context-dependent primitive cannot be mounted by them (the #110 precedent:
 *   module-level store + `useSyncExternalStore`, `lib/toast-store.ts`). Collapse arrives in a
 *   later ticket and will bring its own state mechanism.
 * - `SidebarTrigger`, `SidebarRail`, `SidebarInset` — collapse affordances and the content-area
 *   wrapper, all of which read that context.
 * - Everything Sheet- or Tooltip-shaped — the mobile off-canvas branch of `Sidebar`, and
 *   `SidebarMenuButton`'s `tooltip` prop. Neither primitive exists in this app (see the 404 note
 *   above); the mobile presentation is its own ticket.
 * - `SidebarInput`, `SidebarSeparator`, `SidebarMenuSkeleton`, `SidebarGroupAction`,
 *   `SidebarMenuAction`, `SidebarMenuBadge` — no consumer in the rail this ticket builds. The
 *   orphan guard does not watch `reui/`, so nothing else would report them as dead weight.
 * - Every `group-data-[collapsible=icon]:…` variant. Those selectors only do anything under the
 *   provider's wrapper, which is discarded, so shipping them would mean shipping selectors that
 *   silently never match. The collapse ticket re-adds them where they can be tested.
 *
 * ## Divergences from the reference, beyond the deletions
 *
 * 1. Radix `Slot.Root` + `asChild` becomes Base UI `useRender` + `mergeProps` + `render`, matching
 *    `reui/item.tsx` and `reui/kanban.tsx`. This is what lets the rail pass `InternalLink` as the
 *    rendered element — mandatory here, because `lib/staff-history.ts` gives the router a
 *    read-only history and a plain `<a href>` full-page-reloads (see CLAUDE.md and
 *    `lib/routing-transport.guard.test.ts`).
 * 2. `lucide-react` is not a dependency; no icon is imported. Icons are the consumer's business.
 * 3. **The focus ring is removed** — `outline-hidden`, `ring-sidebar-ring` and
 *    `focus-visible:ring-2`. `tokens/base.css:25` declares an unlayered
 *    `:focus-visible { outline: … }` that beats Tailwind's `@layer utilities`, so `outline-hidden`
 *    suppresses nothing while the ring paints a SECOND indicator beside the global outline that
 *    tailwind-merge cannot collapse against it (`box-shadow` vs `outline`). This is the same
 *    correction already recorded in `reui/badge.tsx` (correction 2) and `reui/button.tsx`
 *    (divergence 5), and it is why `--sidebar-ring` is not among the bridged roles.
 * 4. `sidebarMenuButtonVariants`' `outline` variant is dropped: its only consumer would be a
 *    bordered nav button the design does not use, and it reads `bg-background` — a role
 *    `tokens/inverse.css` re-scopes, which AC6 of #111 forbids the rail from depending on.
 * 5. `w-(--sidebar-width)` is dropped from the root. Width is layout, not a colour role, and the
 *    rail's 250px belongs to the rail. Dropping it also keeps `--sidebar-width` from becoming a
 *    phantom token that the CSS-only phantom guard could not see.
 *
 * The `--sidebar*` colour roles this file consumes are bridged in `styles/tokens/reui.css` and
 * held to that file by `styles/sidebar-token-bridge.guard.test.ts`, which reads THIS file to
 * discover them. Add a `bg-sidebar-*` utility here and the guard will require the bridge.
 */

function Sidebar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar"
      className={cn(
        "flex h-full flex-col bg-sidebar text-sidebar-foreground",
        className
      )}
      {...props}
    />
  )
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      className={cn("flex flex-col gap-2 p-2", className)}
      {...props}
    />
  )
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn("flex min-h-0 flex-1 flex-col gap-2 overflow-auto", className)}
      {...props}
    />
  )
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      className={cn("flex flex-col gap-2 p-2", className)}
      {...props}
    />
  )
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group"
      className={cn("relative flex w-full min-w-0 flex-col p-2", className)}
      {...props}
    />
  )
}

function SidebarGroupLabel({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(
          "flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 transition-[margin,opacity] duration-200 ease-linear [&>svg]:size-4 [&>svg]:shrink-0",
          className
        ),
      },
      props
    ),
    render,
    state: { slot: "sidebar-group-label" },
  })
}

function SidebarGroupContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group-content"
      className={cn("w-full text-sm", className)}
      {...props}
    />
  )
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      className={cn("flex w-full min-w-0 flex-col gap-1", className)}
      {...props}
    />
  )
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-item"
      className={cn("group/menu-item relative", className)}
      {...props}
    />
  )
}

const sidebarMenuButtonVariants = cva(
  "peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm transition-[width,height,padding] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      size: {
        default: "h-8 text-sm",
        sm: "h-7 text-xs",
        lg: "h-12 text-sm",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
)

function SidebarMenuButton({
  className,
  isActive = false,
  size = "default",
  render,
  ...props
}: useRender.ComponentProps<"button"> &
  VariantProps<typeof sidebarMenuButtonVariants> & { isActive?: boolean }) {
  // Hoisted rather than passed as a literal: `mergeProps<"button">`'s first parameter is a union,
  // so TypeScript's excess-property check rejects `data-*` keys on a FRESH object literal there
  // (TS2353) and accepts the same object through a variable. `reui/kanban.tsx` does the same.
  //
  // `data-active` is written explicitly and is deliberately NOT put in `state` below. Base UI's
  // default state mapping renders a boolean as a valueless attribute (`data-active=""`), which the
  // `data-[active=true]:` variants in the cva string would not match — the active paint would
  // vanish silently. React renders this prop as `data-active="true"` / `"false"`.
  const defaultProps = {
    "data-size": size,
    "data-active": isActive,
    className: cn(sidebarMenuButtonVariants({ size }), className),
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
    state: { slot: "sidebar-menu-button" },
  })
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu-sub"
      className={cn(
        "mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-l border-sidebar-border px-2.5 py-0.5",
        className
      )}
      {...props}
    />
  )
}

function SidebarMenuSubItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-sub-item"
      className={cn("group/menu-sub-item relative", className)}
      {...props}
    />
  )
}

function SidebarMenuSubButton({
  className,
  isActive = false,
  size = "md",
  render,
  ...props
}: useRender.ComponentProps<"a"> & {
  isActive?: boolean
  size?: "sm" | "md"
}) {
  // Same two reasons as `SidebarMenuButton` above: TS2353 on a fresh literal, and `data-active`
  // kept out of `state` so the `data-[active=true]:` variants keep matching.
  const defaultProps = {
    "data-size": size,
    "data-active": isActive,
    className: cn(
      "flex h-7 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-md px-2 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-accent-foreground",
      size === "sm" && "text-xs",
      size === "md" && "text-sm",
      className
    ),
  };

  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(defaultProps, props),
    render,
    state: { slot: "sidebar-menu-sub-button" },
  })
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  sidebarMenuButtonVariants,
}
