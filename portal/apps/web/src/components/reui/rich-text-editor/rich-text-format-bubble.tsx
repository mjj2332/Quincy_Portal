// Vendored from ReUI `rich-text-editor-2` (`rich-text-format-bubble.tsx`) via the `tmp/ReUI-Test-1` sandbox
// (#927, `npx shadcn@latest add @reui/rich-text-editor-2 --path src/components/vendor-927`; the file matches the
// 2026-10-08 snapshot). Edits:
// 1. Import paths -> `@/components/reui/*`; the bar, toolbar, link popover and state hook are the copies already
//    vendored here (#491, #492), with their Quincy edits.
// 2. The control set is a note's (#927, frame C3): Bold, Italic, Strikethrough, Link | Bulleted list, Numbered list.
//    The vendor's block-type menu, Underline, alignment and highlight are dropped, and with them
//    `rich-text-controls.tsx`, which is not vendored: a note makes no headings (`lib/rich-text-tiptap.ts`), and
//    alignment and highlight are Notice-board marks the comment profile refuses.
// 3. A selection inside a link still shows the bubble. The vendor steps aside there for its own link bubble, which
//    is not vendored; here Link reads pressed and its popover edits or removes the link. Its code-block and table
//    exclusions go with the nodes a note's schema does not have.
// 4. `docked` (frame P2): on a phone the bubble sits on the box's top edge, start-aligned, instead of over the
//    selection, so it never meets iOS's own Copy / Paste callout. Its anchor is `dockTo()` (the host's box), else
//    the editor's field.
// 5. `appendTo`: the bubble mounts at the nearest `data-surface` scope rather than beside the editor. The note box's
//    text region scrolls, which would clip it, and the scope gives it the viewer's dark popover roles (ADR 0024,
//    owner decision D5: C3 and P2 draw a light bubble, the build keeps the viewer's). With no scope it mounts in the
//    dialog that holds the editor (the Project sheet's Collaboration tab): on `document.body` the sheet, at --z-dialog,
//    covered the bubble's --z-popover. `document.body` is the last resort. `richTextBubbleRoot` is that order.
// 6. A click inside the bubble stops there. React carries it through the menu's portal to whatever renders the
//    editor, and a note card seeks on click (docs/lessons.md "A portaled menu's click bubbles to the card that
//    renders it (#901)").
// 7. `testId` on the bar (`rich-text-format-bubble`), and `data-docked` on it for browser measurement.
// 8. `shouldShow` answers false for a destroyed editor: the plugin's debounced update can run after an unmount, and reading
//    `view` then throws (a note composer closed within 250ms of a selection).
// 9. Sizes: the installed toggle's `sm` (28px, 44px below 721px, so docked targets are 44px) against the frame's 30px / 40px, with the
//    icons set to the frame's 16px / 18px. The Strikethrough tooltip names the shortcut that works, ⇧⌘S (Tiptap's), not the frame's ⇧⌘X.
// 10. `notice` (#951, owner decision N4): the Notice board's box gets the note's controls plus the vendor's Underline (after Italic, the
//    vendor's order) and a Layout group of alignment and highlight, the installed `RichTextAlignMenu` and `RichTextHighlightPopover`.
//    Headings, the checklist and tables stay in its "/" menu. Without it the bubble is the note's, unchanged.
import { useCallback, useLayoutEffect, useMemo, useRef } from "react"
import type { EditorState } from "@tiptap/pm/state"
import { isTextSelection, type Editor } from "@tiptap/react"
import { BubbleMenu } from "@tiptap/react/menus"
import { BoldIcon, ItalicIcon, ListIcon, ListOrderedIcon, StrikethroughIcon, UnderlineIcon } from "lucide-react"

import { RichTextAlignMenu } from "./rich-text-align"
import { RichTextHighlightPopover } from "./rich-text-highlight"

import { RichTextBubbleBar, setRichTextBubble } from "./rich-text-bubble-bar"
import { RichTextLinkPopover } from "./rich-text-link"
import { useRichTextState } from "./rich-text-state"
import {
  RichTextToggle,
  RichTextToolbarGroup,
  RichTextToolbarSeparator,
} from "./rich-text-toolbar"

const FORMAT_BUBBLE_KEY = "richTextFormatBubble"

const FLOATING_OPTIONS = { placement: "top", offset: 8 } as const
// Docked, it keeps to the box's top edge: flipping it under the box would put it over the keyboard.
const DOCKED_OPTIONS = { placement: "top-start", offset: 8, flip: false } as const

/** Where a bubble mounts: the surface scope, else the dialog that holds the editor, else `document.body` (edit 5). */
export function richTextBubbleRoot(editor: Editor): HTMLElement {
  const dom = editor.view.dom
  return (dom.closest("[data-surface]") as HTMLElement | null) ?? (dom.closest("[role='dialog']") as HTMLElement | null) ?? document.body
}

/** Shows the format bubble now, for a link edit that starts from the keyboard. */
export function showRichTextFormatBubble(editor: Editor) {
  setRichTextBubble(editor, FORMAT_BUBBLE_KEY, "show")
}

interface ShouldShowProps {
  editor: Editor
  element: HTMLElement
  state: EditorState
  from: number
  to: number
}

interface RichTextFormatBubbleProps {
  editor: Editor
  linkOpen: boolean
  onLinkOpenChange: (open: boolean) => void
  /** Called with the address after a successful Apply. */
  onLinkApplied?: (href: string) => void
  /** The owner's own disabled state. */
  disabled?: boolean
  /** On the box's top edge (a phone) instead of over the selection. */
  docked?: boolean
  /** The element a docked bubble sits on; the editor's field when absent or null. */
  dockTo?: () => Element | null
  /** The Notice board's set (N4): Underline, then alignment and highlight after the lists. */
  notice?: boolean
}

