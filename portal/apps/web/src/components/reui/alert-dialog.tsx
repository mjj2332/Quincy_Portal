import * as React from "react"
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog"
import { cn } from "@/lib/utils"
import { InsideAlertDialogContext } from "@/lib/alert-dialog-press"

import { Button } from "@/components/reui/button"

/**
 * Alert-dialog primitive — base-nova's `alert-dialog`, fetched via
 * `npx shadcn@latest add alert-dialog` into a sandbox (`tmp/ReUI-Test-1`) for #219 (stage 1 of
 * the Gantt vendor, PR A), registry version matching `@base-ui/react` 1.7.0 in
 * `portal/package.json`. Three mechanical edits: dropped the registry's `"use client"` directive
 * (meaningless in this Vite SPA), imported `cn` from `@/lib/utils` instead of the registry's raw
 * `"cn"` package (see `reui/checkbox.tsx`'s header for why that package must never be installed),
 * and repointed `@/components/ui/button` at `@/components/reui/button` — this repo's alias
 * already resolves `ui` to `reui`, but the vendored source hard-codes the registry's own path, so
 * the import is rewritten to the Quincy copy actually on disk rather than left to resolve by
 * accident. No other change.
 *
 * #221 (2026-09-28): restyled on Quincy's Modal tokens — scrim, square panel, display-serif title,
 * Modal padding/footer, bottom sheet below 721px (≤720). The Gantt deadline confirm is its first production
 * consumer; the design review found the stock styling unlike every Portal dialog. Token choices
 * copied from `components/Modal.tsx` (SCRIM, panelClasses, TITLE, FOOT), not its implementation:
 * - Overlay: Modal's `--scrim-overlay` + 3px blur at `--z-dialog`; the base-ui open/close
 *   animation attributes are kept.
 * - Content: square, `bg-background`, hairline border, `--shadow-lg`, padded `--space-6` with
 *   `--space-4` gaps. Width: default 460px (Modal's default rung), `sm` keeps the vendor's
 *   `max-w-xs` (320px — Quincy does not redefine `--container-xs`). The vendor's
 *   `sm:max-w-sm` is gone: Quincy redefines `--container-sm/md` (tokens/spacing.css) to
 *   640/860px, so `max-w-sm` would resolve to 640px, not the stock 384px.
 * - Below 721px (≤720; `max-[721px]:` compiles to `width < 721px`): a bottom sheet like Modal — anchored to the bottom edge, full width, footer buttons
 *   stacked full width at 44px. The Popup is a SIBLING of the overlay here (not its child, as in
 *   Modal), so the sheet is positioned on the Popup itself.
 * - Header: left-aligned at every width for `size="default"` (the vendor centred it below its
 *   640px `sm`); `size="sm"` keeps the vendor's centred header.
 * - Footer: Modal's FOOT (hairline top rule, no tinted band, no rounded bottom). Because the
 *   content carries the padding, the footer pulls itself out by `--space-6` so the rule runs
 *   edge to edge like Modal's.
 *
 * #692: the footer's `size="sm"` grid switches at `min-[721px]:` (was `min-[722px]:`), the exact complement of the sheet's `max-[721px]:`; 722 left width 721 in neither variant.
 *
 * #625: `AlertDialogContent` provides `InsideAlertDialogContext` around its children, so a
 * `reui/popover` opened from inside the dialog (above it) is told apart from a popover beneath it,
 * which `popover.tsx`'s alert-dialog adaptation exempts from dismissal by presses on the dialog.
 * The overlay also cancels `mousedown`'s default: an alert dialog ignores scrim presses, and Base
 * UI never restores focus after one, so the press would leave focus on `<body>` with the dialog
 * still open — Shift+Tab then walks out into the app and closes popovers beneath. (`mousedown`,
 * not `pointerdown`: only the former's default moves focus. Touch taps emit one too.)
 *
 * #221 (2026-09-28, browser pass D): the overlay passes `forceRender` and carries
 * `data-testid="alert-dialog-scrim"`. `RailedShell` wraps every page in one `Sheet` (a Base UI
 * Dialog Root, closed on desktop), so any alert-dialog below it is "nested", and Base UI's
 * Backdrop renders only when `forceRender || !nested` — the restyled scrim never appeared.
 * `components/Modal.tsx` is unaffected: it draws its scrim with Floating UI, not a Base UI Root.
 */
function AlertDialog({ ...props }: AlertDialogPrimitive.Root.Props) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
}

function AlertDialogTrigger({ ...props }: AlertDialogPrimitive.Trigger.Props) {
  return (
    <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
  )
}

function AlertDialogPortal({ ...props }: AlertDialogPrimitive.Portal.Props) {
  return (
    <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
  )
}

