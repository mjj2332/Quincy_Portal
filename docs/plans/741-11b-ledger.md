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
| Archived-while-creating notice (`ReviewLinksDialogHost`) | installed `quincy/Notice` (`caution`) under `reui/dialog` `DialogHeader`/`DialogTitle`, the wording of the detail's archived notice |
| Unlisted-Version row in the detail | the existing Version row (`quincy/Checkbox` in a 44px `label`), labelled "Version N"; no new element |
| Empty state, errors, notices | installed `quincy/EmptyState`, `quincy/Notice` |
| Loading | installed `reui/spinner` |
| Back to list | installed `quincy/Button` (`text`) + lucide `ChevronLeft` |
| Detail action buttons (Save changes, Remove passcode / Keep passcode, Remove, Replace link, Revoke link) | installed `quincy/Button` (`primary` / `secondary` / `text` / `danger`), `min-h-11` targets; no raw `<button>` |
| Detail section headings ("Films on this link", "Verified guests") | plain `<h3>` in the Quincy `--weight-medium` / `--text-sm` type, inside `<section aria-label>`: searched `reui/item` (`ItemGroup` has no heading), `reui/field` (`FieldLegend` needs a `FieldSet`, these are not form fields) and `reui/card` (`CardTitle`, rejected by ADR 0014: the Portal's surface is `frame`); nothing in ReUI is a bare section heading |
| Standalone `FieldDescription` (passcode hints) | installed `reui/field` `FieldDescription`, wrapped with its input in a `gap-[var(--space-1)]` grid like the Expires field and linked by `aria-describedby`; `QuincyField` has no description slot, so the hint sits beside it |
| Dialog close control | installed `quincy/SheetCloseButton` (its `SheetClose` is Base UI's `Dialog.Close`, so it works in `reui/dialog`): 28px on desktop, `max-[721px]:size-11`; `showCloseButton={false}` on the `DialogContent`; the header reserves `SHEET_CLOSE_CLEARANCE` |
| Dialog frame (`ReviewLinkDialogFrame`) | the `Modal` / `VideoNotePasteDialog` structure: `DialogContent` is `flex flex-col`, header and footer outside an inner `min-h-0 flex-1 overflow-y-auto` body; no new element, only layout |
| Per-film heading in Create (the film title above its Version rows) | plain `<span>` in the `--weight-medium` / `--text-sm` type inside a `role="group"` named by the title: searched `reui/field` (`FieldLegend` needs a `FieldSet`; these are not one field) and `reui/item` (`ItemTitle` is a row title, not a group heading); nothing in ReUI is a bare group label |
| Reveal's link-name `<p>` | plain `<p>` in the same `--weight-medium` / `--text-sm` type, in the `DialogHeader` under the description: `DialogDescription` is muted body text and `DialogTitle` is taken by "Review link ready"; no ReUI dialog slot is a second header line |
| Legends "What guests can do" and "Versions" | plain `<span id>` in the Quincy eyebrow type (`--type-eyebrow`, uppercase, `--tracking-wide`, `--text-secondary`: what `reui/field` `FieldLabel` renders for LABEL / EXPIRES), naming a `role="group"` through `aria-labelledby`; `FieldLegend` was rejected because it needs a `FieldSet` (a raw `<fieldset>` the ratchet would flag) and sets its own legend type |
| Grant-limit hint ("A film can share up to 100 Versions on a link.") | installed `reui/field` `FieldDescription` in the create step, a muted `<p>` in the detail beside the "Remove the film" line; linked to each disabled Version by `aria-describedby`; the limit is `REVIEW_LINK_MAX_GRANTS_PER_VIDEO` in shared |
| Locked-Version hint ("A film needs at least one Version...") | installed `reui/field` `FieldDescription`, linked to the disabled checkbox with `aria-describedby` |
| Review links button in the Films header | still installed `quincy/Button` (`secondary`), moved into `.workspace-intro` (`ReviewLinksOpenButton`) |
| Dialog width | `sm:max-w-[560px]`, Modal's "wide" step (not `max-w-xl`, which is 1320px here) |

No raw `<button>`, `<input>`, `<select>`, `<textarea>`, `<dialog>` or widget role was added outside `components/reui/` and `components/quincy/`; `ui-primitive-allowlist.ts` is unchanged.

## Ordering notes (Sol round 2)
- **Rule A, one write in flight per link.** Design: a per-link lock in `review-link-form-store.run` (the link id is the lock; every write on a link, whatever its scope, is refused while another is out). The detail disables every write control of the link while any of its scopes is pending, so a response can only be the latest write for that link and is applied to the cache as such. Chosen over a queue because the UI already locks and a queued write would be built on a stale set.
- **Rule B, reveals queue.** `reveals` holds every successful create/replace URL; the dialog shows `reveals[0]` with "1 of N" and drops one only on Done/close.
