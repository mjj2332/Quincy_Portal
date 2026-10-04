// Adapted from ReUI `rich-text-editor-2` (`RichTextAlignMenu` in `rich-text-controls.tsx`) via the
// `tmp/ReUI-Test-1` sandbox (#492), lifted out of the vendor's controls file on its own: the rest of
// `rich-text-controls.tsx` is the vendor's whole toolbar, which Quincy does not use (the toolbar is
// composed in `QuincyRichTextEditor`, #491). Edits:
// 1. Imports -> `@/components/reui/*`; `ControlProps` -> `{ editor, state }` of our own snapshot.
// 2. The trigger reads `state.align` / `state.canAlign` (document-only: the composer has no
//    `TextAlign`, so `setTextAlign` does not exist there and the snapshot never calls it).
// 3. `data-testid="rich-text-align-menu"` on the trigger, a Quincy-owned test hook.
import { useRef, type ReactNode } from "react"
import type { Editor } from "@tiptap/react"
import { AlignCenterIcon, AlignJustifyIcon, AlignLeftIcon, AlignRightIcon, ChevronDownIcon } from "lucide-react"

import { Button } from "@/components/reui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/reui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/reui/tooltip"
import type { RichTextAlign, RichTextSnapshot } from "./rich-text-state"
import { useShortcutLabel } from "./rich-text-toolbar"

export const RICH_TEXT_ALIGNS = ["left", "center", "right", "justify"] as const satisfies readonly RichTextAlign[]

const ALIGN_LABELS: Record<RichTextAlign, string> = {
  left: "Align left",
  center: "Align center",
  right: "Align right",
  justify: "Justify",
}

const ALIGN_KEYS: Record<RichTextAlign, string> = { left: "L", center: "E", right: "R", justify: "J" }

// Whole static nodes per key, so the trigger can mirror the current value.
const ALIGN_ICONS: Record<RichTextAlign, ReactNode> = {
  left: <AlignLeftIcon aria-hidden="true" />,
  center: <AlignCenterIcon aria-hidden="true" />,
  right: <AlignRightIcon aria-hidden="true" />,
  justify: <AlignJustifyIcon aria-hidden="true" />,
}

const isAlign = (value: unknown): value is RichTextAlign =>
  typeof value === "string" && value in ALIGN_LABELS

function MenuShortcut({ keys }: { keys: readonly string[] }) {
  return <DropdownMenuShortcut>{useShortcutLabel(keys)}</DropdownMenuShortcut>
}

export function RichTextAlignMenu({ editor, state, disabled = false }: { editor: Editor | null; state: RichTextSnapshot; disabled?: boolean }) {
  // Only choosing an alignment moves focus to the editor; Escape / outside dismissal returns it to the trigger.
  const appliedRef = useRef(false)
  // Two glyphs and no label read as an icon button, so the text inset is trimmed.
  return (
    <DropdownMenu onOpenChange={(open) => { if (open) appliedRef.current = false }}>
      <Tooltip>
        {/* The span carries the tooltip, so the trigger keeps its own props. */}
        <TooltipTrigger render={<span className="flex shrink-0" />}>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Alignment, ${ALIGN_LABELS[state.align]}`}
                disabled={disabled || !state.canAlign}
                className="gap-0.5 px-1.5 max-[721px]:h-11"
                data-toolbar-item=""
                data-testid="rich-text-align-menu"
              />
            }
          >
            {ALIGN_ICONS[state.align]}
            <ChevronDownIcon aria-hidden="true" className="opacity-60" />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Alignment</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-auto" finalFocus={() => (appliedRef.current ? (editor?.view.dom ?? true) : true)}>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Alignment</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={state.align}
            onValueChange={(value) => {
              if (isAlign(value)) { appliedRef.current = true; editor?.chain().focus().setTextAlign(value).run() }
            }}
          >
            {RICH_TEXT_ALIGNS.map((align) => (
              <DropdownMenuRadioItem key={align} value={align} closeOnClick>
                {ALIGN_ICONS[align]}
                {ALIGN_LABELS[align]}
                <MenuShortcut keys={["mod", "shift", ALIGN_KEYS[align]]} />
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
