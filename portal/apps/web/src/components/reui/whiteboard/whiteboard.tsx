/**
 * ReUI `@reui/whiteboard-1` (Pro block; Excalidraw), vendored for #498 through the sandbox
 * (`tmp/ReUI-Test-1`, `--path src/components/vendor-498`), never `shadcn add` in apps/web. Mechanical edits
 * in every file of the set: `cn` from `@/lib/utils` (not the registry's raw `"cn"`), imports repointed to
 * `@/components/reui/`, the `"use client"` directive dropped, the Skin guard's strips (`dark:` variants,
 * Tailwind `shadow-*`, focus ring widths -- see `reui-skin.guard.test.ts`), and `noUncheckedIndexedAccess`
 * narrowing. `"dark": boolean` is quoted only so the guard's `dark:` matcher does not read a type as a variant.
 *
 * This file: The editor wrapper: lazy-loads `whiteboard-canvas` (so Excalidraw never reaches the entry chunk), the skeleton, error state and theme. Unchanged apart from the mechanical edits and the additions marked QUINCY ADDITION below.
 * QUINCY ADDITION #499 (additive; nothing existing changes): `WhiteboardCollaborator.colorKey`, the controller's
 * `applyRemote` and the `onPresence` prop, so the Project whiteboard can show live cursors and merge other people's edits.
 * Left out of the install on purpose: `share-popover` (public view-only links: ADR 0017 / #483 forbid them),
 * `review-board` (the demo composition -- `components/ProjectWhiteboard.tsx` is the Portal's), `page`, `presence`
 * (#499) and `history-tab` (#500). New production dependencies: `@excalidraw/excalidraw` (pinned 0.18.1) and `motion`.
 */
