// Vendored from ReUI `rich-text-editor-2` (`rich-text-highlight.tsx`) via the `tmp/ReUI-Test-1`
// sandbox (#492). Edits:
// 1. Imports -> `@/components/reui/*`, `cn` -> `@/lib/utils`.
// 2. `RichTextHighlight` (the `color`-attribute `Highlight` extension) moved to
//    `lib/rich-text-tiptap.ts`, so the schema module carries no UI import; the picker stays here.
// 3. Five Tailwind-palette colours with `dark:` pairs -> the three the stored contract allows
//    (yellow, green, blue), on new `--highlight-*` tokens; the painted mark is plain CSS in
//    `styles/app.css`. `pink` and `violet` are gone: `parseRichTextDoc` would reject them.
// 4. The pressed toggle reads `bg-primary` / `--accent-on`, as `RichTextToggle` does (#491 edit 3).
// 5. `data-testid="rich-text-highlight"` on the trigger, a Quincy-owned test hook.
// 6. `finalFocus` depends on the close reason (as the link popover): applying a colour -> the editor,
//    Escape / outside dismissal -> the trigger. Colour buttons are 44px at <=721px.
import { useRef, useState } from "react"
import type { RichTextHighlightColor } from "@quincy/shared"
import type { Editor } from "@tiptap/react"
import { cn } from "@/lib/utils"

import { Button } from "@/components/reui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/reui/popover"
import { Separator } from "@/components/reui/separator"
import { Toggle } from "@/components/reui/toggle"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/reui/tooltip"
import type { RichTextSnapshot } from "./rich-text-state"
import { keepEditorFocus, ShortcutKeys } from "./rich-text-toolbar"
import { HighlighterIcon, CheckIcon, BanIcon } from "lucide-react"

interface HighlightColor {
  id: RichTextHighlightColor
  label: string
  /** The swatch in the picker; the painted mark is `mark[data-color]` in `styles/app.css`. */
  swatch: string
}

// Three washes on the `--highlight-*` tokens (`styles/tokens/colors.css`, contrast-checked against
// ink in `design-system-guards.test.ts`). The Portal has no dark theme, so there is no dark pair.
export const HIGHLIGHT_COLORS = [
  { id: "yellow", label: "Yellow", swatch: "bg-[var(--highlight-yellow)]" },
  { id: "green", label: "Green", swatch: "bg-[var(--highlight-green)]" },
  { id: "blue", label: "Blue", swatch: "bg-[var(--highlight-blue)]" },
] as const satisfies readonly HighlightColor[]

export type HighlightColorId = (typeof HIGHLIGHT_COLORS)[number]["id"]

interface RichTextHighlightPopoverProps {
  editor: Editor | null
  state: RichTextSnapshot
}

export function RichTextHighlightPopover({
  editor,
  state,
}: RichTextHighlightPopoverProps) {
  const [open, setOpen] = useState(false)
  // Only applying a colour moves focus to the editor; Escape / outside dismissal returns it to the trigger.
  const appliedRef = useRef(false)

  function apply(color: HighlightColorId | null) {
    const chain = editor?.chain().focus()

    if (color) {
      chain?.setHighlight({ color }).run()
    } else {
      chain?.unsetHighlight().run()
    }

    appliedRef.current = true
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) appliedRef.current = false
        setOpen(next)
      }}
    >
      <Tooltip>
        {/* The span carries the tooltip, so the trigger keeps its own props. */}
        <TooltipTrigger render={<span className="flex" />}>
          <PopoverTrigger
            render={
              <Toggle
                size="sm"
                aria-label="Highlight"
                pressed={state.highlight !== null}
                disabled={!state.canHighlight}
                onMouseDown={keepEditorFocus}
                className="px-0 aria-pressed:bg-primary aria-pressed:!text-[var(--accent-on)]"
                data-toolbar-item=""
                data-testid="rich-text-highlight"
              />
            }
          >
            <HighlighterIcon aria-hidden="true" />
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>
          Highlight
          <ShortcutKeys keys={["mod", "shift", "H"]} />
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align="start"
        aria-label="Highlight color"
        className="w-auto"
        finalFocus={() => (appliedRef.current ? (editor?.view.dom ?? true) : true)}
      >
        <div className="flex items-center gap-1">
          {HIGHLIGHT_COLORS.map((color) => {
            const selected = state.highlight === color.id

            return (
              <Button
                key={color.id}
                variant="ghost"
                size="icon-sm"
                className="max-[721px]:size-11"
                aria-label={`${color.label} highlight`}
                aria-pressed={selected}
                onClick={() => apply(color.id)}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "text-foreground flex size-5 items-center justify-center rounded-full",
                    color.swatch
                  )}
                >
                  {selected ? (
                    <CheckIcon aria-hidden="true" />
                  ) : null}
                </span>
              </Button>
            )
          })}
          <Separator
            orientation="vertical"
            className="h-4 data-[orientation=vertical]:self-center"
          />
          <Button
            variant="ghost"
            size="icon-sm"
            className="max-[721px]:size-11"
            aria-label="Remove highlight"
            disabled={state.highlight === null}
            onClick={() => apply(null)}
          >
            <BanIcon aria-hidden="true" />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}