/**
 * ReUI `@reui/whiteboard-1` (Pro block; Excalidraw), vendored for #498 through the sandbox
 * (`tmp/ReUI-Test-1`, `--path src/components/vendor-498`), never `shadcn add` in apps/web. Mechanical edits
 * in every file of the set: `cn` from `@/lib/utils` (not the registry's raw `"cn"`), imports repointed to
 * `@/components/reui/`, the `"use client"` directive dropped, the Skin guard's strips (`dark:` variants,
 * Tailwind `shadow-*`, focus ring widths -- see `reui-skin.guard.test.ts`), and `noUncheckedIndexedAccess`
 * narrowing. `"dark": boolean` is quoted only so the guard's `dark:` matcher does not read a type as a variant.
 *
 * This file: The Excalidraw canvas and chrome host. Imports `@excalidraw/excalidraw/index.css`, which is UNLAYERED (see docs/lessons.md, #498): it only loads with this lazy chunk. Unchanged apart from the mechanical edits and the QUINCY ADDITIONs marked inline (#498: image tool off; #501: the host's Image or video tool, media insert, video click, paste and drop of media files, foreign-media refusal at local entry points; #499: `applyRemote` and `adoptRevisions` (revisions never change across an index move), collaborator `colorKey`, `onPresence`).
 */
/**
 * The editor behind <Whiteboard>: the only runtime import of Excalidraw (MIT,
 * its license ships in the npm package) and of its stylesheet. It maps the embed
 * props onto the editor and owns the controller, autosave and the chrome slots.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  defaultLang,
  DefaultSidebar,
  Excalidraw,
  exportToBlob,
  exportToClipboard,
  exportToSvg,
  getCommonBounds,
  getNonDeletedElements,
  hashElementsVersion,
  reconcileElements,
  isElementLink,
  languages,
  loadSceneOrLibraryFromBlob,
  MainMenu,
  MIME_TYPES,
  newElementWith,
  normalizeLink,
  restoreElements,
  serializeAsJSON,
  serializeLibraryAsJSON,
  UserIdleState,
  viewportCoordsToSceneCoords,
  WelcomeScreen,
} from "@excalidraw/excalidraw"
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform"
import type {
  ExcalidrawElement,
  ExcalidrawFrameLikeElement,
  FileId,
  NonDeletedExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types"
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  Collaborator,
  DataURL,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  LibraryItem,
  LibraryItems,
  NormalizedZoomValue,
  SocketId,
  UIOptions,
} from "@excalidraw/excalidraw/types"
import { cn } from "@/lib/utils"
import { createChangeTracker } from "@/lib/whiteboard-changes"
import { withSelectionAnchor } from "@/lib/whiteboard-collaborators"
import { adoptArrivedRevisions, interactingIds, mergeRemote } from "@/lib/whiteboard-merge"
import { isMediaCandidate, pasteIsUnsupported, planSceneDrop, withoutForeignMedia, withoutUnsupported, type ServerHold } from "@/lib/whiteboard-saver"
import { whiteboardMediaRef } from "@quincy/shared"
import { unfinalized } from "@/lib/whiteboard-vanish"

import "@excalidraw/excalidraw/index.css"

import {
  MAX_ZOOM,
  MIN_ZOOM,
  type WhiteboardCanvasProps,
  type WhiteboardCollaborator,
  type WhiteboardContent,
  type WhiteboardController,
  type WhiteboardExportOptions,
  type WhiteboardFile,
  type WhiteboardInitialData,
  type WhiteboardLibraryEntry,
  type WhiteboardPanel,
  type WhiteboardSaveStatus,
  type WhiteboardScene,
  WHITEBOARD_SAVE_SKIPPED,
} from "./whiteboard"
import {
  adjacentFrames,
  WhiteboardChrome,
  ZOOM_STEP,
  type ChromeFrame,
  type ChromeState,
  type FitTarget,
  type HistoryAction,
  type HistoryState,
  type PickedWith,
  type WhiteboardPreference,
  type WhiteboardTool,
  type ZoomTarget,
} from "./whiteboard-controls"
import { shortcutPlatform, WhiteboardShortcuts } from "./whiteboard-shortcuts"
import {
  CANVAS_BACKGROUND,
  CANVAS_GRID,
  EXPORT_BACKGROUND,
} from "./whiteboard-theme"

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[]
  }
}

// 0.18.1 re-exports these from a package it does not ship typings for, so
// they arrive untyped; these are their published signatures.
type ExportOptions = {
  elements: readonly NonDeletedExcalidrawElement[]
  appState?: Partial<Omit<AppState, "offsetTop" | "offsetLeft">>
  files: BinaryFiles | null
  exportPadding?: number
  exportingFrame?: ExcalidrawFrameLikeElement | null
  maxWidthOrHeight?: number
  getDimensions?: (
    width: number,
    height: number
  ) => { width: number; height: number; scale?: number }
}
const toBlob: (
  options: ExportOptions & { mimeType?: string }
) => Promise<Blob> = exportToBlob
const toSvg: (
  options: Omit<ExportOptions, "getDimensions" | "maxWidthOrHeight">
) => Promise<SVGSVGElement> = exportToSvg
const toClipboard: (
  options: ExportOptions & { type: "png" | "svg" | "json" }
) => Promise<void> = exportToClipboard

// The host owns export, files, clearing, theme and the background, so the
// editor's own entry points for them stay off.
const UI_OPTIONS: Partial<UIOptions> = {
  canvasActions: {
    changeViewBackgroundColor: false,
    clearCanvas: false,
    export: false,
    loadScene: false,
    saveToActiveFile: false,
    saveAsImage: false,
  },
  tools: { image: true },
}
// #498: the Image tool is a host option (see `imageTool` on WhiteboardProps).
const UI_OPTIONS_NO_IMAGE: Partial<UIOptions> = {
  ...UI_OPTIONS,
  tools: { image: false },
}

/** Space the floating chrome takes, so fits never hide content under it; the
 * editor's properties island, open for a selection or a drawing tool, counts too. */
function chromeOffsets(width: number, root?: HTMLElement | null) {
  const offsets =
    width < 730
      ? { top: 80, right: 16, bottom: 80, left: 16 }
      : { top: 80, right: 16, bottom: 64, left: 16 }
  const island = root?.querySelector(".App-menu__left")
  if (root && island) {
    const edge = island.getBoundingClientRect().right
    offsets.left = Math.max(
      offsets.left,
      edge - root.getBoundingClientRect().left + 16
    )
  }
  return offsets
}

// The Grid's cell in scene units (the editor's own default): 12px on screen at the
// 60% opening zoom. The hairlines sit on its edges, where snapping lands.
const GRID_CELL = 20

// On-screen cell sizes over which the lines fade out, so a far zoom never
// turns them into noise.
const GRID_FADE = [6, 10] as const

/** Pins the hairline layer to the scene grid, straight to its variables:
 * panning never re-renders. */
function placeGrid(layer: HTMLDivElement | null, state: AppState) {
  if (!layer) return
  const zoom = state.zoom.value
  const gap = (state.gridSize > 0 ? state.gridSize : GRID_CELL) * zoom
  const [from, to] = GRID_FADE
  const fade = Math.min(Math.max((gap - from) / (to - from), 0), 1)
  // The scene origin on screen; each tile draws its lines on its top and left edges.
  const next = {
    "--wb-grid-gap": `${gap}px`,
    "--wb-grid-x": `${state.scrollX * zoom}px`,
    "--wb-grid-y": `${state.scrollY * zoom}px`,
    "--wb-grid-fade": `${Math.round(fade * 100)}%`,
  }
  for (const [name, value] of Object.entries(next)) {
    if (layer.style.getPropertyValue(name) !== value) {
      layer.style.setProperty(name, value)
    }
  }
}

// A 1px line on each cell's top and left edges; the colour comes from CANVAS_GRID
// in whiteboard-theme.ts.
const GRID_LAYOUT = [
  "pointer-events-none absolute inset-0 [--wb-grid-ink:color-mix(in_oklab,var(--wb-grid-line)_var(--wb-grid-fade,100%),transparent)]",
  "[background-image:linear-gradient(to_right,var(--wb-grid-ink)_1px,transparent_1px),linear-gradient(to_bottom,var(--wb-grid-ink)_1px,transparent_1px)]",
  "[background-size:var(--wb-grid-gap,20px)_var(--wb-grid-gap,20px)]",
  "[background-position:var(--wb-grid-x,0px)_var(--wb-grid-y,0px)]",
].join(" ")

/** The editor's switch to its phone layout, on the board's own size. */
const isPhoneLayout = (width: number, height: number) =>
  width < 730 || (height < 500 && width < 1000)

// Below this board width the phone bar has no room for the zoom steppers.
const NARROW_WIDTH = 380

function readChrome(state: AppState, frameAt: string | null): ChromeState {
  return {
    tool: state.activeTool.type,
    zoom: state.zoom.value,
    grid: state.gridModeEnabled,
    snap: state.objectsSnapModeEnabled,
    viewMode: state.viewModeEnabled,
    selected: Object.keys(state.selectedElementIds).length > 0,
    penMode: state.penMode,
    penDetected: state.penDetected,
    phone: isPhoneLayout(state.width, state.height),
    narrow: state.width < NARROW_WIDTH,
    frameAt,
  }
}

const sameChrome = (a: ChromeState, b: ChromeState) =>
  (Object.keys(a) as (keyof ChromeState)[]).every((key) => a[key] === b[key])

// 0.18.1 has no undo API (only history.clear), so the footer drives the editor's
// own buttons, hidden in whiteboard-theme.ts; both layouts carry these test ids.
const HISTORY_BUTTONS: Record<HistoryAction, string> = {
  undo: ".excalidraw [data-testid=button-undo]",
  redo: ".excalidraw [data-testid=button-redo]",
}

const NO_HISTORY: HistoryState = { undo: false, redo: false }

/** This board's own undo or redo button, never another instance's. */
const historyButton = (root: HTMLElement | null, action: HistoryAction) =>
  root?.querySelector<HTMLButtonElement>(HISTORY_BUTTONS[action]) ?? null

const canRun = (
  button: HTMLButtonElement | null
): button is HTMLButtonElement =>
  button !== null &&
  !button.disabled &&
  button.getAttribute("aria-disabled") !== "true"

type BoardFrame = ChromeFrame & {
  x: number
  y: number
  width: number
  height: number
}

/** The board's frames in reading order: rows top to bottom, each left to right. */
function readFrames(elements: readonly OrderedExcalidrawElement[]) {
  const frames: BoardFrame[] = elements.flatMap((element) =>
    element.type === "frame" && !element.isDeleted
      ? [
          {
            id: element.id,
            name: element.name ?? "Frame",
            x: element.x,
            y: element.y,
            width: element.width,
            height: element.height,
          },
        ]
      : []
  )
  const rows: BoardFrame[][] = []
  for (const frame of [...frames].sort((a, b) => a.y - b.y)) {
    const row = rows.at(-1)
    const first = row?.[0]
    // A frame starting above the middle of the row's first joins that row.
    if (row && first && frame.y < first.y + first.height / 2) row.push(frame)
    else rows.push([frame])
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x))
}

const sameFrames = (a: readonly ChromeFrame[], b: readonly ChromeFrame[]) =>
  a.length === b.length &&
  a.every(
    (frame, index) => frame.id === b[index]?.id && frame.name === b[index]?.name
  )

/** The scene point at the middle of the view. */
function viewCentre(state: AppState) {
  const zoom = state.zoom.value
  return {
    x: state.width / 2 / zoom - state.scrollX,
    y: state.height / 2 / zoom - state.scrollY,
  }
}

