/**
 * ReUI `@reui/whiteboard-1` (Pro block; Excalidraw), vendored for #498 through the sandbox
 * (`tmp/ReUI-Test-1`, `--path src/components/vendor-498`), never `shadcn add` in apps/web. Mechanical edits
 * in every file of the set: `cn` from `@/lib/utils` (not the registry's raw `"cn"`), imports repointed to
 * `@/components/reui/`, the `"use client"` directive dropped, the Skin guard's strips (`dark:` variants,
 * Tailwind `shadow-*`, focus ring widths -- see `reui-skin.guard.test.ts`), and `noUncheckedIndexedAccess`
 * narrowing. `"dark": boolean` is quoted only so the guard's `dark:` matcher does not read a type as a variant.
 *
 * This file: The canvas chrome (tools, zoom, frames navigator, footer). Edits: dropped the nova `shadow-sm` on the outline controls (the Skin guard; the controls keep their hairline) and the unused empty classNames that left.
 */
import {
  memo,
  useRef,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react"
import { cn } from "@/lib/utils"

import { Button } from "@/components/reui/button"
import {
  ButtonGroup,
  ButtonGroupText,
} from "@/components/reui/button-group"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/reui/dropdown-menu"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/reui/toggle-group"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/reui/tooltip"
import {
  MAX_ZOOM,
  MIN_ZOOM,
  type WhiteboardAction,
  type WhiteboardMenuGroup,
} from "./whiteboard"
import {
  formatShortcut,
  ShortcutKbd,
  type ShortcutPlatform,
} from "./whiteboard-shortcuts"
import { HandIcon, MousePointer2Icon, CircleIcon, ArrowRightIcon, MinusIcon, PencilIcon, TypeIcon, ImageIcon, MenuIcon, MoreHorizontalIcon, PlusIcon, Maximize2Icon, ScanSearchIcon, Grid2x2Icon, CombineIcon, LockIcon, ChevronLeftIcon, ChevronRightIcon, Undo2Icon, Redo2Icon, SearchIcon, KeyboardIcon } from "lucide-react"

export type WhiteboardTool =
  | "hand"
  | "selection"
  | "rectangle"
  | "diamond"
  | "ellipse"
  | "arrow"
  | "line"
  | "freedraw"
  | "text"
  | "image"
  | "eraser"
  | "frame"
  | "laser"

/** How a control was used: a pointer type, or null for the keyboard. */
export type PickedWith = "mouse" | "touch" | "pen" | null

export type WhiteboardPreference = "grid" | "snap" | "pen"

/** A zoom step, or an exact zoom such as 1 for 100%. */
export type ZoomTarget = "in" | "out" | number

export type FitTarget = "all" | "selection"

/** The editor state the controls mirror, refreshed from its onChange. */
export type ChromeState = {
  tool: string
  zoom: number
  grid: boolean
  snap: boolean
  /** The editor's view mode: nothing on the board can change. */
  viewMode: boolean
  selected: boolean
  penMode: boolean
  penDetected: boolean
  /** The editor's phone layout: its bottom bar replaces the desktop footer. */
  phone: boolean
  /** Too narrow for the zoom steppers; the zoom menu carries them. */
  narrow: boolean
  /** The frame under the middle of the view, or the one a step is heading to. */
  frameAt: string | null
}

/** Whether the editor's undo and redo can run now. */
export type HistoryState = { undo: boolean; redo: boolean }

export type HistoryAction = keyof HistoryState

/** A frame on the board, in reading order. */
export type ChromeFrame = { id: string; name: string }

/** Where focus goes when one of the controls' menus closes. */
export type MenuFocus = ComponentProps<typeof DropdownMenuContent>["finalFocus"]

// The editor's zoom step.
export const ZOOM_STEP = 0.1

const ZOOM_PRESETS = [0.5, 1, 2] as const

// A ButtonGroup's root has no radius in any style, so each segment carries the
// shadow; each later one clips its own off the segment before, so joints never seam.
const SEAMLESS_SEGMENTS = [
  "[&>*+*]:[clip-path:polygon(-8px_-8px,calc(100%+8px)_-8px,calc(100%+8px)_calc(100%+8px),-8px_calc(100%+8px),-8px_100%,0_100%,0_0,-8px_0)]",
  "[&>*+*:focus-visible]:[clip-path:none]",
].join(" ")

/** The frames either side of `current`; outside every frame, the first and last. */
export function adjacentFrames(
  frames: readonly ChromeFrame[],
  current: string | null
) {
  const index = frames.findIndex((frame) => frame.id === current)
  if (index < 0) {
    return { index, previous: frames.at(-1) ?? null, next: frames[0] ?? null }
  }
  return {
    index,
    previous: frames[index - 1] ?? null,
    next: frames[index + 1] ?? null,
  }
}

/** aria-keyshortcuts for a combination: Mod is Control, or Meta on Apple keyboards.
 * "+" and "-" name the separator itself there, so those combinations go unlisted. */
function ariaShortcut(keys: readonly string[]) {
  if (keys.length === 0) return undefined
  if (keys.some((key) => key === "+" || key === "-")) return undefined
  const combo = (mod: string) =>
    keys.map((key) => (key === "Mod" ? mod : key)).join("+")
  return keys.includes("Mod")
    ? `${combo("Control")} ${combo("Meta")}`
    : combo("")
}

const pickedBy = (event: React.MouseEvent): PickedWith =>
  // A click from the keyboard has no detail.
  event.detail > 0 ? "mouse" : null

// The editor's own tool glyphs, for the shapes the icon catalog has no mapping
// for (Excalidraw is MIT). Drawn at the icon set's 2px weight.
function Glyph({ children, box = 24 }: { children: ReactNode; box?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${box} ${box}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={box / 12}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

// prettier-ignore
const GLYPHS = {
  rectangle: <Glyph><rect x="4" y="4" width="16" height="16" rx="2" /></Glyph>,
  diamond: <Glyph><path d="M10.5 20.4l-6.9-6.9c-.78-.78-.78-2.22 0-3l6.9-6.9c.78-.78 2.22-.78 3 0l6.9 6.9c.78.78.78 2.22 0 3l-6.9 6.9c-.78.78-2.22.78-3 0z" /></Glyph>,
  eraser: <Glyph><path d="M19 20h-10.5l-4.21-4.3a1 1 0 0 1 0-1.41l10-10a1 1 0 0 1 1.41 0l5 5a1 1 0 0 1 0 1.41l-9.2 9.3" /><path d="M18 13.3l-6.3-6.3" /></Glyph>,
  frame: <Glyph><path d="M4 7h16M4 17h16M7 4v16M17 4v16" /></Glyph>,
  laser: <Glyph box={20}><g transform="rotate(90 10 10)"><path d="m9.644 13.69 7.774-7.773a2.357 2.357 0 0 0-3.334-3.334l-7.773 7.774L8 12l1.643 1.69Z" /><path d="m13.25 3.417 3.333 3.333M10 10l2-2M5 15l3-3M2.156 17.894l1-1M5.453 19.029l-.144-1.407M2.377 11.887l.866 1.118M8.354 17.273l-1.194-.758M.953 14.652l1.408.13" /></g></Glyph>,
}

type ToolDef = {
  id: WhiteboardTool
  label: string
  /** The editor's own key for it. */
  key: string
  icon: ReactNode
}

// prettier-ignore
const TOOLS: readonly ToolDef[] = [
  { id: "hand", label: "Hand", key: "H", icon: <HandIcon aria-hidden="true" /> },
  { id: "selection", label: "Selection", key: "V", icon: <MousePointer2Icon aria-hidden="true" /> },
  { id: "rectangle", label: "Rectangle", key: "R", icon: GLYPHS.rectangle },
  { id: "diamond", label: "Diamond", key: "D", icon: GLYPHS.diamond },
  { id: "ellipse", label: "Ellipse", key: "O", icon: <CircleIcon aria-hidden="true" /> },
  { id: "arrow", label: "Arrow", key: "A", icon: <ArrowRightIcon aria-hidden="true" /> },
  { id: "line", label: "Line", key: "L", icon: <MinusIcon aria-hidden="true" /> },
  { id: "freedraw", label: "Draw", key: "P", icon: <PencilIcon aria-hidden="true" /> },
  { id: "text", label: "Text", key: "T", icon: <TypeIcon aria-hidden="true" /> },
  { id: "image", label: "Image", key: "9", icon: <ImageIcon aria-hidden="true" /> },
  { id: "eraser", label: "Eraser", key: "E", icon: GLYPHS.eraser },
]

const MORE_TOOLS: readonly ToolDef[] = [
  { id: "frame", label: "Frame", key: "F", icon: GLYPHS.frame },
  { id: "laser", label: "Laser Pointer", key: "K", icon: GLYPHS.laser },
]

// The More item's value in the group: pressed while one of its tools is active.
const MORE = "more"

const isMainTool = (value: string): value is WhiteboardTool =>
  TOOLS.some((tool) => tool.id === value)

// prettier-ignore
const ICONS = {
  menu: <MenuIcon aria-hidden="true" />,
  more: <MoreHorizontalIcon aria-hidden="true" />,
  zoomIn: <PlusIcon aria-hidden="true" />,
  zoomOut: <MinusIcon aria-hidden="true" />,
  fit: <Maximize2Icon aria-hidden="true" />,
  fitSelection: <ScanSearchIcon aria-hidden="true" />,
  grid: <Grid2x2Icon aria-hidden="true" />,
  snap: <CombineIcon aria-hidden="true" />,
  lock: <LockIcon aria-hidden="true" />,
  previous: <ChevronLeftIcon aria-hidden="true" />,
  next: <ChevronRightIcon aria-hidden="true" />,
  undo: <Undo2Icon aria-hidden="true" />,
  redo: <Redo2Icon aria-hidden="true" />,
  pen: <PencilIcon aria-hidden="true" />,
  find: <SearchIcon aria-hidden="true" />,
  shortcuts: <KeyboardIcon aria-hidden="true" />,
}

/** One square toggle with its name and key in a tooltip. */
// Phone sets `--wb-control-size:44px` on the board root (`whiteboard-theme.ts`); every custom control reads it,
// so the strip is 32px on desktop and 44px at <=721px, uniform (#498). `size="icon"` (`size-8`) and the toggle's
// `h-8 min-w-8` sit in the same tailwind-merge groups, so these win.
const CONTROL_SQUARE = "size-[var(--wb-control-size,2rem)]"
const CONTROL_TOGGLE =
  "h-[var(--wb-control-size,2rem)] min-w-[var(--wb-control-size,2rem)]"

const DISABLED_NO_FILL =
  "disabled:bg-transparent disabled:aria-pressed:bg-transparent disabled:data-[state=on]:bg-transparent disabled:data-[pressed]:bg-transparent"

function ToggleItem({
  value,
  label,
  keys,
  icon,
  side,
  disabled,
  platform,
}: {
  value: string
  label: string
  keys: readonly string[]
  icon: ReactNode
  side: "top" | "bottom"
  disabled?: boolean
  platform: ShortcutPlatform
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // An icon has no label to pad, so the item stays square.
          <ToggleGroupItem
            value={value}
            aria-label={label}
            aria-keyshortcuts={ariaShortcut(keys)}
            disabled={disabled}
            // #551: a disabled toggle (View Only on a locked board) is colour only, never the pressed fill.
            className={cn("px-0", CONTROL_TOGGLE, DISABLED_NO_FILL)}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent side={side}>
        {label}
        <ShortcutKbd keys={keys} platform={platform} />
      </TooltipContent>
    </Tooltip>
  )
}

/** An outline icon button with its name and key in a tooltip; disabled, it keeps
 * focus (aria-disabled), so a keyboard press that disables it never drops focus. */
function IconButton({
  label,
  keys,
  icon,
  side = "top",
  disabled,
  className,
  platform,
  onClick,
}: {
  label: string
  keys: readonly string[]
  icon: ReactNode
  side?: "top" | "bottom"
  disabled?: boolean
  className?: string
  platform: ShortcutPlatform
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="icon"
            aria-label={label}
            aria-keyshortcuts={ariaShortcut(keys)}
            disabled={disabled}
            focusableWhenDisabled
            className={cn(
              CONTROL_SQUARE,
              "aria-disabled:pointer-events-none aria-disabled:opacity-50",
              className
            )}
            onClick={onClick}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent side={side}>
        {label}
        <ShortcutKbd keys={keys} platform={platform} />
      </TooltipContent>
    </Tooltip>
  )
}

const Tools = memo(function Tools({
  tool,
  imageTool,
  mediaToolLabel,
  platform,
  menuFocus,
  onTool,
}: {
  tool: string
  imageTool: boolean
  mediaToolLabel?: string
  platform: ShortcutPlatform
  menuFocus: MenuFocus
  onTool: (tool: WhiteboardTool, pickedWith: PickedWith) => void
}) {
  const pickedWith = useRef<PickedWith>(null)
  const value = isMainTool(tool)
    ? [tool]
    : MORE_TOOLS.some((extra) => extra.id === tool)
      ? [MORE]
      : []

  return (
    <ToggleGroup
      variant="outline"
      spacing={0}
      aria-label="Tools"
      value={value}
      onValueChange={(next) => {
        // More leaves the tool as it is; a pointer pressing the active tool again
        // keeps it and still hands focus to the board, so its keys keep working.
        const repressed = !next.length && pickedWith.current && isMainTool(tool)
        const picked = next.find(isMainTool) ?? (repressed ? tool : undefined)
        if (picked) onTool(picked, pickedWith.current)
      }}
      onPointerDown={(event) => {
        pickedWith.current =
          event.pointerType === "touch" || event.pointerType === "pen"
            ? event.pointerType
            : "mouse"
      }}
      onKeyDown={() => {
        pickedWith.current = null
      }}
      className="bg-background"
    >
      {TOOLS.filter(
        (item) => imageTool || mediaToolLabel !== undefined || item.id !== "image"
      ).map((item) => {
        // QUINCY ADDITION #501: the host's media tool takes the Image slot, with its own name and no key (the editor's key 9 is its own image tool, which is off).
        const hostMedia = item.id === "image" && !imageTool && mediaToolLabel !== undefined
        return (
          <ToggleItem
            key={item.id}
            value={item.id}
            label={hostMedia ? mediaToolLabel : item.label}
            keys={hostMedia ? [] : [item.key]}
            icon={item.icon}
            side="bottom"
            platform={platform}
          />
        )
      })}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <ToggleGroupItem
                    value={MORE}
                    aria-label="More tools"
                    className={cn("px-0", CONTROL_TOGGLE)}
                  />
                }
              />
            }
          >
            {ICONS.more}
          </TooltipTrigger>
          <TooltipContent side="bottom">More Tools</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="end"
          className="w-auto"
          finalFocus={menuFocus}
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel>More Tools</DropdownMenuLabel>
            {MORE_TOOLS.map((item) => (
              <DropdownMenuItem
                key={item.id}
                onClick={() => onTool(item.id, null)}
              >
                {item.icon}
                {item.label}
                <DropdownMenuShortcut>{item.key}</DropdownMenuShortcut>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </ToggleGroup>
  )
})

/** Stands in for the tools while the board is view only, with the way back. */
function ViewOnlyBar({
  locked,
  platform,
  onViewOnly,
}: {
  locked: boolean
  platform: ShortcutPlatform
  onViewOnly: (pickedWith: PickedWith) => void
}) {
  return (
    <ButtonGroup
      aria-label="View only"
      className={cn("bg-background", SEAMLESS_SEGMENTS)}
    >
      <ButtonGroupText>
        {ICONS.lock}
        View Only
      </ButtonGroupText>
      {locked ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                aria-keyshortcuts="Alt+R"
                onClick={(event) => onViewOnly(pickedBy(event))}
              />
            }
          >
            Edit
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Exit View Only
            <ShortcutKbd keys={["Alt", "R"]} platform={platform} />
          </TooltipContent>
        </Tooltip>
      )}
    </ButtonGroup>
  )
}

const BoardMenu = memo(function BoardMenu({
  penMode,
  penDetected,
  menu,
  platform,
  menuFocus,
  onPreference,
  onFind,
  onShortcuts,
}: {
  penMode: boolean
  penDetected: boolean
  menu?: readonly WhiteboardMenuGroup[]
  platform: ShortcutPlatform
  menuFocus: MenuFocus
  onPreference: (
    preference: WhiteboardPreference,
    pickedWith: PickedWith
  ) => void
  onFind: () => void
  onShortcuts: () => void
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="icon"
                  className={CONTROL_SQUARE}
                  aria-label="Board menu"
                />
              }
            />
          }
        >
          {ICONS.menu}
        </TooltipTrigger>
        <TooltipContent side="bottom">Board Menu</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        className="w-auto"
        finalFocus={menuFocus}
      >
        {menu?.map((group) => (
          <DropdownMenuGroup key={group.id}>
            {group.title ? (
              <DropdownMenuLabel>{group.title}</DropdownMenuLabel>
            ) : null}
            {group.items.map((item) => (
              <DropdownMenuItem
                key={item.id}
                variant={item.variant}
                disabled={item.disabled}
                onClick={item.onSelect}
              >
                {item.icon}
                {item.label}
                {item.shortcut ? (
                  <DropdownMenuShortcut>{item.shortcut}</DropdownMenuShortcut>
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
        {menu?.length ? <DropdownMenuSeparator /> : null}
        <DropdownMenuGroup>
          {/* Offered once a stylus touches the board, as the editor does. */}
          {penDetected ? (
            <DropdownMenuCheckboxItem
              checked={penMode}
              closeOnClick
              onCheckedChange={() => onPreference("pen", null)}
            >
              {ICONS.pen}
              Pen Mode
            </DropdownMenuCheckboxItem>
          ) : null}
          <DropdownMenuItem onClick={onFind}>
            {ICONS.find}
            Find on Canvas
            <DropdownMenuShortcut>
              {formatShortcut(["Mod", "F"], platform)}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onShortcuts}>
            {ICONS.shortcuts}
            Keyboard Shortcuts
            <DropdownMenuShortcut>?</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

function Zoom({
  state,
  platform,
  menuFocus,
  onZoom,
  onFit,
  className,
}: {
  state: ChromeState
  platform: ShortcutPlatform
  menuFocus: MenuFocus
  onZoom: (target: ZoomTarget, pickedWith: PickedWith) => void
  onFit: (target: FitTarget, pickedWith: PickedWith) => void
  className?: string
}) {
  const { zoom } = state
  const percent = Math.round(zoom * 100)
  const preset = ZOOM_PRESETS.find(
    (value) => Math.round(value * 100) === percent
  )

  return (
    <ButtonGroup aria-label="Zoom" className={className}>
      {state.narrow ? null : (
        <IconButton
          label="Zoom Out"
          keys={["Mod", "-"]}
          icon={ICONS.zoomOut}
          disabled={zoom <= MIN_ZOOM}
          platform={platform}
          onClick={(event) => onZoom("out", pickedBy(event))}
        />
      )}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  // Wide enough for four digits, so the group never shifts.
                  <Button
                    variant="outline"
                    aria-label={`Zoom ${percent}%, zoom options`}
                    className="min-h-[var(--wb-control-size,2rem)] min-w-16 tabular-nums"
                  />
                }
              />
            }
          >
            {percent}%
          </TooltipTrigger>
          <TooltipContent side="top">Zoom Options</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          side="top"
          align="start"
          className="w-auto"
          finalFocus={menuFocus}
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel>Zoom</DropdownMenuLabel>
            <DropdownMenuItem
              disabled={zoom >= MAX_ZOOM}
              onClick={() => onZoom("in", null)}
            >
              {ICONS.zoomIn}
              Zoom In
              <DropdownMenuShortcut>
                {formatShortcut(["Mod", "+"], platform)}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={zoom <= MIN_ZOOM}
              onClick={() => onZoom("out", null)}
            >
              {ICONS.zoomOut}
              Zoom Out
              <DropdownMenuShortcut>
                {formatShortcut(["Mod", "-"], platform)}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onFit("all", null)}>
              {ICONS.fit}
              Zoom to Fit
              <DropdownMenuShortcut>
                {formatShortcut(["Shift", "1"], platform)}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!state.selected}
              onClick={() => onFit("selection", null)}
            >
              {ICONS.fitSelection}
              Zoom to Selection
              <DropdownMenuShortcut>
                {formatShortcut(["Shift", "2"], platform)}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={preset === undefined ? "" : String(preset)}
            onValueChange={(value) => onZoom(Number(value), null)}
          >
            {ZOOM_PRESETS.map((value) => (
              <DropdownMenuRadioItem
                key={value}
                value={String(value)}
                closeOnClick
                className="tabular-nums"
              >
                {value * 100}%
                {value === 1 ? (
                  <DropdownMenuShortcut>
                    {formatShortcut(["Mod", "0"], platform)}
                  </DropdownMenuShortcut>
                ) : null}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {state.narrow ? null : (
        <IconButton
          label="Zoom In"
          keys={["Mod", "+"]}
          icon={ICONS.zoomIn}
          disabled={zoom >= MAX_ZOOM}
          platform={platform}
          onClick={(event) => onZoom("in", pickedBy(event))}
        />
      )}
    </ButtonGroup>
  )
}

const VIEW_OPTIONS = ["grid", "snap", "view"] as const

const ViewToggles = memo(function ViewToggles({
  grid,
  snap,
  viewMode,
  viewOnlyLocked,
  platform,
  onPreference,
  onViewOnly,
}: {
  grid: boolean
  snap: boolean
  viewMode: boolean
  viewOnlyLocked: boolean
  platform: ShortcutPlatform
  onPreference: (
    preference: WhiteboardPreference,
    pickedWith: PickedWith
  ) => void
  onViewOnly: (pickedWith: PickedWith) => void
}) {
  const pickedWith = useRef<PickedWith>(null)
  const pressed = { grid, snap, view: viewMode }
  const value = VIEW_OPTIONS.filter((option) => pressed[option])

  return (
    <ToggleGroup
      variant="outline"
      spacing={0}
      multiple
      aria-label="View"
      value={value}
      onValueChange={(next) => {
        const changed = VIEW_OPTIONS.find(
          (option) => next.includes(option) !== pressed[option]
        )
        if (changed === "view") onViewOnly(pickedWith.current)
        else if (changed) onPreference(changed, pickedWith.current)
      }}
      onPointerDown={() => {
        pickedWith.current = "mouse"
      }}
      onKeyDown={() => {
        pickedWith.current = null
      }}
      className="bg-background"
    >
      <ToggleItem
        value="grid"
        label="Grid"
        keys={["Mod", "'"]}
        icon={ICONS.grid}
        side="top"
        platform={platform}
      />
      <ToggleItem
        value="snap"
        label="Snap to Objects"
        keys={["Alt", "S"]}
        icon={ICONS.snap}
        side="top"
        disabled={viewMode}
        platform={platform}
      />
      <ToggleItem
        value="view"
        label="View Only"
        keys={["Alt", "R"]}
        icon={ICONS.lock}
        side="top"
        disabled={viewOnlyLocked}
        platform={platform}
      />
    </ToggleGroup>
  )
})

const History = memo(function History({
  history,
  platform,
  onHistory,
  className,
}: {
  history: HistoryState
  platform: ShortcutPlatform
  onHistory: (action: HistoryAction, pickedWith: PickedWith) => void
  className?: string
}) {
  return (
    <ButtonGroup aria-label="History" className={className}>
      <IconButton
        label="Undo"
        keys={["Mod", "Z"]}
        icon={ICONS.undo}
        disabled={!history.undo}
        platform={platform}
        onClick={(event) => onHistory("undo", pickedBy(event))}
      />
      <IconButton
        label="Redo"
        keys={["Mod", "Shift", "Z"]}
        icon={ICONS.redo}
        disabled={!history.redo}
        platform={platform}
        onClick={(event) => onHistory("redo", pickedBy(event))}
      />
    </ButtonGroup>
  )
})

const FrameStepper = memo(function FrameStepper({
  frames,
  current,
  platform,
  menuFocus,
  onFrame,
}: {
  frames: readonly ChromeFrame[]
  current: string | null
  platform: ShortcutPlatform
  menuFocus: MenuFocus
  onFrame: (id: string, pickedWith: PickedWith) => void
}) {
  const { index, previous, next } = adjacentFrames(frames, current)
  const label = index < 0 ? `${frames.length} Frames` : (frames[index]?.name ?? "")

  return (
    <ButtonGroup
      aria-label="Frames"
      className={cn("bg-background", SEAMLESS_SEGMENTS)}
    >
      <IconButton
        label="Previous Frame"
        keys={["["]}
        icon={ICONS.previous}
        disabled={!previous}
        platform={platform}
        onClick={(event) => {
          if (previous) onFrame(previous.id, pickedBy(event))
        }}
      />
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  // One width for every name, so the arrows never move.
                  <Button
                    variant="outline"
                    aria-label={`${label}, choose a frame`}
                    className="w-36"
                  />
                }
              />
            }
          >
            {GLYPHS.frame}
            <span className="min-w-0 truncate">{label}</span>
          </TooltipTrigger>
          <TooltipContent side="top">Jump to Frame</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          side="top"
          align="end"
          className="w-auto"
          finalFocus={menuFocus}
        >
          <FrameItems
            frames={frames}
            current={index < 0 ? null : (frames[index]?.id ?? null)}
            onFrame={onFrame}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <IconButton
        label="Next Frame"
        keys={["]"]}
        icon={ICONS.next}
        disabled={!next}
        platform={platform}
        onClick={(event) => {
          if (next) onFrame(next.id, pickedBy(event))
        }}
      />
    </ButtonGroup>
  )
})

function FrameItems({
  frames,
  current,
  onFrame,
}: {
  frames: readonly ChromeFrame[]
  current: string | null
  onFrame: (id: string, pickedWith: PickedWith) => void
}) {
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>Frames</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={current ?? ""}
        onValueChange={(id) => onFrame(String(id), null)}
      >
        {frames.map((frame) => (
          <DropdownMenuRadioItem key={frame.id} value={frame.id} closeOnClick>
            {GLYPHS.frame}
            {frame.name}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  )
}

/** The phone footer's one menu: the view options and frames the bar has no room for. */
function MoreMenu({
  state,
  frames,
  viewOnlyLocked,
  platform,
  menuFocus,
  onPreference,
  onViewOnly,
  onFrame,
}: {
  state: ChromeState
  frames: readonly ChromeFrame[]
  viewOnlyLocked: boolean
  platform: ShortcutPlatform
  menuFocus: MenuFocus
  onPreference: (
    preference: WhiteboardPreference,
    pickedWith: PickedWith
  ) => void
  onViewOnly: (pickedWith: PickedWith) => void
  onFrame: (id: string, pickedWith: PickedWith) => void
}) {
  const { index } = adjacentFrames(frames, state.frameAt)

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="icon"
                  className={CONTROL_SQUARE}
                  aria-label="More options"
                />
              }
            />
          }
        >
          {ICONS.more}
        </TooltipTrigger>
        <TooltipContent side="top">More Options</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        className="w-auto"
        finalFocus={menuFocus}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>View</DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={state.grid}
            closeOnClick
            onCheckedChange={() => onPreference("grid", null)}
          >
            {ICONS.grid}
            Grid
            <DropdownMenuShortcut>
              {formatShortcut(["Mod", "'"], platform)}
            </DropdownMenuShortcut>
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={state.snap}
            closeOnClick
            disabled={state.viewMode}
            onCheckedChange={() => onPreference("snap", null)}
          >
            {ICONS.snap}
            Snap to Objects
            <DropdownMenuShortcut>
              {formatShortcut(["Alt", "S"], platform)}
            </DropdownMenuShortcut>
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={state.viewMode}
            closeOnClick
            disabled={viewOnlyLocked}
            onCheckedChange={() => onViewOnly(null)}
          >
            {ICONS.lock}
            View Only
            <DropdownMenuShortcut>
              {formatShortcut(["Alt", "R"], platform)}
            </DropdownMenuShortcut>
          </DropdownMenuCheckboxItem>
        </DropdownMenuGroup>
        {frames.length ? (
          <>
            <DropdownMenuSeparator />
            <FrameItems
              frames={frames}
              current={index < 0 ? null : (frames[index]?.id ?? null)}
              onFrame={onFrame}
            />
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Actions({ actions }: { actions: readonly WhiteboardAction[] }) {
  return actions.map((action) =>
    action.pressed === undefined ? (
      // Sits on the background, so the canvas never shows through the button.
      <div key={action.id} className="bg-background">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon"
                className={CONTROL_SQUARE}
                aria-label={action.label}
                disabled={action.disabled}
                onClick={action.onSelect}
              />
            }
          >
            {action.icon}
          </TooltipTrigger>
          <TooltipContent side="bottom">{action.label}</TooltipContent>
        </Tooltip>
      </div>
    ) : (
      // A toggle is its own one-item group: the pressed fill and the group's
      // shape come from the primitive in every style.
      <ToggleGroup
        key={action.id}
        variant="outline"
        spacing={0}
        multiple
        aria-label={action.label}
        value={action.pressed ? [action.id] : []}
        onValueChange={action.onSelect}
        className="bg-background"
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <ToggleGroupItem
                value={action.id}
                aria-label={action.label}
                disabled={action.disabled}
                className={cn("px-0", CONTROL_TOGGLE)}
              />
            }
          >
            {action.icon}
          </TooltipTrigger>
          <TooltipContent side="bottom">{action.label}</TooltipContent>
        </Tooltip>
      </ToggleGroup>
    )
  )
}

export type WhiteboardChromeProps = {
  state: ChromeState
  history: HistoryState
  frames: readonly ChromeFrame[]
  /** The host holds the board view only, so the toggle cannot lift it. */
  viewOnlyLocked: boolean
  /** Quincy: false drops the "View Only" pill when the host holds the board view only and says so itself. */
  viewOnlyIndicator?: boolean
  /** #498: false hides the Image tool. */
  imageTool: boolean
  /** QUINCY ADDITION #501: the host's "Image or video" tool: shows the Image slot, relabelled, when the editor's own image tool is off. */
  mediaToolLabel?: string
  platform: ShortcutPlatform
  menu?: readonly WhiteboardMenuGroup[]
  actions?: readonly WhiteboardAction[]
  /** The scene is still loading: laid out in place under the skeleton, inert. */
  loading: boolean
  menuFocus: MenuFocus
  onTool: (tool: WhiteboardTool, pickedWith: PickedWith) => void
  onZoom: (target: ZoomTarget, pickedWith: PickedWith) => void
  onFit: (target: FitTarget, pickedWith: PickedWith) => void
  onPreference: (
    preference: WhiteboardPreference,
    pickedWith: PickedWith
  ) => void
  onViewOnly: (pickedWith: PickedWith) => void
  onHistory: (action: HistoryAction, pickedWith: PickedWith) => void
  onFrame: (id: string, pickedWith: PickedWith) => void
  onFind: () => void
  onShortcuts: () => void
  /** The footer's start, measured so the editor's own buttons in its line follow it. */
  footerRef: Ref<HTMLDivElement>
  /** The layer over the whole canvas, measured for the phone or desktop layout. */
  layerRef: Ref<HTMLDivElement>
}

/** Floats over the canvas: menu, tools and actions on top, the footer bottom left,
 * frames bottom right; on phones the footer rides the editor's bottom bar. */
export const WhiteboardChrome = memo(function WhiteboardChrome({
  state,
  history,
  frames,
  viewOnlyLocked,
  viewOnlyIndicator = true,
  imageTool,
  mediaToolLabel,
  platform,
  menu,
  actions,
  loading,
  menuFocus,
  onTool,
  onZoom,
  onFit,
  onPreference,
  onViewOnly,
  onHistory,
  onFrame,
  onFind,
  onShortcuts,
  footerRef,
  layerRef,
}: WhiteboardChromeProps) {
  const boardMenu = (
    // Sits on the background, so the canvas never shows through the button.
    <div className="bg-background pointer-events-auto">
      <BoardMenu
        penMode={state.penMode}
        penDetected={state.penDetected}
        menu={menu}
        platform={platform}
        menuFocus={menuFocus}
        onPreference={onPreference}
        onFind={onFind}
        onShortcuts={onShortcuts}
      />
    </div>
  )
  const top = state.viewMode ? (
    !viewOnlyIndicator && viewOnlyLocked ? null : <ViewOnlyBar
      locked={viewOnlyLocked}
      platform={platform}
      onViewOnly={onViewOnly}
    />
  ) : (
    <Tools
      tool={state.tool}
      imageTool={imageTool}
      mediaToolLabel={mediaToolLabel}
      platform={platform}
      menuFocus={menuFocus}
      onTool={onTool}
    />
  )
  const hostActions = actions?.length ? (
    <div className="pointer-events-auto flex shrink-0 items-center gap-2">
      <Actions actions={actions} />
    </div>
  ) : null

  return (
    <TooltipProvider delay={300}>
      <div
        ref={layerRef}
        data-slot="whiteboard-chrome"
        inert={loading}
        className="@container pointer-events-none absolute inset-0 z-10 max-[721px]:[--wb-control-size:44px] max-[721px]:[&_[data-slot=button]]:min-h-11 max-[721px]:[&_[data-slot=button]]:min-w-11"
      >
        {state.phone ? (
          <>
            <div className="absolute inset-x-4 top-4 flex items-center gap-2">
              {boardMenu}
              {/* The tools scroll sideways when the row is narrower than them;
                  the vertical inset keeps their shadow clear of the clip. */}
              <div className="scroll-fade-x no-scrollbar pointer-events-auto -my-2 min-w-0 flex-1 overflow-x-auto py-2">
                <div className="mx-auto w-fit">{top}</div>
              </div>
              {hostActions}
            </div>
            {/* Rides the editor's bottom bar, whose own shadow lifts it: zoom and
                More lead, its buttons for a selection follow, undo and redo close it. */}
            <div className="absolute inset-x-4.5 bottom-[calc(1.125rem+env(safe-area-inset-bottom))] flex items-center justify-between gap-1">
              <div
                ref={footerRef}
                className="pointer-events-auto flex items-center gap-1"
              >
                <Zoom
                  state={state}
                  platform={platform}
                  menuFocus={menuFocus}
                  onZoom={onZoom}
                  onFit={onFit}
                />
                <MoreMenu
                  state={state}
                  frames={frames}
                  viewOnlyLocked={viewOnlyLocked}
                  platform={platform}
                  menuFocus={menuFocus}
                  onPreference={onPreference}
                  onViewOnly={onViewOnly}
                  onFrame={onFrame}
                />
              </div>
              {state.viewMode ? null : (
                <History
                  history={history}
                  platform={platform}
                  onHistory={onHistory}
                  className="pointer-events-auto"
                />
              )}
            </div>
          </>
        ) : (
          <>
            <div className="absolute top-4 left-4">{boardMenu}</div>
            <div className="pointer-events-auto absolute top-4 left-1/2 -translate-x-1/2">
              {top}
            </div>
            <div className="absolute top-4 right-4">{hostActions}</div>
            <div
              ref={footerRef}
              className="pointer-events-auto absolute bottom-4 left-4 flex items-center gap-2"
            >
              <Zoom
                state={state}
                platform={platform}
                menuFocus={menuFocus}
                onZoom={onZoom}
                onFit={onFit}
                className={cn("bg-background", SEAMLESS_SEGMENTS)}
              />
              <div className="bg-background">
                <IconButton
                  label="Zoom to Fit"
                  keys={["Shift", "1"]}
                  icon={ICONS.fit}
                  platform={platform}
                  onClick={(event) => onFit("all", pickedBy(event))}
                />
              </div>
              <ViewToggles
                grid={state.grid}
                snap={state.snap}
                viewMode={state.viewMode}
                viewOnlyLocked={viewOnlyLocked}
                platform={platform}
                onPreference={onPreference}
                onViewOnly={onViewOnly}
              />
              {/* View only has nothing to undo; the editor drops its own pair too. */}
              {state.viewMode ? null : (
                <History
                  history={history}
                  platform={platform}
                  onHistory={onHistory}
                  className={cn("bg-background", SEAMLESS_SEGMENTS)}
                />
              )}
            </div>
            {frames.length ? (
              <div className="pointer-events-auto absolute right-4 bottom-4">
                <FrameStepper
                  frames={frames}
                  current={state.frameAt}
                  platform={platform}
                  menuFocus={menuFocus}
                  onFrame={onFrame}
                />
              </div>
            ) : null}
          </>
        )}
      </div>
    </TooltipProvider>
  )
})