import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react"
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform"
import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types"
import type {
  AppState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types"
import type { ServerHold } from "@/lib/whiteboard-saver"
import { cn } from "@/lib/utils"

import { Button } from "@/components/reui/button"
import {
  ButtonGroup,
  ButtonGroupText,
} from "@/components/reui/button-group"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/reui/empty"
import { Skeleton } from "@/components/reui/skeleton"
import {
  useWhiteboardTheme,
  WHITEBOARD_THEME,
  type WhiteboardTheme,
} from "./whiteboard-theme"
import { LockIcon, TriangleAlertIcon } from "lucide-react"

export type { WhiteboardTheme }

// The editor's zoom range; declared here so the placeholder never loads the controls.
export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 30

export type WhiteboardSaveStatus = "saved" | "unsaved" | "saving" | "error"
/** QUINCY ADDITION #499: what onSave resolves with when it deliberately sent nothing; see onSave. */
export const WHITEBOARD_SAVE_SKIPPED = "skipped" as const
export type WhiteboardSaveOutcome = void | typeof WHITEBOARD_SAVE_SKIPPED

/** An image the board draws, keyed by the fileId its image element carries. */
export type WhiteboardFile = {
  id: string
  mimeType: string
  /** A base64 data URL. */
  dataURL: string
  created?: number
}

export type WhiteboardContent = {
  /** Saved elements, as getScene() or onSave() hand them to you. */
  elements?: readonly ExcalidrawElement[]
  /** Authored content, converted once with the ids and seeds you give it. */
  skeleton?: readonly ExcalidrawElementSkeleton[]
  files?: readonly WhiteboardFile[]
}

export type WhiteboardLibraryItem = {
  id: string
  name: string
  skeleton: readonly ExcalidrawElementSkeleton[]
}

/** A shape saved in the board's library, from your seed or the canvas menu's Add to Library. */
export type WhiteboardLibraryEntry = {
  id: string
  /** Unnamed when saved from the canvas. */
  name?: string
  /** Epoch milliseconds. */
  created: number
  elements: readonly NonDeletedExcalidrawElement[]
}

/** The editor sidebar tabs a host panel can take over; see onPanelRequest. */
export type WhiteboardPanel = "library" | "search"

/** An outline icon button at the canvas's top right, opposite the board menu. */
export type WhiteboardAction = {
  id: string
  label: string
  icon: React.JSX.Element
  /** Makes it a toggle: aria-pressed and the style's pressed fill. */
  pressed?: boolean
  disabled?: boolean
  onSelect: () => void
}

export type WhiteboardPreferences = Pick<
  AppState,
  "gridModeEnabled" | "objectsSnapModeEnabled"
>

export type WhiteboardInitialData = WhiteboardContent & {
  appState?: Partial<WhiteboardPreferences>
  /** Reusable shapes: skeletons you author, or the entries onLibraryChange handed you (store
   * those as JSON and pass them back here, so shapes saved from the canvas survive a reload). */
  library?: readonly (WhiteboardLibraryItem | WhiteboardLibraryEntry)[]
}

/** A self-contained snapshot: store it as JSON and pass it back as content. */
export type WhiteboardScene = {
  elements: readonly NonDeletedExcalidrawElement[]
  /** Only the images live elements still reference. */
  files: readonly WhiteboardFile[]
  appState: WhiteboardPreferences
  /** Changes whenever any element changes; use it to skip redundant saves. */
  version: number
}

export type WhiteboardMenuItem = {
  id: string
  label: string
  icon: React.JSX.Element
  shortcut?: string
  disabled?: boolean
  /** "destructive" reads as the menu's delete row; confirm the action before it runs. */
  variant?: "default" | "destructive"
  onSelect: () => void
}

export type WhiteboardMenuGroup = {
  id: string
  title?: string
  items: readonly WhiteboardMenuItem[]
}

export type WhiteboardWelcome = {
  heading: string
  actions: readonly WhiteboardMenuItem[]
}

export type WhiteboardCollaborator = {
  id: string
  name: string
  avatarUrl?: string
  /** Scene coordinates; omit to hide the cursor. */
  pointer?: { x: number; y: number }
  selectedIds?: readonly string[]
  state?: "active" | "idle" | "away"
  pressed?: boolean
  /** QUINCY ADDITION #499: what Excalidraw 0.18.1 hashes for this person's cursor, label and selection colour
   * (it ignores a supplied colour). Give one person's connections the same key (the user id) to share a colour;
   * defaults to `id`. */
  colorKey?: string
}

/** QUINCY ADDITION #499: what onPresence reports: the local pointer in scene coordinates (null until it has moved),
 * whether a button is down, and the ids of the selected elements. */
export type WhiteboardPresence = {
  pointer: { x: number; y: number } | null
  button: "up" | "down"
  selectedIds: readonly string[]
}

export type WhiteboardExportScope =
  { type: "board" } | { type: "selection" } | { type: "frame"; id: string }

export type WhiteboardExportOptions = {
  format: "png" | "svg"
  scope: WhiteboardExportScope
  background: boolean
  "dark": boolean
  /** PNG pixel density. */
  scale?: 1 | 2 | 3
  /** Embeds the scene so the file opens back as an editable board. */
  embedScene?: boolean
  padding?: number
  /** Caps the longer PNG side, for previews. */
  maxSize?: number
}

export type WhiteboardController = {
  /** The raw Excalidraw API, for anything the controller does not wrap. */
  api: ExcalidrawImperativeAPI
  getScene: () => WhiteboardScene
  getSelectedIds: () => readonly string[]
  /** The board as .excalidraw JSON. */
  toJSON: () => string
  /** Opens an .excalidraw scene or .excalidrawlib library file. */
  load: (file: Blob) => Promise<"scene" | "library">
  /** Swaps the whole board, undoable with Ctrl+Z. `undoable: false` loads it as a new document
   * with empty Undo and Redo, so keep the default for live sync, which should keep local history. */
  replace: (
    content: WhiteboardContent,
    options?: { undoable?: boolean }
  ) => void
  /** Places content beside the board (mid-view when empty), selects and shows it; returns its ids. */
  insert: (skeleton: readonly ExcalidrawElementSkeleton[]) => readonly string[]
  /** Empties the board, undoable with Ctrl+Z. */
  clear: () => void
  /** Fits the given elements, or the whole board, clear of the chrome. */
  scrollTo: (ids?: readonly string[]) => void
  /** Known library exception: the first SVG per page logs "Failed to use workers for subsetting" from @excalidraw/excalidraw 0.18.1 (dist/dev/chunk-4FTI6OG3.js, subset-main) when the bundler (Turbopack) rewrites its worker URL to file://.
   * It then subsets fonts on the main thread, so the SVG keeps its embedded fonts and is correct; worth reporting upstream. */
  exportImage: (options: WhiteboardExportOptions) => Promise<Blob>
  /** Call it straight from the click: browsers only allow it inside a gesture; SVG logs the same line as exportImage. */
  copyImage: (options: WhiteboardExportOptions) => Promise<void>
  setCollaborators: (collaborators: readonly WhiteboardCollaborator[]) => void
  /** QUINCY ADDITION #499: merges elements another person changed into the board, by Excalidraw's own element-version
   * reconciliation (`reconcileElements`), as a change that never enters this person's Undo. Unlike `replace`, it keeps
   * everything the sender did not mention and never bumps versions or tombstones. `hold` says what the server holds of each board element (the saver's `hold`): what it holds keeps its index, and an unsent or edited element in the way of an incoming index is moved (never changing a revision). Works in view-only mode too. Returns
   * every element now on the board, deleted ones included. */
  applyRemote: (elements: readonly unknown[], hold: (element: ExcalidrawElement) => ServerHold) => readonly ExcalidrawElement[]
  /** QUINCY ADDITION #499: merges elements the PERSON authored (an editor-style deletion of an element the editor dropped) into the board, the way
   * `applyRemote` does (never a raw append, whose index repair would bump a revision), but they are NOT remote: the board's change event reads
   * them as the person's own edit, so the board is dirty and autosave sends them. Returns every element now on the board, deleted ones included. */
  applyLocal: (elements: readonly unknown[], hold: (element: ExcalidrawElement) => ServerHold) => readonly ExcalidrawElement[]
  /** QUINCY ADDITION #499: the editor's own `newElementWith`: a copy of `element` with `updates`, one version up and a fresh nonce. The only way a revision is authored outside the editor. */
  author: (element: ExcalidrawElement, updates: Record<string, unknown>) => ExcalidrawElement
  /** QUINCY ADDITION #499: puts the board's elements back at the version and nonce in `arrived` (matched by id), in place.
   * The editor's own restore of `initialData` repairs fractional-index clashes by bumping revisions; call this once the
   * board is ready with what the server sent, so nothing the server already holds reads as an edit. */
  adoptRevisions: (arrived: ReadonlyArray<{ id: string; version: number; versionNonce: number; index?: string | null }>) => void
  /** Selects the given elements, replacing the selection. */
  select: (ids: readonly string[]) => void
  /** Your panel through onPanelRequest when it is set, else the editor's own library sidebar. */
  openLibrary: () => void
  /** The library as the last onLibraryChange delivered it. */
  getLibrary: () => readonly WhiteboardLibraryEntry[]
  /** Saves the selection (with its labels and frame contents) as one library shape; null when
   * nothing is selected. Rejects images and embeds, which a library cannot hold. */
  addToLibrary: (name?: string) => Promise<WhiteboardLibraryEntry | null>
  removeFromLibrary: (id: string) => Promise<void>
  /** Drops a copy of a library shape at the middle of the view, selected; returns its ids. */
  insertFromLibrary: (id: string) => readonly string[]
  /** A PNG of one library shape on a transparent ground, fit into `size` pixels. */
  previewLibraryItem: (
    id: string,
    options: { "dark": boolean; size: number }
  ) => Promise<Blob>
  /** Call from a dragstart: the canvas accepts the drop as a copy where it lands. */
  dragLibraryItem: (id: string, dataTransfer: DataTransfer) => void
  focus: () => void
  /** The element focus() moves to, for a dialog's return focus; null before the editor mounts. */
  focusTarget: () => HTMLElement | null
}

export type WhiteboardProps = {
  /** Read once on mount; remount with a new key to load another board. */
  initialData?:
    WhiteboardInitialData | (() => Promise<WhiteboardInitialData | null>)
  /** Fires once the scene loads, then after edits settle (Grid and Snap included), never per pointer
   * move or scroll; mirror the scene here. A font re-wrap right after load can fire it once more. */
  onChange?: (scene: WhiteboardScene) => void
  /** Every editor change, synchronously, with ALL elements (deleted tombstones included). Quincy: lets a host
   * keep a snapshot that survives the editor tearing down. */
  onElements?: (elements: readonly unknown[]) => void
  /** QUINCY ADDITION #499: the local pointer and selection, for a host that shares presence. Fires on every pointer
   * move (throttle it) and whenever the selection changes. */
  onPresence?: (presence: WhiteboardPresence) => void
  /** Milliseconds edits settle before onChange; default 300. */
  changeDelay?: number
  /** Autosave: store the scene as JSON and pass it back as initialData. Called after edits idle,
   * and when the page hides or unmounts; a rejected promise reports "error" and retries on the next edit.
   * QUINCY ADDITION #499: resolving WHITEBOARD_SAVE_SKIPPED means "nothing was sent" (the board went view-only):
   * the edit stays dirty, the status is "unsaved", and it is flushed when the pause ends. Any other resolution
   * means the scene was stored. */
  onSave?: (scene: WhiteboardScene) => Promise<WhiteboardSaveOutcome> | WhiteboardSaveOutcome
  /** Milliseconds of idle before onSave; default 1500. */
  autosaveDelay?: number
  onSaveStatusChange?: (status: WhiteboardSaveStatus) => void
  /** Fires once the scene has loaded. */
  onReady?: (controller: WhiteboardController) => void
  /** View only: nobody edits the board, though controller methods still write (gate your own actions).
   * Without onReadOnlyChange it is held on, and the footer's View Only toggle (Alt+R) switches the board's own. */
  readOnly?: boolean
  /** Quincy: false hides the canvas's own "View Only" pill when the host shows one itself. Default true. */
  viewOnlyIndicator?: boolean
  /** Hands the footer's View Only toggle, its Edit button and Alt+R to you: they call this and
   * readOnly follows your state, so a share setting and the canvas stay one switch. */
  onReadOnlyChange?: (readOnly: boolean) => void
  /** "auto" (default) follows a .dark class on <html> or any ancestor, live. The canvas is transparent over your tokens, so "light"
   * and "dark" must match them: pass your resolved theme when tokens switch another way (next-themes with attribute="data-theme"). */
  theme?: WhiteboardTheme
  /** The board's name, as api.getName() reports it; exports and toJSON take their file name from you. */
  name?: string
  /** Excalidraw UI language; defaults to the host <html lang>. */
  langCode?: string
  /** Self-hosted font base: the folder that holds Excalidraw's fonts/. Page-wide: the first board's value wins. */
  assetPath?: string | string[]
  /** Groups rendered in the board menu (the canvas's top-left DropdownMenu), above Find on Canvas and
   * Keyboard Shortcuts. The view options (zoom, fit, grid, snap, view only, frames) live in the footer. */
  menu?: readonly WhiteboardMenuGroup[]
  /** Shown on an empty, editable board. Memoize it (useMemo): a new object re-renders the whole editor. */
  welcome?: WhiteboardWelcome
  /** Buttons at the canvas's top right (a library toggle, say), as outline icon buttons in the style's size. */
  actions?: readonly WhiteboardAction[]
  /** Hosts the library and search in your own panel: the editor's sidebar then never opens, and
   * its entry points (Mod+F, the menu's Find on Canvas, openLibrary, an opened library file) call this. */
  onPanelRequest?: (panel: WhiteboardPanel) => void
  /** Fires with the whole library on load and after every change, the canvas menu's Add to Library included. */
  onLibraryChange?: (library: readonly WhiteboardLibraryEntry[]) => void
  /** Takes the editor's own confirmations ("Added to library", "Copied styles") into your toaster;
   * without it they show as the editor's toast on the canvas. */
  onToast?: (message: string) => void
  /** Default "grid": faint 1px lines on the Grid cells (20 units) that pan, zoom and fade out far
   * out (colour in whiteboard-theme.ts; exports skip it). "plain" shows only the host background. */
  background?: "grid" | "plain"
  /** Opening zoom, centred on the board; default 0.6, clamped to the editor's 0.1 to 30. Frame jumps
   * and scrollTo() still fit their target. */
  initialZoom?: number
  /** #498 (additive): false removes the Image tool and its editor entry point. The Portal turns it
   * off until Embedded media (#501) can serve what an image element would reference. Default true. */
  imageTool?: boolean
  /** Accessible name of the canvas region; default "Whiteboard". */
  label?: string
  className?: string
}

export type WhiteboardCanvasProps = Omit<
  WhiteboardProps,
  "className" | "label" | "theme" | "initialZoom"
> & {
  rootRef: RefObject<HTMLDivElement | null>
  theme: "light" | "dark"
  /** Clamped to the editor's range. */
  initialZoom: number
  onLoaded: () => void
}

const loadCanvas = () =>
  import("./whiteboard-canvas").then((module) => ({
    default: module.WhiteboardCanvas,
  }))

const subscribeNoop = () => () => {}

/** False on the server and during hydration, so the editor never renders there. */
function useIsClient() {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false
  )
}