/** The frame under the middle of the view, if any. */
function frameAtCentre(frames: readonly BoardFrame[], state: AppState) {
  const { x, y } = viewCentre(state)
  const frame = frames.find(
    (item) =>
      x >= item.x &&
      x <= item.x + item.width &&
      y >= item.y &&
      y <= item.y + item.height
  )
  return frame?.id ?? null
}

const frameAtCentreOf = (
  api: ExcalidrawImperativeAPI | null,
  frames: readonly BoardFrame[]
) => (api ? frameAtCentre(frames, api.getAppState()) : null)

/** Fits elements clear of the chrome: `fill` frames them up to 125%, else the
 * whole set fits at 100% at most, as the editor's own Shift+1 and Shift+2 do. */
function fitElements(
  api: ExcalidrawImperativeAPI,
  targets: readonly ExcalidrawElement[],
  fill: boolean,
  root: HTMLElement | null
) {
  if (!targets.length) return
  const shared = {
    animate: motionAllowed(),
    duration: 300,
    canvasOffsets: chromeOffsets(api.getAppState().width, root),
  }
  if (fill) {
    api.scrollToContent(targets, {
      ...shared,
      fitToViewport: true,
      viewportZoomFactor: 0.9,
      maxZoom: 1.25,
    })
  } else {
    api.scrollToContent(targets, { ...shared, fitToContent: true })
  }
}

const FRAME_PADDING = 40
const INSERT_GAP = 80
/** QUINCY #501: screen pixels between the files of one multi-file insert. */
const INSERT_CASCADE = 28
/** QUINCY #501: the play badge's disc is ~11% of the short edge (see lib/whiteboard-media-render.ts); a click this far (as a fraction of the short edge) from the centre opens the video, a little generous for a fingertip. */
const BADGE_HIT_RADIUS = 0.13
/** QUINCY #501: the play badge's hit radius never shrinks below this many CSS pixels, so a zoomed-out board still has a fingertip-sized target. */
const BADGE_MIN_HIT_PX = 22
// Excalidraw's inset between a shape and its label.
const BOUND_TEXT_PADDING = 5
const LABEL_SHAPES = new Set(["rectangle", "ellipse", "diamond"])

const IDLE_STATE = {
  active: UserIdleState.ACTIVE,
  idle: UserIdleState.IDLE,
  away: UserIdleState.AWAY,
} satisfies Record<NonNullable<WhiteboardCollaborator["state"]>, UserIdleState>

/** A menu item sent focus somewhere on purpose (Find to the host's search, a
 * confirm dialog), so the closing menu leaves it there. */
const focusMovedAway = (root: HTMLElement | null) => {
  const active = document.activeElement
  return (
    active instanceof HTMLElement &&
    active !== document.body &&
    !active.closest("[role=menu]") &&
    !root?.contains(active)
  )
}

const motionAllowed = () =>
  document.documentElement.dataset.demo !== "frozen" &&
  !window.matchMedia("(prefers-reduced-motion: reduce)").matches

const NON_TEXT_INPUTS = new Set([
  "checkbox",
  "radio",
  "button",
  "range",
  "color",
])

/** Where a typed key is text, as the editor's own isWritableElement decides. */
const isWritable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.dataset.type === "wysiwyg" ||
    (target instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(target.type)))

// Excalidraw brands ids and data URLs; the embed's plain strings carry the same values.
const toBinaryFile = (file: WhiteboardFile): BinaryFileData => ({
  id: file.id as FileId,
  mimeType: file.mimeType as BinaryFileData["mimeType"],
  dataURL: file.dataURL as DataURL,
  created: file.created ?? 0,
})
const toSocketId = (id: string) => id as SocketId

// The element types a library cannot hold, as the editor's own Add to Library rules.
const LIBRARY_EXCLUDED = new Set(["image", "embeddable", "iframe"])

const toLibraryEntry = ({
  id,
  name,
  created,
  elements,
}: LibraryItem): WhiteboardLibraryEntry => ({ id, name, created, elements })

/** A random 21 character id, the length of the editor's own. */
function freshId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(21)), (byte) =>
    (byte % 36).toString(36)
  ).join("")
}

/**
 * Copies elements under fresh ids, re-pointing labels, bindings, groups and
 * frames inside the copy; links to anything outside it are dropped.
 */
function cloneWithFreshIds(elements: readonly ExcalidrawElement[]) {
  const ids = new Map(elements.map((element) => [element.id, freshId()]))
  const groups = new Map<string, string>()
  const regroup = (id: string) => {
    const next = groups.get(id) ?? freshId()
    groups.set(id, next)
    return next
  }
  const inside = (id: string | null) =>
    id === null ? null : (ids.get(id) ?? null)
  const rebind = <T extends { elementId: string } | null>(binding: T) => {
    if (binding === null) return null
    const elementId = inside(binding.elementId)
    return elementId === null ? null : { ...binding, elementId }
  }
  return elements.map((element) => {
    const copy = {
      ...element,
      id: ids.get(element.id) ?? freshId(),
      groupIds: element.groupIds.map(regroup),
      frameId: inside(element.frameId),
      boundElements:
        element.boundElements?.flatMap((bound) => {
          const id = inside(bound.id)
          return id === null ? [] : [{ ...bound, id }]
        }) ?? null,
    }
    if (copy.type === "text") {
      return { ...copy, containerId: inside(copy.containerId) }
    }
    if (copy.type === "arrow" || copy.type === "line") {
      return {
        ...copy,
        startBinding: rebind(copy.startBinding),
        endBinding: rebind(copy.endBinding),
      }
    }
    return copy
  })
}

/** Grows each frame to its children plus padding, instead of the tight default. */
function padFrames(elements: readonly OrderedExcalidrawElement[]) {
  return elements.map((element) => {
    if (element.type !== "frame") return element
    const children = elements.filter((child) => child.frameId === element.id)
    if (!children.length) return element
    const [minX, minY, maxX, maxY] = getCommonBounds(children)
    return newElementWith(element, {
      x: minX - FRAME_PADDING,
      y: minY - FRAME_PADDING,
      width: maxX - minX + FRAME_PADDING * 2,
      height: maxY - minY + FRAME_PADDING * 2,
    })
  })
}

/** The area a label may fill inside its shape, in Excalidraw's own geometry. */
function labelBox(shape: ExcalidrawElement) {
  const { x, y, width, height } = shape
  const padding = BOUND_TEXT_PADDING
  if (shape.type === "ellipse") {
    const inset = 1 - Math.SQRT1_2
    return {
      x: x + padding + (width / 2) * inset,
      y: y + padding + (height / 2) * inset,
      width: Math.round((width / 2) * Math.SQRT2) - padding * 2,
      height: Math.round((height / 2) * Math.SQRT2) - padding * 2,
    }
  }
  if (shape.type === "diamond") {
    return {
      x: x + padding + width / 4,
      y: y + padding + height / 4,
      width: Math.round(width / 2) - padding * 2,
      height: Math.round(height / 2) - padding * 2,
    }
  }
  return {
    x: x + padding,
    y: y + padding,
    width: width - padding * 2,
    height: height - padding * 2,
  }
}

/** The shape size whose label area holds `size`, as Excalidraw grows it. */
function shapeSizeFor(size: number, type: ExcalidrawElement["type"]) {
  const padded = Math.ceil(size) + BOUND_TEXT_PADDING * 2
  if (type === "ellipse") return Math.round((padded / Math.SQRT2) * 2)
  if (type === "diamond") return padded * 2
  return padded
}

// Re-wrapping keeps a label's old top edge; this grows each shape to fit its
// label and re-aligns the label inside it, as an edit in the editor does.
function seatLabels(elements: readonly OrderedExcalidrawElement[]) {
  const byId = new Map(elements.map((element) => [element.id, element]))
  const seated = new Map<string, OrderedExcalidrawElement>()
  for (const label of elements) {
    if (label.type !== "text" || !label.containerId || label.isDeleted) continue
    const original = byId.get(label.containerId)
    if (!original || !LABEL_SHAPES.has(original.type)) continue
    let shape = original
    let box = labelBox(shape)
    if (label.width > box.width || label.height > box.height) {
      shape = {
        ...shape,
        width:
          label.width > box.width
            ? shapeSizeFor(label.width, shape.type)
            : shape.width,
        height:
          label.height > box.height
            ? shapeSizeFor(label.height, shape.type)
            : shape.height,
      }
      seated.set(shape.id, shape)
      box = labelBox(shape)
    }
    const x =
      label.textAlign === "left"
        ? box.x
        : label.textAlign === "right"
          ? box.x + box.width - label.width
          : box.x + (box.width - label.width) / 2
    const y =
      label.verticalAlign === "top"
        ? box.y
        : label.verticalAlign === "bottom"
          ? box.y + box.height - label.height
          : box.y + (box.height - label.height) / 2
    seated.set(label.id, { ...label, x, y })
  }
  return elements.map((element) => seated.get(element.id) ?? element)
}

/** Whether an element kept its box and wrapped text through a re-measure. */
function sameBox(next: ExcalidrawElement, previous?: ExcalidrawElement) {
  if (!previous) return false
  const sameText =
    next.type !== "text" ||
    (previous.type === "text" && previous.text === next.text)
  return (
    sameText &&
    next.x === previous.x &&
    next.y === previous.y &&
    next.width === previous.width &&
    next.height === previous.height
  )
}

function convertSkeleton(
  skeleton: readonly ExcalidrawElementSkeleton[] | undefined,
  regenerateIds: boolean
) {
  if (!skeleton?.length) return []
  return padFrames(
    convertToExcalidrawElements([...skeleton], { regenerateIds })
  )
}

type LibrarySeed = NonNullable<WhiteboardInitialData["library"]>

/** A saved entry passes through as it is; an authored skeleton converts. */
function toLibraryItem(item: LibrarySeed[number], index: number): LibraryItem {
  if ("elements" in item) return { ...item, status: "unpublished" }
  return {
    id: item.id,
    name: item.name,
    status: "unpublished",
    created: index + 1,
    elements: convertToExcalidrawElements([...item.skeleton], {
      regenerateIds: false,
    }),
  }
}

// Excalidraw merges library items by element identity, so a library converts
// once and every later load (StrictMode, remounts) merges instead of doubling.
const convertedLibraries = new WeakMap<LibrarySeed, LibraryItem[]>()

function toLibraryItems(library: LibrarySeed) {
  const cached = convertedLibraries.get(library)
  if (cached) return cached
  const items = library.map(toLibraryItem)
  convertedLibraries.set(library, items)
  return items
}

/** Centres the board at the opening zoom, in the space the chrome leaves. */
function openingView(
  elements: readonly ExcalidrawElement[],
  rect: DOMRect | undefined,
  zoom: number
): Pick<AppState, "zoom" | "scrollX" | "scrollY"> | null {
  const live = elements.filter((element) => !element.isDeleted)
  if (!rect || rect.width === 0 || rect.height === 0 || !live.length) {
    return null
  }
  const offsets = chromeOffsets(rect.width)
  const [minX, minY, maxX, maxY] = getCommonBounds(live)
  const centerX = offsets.left + (rect.width - offsets.left - offsets.right) / 2
  const centerY = offsets.top + (rect.height - offsets.top - offsets.bottom) / 2
  return {
    // Clamped to Excalidraw's range by the caller, so a valid zoom value.
    zoom: { value: zoom as NormalizedZoomValue },
    scrollX: centerX / zoom - (minX + maxX) / 2,
    scrollY: centerY / zoom - (minY + maxY) / 2,
  }
}

