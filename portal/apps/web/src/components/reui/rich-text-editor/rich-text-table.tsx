// Vendored from ReUI `rich-text-editor-2` (`rich-text-table.tsx`) via the `tmp/ReUI-Test-1` sandbox
// (#492). Edits:
// 1. `@/components/ui/*` -> `@/components/reui/*`; `cn` import dropped with the prose constant below.
// 2. `RichTextTable` (a resizable `TableKit`) and `RICH_TEXT_TABLE_PROSE` (Tailwind descendant classes)
//    are NOT here. The Notice board tables are not resizable (no stored `colwidth`; enabling it later
//    is additive), the nodes are built in `lib/rich-text-tiptap.ts` (cells pinned to `paragraph+`,
//    the stored contract) and the table's look is token-only CSS in `styles/app.css` (`.rich-text table`
//    / `.rich-text__editor-content table`), as the rest of the editor surface is.
// 3. `z-50` -> `z-[var(--z-popover)]` (the overlay ladder; a bare `z-50` sits under the shell header).
// 4. `testId="rich-text-table-bubble"` on the bar: a Quincy-owned test hook.
// 5. Add row / Add column disable at the server's 50 x 12 limits (`tableDimensions`); the hard stop for
//    Tab and paste is `TableSizeBoundary` in `lib/rich-text-tiptap.ts`.
// 6. The bar anchors to the DOM element of the CELL holding the caret (`$anchor`), not the whole table
//    (nothing in the vendored copy anchored to cells or rows; the original used the table), so it can be
//    placed `top-start` -> `bottom-start` around the active cell and never over it. It is re-resolved on
//    every selection update; the plugin's own scroll/resize handlers re-run it. flip and shift share one
//    boundary rect (`rich-text-table-position.ts`): bounded by the editable surface's top down to the
//    helper line, with 8px clearance. The bar may therefore cross the frame's bottom border (owner
//    decision #535); it never covers the toolbar, the character counter or the helper: the floor is the top of
//    the first rendered element below the frame (`tableBubbleFloors`). Hosts with none of them (e.g. the edit
//    composer below 90% of the limit) keep the surface as the boundary. When even that fails the bar keeps
//    `top-start` and shift clamps it.
// 7. The zone the bar may occupy is chosen per positioning pass (`tableBubbleZone`): between the neighbouring
//    blocks when the bar fits above or below the active ROW (`readActiveRowRect`, `readTableNeighbours`), else
//    the wide zone of edit 6, and the bar's outer padding is gone (`rich-text-bubble-bar.tsx`), so it fits above
//    row 2 of a first-block table (#535).
// 8. The bar's controls are `RichTextTableControls`, shared with `RichTextTableTools`: below 721px the same
//    controls render as the FIRST group of the formatting toolbar instead (`QuincyRichTextEditor`), because
//    a floating bar has no room around a table on a phone (#535). The two never mount together.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react"
import { findParentNodeClosestToPos, type Editor } from "@tiptap/react"
import { BubbleMenu } from "@tiptap/react/menus"

import { Button } from "@/components/reui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/reui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/reui/tooltip"
import { RICH_TEXT_TABLE_MAX_COLUMNS, RICH_TEXT_TABLE_MAX_ROWS } from "@quincy/shared"
import { tableDimensions } from "@/lib/rich-text-tiptap"
import { readFloorTop, readVisualOffset, tableBubbleOptions } from "./rich-text-table-position"
import { RichTextBubbleBar, focusFirstToolbarStop, fromOwnDom } from "./rich-text-bubble-bar"
import type { RichTextSlashItem } from "./rich-text-slash-menu"
import { useRichTextSelector } from "./rich-text-state"
import {
  RichTextButton,
  RichTextToggle,
  RichTextToolbarGroup,
  RichTextToolbarSeparator,
} from "./rich-text-toolbar"
import { TableIcon, BetweenHorizontalEndIcon, BetweenVerticalEndIcon, PanelTopIcon, Trash2Icon, Rows3Icon, Columns3Icon } from "lucide-react"

export const RICH_TEXT_TABLE_SLASH_ITEM: RichTextSlashItem = {
  id: "table",
  group: "Advanced",
  title: "Table",
  hint: "Rows and columns with a header",
  keywords: ["grid", "rows", "columns", "spreadsheet"],
  icon: (
    <TableIcon aria-hidden="true" />
  ),
  // Cells hold paragraphs only, but a table inside a table is refused all the same.
  can: (editor) => !editor.isActive("table"),
  run: (editor, range) =>
    editor
      .chain()
      .focus()
      .deleteRange(range)
      .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
      .run(),
}

interface TableSnapshot {
  headerRow: boolean
  canDeleteRow: boolean
  canDeleteColumn: boolean
  /** The server stores at most 50 rows x 12 columns: growth stops there. */
  canAddRow: boolean
  canAddColumn: boolean
}

const IDLE_TABLE: TableSnapshot = {
  headerRow: false,
  canDeleteRow: false,
  canDeleteColumn: false,
  canAddRow: false,
  canAddColumn: false,
}

