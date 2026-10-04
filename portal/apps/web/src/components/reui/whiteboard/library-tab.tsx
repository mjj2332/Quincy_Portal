/**
 * ReUI `@reui/whiteboard-1` (Pro block; Excalidraw), vendored for #498 through the sandbox
 * (`tmp/ReUI-Test-1`, `--path src/components/vendor-498`), never `shadcn add` in apps/web. Mechanical edits
 * in every file of the set: `cn` from `@/lib/utils` (not the registry's raw `"cn"`), imports repointed to
 * `@/components/reui/`, the `"use client"` directive dropped, the Skin guard's strips (`dark:` variants,
 * Tailwind `shadow-*`, focus ring widths -- see `reui-skin.guard.test.ts`), and `noUncheckedIndexedAccess`
 * narrowing. `"dark": boolean` is quoted only so the guard's `dark:` matcher does not read a type as a variant.
 *
 * This file: The Library tab (templates and shapes). Unchanged apart from the mechanical edits. The Portal keeps "Add to library" session-only: persisting it needs storage a later slice owns.
 */
import { useEffect, useRef, useState } from "react"

import { Button } from "@/components/reui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/reui/empty"
import {
  PanelInset,
  PanelList,
  PanelRow,
  PanelRowSkeletons,
  PanelScroll,
  PanelSection,
  RowAction,
} from "./board-panel"
import type { TemplateId } from "./board-scene"
import { MENU_ICONS, TEMPLATES } from "./data"
import type { WhiteboardController, WhiteboardLibraryEntry } from "./whiteboard"
import { CombineIcon, PlusIcon, Trash2Icon } from "lucide-react"

// Preview bitmaps in device pixels: sharp in the tile's 24px well up to 4x.
const PREVIEW_SIZE = 96

// One empty list for a library still loading, so the preview effect never re-runs on it.
const NO_LIBRARY: readonly WhiteboardLibraryEntry[] = []

// Stands in for a preview until the board's exporter draws it.
const SHAPE_ICON = (
  <CombineIcon aria-hidden="true" />
)

const PLUS_ICON = (
  <PlusIcon aria-hidden="true" />
)

const TRASH_ICON = (
  <Trash2Icon aria-hidden="true" />
)

