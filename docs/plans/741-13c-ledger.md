# #741 13c reuse ledger (guest notes UI)

One line per new UI element. Paths are under `portal/apps/web/src/`. Search order per AGENTS.md: installed `reui/` and `quincy/`, then a ReUI item, then a ReUI block, then a base-nova primitive, then hand-built. Nothing here is hand-built.

Installed this slice: `components/reui/input-otp.tsx`, base-nova `input-otp` (the registry's `@reui/input-otp` is not a ReUI item; base-nova has it), fetched through the sandbox (`tmp/ReUI-Test-1`, `npx shadcn@latest add input-otp --path src/components/vendor-741c`) and hand-applied: `cn` rewritten to `@/lib/utils`, `dark:` variants dropped, Quincy's field box (radius, border, `--field-bg`, 44px slot below 721px), `animate-caret-blink` (no such keyframe in the tokens) replaced with `motion-safe:animate-pulse`, `ring-3` to `ring-2`. The `input-otp@1.5.0` package is pinned in `portal/package.json`. `shadcn add` was never run in `apps/web`.

| Element | Where | Uses |
|---|---|---|
| Verify dialog | `guest/GuestVerifyDialog.tsx` | `components/reui/dialog.tsx` (`Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`) |
| Email and name fields, labels | `guest/GuestVerifyDialog.tsx` | `components/reui/field.tsx` (`FieldGroup`, `Field`, `FieldLabel`), `components/reui/input.tsx` |
| Six-digit code | `guest/GuestVerifyDialog.tsx` | `components/reui/input-otp.tsx` (`InputOTP`, `InputOTPGroup`, `InputOTPSlot`), `REGEXP_ONLY_DIGITS` from `input-otp` |
| Send code, Resend (with countdown), Verify, Change, Cancel | `guest/GuestVerifyDialog.tsx` | `components/reui/button.tsx` (`variant` ghost / outline / link) |
| Verify error line | `guest/GuestVerifyDialog.tsx` | a `<p role="alert">` in the destructive token, the same line the passcode screen renders through `FieldError`; `FieldError` is bound to a `Field` with `data-invalid`, and the code step's message belongs to the whole form |
| "Add a note" entry | `guest/GuestVideoScreen.tsx` | `components/reui/button.tsx` |
| Composer (anchor line, Mark in / Mark out / Draw, body, Post, Cancel) | `guest/use-guest-compose.tsx` | `components/reui/button.tsx`, `components/reui/textarea.tsx` |
| Pen toolbar while drawing | `guest/use-guest-compose.tsx` | `components/quincy/markup-toolbar.tsx` (`MarkupToolbar`), in the player's `transportReplacement` slot, with `lib/use-markup.ts` for pointer capture and undo / redo |
| Draft drawing layer on the picture | `guest/use-guest-compose.tsx` | `components/quincy/freehand-strokes.tsx` (`MarkupLayer`, `StrokeVisible`). The staff `VideoNoteComposer` and `VideoMarkupOverlay` are bound to `lib/video-note-form-store` (-> `lib/api`) and `lib/video-notes-data` (-> `@tanstack`, `lib/api`), which `guest-boundary.guard.test.ts` forbids, so only their pure parts are reused (`useMarkup`, `markFrame`, `marksToFrames`); nothing was lifted into `components/quincy/` because no pure part needed moving. |
| Own-note "…" menu (Edit, Delete) | `guest/GuestNoteItem.tsx` | `components/quincy/menu.tsx` (`Menu`, `MenuPrimitive.Item`, `MENU_ITEM`), trigger styled with `components/quincy/icon-button.tsx` (`ICON_BUTTON`) |
| Delete confirm | `guest/GuestNoteItem.tsx` | `components/reui/alert-dialog.tsx` (`AlertDialog`, `AlertDialogContent`, `AlertDialogHeader`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogCancel`, `AlertDialogAction variant="destructive"`), the shape of `components/ConfirmDialog.tsx` |
| Edit form, reply form | `guest/GuestNoteItem.tsx` | `components/reui/textarea.tsx`, `components/reui/button.tsx` |
| "You" / "Studio" / "Client" chip | `guest/GuestNoteItem.tsx` | `components/reui/badge.tsx` |
| Thread row | `guest/GuestNoteItem.tsx` | `components/reui/item.tsx` (`Item variant="outline"`, `ItemContent`), as before |
| "Has a drawing" tip | `guest/GuestNoteItem.tsx` | `components/quincy/VideoPlayer.tsx` (`IconTip`), as before |
| Archived notice | `guest/GuestApp.tsx` | the `<p role="status">` band `guest-notice` already uses on the same page |
| Staff "Client" badge | `components/video/VideoNoteThread.tsx` | `components/reui/badge.tsx` |
| Staff guest email | `components/video/VideoNoteThread.tsx` | `components/reui/tooltip.tsx` (`Tooltip`, `TooltipTrigger`, `TooltipContent`), only where the DTO carries `email` |