function findTable(editor: Editor) {
  return findParentNodeClosestToPos(
    editor.state.selection.$from,
    (node) => node.type.name === "table"
  )
}

// The engine reports the last row and column as deletable, then refuses.
function readTable(editor: Editor | null): TableSnapshot {
  const table = editor ? findTable(editor) : undefined
  const firstRow = table?.node.firstChild

  if (!table || !firstRow) return IDLE_TABLE

  const { rows, columns } = tableDimensions(table.node)

  return {
    headerRow: firstRow.firstChild?.type.name === "tableHeader",
    canDeleteRow: table.node.childCount > 1,
    canDeleteColumn: columns > 1,
    canAddRow: rows < RICH_TEXT_TABLE_MAX_ROWS,
    canAddColumn: columns < RICH_TEXT_TABLE_MAX_COLUMNS,
  }
}

const TABLE_BUBBLE_KEY = "richTextTableBubble"

/** The DOM element of the table cell holding the selection anchor, or null outside a table. */
export function getActiveCellElement(editor: Editor): HTMLElement | null {
  const found = findParentNodeClosestToPos(
    editor.state.selection.$anchor,
    (node) => node.type.name === "tableCell" || node.type.name === "tableHeader"
  )
  const dom = found ? editor.view.nodeDOM(found.pos) : null

  return dom instanceof HTMLElement ? dom : null
}

/** The rect of the table row (every cell) holding the selection anchor; the cell's own when no row resolves. */
export function readActiveRowRect(editor: Editor) {
  const found = findParentNodeClosestToPos(
    editor.state.selection.$anchor,
    (node) => node.type.name === "tableRow"
  )
  const dom = found ? editor.view.nodeDOM(found.pos) : null
  const element = dom instanceof HTMLElement ? dom : getActiveCellElement(editor)
  const rect = element?.getBoundingClientRect()

  return rect
    ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
    : { top: 0, bottom: 0, left: 0, right: 0 }
}

function blockRect(editor: Editor, pos: number) {
  const dom = editor.view.nodeDOM(pos)
  if (!(dom instanceof HTMLElement)) return null
  const rect = dom.getBoundingClientRect()

  return Number.isFinite(rect.top) && Number.isFinite(rect.bottom) ? rect : null
}

/**
 * Bottom of the block before the table and top of the block after it (null at the document's edges or when a
 * neighbour has no element). Read fresh on every positioning pass: the blocks reflow as the content does.
 */
export function readTableNeighbours(editor: Editor): {
  prevBottom: number | null
  nextTop: number | null
} {
  const table = findTable(editor)

  if (!table) return { prevBottom: null, nextTop: null }

  const $table = editor.state.doc.resolve(table.pos)
  const before = $table.nodeBefore
  const nextPos = table.pos + table.node.nodeSize
  const after = nextPos <= editor.state.doc.content.size ? editor.state.doc.resolve(nextPos).nodeAfter : null

  return {
    prevBottom: before ? (blockRect(editor, table.pos - before.nodeSize)?.bottom ?? null) : null,
    nextTop: after ? (blockRect(editor, nextPos)?.top ?? null) : null,
  }
}

function showInTable({
  editor,
  element,
}: {
  editor: Editor
  element: HTMLElement
}) {
  return (
    editor.isEditable &&
    editor.isActive("table") &&
    (editor.view.hasFocus() || element.contains(document.activeElement))
  )
}

interface RichTextTableBubbleProps {
  editor: Editor
  /** Deleting the whole table is the host's call: confirm it first. */
  onDeleteTable: () => void
  /**
   * Elements rendered below the editor frame (character counter, host helper line): the table bar may extend
   * down to the highest of them (#535).
   */
  tableBubbleFloors?: ReadonlyArray<RefObject<HTMLElement | null> | undefined>
}

interface RichTextTableControlsProps {
  editor: Editor
  onDeleteTable: () => void
  /** The editor is read-only or busy: every control is disabled, the group stays. */
  disabled?: boolean
}