const TYPE_NAMES: Partial<Record<string, string>> = {
  rectangle: "Rectangle",
  ellipse: "Ellipse",
  diamond: "Diamond",
  arrow: "Arrow",
  line: "Line",
  freedraw: "Drawing",
  text: "Text",
  frame: "Frame",
}

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`

/** Seeded shapes carry a name; ones saved from the board read as their frame or first words. */
export function libraryName(entry: WhiteboardLibraryEntry) {
  if (entry.name) return entry.name
  for (const element of entry.elements) {
    if (element.type === "frame" && element.name) return element.name
  }
  for (const element of entry.elements) {
    if (element.type === "text") {
      const words = element.originalText.replace(/\s+/g, " ").trim()
      if (words) return words
    }
  }
  return TYPE_NAMES[entry.elements[0]?.type ?? ""] ?? "Saved Shape"
}

/** Shapes a user would count: labels inside shapes ride with them. */
const shapeCount = (entry: WhiteboardLibraryEntry) =>
  entry.elements.filter(
    (element) => !(element.type === "text" && element.containerId !== null)
  ).length

/**
 * One PNG per library shape, drawn by the board's own exporter in the current
 * theme, kept while the shape stays and revoked once it leaves.
 */
function useLibraryPreviews(
  controller: WhiteboardController | null,
  library: readonly WhiteboardLibraryEntry[],
  isDark: boolean
) {
  const dark = isDark
  const cacheRef = useRef(new Map<string, string>())
  const [previews, setPreviews] = useState<ReadonlyMap<string, string>>(
    () => new Map()
  )

  useEffect(() => {
    if (!controller) return
    const cache = cacheRef.current
    const theme = dark ? "dark" : "light"
    const keyOf = (id: string) => `${id}:${theme}`
    const wanted = new Set(library.map((entry) => keyOf(entry.id)))
    for (const [key, url] of cache) {
      if (!wanted.has(key)) {
        URL.revokeObjectURL(url)
        cache.delete(key)
      }
    }
    let cancelled = false
    const missing = library.filter((entry) => !cache.has(keyOf(entry.id)))
    void Promise.all(
      missing.map((entry) =>
        controller
          .previewLibraryItem(entry.id, { dark, size: PREVIEW_SIZE })
          .then((blob) => [entry.id, blob] as const)
          .catch(() => null)
      )
    ).then((results) => {
      if (cancelled) return
      for (const result of results) {
        if (result) cache.set(keyOf(result[0]), URL.createObjectURL(result[1]))
      }
      const next = new Map<string, string>()
      for (const entry of library) {
        const url = cache.get(keyOf(entry.id))
        if (url) next.set(entry.id, url)
      }
      // The same previews keep the same map, so nothing re-renders for them.
      setPreviews((previous) =>
        previous.size === next.size &&
        [...next].every(([id, url]) => previous.get(id) === url)
          ? previous
          : next
      )
    })
    return () => {
      cancelled = true
    }
  }, [controller, library, dark])

  useEffect(() => {
    const cache = cacheRef.current
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url)
      cache.clear()
    }
  }, [])

  return previews
}

function LibraryRow({
  entry,
  preview,
  disabled,
  controller,
  removeRef,
  onInsert,
  onRemove,
}: {
  entry: WhiteboardLibraryEntry
  preview: string | undefined
  disabled: boolean
  controller: WhiteboardController | null
  removeRef: React.Ref<HTMLButtonElement>
  onInsert: (entry: WhiteboardLibraryEntry) => void
  onRemove: (entry: WhiteboardLibraryEntry) => void
}) {
  const imageRef = useRef<HTMLImageElement | null>(null)
  const name = libraryName(entry)

  return (
    <PanelRow
      icon={
        preview ? (
          <img
            ref={imageRef}
            src={preview}
            alt={`${name} preview`}
            draggable={false}
            className="size-full object-contain p-0.5"
          />
        ) : (
          SHAPE_ICON
        )
      }
      title={name}
      meta={[plural(shapeCount(entry), "shape")]}
      draggable={!disabled && controller !== null}
      onDragStart={(event) => {
        if (!controller) return
        // The canvas takes the drop as a copy where it lands.
        controller.dragLibraryItem(entry.id, event.dataTransfer)
        const image = imageRef.current
        if (image) {
          event.dataTransfer.setDragImage(
            image,
            image.width / 2,
            image.height / 2
          )
        }
      }}
      actions={
        <>
          <RowAction
            label={`Insert ${name}`}
            tooltip="Insert"
            icon={PLUS_ICON}
            disabled={disabled}
            onClick={() => onInsert(entry)}
          />
          <RowAction
            label={`Remove ${name}`}
            tooltip="Remove"
            icon={TRASH_ICON}
            disabled={disabled}
            buttonRef={removeRef}
            onClick={() => onRemove(entry)}
          />
        </>
      }
    />
  )
}

export function LibraryTab({
  controller,
  library,
  dark,
  readOnly,
  canAdd,
  onInsertTemplate,
  onInsertItem,
  onAddSelection,
  onRemoveItem,
  removeRef,
  addSelectionRef,
}: {
  controller: WhiteboardController | null
  /** Null until the board has loaded its library. */
  library: readonly WhiteboardLibraryEntry[] | null
  "dark": boolean
  readOnly: boolean
  /** Something is selected that the library can hold. */
  canAdd: boolean
  onInsertTemplate: (templateId: TemplateId) => void
  onInsertItem: (entry: WhiteboardLibraryEntry) => void
  onAddSelection: () => void
  onRemoveItem: (entry: WhiteboardLibraryEntry) => void
  /** Each row's Remove button by entry id, where focus returns around a remove. */
  removeRef: (id: string) => React.Ref<HTMLButtonElement>
  /** Add Selection, where focus goes once the last shape is removed. */
  addSelectionRef: React.Ref<HTMLButtonElement>
}) {
  const previews = useLibraryPreviews(controller, library ?? NO_LIBRARY, dark)
  const locked = readOnly || !controller

  return (
    <PanelScroll>
      <div className="flex flex-col gap-4">
        <PanelSection title="Templates">
          <PanelList>
            {TEMPLATES.map((template) => (
              <PanelRow
                key={template.id}
                icon={template.icon}
                title={template.name}
                meta={[template.description]}
                actions={
                  <RowAction
                    label={`Insert ${template.name}`}
                    tooltip="Insert"
                    icon={PLUS_ICON}
                    disabled={locked}
                    onClick={() => onInsertTemplate(template.id)}
                  />
                }
              />
            ))}
          </PanelList>
        </PanelSection>
        <PanelSection
          title="Personal Library"
          action={
            <Button
              ref={addSelectionRef}
              type="button"
              variant="ghost"
              size="xs"
              disabled={locked || !canAdd}
              onClick={onAddSelection}
            >
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              Add Selection
            </Button>
          }
        >
          {library === null ? (
            // The demo library's five shapes.
            <PanelRowSkeletons widths={[80, 56, 96, 72, 72]} />
          ) : library.length ? (
            <PanelList>
              {library.map((entry) => (
                <LibraryRow
                  key={entry.id}
                  entry={entry}
                  preview={previews.get(entry.id)}
                  disabled={locked}
                  controller={controller}
                  removeRef={removeRef(entry.id)}
                  onInsert={onInsertItem}
                  onRemove={onRemoveItem}
                />
              ))}
            </PanelList>
          ) : (
            <Empty className="py-6">
              <EmptyHeader>
                <EmptyMedia variant="icon">{MENU_ICONS.library}</EmptyMedia>
                <EmptyTitle>No Saved Shapes</EmptyTitle>
                <EmptyDescription>
                  Select shapes on the board, then add them here.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </PanelSection>
        {readOnly ? (
          <PanelInset>
            <p className="text-muted-foreground text-xs">
              Turn off view only to edit.
            </p>
          </PanelInset>
        ) : null}
      </div>
    </PanelScroll>
  )
}