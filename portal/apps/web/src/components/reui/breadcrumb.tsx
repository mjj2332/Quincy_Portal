import * as React from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cn } from "@/lib/utils"
import { ChevronRightIcon, MoreHorizontalIcon } from "lucide-react"

// Vendored via `shadcn add breadcrumb` (base-nova) into the `tmp/ReUI-Test-1` sandbox
// (`src/components/vendor-112/breadcrumb.tsx`), then hand-applied here — #112. `breadcrumb` 404s
// against `components.json` the same way `sheet` and `sidebar` do (`docs/reui-reuse.md`), so this is
// base-nova's primitive rather than a registry pull.
//
// - `import { cn } from "cn"` -> `@/lib/utils`. Every upstream export is kept.
// - **One correction:** `BreadcrumbLink`'s `hover:text-foreground` becomes `hover:!text-foreground`.
//   `styles/tokens/base.css:21` has an unlayered `a { color: inherit }` rule, and unlayered author
//   CSS beats anything in Tailwind's `@layer utilities` regardless of specificity — the same reason
//   `reui/button.tsx`'s correction 2 marks every `text-COLOUR` variant `!`-prefixed. Without it the
//   hover here is a silent no-op on every real `<a>` this renders onto (`ShellHeader`'s breadcrumb,
//   via `InternalLink`).
// - `BreadcrumbPage`'s upstream `role="link" aria-disabled="true" aria-current="page"` is left as
//   shipped and audited, not stripped: `ShellHeader` overrides `role`/`aria-disabled` to `undefined`
//   at the call site for its own leaf segment (removing the attribute, since `{...props}` is spread
//   after these three in the JSX below) rather than this file dropping them outright, so a future
//   consumer that wants upstream's own "keep the leaf in the tab order" semantics still can.
function Breadcrumb({ className, ...props }: React.ComponentProps<"nav">) {
  return (
    <nav
      aria-label="breadcrumb"
      data-slot="breadcrumb"
      className={cn(className)}
      {...props}
    />
  )
}

function BreadcrumbList({ className, ...props }: React.ComponentProps<"ol">) {
  return (
    <ol
      data-slot="breadcrumb-list"
      className={cn(
        "flex flex-wrap items-center gap-1.5 text-sm wrap-break-word text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function BreadcrumbItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="breadcrumb-item"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  )
}

function BreadcrumbLink({
  className,
  render,
  ...props
}: useRender.ComponentProps<"a">) {
  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(
      {
        // Corrected: `hover:!text-foreground` — see the file header.
        className: cn("transition-colors hover:!text-foreground", className),
      },
      props
    ),
    render,
    state: {
      slot: "breadcrumb-link",
    },
  })
}

function BreadcrumbPage({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="breadcrumb-page"
      role="link"
      aria-disabled="true"
      aria-current="page"
      className={cn("font-normal text-foreground", className)}
      {...props}
    />
  )
}

function BreadcrumbSeparator({
  children,
  className,
  ...props
}: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="breadcrumb-separator"
      role="presentation"
      aria-hidden="true"
      className={cn("[&>svg]:size-3.5", className)}
      {...props}
    >
      {children ?? (
        <ChevronRightIcon />
      )}
    </li>
  )
}

function BreadcrumbEllipsis({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="breadcrumb-ellipsis"
      role="presentation"
      aria-hidden="true"
      className={cn(
        "flex size-5 items-center justify-center [&>svg]:size-4",
        className
      )}
      {...props}
    >
      <MoreHorizontalIcon
      />
      <span className="sr-only">More</span>
    </span>
  )
}

export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
}