/** Add row / column, Header row and Delete: the table's controls, in the floating bar and on the phone alike. */
export function RichTextTableControls({
  editor,
  onDeleteTable,
  disabled = false,
}: RichTextTableControlsProps) {
  const table = useRichTextSelector(editor, readTable)

  return (
    <>
      <RichTextToolbarGroup label="Insert">
        <RichTextButton
          label="Add row below"
          disabled={disabled || !table.canAddRow}
          onClick={() => editor.chain().focus().addRowAfter().run()}
        >
          <BetweenHorizontalEndIcon aria-hidden="true" />
        </RichTextButton>
        <RichTextButton
          label="Add column right"
          disabled={disabled || !table.canAddColumn}
          onClick={() => editor.chain().focus().addColumnAfter().run()}
        >
          <BetweenVerticalEndIcon aria-hidden="true" />
        </RichTextButton>
      </RichTextToolbarGroup>
      <RichTextToolbarSeparator />
      <RichTextToggle
        label="Header row"
        pressed={table.headerRow}
        disabled={disabled}
        onToggle={() => editor.chain().focus().toggleHeaderRow().run()}
      >
        <PanelTopIcon aria-hidden="true" />
      </RichTextToggle>
      <RichTextToolbarSeparator />
      <DropdownMenu>
        <Tooltip>
          {/* The span carries the tooltip, so the trigger keeps its own props. */}
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="max-[721px]:size-11"
                  aria-label="Delete"
                  disabled={disabled}
                  data-toolbar-item=""
                />
              }
            >
              <Trash2Icon aria-hidden="true" />
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Delete</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="start"
          className="w-auto"
          finalFocus={() => editor.view.dom}
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel>Delete</DropdownMenuLabel>
            <DropdownMenuItem
              disabled={disabled || !table.canDeleteRow}
              onClick={() => editor.chain().focus().deleteRow().run()}
            >
              <Rows3Icon aria-hidden="true" />
              Delete Row
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={disabled || !table.canDeleteColumn}
              onClick={() => editor.chain().focus().deleteColumn().run()}
            >
              <Columns3Icon aria-hidden="true" />
              Delete Column
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" disabled={disabled} onClick={onDeleteTable}>
            <Trash2Icon aria-hidden="true" />
            Delete Table
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

/** Row, column and header controls above the table holding the caret. */
export function RichTextTableBubble({
  editor,
  onDeleteTable,
  tableBubbleFloors,
}: RichTextTableBubbleProps) {
  // Anchors to the active cell; re-resolved on each selection update, so moving the caret re-anchors.
  const getCellRect = useCallback(() => {
    const dom = getActiveCellElement(editor)

    if (!dom) return null

    return {
      getBoundingClientRect: () => dom.getBoundingClientRect(),
      getClientRects: () => [dom.getBoundingClientRect()],
      contextElement: dom,
    }
  }, [editor])

  const options = useMemo(
    () =>
      tableBubbleOptions({
        surface: () => editor.view.dom.getBoundingClientRect(),
        floorTop: () => readFloorTop(...(tableBubbleFloors ?? []).map((ref) => ref?.current)),
        neighbours: () => readTableNeighbours(editor),
        row: () => readActiveRowRect(editor),
        visualOffset: () => readVisualOffset(),
      }),
    [editor, tableBubbleFloors]
  )

  return (
    <BubbleMenu
      editor={editor}
      pluginKey={TABLE_BUBBLE_KEY}
      shouldShow={showInTable}
      getReferencedVirtualElement={getCellRect}
      options={options}
      className="z-[var(--z-popover)]"
    >
      <RichTextBubbleBar
        editor={editor}
        pluginKey={TABLE_BUBBLE_KEY}
        label="Table"
        testId="rich-text-table-bubble"
      >
        <RichTextTableControls editor={editor} onDeleteTable={onDeleteTable} />
      </RichTextBubbleBar>
    </BubbleMenu>
  )
}

interface RichTextTableToolsProps {
  editor: Editor
  onDeleteTable: () => void
  disabled?: boolean
}

/**
 * The phone's table controls: a group at the start of the formatting toolbar (a toolbar item, so the roving
 * focus walks it), mirroring `rich-text-media-tools`. It appears with the caret in a table and scrolls the
 * toolbar back to its start so it is visible; Alt+F10 from the text reaches it and Escape returns.
 */
export function RichTextTableTools({
  editor,
  onDeleteTable,
  disabled = false,
}: RichTextTableToolsProps) {
  const ref = useRef<HTMLDivElement>(null)

  // Appearing must not leave the group scrolled out of view; a plain scrollLeft keeps focus and the page still.
  useLayoutEffect(() => {
    const scroller = ref.current?.closest<HTMLElement>("[role='toolbar']")

    if (scroller) scroller.scrollLeft = 0
  }, [])

  // The WAI-ARIA editor convention, as the floating bar has it; only a mounted group is reachable.
  useEffect(() => {
    const { dom } = editor.view

    function handleShortcut(event: KeyboardEvent) {
      const group = ref.current

      if (!event.altKey || event.key !== "F10" || !group?.isConnected) return
      if (!focusFirstToolbarStop(group)) return
      event.preventDefault()
    }

    dom.addEventListener("keydown", handleShortcut)
    return () => dom.removeEventListener("keydown", handleShortcut)
  }, [editor])

  // Menus portal out, yet React still bubbles their events here. Capture phase: a control that handles Escape
  // itself (the Base UI button/tooltip) stops it before it would bubble to this wrapper.
  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || !fromOwnDom(event)) return

    event.preventDefault()
    editor.commands.focus()
  }

  return (
    <div
      ref={ref}
      data-testid="rich-text-table-tools"
      aria-keyshortcuts="Alt+F10"
      className="order-first flex shrink-0 items-center gap-[var(--space-2)]"
      onKeyDownCapture={handleKeyDown}
    >
      <RichTextToolbarGroup label="Table">
        <RichTextTableControls
          editor={editor}
          onDeleteTable={onDeleteTable}
          disabled={disabled}
        />
      </RichTextToolbarGroup>
      <RichTextToolbarSeparator />
    </div>
  )
}
