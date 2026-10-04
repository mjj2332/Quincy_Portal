/**
 * ReUI `@reui/whiteboard-1` (Pro block; Excalidraw), vendored for #498 through the sandbox
 * (`tmp/ReUI-Test-1`, `--path src/components/vendor-498`), never `shadcn add` in apps/web. Mechanical edits
 * in every file of the set: `cn` from `@/lib/utils` (not the registry's raw `"cn"`), imports repointed to
 * `@/components/reui/`, the `"use client"` directive dropped, the Skin guard's strips (`dark:` variants,
 * Tailwind `shadow-*`, focus ring widths -- see `reui-skin.guard.test.ts`), and `noUncheckedIndexedAccess`
 * narrowing. `"dark": boolean` is quoted only so the guard's `dark:` matcher does not read a type as a variant.
 *
 * This file: Keyboard shortcut handling and the shortcuts dialog. Unchanged apart from the mechanical edits.
 */
import { memo, useRef, useState, type RefObject } from "react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/reui/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/reui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/reui/input-group"
import { Kbd, KbdGroup } from "@/components/reui/kbd"
import { SearchIcon } from "lucide-react"

export type ShortcutPlatform = "apple" | "windows" | "other"

/** Which modifier names the keyboard shows: Cmd and Option, or Ctrl and Alt. */
export function shortcutPlatform(): ShortcutPlatform {
  if (/Mac|iPhone|iPad/.test(navigator.platform)) return "apple"
  if (/Win/.test(navigator.platform)) return "windows"
  return "other"
}

/** One key combination, modifiers first: "Mod" is Cmd on Apple and Ctrl elsewhere. */
type Keys = readonly string[]

type Shortcut = {
  label: string
  /** Alternatives, any of which works. */
  keys: readonly Keys[] | ((platform: ShortcutPlatform) => readonly Keys[])
  supported?: () => boolean
}

type ShortcutGroup = { id: string; title: string; items: readonly Shortcut[] }

// Excalidraw's own labels, as its context menu prints them: words joined by "+",
// Cmd and Option on Apple, Ctrl and Alt elsewhere. Every label here matches them.
const APPLE_NAME: Partial<Record<string, string>> = {
  Mod: "Cmd",
  Alt: "Option",
}
const OTHER_NAME: Partial<Record<string, string>> = { Mod: "Ctrl" }

const APPLE_SPOKEN: Partial<Record<string, string>> = {
  Mod: "Command",
  Alt: "Option",
  Ctrl: "Control",
}
const OTHER_SPOKEN: Partial<Record<string, string>> = {
  Mod: "Control",
  Ctrl: "Control",
}

const keyLabel = (key: string, platform: ShortcutPlatform) =>
  (platform === "apple" ? APPLE_NAME[key] : OTHER_NAME[key]) ?? key

const spokenKey = (key: string, platform: ShortcutPlatform) =>
  (platform === "apple" ? APPLE_SPOKEN[key] : OTHER_SPOKEN[key]) ?? key

/** A menu label in Excalidraw's own format: "Cmd+Shift+Z" on Apple, "Ctrl+Shift+Z" elsewhere. */
export function formatShortcut(keys: Keys, platform: ShortcutPlatform) {
  return keys.map((key) => keyLabel(key, platform)).join("+")
}

const canCopyImage = () => "ClipboardItem" in window