function readScene(api: ExcalidrawImperativeAPI): WhiteboardScene {
  const all = api.getSceneElementsIncludingDeleted()
  const elements = structuredClone(getNonDeletedElements(all))
  const referenced = new Set<string>()
  for (const element of elements) {
    if (element.type === "image" && element.fileId)
      referenced.add(element.fileId)
  }
  const files = Object.values(api.getFiles())
    .filter((file) => referenced.has(file.id))
    .map(({ id, mimeType, dataURL, created }) => ({
      id,
      mimeType,
      dataURL,
      created,
    }))
  const state = api.getAppState()
  return {
    elements,
    files,
    appState: {
      gridModeEnabled: state.gridModeEnabled,
      objectsSnapModeEnabled: state.objectsSnapModeEnabled,
    },
    version: hashElementsVersion(all),
  }
}

function exportTarget(
  api: ExcalidrawImperativeAPI,
  scope: WhiteboardExportOptions["scope"]
) {
  const elements = api.getSceneElements()
  if (scope.type === "frame") {
    const frame = elements.find((element) => element.id === scope.id)
    const exportingFrame =
      frame && (frame.type === "frame" || frame.type === "magicframe")
        ? frame
        : null
    return { elements, exportingFrame }
  }
  if (scope.type === "selection") {
    const selected = new Set(Object.keys(api.getAppState().selectedElementIds))
    const picked = elements.filter(
      (element) =>
        selected.has(element.id) ||
        (element.frameId !== null && selected.has(element.frameId)) ||
        (element.type === "text" &&
          element.containerId !== null &&
          selected.has(element.containerId))
    )
    return { elements: picked, exportingFrame: null }
  }
  return { elements, exportingFrame: null }
}

function exportOptions(
  api: ExcalidrawImperativeAPI,
  options: WhiteboardExportOptions
): ExportOptions {
  const { elements, exportingFrame } = exportTarget(api, options.scope)
  const scale = options.scale ?? 1
  return {
    elements,
    exportingFrame,
    files: api.getFiles(),
    exportPadding: options.padding ?? 16,
    appState: {
      exportBackground: options.background,
      exportWithDarkMode: options.dark,
      exportEmbedScene: options.embedScene ?? false,
      viewBackgroundColor: EXPORT_BACKGROUND,
    },
    ...(options.maxSize
      ? { maxWidthOrHeight: options.maxSize }
      : {
          getDimensions: (width: number, height: number) => ({
            width: width * scale,
            height: height * scale,
            scale,
          }),
        }),
  }
}

/** Everything on the board marked deleted, as the editor's own Clear does, so
 * version based sync (reconcileElements) sees the removals. */
const tombstones = (elements: readonly OrderedExcalidrawElement[]) =>
  elements.map((element) =>
    element.isDeleted ? element : newElementWith(element, { isDeleted: true })
  )

export function replaceContent(
  api: ExcalidrawImperativeAPI,
  content: WhiteboardContent,
  undoable: boolean
) {
  const files = content.files?.map(toBinaryFile) ?? []
  if (files.length) api.addFiles(files)
  // Stored scenes get the same repair initialData does (older schemas, bindings).
  const incoming = content.elements
    ? restoreElements(content.elements, null, { repairBindings: true })
    : convertSkeleton(content.skeleton, false)
  const all = api.getSceneElementsIncludingDeleted()
  const current = new Map(all.map((element) => [element.id, element]))
  // Bump past what is on the board, so version based sync sees the change.
  const next = incoming.map((element) => {
    const previous = current.get(element.id)
    if (!previous) return element
    return newElementWith(
      { ...element, version: Math.max(element.version, previous.version) },
      {},
      true
    )
  })
  const kept = new Set(next.map((element) => element.id))
  api.updateScene({
    elements: [
      ...next,
      ...tombstones(all.filter((element) => !kept.has(element.id))),
    ],
    captureUpdate: undoable
      ? CaptureUpdateAction.IMMEDIATELY
      : CaptureUpdateAction.NEVER,
  })
}

type MergeElement = { id: string; version: number; versionNonce: number }

function toCollaborator(person: WhiteboardCollaborator): Collaborator {
  const selectedElementIds: Record<string, true> = {}
  for (const id of person.selectedIds ?? []) selectedElementIds[id] = true
  return {
    // QUINCY ADDITION #499: Excalidraw 0.18.1 colours from a hash of this field (and ignores `color`).
    id: person.colorKey ?? person.id,
    username: person.name,
    avatarUrl: person.avatarUrl,
    pointer: person.pointer
      ? { x: person.pointer.x, y: person.pointer.y, tool: "pointer" }
      : undefined,
    button: person.pressed ? "down" : "up",
    selectedElementIds,
    userState: IDLE_STATE[person.state ?? "active"],
  }
}

/** This board's editor element, where its keys and focus live. */
const boardElement = (root: HTMLElement | null) =>
  root?.querySelector<HTMLElement>(".excalidraw-container") ?? null

/**
 * QUINCY ADDITION #499: the scene without its unfinalized elements (live, invisibly small, nothing holding them), or null when it has
 * none. Excalidraw finalizes a zero-size element when a pointer gesture ends; one that gets here by any other path would be sent as an
 * ordinary edit and dropped by every other tab's restore. `handleChange` reports the scene once, then drops them through updateScene,
 * and the vanish observer authors their deletion. An element a gesture holds (drawing, resizing, text editing, a multi-point line in
 * progress) is left alone.
 */
export function sweepUnfinalized(
  elements: readonly OrderedExcalidrawElement[],
  appState: AppState
): readonly OrderedExcalidrawElement[] | null {
  const holding = new Set<string>(interactingIds(appState))
  const drawing = appState.multiElement?.id
  const lineEdit = appState.editingLinearElement?.elementId
  if (drawing) holding.add(drawing)
  if (lineEdit) holding.add(lineEdit)
  const stray = new Set(unfinalized(elements as never, holding))
  return stray.size === 0 ? null : elements.filter((element) => !stray.has(element.id))
}

type ControllerHost = {
  root: () => HTMLDivElement | null
  arm: () => void
  /** The host's panel handler, when it hosts the library and search itself. */
  panel: () => ((panel: WhiteboardPanel) => void) | undefined
  library: () => LibraryItems
  /** False in view-only mode; checked again after the async parse, since the mode can change meanwhile. */
  editable: () => boolean
  /** QUINCY ADDITION #499: the element hash right after a remote merge, so the editor's own change event for it is not a local edit. */
  remoteApplied: (hash: number, taken: readonly { id: string; version: number; versionNonce: number }[]) => void
  /** QUINCY ADDITION #499: has the person already changed this element since the load? */
  edited?: (element: { id: string; version: number; versionNonce: number }) => boolean
  /** QUINCY ADDITION #501: does this board hold the media (an element references it, deleted ones included, or it was uploaded in this session)? */
  knownMedia?: (mediaId: string) => boolean
  /** QUINCY ADDITION #501: media this session put on the board, so a paste of it counts as known even after its element is purged. */
  uploadedMedia?: (mediaId: string) => void
  /** QUINCY ADDITION #501: media elements from another board were refused on a scene file load. */
  refusedMedia?: (count: number) => void
}

/** Whether an element hides what is beneath its footprint for a click (images, text, opaque shapes). Frames, lines, arrows, freedraw and transparent shapes are mostly empty or drawn behind. */
function occludesVideo(element: { type: string; backgroundColor?: string }): boolean {
  if (element.type === "image" || element.type === "text") return true
  if (element.type === "rectangle" || element.type === "diamond" || element.type === "ellipse") return element.backgroundColor !== undefined && element.backgroundColor !== "transparent"
  return false
}

