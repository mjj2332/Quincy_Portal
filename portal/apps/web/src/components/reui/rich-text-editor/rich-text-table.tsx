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
// 6. The bar DOCKS to the table's outer edge (#555): it anchors to the whole table vertically (`readActiveTableRect`) and
//    to the DOM element of the CELL holding the caret (`$anchor`) horizontally, clamped to the table, so it is placed
//    `top-start` -> `bottom-start` around the table and never over a cell. It is re-resolved on every selection
//    update; the plugin's own scroll/resize handlers re-run it. flip and shift share one boundary rect
//    (`rich-text-table-position.ts`): the editable surface clipped to the visible viewport, whose top is the sticky
//    shell header's bottom (`shellChromeBottom`). The bar may float over the paragraph above or below the table
//    (owner decision 2026-10-06) but never leaves the surface, so the helper line stays visible.
// 7. The zone is chosen per positioning pass (`tableBubbleZone`): just above the table with an 8px gap when that fits,
//    else just below, else tier "none". The neighbouring blocks no longer bound it. The offset is derivable and
//    carries the same gap as the flip/shift padding. Under "none" the bar stays MOUNTED but
//    inert, hidden from assistive tech and invisible (`RichTextBubbleBar` `inactive`; we do not touch Tiptap's own
//    inline visibility), `onTierChange` tells the host, which shows the same controls as the toolbar's table group
//    (edit 8), so exactly one control set is usable. The bar's outer padding is gone (`rich-text-bubble-bar.tsx`).
// 8. The bar's controls are `RichTextTableControls`, shared with `RichTextTableTools`: below 721px, or whenever the
//    bar's tier is "none", the same controls render as the FIRST group of the formatting toolbar instead
//    (`QuincyRichTextEditor`), because a floating bar has no room around the table (#535). Below 721px the bar is
//    unmounted; at "none" it is inert, so the two are never both usable.
//    (#595 supersedes that for a desktop at tier "none": there the group does NOT lead the toolbar, it would shove every
//    control sideways; the Insert-table slot becomes the `RichTextTableMenu` below, so the toolbar keeps its order.
//    Only the phone still leads with `RichTextTableTools`.)
// 9. The bar takes an optional `ceiling` (#594): the sticky composer toolbar's bottom, a second chrome edge under the header.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react"
import { findParentNodeClosestToPos, type Editor } from "@tiptap/react"
import { BubbleMenu } from "@tiptap/react/menus"

import { Button } from "@/components/reui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
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
import { readVisualOffset, tableBubbleAnchor, tableBubbleOptions, viewportBelow, type TableBubbleTier } from "./rich-text-table-position"
import { RichTextBubbleBar, focusFirstToolbarStop, fromOwnDom } from "./rich-text-bubble-bar"
import type { RichTextSlashItem } from "./rich-text-slash-menu"
import { useRichTextSelector } from "./rich-text-state"
import {
  RichTextButton,
  RichTextToggle,
  RichTextToolbarGroup,
  RichTextToolbarSeparator,
} from "./rich-text-toolbar"
import { ChevronDownIcon, TableIcon, BetweenHorizontalEndIcon, BetweenVerticalEndIcon, PanelTopIcon, Trash2Icon, Rows3Icon, Columns3Icon } from "lucide-react"

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

/**
 * The whole table: vertical extent of the `<table>`, horizontal extent of its scroll wrapper (the visible width),
 * so the bar docks to the table's outer edge (#555). Null when no table holds the caret.
 */