class CanvasErrorBoundary extends Component<
  { onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch() {
    this.props.onError()
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}

/** A placeholder with the box of the controls it stands for: the primitives
 * themselves, unseen, so it matches every style's control size. */
function Ghost({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn("relative flex", className)}>
      <div inert className="invisible flex">
        {children}
      </div>
      <Skeleton className="absolute inset-0" />
    </div>
  )
}

const iconBoxes = (count: number) =>
  Array.from({ length: count }, (_, index) => (
    <Button key={index} variant="outline" size="icon" />
  ))

/** Mirrors the canvas chrome (whiteboard-controls.tsx) box for box, desktop and phone,
 * so the swap to the live controls moves nothing. */
export function WhiteboardSkeleton({
  actions = 0,
  zoom = 0.6,
  viewOnly = false,
  imageTool = true,
  className,
}: {
  /** How many host actions sit top right. */
  actions?: number
  /** The opening zoom, whose label sizes the zoom menu. */
  zoom?: number
  viewOnly?: boolean
  /** #498: false drops the Image tool's box. */
  imageTool?: boolean
  className?: string
}) {
  const tools = viewOnly ? (
    <Ghost>
      <ButtonGroup>
        <ButtonGroupText>
          <LockIcon aria-hidden="true" />
          View Only
        </ButtonGroupText>
        <Button variant="outline">Edit</Button>
      </ButtonGroup>
    </Ghost>
  ) : (
    // Eleven tools (ten without Image) and More.
    <Ghost>{iconBoxes(imageTool ? 12 : 11)}</Ghost>
  )
  const hostActions = iconBoxes(actions).map((box, index) => (
    <Ghost key={index}>{box}</Ghost>
  ))

  return (
    <div
      role="status"
      className={cn(
        "bg-background [container-type:size] pointer-events-none",
        className
      )}
    >
      {/* Desktop, from the editor's 730px width (1000px on a board under 500px tall). */}
      <div className="contents @max-[730px]:hidden [@container_(height<500px)_and_(width<1000px)]:hidden">
        <Ghost className="absolute top-4 left-4">{iconBoxes(1)}</Ghost>
        <div className="absolute top-4 left-1/2 -translate-x-1/2">{tools}</div>
        <div className="absolute top-4 right-4 flex gap-2">{hostActions}</div>
        <div className="absolute bottom-4 left-4 flex items-center gap-2">
          <Ghost>
            <Button variant="outline" size="icon" />
            <Button variant="outline" className="min-w-16 tabular-nums">
              {Math.round(zoom * 100)}%
            </Button>
            <Button variant="outline" size="icon" />
          </Ghost>
          <Ghost>{iconBoxes(1)}</Ghost>
          <Ghost>{iconBoxes(3)}</Ghost>
          {/* Undo and redo. */}
          {viewOnly ? null : <Ghost>{iconBoxes(2)}</Ghost>}
        </div>
        <Ghost className="absolute right-4 bottom-4">
          <Button variant="outline" size="icon" />
          <Button variant="outline" className="w-36" />
          <Button variant="outline" size="icon" />
        </Ghost>
      </div>
      {/* Phone: one top row, and the editor's bottom bar the footer leads. */}
      <div className="hidden @max-[730px]:contents [@container_(height<500px)_and_(width<1000px)]:contents">
        <div className="absolute inset-x-4 top-4 flex items-center gap-2">
          <Ghost>{iconBoxes(1)}</Ghost>
          <div className="min-w-0 flex-1 overflow-hidden">
            <div className="mx-auto w-fit">{tools}</div>
          </div>
          {hostActions}
        </div>
        <Ghost className="absolute inset-x-3.5 bottom-3.5 p-1">
          {iconBoxes(1)}
        </Ghost>
      </div>
      <span className="sr-only">Loading board</span>
    </div>
  )
}