export function createController(
  api: ExcalidrawImperativeAPI,
  { root, arm, panel, library, editable, remoteApplied, edited, knownMedia, uploadedMedia, refusedMedia }: ControllerHost
): WhiteboardController {
  const libraryItem = (id: string) => library().find((item) => item.id === id)
  // QUINCY ADDITION #499: canonical (server / authored) index per element, apart from the one the renderer repaired it to.
  const scrollTo = (ids?: readonly string[]) => {
    arm()
    const elements = api.getSceneElements()
    if (ids?.length) {
      fitElements(
        api,
        elements.filter((element) => ids.includes(element.id)),
        true,
        root()
      )
    } else {
      fitElements(api, elements, false, root())
    }
  }

  // QUINCY ADDITION #499: merges a batch into the board and returns every element now on it. Restore, reconcile and the index
  // repair they do never change a revision (see whiteboard-merge.ts).
  const mergeInto = (
    batch: readonly unknown[],
    hold: (element: ExcalidrawElement) => ServerHold
  ) => {
    const merged = mergeRemote(
      api.getSceneElementsIncludingDeleted() as unknown as MergeElement[],
      batch as never,
      {
        restore: (raw) => restoreElements(raw as never, null) as unknown as MergeElement[],
        reconcile: (local, incoming) =>
          reconcileElements(
            local as never,
            incoming as never,
            api.getAppState()
          ) as unknown as MergeElement[],
      },
      (element) => hold(element as never),
      interactingIds(api.getAppState())
    )
    api.updateScene({
      elements: merged as never,
      captureUpdate: CaptureUpdateAction.NEVER,
    })
    return api.getSceneElementsIncludingDeleted()
  }

  return {
    api,
    getScene: () => readScene(api),
    getSelectedIds: () => {
      // Undo, replace and clear drop elements but leave their ids selected.
      const live = new Set(api.getSceneElements().map((element) => element.id))
      return Object.keys(api.getAppState().selectedElementIds).filter((id) =>
        live.has(id)
      )
    },
    toJSON: () =>
      serializeAsJSON(
        api.getSceneElements(),
        { ...api.getAppState(), viewBackgroundColor: EXPORT_BACKGROUND },
        api.getFiles(),
        "local"
      ),
    load: async (file) => {
      const result = await loadSceneOrLibraryFromBlob(
        file,
        api.getAppState(),
        api.getSceneElements()
      )
      if (!editable()) throw new Error("The whiteboard is view only.")
      arm()
      if (result.type === MIME_TYPES.excalidrawlib) {
        const hostPanel = panel()
        await api.updateLibrary({
          libraryItems: file,
          merge: true,
          openLibraryMenu: !hostPanel,
        })
        hostPanel?.("library")
        return "library"
      }
      // QUINCY #501: a scene file is a LOCAL entry point. Media this board does not hold came from another board and is dropped; the file's
      // own image data is never used (the resolver supplies every media file, so a crafted file cannot paint pixels under a media id).
      const { kept, removed } = knownMedia
        ? withoutForeignMedia(result.data.elements, knownMedia)
        : { kept: result.data.elements, removed: 0 }
      if (removed > 0) refusedMedia?.(removed)
      replaceContent(
        api,
        { elements: kept as typeof result.data.elements, files: [] },
        true
      )
      scrollTo()
      return "scene"
    },
    replace: (content, options) => {
      arm()
      const undoable = options?.undoable ?? true
      replaceContent(api, content, undoable)
      if (undoable) return
      // A new document: the old history would rewrite it. Clearing fires no history
      // event, so a run of the editor's own lit button on the empty stack relights both.
      api.history.clear()
      const stale = (["undo", "redo"] as const)
        .map((action) => historyButton(root(), action))
        .find(canRun)
      stale?.click()
    },
    insert: (skeleton) => {
      const converted = convertSkeleton(skeleton, true)
      if (!converted.length) return []
      arm()
      const [minX, minY, maxX, maxY] = getCommonBounds(converted)
      const existing = api.getSceneElements()
      let dx: number
      let dy: number
      if (existing.length) {
        // Beside the board, never on top of someone's work.
        const [, boardTop, boardRight] = getCommonBounds(existing)
        dx = boardRight + INSERT_GAP - minX
        dy = boardTop - minY
      } else {
        const centre = viewCentre(api.getAppState())
        dx = centre.x - (minX + maxX) / 2
        dy = centre.y - (minY + maxY) / 2
      }
      const moved = converted.map((element) =>
        newElementWith(element, { x: element.x + dx, y: element.y + dy })
      )
      const ids = moved
        .filter(
          (element) =>
            element.frameId === null &&
            !(element.type === "text" && element.containerId !== null)
        )
        .map((element) => element.id)
      const selectedElementIds: Record<string, true> = {}
      for (const id of ids) selectedElementIds[id] = true
      api.updateScene({
        elements: [...api.getSceneElementsIncludingDeleted(), ...moved],
        appState: { selectedElementIds },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      })
      scrollTo(ids)
      return ids
    },
    clear: () => {
      arm()
      api.updateScene({
        elements: tombstones(api.getSceneElementsIncludingDeleted()),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      })
    },
    // QUINCY ADDITION #501: a board image or video is an `image` element that REFERENCES an Embedded media row. It is built the way the
    // editor builds an image (a skeleton through convertToExcalidrawElements, `status: "saved"` because newImageElement defaults to
    // "pending"), appended as one undoable change, and only then is its file added (the editor scans the scene for uncached images).
    insertMedia: ({ fileId, kind, file, width, height, at, cascade }) => {
      if (!editable()) return null
      arm()
      const state = api.getAppState()
      // About 40% of the view's short side, never above the media's natural size.
      const fit = (Math.min(state.width, state.height) * 0.4) / state.zoom.value
      const scale = Math.min(1, fit / Math.max(width, height, 1))
      const w = Math.max(1, Math.round(width * scale))
      const h = Math.max(1, Math.round(height * scale))
      // Several files from one choice fan out from the same point, a step apart, so none hides another.
      const base = at ?? viewCentre(state)
      const step = (cascade ?? 0) * (INSERT_CASCADE / state.zoom.value)
      const centre = { x: base.x + step, y: base.y + step }
      const [element] = convertToExcalidrawElements(
        [
          {
            type: "image",
            fileId: fileId as FileId,
            status: "saved",
            customData: { quincyMedia: { kind } },
            x: centre.x - w / 2,
            y: centre.y - h / 2,
            width: w,
            height: h,
          },
        ],
        { regenerateIds: false }
      )
      if (!element) return null
      uploadedMedia?.(fileId)
      const placedMedia = [element]
      api.updateScene({
        elements: [...api.getSceneElementsIncludingDeleted(), ...placedMedia],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      })
      api.addFiles([toBinaryFile(file)])
      return element.id
    },
    addMediaFiles: (files) => {
      const held = api.getFiles()
      const missing = files.filter((file) => !(file.id in held))
      if (missing.length) api.addFiles(missing.map(toBinaryFile))
    },
    videoAt: (clientX, clientY) => {
      const state = api.getAppState()
      const edit = editable()
      const tool = state.activeTool.type
      if (edit && tool !== "selection" && tool !== "hand") return null
      const point = viewportCoordsToSceneCoords({ clientX, clientY }, state)
      const elements = api.getSceneElements()
      for (let index = elements.length - 1; index >= 0; index -= 1) {
        const element = elements[index]!
        const ref = whiteboardMediaRef(element as unknown as Record<string, unknown>)
        const isVideo = ref?.kind === "video"
        if (!isVideo && !occludesVideo(element)) continue
        // The point in the element's own frame (undo its rotation about its centre).
        const dx = point.x - (element.x + element.width / 2)
        const dy = point.y - (element.y + element.height / 2)
        const cos = Math.cos(-element.angle)
        const sin = Math.sin(-element.angle)
        const rx = dx * cos - dy * sin
        const ry = dx * sin + dy * cos
        if (Math.abs(rx) > element.width / 2 || Math.abs(ry) > element.height / 2) continue
        // The topmost element under the point decides: anything opaque above a video's badge hides it.
        if (!isVideo) return null
        // Editing: only the play badge opens it (a click anywhere else selects, drags, resizes). Viewing: the whole element.
        if (edit && Math.hypot(rx, ry) > Math.max(Math.min(element.width, element.height) * BADGE_HIT_RADIUS, BADGE_MIN_HIT_PX / state.zoom.value)) return null
        return ref.id
      }
      return null
    },
    selectedVideo: () => {
      const live = new Map(api.getSceneElements().map((element) => [element.id, element]))
      const ids = Object.keys(api.getAppState().selectedElementIds).filter((id) => live.has(id))
      const only = ids.length === 1 ? live.get(ids[0]!) : undefined
      const ref = only ? whiteboardMediaRef(only as unknown as Record<string, unknown>) : null
      return ref?.kind === "video" ? ref.id : null
    },
    scrollTo,
    exportImage: async (options) => {
      const settings = exportOptions(api, options)
      if (options.format === "svg") {
        const svg = await toSvg(settings)
        return new Blob([svg.outerHTML], { type: MIME_TYPES.svg })
      }
      return toBlob({ ...settings, mimeType: MIME_TYPES.png })
    },
    copyImage: (options) =>
      toClipboard({
        ...exportOptions(api, options),
        type: options.format,
      }),
    setCollaborators: (collaborators) => {
      // Remote presence is never the local user's undo history.
      api.updateScene({
        collaborators: new Map(
          collaborators.map((person) => [
            toSocketId(person.id),
            // QUINCY ADDITION #551: a selection with no cursor still carries its owner's name.
            toCollaborator(withSelectionAnchor(person, api.getSceneElements())),
          ])
        ),
        captureUpdate: CaptureUpdateAction.NEVER,
      })
    },
    // QUINCY ADDITION #499: other people's elements, merged by Excalidraw's own rule and kept out of Undo.
    applyRemote: (remote, hold) => {
      const scene = mergeInto(remote, hold)
      // handleChange must not read this as a local edit (a remote tick would flash "Unsaved changes").
      // Only what the scene actually took of the batch is remote; an unreported local edit stays the person's own.
      const taken = new Map(remote.map((element) => [String((element as { id: unknown }).id), element as { version: number; versionNonce: number }]))
      remoteApplied(
        hashElementsVersion(scene),
        scene.filter((element) => {
          const incoming = taken.get(element.id)
          return incoming !== undefined && incoming.version === element.version && incoming.versionNonce === element.versionNonce
        })
      )
      return scene
    },
    // QUINCY ADDITION #499: the person's own deletion of an element the editor dropped: merged like a remote one, never recorded as remote.
    applyLocal: (elements, hold) => mergeInto(elements, hold),
    author: (element, updates) => newElementWith(element, updates as never),
    adoptRevisions: (arrived) => {
      // The editor's own restore of `initialData` repaired indices and bumped revisions; the server's are what count.
      // An element the person edited before this ran keeps its own revision: it is their edit, not a repair.
      const scene = api.getSceneElementsIncludingDeleted()
      const left = new Set<unknown>(adoptArrivedRevisions(scene, arrived as never, edited))
      api.updateScene({
        elements: scene as never,
        captureUpdate: CaptureUpdateAction.NEVER,
      })
      const adopted = api.getSceneElementsIncludingDeleted()
      remoteApplied(hashElementsVersion(adopted), adopted.filter((element) => !left.has(element) && arrived.some((a) => (a as { id: string }).id === element.id)))
    },
    select: (ids) => {
      const selectedElementIds: Record<string, true> = {}
      for (const id of ids) selectedElementIds[id] = true
      api.updateScene({
        appState: { selectedElementIds, selectedGroupIds: {} },
        captureUpdate: CaptureUpdateAction.NEVER,
      })
    },
    openLibrary: () => {
      const hostPanel = panel()
      if (hostPanel) hostPanel("library")
      else api.toggleSidebar({ name: "default", tab: "library", force: true })
    },
    getLibrary: () => library().map(toLibraryEntry),
    addToLibrary: async (itemName) => {
      const selected = new Set(
        Object.keys(api.getAppState().selectedElementIds)
      )
      const picked = api
        .getSceneElements()
        .filter(
          (element) =>
            selected.has(element.id) ||
            (element.frameId !== null && selected.has(element.frameId)) ||
            (element.type === "text" &&
              element.containerId !== null &&
              selected.has(element.containerId))
        )
      if (!picked.length) return null
      if (picked.some((element) => LIBRARY_EXCLUDED.has(element.type))) {
        throw new Error("Images and embeds cannot join the library.")
      }
      const item: LibraryItem = {
        id: freshId(),
        name: itemName,
        status: "unpublished",
        created: Date.now(),
        elements: structuredClone(picked),
      }
      await api.updateLibrary({
        libraryItems: (items) => [item, ...items],
      })
      return toLibraryEntry(item)
    },
    removeFromLibrary: async (id) => {
      await api.updateLibrary({
        libraryItems: (items) => items.filter((item) => item.id !== id),
      })
    },
    insertFromLibrary: (id) => {
      const item = libraryItem(id)
      if (!item?.elements.length) return []
      arm()
      const copies = cloneWithFreshIds(item.elements)
      const [minX, minY, maxX, maxY] = getCommonBounds(copies)
      const centre = viewCentre(api.getAppState())
      const dx = centre.x - (minX + maxX) / 2
      const dy = centre.y - (minY + maxY) / 2
      const placed = copies.map((element) =>
        newElementWith(element, { x: element.x + dx, y: element.y + dy })
      )
      // Frame contents and labels ride along with their frame or shape.
      const top = placed.filter(
        (element) =>
          element.frameId === null &&
          !(element.type === "text" && element.containerId !== null)
      )
      const selectedElementIds: Record<string, true> = {}
      const selectedGroupIds: Record<string, true> = {}
      for (const element of top) {
        selectedElementIds[element.id] = true
        const outermost = element.groupIds.at(-1)
        if (outermost) selectedGroupIds[outermost] = true
      }
      api.updateScene({
        elements: [...api.getSceneElementsIncludingDeleted(), ...placed],
        appState: { selectedElementIds, selectedGroupIds },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      })
      return top.map((element) => element.id)
    },
    previewLibraryItem: (id, { dark, size }) => {
      const item = libraryItem(id)
      if (!item) return Promise.reject(new Error(`No library item ${id}`))
      return toBlob({
        elements: item.elements,
        files: null,
        exportPadding: 8,
        appState: {
          exportBackground: false,
          exportWithDarkMode: dark,
          viewBackgroundColor: EXPORT_BACKGROUND,
        },
        // Scaled up or down so every shape fills the same tile.
        getDimensions: (width, height) => {
          const scale = Math.min(size / Math.max(width, height), 4)
          return { width: width * scale, height: height * scale, scale }
        },
        mimeType: MIME_TYPES.png,
      })
    },
    dragLibraryItem: (id, dataTransfer) => {
      const item = libraryItem(id)
      if (!item) return
      // The editor's own drop target copies the shape where it lands.
      dataTransfer.setData(
        MIME_TYPES.excalidrawlib,
        serializeLibraryAsJSON([item])
      )
      dataTransfer.effectAllowed = "copy"
    },
    focus: () => boardElement(root())?.focus(),
    focusTarget: () => boardElement(root()),
  }
}

/** The host <html lang> matched to a shipped Excalidraw locale, else English. */
function matchLanguage(lang: string | null) {
  if (!lang) return defaultLang.code
  const prefix = lang.split("-")[0]
  const match =
    languages.find((language) => language.code === lang) ??
    languages.find((language) => language.code.split("-")[0] === prefix)
  return match?.code ?? defaultLang.code
}

/** Until the editor's first onChange: its defaults at the opening zoom; the
 * layout (phone or desktop) is measured before the first paint. */
