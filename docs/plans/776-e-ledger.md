# #776 E: reuse ledger (Remove a Version or Video, Undo, Trash dialog)

Nothing is installed (`shadcn add` is not run in `apps/web`); every element below is already in `components/reui/` or `components/quincy/`. No raw `<button>`, `<input>`, `<select>`, `<textarea>`, `<dialog>` or widget `role` is added, so `config/ui-primitive-allowlist.ts` gains nothing.

Searches run (ReUI MCP `search`, 2026-10-11): "trash", "deleted items", "restore", "recycle bin", "confirm remove dialog with impact list", "undo toast". Results were settings-page blocks and the stock `alert-dialog` / `item` / `badge` examples already installed; none is a Trash list. The base-nova `sheet` was rejected for the Trash because the Video Collection's other lists (Review links, 11b) are dialogs.

| Element | Item |
|---|---|
| "⋯" Version menu beside the Version select (`VideoVersionMenu`) | installed `components/quincy/menu.tsx` (`Menu`, `MenuPrimitive.Item`, `MENU_ITEM`) with the trigger on `quincy/icon-button.tsx` `ICON_BUTTON`; `finalFocus` returns `false` while Remove hands off to the dialog (#463, #523), as `VideoNoteThread.renderMenu` does |
| Remove-Version and Remove-whole-film confirmations (one `AlertDialog`, two modes by `impact.lastVersion`) | installed `reui/alert-dialog` composed like `ConfirmDeleteDialog` (`AlertDialogAction variant="destructive"`, Cancel focused first, error in `quincy/Notice`) |
| Impact rows (notes, decisions, release, links) | installed `reui/item` (`ItemGroup`, `Item size="xs"`, `ItemContent`, `ItemTitle`, `ItemDescription`) |
| "Live" chip on a released Version | installed `reui/badge` `warning-light`. The confirmation portals to `body` (the `AlertDialog` portal, as the notes delete confirm does), outside the viewer's `data-surface="inverse"`, so the light roles apply and no `--signal-*-on-inverse` token is needed |
| Draft, upload and refusal notices | installed `quincy/Notice` (`caution`, `critical`) |
| Checking indicator | installed `reui/spinner` |
| Retry after an unreadable impact | installed `quincy/Button` (`secondary`) |
| Undo after a removal | `lib/toast-store.ts` `pushToast` with an `action` (`ToastViewport-action.dom.test.tsx`), `UNDO_TOAST_TTL_MS` (10 s) from `use-scheduling-undo-toast.ts` |
| "Trash" opener in the Films header | installed `quincy/Button` (`secondary`), the same as "Review links" (11b), `min-h-11` |
| Trash dialog | installed `reui/dialog` (`sm:max-w-[560px]`, never `max-w-{sm,md,lg,xl}`) with `quincy/SheetCloseButton` last, structured like `ReviewLinksDialogHost`; rows are `reui/item variant="outline"` (`ItemActions` for the chip and the button) |
| "N days left" chip | installed `reui/badge` (`warning-light` at 3 days or fewer, `secondary` otherwise); the dialog is on the light surface |
| Restore button | installed `quincy/Button` (`secondary`), 44px below 721px |
| Empty, error, archived states | installed `quincy/EmptyState`, `quincy/Notice` |
| Remover's name and date | the person label and `formatVideoDate` used in the viewer's details rows (no avatar) |

Not used, and why: `reui/scroll-area` and `reui/frame` (the plan's first list). The body is a plain `overflow-y-auto` grid, the structure `ReviewLinkDialogFrame` already ships for the sibling dialog, so the two dialogs scroll and clip alike. A restore has no confirmation dialog: it only brings a hidden thing back, and the toast and list change say so.

**Undo inside the open viewer (Sol round 2).** No new element: the Undo is the existing `ToastViewport` action. `lib/toast-host.ts` lets an open modal host that one viewport, so `VideoReviewViewer` registers an empty `<div>` inside its `DialogContent` (next to the overlay slot) and the viewport portals into it, with `data-surface="default"` so the ink toast keeps its non-inverse roles. Searched the ReUI MCP and base-nova for a toast or sonner item: the repo's single-viewport rule (`ToastViewport.dom.test.tsx`) rules out a second surface, and an Undo button added to the viewer would duplicate the toast's action and its announcement.
