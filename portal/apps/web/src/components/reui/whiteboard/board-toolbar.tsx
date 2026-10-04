/**
 * ReUI `@reui/whiteboard-1` (Pro block; Excalidraw), vendored for #498 through the sandbox
 * (`tmp/ReUI-Test-1`, `--path src/components/vendor-498`), never `shadcn add` in apps/web. Mechanical edits
 * in every file of the set: `cn` from `@/lib/utils` (not the registry's raw `"cn"`), imports repointed to
 * `@/components/reui/`, the `"use client"` directive dropped, the Skin guard's strips (`dark:` variants,
 * Tailwind `shadow-*`, focus ring widths -- see `reui-skin.guard.test.ts`), and `noUncheckedIndexedAccess`
 * narrowing. `"dark": boolean` is quoted only so the guard's `dark:` matcher does not read a type as a variant.
 *
 * This file: The board header. Edit (additive): a `title` prop replaces the registry's hard-coded demo title (`BOARD.title`).
 */
import { useId } from "react"
import { cn } from "@/lib/utils"

import { Button } from "@/components/reui/button"
import { Separator } from "@/components/reui/separator"
import { Spinner } from "@/components/reui/spinner"
import { Toggle } from "@/components/reui/toggle"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/reui/tooltip"
import type { WhiteboardSaveStatus } from "./whiteboard"
import { TriangleAlertIcon, CloudUploadIcon, CheckIcon, PanelRightIcon, DownloadIcon } from "lucide-react"

const STATUS_LABEL: Record<WhiteboardSaveStatus, string> = {
  saved: "Saved",
  unsaved: "Unsaved",
  saving: "Saving",
  error: "Save failed",
}

const STATES = [
  "saved",
  "unsaved",
  "saving",
  "error",
] as const satisfies readonly WhiteboardSaveStatus[]

/** One fixed slot: every icon and label stays mounted and only its visibility changes,
 * so the status never remounts an icon or resizes as a save runs. */
function SaveStatus({ status }: { status: WhiteboardSaveStatus }) {
  // Screen readers hear outcomes only, never the Unsaved and Saving on the way.
  const outcome = status === "saved" || status === "error"
  return (
    <span
      data-status={status}
      className="text-muted-foreground data-[status=error]:text-destructive flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap"
    >
      <span role="status" aria-live="polite" className="sr-only">
        {outcome ? STATUS_LABEL[status] : ""}
      </span>
      <span
        aria-hidden="true"
        className="flex size-4 shrink-0 items-center justify-center"
      >
        <Spinner
          role="presentation"
          aria-hidden="true"
          className={cn(status !== "saving" && "hidden")}
        />
        <TriangleAlertIcon className={cn("size-4", status !== "error" && "hidden")} aria-hidden="true" />
        <CloudUploadIcon className={cn("size-4", status !== "unsaved" && "hidden")} aria-hidden="true" />
        <CheckIcon className={cn("size-4", status !== "saved" && "hidden")} aria-hidden="true" />
      </span>
      {/* Every label in one cell, so the slot is as wide as the longest. */}
      <span aria-hidden="true" className="grid @max-sm/header:hidden">
        {STATES.map((key) => (
          <span
            key={key}
            className={cn(
              "col-start-1 row-start-1",
              key !== status && "invisible"
            )}
          >
            {STATUS_LABEL[key]}
          </span>
        ))}
      </span>
    </span>
  )
}

const PANEL_ICON = (
  <PanelRightIcon aria-hidden="true" />
)

/**
 * The panel's one control: a Toggle while the panel docks, a Button that opens the sheet
 * below that. The name stays the panel's; the tooltip says what a press does.
 */
function PanelToggle({
  label,
  panelId,
  docked,
  dockOpen,
  sheetOpen,
  onPanel,
}: {
  label: string
  /** The docked aside's id, referenced only while it is mounted. */
  panelId: string
  docked: boolean
  dockOpen: boolean
  sheetOpen: boolean
  onPanel: () => void
}) {
  // Keyed by mode: a swapped trigger element would keep its tooltip bound to the old one.
  return docked ? (
    <Tooltip key="dock">
      <TooltipTrigger
        render={
          <Toggle
            className="px-0"
            aria-label={label}
            aria-controls={dockOpen ? panelId : undefined}
            pressed={dockOpen}
            onPressedChange={onPanel}
          />
        }
      >
        {PANEL_ICON}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {dockOpen ? "Hide Panel" : "Show Panel"}
      </TooltipContent>
    </Tooltip>
  ) : (
    <Tooltip key="sheet">
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={label}
            aria-haspopup="dialog"
            aria-expanded={sheetOpen}
            onClick={onPanel}
          />
        }
      >
        {PANEL_ICON}
      </TooltipTrigger>
      <TooltipContent side="bottom">Show Panel</TooltipContent>
    </Tooltip>
  )
}

/**
 * The board's own header: title, save state and board actions, no app chrome. A named
 * landmark: mount the block inside your app's <main>, as an app shell's content area is.
 */
export function BoardToolbar({
  title,
  status,
  presence,
  share,
  panelId,
  docked,
  dockOpen,
  sheetOpen,
  onPanel,
  exportDisabled,
  onExport,
}: {
  /** #498: the host's board name (the registry hard-codes a demo's). */
  title: string
  status: WhiteboardSaveStatus
  presence: React.ReactNode
  share: React.ReactNode
  panelId: string
  /** The panel docks beside the canvas; below that the toggle opens a sheet. */
  docked: boolean
  dockOpen: boolean
  sheetOpen: boolean
  onPanel: () => void
  exportDisabled: boolean
  onExport: () => void
}) {
  const titleId = useId()
  return (
    <header
      aria-labelledby={titleId}
      className="bg-background @container/header sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b px-3"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <h2 id={titleId} className="truncate text-sm font-medium">
          {title}
        </h2>
        <SaveStatus status={status} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {presence}
        {share}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="outline"
                aria-haspopup="dialog"
                className="@max-md/header:w-8 @max-md/header:px-0"
                disabled={exportDisabled}
                onClick={onExport}
              />
            }
          >
            <DownloadIcon aria-hidden="true" />
            <span className="@max-md/header:sr-only">Export</span>
          </TooltipTrigger>
          <TooltipContent side="bottom">Export Board</TooltipContent>
        </Tooltip>
        {/* The one group boundary: board actions before it, the view after. */}
        <Separator
          orientation="vertical"
          className="h-4 data-[orientation=vertical]:self-center"
        />
        <PanelToggle
          label="Board panel"
          panelId={panelId}
          docked={docked}
          dockOpen={dockOpen}
          sheetOpen={sheetOpen}
          onPanel={onPanel}
        />
      </div>
    </header>
  )
}