function initialChrome(zoom: number, viewMode: boolean): ChromeState {
  return {
    tool: "selection",
    zoom,
    grid: false,
    snap: false,
    viewMode,
    selected: false,
    penMode: false,
    penDetected: false,
    phone: false,
    narrow: false,
    frameAt: null,
  }
}

const NO_FRAMES: readonly BoardFrame[] = []

// Shift plus these fit, as the footer's Zoom to Fit and Zoom to Selection.
const FIT_KEYS: Partial<Record<string, FitTarget>> = {
  Digit1: "all",
  Digit2: "selection",
}

// The frame keys, as the Keyboard Shortcuts dialog lists them.
const FRAME_KEYS: Partial<Record<string, -1 | 1>> = {
  BracketLeft: -1,
  BracketRight: 1,
}

type AutosaveOptions = Pick<
  WhiteboardCanvasProps,
  "onChange" | "onSave" | "onSaveStatusChange" | "discardSave"
> & { changeDelay: number; autosaveDelay: number }

// QUINCY ADDITION #499: a failed or refused save (the server answers `stale` while an access change is landing) is
// retried by the autosave itself, 1 s, 2 s, 4 s ... capped at 30 s, until it goes through or the board closes.
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 30_000

/** The settled onChange and the autosave: onSave after edits idle, when the page
 * hides and on unmount, reporting the status as it moves. */
export function useAutosave(
  api: ExcalidrawImperativeAPI | null,
  options: RefObject<AutosaveOptions>,
  // QUINCY ADDITION #499: while paused (a view-only board) nothing is saved and pending edits stay dirty, never
  // reported "saved"; they are saved when the pause ends.
  paused = false
) {
  const pausedRef = useRef(paused)
  const apiRef = useRef(api)
  useEffect(() => {
    apiRef.current = api
  }, [api])
  const dirtyRef = useRef(false)
  const savingRef = useRef(false)
  const pendingRef = useRef(false)
  const statusRef = useRef<WhiteboardSaveStatus>("saved")
  // The scene read at unmount; the editor empties itself right after.
  const finalSceneRef = useRef<WhiteboardScene | null>(null)
  const changeTimer = useRef<number | undefined>(undefined)
  const saveTimer = useRef<number | undefined>(undefined)
  const retryTimer = useRef<number | undefined>(undefined)
  const failuresRef = useRef(0)
  const closedRef = useRef(false)

  const report = useCallback(
    (status: WhiteboardSaveStatus) => {
      if (statusRef.current === status) return
      statusRef.current = status
      options.current.onSaveStatusChange?.(status)
    },
    [options]
  )

  // Declared before flush and bound to it through a ref, since the retry calls flush and flush arms the retry.
  const flushRef = useRef<() => Promise<void>>(async () => undefined)
  const scheduleRetry = useCallback(() => {
    if (closedRef.current) return
    const delay = Math.min(RETRY_BASE_MS * 2 ** failuresRef.current, RETRY_MAX_MS)
    failuresRef.current += 1
    window.clearTimeout(retryTimer.current)
    retryTimer.current = window.setTimeout(() => void flushRef.current(), delay)
  }, [])

  const flush = useCallback(async () => {
    const current = apiRef.current
    const save = options.current.onSave
    if (!current || !save || !dirtyRef.current) return
    // QUINCY ADDITION #500: the host is replacing this board's scene (a version was restored): what is pending is not sent.
    if (options.current.discardSave?.()) {
      dirtyRef.current = false
      finalSceneRef.current = null
      return
    }
    if (pausedRef.current && !closedRef.current) {
      report("unsaved")
      return
    }
    if (savingRef.current) {
      pendingRef.current = true
      return
    }
    window.clearTimeout(saveTimer.current)
    window.clearTimeout(retryTimer.current)
    dirtyRef.current = false
    savingRef.current = true
    report("saving")
    try {
      const outcome = await save(finalSceneRef.current ?? readScene(current))
      if (outcome === WHITEBOARD_SAVE_SKIPPED) {
        // QUINCY ADDITION #499: nothing was sent (the board went view-only before this hook's pause caught up). The
        // edit is still unsaved: keep it dirty and never report Saved. The pause ending flushes it, but the restore can
        // land before React ever commits paused=true (no flip, no resume effect), so arm the same bounded retry as a
        // failed save. Each retry goes through this flush: paused, it stays dirty and waits; not paused, it sends.
        dirtyRef.current = true
        report("unsaved")
        scheduleRetry()
      } else {
        failuresRef.current = 0
        report(dirtyRef.current ? "unsaved" : "saved")
      }
    } catch {
      // Keep the edits dirty, so the next change or page hide retries the save.
      dirtyRef.current = true
      report("error")
      // QUINCY ADDITION #499: and retry without waiting for another edit, backing off to a bound.
      scheduleRetry()
    } finally {
      savingRef.current = false
      if (pendingRef.current) {
        pendingRef.current = false
        void flush()
      }
    }
  }, [options, report, scheduleRetry])
  useEffect(() => {
    flushRef.current = flush
  }, [flush])

  // The pause ends: whatever is still dirty goes out now, with no new edit.
  useEffect(() => {
    pausedRef.current = paused
    if (!paused && dirtyRef.current) void flush()
  }, [paused, flush])

  const markDirty = useCallback(() => {
    if (!options.current.onSave) return
    dirtyRef.current = true
    report("unsaved")
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(
      () => void flush(),
      options.current.autosaveDelay
    )
  }, [flush, options, report])

  const scheduleChange = useCallback(() => {
    window.clearTimeout(changeTimer.current)
    changeTimer.current = window.setTimeout(() => {
      const current = apiRef.current
      if (current) options.current.onChange?.(readScene(current))
    }, options.current.changeDelay)
  }, [options])

  // A hidden tab may never come back, so pending edits save on the way out.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void flush()
    }
    const onPageHide = () => void flush()
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pagehide", onPageHide)
    return () => {
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pagehide", onPageHide)
    }
  }, [flush])

  // Layout cleanup runs before the editor unmounts, while the scene is readable,
  // so a save still in flight re-runs against this snapshot, never an empty board.
  useLayoutEffect(() => {
    finalSceneRef.current = null
    closedRef.current = false
    return () => {
      closedRef.current = true
      window.clearTimeout(changeTimer.current)
      window.clearTimeout(saveTimer.current)
      window.clearTimeout(retryTimer.current)
      const current = apiRef.current
      // QUINCY ADDITION #500: a board reset discards the pending edit; the teardown flush is exactly what would resurrect it.
      if (options.current.discardSave?.()) {
        dirtyRef.current = false
        finalSceneRef.current = null
        return
      }
      if (dirtyRef.current && current) {
        finalSceneRef.current = readScene(current)
      }
      void flush()
    }
  }, [flush])

  return { markDirty, scheduleChange }
}

/** The editor's language (the host <html lang> matched when none is given). The
 * editor writes <html lang dir> on mount and on every change; the host's go back. */
function useHostLanguage(langCode: string | undefined) {
  const [host] = useState(() => ({
    lang: document.documentElement.getAttribute("lang"),
    dir: document.documentElement.getAttribute("dir"),
  }))
  const language = langCode ?? matchLanguage(host.lang)
  // Runs after the editor's own language effect and update, which write at once.
  useEffect(() => {
    const html = document.documentElement
    for (const [attribute, value] of [
      ["lang", host.lang],
      ["dir", host.dir],
    ] as const) {
      if (value === null) html.removeAttribute(attribute)
      else html.setAttribute(attribute, value)
    }
  }, [host, language])
  return language
}

/** Whether the editor's undo and redo can run: it re-renders its own buttons as its
 * history changes, and the footer's pair mirrors them (0.18.1 has no history API). */
function useHistoryMirror(
  rootRef: RefObject<HTMLDivElement | null>,
  api: ExcalidrawImperativeAPI | null
) {
  const [history, setHistory] = useState<HistoryState>(NO_HISTORY)
  useEffect(() => {
    const root = rootRef.current
    if (!root || !api) return
    const read = () => {
      const next = {
        undo: canRun(historyButton(root, "undo")),
        redo: canRun(historyButton(root, "redo")),
      }
      setHistory((previous) =>
        previous.undo === next.undo && previous.redo === next.redo
          ? previous
          : next
      )
    }
    read()
    const observer = new MutationObserver(read)
    observer.observe(root.querySelector(".excalidraw") ?? root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["disabled", "aria-disabled"],
    })
    return () => observer.disconnect()
  }, [api, rootRef])
  return history
}

type BoardKeys = {
  toggleViewOnly: (pickedWith: PickedWith) => void
  fit: (target: FitTarget, pickedWith: PickedWith) => void
  /** Steps to the previous (-1) or next (1) frame; false when there is none. */
  stepFrame: (step: -1 | 1) => boolean
  openShortcuts: () => void
  hostPanel: () => ((panel: WhiteboardPanel) => void) | undefined
}

/** The board's own keys, taken on its root in the capture phase before the editor
 * sees them: View Only, the fits, frame steps, Keyboard Shortcuts and the blocked ones. */
function useBoardKeys(
  rootRef: RefObject<HTMLDivElement | null>,
  keys: BoardKeys
) {
  const { toggleViewOnly, fit, stepFrame, openShortcuts, hostPanel } = keys
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onKeyDown = (event: KeyboardEvent) => {
      const typing = event.isComposing || isWritable(event.target)
      const modified = event.ctrlKey || event.metaKey || event.shiftKey
      // Alt+R is the editor's view mode key; the embed owns view only, so it
      // switches that instead of the editor's reverted toggle.
      if (!typing && event.altKey && !modified && event.code === "KeyR") {
        event.preventDefault()
        event.stopPropagation()
        toggleViewOnly(null)
        return
      }
      // Shift+1 and Shift+2 fit like the footer, clear of the kit's chrome; the
      // editor's own fits leave only 16px at the bottom, under the footer.
      const fitKey = FIT_KEYS[event.code]
      if (fitKey && !typing && event.shiftKey && !event.altKey) {
        if (event.ctrlKey || event.metaKey) return
        event.preventDefault()
        event.stopPropagation()
        fit(fitKey, null)
        return
      }
      // [ and ] step through the frames in reading order.
      const step = FRAME_KEYS[event.code]
      if (step && !typing && !modified && !event.altKey) {
        if (!stepFrame(step)) return
        event.preventDefault()
        event.stopPropagation()
        return
      }
      // The editor opens its Help on "?" before any action runs, so it stops here.
      if (event.key === "?") {
        if (event.ctrlKey || event.metaKey || event.altKey || typing) return
        event.preventDefault()
        event.stopPropagation()
        openShortcuts()
        return
      }
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey)
        return
      const key = event.key.toLowerCase()
      // The editor clears the board on Mod+Delete even with clearCanvas off; the
      // host's own Clear (confirm, toast, undo) is the one way to do it.
      if ((key === "delete" || key === "backspace") && !typing) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      // Find goes to the host's panel, so the editor's sidebar never opens.
      const panel = hostPanel()
      if (key === "f" && panel) {
        event.preventDefault()
        event.stopPropagation()
        panel("search")
        return
      }
      // Ctrl+P makes the editor point at its command palette, which 0.18.1 never
      // renders, so the shortcut stops at the board, as printing already did.
      if (key !== "p") return
      event.preventDefault()
      event.stopPropagation()
    }
    root.addEventListener("keydown", onKeyDown, true)
    return () => root.removeEventListener("keydown", onKeyDown, true)
  }, [rootRef, toggleViewOnly, fit, stepFrame, openShortcuts, hostPanel])
}

/** Text is wrapped when the scene loads, often before its web font arrives; once
 * fonts land, untouched boards re-wrap from the original text. */