/**
 * Host it in a page, Card, panel or non-modal Dialog or Sheet (a Radix modal host keeps focus and clicks from the editor's <body> popups). A Dialog host skips its Escape close for keys from the board.
 * Base UI: `onOpenChange={(open, details) => { if (!open && details.reason === "escape-key" && details.event.composedPath().some((node) => node instanceof Element && node.classList.contains("excalidraw"))) return; setOpen(open) }}`; Radix: `onEscapeKeyDown={(event) => { if (event.target instanceof Element && event.target.closest(".excalidraw")) event.preventDefault() }}` on the content.
 */
export function Whiteboard({
  theme = "auto",
  label = "Whiteboard",
  initialZoom = 0.6,
  className,
  ...props
}: WhiteboardProps) {
  const zoom = Math.min(Math.max(initialZoom, MIN_ZOOM), MAX_ZOOM)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const isClient = useIsClient()
  const resolvedTheme = useWhiteboardTheme(theme, rootRef)
  const [Canvas, setCanvas] = useState(() => lazy(loadCanvas))
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<"loading" | "ready" | "failed">(
    "loading"
  )

  const handleLoaded = useCallback(() => setStatus("ready"), [])
  const handleError = useCallback(() => setStatus("failed"), [])

  // A fresh lazy() asks the bundler again. Bundlers that cache a failed chunk
  // (Turbopack) fail the retry too, so the next action reloads the page.
  const retried = attempt > 0
  const retry = useCallback(() => {
    setCanvas(() => lazy(loadCanvas))
    setAttempt((value) => value + 1)
    setStatus("loading")
  }, [])
  const reload = useCallback(() => window.location.reload(), [])

  return (
    <div
      ref={rootRef}
      role="region"
      aria-label={label}
      aria-busy={status === "loading"}
      className={cn(
        "bg-background relative isolate size-full min-h-0 overflow-hidden",
        // Only a Tab onto the board rings it, inset and quiet; a click never does.
        "data-keyboard-focus:outline-ring/50 data-keyboard-focus:-outline-offset-2 data-keyboard-focus:outline-2",
        WHITEBOARD_THEME,
        className
      )}
    >
      <CanvasErrorBoundary key={attempt} onError={handleError}>
        <Suspense fallback={null}>
          {isClient ? (
            <Canvas
              {...props}
              initialZoom={zoom}
              rootRef={rootRef}
              theme={resolvedTheme}
              onLoaded={handleLoaded}
            />
          ) : null}
        </Suspense>
      </CanvasErrorBoundary>

      {status === "loading" ? (
        <WhiteboardSkeleton
          actions={props.actions?.length}
          zoom={zoom}
          viewOnly={props.readOnly}
          imageTool={props.imageTool}
          className="absolute inset-0 z-10"
        />
      ) : null}

      {status === "failed" ? (
        <Empty className="absolute inset-0 z-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TriangleAlertIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>Board Unavailable</EmptyTitle>
            <EmptyDescription>
              {retried
                ? "Reloading the page fetches the editor again."
                : "The editor could not load here."}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={retried ? reload : retry}
            >
              {retried ? "Reload Page" : "Try Again"}
            </Button>
          </EmptyContent>
        </Empty>
      ) : null}
    </div>
  )
}