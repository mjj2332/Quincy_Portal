/**
 * ReUI `@reui/whiteboard-1` (Pro block; Excalidraw), vendored for #498 through the sandbox
 * (`tmp/ReUI-Test-1`, `--path src/components/vendor-498`), never `shadcn add` in apps/web. Mechanical edits
 * in every file of the set: `cn` from `@/lib/utils` (not the registry's raw `"cn"`), imports repointed to
 * `@/components/reui/`, the `"use client"` directive dropped, the Skin guard's strips (`dark:` variants,
 * Tailwind `shadow-*`, focus ring widths -- see `reui-skin.guard.test.ts`), and `noUncheckedIndexedAccess`
 * narrowing. `"dark": boolean` is quoted only so the guard's `dark:` matcher does not read a type as a variant.
 *
 * This file: PNG / SVG export. Edits: `sonner` toasts became `lib/toast-store` `pushToast` (message-only; the description joins the title); `title` and `boardName` props replace the demo's `BOARD.title` / `BOARD.fileName`.
 */
import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { flushSync } from "react-dom"
import { pushToast } from "@/lib/toast-store"

import { Button } from "@/components/reui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/reui/dialog"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/reui/field"
import { Item } from "@/components/reui/item"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/reui/select"
import { Skeleton } from "@/components/reui/skeleton"
import { Spinner } from "@/components/reui/spinner"
import { Switch } from "@/components/reui/switch"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/reui/toggle-group"

import type {
  WhiteboardController,
  WhiteboardExportOptions,
  WhiteboardExportScope,
} from "./whiteboard"

type Format = WhiteboardExportOptions["format"]
type Scale = NonNullable<WhiteboardExportOptions["scale"]>

export type BoardFrame = { id: string; name: string; count: number }

/** Starts a download without leaving the page. */
export function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")

const toScope = (value: string): WhiteboardExportScope =>
  value === "board" || value === "selection"
    ? { type: value }
    : { type: "frame", id: value }