function useFontRewrap(
  api: ExcalidrawImperativeAPI | null,
  ready: boolean,
  armedRef: RefObject<boolean>
) {
  useEffect(() => {
    if (!ready || !api) return
    let cancelled = false
    const rewrap = () => {
      if (cancelled || armedRef.current) return
      const current = api.getSceneElementsIncludingDeleted()
      const before = new Map(current.map((element) => [element.id, element]))
      const rewrapped = seatLabels(
        restoreElements(
          current.map((element) =>
            element.type === "text" && element.containerId !== null
              ? { ...element, text: element.originalText }
              : element
          ),
          null,
          { refreshDimensions: true, repairBindings: true }
        )
      )
      // Undo keeps its own copy of each element and refreshes it only when the
      // version moves, so a re-measured element gets a new version.
      api.updateScene({
        elements: rewrapped.map((element) =>
          sameBox(element, before.get(element.id))
            ? element
            : newElementWith(element, {}, true)
        ),
        captureUpdate: CaptureUpdateAction.NEVER,
      })
    }
    void document.fonts.ready.then(rewrap)
    document.fonts.addEventListener("loadingdone", rewrap)
    return () => {
      cancelled = true
      document.fonts.removeEventListener("loadingdone", rewrap)
    }
  }, [ready, api, armedRef])
}

/** Keeps the editor's idea of its container true to the board's box once loaded,
 * re-centring the opening view on the way until the first interaction. */