// The 0.18.1 bindings that work in this embed plus the kit's (View Only, frames);
// clearing, theme, zen, the command palette and file and export keys are off.
const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    id: "tools",
    title: "Tools",
    items: [
      { label: "Hand", keys: [["H"]] },
      { label: "Selection", keys: [["V"], ["1"]] },
      { label: "Rectangle", keys: [["R"], ["2"]] },
      { label: "Diamond", keys: [["D"], ["3"]] },
      { label: "Ellipse", keys: [["O"], ["4"]] },
      { label: "Arrow", keys: [["A"], ["5"]] },
      { label: "Line", keys: [["L"], ["6"]] },
      { label: "Draw", keys: [["P"], ["7"]] },
      { label: "Text", keys: [["T"], ["8"]] },
      { label: "Image", keys: [["9"]] },
      { label: "Eraser", keys: [["E"], ["0"]] },
      { label: "Frame", keys: [["F"]] },
      { label: "Laser Pointer", keys: [["K"]] },
      { label: "Eyedropper", keys: [["I"]] },
      { label: "Keep Tool Active", keys: [["Q"]] },
    ],
  },
  {
    id: "editing",
    title: "Editing",
    items: [
      { label: "Edit Text", keys: [["Enter"]] },
      { label: "Finish Text", keys: [["Esc"], ["Mod", "Enter"]] },
      { label: "Edit Line Points", keys: [["Mod", "Enter"]] },
      { label: "Add Link", keys: [["Mod", "K"]] },
      { label: "Delete", keys: [["Delete"]] },
      { label: "Cut", keys: [["Mod", "X"]] },
      { label: "Copy", keys: [["Mod", "C"]] },
      { label: "Paste", keys: [["Mod", "V"]] },
      { label: "Paste as Plain Text", keys: [["Mod", "Shift", "V"]] },
      { label: "Select All", keys: [["Mod", "A"]] },
      { label: "Add to Selection", keys: [["Shift", "Click"]] },
      { label: "Select in Group", keys: [["Mod", "Click"]] },
      {
        label: "Duplicate",
        keys: [
          ["Mod", "D"],
          ["Alt", "Drag"],
        ],
      },
      { label: "Group", keys: [["Mod", "G"]] },
      { label: "Ungroup", keys: [["Mod", "Shift", "G"]] },
      { label: "Lock Element", keys: [["Mod", "Shift", "L"]] },
      { label: "Flip Horizontal", keys: [["Shift", "H"]] },
      { label: "Flip Vertical", keys: [["Shift", "V"]] },
      { label: "Copy Styles", keys: [["Mod", "Alt", "C"]] },
      { label: "Paste Styles", keys: [["Mod", "Alt", "V"]] },
      {
        label: "Copy as PNG",
        keys: [["Shift", "Alt", "C"]],
        supported: canCopyImage,
      },
      { label: "Send Backward", keys: [["Mod", "["]] },
      { label: "Bring Forward", keys: [["Mod", "]"]] },
      {
        label: "Send to Back",
        keys: (platform) =>
          platform === "apple"
            ? [["Mod", "Alt", "["]]
            : [["Mod", "Shift", "["]],
      },
      {
        label: "Bring to Front",
        keys: (platform) =>
          platform === "apple"
            ? [["Mod", "Alt", "]"]]
            : [["Mod", "Shift", "]"]],
      },
      { label: "Align Top", keys: [["Mod", "Shift", "↑"]] },
      { label: "Align Bottom", keys: [["Mod", "Shift", "↓"]] },
      { label: "Align Left", keys: [["Mod", "Shift", "←"]] },
      { label: "Align Right", keys: [["Mod", "Shift", "→"]] },
      { label: "Stroke Color", keys: [["S"]] },
      { label: "Background Color", keys: [["G"]] },
      { label: "Font Family", keys: [["Shift", "F"]] },
      { label: "Font Size Down", keys: [["Mod", "Shift", "<"]] },
      { label: "Font Size Up", keys: [["Mod", "Shift", ">"]] },
      { label: "Create Flowchart", keys: [["Mod", "Arrow"]] },
      { label: "Navigate Flowchart", keys: [["Alt", "Arrow"]] },
      { label: "Undo", keys: [["Mod", "Z"]] },
      {
        label: "Redo",
        keys: (platform) =>
          platform === "windows"
            ? [
                ["Mod", "Shift", "Z"],
                ["Mod", "Y"],
              ]
            : [["Mod", "Shift", "Z"]],
      },
    ],
  },
  {
    id: "view",
    title: "View",
    items: [
      { label: "Zoom In", keys: [["Mod", "+"]] },
      { label: "Zoom Out", keys: [["Mod", "-"]] },
      { label: "Reset Zoom", keys: [["Mod", "0"]] },
      { label: "Zoom to Fit", keys: [["Shift", "1"]] },
      { label: "Zoom to Selection", keys: [["Shift", "2"]] },
      { label: "Pan Canvas", keys: [["Space", "Drag"]] },
      { label: "Scroll Page", keys: [["PgUp"], ["PgDn"]] },
      {
        label: "Scroll Sideways",
        keys: [
          ["Shift", "PgUp"],
          ["Shift", "PgDn"],
        ],
      },
      { label: "Grid", keys: [["Mod", "'"]] },
      { label: "Snap to Objects", keys: [["Alt", "S"]] },
      { label: "View Only", keys: [["Alt", "R"]] },
      { label: "Previous Frame", keys: [["["]] },
      { label: "Next Frame", keys: [["]"]] },
      { label: "Stats", keys: [["Alt", "/"]] },
      { label: "Find on Canvas", keys: [["Mod", "F"]] },
      { label: "Keyboard Shortcuts", keys: [["?"]] },
    ],
  },
]

