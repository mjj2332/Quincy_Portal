// Vendored from ReUI `rich-text-editor-2` (`delete-table-dialog.tsx`) via the `tmp/ReUI-Test-1`
// sandbox (#492). Edits:
// 1. `@/components/ui/alert-dialog` -> `@/components/reui/alert-dialog` (Quincy's restyled copy).
// 2. The success toast with an Undo action is dropped, with `sonner` and `./icons`: the Portal has no
//    toast host in this tree, so the table is simply gone and Undo (Cmd/Ctrl+Z, the toolbar button)
//    restores it. The dialog copy says so.
// 3. `data-testid` on the confirm action, a Quincy-owned test hook.
import { useState } from "react"
import { findParentNodeClosestToPos, type Editor } from "@tiptap/react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/reui/alert-dialog"


/** Tables have no title, so the heading above one names it. */
function tableName(editor: Editor) {
  const table = findParentNodeClosestToPos(
    editor.state.selection.$from,
    (node) => node.type.name === "table"
  )
  let heading = ""

  editor.state.doc.descendants((node, pos) => {
    if (!table || pos >= table.pos) return false
    if (node.type.name === "heading" && node.textContent.trim()) {
      heading = node.textContent.trim()
    }
    return node.type.name !== "heading"
  })

  return heading ? `${heading} table` : "This table"
}

interface DeleteTableDialogProps {
  editor: Editor | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Confirms before a whole table goes, then offers Undo. */
export function DeleteTableDialog({
  editor,
  open,
  onOpenChange,
}: DeleteTableDialogProps) {
  const [name, setName] = useState("This table")
  const [shownOpen, setShownOpen] = useState(open)

  // Named once on open, so the copy holds through the closing animation.
  if (open !== shownOpen) {
    setShownOpen(open)
    if (open && editor) setName(tableName(editor))
  }

  function deleteTable() {
    editor?.chain().focus().deleteTable().run()
    onOpenChange(false)
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {/* The bar that opened it hides with the table, so focus lands in the page. */}
      <AlertDialogContent size="sm" finalFocus={() => editor?.view.dom ?? true}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Table?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="text-foreground font-medium">{name}</span> and
            every row in it will be removed. Undo brings it back.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={deleteTable} data-testid="rich-text-delete-table-confirm">
            Delete Table
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}