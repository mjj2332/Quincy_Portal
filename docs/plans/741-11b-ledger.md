# #741 11b — reuse ledger (staff UI for Review links)

Searches run: `mcp__ReUI__search` "share link dialog with copy URL input group and expiry, revoke, list of links" (top hit `c-input-group-40`; `profile-6` and `card-21` are page-level Pro blocks on the card surface, not usable in a dialog; `form-8` and `dialog-8` / `dialog-2` as recorded in `docs/plans/741-10-12.md` §4). Nothing new installed.

| Element | Reuse |
|---|---|
| Selection checkbox on `VideoCard` | installed `quincy/Checkbox`, inside a 44px `label` target |
| Selection bar (`ReviewLinkSelectionBar`) | PhotoGrid `ACTIONBAR` inverse surface classes copied (not lifted: PhotoGrid is outside this slice; the `quincy/selection-bar.ts` extraction is deferred) + installed `quincy/Button` |
| Header "Review links" button | installed `quincy/Button` (`secondary`) |
| Dialog shell (list, create, detail, reveal steps) | installed `reui/dialog`; nested overlays via `OverlayContainerContext` (the `VideoReviewViewer` precedent) |
| Confirms (Remove Video, Revoke, Replace) | installed `reui/alert-dialog`, composed like `ConfirmDeleteDialog` |
| Label, passcode inputs | installed `quincy/QuincyField` (`reui/field` + `reui/input`) |
| Expiry | installed `quincy/DateTimeField`, date mode, `positionerClassName` raised above `--z-dialog` |
| Permissions (Comments, Approve, Download) | installed `reui/switch` |
| Version picker | installed `quincy/Checkbox` rows in a 44px `label` (inside `reui/item` in the detail) |
| Add a Video | installed `reui/combobox` (the `SubtaskAssigneePicker` composition), trigger styled with `buttonClasses("secondary")` |
| Link rows, member rows, verified-guest rows | installed `reui/item` (`ItemGroup`, `ItemContent`, `ItemActions`) |
| Status badge | installed `reui/badge`: `success-light` / `warning-light` / `secondary` |
| Card chips | installed `reui/badge` inside installed `quincy/Button` (`text`) so the click target is a real button, not a raw `<button>` |
| "+N" chip | `reui/badge` `outline` inside `quincy/Button` |
| Reveal URL + Copy | `c-input-group-40` composition (visibility dropdown dropped) on installed `reui/input-group`, plus the `c-button-41` pattern in `video/CopyTextButton.tsx` (clipboard core of `quincy/CopyProjectLinkButton`; kept in `components/video/` for this slice, `CopyProjectLinkButton` unchanged; `use-copy-to-clipboard` still rejected for the reason in that file) |
| Empty state, errors, notices | installed `quincy/EmptyState`, `quincy/Notice` |
| Loading | installed `reui/spinner` |
| Back to list | installed `quincy/Button` (`text`) + lucide `ChevronLeft` |

No raw `<button>`, `<input>`, `<select>`, `<textarea>`, `<dialog>` or widget role was added outside `components/reui/` and `components/quincy/`; `ui-primitive-allowlist.ts` is unchanged.
