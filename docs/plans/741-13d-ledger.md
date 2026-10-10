# #741 13d reuse ledger (guest paste UI)

One line per new UI element. Paths are under `portal/apps/web/src/`. Search order per AGENTS.md: installed `reui/` and `quincy/`, then a ReUI item, then a ReUI block, then a base-nova primitive, then hand-built. Nothing here is hand-built and nothing new was installed.

The staff flow is `components/video/VideoNotePasteDialog.tsx`. It cannot be reused: it takes the staff `NoteFormStore` (`lib/video-note-form-store`) and imports `VisibilityBadge` from `components/video/VideoNoteThread.tsx`, which reaches `lib/video-notes-data` (-> `@tanstack`, `lib/api`), and `guest-boundary.guard.test.ts` forbids that for everything under `guest/`. Its pure parts that were worth keeping are copied by value, not imported: the skip copy (`guest/guest-paste.ts`, plus `not_author`), the 300 ms offset debounce, and the "settled" rule (the plan's offset equals the field's). The flow is the same: choose the source, a frame offset, a plan with a tick per note and the notes left out with the reason, then commit the ticked ones with the revisions shown. `noteAnchorLabel` and `framesToTimecode` are pure and already used by `GuestNoteItem`.

| Element | Where | Uses |
|---|---|---|
| "Copy my notes from another version" entry | `guest/GuestVideoScreen.tsx` | `components/reui/button.tsx` (`variant="ghost"`), under "Add a note" |
| Paste dialog frame, title, description, footer | `guest/GuestPasteDialog.tsx` | `components/reui/dialog.tsx` (`Dialog`, `DialogContent` at `sm:max-w-xl`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`) |
| "Copy from" Version picker | `guest/GuestPasteDialog.tsx` | `components/reui/select.tsx` (`Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem`) with `components/reui/label.tsx`, the same composition as the Version picker on the video screen |
| Frame offset | `guest/GuestPasteDialog.tsx` | `components/reui/number-field.tsx` (`NumberField`, `NumberFieldGroup`, `NumberFieldDecrement`, `NumberFieldIncrement`, `NumberFieldInput`) with `components/reui/label.tsx`, as the staff dialog |
| Note rows with a tick | `guest/GuestPasteDialog.tsx` | `components/reui/item.tsx` (`ItemGroup`, `Item variant="outline"`, `ItemContent`, `ItemTitle`, `ItemDescription`) and `components/reui/checkbox.tsx`. The staff dialog uses `reui/table`; `item` rows (plan section 8) stack on a phone with no layout switch. |
| "Left out" list with reasons | `guest/GuestPasteDialog.tsx` | a `<ul>` of text rows in the secondary-foreground token, the staff dialog's list |
| "Shortened to fit", drawn-notes line, empty line, loading line | `guest/GuestPasteDialog.tsx` | `<p>` text in the secondary-foreground token |
| Changed-since-preview notice, load error, commit error | `guest/GuestPasteDialog.tsx` | `components/quincy/Notice.tsx` (`tone="caution"` for the changed notice, `critical` for errors), as the staff dialog |
| Try again, Cancel, Paste N notes | `guest/GuestPasteDialog.tsx` | `components/reui/button.tsx` (`ghost`, `outline`, default) |
| "Copied N notes from vX" line | `guest/GuestVideoScreen.tsx` | a `<p role="status">` in the secondary-foreground token, the line the screen already uses for status text |

Below 721px every control carries the same `pointer-coarse:min-h-11 max-[721px]:min-h-11` utility the rest of the guest screens use, and the tick's hit area is widened with the staff dialog's `after:-inset-3.5`. The notes column's `top` slot already scrolls inside the exact-viewport layout (`max-h-[60%] overflow-y-auto`), and the dialog is a portal, so the layout at 721px and wider is unchanged.