function AlertDialogOverlay({
  className,
  onMouseDown,
  ...props
}: AlertDialogPrimitive.Backdrop.Props) {
  return (
    <AlertDialogPrimitive.Backdrop
      data-slot="alert-dialog-overlay"
      data-testid="alert-dialog-scrim"
      // Every Portal page sits inside RailedShell's `Sheet` Root, so Base UI treats this dialog as
      // nested and would skip its Backdrop (`enabled: forceRender || !nested`). See header, #221.
      forceRender
      // Keep focus inside the dialog on a scrim press. See header, #625.
      onMouseDown={(event) => {
        event.preventDefault()
        onMouseDown?.(event)
      }}
      className={cn(
        "fixed inset-0 isolate z-[var(--z-dialog)] bg-[var(--scrim-overlay)] backdrop-blur-[3px] duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogContent({
  className,
  size = "default",
  children,
  ...props
}: AlertDialogPrimitive.Popup.Props & {
  size?: "default" | "sm"
}) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Popup
        data-slot="alert-dialog-content"
        data-size={size}
        className={cn(
          "group/alert-dialog-content fixed top-1/2 left-1/2 z-[var(--z-dialog)] grid w-full -translate-x-1/2 -translate-y-1/2 gap-[var(--space-4)] p-[var(--space-6)] bg-background text-foreground border-solid border-[length:var(--border-width-hair)] border-border rounded-none shadow-[var(--shadow-lg)] max-h-[calc(100dvh-var(--space-7))] overflow-auto duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          // Width rung as a plain (unprefixed) utility, not `data-[size=…]:max-w-*`: an attribute
          // variant out-specifies both a consumer's `max-w-[560px]` and the sheet's
          // `max-[721px]:max-w-none` below, and tailwind-merge only collapses same-variant pairs.
          size === "sm" ? "max-w-xs" : "max-w-[460px]",
          // Below 721px (≤720): Modal's bottom sheet — pinned to the bottom edge, full width.
          "max-[721px]:top-auto max-[721px]:bottom-0 max-[721px]:left-0 max-[721px]:translate-x-0 max-[721px]:translate-y-0 max-[721px]:max-w-none max-[721px]:max-h-[85dvh]",
          className
        )}
        {...props}
      >
        <InsideAlertDialogContext.Provider value={true}>
          {children}
        </InsideAlertDialogContext.Provider>
      </AlertDialogPrimitive.Popup>
    </AlertDialogPortal>
  )
}

function AlertDialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn(
        "grid grid-rows-[auto_1fr] gap-[var(--space-2)] has-data-[slot=alert-dialog-media]:grid-rows-[auto_auto_1fr] has-data-[slot=alert-dialog-media]:gap-x-[var(--space-4)] group-data-[size=sm]/alert-dialog-content:place-items-center group-data-[size=sm]/alert-dialog-content:text-center group-data-[size=default]/alert-dialog-content:place-items-start group-data-[size=default]/alert-dialog-content:text-left group-data-[size=default]/alert-dialog-content:has-data-[slot=alert-dialog-media]:grid-rows-[auto_1fr]",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        "-mx-[var(--space-6)] -mb-[var(--space-6)] flex flex-wrap justify-end gap-[var(--space-3)] px-[var(--space-6)] py-[var(--space-5)] [border-top-style:solid] border-t-[length:var(--border-width-hair)] border-t-border min-[721px]:group-data-[size=sm]/alert-dialog-content:grid min-[721px]:group-data-[size=sm]/alert-dialog-content:grid-cols-2 max-[721px]:flex-col-reverse max-[721px]:[&>*]:w-full max-[721px]:[&>*]:min-h-[44px]",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogMedia({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-media"
      className={cn(
        "mb-2 inline-flex size-10 items-center justify-center rounded-md bg-muted group-data-[size=default]/alert-dialog-content:row-span-2 *:[svg:not([class*='size-'])]:size-6",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn(
        "m-0 [font:var(--type-h3)] tracking-[var(--tracking-tight)] text-pretty group-data-[size=default]/alert-dialog-content:group-has-data-[slot=alert-dialog-media]/alert-dialog-content:col-start-2",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn(
        "m-0 text-[length:var(--text-sm)] leading-[var(--leading-normal)] text-muted-foreground text-pretty *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogAction({
  className,
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button
      data-slot="alert-dialog-action"
      className={cn(className)}
      {...props}
    />
  )
}

function AlertDialogCancel({
  className,
  variant = "outline",
  size = "default",
  ...props
}: AlertDialogPrimitive.Close.Props &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <AlertDialogPrimitive.Close
      data-slot="alert-dialog-cancel"
      className={cn(className)}
      render={<Button variant={variant} size={size} />}
      {...props}
    />
  )
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
}