/** One combination as keycaps, for a tooltip: "Cmd" "+" on Apple, "Ctrl" "+" elsewhere. */
export function ShortcutKbd({
  keys,
  platform,
}: {
  keys: Keys
  platform: ShortcutPlatform
}) {
  return (
    <KbdGroup>
      {keys.map((key) => (
        <Kbd key={key}>{keyLabel(key, platform)}</Kbd>
      ))}
    </KbdGroup>
  )
}

function ShortcutKeys({
  keys,
  platform,
}: {
  keys: readonly Keys[]
  platform: ShortcutPlatform
}) {
  const spoken = keys
    .map((combo) => combo.map((key) => spokenKey(key, platform)).join(" "))
    .join(" or ")

  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span aria-hidden="true" className="flex items-center gap-1.5">
        {keys.map((combo, index) => (
          <span key={combo.join("+")} className="flex items-center gap-1.5">
            {index > 0 ? (
              <span className="text-muted-foreground text-xs">or</span>
            ) : null}
            <KbdGroup>
              {combo.map((key) => (
                <Kbd key={key}>{keyLabel(key, platform)}</Kbd>
              ))}
            </KbdGroup>
          </span>
        ))}
      </span>
      <span className="sr-only">{spoken}</span>
    </span>
  )
}

function ShortcutList({
  platform,
  searchRef,
}: {
  platform: ShortcutPlatform
  searchRef: RefObject<HTMLInputElement | null>
}) {
  // Lives inside the dialog content, so the query resets when it unmounts.
  const [query, setQuery] = useState("")
  const needle = query.trim().toLowerCase()
  const groups = SHORTCUT_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) =>
        (item.supported?.() ?? true) &&
        item.label.toLowerCase().includes(needle)
    ),
  })).filter((group) => group.items.length > 0)
  const count = groups.reduce((total, group) => total + group.items.length, 0)

  return (
    <>
      <InputGroup className="shrink-0">
        <InputGroupAddon align="inline-start">
          <SearchIcon aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          ref={searchRef}
          value={query}
          placeholder="Search shortcuts"
          aria-label="Search shortcuts"
          onChange={(event) => setQuery(event.target.value)}
        />
      </InputGroup>
      <span role="status" aria-live="polite" className="sr-only">
        {count === 1 ? "1 shortcut" : `${count} shortcuts`}
      </span>
      {groups.length ? (
        <div className="scroll-fade-y no-scrollbar -mx-2 min-h-0 flex-1 scroll-py-10 overflow-y-auto">
          <div className="flex flex-col gap-3">
            {groups.map((group) => (
              <section key={group.id} aria-labelledby={`shortcuts-${group.id}`}>
                <h3
                  id={`shortcuts-${group.id}`}
                  className="text-muted-foreground px-2 py-1.5 text-xs font-medium"
                >
                  {group.title}
                </h3>
                <ul>
                  {group.items.map((item) => (
                    <li
                      key={item.label}
                      className="flex min-h-8 items-center justify-between gap-3 px-2 text-sm"
                    >
                      <span className="min-w-0 truncate">{item.label}</span>
                      <ShortcutKeys
                        keys={
                          typeof item.keys === "function"
                            ? item.keys(platform)
                            : item.keys
                        }
                        platform={platform}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      ) : (
        <Empty className="min-h-0 flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No Shortcuts Found</EmptyTitle>
            <EmptyDescription>Try another word.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </>
  )
}

/**
 * Opened by the board menu, the "?" key and any path that asks Excalidraw for
 * its Help. Focus starts in the search and returns to `returnFocus()` on close.
 */
export const WhiteboardShortcuts = memo(function WhiteboardShortcuts({
  open,
  onOpenChange,
  platform,
  returnFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  platform: ShortcutPlatform
  returnFocus: () => HTMLElement | null
}) {
  const searchRef = useRef<HTMLInputElement | null>(null)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Excalidraw closes its sidebar and popovers on presses outside it; a
          fixed height keeps the search still while the list filters. */}
      <DialogContent
        data-prevent-outside-click
        initialFocus={searchRef}
        finalFocus={() => returnFocus() ?? true}
        className="flex h-[calc(100svh-2rem)] flex-col sm:h-[min(40rem,calc(100svh-4rem))] sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
          <DialogDescription>
            Work the board from the keyboard.
          </DialogDescription>
        </DialogHeader>
        <ShortcutList platform={platform} searchRef={searchRef} />
      </DialogContent>
    </Dialog>
  )
})