export function readActiveTableRect(editor: Editor) {
  const found = findParentNodeClosestToPos(editor.state.selection.$anchor, (node) => node.type.name === "table")
  const dom = found ? editor.view.nodeDOM(found.pos) : null

  if (!(dom instanceof HTMLElement)) return null
  const table = dom instanceof HTMLTableElement ? dom : dom.querySelector("table")
  const vertical = (table ?? dom).getBoundingClientRect()
  const horizontal = dom.getBoundingClientRect()

  return { top: vertical.top, bottom: vertical.bottom, left: horizontal.left, right: horizontal.right }
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
  /** The tier the host last heard (null outside a table): "none" makes the bar inert, the host shows the toolbar group. */
  tier?: TableBubbleTier | null
  /** Fired when the bar's tier changes while the caret is in a table. */
  onTierChange?: (tier: TableBubbleTier) => void
  /** Client-Y of a second chrome edge below the shell header (the stuck composer toolbar's bottom): the bar never docks above it. */
  ceiling?: () => number
}

interface RichTextTableControlsProps {
  editor: Editor
  onDeleteTable: () => void
  /** The editor is read-only or busy: every control is disabled, the group stays. */
  disabled?: boolean
}

/** The table commands, shared by the floating bar, the phone group and the desktop Table menu: one definition each. */
export const tableCommands = {
  addRow: (editor: Editor) => editor.chain().focus().addRowAfter().run(),
  addColumn: (editor: Editor) => editor.chain().focus().addColumnAfter().run(),
  toggleHeaderRow: (editor: Editor) => editor.chain().focus().toggleHeaderRow().run(),
  deleteRow: (editor: Editor) => editor.chain().focus().deleteRow().run(),
  deleteColumn: (editor: Editor) => editor.chain().focus().deleteColumn().run(),
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
          onClick={() => tableCommands.addRow(editor)}
        >
          <BetweenHorizontalEndIcon aria-hidden="true" />
        </RichTextButton>
        <RichTextButton
          label="Add column right"
          disabled={disabled || !table.canAddColumn}
          onClick={() => tableCommands.addColumn(editor)}
        >
          <BetweenVerticalEndIcon aria-hidden="true" />
        </RichTextButton>
      </RichTextToolbarGroup>
      <RichTextToolbarSeparator />
      <RichTextToggle
        label="Header row"
        pressed={table.headerRow}
        disabled={disabled}
        onToggle={() => tableCommands.toggleHeaderRow(editor)}
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
              onClick={() => tableCommands.deleteRow(editor)}
            >
              <Rows3Icon aria-hidden="true" />
              Delete Row
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={disabled || !table.canDeleteColumn}
              onClick={() => tableCommands.deleteColumn(editor)}
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
  tier = null,
  onTierChange,
  ceiling,
}: RichTextTableBubbleProps) {
  // The anchor and the zone share ONE rect (the whole table's vertical extent and the active cell's column, `tableBubbleAnchor`); re-resolved on each pass.
  const readAnchor = useCallback(() => {
    const dom = getActiveCellElement(editor)

    if (!dom) return null
    const cell = dom.getBoundingClientRect()

    return tableBubbleAnchor(readActiveTableRect(editor) ?? readActiveRowRect(editor), cell)
  }, [editor])

  const getCellRect = useCallback(() => {
    const dom = getActiveCellElement(editor)

    if (!dom) return null

    return {
      getBoundingClientRect: () => {
        const rect = readAnchor() ?? dom.getBoundingClientRect()

        return new DOMRect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top)
      },
      getClientRects: () => [dom.getBoundingClientRect()],
      contextElement: dom,
    }
  }, [editor, readAnchor])

  // Options are rebuilt when the caret enters or leaves a table, so the tier's "only on change" memory starts over.
  const inTable = useRichTextSelector(editor, (current) => current?.isActive("table") ?? false)
  const onTierChangeRef = useRef(onTierChange)
  const ceilingRef = useRef(ceiling)

  useLayoutEffect(() => {
    onTierChangeRef.current = onTierChange
    ceilingRef.current = ceiling
  }, [onTierChange, ceiling])

  const options = useMemo(
    () => {
      void inTable

      return tableBubbleOptions({
        surface: () => editor.view.dom.getBoundingClientRect(),
        row: () => readAnchor() ?? readActiveRowRect(editor),
        viewport: viewportBelow(() => ceilingRef.current?.() ?? 0),
        visualOffset: () => readVisualOffset(),
        // A late pass after the caret left the table must not resurrect the group.
        onTier: (next) => {
          if (editor.isActive("table")) onTierChangeRef.current?.(next)
        },
      })
    },
    [editor, readAnchor, inTable]
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
        inactive={tier === "none"}
        tier={tier ?? undefined}
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

interface RichTextTableMenuProps {
  editor: Editor
  onDeleteTable: () => void
  disabled?: boolean
}

/**
 * The desktop's table controls at tier "none" (#595): one "Table" menu standing in the Insert-table slot of the Layout
 * group (Insert table cannot act inside a table anyway), so nothing in the toolbar shifts sideways. Same commands as the
 * bar (`tableCommands`). Alt+F10 from the text focuses the trigger; Escape on it returns to the text (capture phase).
 */
export function RichTextTableMenu({ editor, onDeleteTable, disabled = false }: RichTextTableMenuProps) {
  const table = useRichTextSelector(editor, readTable)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  // Appearing must not leave the slot scrolled out of a narrow toolbar: write scrollLeft (a call that scrolls the page itself would jump it).
  useLayoutEffect(() => {
    const trigger = triggerRef.current
    const scroller = trigger?.closest<HTMLElement>("[role='toolbar']")

    if (!trigger || !scroller) return
    const box = trigger.getBoundingClientRect()
    const view = scroller.getBoundingClientRect()

    if (box.right > view.right) scroller.scrollLeft += box.right - view.right
    else if (box.left < view.left) scroller.scrollLeft -= view.left - box.left
  }, [])

  useEffect(() => {
    const { dom } = editor.view

    function handleShortcut(event: KeyboardEvent) {
      const trigger = triggerRef.current

      if (!event.altKey || event.key !== "F10" || !trigger?.isConnected || trigger.closest("[inert]")) return
      event.preventDefault()
      trigger.focus()
    }

    dom.addEventListener("keydown", handleShortcut)
    return () => dom.removeEventListener("keydown", handleShortcut)
  }, [editor])

  function handleKeyDown(event: ReactKeyboardEvent<HTMLSpanElement>) {
    if (event.key !== "Escape" || !fromOwnDom(event)) return

    event.preventDefault()
    editor.commands.focus()
  }

  return (
    <span className="flex shrink-0" aria-keyshortcuts="Alt+F10" onKeyDownCapture={handleKeyDown}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              ref={triggerRef}
              variant="ghost"
              size="sm"
              aria-label="Table"
              disabled={disabled}
              data-toolbar-item=""
              data-testid="rich-text-table-menu"
              className="max-[721px]:h-11"
            />
          }
        >
          Table
          <ChevronDownIcon aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-auto" finalFocus={() => editor.view.dom}>
          <DropdownMenuGroup>
            <DropdownMenuItem disabled={disabled || !table.canAddRow} onClick={() => tableCommands.addRow(editor)}>
              <BetweenHorizontalEndIcon aria-hidden="true" />
              Add row below
            </DropdownMenuItem>
            <DropdownMenuItem disabled={disabled || !table.canAddColumn} onClick={() => tableCommands.addColumn(editor)}>
              <BetweenVerticalEndIcon aria-hidden="true" />
              Add column right
            </DropdownMenuItem>
            <DropdownMenuCheckboxItem checked={table.headerRow} closeOnClick disabled={disabled} onCheckedChange={() => tableCommands.toggleHeaderRow(editor)}>
              <PanelTopIcon aria-hidden="true" />
              Header row
            </DropdownMenuCheckboxItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem disabled={disabled || !table.canDeleteRow} onClick={() => tableCommands.deleteRow(editor)}>
              <Rows3Icon aria-hidden="true" />
              Delete Row
            </DropdownMenuItem>
            <DropdownMenuItem disabled={disabled || !table.canDeleteColumn} onClick={() => tableCommands.deleteColumn(editor)}>
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
    </span>
  )
}