/** Marks, link and lists over a text selection. */
export function RichTextFormatBubble({
  editor,
  linkOpen,
  onLinkOpenChange,
  onLinkApplied,
  disabled = false,
  docked = false,
  dockTo,
  notice = false,
}: RichTextFormatBubbleProps) {
  const state = useRichTextState(editor)
  const linkOpenRef = useRef(linkOpen)
  const dockToRef = useRef(dockTo)
  const dockedRef = useRef(docked)

  useLayoutEffect(() => {
    linkOpenRef.current = linkOpen
    dockToRef.current = dockTo
    dockedRef.current = docked
  }, [linkOpen, dockTo, docked])

  // Stable identity: a new function would re-register the plugin options.
  const shouldShow = useCallback(
    ({ editor: current, element, state: doc, from, to }: ShouldShowProps) => {
      // Tiptap's 250ms update timer outlives the editor (it is not cleared on destroy), and a destroyed editor's view throws.
      if (current.isDestroyed || !current.isEditable) return false
      // The link field lives in this bar, so it stays up while it is open.
      if (linkOpenRef.current) return true
      if (!isTextSelection(doc.selection) || doc.selection.empty) return false
      if (!doc.doc.textBetween(from, to).trim()) return false
      return current.view.hasFocus() || element.contains(document.activeElement)
    },
    []
  )

  // Always a function, read through refs: the plugin keeps the last one it was given, so `undefined` would not undo a dock. Null floats
  // the bubble over the selection, as the vendor does.
  const reference = useCallback(() => {
    if (!dockedRef.current) return null
    const anchor = dockToRef.current?.() ?? editor.view.dom.closest("[data-testid='rich-text-field']") ?? editor.view.dom
    return { getBoundingClientRect: () => anchor.getBoundingClientRect(), getClientRects: () => [anchor.getBoundingClientRect()], contextElement: anchor }
  }, [editor])

  const appendTo = useCallback(() => richTextBubbleRoot(editor), [editor])

  const options = useMemo(() => (docked ? DOCKED_OPTIONS : FLOATING_OPTIONS), [docked])
  const off = (can: boolean) => disabled || !can

  return (
    <BubbleMenu
      editor={editor}
      pluginKey={FORMAT_BUBBLE_KEY}
      shouldShow={shouldShow}
      options={options}
      appendTo={appendTo}
      getReferencedVirtualElement={reference}
      className="z-[var(--z-popover)]"
    >
      {/* Icons at the frame's sizes: 16px over the selection (C3), 18px docked (P2), where the targets are 44px. */}
      <div data-docked={docked ? "true" : "false"} onClick={(event) => event.stopPropagation()} className={docked ? "[&_[data-toolbar-item]_svg]:size-4.5" : "[&_[data-toolbar-item]_svg]:size-4"}>
        <RichTextBubbleBar
          editor={editor}
          pluginKey={FORMAT_BUBBLE_KEY}
          label="Format text"
          holdOpen={linkOpen}
          testId="rich-text-format-bubble"
        >
          <RichTextToolbarGroup label="Text style">
            <RichTextToggle label="Bold" shortcut={["mod", "B"]} pressed={state.bold} disabled={off(state.canBold)} onToggle={() => editor.chain().focus().toggleBold().run()}>
              <BoldIcon aria-hidden="true" />
            </RichTextToggle>
            <RichTextToggle label="Italic" shortcut={["mod", "I"]} pressed={state.italic} disabled={off(state.canItalic)} onToggle={() => editor.chain().focus().toggleItalic().run()}>
              <ItalicIcon aria-hidden="true" />
            </RichTextToggle>
            {notice && <RichTextToggle label="Underline" shortcut={["mod", "U"]} pressed={state.underline} disabled={off(state.canUnderline)} onToggle={() => editor.chain().focus().toggleUnderline().run()}>
              <UnderlineIcon aria-hidden="true" />
            </RichTextToggle>}
            <RichTextToggle label="Strikethrough" shortcut={["mod", "shift", "S"]} pressed={state.strike} disabled={off(state.canStrike)} onToggle={() => editor.chain().focus().toggleStrike().run()}>
              <StrikethroughIcon aria-hidden="true" />
            </RichTextToggle>
            <RichTextLinkPopover editor={editor} state={state} disabled={disabled} testId="rich-text-link-popover" open={linkOpen} onOpenChange={onLinkOpenChange} onApplied={onLinkApplied} />
          </RichTextToolbarGroup>
          <RichTextToolbarSeparator />
          <RichTextToolbarGroup label="Lists">
            <RichTextToggle label="Bulleted list" pressed={state.bulletList} disabled={off(state.canBulletList) || state.atListNestingLimit} onToggle={() => editor.chain().focus().toggleBulletList().run()}>
              <ListIcon aria-hidden="true" />
            </RichTextToggle>
            <RichTextToggle label="Numbered list" pressed={state.orderedList} disabled={off(state.canOrderedList) || state.atListNestingLimit} onToggle={() => editor.chain().focus().toggleOrderedList().run()}>
              <ListOrderedIcon aria-hidden="true" />
            </RichTextToggle>
          </RichTextToolbarGroup>
          {notice && <>
            <RichTextToolbarSeparator />
            <RichTextToolbarGroup label="Layout">
              <RichTextAlignMenu editor={editor} state={state} disabled={disabled} />
              <RichTextHighlightPopover editor={editor} state={state} />
            </RichTextToolbarGroup>
          </>}
        </RichTextBubbleBar>
      </div>
    </BubbleMenu>
  )
}