function ExportForm({
  title,
  boardName,
  controller,
  frames,
  initialScope,
  initialDark,
  onDone,
}: {
  /** #498: the board's display name and file stem, from the host (the registry hard-codes a demo's). */
  title: string
  boardName: string
  controller: WhiteboardController
  frames: readonly BoardFrame[]
  initialScope: string
  initialDark: boolean
  onDone: () => void
}) {
  const [format, setFormat] = useState<Format>("png")
  const [scope, setScope] = useState(initialScope)
  const [scale, setScale] = useState<Scale>(2)
  const [background, setBackground] = useState(true)
  const [dark, setDark] = useState(initialDark)
  const [embedScene, setEmbedScene] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [busy, setBusy] = useState<"copy" | "download" | null>(null)
  const [hasSelection] = useState(() => controller.getSelectedIds().length > 0)
  const previewRef = useRef<string | null>(null)
  const copyRef = useRef<HTMLButtonElement | null>(null)

  const items = [
    { value: "board", label: "Whole Board" },
    { value: "selection", label: "Selection" },
    ...frames.map((frame) => ({ value: frame.id, label: frame.name })),
  ]
  const frameName = frames.find((frame) => frame.id === scope)?.name
  const fileName = `${boardName}${frameName ? `-${slug(frameName)}` : ""}.${format}`
  const options: WhiteboardExportOptions = {
    format,
    scope: toScope(scope),
    background,
    dark,
    scale,
    embedScene,
  }

  // The preview is always a small PNG; SVG and PNG draw the same picture.
  useEffect(() => {
    let cancelled = false
    controller
      .exportImage({
        format: "png",
        scope: toScope(scope),
        background,
        dark,
        maxSize: 640,
      })
      .then((blob) => {
        if (cancelled) return
        const url = URL.createObjectURL(blob)
        if (previewRef.current) URL.revokeObjectURL(previewRef.current)
        previewRef.current = url
        setPreview(url)
        setPreviewFailed(false)
      })
      .catch(() => {
        if (!cancelled) setPreviewFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [controller, scope, background, dark])

  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    },
    []
  )

  const download = async () => {
    setBusy("download")
    try {
      saveBlob(await controller.exportImage(options), fileName)
      pushToast(`Image exported: ${fileName}`, "success")
      onDone()
    } catch {
      pushToast("Export failed: the image could not be rendered.", "error")
    } finally {
      setBusy(null)
    }
  }

  // Called straight from the click: clipboard writes need the user gesture.
  const copy = () => {
    setBusy("copy")
    controller
      .copyImage(options)
      .then(() => {
        pushToast(`Image copied: ${format.toUpperCase()} of ${frameName ?? title}`, "success")
        onDone()
      })
      .catch(() => {
        // Busy disabled the focused button, so focus comes back once it re-enables.
        flushSync(() => setBusy(null))
        copyRef.current?.focus()
        pushToast("Copy failed: this browser blocked clipboard access.", "error")
      })
      .finally(() => setBusy(null))
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Export Board</DialogTitle>
        <DialogDescription>
          PNG for docs, SVG for sharp scaling.
        </DialogDescription>
      </DialogHeader>

      {/* On a short screen only this body scrolls; the 12px gutter holds focus rings
          and the switches' touch areas, so it never scrolls sideways. */}
      <div className="scroll-fade-y no-scrollbar -mx-3 grid min-h-0 flex-1 scroll-py-10 gap-4 overflow-y-auto px-3">
        {/* A dark, transparent export previews on the well as dark mode draws it:
            the dark token, opaque, since a light dialog would show through. */}
        <Item
          variant="muted"
          className={cn(
            "h-44 justify-center overflow-hidden",
            dark && !background && "dark bg-muted"
          )}
        >
          {preview && !previewFailed ? (
            <img
              src={preview}
              alt={`Preview of ${frameName ?? title}`}
              className="max-h-full max-w-full object-contain"
            />
          ) : previewFailed ? (
            <p className="text-muted-foreground text-sm">Nothing to export</p>
          ) : (
            <Skeleton className="h-32 w-56" />
          )}
        </Item>

        <FieldGroup className="gap-4">
          <Field orientation="horizontal">
            <FieldLabel htmlFor="export-area">Area</FieldLabel>
            <Select
              items={items}
              value={scope}
              onValueChange={(value) => {
                if (value) setScope(value)
              }}
            >
              <SelectTrigger id="export-area" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start" alignItemWithTrigger={false}>
                {items.map((item) => (
                  <SelectItem
                    key={item.value}
                    value={item.value}
                    disabled={item.value === "selection" && !hasSelection}
                  >
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field orientation="horizontal">
            <FieldLabel>Format</FieldLabel>
            <ToggleGroup
              multiple={false}
              value={[format]}
              onValueChange={(value) => {
                const next = value[0]
                if (next === "png" || next === "svg") setFormat(next)
              }}
              variant="outline"
              size="sm"
              spacing={0}
              aria-label="Format"
            >
              <ToggleGroupItem value="png">PNG</ToggleGroupItem>
              <ToggleGroupItem value="svg">SVG</ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <Field orientation="horizontal" data-disabled={format === "svg"}>
            <FieldLabel>Scale</FieldLabel>
            <ToggleGroup
              multiple={false}
              value={[String(scale)]}
              onValueChange={(value) => {
                const next = Number(value[0])
                if (next === 1 || next === 2 || next === 3) setScale(next)
              }}
              variant="outline"
              size="sm"
              spacing={0}
              disabled={format === "svg"}
              aria-label="Scale"
            >
              <ToggleGroupItem value="1">1x</ToggleGroupItem>
              <ToggleGroupItem value="2">2x</ToggleGroupItem>
              <ToggleGroupItem value="3">3x</ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="export-background">Background</FieldLabel>
              <FieldDescription>Off keeps it transparent.</FieldDescription>
            </FieldContent>
            <Switch
              id="export-background"
              checked={background}
              onCheckedChange={setBackground}
            />
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="export-dark">Dark</FieldLabel>
              <FieldDescription>
                Inverts the drawing for dark slides.
              </FieldDescription>
            </FieldContent>
            <Switch id="export-dark" checked={dark} onCheckedChange={setDark} />
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="export-embed">Editable</FieldLabel>
              <FieldDescription>Opens back as a board.</FieldDescription>
            </FieldContent>
            <Switch
              id="export-embed"
              checked={embedScene}
              onCheckedChange={setEmbedScene}
            />
          </Field>
        </FieldGroup>
      </div>

      <DialogFooter>
        <Button
          ref={copyRef}
          type="button"
          variant="outline"
          disabled={busy !== null || previewFailed}
          onClick={copy}
        >
          {busy === "copy" ? (
            <Spinner data-icon="inline-start" role="presentation" aria-hidden />
          ) : null}
          Copy
        </Button>
        <Button
          type="button"
          disabled={busy !== null || previewFailed}
          onClick={() => void download()}
        >
          {busy === "download" ? (
            <Spinner data-icon="inline-start" role="presentation" aria-hidden />
          ) : null}
          Download
        </Button>
      </DialogFooter>
    </>
  )
}

export function ExportDialog({
  title,
  boardName,
  open,
  onOpenChange,
  request,
  controller,
  frames,
  dark,
}: {
  title: string
  boardName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Bumped per open, so each open starts from the requested area. */
  request: { id: number; scope: string }
  controller: WhiteboardController | null
  frames: readonly BoardFrame[]
  "dark": boolean
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Bounded by the viewport; centred by layout, since the stock -50%
          translate puts an odd height on a half pixel and smears the hairlines. */}
      <DialogContent className="inset-0 m-auto flex h-fit max-h-[calc(100svh-2rem)] translate-x-0 translate-y-0 flex-col sm:max-w-md">
        {controller ? (
          <ExportForm
            key={request.id}
            title={title}
            boardName={boardName}
            controller={controller}
            frames={frames}
            initialScope={request.scope}
            initialDark={dark}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}