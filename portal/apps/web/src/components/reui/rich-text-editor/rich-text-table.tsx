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
import { useCallback, useMemo } from "react"
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
import { RichTextBubbleBar } from "./rich-text-bubble-bar"
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

// Below the table, never flipped: flipping above puts the bar over the main toolbar when the table is the
// first block. Instead `shift` (cross axis too) clamps the bar inside the editable surface, so when the table
// is the last block or tall the bar rides over the table's lower rows rather than leaving the surface onto the
// frame border, the helper line or the toolbar. A table is always taller than the bar, so it always fits.
const TABLE_BUBBLE_GAP = 8

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
}

/** Row, column and header controls above the table holding the caret. */
export function RichTextTableBubble({
  editor,
  onDeleteTable,
}: RichTextTableBubbleProps) {
  const table = useRichTextSelector(editor, readTable)

  // Anchors to the whole table, so the bar holds still while the caret moves.
  const getTableRect = useCallback(() => {
    const found = findTable(editor)
    const dom = found ? editor.view.nodeDOM(found.pos) : null

    if (!(dom instanceof HTMLElement)) return null

    return {
      getBoundingClientRect: () => dom.getBoundingClientRect(),
      getClientRects: () => [dom.getBoundingClientRect()],
      contextElement: dom,
    }
  }, [editor])

  const options = useMemo(
    () => ({
      placement: "bottom-start" as const,
      offset: TABLE_BUBBLE_GAP,
      flip: false as const,
      shift: { boundary: editor.view.dom, padding: TABLE_BUBBLE_GAP, crossAxis: true },
    }),
    [editor]
  )

  return (
    <BubbleMenu
      editor={editor}
      pluginKey={TABLE_BUBBLE_KEY}
      shouldShow={showInTable}
      getReferencedVirtualElement={getTableRect}
      options={options}
      className="z-[var(--z-popover)]"
    >
      <RichTextBubbleBar
        editor={editor}
        pluginKey={TABLE_BUBBLE_KEY}
        label="Table"
        testId="rich-text-table-bubble"
      >
        <RichTextToolbarGroup label="Insert">
          <RichTextButton
            label="Add row below"
            disabled={!table.canAddRow}
            onClick={() => editor.chain().focus().addRowAfter().run()}
          >
            <BetweenHorizontalEndIcon aria-hidden="true" />
          </RichTextButton>
          <RichTextButton
            label="Add column right"
            disabled={!table.canAddColumn}
            onClick={() => editor.chain().focus().addColumnAfter().run()}
          >
            <BetweenVerticalEndIcon aria-hidden="true" />
          </RichTextButton>
        </RichTextToolbarGroup>
        <RichTextToolbarSeparator />
        <RichTextToggle
          label="Header row"
          pressed={table.headerRow}
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
                disabled={!table.canDeleteRow}
                onClick={() => editor.chain().focus().deleteRow().run()}
              >
                <Rows3Icon aria-hidden="true" />
                Delete Row
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!table.canDeleteColumn}
                onClick={() => editor.chain().focus().deleteColumn().run()}
              >
                <Columns3Icon aria-hidden="true" />
                Delete Column
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDeleteTable}>
              <Trash2Icon aria-hidden="true" />
              Delete Table
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </RichTextBubbleBar>
    </BubbleMenu>
  )
}