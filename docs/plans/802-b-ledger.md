# #802 PR B reuse ledger

One line per UI element added or changed. All reuse installed items; nothing is hand-built.

| Element | Item | Where |
|---|---|---|
| Preparing / failed / over-size message (staff and guest) | `components/quincy/Notice` (`caution` while preparing, `critical` on failure) | `components/PreparedZipNotice.tsx`, `guest/GuestDownloadAll.tsx` |
| Spinner beside the preparing copy | `components/reui/spinner` | same two files |
| "Download zip" (shown once ready), "Check again", "Close" | `components/reui/button` (`default`, `outline`, `ghost`) | `components/PreparedZipNotice.tsx`; the guest dialog's own "Check again" in `guest/GuestDownloadAll.tsx` |
| Guest Download all container | existing `components/reui/dialog` already used by `GuestDownloadAll` (unchanged) | `guest/GuestDownloadAll.tsx` |
| Toast for an unavailable or over-size staff zip | existing `lib/toast-store` `pushToast` | `screens/ProjectWorkspace.tsx` |
| Staff selected-RAW button and "Download selection" | unchanged elements; only their click handlers changed | `screens/ProjectWorkspace.tsx`, `components/PhotoGrid.tsx` |
| Polling timer (30 s, 5 min, visibility, cleanup) | no UI; `lib/use-prepared-download.ts` hook shared by both surfaces | `lib/use-prepared-download.ts` |

The staff notice is an inline `Notice` under the hand-off bar rather than a `reui/dialog`: the staff download buttons live in a toolbar and the notice must not block the grid while the zip prepares. The guest surface already is a dialog.
