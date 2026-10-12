# #802 PR B reuse ledger

One line per UI element added or changed. All reuse installed items; nothing is hand-built.

| Element | Item | Where |
|---|---|---|
| Preparing / ready / timeout message (staff and guest) | `components/quincy/Notice` (staff: `caution` while preparing, `positive` once ready with the ready sentence inside the status region, `critical` on failure; the guest dialog keeps one status Notice mounted from preparing to ready) | `components/PreparedZipNotice.tsx`, `guest/GuestDownloadAll.tsx` |
| Staff failure / too-large messages | the same `Notice` (`critical`) rendered as `role="alert"`, a separate element from the preparing/ready `role="status"` region, matching the guest's alert (decision from the #811 design review) | `components/PreparedZipNotice.tsx` |
| Guest failure / too-large messages | plain `<p role="alert">` with the `PROBLEM` class (not a critical Notice) | `guest/GuestDownloadAll.tsx` |
| Spinner beside the preparing copy | `components/reui/spinner` | same two files |
| "Download zip" (shown once ready), "Check again", "Close" | `components/reui/button` (`outline` for Download zip and Check again so it does not compete with the AutoHDR primary, `ghost` for Close) | `components/PreparedZipNotice.tsx`; the guest dialog's own "Check again" in `guest/GuestDownloadAll.tsx` |
| Guest Download all container | existing `components/reui/dialog` already used by `GuestDownloadAll` (unchanged) | `guest/GuestDownloadAll.tsx` |
| Toast for an unavailable or over-size staff zip | existing `lib/toast-store` `pushToast` | `screens/ProjectWorkspace.tsx` |
| Staff selected-RAW button and "Download selection" | unchanged elements; only their click handlers changed | `screens/ProjectWorkspace.tsx`, `components/PhotoGrid.tsx` |
| Polling timer (30 s, 5 min, visibility, cleanup) | no UI; `lib/use-prepared-download.ts` hook shared by both surfaces | `lib/use-prepared-download.ts` |

The staff notice is an inline `Notice` under the hand-off bar rather than a `reui/dialog`: the staff download buttons live in a toolbar and the notice must not block the grid while the zip prepares. The guest surface already is a dialog.

The notice renders after the hand-off block on both tabs (after the AutoHDR status card on Edited), and Close / Download zip return focus to the control that opened it.

The staff notice's "Download zip" (`outline`) and "Close" (`ghost`) inherit the notice's tone colour, so their labels are green when the notice is ready (positive) and caution-toned while preparing; accepted, not overridden.