function useContainerFollow(
  rootRef: RefObject<HTMLDivElement | null>,
  api: ExcalidrawImperativeAPI | null,
  ready: boolean,
  armedRef: RefObject<boolean>,
  latest: RefObject<{ openingZoom: number }>
) {
  // Hosts often settle their layout after mount (a panel docks, a tab shows),
  // so the opening view re-centres with the container.
  useEffect(() => {
    const root = rootRef.current
    if (!ready || !api || !root) return
    let last = root.getBoundingClientRect()
    const observer = new ResizeObserver(() => {
      const rect = root.getBoundingClientRect()
      if (armedRef.current) return
      if (rect.width === last.width && rect.height === last.height) return
      last = rect
      const view = openingView(
        api.getSceneElements(),
        rect,
        latest.current.openingZoom
      )
      if (view) {
        api.updateScene({
          appState: view,
          captureUpdate: CaptureUpdateAction.NEVER,
        })
      }
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [ready, api, rootRef, armedRef, latest])

  // A host transform at mount (a Dialog's zoom in) skews the one rect the editor
  // reads, and its end fires none of the editor's observers, so the board re-reads it.
  useEffect(() => {
    const root = rootRef.current
    if (!ready || !api || !root) return
    const settle = () => {
      const rect = root.getBoundingClientRect()
      const state = api.getAppState()
      if (rect.width !== state.width || rect.height !== state.height) {
        const view = armedRef.current
          ? null
          : openingView(
              api.getSceneElements(),
              rect,
              latest.current.openingZoom
            )
        const { zoom, scrollX, scrollY } = view ?? state
        // refresh() re-reads only the offsets, so the size goes through updateScene.
        api.updateScene({
          appState: {
            width: rect.width,
            height: rect.height,
            offsetLeft: rect.left,
            offsetTop: rect.top,
            zoom,
            scrollX,
            scrollY,
          },
          captureUpdate: CaptureUpdateAction.NEVER,
        })
      } else if (
        rect.left !== state.offsetLeft ||
        rect.top !== state.offsetTop
      ) {
        api.refresh()
      }
    }
    settle()
    const onEnd = (event: Event) => {
      if (event.target instanceof Node && event.target.contains(root)) settle()
    }
    document.addEventListener("animationend", onEnd, true)
    document.addEventListener("transitionend", onEnd, true)
    return () => {
      document.removeEventListener("animationend", onEnd, true)
      document.removeEventListener("transitionend", onEnd, true)
    }
  }, [ready, api, rootRef, armedRef, latest])
}

export function WhiteboardCanvas({
  initialData,
  onChange,
  changeDelay = 300,
  onSave,
  autosaveDelay = 1500,
  onSaveStatusChange,
  discardSave,
  onElements,
  onPresence,
  onReady,
  mediaTool,
  onVideoOpen,
  readOnly = false,
  viewOnlyIndicator = true,
  onReadOnlyChange,
  imageTool = true,
  theme,
  name,
  langCode,
  assetPath,
  menu,
  welcome,
  background = "grid",
  initialZoom: openingZoom,
  actions,
  onPanelRequest,
  onLibraryChange,
  onToast,
  rootRef,
  onLoaded,
}: WhiteboardCanvasProps) {
  // Fonts resolve their URLs on first use, so the path is set before mount.
  useState(() => {
    if (assetPath && window.EXCALIDRAW_ASSET_PATH === undefined) {
      window.EXCALIDRAW_ASSET_PATH = assetPath
    }
    return null
  })
  const language = useHostLanguage(langCode)

  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const [controller, setController] = useState<WhiteboardController | null>(
    null
  )
  const [ready, setReady] = useState(false)
  const [chrome, setChrome] = useState<ChromeState>(() =>
    initialChrome(openingZoom, readOnly)
  )
  const [frames, setFrames] = useState<readonly BoardFrame[]>(NO_FRAMES)
  const [footer, setFooter] = useState<HTMLDivElement | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // View only is the host's when it listens for changes; otherwise the board
  // keeps its own, which a readOnly board holds on.
  const [ownViewOnly, setOwnViewOnly] = useState(false)
  const viewOnlyControlled = onReadOnlyChange !== undefined
  const viewOnly = viewOnlyControlled ? readOnly : readOnly || ownViewOnly
  const viewOnlyLocked = !viewOnlyControlled && readOnly

  const latest = useRef({
    initialData,
    onChange,
    onSave,
    onSaveStatusChange,
    discardSave,
    onElements,
    onPresence,
    onReady,
    changeDelay,
    autosaveDelay,
    openingZoom,
    onPanelRequest,
    onLibraryChange,
    onToast,
    onReadOnlyChange,
    mediaTool,
    onVideoOpen,
    viewOnly,
    viewOnlyLocked,
  })
  useLayoutEffect(() => {
    latest.current = {
      initialData,
      onChange,
      onSave,
      onSaveStatusChange,
      discardSave,
      onElements,
      onPresence,
      onReady,
      changeDelay,
      autosaveDelay,
      openingZoom,
      onPanelRequest,
      onLibraryChange,
      onToast,
      onReadOnlyChange,
      mediaTool,
      onVideoOpen,
      viewOnly,
      viewOnlyLocked,
    }
  })

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const layerRef = useRef<HTMLDivElement | null>(null)
  const libraryRef = useRef<LibraryItems>([])
  const framesRef = useRef<readonly BoardFrame[]>(NO_FRAMES)
  // The frame a step is heading to, shown until the view arrives or the user
  // takes over, so the label never flickers through the frames it passes.
  const steppingRef = useRef<string | null>(null)
  const hashRef = useRef<number | null>(null)
  const loadedRef = useRef(false)
  const signatureRef = useRef("")
  const armedRef = useRef(false)
  // QUINCY ADDITION #499: the element hash a remote merge produced (see applyRemote), and the local presence last reported.
  const changesRef = useRef(createChangeTracker())
  const pointerRef = useRef<{ x: number; y: number } | null>(null)
  const buttonRef = useRef<"up" | "down">("up")
  const selectionRef = useRef("")

  useEffect(() => {
    apiRef.current = api
  }, [api])

  const reportPresence = useCallback((selectedIds: readonly string[]) => {
    latest.current.onPresence?.({
      pointer: pointerRef.current,
      button: buttonRef.current,
      selectedIds,
    })
  }, [])
  const handlePointerUpdate = useCallback(
    (payload: { pointer: { x: number; y: number }; button: "down" | "up" }) => {
      pointerRef.current = { x: payload.pointer.x, y: payload.pointer.y }
      buttonRef.current = payload.button
      const selected = Object.keys(apiRef.current?.getAppState().selectedElementIds ?? {})
      reportPresence(selected)
    },
    [reportPresence]
  )

  const arm = useCallback(() => {
    armedRef.current = true
  }, [])

  const { markDirty, scheduleChange } = useAutosave(api, latest, readOnly)
  const history = useHistoryMirror(rootRef, api)

  const imageToolRef = useRef(imageTool)
  imageToolRef.current = imageTool

  // QUINCY #501: media this session put on the board, so a paste of it is known even after its element was purged.
  const uploadedMediaRef = useRef(new Set<string>())
  /** Does this board hold the media: an element references it (deleted ones included) or it was uploaded here. Judges LOCAL entry points only (paste, scene file); a remote element is never refused by it. */
  const knownMedia = useCallback((mediaId: string) => {
    if (uploadedMediaRef.current.has(mediaId)) return true
    const elements = apiRef.current?.getSceneElementsIncludingDeleted() ?? []
    return elements.some(
      (element) =>
        whiteboardMediaRef(element as unknown as Record<string, unknown>)?.id === mediaId
    )
  }, [])
  /** Where a viewport point is on the board, for placing a dropped or pasted file. */
  const scenePointAt = useCallback((clientX: number, clientY: number) => {
    const state = apiRef.current?.getAppState()
    return state ? viewportCoordsToSceneCoords({ clientX, clientY }, state) : undefined
  }, [])

  // Quincy (#498): the image tool is off, but a paste from another scene carries image elements the
  // server refuses; refuse the paste here, before they are inserted. #501: a well-formed media element is
  // refused too when this board does not hold its media (it came from another board); this board's own is copied as usual.
  const handlePaste = useCallback(
    (data: { elements?: readonly { type?: unknown }[] }) => {
      if (imageTool) return true
      if (pasteIsUnsupported(data, knownMedia)) {
        latest.current.onToast?.("That image or video cannot be pasted here. Add images and videos with the Image or video tool.")
        return false
      }
      return true
    },
    [imageTool, knownMedia]
  )

  // onChange also fires on pointer moves; only a new element hash counts.
  const handleChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState) => {
      // Quincy (#498): images that arrived by file open, library insert or drag-drop (paste is refused
      // earlier) are swept out before they show or are reported, with the same toast. #501: only MALFORMED images
      // (no media id, a hashed Excalidraw fileId); a well-formed media element is NEVER swept, whatever its id,
      // because this runs for REMOTE merges too: a peer's new image has an id this client has never seen, and
      // sweeping it would have the vanish observer delete it for everyone.
      if (!imageToolRef.current) {
        const { kept, removed } = withoutUnsupported(elements)
        if (removed > 0) {
          apiRef.current?.updateScene({
            elements: kept as never,
            captureUpdate: CaptureUpdateAction.NEVER,
          })
          latest.current.onToast?.("Add images and videos with the Image or video tool.")
          return
        }
      }
      // QUINCY ADDITION #499: an unfinalized zero-size element is reported once (so its observer has seen it), then dropped; the
      // update is another change event, where the observer authors its deletion.
      const unfinished = sweepUnfinalized(elements, appState)
      if (unfinished) {
        latest.current.onElements?.(elements)
        apiRef.current?.updateScene({
          elements: unfinished as never,
          captureUpdate: CaptureUpdateAction.NEVER,
        })
        return
      }
      latest.current.onElements?.(elements)
      // QUINCY ADDITION #499: a changed selection is presence too.
      const selected = Object.keys(appState.selectedElementIds)
      const selection = selected.join(",")
      if (selection !== selectionRef.current) {
        selectionRef.current = selection
        reportPresence(selected)
      }
      // Written straight to the layer: panning never re-renders React.
      placeGrid(gridRef.current, appState)
      // Any path left to Excalidraw's own Help swaps it for the kit's dialog
      // before paint; hiding it with CSS would leave its focus trap live.
      if (appState.openDialog?.name === "help") {
        apiRef.current?.updateScene({
          appState: { openDialog: null },
          captureUpdate: CaptureUpdateAction.NEVER,
        })
        setShortcutsOpen(true)
      }
      // A host panel owns the library and search, so the editor's sidebar
      // closes before paint and the request goes to that panel instead.
      const sidebar = appState.openSidebar
      const hostPanel = latest.current.onPanelRequest
      if (sidebar?.name === "default" && hostPanel) {
        apiRef.current?.updateScene({
          appState: { openSidebar: null },
          captureUpdate: CaptureUpdateAction.NEVER,
        })
        hostPanel(sidebar.tab === "search" ? "search" : "library")
      }
      // The editor's confirmations ("Added to library", "Copied styles") go to
      // the host's toaster when it has one, so feedback lives in one place.
      const hostToast = latest.current.onToast
      if (appState.toast && hostToast) {
        const { message } = appState.toast
        apiRef.current?.updateScene({
          appState: { toast: null },
          captureUpdate: CaptureUpdateAction.NEVER,
        })
        hostToast(message)
      }
      const hash = hashElementsVersion(elements)
      if (hash !== hashRef.current) {
        hashRef.current = hash
        const nextFrames = readFrames(elements)
        framesRef.current = nextFrames
        setFrames((previous) =>
          sameFrames(previous, nextFrames) ? previous : nextFrames
        )
      }
      const centre = frameAtCentre(framesRef.current, appState)
      if (centre === steppingRef.current) steppingRef.current = null
      // The controls mirror the tool, zoom, view options and frame, keyboard
      // changes included; an unchanged state keeps its object, so no re-render.
      const next = readChrome(appState, steppingRef.current ?? centre)
      setChrome((previous) => (sameChrome(previous, next) ? previous : next))
      const signature = `${hash}:${next.grid}:${next.snap}`
      if (signature === signatureRef.current) return
      signatureRef.current = signature
      scheduleChange()
      if (!loadedRef.current) {
        changesRef.current.seed(elements)
        loadedRef.current = true
        setReady(true)
        return
      }
      // Font loading re-measures text after load; only edits after a real
      // interaction count as unsaved work.
      // QUINCY ADDITION #499: the change event of a remote merge is not the person's own edit.
      if (changesRef.current.classify(elements, hash) === "remote") return
      if (armedRef.current) markDirty()
    },
    [markDirty, reportPresence, scheduleChange]
  )

  const loadInitialData =
    useCallback(async (): Promise<ExcalidrawInitialDataState> => {
      const source = latest.current.initialData
      const data = typeof source === "function" ? await source() : source
      const elements = [
        ...(data?.elements ?? []),
        ...convertSkeleton(data?.skeleton, false),
      ]
      return {
        elements,
        files: Object.fromEntries(
          (data?.files ?? []).map((file) => [file.id, toBinaryFile(file)])
        ),
        // Never undefined, so onLibraryChange fires on load, empty included.
        libraryItems: data?.library ? toLibraryItems(data.library) : [],
        appState: {
          ...data?.appState,
          // The hairlines and Grid share one cell; a gridStep of 1 drops the editor's
          // bold solid lines, so Grid never draws heavier than the hairlines.
          gridSize: GRID_CELL,
          gridStep: 1,
          viewBackgroundColor: CANVAS_BACKGROUND,
          ...openingView(
            elements,
            rootRef.current?.getBoundingClientRect(),
            latest.current.openingZoom
          ),
        },
        scrollToContent: false,
      }
    }, [rootRef])

  const handleLinkOpen = useCallback(
    (
      element: NonDeletedExcalidrawElement,
      event: CustomEvent<{ nativeEvent: MouseEvent | React.PointerEvent }>
    ) => {
      const link = element.link
      if (!link) return
      // The host page never navigates away from under the board.
      event.preventDefault()
      if (isElementLink(link)) {
        apiRef.current?.scrollToContent(link, {
          fitToContent: true,
          animate: motionAllowed(),
        })
        return
      }
      window.open(normalizeLink(link), "_blank", "noopener,noreferrer")
    },
    []
  )

  // The editor listens for keys on its own container, so a pointer pick hands
  // focus back to it, as its own toolbar does; a keyboard pick keeps its place.
  const focusBoard = useCallback(() => {
    boardElement(rootRef.current)?.focus()
  }, [rootRef])

  // Grid and snap are the editor's own state (Mod+' and Alt+S flip it too).
  const togglePreference = useCallback(
    (key: WhiteboardPreference, pickedWith: PickedWith) => {
      const current = apiRef.current
      if (!current) return
      const state = current.getAppState()
      const captureUpdate = CaptureUpdateAction.NEVER
      armedRef.current = true
      if (key === "grid") {
        current.updateScene({
          appState: { gridModeEnabled: !state.gridModeEnabled },
          captureUpdate,
        })
      } else if (key === "snap") {
        current.updateScene({
          appState: { objectsSnapModeEnabled: !state.objectsSnapModeEnabled },
          captureUpdate,
        })
      } else {
        current.updateScene({
          appState: { penMode: !state.penMode },
          captureUpdate,
        })
      }
      if (pickedWith) focusBoard()
    },
    [focusBoard]
  )

  // Alt+R and the footer toggle; a readOnly board without onReadOnlyChange stays locked.
  const toggleViewOnly = useCallback(
    (pickedWith: PickedWith) => {
      const {
        onReadOnlyChange: hostChange,
        viewOnly: on,
        viewOnlyLocked: locked,
      } = latest.current
      if (locked) return
      armedRef.current = true
      if (hostChange) hostChange(!on)
      else setOwnViewOnly(!on)
      if (pickedWith) focusBoard()
    },
    [focusBoard]
  )

  const selectTool = useCallback(
    (tool: WhiteboardTool, pickedWith: PickedWith) => {
      const current = apiRef.current
      if (!current) return
      if (tool === "image" && latest.current.mediaTool) {
        // QUINCY #501: the host chooses the files and uploads them (the editor's own image tool is off). The tool never becomes active.
        latest.current.mediaTool.onPick(viewCentre(current.getAppState()))
        // The picker is the whole action: hand the tool back to selection so it does not stay highlighted after the picker closes.
        current.setActiveTool({ type: "selection" })
      } else if (tool === "image") {
        // Opens the file picker; touch and keyboard picks drop the image mid-view.
        current.setActiveTool({
          type: "image",
          insertOnCanvasDirectly: pickedWith !== "mouse",
        })
      } else {
        current.setActiveTool({ type: tool })
      }
      if (pickedWith) focusBoard()
    },
    [focusBoard]
  )

  // Zooms around the middle of the view in the editor's own steps and range.
  const zoomTo = useCallback(
    (zoom: ZoomTarget, pickedWith: PickedWith) => {
      const current = apiRef.current
      if (!current) return
      armedRef.current = true
      const state = current.getAppState()
      const from = state.zoom.value
      const target =
        zoom === "in"
          ? from + ZOOM_STEP
          : zoom === "out"
            ? from - ZOOM_STEP
            : zoom
      const to = Math.min(
        Math.max(Math.round(target * 1e6) / 1e6, MIN_ZOOM),
        MAX_ZOOM
      )
      const centerX = state.width / 2
      const centerY = state.height / 2
      current.updateScene({
        appState: {
          // Clamped to the editor's range, so a valid zoom value.
          zoom: { value: to as NormalizedZoomValue },
          scrollX: state.scrollX + centerX / to - centerX / from,
          scrollY: state.scrollY + centerY / to - centerY / from,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      })
      if (pickedWith) focusBoard()
    },
    [focusBoard]
  )

  // Zoom to Fit fits every element, Zoom to Selection the selection (all without
  // one, as the editor's Shift+2 does), both at 100% at most.
  const fit = useCallback(
    (target: FitTarget, pickedWith: PickedWith) => {
      const current = apiRef.current
      if (!current) return
      armedRef.current = true
      const elements = current.getSceneElements()
      const selected = current.getAppState().selectedElementIds
      const picked = elements.filter((element) => selected[element.id])
      fitElements(
        current,
        target === "selection" && picked.length ? picked : elements,
        false,
        rootRef.current
      )
      if (pickedWith) focusBoard()
    },
    [focusBoard, rootRef]
  )

  // Fills the view with one frame; the label holds it while the view travels.
  const showFrame = useCallback(
    (id: string, pickedWith: PickedWith) => {
      const current = apiRef.current
      const frame = current?.getSceneElements().find((item) => item.id === id)
      if (!current || !frame) return
      armedRef.current = true
      steppingRef.current = id
      setChrome((previous) =>
        previous.frameAt === id ? previous : { ...previous, frameAt: id }
      )
      fitElements(current, [frame], true, rootRef.current)
      if (pickedWith) focusBoard()
    },
    [focusBoard, rootRef]
  )

  // [ and ]: from the frame the view is on or heading to, in reading order.
  const stepFrame = useCallback(
    (step: -1 | 1) => {
      const { previous, next } = adjacentFrames(
        framesRef.current,
        steppingRef.current ??
          frameAtCentreOf(apiRef.current, framesRef.current)
      )
      const target = step < 0 ? previous : next
      if (!target) return false
      showFrame(target.id, null)
      return true
    },
    [showFrame]
  )

  // A real click on the editor's own button runs its undo or redo action.
  const runHistory = useCallback(
    (action: HistoryAction, pickedWith: PickedWith) => {
      const button = historyButton(rootRef.current, action)
      if (!canRun(button)) return
      armedRef.current = true
      button.click()
      if (pickedWith) focusBoard()
    },
    [focusBoard, rootRef]
  )

  const hostPanel = useCallback(() => latest.current.onPanelRequest, [])

  // The host's panel when it has one, else the library sidebar's Search tab.
  const requestSearch = useCallback(() => {
    const panel = hostPanel()
    if (panel) {
      panel("search")
      return
    }
    apiRef.current?.toggleSidebar({
      name: "default",
      tab: "search",
      force: true,
    })
  }, [hostPanel])
  // The Board menu's Find runs once the menu has closed, so the menu hands focus
  // to the search instead of pulling it back.
  const findPendingRef = useRef(false)
  const openSearch = useCallback(() => {
    findPendingRef.current = true
  }, [])
  // Every library change, the canvas menu's Add to Library included.
  const handleLibraryChange = useCallback((items: LibraryItems) => {
    libraryRef.current = items
    latest.current.onLibraryChange?.(items.map(toLibraryEntry))
  }, [])
  const openShortcuts = useCallback(() => setShortcutsOpen(true), [])
  // A menu closed by a pointer hands focus to the board (Base UI skips an element
  // returned here, so it moves after the close); a keyboard close returns to the trigger.
  const menuFocus = useCallback(
    (closeType: string) => {
      if (findPendingRef.current) {
        findPendingRef.current = false
        queueMicrotask(requestSearch)
        return false
      }
      if (closeType === "keyboard" || closeType === "") return true
      queueMicrotask(() => {
        if (!focusMovedAway(rootRef.current)) focusBoard()
      })
      return false
    },
    [focusBoard, requestSearch, rootRef]
  )
  // The shortcuts dialog hands focus back to the board, never the closed menu.
  const focusTarget = useCallback(
    () => boardElement(rootRef.current),
    [rootRef]
  )

  const rootOf = useCallback(() => rootRef.current, [rootRef])
  const libraryOf = useCallback(() => libraryRef.current, [])
  // The editor hands its API over as it constructs; the controller wraps it there.
  const handleApi = useCallback(
    (next: ExcalidrawImperativeAPI) => {
      setApi(next)
      setController(
        createController(next, {
          root: rootOf,
          arm,
          panel: hostPanel,
          library: libraryOf,
          editable: () => !latest.current.viewOnly,
          remoteApplied: (hash, taken) => {
            changesRef.current.remoteApplied(hash, [], taken)
          },
          edited: (element) => changesRef.current.editedSinceLoad(element),
          knownMedia,
          uploadedMedia: (mediaId) => uploadedMediaRef.current.add(mediaId),
          refusedMedia: () =>
            latest.current.onToast?.("Images and videos from another board cannot be opened here."),
        })
      )
    },
    [arm, hostPanel, knownMedia, libraryOf, rootOf]
  )

  // Quincy (#498): a dropped scene file would replace the canvas without tombstoning what it replaces.
  // Route it through controller.load (replaceContent), which emits versioned tombstones.
  useEffect(() => {
    const root = rootRef.current
    if (!root || !controller) return
    const onDrop = (event: DragEvent) => {
      const plan = planSceneDrop(event.dataTransfer?.files ?? [], latest.current.viewOnly)
      if (plan === "ignore") return
      // QUINCY #501: image and video files belong to the host's media pipeline, and only where it has one.
      if (typeof plan === "object" && "media" in plan && !latest.current.mediaTool) return
      event.preventDefault()
      event.stopPropagation()
      if (plan === "refuse") return
      if ("media" in plan) {
        latest.current.mediaTool?.onFiles(plan.media, scenePointAt(event.clientX, event.clientY))
        return
      }
      void controller.load(plan.load).catch(() => latest.current.onToast?.("That file could not be opened."))
    }
    root.addEventListener("drop", onDrop, true)
    return () => root.removeEventListener("drop", onDrop, true)
  }, [rootRef, controller, scenePointAt])

  // QUINCY ADDITION #501: a pasted image or video FILE. Excalidraw handles a pasted image file before it calls onPaste (and, with its
  // image tool off, only errors), so it is taken at the document's capture phase, which is where the editor listens. Only while
  // focus is inside this board and not in a text field; anything else falls through.
  useEffect(() => {
    const root = rootRef.current
    if (!root || !controller) return
    const onPasteFiles = (event: ClipboardEvent) => {
      const tool = latest.current.mediaTool
      if (!tool || latest.current.viewOnly) return
      const active = document.activeElement
      if (!active || !root.contains(active)) return
      if (active instanceof HTMLElement && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return
      const files = Array.from(event.clipboardData?.files ?? []).filter(isMediaCandidate)
      if (files.length === 0) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const state = apiRef.current?.getAppState()
      tool.onFiles(files, pointerRef.current ?? (state ? viewCentre(state) : undefined))
    }
    document.addEventListener("paste", onPasteFiles, true)
    return () => document.removeEventListener("paste", onPasteFiles, true)
  }, [rootRef, controller])

  // QUINCY ADDITION #501: a click (not a drag) on a video element asks the host to play it. Excalidraw does not report what a click hit in
  // view mode, so this is the controller's own hit test. It only observes: nothing is stopped, so in edit mode the click still selects.
  useEffect(() => {
    const root = rootRef.current
    if (!root || !controller) return
    let started: { x: number; y: number; id: string } | null = null
    const onCanvas = (event: PointerEvent) => event.target instanceof HTMLCanvasElement && boardElement(root)?.contains(event.target) === true
    const onDown = (event: PointerEvent) => {
      started = null
      if (event.button !== 0 || !event.isPrimary || !onCanvas(event) || !latest.current.onVideoOpen) return
      const id = controller.videoAt(event.clientX, event.clientY)
      if (id) started = { x: event.clientX, y: event.clientY, id }
    }
    const onUp = (event: PointerEvent) => {
      const down = started
      started = null
      if (!down || event.button !== 0 || Math.hypot(event.clientX - down.x, event.clientY - down.y) >= 5) return
      if (controller.videoAt(event.clientX, event.clientY) === down.id) latest.current.onVideoOpen?.(down.id)
    }
    root.addEventListener("pointerdown", onDown, true)
    root.addEventListener("pointerup", onUp, true)
    return () => {
      root.removeEventListener("pointerdown", onDown, true)
      root.removeEventListener("pointerup", onUp, true)
    }
  }, [rootRef, controller])

  // Anything the user does inside the board makes later edits unsaved work.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const events = ["pointerdown", "keydown", "wheel", "paste", "drop"] as const
    for (const type of events) root.addEventListener(type, arm, true)
    return () => {
      for (const type of events) root.removeEventListener(type, arm, true)
    }
  }, [arm, rootRef])

  // A pan or zoom by hand ends a frame step's hold on the label.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const release = () => {
      steppingRef.current = null
    }
    root.addEventListener("pointerdown", release, true)
    root.addEventListener("wheel", release, true)
    return () => {
      root.removeEventListener("pointerdown", release, true)
      root.removeEventListener("wheel", release, true)
    }
  }, [rootRef])

  useBoardKeys(rootRef, {
    toggleViewOnly,
    fit,
    stepFrame,
    openShortcuts,
    hostPanel,
  })

  // Escape that ends text editing belongs to the editor; left to bubble, it
  // reaches a host Dialog or Sheet and closes it around the board.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      const target = event.target
      if (
        target instanceof HTMLTextAreaElement &&
        target.classList.contains("excalidraw-wysiwyg")
      ) {
        event.stopPropagation()
      }
    }
    root.addEventListener("keydown", onKeyDown)
    return () => root.removeEventListener("keydown", onKeyDown)
  }, [rootRef])

  // Tabbing onto the board marks the root for a quiet inset ring. :focus-visible
  // cannot tell a click apart: any key pressed after one turns it on.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let keyboard = false
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") keyboard = true
    }
    const onPointerDown = () => {
      keyboard = false
      delete root.dataset.keyboardFocus
    }
    const onFocusIn = (event: FocusEvent) => {
      const board =
        event.target instanceof HTMLElement &&
        event.target.classList.contains("excalidraw-container")
      if (board && keyboard) root.dataset.keyboardFocus = ""
      else delete root.dataset.keyboardFocus
    }
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget
      if (!(next instanceof Node) || !root.contains(next)) {
        delete root.dataset.keyboardFocus
      }
    }
    document.addEventListener("keydown", onKeyDown, true)
    document.addEventListener("pointerdown", onPointerDown, true)
    root.addEventListener("focusin", onFocusIn)
    root.addEventListener("focusout", onFocusOut)
    return () => {
      document.removeEventListener("keydown", onKeyDown, true)
      document.removeEventListener("pointerdown", onPointerDown, true)
      root.removeEventListener("focusin", onFocusIn)
      root.removeEventListener("focusout", onFocusOut)
    }
  }, [rootRef])

  useEffect(() => {
    if (!ready || !controller) return
    onLoaded()
    latest.current.onReady?.(controller)
  }, [ready, controller, onLoaded])

  // The root's ref attaches after this effect when both mount together, so the
  // chrome's own layer, the board's size, sets the layout before the first paint.
  useLayoutEffect(() => {
    const layer = layerRef.current ?? rootRef.current
    if (!layer) return
    const { width, height } = layer.getBoundingClientRect()
    setChrome((previous) => {
      const next = {
        ...previous,
        phone: isPhoneLayout(width, height),
        narrow: width < NARROW_WIDTH,
      }
      return sameChrome(previous, next) ? previous : next
    })
  }, [rootRef])

  // The adapter hides the hint while the selection tool is on, keyed on this
  // (ready runs it again once the root's ref has attached).
  useLayoutEffect(() => {
    const root = rootRef.current
    if (root) root.dataset.wbTool = chrome.tool
  }, [chrome.tool, ready, rootRef])

  // The editor's buttons that share the footer's line (the phone bar's, a touch
  // screen's finalize) follow it at its control size, measured before the first paint.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || !footer) return
    const measure = () => {
      root.style.setProperty("--wb-footer-width", `${footer.offsetWidth}px`)
      root.style.setProperty("--wb-control-size", `${footer.offsetHeight}px`)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(footer)
    return () => observer.disconnect()
  }, [rootRef, footer])

  useFontRewrap(api, ready, armedRef)
  useContainerFollow(rootRef, api, ready, armedRef, latest)

  const platform = shortcutPlatform()

  // Excalidraw re-renders whenever its children change identity.
  const slots = useMemo(
    () => (
      <>
        {/* Empty: the kit's Board menu replaces it. Its hidden trigger keeps
            the properties island clear of that menu. */}
        <MainMenu />
        {/* Undocked: the pin would let the library push the canvas aside. */}
        <DefaultSidebar docked={false} />
        {welcome && !viewOnly ? (
          <WelcomeScreen>
            <WelcomeScreen.Center>
              <WelcomeScreen.Center.Heading>
                {welcome.heading}
              </WelcomeScreen.Center.Heading>
              <WelcomeScreen.Center.Menu>
                {welcome.actions.map((action) => (
                  <WelcomeScreen.Center.MenuItem
                    key={action.id}
                    icon={action.icon}
                    shortcut={action.shortcut ?? null}
                    disabled={action.disabled}
                    onSelect={action.onSelect}
                  >
                    {action.label}
                  </WelcomeScreen.Center.MenuItem>
                ))}
              </WelcomeScreen.Center.Menu>
            </WelcomeScreen.Center>
            <WelcomeScreen.Hints.MenuHint>
              Files, view and shortcuts
            </WelcomeScreen.Hints.MenuHint>
            <WelcomeScreen.Hints.ToolbarHint>
              Shapes, arrows and text
            </WelcomeScreen.Hints.ToolbarHint>
          </WelcomeScreen>
        ) : null}
      </>
    ),
    [welcome, viewOnly]
  )

  // Dots under the cleared canvas (outside its dark inversion); the controls and the
  // dialog are siblings outside the editor's DOM, so its styles and keys never reach them.
  return (
    <>
      {background === "grid" ? (
        <div
          ref={gridRef}
          aria-hidden="true"
          className={cn(GRID_LAYOUT, CANVAS_GRID)}
        />
      ) : null}
      <Excalidraw
        excalidrawAPI={handleApi}
        initialData={loadInitialData}
        onChange={handleChange}
        onPointerUpdate={handlePointerUpdate}
        onPaste={handlePaste}
        onLinkOpen={handleLinkOpen}
        onLibraryChange={handleLibraryChange}
        theme={theme}
        viewModeEnabled={viewOnly}
        // The footer covers what zen mode would hide, so it stays off.
        zenModeEnabled={false}
        name={name}
        langCode={language}
        UIOptions={imageTool ? UI_OPTIONS : UI_OPTIONS_NO_IMAGE}
        aiEnabled={false}
      >
        {slots}
      </Excalidraw>
      {/* Mounted with the editor and inert until the scene is ready, so the
          editor's buttons it seats never move once painted. */}
      <WhiteboardChrome
        state={chrome}
        history={history}
        frames={frames}
        viewOnlyLocked={viewOnlyLocked}
        viewOnlyIndicator={viewOnlyIndicator}
        imageTool={imageTool}
        mediaToolLabel={mediaTool?.label}
        platform={platform}
        menu={menu}
        actions={actions}
        loading={!ready}
        menuFocus={menuFocus}
        onTool={selectTool}
        onZoom={zoomTo}
        onFit={fit}
        onPreference={togglePreference}
        onViewOnly={toggleViewOnly}
        onHistory={runHistory}
        onFrame={showFrame}
        onFind={openSearch}
        onShortcuts={openShortcuts}
        footerRef={setFooter}
        layerRef={layerRef}
      />

      <WhiteboardShortcuts
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        platform={platform}
        returnFocus={focusTarget}
      />
    </>
  )
}